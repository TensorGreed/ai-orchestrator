/**
 * Phase 10.8 — the `l2m` command line.
 *
 *   l2m mcp check     CI gate: breaking schema changes, unreachable servers,
 *                     policy-blocked tools. Against the API (API key) or
 *                     offline against exported snapshot files.
 *   l2m mcp mock      A stdio MCP server answering from a snapshot file and,
 *                     optionally, a cassette.
 *   l2m mcp snapshot export
 *                     Download a server's accepted snapshot for the two above.
 *
 *   l2m audit verify  Phase 11.1 — verify an audit bundle offline: signature,
 *                     signed file index and manifest digest.
 *
 * Exit codes: 0 clean, 1 the check found problems (or a request failed),
 * 2 usage errors.
 */
import fs from "node:fs";
import {
  judgeMcpCheck,
  type McpCheckReport,
  type McpCheckServerResult,
  type McpSnapshotFile
} from "@ai-orchestrator/shared";
import {
  diffToolSnapshots,
  hashToolSnapshot,
  HttpMCPServerAdapter,
  normalizeToolSnapshot,
  parseCassette,
  parseSnapshotFile,
  serveSnapshotMockOverStdio,
  SnapshotMockServer,
  StdioMCPServerAdapter,
  type MCPExecutionContext,
  type MCPServerAdapter
} from "@ai-orchestrator/mcp-sdk";
import { listFlag, oneFlag, parseArgs, splitCommand, UsageError, type ParsedArgs } from "./args";
import { formatAuditVerifyResult, parsePublicKeyInput, PublicKeyInputError, verifyAuditBundle } from "./audit-verify";

export interface CliIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

const DEFAULT_TIMEOUT_MS = 15_000;

const USAGE = `Usage:
  l2m mcp check [--server <id>]... [--toolset <id>] [--workflow <id>]...
                [--api-url <url>] [--api-key <key>]
                [--allow-unreachable] [--allow-policy-blocked] [--json]
  l2m mcp check --snapshot <file>... (--stdio "<command>" | --url <endpoint> | --against <file>)
                [--timeout <ms>] [--allow-unreachable] [--json]
  l2m mcp mock --snapshot <file> [--cassette <file>] [--fixed-text <text>]
  l2m mcp snapshot export --server <id> [--out <file>] [--api-url <url>] [--api-key <key>]
  l2m audit verify <bundle.zip> [--public-key <file|base64>] [--json]

The API URL and key default to L2M_API_URL and L2M_API_KEY.
Exit codes: 0 clean, 1 problems found or a request failed, 2 usage error.
`;

