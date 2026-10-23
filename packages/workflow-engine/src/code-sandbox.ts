/**
 * Where and how code nodes run.
 *
 * A deployment picks one plan at startup (see `resolveCodeSandboxPlan`):
 *
 *   container   JavaScript and Python run in a throwaway container per node
 *               execution, built like the MCP stdio sandbox (Phase 10.7):
 *               `--network none --read-only --cap-drop ALL`, a non-root user,
 *               memory, CPU and process limits, no host mounts and no
 *               environment. Needs docker or podman and the two images.
 *   in_process  the fallback when no container runtime (or image) is there.
 *               JavaScript runs in an isolated V8 realm in the API process
 *               with no host objects (the same hardening as the expression
 *               sandbox), its result passed out as JSON. Python runs as a
 *               host subprocess in isolated mode (`-I`) with an explicit,
 *               minimal environment (no API secrets), a scratch working
 *               directory and a hard kill on timeout. It can still read files
 *               the API user can read, which is why the API warns at startup.
 *   disabled    CODE_NODES_ENABLED=false: every code node fails with a clear
 *               configuration error.
 *
 * Both JavaScript paths use the same in-realm harness, so code behaves the
 * same in either: `input` holds the node's input, `console.*` is collected
 * into `code_logs`, `return` sets the result (async code may `await`), and
 * there is no `require`, `process`, `fetch`, timers or Buffer.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { ErrorCategory, WorkflowError } from "@ai-orchestrator/shared";
import { buildContainerRunArgs, currentSandboxOwner, detectContainerRuntime, type RuntimeLocator } from "@ai-orchestrator/mcp-sdk";
import { REALM_HARDEN_SOURCE, createBareContext, toSandboxJson } from "./expression-sandbox";
import { PY_RUNNER, executePythonCodeNode, parsePythonRunnerOutput, type PythonExecutionInput, type PythonExecutionResult } from "./python-runner";

export type CodeSandboxMode = "auto" | "container" | "in_process";

export type CodeSandboxPlan =
  | { kind: "disabled"; reason: string }
  | { kind: "in_process"; reason?: string }
  | {
      kind: "container";
      runtime: "docker" | "podman";
      runtimePath: string;
      jsImage: string;
      pythonImage: string;
      memoryMb: number;
      cpus: number;
      pidsLimit: number;
      /** Extra time allowed for the container to start, on top of the code's own timeout. */
      startupMs: number;
      /** Label value shared by this deployment's containers, so the startup sweep finds leftovers. */
      instanceLabel: string;
    };

export const IN_PROCESS_CODE_SANDBOX: CodeSandboxPlan = { kind: "in_process" };

export const CODE_NODES_DISABLED_MESSAGE = "Code nodes are disabled on this deployment (CODE_NODES_ENABLED=false). Ask an admin to enable them.";

export function codeNodesDisabledError(plan: Extract<CodeSandboxPlan, { kind: "disabled" }>): WorkflowError {
  return new WorkflowError(plan.reason, ErrorCategory.CONFIGURATION, false);
}

export interface CodeRunOutput {
  result: unknown;
  logs: string[];
}

/**
 * The in-realm harness: returns a setter for (code, payload JSON), defines
 * `__l2mStart` (parse the payload into `input`, compile the code as an async
 * function body in the realm, run it) and `__l2mResult` (the outcome as a JSON
 * string once the code has settled, undefined before). The code is compiled
 * by the realm's own AsyncFunction, so it cannot break out of a wrapper, and
 * every error is caught and described inside the realm.
 */
