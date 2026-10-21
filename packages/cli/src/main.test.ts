import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { hashToolSnapshot, normalizeToolSnapshot } from "@ai-orchestrator/mcp-sdk";
import type { McpCheckReport, McpSnapshotFile } from "@ai-orchestrator/shared";
import { splitCommand } from "./args";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, main, type CliIo } from "./main";

const here = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(here, "../bin/l2m.mjs");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-cli-"));

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function snapshotFile(tools: McpSnapshotFile["snapshot"]["tools"], name = "Docs"): McpSnapshotFile {
  const normalized = normalizeToolSnapshot(tools);
  return {
    format: "l2m.mcp-snapshot",
    version: 1,
    exportedAt: "2026-10-01T00:00:00.000Z",
    server: { id: `mcp_${name.toLowerCase()}`, name, adapterId: "http_mcp" },
    snapshot: { hash: hashToolSnapshot(normalized), tools: normalized as McpSnapshotFile["snapshot"]["tools"] }
  };
}

const searchTool = {
  name: "search_docs",
  description: "Search the docs",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  outputSchema: { type: "object", properties: { hits: { type: "integer" } }, required: ["hits"] }
};
const readTool = { name: "read_page", description: "Read a page", inputSchema: { type: "object", properties: { id: { type: "string" } } } };

function writeJson(name: string, value: unknown): string {
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

const accepted = writeJson("accepted.json", snapshotFile([searchTool, readTool]));
const same = writeJson("same.json", snapshotFile([readTool, searchTool]));
const additive = writeJson("additive.json", snapshotFile([searchTool, readTool, { name: "list_pages", inputSchema: { type: "object" } }]));
const breaking = writeJson("breaking.json", snapshotFile([searchTool]));

function io(extra: Partial<CliIo> = {}): CliIo & { out: () => string; err: () => string } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  return { stdin: new PassThrough(), stdout, stderr, env: {}, ...extra, out: () => out, err: () => err };
}

describe("splitCommand", () => {
  it("honours quotes", () => {
    expect(splitCommand(`node "my server.js" --flag 'a b' ""`)).toEqual(["node", "my server.js", "--flag", "a b", ""]);
  });
});

