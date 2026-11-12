#!/usr/bin/env node
/**
 * Runs the official MCP conformance suite (@modelcontextprotocol/conformance, pinned in the root package.json)
 * against L2M in both directions:
 *
 *   server runs: the gateway (a booted API, MCP_GATEWAY_MODERN_PROTOCOL on and off), for spec versions 2025-11-25
 *                and 2026-07-28;
 *   client runs: the HTTP MCP client (packages/mcp-sdk/src/bin/conformance-client.ts), for the same two versions plus
 *                the `backcompat` and `auth` suites.
 *
 * Known gaps live in conformance/baselines/*.yaml with a reason per scenario. The suite exits 1 for a failure that is
 * not listed AND for a listed scenario that now passes (remove it from the baseline), so the lists only shrink.
 *
 *   node conformance/run.mjs                    every run
 *   node conformance/run.mjs --only server-modern-on-2026-07-28,client-2025-11-25
 *   node conformance/run.mjs --out <dir>        keep the raw results (checks.json per scenario) in <dir>
 *   node conformance/run.mjs --list             print the run names
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const cliEntry = path.join(repoRoot, "node_modules/@modelcontextprotocol/conformance/dist/index.js");
const tsx = path.join(repoRoot, "packages/mcp-sdk/node_modules/.bin/tsx");
const apiTsx = path.join(repoRoot, "apps/api/node_modules/.bin/tsx");
const clientHarness = path.join(repoRoot, "packages/mcp-sdk/src/bin/conformance-client.ts");
const bootScript = path.join(here, "boot-gateway.ts");
const baseline = (name) => path.join(here, "baselines", `${name}.yaml`);

/** Server runs share one booted gateway per modern-mode setting. */
const SERVER_RUNS = [
  { name: "server-modern-on-2026-07-28", modern: "on", args: ["--requirements", "2026-07-28"] },
  { name: "server-modern-on-2025-11-25", modern: "on", args: ["--requirements", "2025-11-25"] },
  { name: "server-modern-off-2025-11-25", modern: "off", args: ["--requirements", "2025-11-25"] },
  { name: "server-modern-off-2026-07-28", modern: "off", args: ["--requirements", "2026-07-28"] }
];

const CLIENT_RUNS = [
  { name: "client-2026-07-28", args: ["--requirements", "2026-07-28"] },
  { name: "client-2025-11-25", args: ["--requirements", "2025-11-25"] },
  { name: "client-backcompat", args: ["--suite", "backcompat", "--spec-version", "2025-03-26"] },
  { name: "client-auth", args: ["--suite", "auth", "--spec-version", "2026-07-28"] }
];

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const only = argValue("--only")?.split(",").map((item) => item.trim()).filter(Boolean);

if (process.argv.includes("--list")) {
  for (const run of [...SERVER_RUNS, ...CLIENT_RUNS]) console.log(run.name);
  process.exit(0);
}
const knownRuns = new Set([...SERVER_RUNS, ...CLIENT_RUNS].map((run) => run.name));
const unknownRuns = (only ?? []).filter((name) => !knownRuns.has(name));
if (unknownRuns.length > 0) {
  console.error(`Unknown run(s): ${unknownRuns.join(", ")}. Known: ${[...knownRuns].join(", ")}`);
  process.exit(2);
}
const outRoot = argValue("--out") ?? fs.mkdtempSync(path.join(os.tmpdir(), "l2m-conformance-results-"));

function selected(run) {
  return !only || only.includes(run.name);
}

/** Runs the conformance CLI, mirrors its output, and resolves with the exit code and the scenario summary lines. */
function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliEntry, ...args], { cwd: options.cwd ?? repoRoot, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.stderr.on("data", (chunk) => (text += chunk));
    child.on("close", (code) => resolve({ code: code ?? 1, text }));
  });
}

function summarize(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /SUMMARY/.test(line));
  return start >= 0 ? lines.slice(start).join("\n").trimEnd() : text.split("\n").slice(-40).join("\n");
}

const liveChildren = new Set();
process.on("exit", () => {
  for (const child of liveChildren) child.kill("SIGKILL");
});

async function bootGateway(modern) {
  const child = spawn(apiTsx, [bootScript, "--modern", modern], { cwd: here, stdio: ["ignore", "pipe", "inherit"] });
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  const lines = readline.createInterface({ input: child.stdout });
  let url;
  try {
    url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The gateway did not start within 90 s.")), 90_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`The gateway process exited early (${code}).`));
      });
      lines.on("line", (line) => {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed.url === "string") {
            clearTimeout(timer);
            resolve(parsed.url);
          }
        } catch {
          // Log lines from the API are not the ready message.
        }
      });
    });
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return {
    url,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
      })
  };
}

const results = [];

for (const modern of ["on", "off"]) {
  const runs = SERVER_RUNS.filter((run) => run.modern === modern && selected(run));
  if (runs.length === 0) continue;
  const gateway = await bootGateway(modern);
  try {
    for (const run of runs) {
      const { code, text } = await runCli([
        "server", "--url", gateway.url, ...run.args,
        "--expected-failures", baseline(run.name), "-o", path.join(outRoot, run.name), "--timeout", "20000"
      ]);
      results.push({ name: run.name, code, summary: summarize(text) });
    }
  } finally {
    await gateway.stop();
  }
}

for (const run of CLIENT_RUNS.filter(selected)) {
  const { code, text } = await runCli(
    ["client", "--command", `"${tsx}" "${clientHarness}"`, ...run.args, "--expected-failures", baseline(run.name), "-o", path.join(outRoot, run.name), "--timeout", "40000"],
    { cwd: path.join(repoRoot, "packages/mcp-sdk") }
  );
  results.push({ name: run.name, code, summary: summarize(text) });
}

let failed = 0;
for (const result of results) {
  console.log(`\n##### ${result.name}: ${result.code === 0 ? "OK (matches baseline)" : "FAILED"}`);
  console.log(result.summary);
  if (result.code !== 0) failed += 1;
}
console.log(`\nRaw results: ${outRoot}`);
console.log(failed === 0 ? "\nConformance: every run matches its baseline." : `\nConformance: ${failed} run(s) differ from their baseline.`);
process.exit(failed === 0 ? 0 : 1);