export const CODE_PRELUDE_SOURCE = String.raw`(() => {
  "use strict";
  const stringify = JSON.stringify, parse = JSON.parse, toText = String;
  const AsyncFunction = (async function () {}).constructor;
  const logs = [];
  let code = "";
  let payload = "null";
  let out;
  const format = (args) => {
    const parts = [];
    for (const arg of args) {
      if (typeof arg === "string") { parts.push(arg); continue; }
      try {
        const text = stringify(arg);
        parts.push(text === undefined ? toText(arg) : text);
      } catch (error) {
        parts.push(toText(arg));
      }
    }
    return parts.join(" ");
  };
  const logger = (prefix) => (...args) => {
    if (logs.length < 1000) logs.push(prefix + format(args));
  };
  globalThis.console = { log: logger(""), info: logger(""), debug: logger(""), warn: logger("WARN: "), error: logger("ERROR: ") };
  const describe = (error) => {
    try {
      if (error && typeof error === "object") {
        if (typeof error.message === "string" && error.message.trim()) return error.message.trim();
        if (typeof error.name === "string" && error.name.trim()) return error.name.trim();
        const text = stringify(error);
        if (text && text !== "{}") return text;
      }
      return toText(error).trim() || "Code node execution failed.";
    } catch (inner) {
      return "Code node execution failed.";
    }
  };
  const finish = (value) => {
    let text;
    try { text = value === undefined ? "null" : stringify(value); } catch (error) { text = stringify(toText(value)); }
    out = '{"ok":true,"result":' + (text === undefined ? "null" : text) + ',"logs":' + stringify(logs) + "}";
  };
  const fail = (error) => {
    out = stringify({ ok: false, error: describe(error), logs });
  };
  Object.defineProperty(globalThis, "__l2mStart", {
    value: () => {
      try { globalThis.input = parse(payload); } catch (error) { fail(error); return; }
      let fn;
      try { fn = new AsyncFunction(code); } catch (error) { fail(error); return; }
      try { fn().then(finish, fail); } catch (error) { fail(error); }
    }
  });
  Object.defineProperty(globalThis, "__l2mResult", { value: () => out });
  return (nextCode, nextPayload) => { code = nextCode; payload = nextPayload; };
})()`;

const NEVER_SETTLED = "Code node did not finish: it waits on a promise that never settles (timers and network are not available in the sandbox).";

type HarnessSetter = (code: string, payload: string) => void;

function parseHarnessOutput(raw: unknown): CodeRunOutput {
  if (typeof raw !== "string") throw new Error(`Code node sandbox error: ${NEVER_SETTLED}`);
  let parsed: { ok?: unknown; result?: unknown; error?: unknown; logs?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error("Code node sandbox error: the sandbox returned an unreadable result.");
  }
  const logs = Array.isArray(parsed.logs) ? parsed.logs.filter((line): line is string => typeof line === "string") : [];
  if (parsed.ok === true) return { result: parsed.result ?? null, logs };
  throw new Error(`Code node sandbox error: ${typeof parsed.error === "string" ? parsed.error : "Code node execution failed."}`);
}

/** One JavaScript run in a fresh, hardened realm of this process. */
export function runJavaScriptInProcess(code: string, input: unknown, timeoutMs: number): CodeRunOutput {
  const context = createBareContext();
  vm.runInContext(REALM_HARDEN_SOURCE, context);
  const setJob = vm.runInContext(CODE_PRELUDE_SOURCE, context) as HarnessSetter;
  setJob(code, toSandboxJson(input));
  try {
    vm.runInContext("__l2mStart()", context, { timeout: timeoutMs, filename: "code-node.js" });
  } catch (error) {
    // Only the host's own timeout error can reach here; the harness catches everything the code throws.
    const message = error instanceof Error ? error.message : "Code node execution failed.";
    throw new Error(`Code node sandbox error: ${message}`);
  }
  return parseHarnessOutput(vm.runInContext("__l2mResult()", context, { timeout: 100 }));
}

/** The program a container runs for JavaScript: the same harness, fed from stdin. */
export const CONTAINER_JS_RUNNER = String.raw`"use strict";
const vm = require("node:vm");
const HARDEN = ${JSON.stringify(REALM_HARDEN_SOURCE)};
const PRELUDE = ${JSON.stringify(CODE_PRELUDE_SOURCE)};
const dont = vm.constants && vm.constants.DONT_CONTEXTIFY;
const runOne = (code, payload, timeout) => {
  const options = { microtaskMode: "afterEvaluate", codeGeneration: { strings: true, wasm: false } };
  const context = dont !== undefined ? vm.createContext(dont, options) : vm.createContext(Object.create(null), options);
  vm.runInContext(HARDEN, context);
  vm.runInContext(PRELUDE, context)(code, payload);
  try {
    vm.runInContext("__l2mStart()", context, { timeout, filename: "code-node.js" });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error && error.message), logs: [] });
  }
  const raw = vm.runInContext("__l2mResult()", context, { timeout: 100 });
  return typeof raw === "string" ? raw : null;
};
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const job = JSON.parse(raw);
  process.stdout.write(JSON.stringify(job.payloads.map((payload) => runOne(job.code, payload, job.timeoutMs))));
});
`;

interface ContainerRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** Spawner seam for tests: by default the real container CLI. */
export type ContainerSpawn = typeof spawn;

let containerSpawn: ContainerSpawn = spawn;