describe("l2m mcp check offline", () => {
  it("exits 0 when the target matches, or only adds tools", async () => {
    const clean = io();
    expect(await main(["mcp", "check", "--snapshot", accepted, "--against", same], clean)).toBe(EXIT_OK);
    expect(clean.out()).toContain("✓ Docs  matches the accepted snapshot");
    expect(clean.out()).toContain("OK: 1 server checked");
    const added = io();
    expect(await main(["mcp", "check", "--snapshot", accepted, "--against", additive], added)).toBe(EXIT_OK);
    expect(added.out()).toContain("additive  list_pages");
  });

  it("exits 1 on breaking changes, with a JSON report", async () => {
    const human = io();
    expect(await main(["mcp", "check", "--snapshot", accepted, "--against", breaking], human)).toBe(EXIT_FAILED);
    expect(human.out()).toContain("breaking  read_page");
    expect(human.out()).toContain("FAILED: Docs: 1 breaking change against the accepted snapshot");

    const json = io();
    expect(await main(["mcp", "check", "--snapshot", accepted, "--against", breaking, "--json"], json)).toBe(EXIT_FAILED);
    const report = JSON.parse(json.out()) as McpCheckReport;
    expect(report.ok).toBe(false);
    expect(report.servers[0]).toMatchObject({ serverId: "mcp_docs", reachable: true, breaking: true });
    expect(report.servers[0].changes).toEqual([expect.objectContaining({ tool: "read_page", kind: "tool_removed", breaking: true })]);
    expect(report.failures).toEqual([expect.objectContaining({ kind: "breaking", serverId: "mcp_docs" })]);
  });

  it("exits 1 when the target is unreachable, unless allowed", async () => {
    const down = io();
    expect(await main(["mcp", "check", "--snapshot", accepted, "--url", "http://127.0.0.1:9/mcp", "--timeout", "1500", "--json"], down)).toBe(EXIT_FAILED);
    const report = JSON.parse(down.out()) as McpCheckReport;
    expect(report.servers[0]).toMatchObject({ reachable: false, currentHash: null });
    expect(report.failures[0].kind).toBe("unreachable");
    const allowed = io();
    expect(await main(["mcp", "check", "--snapshot", accepted, "--url", "http://127.0.0.1:9/mcp", "--timeout", "1500", "--allow-unreachable"], allowed)).toBe(EXIT_OK);
    expect(allowed.out()).toContain("unreachable");
  }, 30_000);

  it("checks a live stdio server: the snapshot mock of itself is clean", async () => {
    const run = io();
    const code = await main(["mcp", "check", "--snapshot", accepted, "--stdio", `${process.execPath} ${binPath} mcp mock --snapshot ${accepted}`, "--json"], run);
    const report = JSON.parse(run.out()) as McpCheckReport;
    expect(report.servers[0]).toMatchObject({ reachable: true, breaking: false, changes: [] });
    expect(report.servers[0].currentHash).toBe(report.servers[0].acceptedHash);
    expect(code).toBe(EXIT_OK);
  }, 30_000);

  it("exits 2 on usage errors", async () => {
    expect(await main([], io())).toBe(EXIT_USAGE);
    expect(await main(["mcp", "nope"], io())).toBe(EXIT_USAGE);
    expect(await main(["mcp", "check", "--snapshot", accepted], io())).toBe(EXIT_USAGE);
    expect(await main(["mcp", "check", "--snapshot", path.join(tempDir, "missing.json"), "--against", same], io())).toBe(EXIT_USAGE);
    expect(await main(["mcp", "check", "--server", "mcp_1"], io())).toBe(EXIT_USAGE);
    expect(await main(["mcp", "check", "--against", same], io({ env: { L2M_API_URL: "http://x", L2M_API_KEY: "k" } }))).toBe(EXIT_USAGE);
    const help = io();
    expect(await main(["--help"], help)).toBe(EXIT_OK);
    expect(help.out()).toContain("l2m mcp check");
  });
});

