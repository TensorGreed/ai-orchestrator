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
 *   l2m replay run    Phase 15.1 — replay a golden run against the draft or a
 *                     saved version and gate on the diff. Connector, HTTP,
 *                     MCP and code nodes are answered from the recording;
 *                     expressions in the nodes that run are still evaluated.
 *
 * Exit codes: 0 clean, 1 the check found problems (or a request failed),
 * 2 usage errors, 3 an audit bundle is internally consistent but its signer
 * was not verified (no --public-key), 4 a replay could not complete (the
 * recording could not answer the candidate or reached a node it never saw,
 * the request failed, or the answer was not a replay result). A replay whose flags the API rejects
 * (400) exits 2, like any usage error.
 */
import fs from "node:fs";
import {
  DEFAULT_ZIP_MAX_TOTAL_BYTES,
  judgeMcpCheck,
  judgeReplayDiff,
  REPLAY_IGNORE_PATHS_MAX,
  REPLAY_MCP_MODES,
  replayIgnorePathSchema,
  type ReplayRunResponse,
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
/** `l2m audit verify` without a trusted public key: consistent, but not proven to come from the deployment. */
export const EXIT_SIGNER_UNVERIFIED = 3;
/** `l2m replay run`: the replay could not complete, so it proves nothing either way. */
export const EXIT_INCOMPLETE = 4;

const DEFAULT_TIMEOUT_MS = 15_000;

const USAGE = `Usage:
  l2m mcp check [--server <id>]... [--toolset <id>] [--workflow <id>]...
                [--api-url <url>] [--api-key <key>]
                [--allow-unreachable] [--allow-policy-blocked] [--json]
  l2m mcp check --snapshot <file>... (--stdio "<command>" | --url <endpoint> | --against <file>)
                [--timeout <ms>] [--allow-unreachable] [--json]
  l2m mcp mock --snapshot <file> [--cassette <file>] [--fixed-text <text>]
  l2m mcp snapshot export --server <id> [--out <file>] [--api-url <url>] [--api-key <key>]
  l2m audit verify <bundle.zip> [--public-key <file|base64>] [--trust-embedded-key]
                   [--max-bytes <n>] [--json]
  l2m replay run --recording <id> [--draft | --version <n>] [--mcp strict|lenient]
                 [--ignore-path <glob>]... [--number-tolerance <n>]
                 [--api-url <url>] [--api-key <key>] [--json]

The API URL and key default to L2M_API_URL and L2M_API_KEY.
Exit codes: 0 clean (replay: pass), 1 problems found or a request failed
(replay: the candidate differs from the golden run), 2 usage error
(replay: also flags the API rejects),
3 audit bundle signer not verified (no --public-key; see --trust-embedded-key),
4 a replay could not complete.
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

class RequestError extends Error {
  constructor(
    message: string,
    /** The HTTP status, when the API answered. */
    readonly status: number | null = null
  ) {
    super(message);
  }
}

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
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new RequestError(`${method} ${path}: the response could not be read: ${error instanceof Error ? error.message : String(error)}`, response.status);
  }
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "error" in parsed ? String((parsed as { error: unknown }).error) : text.slice(0, 200);
    throw new RequestError(`${method} ${path} failed with ${response.status}: ${message}`, response.status);
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
  const trustEmbeddedKey = args.booleans.has("trust-embedded-key");
  if (trustEmbeddedKey && publicKey) throw new UsageError("--trust-embedded-key and --public-key cannot be combined");
  let maxBytes = DEFAULT_ZIP_MAX_TOTAL_BYTES;
  const maxFlag = oneFlag(args, "max-bytes");
  if (maxFlag !== undefined) {
    if (!/^\d+$/.test(maxFlag.trim()) || Number(maxFlag) <= 0 || !Number.isSafeInteger(Number(maxFlag))) throw new UsageError("--max-bytes must be a positive whole number of bytes");
    maxBytes = Number(maxFlag);
  }
  let bytes: Buffer;
  try {
    // The archive is read into memory, so refuse files larger than the expansion cap before reading them.
    if (fs.statSync(file).size > maxBytes) throw new UsageError(`${file} is larger than --max-bytes (${maxBytes} bytes)`);
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = verifyAuditBundle(new Uint8Array(bytes), { bundle: file, maxBytes, trustEmbeddedKey, ...(publicKey ? { publicKey } : {}) });
  if (args.booleans.has("json")) io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else io.stdout.write(formatAuditVerifyResult(result));
  if (result.status === "fail") return EXIT_FAILED;
  if (result.status === "signer_unverified" && !result.ok) return EXIT_SIGNER_UNVERIFIED;
  return EXIT_OK;
}

// --- replay run --------------------------------------------------------------

function formatReplay(result: ReplayRunResponse, verdict: string, reasons: string[]): string {
  const lines: string[] = [];
  const candidate = result.candidate.kind === "version" ? `version ${result.candidate.version}` : "draft";
  lines.push(`Replay of ${result.recordingId} against the ${candidate}: ${verdict.toUpperCase()}`);
  lines.push(`  execution ${result.executionId}, status ${result.diff.status.baseline} -> ${result.diff.status.candidate}`);
  for (const reason of reasons) lines.push(`  - ${reason}`);
  if (!result.diff.output.equal) {
    for (const change of result.diff.output.changes.slice(0, 20)) {
      lines.push(`  output ${change.kind} ${change.path || "(root)"}: ${JSON.stringify(change.baseline ?? null)} -> ${JSON.stringify(change.candidate ?? null)}`);
    }
    if (result.diff.output.changes.length > 20) lines.push(`  ... ${result.diff.output.changes.length - 20} more output changes`);
  }
  for (const step of result.diff.toolCalls.steps) {
    if (step.kind === "matched" && !step.argsChanged && !step.outcomeChanged) continue;
    const call = step.candidate ?? step.baseline;
    lines.push(`  tool ${step.kind}${step.argsChanged ? " (arguments changed)" : ""}${step.outcomeChanged ? " (outcome changed)" : ""}: ${call?.server ?? ""}/${call?.tool ?? ""}`);
  }
  for (const warning of result.diff.health) lines.push(`  ${warning.blocking ? "blocking" : "warning"} ${warning.kind}: ${warning.message}`);
  return lines.join("\n");
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Whether a 2xx body has everything the verdict and the report are built from. */
function isReplayRunResponse(value: unknown): value is ReplayRunResponse {
  if (!isObject(value) || !isObject(value.diff) || !isObject(value.candidate)) return false;
  const diff = value.diff;
  return (
    isObject(diff.status) &&
    typeof diff.status.regression === "boolean" &&
    isObject(diff.output) &&
    typeof diff.output.equal === "boolean" &&
    Array.isArray(diff.output.changes) &&
    isObject(diff.toolCalls) &&
    Array.isArray(diff.toolCalls.steps) &&
    Array.isArray(diff.health) &&
    diff.health.every((warning) => isObject(warning) && typeof warning.blocking === "boolean")
  );
}

async function runReplay(args: ParsedArgs, io: CliIo): Promise<number> {
  const recording = oneFlag(args, "recording");
  if (!recording) throw new UsageError("l2m replay run needs --recording <id>");
  const versionFlag = oneFlag(args, "version");
  const draft = args.booleans.has("draft");
  if (draft && versionFlag !== undefined) throw new UsageError("Choose --draft or --version, not both");
  let version: number | undefined;
  if (versionFlag !== undefined) {
    if (!/^\d+$/.test(versionFlag.trim()) || Number(versionFlag) <= 0) throw new UsageError("--version must be a positive whole number");
    version = Number(versionFlag);
  }
  const mcpMode = oneFlag(args, "mcp");
  if (mcpMode !== undefined && !(REPLAY_MCP_MODES as readonly string[]).includes(mcpMode)) throw new UsageError("--mcp must be strict or lenient");
  const toleranceFlag = oneFlag(args, "number-tolerance");
  let numberTolerance: number | undefined;
  if (toleranceFlag !== undefined) {
    numberTolerance = Number(toleranceFlag);
    if (!Number.isFinite(numberTolerance) || numberTolerance < 0) throw new UsageError("--number-tolerance must be a number of at least 0");
  }
  const ignorePaths = listFlag(args, "ignore-path");
  // The API's own limits, checked here so a bad flag is a usage error and nothing is sent.
  if (ignorePaths.length > REPLAY_IGNORE_PATHS_MAX) throw new UsageError(`--ignore-path can be given at most ${REPLAY_IGNORE_PATHS_MAX} times`);
  for (const pattern of ignorePaths) {
    const checked = replayIgnorePathSchema.safeParse(pattern);
    if (!checked.success) throw new UsageError(`--ignore-path ${JSON.stringify(pattern.slice(0, 40))}: ${checked.error.issues[0]?.message ?? "invalid"}`);
  }
  const target = apiTarget(args, io);

  let result: unknown;
  try {
    result = await apiRequest<unknown>(target, "POST", `/api/replay/recordings/${encodeURIComponent(recording)}/replay`, {
      ...(version !== undefined ? { version } : { draft: true }),
      ...(mcpMode ? { mcpMode } : {}),
      ...(ignorePaths.length > 0 ? { ignorePaths } : {}),
      ...(numberTolerance !== undefined ? { numberTolerance } : {})
    });
  } catch (error) {
    if (error instanceof RequestError) {
      // A 400 is the API refusing the flags: a usage error, like one caught here.
      if (error.status === 400) {
        write(io.stderr, `l2m: ${error.message}`);
        return EXIT_USAGE;
      }
      write(io.stderr, `l2m: replay could not complete: ${error.message}`);
      return EXIT_INCOMPLETE;
    }
    throw error;
  }
  if (!isReplayRunResponse(result)) {
    write(io.stderr, "l2m: replay could not complete: the API's answer is not a replay result (is the CLI the same version as the API?)");
    return EXIT_INCOMPLETE;
  }
  try {
    // The verdict is judged again here from the diff, so a gate never trusts a summary field alone.
    const judged = judgeReplayDiff(result.diff);
    if (args.booleans.has("json")) io.stdout.write(`${JSON.stringify({ ...result, verdict: judged.verdict, reasons: judged.reasons }, null, 2)}\n`);
    else write(io.stdout, formatReplay(result, judged.verdict, judged.reasons));
    if (judged.verdict === "pass") return EXIT_OK;
    if (judged.verdict === "fail") return EXIT_FAILED;
    return EXIT_INCOMPLETE;
  } catch (error) {
    write(io.stderr, `l2m: replay could not complete: the API's answer could not be read (${error instanceof Error ? error.message : String(error)})`);
    return EXIT_INCOMPLETE;
  }
}

// --- entry -------------------------------------------------------------------

const BOOLEAN_FLAGS = ["json", "allow-unreachable", "allow-policy-blocked", "verbose", "help", "trust-embedded-key", "draft"];

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
    if (group === "replay" && command === "run" && !sub) return await runReplay(args, io);
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