/** Replaces the process spawner (tests only). */
export function setContainerSpawnForTesting(next: ContainerSpawn | null): void {
  containerSpawn = next ?? spawn;
}

const MAX_CONTAINER_OUTPUT_BYTES = 64 * 1024 * 1024;

function runContainer(
  plan: Extract<CodeSandboxPlan, { kind: "container" }>,
  image: string,
  command: string,
  args: string[],
  stdin: string,
  budgetMs: number
): Promise<ContainerRunResult> {
  const name = `l2m-code-${randomUUID().slice(0, 12)}`;
  const runArgs = buildContainerRunArgs({
    settings: { mode: "container", image, memoryMb: plan.memoryMb, cpus: plan.cpus, pidsLimit: plan.pidsLimit, network: "none" },
    command,
    args,
    envNames: [],
    containerName: name,
    instanceLabel: plan.instanceLabel,
    owner: currentSandboxOwner(),
    mounts: []
  });
  return new Promise<ContainerRunResult>((resolve, reject) => {
    // The CLI gets an empty environment apart from PATH/HOME: no API secrets, and none are passed into the container.
    const child = containerSpawn(plan.runtimePath, runArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? os.tmpdir() },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let settled = false;
    const remove = () => {
      const cleanup = containerSpawn(plan.runtimePath, ["rm", "-f", name], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" }, windowsHide: true });
      cleanup.on("error", () => undefined);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      remove();
    }, budgetMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new WorkflowError(`Container runtime '${plan.runtime}' could not start: ${error.message}`, ErrorCategory.CONFIGURATION, false));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_CONTAINER_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        remove();
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin);
  });
}

function containerFailure(plan: Extract<CodeSandboxPlan, { kind: "container" }>, image: string, run: ContainerRunResult, budgetMs: number): WorkflowError {
  if (run.timedOut) {
    return new WorkflowError(`Code node container timed out after ${budgetMs}ms`, ErrorCategory.WORKFLOW_TIMEOUT, false);
  }
  const detail = run.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
  // 125-127 are the CLI's own failures (daemon, image, command), not the code's.
  if (run.code !== null && run.code >= 125 && run.code <= 127) {
    return new WorkflowError(`Code node container could not run (${plan.runtime}, image ${image}): ${detail || `exit ${run.code}`}`, ErrorCategory.CONFIGURATION, false);
  }
  return new WorkflowError(`Code node container exited with code ${run.code}: ${detail}`, ErrorCategory.UNKNOWN, false);
}

/**
 * Runs JavaScript once per input, all in one sandbox: one container, or one
 * fresh realm per input in this process. Throws on the first failing input.
 */
export async function runJavaScriptCode(plan: CodeSandboxPlan, code: string, inputs: unknown[], timeoutMs: number): Promise<CodeRunOutput[]> {
  if (plan.kind === "disabled") throw codeNodesDisabledError(plan);
  if (plan.kind === "in_process") return inputs.map((input) => runJavaScriptInProcess(code, input, timeoutMs));
  const job = JSON.stringify({ code, timeoutMs, payloads: inputs.map((input) => toSandboxJson(input)) });
  const budgetMs = plan.startupMs + timeoutMs * Math.max(1, inputs.length);
  const run = await runContainer(plan, plan.jsImage, "node", ["-e", CONTAINER_JS_RUNNER], job, budgetMs);
  if (run.timedOut || run.code !== 0) throw containerFailure(plan, plan.jsImage, run, budgetMs);
  let outputs: unknown;
  try {
    outputs = JSON.parse(run.stdout);
  } catch {
    throw new Error("Code node sandbox error: the container returned an unreadable result.");
  }
  if (!Array.isArray(outputs) || outputs.length !== inputs.length) {
    throw new Error("Code node sandbox error: the container returned an unexpected result.");
  }
  return outputs.map((raw) => parseHarnessOutput(raw));
}

/** The environment a host Python subprocess gets: enough to start, nothing from the API's own environment. */
export function pythonHostEnv(workdir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: workdir,
    TMPDIR: workdir,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8"
  };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return env;
}