function write(stream: NodeJS.WritableStream, text: string): void {
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

function readJsonFile(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${file} is not JSON`);
  }
}

function loadSnapshot(file: string): McpSnapshotFile {
  try {
    return parseSnapshotFile(readJsonFile(file));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface ApiTarget {
  url: string;
  key: string;
  fetch: typeof fetch;
}

function apiTarget(args: ParsedArgs, io: CliIo): ApiTarget {
  const url = (oneFlag(args, "api-url") ?? io.env.L2M_API_URL ?? "").trim().replace(/\/+$/, "");
  const key = (oneFlag(args, "api-key") ?? io.env.L2M_API_KEY ?? "").trim();
  if (!url) throw new UsageError("Set --api-url or L2M_API_URL");
  if (!key) throw new UsageError("Set --api-key or L2M_API_KEY");
  return { url, key, fetch: io.fetch ?? fetch };
}

class RequestError extends Error {}

async function apiRequest<T>(target: ApiTarget, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await target.fetch(`${target.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${target.key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
  } catch (error) {
    throw new RequestError(`Cannot reach ${target.url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "error" in parsed ? String((parsed as { error: unknown }).error) : text.slice(0, 200);
    throw new RequestError(`${method} ${path} failed with ${response.status}: ${message}`);
  }
  return parsed as T;
}

// --- check -------------------------------------------------------------------

function formatReport(report: McpCheckReport, offline: boolean): string {
  const lines: string[] = [];
  for (const server of report.servers) {
    if (!server.reachable) {
      lines.push(`✗ ${server.name}  unreachable: ${server.error ?? "no answer"}`);
      continue;
    }
    const latency = server.latencyMs !== null ? ` ${server.latencyMs} ms` : "";
    if (!server.acceptedHash) {
      lines.push(`• ${server.name}  reachable${latency}, no accepted snapshot to compare against`);
    } else if (server.changes.length === 0) {
      lines.push(`✓ ${server.name}  matches the accepted snapshot${latency}`);
    } else {
      lines.push(`${server.breaking ? "✗" : "•"} ${server.name}  ${server.changes.length} change${server.changes.length === 1 ? "" : "s"}${latency}`);
    }
    for (const change of server.changes) {
      lines.push(`    ${change.breaking ? "breaking" : "additive"}  ${change.tool}${change.path ? ` ${change.path}` : ""}: ${change.detail}`);
    }
  }
  for (const blocked of report.blockedTools) {
    lines.push(`✗ ${blocked.workflowName} / ${blocked.nodeId} uses '${blocked.toolName}', blocked by ${blocked.reason}: ${blocked.message}`);
  }
  if (offline) lines.push("  (offline check: tool policies are not evaluated)");
  lines.push("");
  lines.push(
    report.ok
      ? `OK: ${report.servers.length} server${report.servers.length === 1 ? "" : "s"} checked`
      : `FAILED: ${report.failures.map((failure) => failure.detail).join("; ")}`
  );
  return lines.join("\n");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Compare one live target, or a second snapshot file, with each accepted snapshot file. */
async function offlineCheck(args: ParsedArgs, snapshots: McpSnapshotFile[]): Promise<McpCheckServerResult[]> {
  const stdio = oneFlag(args, "stdio");
  const url = oneFlag(args, "url");
  const against = oneFlag(args, "against");
  const targets = [stdio, url, against].filter((value) => value !== undefined);
  if (targets.length !== 1) throw new UsageError("Offline check needs exactly one of --stdio, --url or --against");
  const timeoutRaw = oneFlag(args, "timeout");
  const timeoutMs = timeoutRaw !== undefined ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new UsageError("--timeout must be a positive number of milliseconds");

  let current: { tools: ReturnType<typeof normalizeToolSnapshot>; latencyMs: number | null } | { error: string; latencyMs: number | null };
  if (against) {
    current = { tools: normalizeToolSnapshot(loadSnapshot(against).snapshot.tools), latencyMs: null };
  } else {
    let adapter: MCPServerAdapter;
    let connection: Record<string, unknown>;
    if (stdio) {
      const [command, ...commandArgs] = splitCommand(stdio);
      if (!command) throw new UsageError("--stdio needs a command");
      adapter = new StdioMCPServerAdapter();
      connection = { command, args: commandArgs, timeoutMs };
    } else {
      adapter = new HttpMCPServerAdapter();
      connection = { endpoint: url, timeoutMs };
    }
    const context: MCPExecutionContext = { resolveSecret: async () => undefined, runtimeState: new Map<string, unknown>() };
    const started = performance.now();
    try {
      const tools = await withTimeout(adapter.discoverTools({ serverId: "l2m-check", connection }, context), timeoutMs);
      current = { tools: normalizeToolSnapshot(tools), latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      current = { error: error instanceof Error ? error.message : String(error), latencyMs: Math.round(performance.now() - started) };
    } finally {
      try {
        await adapter.closeSessions?.(context);
      } catch {
        // Closing the probe session is best effort.
      }
    }
  }

  return snapshots.map((file) => {
    const base: McpCheckServerResult = {
      serverId: file.server.id,
      name: file.server.name,
      adapterId: file.server.adapterId,
      reachable: false,
      error: null,
      latencyMs: current.latencyMs,
      acceptedHash: file.snapshot.hash,
      currentHash: null,
      breaking: false,
      changes: []
    };
    if ("error" in current) return { ...base, error: current.error };
    const diff = diffToolSnapshots(normalizeToolSnapshot(file.snapshot.tools), current.tools);
    return { ...base, reachable: true, currentHash: hashToolSnapshot(current.tools), breaking: diff.breaking, changes: diff.changes };
  });
}

async function runCheck(args: ParsedArgs, io: CliIo): Promise<number> {
  const json = args.booleans.has("json");
  const failOnUnreachable = !args.booleans.has("allow-unreachable");
  const failOnPolicyBlocked = !args.booleans.has("allow-policy-blocked");
  const snapshotFiles = listFlag(args, "snapshot");

  let report: McpCheckReport;
  if (snapshotFiles.length > 0) {
    const servers = await offlineCheck(args, snapshotFiles.map(loadSnapshot));
    const judged = judgeMcpCheck(servers, [], { failOnUnreachable });
    report = { ok: judged.ok, checkedAt: new Date().toISOString(), servers, blockedTools: [], failures: judged.failures };
  } else {
    if (oneFlag(args, "stdio") || oneFlag(args, "url") || oneFlag(args, "against")) {
      throw new UsageError("--stdio, --url and --against need --snapshot");
    }
    const target = apiTarget(args, io);
    const toolset = oneFlag(args, "toolset");
    const servers = listFlag(args, "server");
    const workflows = listFlag(args, "workflow");
    report = await apiRequest<McpCheckReport>(target, "POST", "/api/mcp/check", {
      ...(servers.length > 0 ? { serverIds: servers } : {}),
      ...(toolset ? { toolsetId: toolset } : {}),
      ...(workflows.length > 0 ? { workflowIds: workflows } : {}),
      failOnUnreachable,
      failOnPolicyBlocked
    });
  }
  write(io.stdout, json ? JSON.stringify(report, null, 2) : formatReport(report, snapshotFiles.length > 0));
  return report.ok ? EXIT_OK : EXIT_FAILED;
}

// --- mock --------------------------------------------------------------------

async function runMock(args: ParsedArgs, io: CliIo): Promise<number> {
  const snapshotPath = oneFlag(args, "snapshot");
  if (!snapshotPath) throw new UsageError("l2m mcp mock needs --snapshot <file>");
  const snapshot = loadSnapshot(snapshotPath);
  const cassettePath = oneFlag(args, "cassette");
  let cassette;
  if (cassettePath) {
    try {
      cassette = parseCassette(readJsonFile(cassettePath));
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError(`${cassettePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const fixedText = oneFlag(args, "fixed-text");
  const server = new SnapshotMockServer(snapshot, { ...(cassette ? { cassette } : {}), ...(fixedText ? { fixedText } : {}) });
  // stdout is the protocol channel; diagnostics go to stderr only.
  write(io.stderr, `l2m mock: serving ${server.tools.length} tool${server.tools.length === 1 ? "" : "s"} from '${snapshot.server.name}' over stdio`);
  await serveSnapshotMockOverStdio(server, {
    input: io.stdin,
    output: io.stdout,
    ...(args.booleans.has("verbose") ? { log: (line: string) => write(io.stderr, line) } : {})
  });
  return EXIT_OK;
}

// --- snapshot export ---------------------------------------------------------

async function runSnapshotExport(args: ParsedArgs, io: CliIo): Promise<number> {
  const serverId = oneFlag(args, "server");
  if (!serverId) throw new UsageError("l2m mcp snapshot export needs --server <id>");
  const target = apiTarget(args, io);
  const file = await apiRequest<McpSnapshotFile>(target, "GET", `/api/mcp/servers/${encodeURIComponent(serverId)}/snapshot/export`);
  const text = `${JSON.stringify(file, null, 2)}\n`;
  const out = oneFlag(args, "out");
  if (out) {
    fs.writeFileSync(out, text);
    write(io.stderr, `Wrote ${file.snapshot.tools.length} tools (snapshot ${file.snapshot.hash.slice(0, 12)}) to ${out}`);
  } else {
    io.stdout.write(text);
  }
  return EXIT_OK;
}

// --- audit verify ------------------------------------------------------------

function runAuditVerify(args: ParsedArgs, io: CliIo): number {
  const [, , file, extra] = args.positionals;
  if (!file || extra) throw new UsageError("l2m audit verify needs exactly one bundle file");
  let publicKey: Buffer | undefined;
  const keyFlag = oneFlag(args, "public-key");
  if (keyFlag !== undefined) {
    try {
      publicKey = parsePublicKeyInput(keyFlag);
    } catch (error) {
      if (error instanceof PublicKeyInputError) throw new UsageError(error.message);
      throw error;
    }
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    throw new UsageError(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = verifyAuditBundle(new Uint8Array(bytes), { bundle: file, ...(publicKey ? { publicKey } : {}) });
  if (args.booleans.has("json")) io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else io.stdout.write(formatAuditVerifyResult(result));
  return result.ok ? EXIT_OK : EXIT_FAILED;
}

// --- entry -------------------------------------------------------------------

const BOOLEAN_FLAGS = ["json", "allow-unreachable", "allow-policy-blocked", "verbose", "help"];

export async function main(argv: string[], io: CliIo): Promise<number> {
  try {
    const args = parseArgs(argv, BOOLEAN_FLAGS);
    const [group, command, sub] = args.positionals;
    if (args.booleans.has("help") || !group) {
      write(args.booleans.has("help") ? io.stdout : io.stderr, USAGE);
      return args.booleans.has("help") ? EXIT_OK : EXIT_USAGE;
    }
    if (group === "mcp" && command === "check" && !sub) return await runCheck(args, io);
    if (group === "mcp" && command === "mock" && !sub) return await runMock(args, io);
    if (group === "mcp" && command === "snapshot" && sub === "export") return await runSnapshotExport(args, io);
    if (group === "audit" && command === "verify") return runAuditVerify(args, io);
    throw new UsageError(`Unknown command: ${args.positionals.join(" ")}`);
  } catch (error) {
    if (error instanceof UsageError) {
      write(io.stderr, `${error.message}\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    write(io.stderr, `l2m: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
}