describe("l2m mcp check against the API", () => {
  function fakeApi(report: McpCheckReport | { status: number; error: string }) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if ("status" in report) return new Response(JSON.stringify({ error: report.error }), { status: report.status });
      return new Response(JSON.stringify(report), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }
  const server = {
    serverId: "mcp_1",
    name: "Docs",
    adapterId: "http_mcp",
    reachable: true,
    error: null,
    latencyMs: 12,
    acceptedHash: "a",
    currentHash: "a",
    breaking: false,
    changes: []
  };

  it("sends the selection and API key, and exits on the report", async () => {
    const clean = fakeApi({ ok: true, checkedAt: "", servers: [server], blockedTools: [], failures: [] });
    const run = io({ env: { L2M_API_URL: "http://api.local/", L2M_API_KEY: "l2m_key" }, fetch: clean.fetchImpl });
    expect(await main(["mcp", "check", "--server", "mcp_1,mcp_2", "--workflow", "wf_1", "--allow-policy-blocked"], run)).toBe(EXIT_OK);
    expect(clean.calls[0].url).toBe("http://api.local/api/mcp/check");
    expect((clean.calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer l2m_key");
    expect(JSON.parse(String(clean.calls[0].init.body))).toEqual({
      serverIds: ["mcp_1", "mcp_2"],
      workflowIds: ["wf_1"],
      failOnUnreachable: true,
      failOnPolicyBlocked: false
    });
    expect(run.out()).toContain("✓ Docs");

    const blocked = fakeApi({
      ok: false,
      checkedAt: "",
      servers: [server],
      blockedTools: [{ workflowId: "wf_1", workflowName: "Support", nodeId: "tool", serverId: "mcp_1", toolName: "delete_page", reason: "policy", message: "Denied" }],
      failures: [{ kind: "policy_blocked", serverId: "mcp_1", detail: "Support (tool) uses 'delete_page'" }]
    });
    const failed = io({ fetch: blocked.fetchImpl });
    expect(await main(["mcp", "check", "--toolset", "ts_1", "--api-url", "http://api.local", "--api-key", "k"], failed)).toBe(EXIT_FAILED);
    expect(JSON.parse(String(blocked.calls[0].init.body))).toMatchObject({ toolsetId: "ts_1" });
    expect(failed.out()).toContain("uses 'delete_page', blocked by policy");
  });

  it("exits 1 when the API refuses or cannot be reached", async () => {
    const refused = fakeApi({ status: 401, error: "Authentication required" });
    const run = io({ fetch: refused.fetchImpl });
    expect(await main(["mcp", "check", "--api-url", "http://api.local", "--api-key", "bad"], run)).toBe(EXIT_FAILED);
    expect(run.err()).toContain("failed with 401: Authentication required");
    const down = io();
    expect(await main(["mcp", "check", "--api-url", "http://127.0.0.1:9", "--api-key", "k"], down)).toBe(EXIT_FAILED);
    expect(down.err()).toContain("Cannot reach http://127.0.0.1:9");
  });
});

describe("l2m mcp snapshot export", () => {
  it("writes the accepted snapshot to a file", async () => {
    const file = snapshotFile([searchTool]);
    const fetchImpl = (async () => new Response(JSON.stringify(file), { status: 200 })) as unknown as typeof fetch;
    const out = path.join(tempDir, "exported.json");
    const run = io({ env: { L2M_API_URL: "http://api.local", L2M_API_KEY: "k" }, fetch: fetchImpl });
    expect(await main(["mcp", "snapshot", "export", "--server", "mcp_docs", "--out", out], run)).toBe(EXIT_OK);
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual(file);
    expect(run.err()).toContain(`Wrote 1 tools`);
    expect(await main(["mcp", "snapshot", "export"], io())).toBe(EXIT_USAGE);
  });
});

describe("l2m mcp mock", () => {
  it("answers initialize, tools/list and tools/call over stdio", async () => {
    const cassette = writeJson("cassette.json", {
      format: "l2m.mcp-cassette",
      version: 1,
      recordedAt: "2026-10-01T00:00:00.000Z",
      servers: [{ key: "registry:mcp_docs", adapterId: "http_mcp", registryServerId: "mcp_docs" }],
      entries: [
        {
          seq: 1,
          server: "registry:mcp_docs",
          method: "tools/call",
          name: "search_docs",
          args: { query: "replay" },
          argsHash: "x",
          result: { ok: true, output: { hits: 7 }, structured: { hits: 7 } },
          at: 0,
          durationMs: 3
        }
      ],
      truncated: false,
      bytes: 100,
      llm: "not_recorded"
    });
    const child = spawn(process.execPath, [binPath, "mcp", "mock", "--snapshot", accepted, "--cassette", cassette], { stdio: ["pipe", "pipe", "pipe"] });
    const responses: Array<Record<string, unknown>> = [];
    let stderrText = "";
    child.stderr.on("data", (chunk: Buffer) => (stderrText += chunk.toString()));
    let buffer = "";
    const waitFor = (count: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out; got ${JSON.stringify(responses)}; stderr ${stderrText}`)), 20_000);
        const check = () => {
          if (responses.length >= count) {
            clearTimeout(timer);
            resolve();
          }
        };
        child.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          let index = buffer.indexOf("\n");
          while (index >= 0) {
            responses.push(JSON.parse(buffer.slice(0, index)));
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf("\n");
          }
          check();
        });
      });
    const done = waitFor(3);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_docs", arguments: { query: "replay" } } });
    await done;
    child.stdin.end();
    await new Promise((resolve) => child.on("close", resolve));
    const byId = new Map(responses.map((response) => [response.id, response.result as Record<string, unknown>]));
    expect(byId.get(1)).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
    expect((byId.get(2)!.tools as Array<{ name: string }>).map((tool) => tool.name).sort()).toEqual(["read_page", "search_docs"]);
    expect(byId.get(3)).toMatchObject({ structuredContent: { hits: 7 } });
  }, 30_000);

  it("exits 2 without a snapshot", async () => {
    expect(await main(["mcp", "mock"], io())).toBe(EXIT_USAGE);
  });
});