/** Runs a Python code node under the plan. */
export async function runPythonCode(plan: CodeSandboxPlan, input: PythonExecutionInput): Promise<PythonExecutionResult> {
  if (plan.kind === "disabled") throw codeNodesDisabledError(plan);
  const timeoutMs = input.timeoutMs ?? 15000;
  if (plan.kind === "in_process") {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-py-"));
    try {
      return await executePythonCodeNode({ ...input, timeoutMs, env: pythonHostEnv(workdir), cwd: workdir, isolated: true });
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }
  const budgetMs = plan.startupMs + timeoutMs;
  const run = await runContainer(plan, plan.pythonImage, "python3", ["-I", "-c", PY_RUNNER], JSON.stringify({ code: input.code, items: input.items, mode: input.mode }), budgetMs);
  if (run.timedOut) throw containerFailure(plan, plan.pythonImage, run, budgetMs);
  if (run.code !== 0 && !run.stdout) throw containerFailure(plan, plan.pythonImage, run, budgetMs);
  return parsePythonRunnerOutput(run.stdout, run.stderr);
}

export interface CodeSandboxSettings {
  enabled: boolean;
  mode: CodeSandboxMode;
  runtime: "auto" | "docker" | "podman";
  jsImage: string;
  pythonImage: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  startupMs: number;
  instanceLabel: string;
}

/** Checks whether an image is present locally (nothing is pulled). Seam for tests. */
export type ImagePresenceCheck = (runtimePath: string, image: string) => Promise<boolean>;

const defaultImagePresent: ImagePresenceCheck = (runtimePath, image) =>
  new Promise((resolve) => {
    const child = spawn(runtimePath, ["image", "inspect", "--format", "{{.Id}}", image], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" }, windowsHide: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, 10_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });

/**
 * Picks the plan for this deployment, with a warning when code runs on the
 * host. `auto` uses containers only when a runtime is installed and both
 * images are already present locally (so no run waits on a pull); `container`
 * insists on containers (images are pulled on first use) and fails code nodes
 * when no runtime is installed.
 */
export async function resolveCodeSandboxPlan(
  settings: CodeSandboxSettings,
  deps: { locator?: RuntimeLocator; imagePresent?: ImagePresenceCheck } = {}
): Promise<{ plan: CodeSandboxPlan; warning: string | null }> {
  if (!settings.enabled) return { plan: { kind: "disabled", reason: CODE_NODES_DISABLED_MESSAGE }, warning: null };
  const onHost = (reason: string) => ({
    plan: { kind: "in_process", reason } as CodeSandboxPlan,
    warning: `Code nodes run on the API host, not in a container: ${reason} JavaScript runs in an isolated realm without host access; Python runs as a subprocess with a minimal environment but can read files the API user can read. Set CODE_SANDBOX_MODE=container with docker or podman installed, or CODE_NODES_ENABLED=false.`
  });
  if (settings.mode === "in_process") return onHost("CODE_SANDBOX_MODE=in_process.");
  const found = detectContainerRuntime(settings.runtime, deps.locator);
  if (!found) {
    if (settings.mode === "container") {
      return {
        plan: { kind: "disabled", reason: `Code nodes need a container runtime (CODE_SANDBOX_MODE=container) and none was found (${settings.runtime === "auto" ? "docker or podman" : settings.runtime}).` },
        warning: "CODE_SANDBOX_MODE=container but no container runtime was found: code nodes will fail until docker or podman is installed."
      };
    }
    return onHost("no container runtime (docker or podman) was found.");
  }
  if (settings.mode === "auto") {
    const imagePresent = deps.imagePresent ?? defaultImagePresent;
    const [js, py] = await Promise.all([imagePresent(found.path, settings.jsImage), imagePresent(found.path, settings.pythonImage)]);
    if (!js || !py) {
      const missing = [!js ? settings.jsImage : null, !py ? settings.pythonImage : null].filter(Boolean).join(" and ");
      return onHost(`${found.runtime} is installed but ${missing} is not present locally (pull it to enable the container sandbox).`);
    }
  }
  return {
    plan: {
      kind: "container",
      runtime: found.runtime,
      runtimePath: found.path,
      jsImage: settings.jsImage,
      pythonImage: settings.pythonImage,
      memoryMb: settings.memoryMb,
      cpus: settings.cpus,
      pidsLimit: settings.pidsLimit,
      startupMs: settings.startupMs,
      instanceLabel: settings.instanceLabel
    },
    warning: null
  };
}

/** A short description for the editor and logs. */
export function describeCodeSandboxPlan(plan: CodeSandboxPlan): { mode: "container" | "in_process" | "disabled"; detail: string } {
  if (plan.kind === "disabled") return { mode: "disabled", detail: plan.reason };
  if (plan.kind === "in_process") return { mode: "in_process", detail: plan.reason ?? "Code runs on the API host." };
  return { mode: "container", detail: `${plan.runtime}: ${plan.jsImage}, ${plan.pythonImage}` };
}

