/**
 * `l2m replay run --set` and `l2m replay status`: a replay job over golden
 * sets, started, polled and judged by exit code.
 *
 * The request is the replay-job contract as plain JSON (packages/shared
 * replay.ts and evals.ts): candidate (draft, version or an inline workflow),
 * overrides, comparison and repeat settings. Response fields the CLI does
 * not know are ignored; a server that does not know a request field answers
 * 400 and the CLI says which, with exit 2.
 *
 * Exit codes: 0 every case passed, 1 a case failed, 2 usage, 4 inconclusive
 * (a case could not be judged, the job did not complete, the request failed).
 */
import fs from "node:fs";
import {
  REPLAY_IGNORE_PATHS_MAX,
  REPLAY_MCP_MODES,
  replayIgnorePathSchema,
  replayJobExitCode,
  type EvalCaseResult,
  type EvalRunView
} from "@ai-orchestrator/shared";
import { apiRequest, apiTarget, cleanServerText, isObject, readJsonFile, RequestError, write, type ApiTarget, type CliIo } from "./api";
import { listFlag, oneFlag, UsageError, type ParsedArgs } from "./args";
import { buildJunit } from "./junit";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_INCOMPLETE = 4;

export interface ReplayFlags {
  version?: number;
  mcpMode?: string;
  ignorePaths: string[];
  numberTolerance?: number;
}

/** The candidate and comparison flags `replay run` takes with --recording and with --set. */
export function replayFlags(args: ParsedArgs): ReplayFlags {
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
  return { ...(version !== undefined ? { version } : {}), ...(mcpMode ? { mcpMode } : {}), ignorePaths, ...(numberTolerance !== undefined ? { numberTolerance } : {}) };
}

// --- the job request ---------------------------------------------------------

/** Flags that only a replay job (`--set`) understands. */
export const JOB_ONLY_FLAGS = ["file", "model", "provider-model", "guard-profile", "mcp-server", "live-read", "models", "compare", "repeats", "aggregate", "max-cost", "timeout", "junit"];
export const JOB_ONLY_BOOLEANS = ["estimate", "no-wait", "wait"];

const MCP_SERVER_MODES = ["strict", "lenient", "live_read_only"] as const;
const MODELS_MODES = ["live", "replay"] as const;
const COMPARE_MODES = ["recording", "baseline_rerun"] as const;
const AGGREGATE_MODES = ["all", "majority", "any"] as const;

/** `left=right`, both non-empty. */
function pair(flag: string, value: string): [string, string] {
  const at = value.indexOf("=");
  const left = at > 0 ? value.slice(0, at).trim() : "";
  const right = at > 0 ? value.slice(at + 1).trim() : "";
  if (!left || !right) throw new UsageError(`--${flag} needs <name>=<value>, got ${JSON.stringify(value.slice(0, 60))}`);
  return [left, right];
}

function oneOf<T extends string>(args: ParsedArgs, flag: string, allowed: readonly T[]): T | undefined {
  const value = oneFlag(args, flag);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`--${flag} must be ${allowed.join(", ")}`);
  return value as T;
}

interface JobModelOverride {
  nodeId?: string;
  provider?: string;
  model: string;
}

interface JobOverrides {
  models?: JobModelOverride[];
  guardProfile?: { profileId: string; version?: number };
  mcpServers?: Record<string, string>;
  liveReadNodes?: string[];
}

function jobOverrides(args: ParsedArgs): JobOverrides | undefined {
  const overrides: JobOverrides = {};
  const models: JobModelOverride[] = [];
  for (const value of args.values.get("model") ?? []) {
    const [nodeId, model] = pair("model", value);
    models.push({ nodeId, model });
  }
  for (const value of args.values.get("provider-model") ?? []) {
    const [provider, model] = pair("provider-model", value);
    models.push({ provider, model });
  }
  if (models.length > 0) overrides.models = models;
  const guard = oneFlag(args, "guard-profile");
  if (guard !== undefined) {
    const at = guard.lastIndexOf("@");
    const profileId = (at >= 0 ? guard.slice(0, at) : guard).trim();
    const versionText = at >= 0 ? guard.slice(at + 1).trim() : undefined;
    if (!profileId) throw new UsageError("--guard-profile needs <id> or <id>@<version>");
    if (versionText !== undefined && (!/^\d+$/.test(versionText) || Number(versionText) <= 0)) throw new UsageError("--guard-profile version must be a positive whole number");
    overrides.guardProfile = { profileId, ...(versionText !== undefined ? { version: Number(versionText) } : {}) };
  }
  const servers: Record<string, string> = {};
  for (const value of args.values.get("mcp-server") ?? []) {
    const [id, mode] = pair("mcp-server", value);
    if (!(MCP_SERVER_MODES as readonly string[]).includes(mode)) throw new UsageError(`--mcp-server mode must be ${MCP_SERVER_MODES.join(", ")}`);
    servers[id] = mode;
  }
  if (Object.keys(servers).length > 0) overrides.mcpServers = servers;
  const live = listFlag(args, "live-read");
  if (live.length > 0) overrides.liveReadNodes = live;
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/** The candidate workflow from `--file`: a JSON object. */
function inlineWorkflow(args: ParsedArgs): Record<string, unknown> | undefined {
  const file = oneFlag(args, "file");
  if (file === undefined) return undefined;
  const parsed = readJsonFile(file);
  if (!isObject(parsed) || !Array.isArray(parsed.nodes)) throw new UsageError(`${file} is not a workflow (a JSON object with nodes and edges)`);
  return parsed;
}

/** The POST body of `/api/replay/runs` and `/api/replay/estimate` for these flags. */
export function jobRequestBody(args: ParsedArgs, sets: string[]): Record<string, unknown> {
  const { version, mcpMode, ignorePaths, numberTolerance } = replayFlags(args);
  const workflow = inlineWorkflow(args);
  if (workflow && (args.booleans.has("draft") || version !== undefined)) throw new UsageError("--file is the candidate: do not combine it with --draft or --version");
  const maxCostFlag = oneFlag(args, "max-cost");
  let maxCostUsd: number | undefined;
  if (maxCostFlag !== undefined) {
    maxCostUsd = Number(maxCostFlag);
    if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) throw new UsageError("--max-cost must be a number of US dollars above 0");
  }
  const repeatsFlag = oneFlag(args, "repeats");
  let repeats: number | undefined;
  if (repeatsFlag !== undefined) {
    if (!/^\d+$/.test(repeatsFlag.trim()) || Number(repeatsFlag) < 1 || Number(repeatsFlag) > 5) throw new UsageError("--repeats must be a whole number from 1 to 5");
    repeats = Number(repeatsFlag);
  }
  const models = oneOf(args, "models", MODELS_MODES);
  const compare = oneOf(args, "compare", COMPARE_MODES);
  const aggregate = oneOf(args, "aggregate", AGGREGATE_MODES);
  const overrides = jobOverrides(args);
  return {
    datasetIds: sets,
    ...(workflow ? { workflow } : version !== undefined ? { version } : { draft: true }),
    ...(overrides ? { overrides } : {}),
    ...(models ? { models } : {}),
    ...(compare ? { compare } : {}),
    ...(repeats !== undefined ? { repeats } : {}),
    ...(aggregate ? { aggregate } : {}),
    ...(mcpMode ? { mcpMode } : {}),
    ...(ignorePaths.length > 0 ? { ignorePaths } : {}),
    ...(numberTolerance !== undefined ? { numberTolerance } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {})
  };
}

/** What a 400 means for the person at the terminal: the API's text, and which request fields this server does not know. */
export function rejectedMessage(error: RequestError): string {
  const details = isObject(error.body) && Array.isArray(error.body.details) ? error.body.details : [];
  const unknown = details.flatMap((issue) => (isObject(issue) && issue.code === "unrecognized_keys" && Array.isArray(issue.keys) ? issue.keys.map(String) : []));
  const base = cleanServerText(error.message);
  if (unknown.length === 0) return base;
  return `${base}\n  This server does not support: ${unknown.map(cleanServerText).join(", ")}. Inline workflows (--file), overrides, --models, --compare, --repeats, --aggregate and --estimate need a server with replay candidates (Phase 15.3); upgrade the server or leave those flags out.`;
}

// --- output ------------------------------------------------------------------

type JobView = EvalRunView & { results?: EvalCaseResult[] };

function isRunView(value: unknown): value is JobView {
  return isObject(value) && typeof value.id === "string" && typeof value.status === "string";
}

function candidateLabel(run: JobView): string {
  if (!run.candidate) return "candidate";
  if (run.candidate.kind === "version") return `version ${cleanServerText(run.candidate.version)}`;
  if ((run.candidate.kind as string) === "inline") return "workflow file";
  return "draft";
}

export function formatJob(run: JobView, code: number): string {
  const lines: string[] = [];
  const verdict = code === EXIT_OK ? "PASS" : code === EXIT_FAILED ? "FAIL" : "INCONCLUSIVE";
  lines.push(`Replay job ${cleanServerText(run.id)} against the ${candidateLabel(run)}${run.candidate ? ` (${cleanServerText(run.candidate.workflowHash).slice(0, 12)})` : ""}: ${verdict} (${cleanServerText(run.status)})`);
  const summary = run.summary;
  if (summary) {
    lines.push(
      `  ${summary.pass} passed, ${summary.fail} failed, ${summary.error} inconclusive${summary.skipped ? `, ${summary.skipped} skipped` : ""} of ${summary.total}; spent $${(summary.costUsd ?? 0).toFixed(4)}${summary.costUnknown ? " or more (some calls are unpriced)" : ""}`
    );
    for (const warning of summary.warnings ?? []) lines.push(`  warning: ${cleanServerText(warning)}`);
  }
  if (run.error) lines.push(`  ${cleanServerText(run.error)}`);
  for (const result of run.results ?? []) {
    if (result.status === "pass") continue;
    const failed = (result.score?.details ?? []).filter((detail) => !detail.pass).map((detail) => `${cleanServerText(detail.type)}: ${cleanServerText(detail.reason)}`);
    lines.push(`  ${cleanServerText(result.status)} ${cleanServerText(result.fixtureName ?? result.fixtureId)}${result.error ? `: ${cleanServerText(result.error)}` : ""}`);
    for (const reason of failed) lines.push(`    - ${reason}`);
  }
  return lines.join("\n");
}

function writeJunit(args: ParsedArgs, io: CliIo, run: JobView | null, message: string | null): void {
  const file = oneFlag(args, "junit");
  if (!file) return;
  try {
    fs.writeFileSync(file, buildJunit({ run, message }));
  } catch (error) {
    write(io.stderr, `l2m: cannot write ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function timeoutSeconds(args: ParsedArgs): number {
  const timeoutFlag = oneFlag(args, "timeout");
  const timeoutS = timeoutFlag === undefined ? DEFAULT_JOB_TIMEOUT_S : Number(timeoutFlag);
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new UsageError("--timeout must be a number of seconds above 0");
  return timeoutS;
}

const JOB_POLL_MS = 2_000;
const DEFAULT_JOB_TIMEOUT_S = 1_800;

/** Polls until the job leaves queued and running, or the time is up (`timedOut`). */
async function waitForJob(target: ApiTarget, io: CliIo, first: JobView, timeoutS: number): Promise<{ run: JobView; timedOut: boolean }> {
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutS * 1000;
  let run = first;
  while (run.status === "queued" || run.status === "running") {
    if (Date.now() >= deadline) return { run, timedOut: true };
    await sleep(JOB_POLL_MS);
    const polled = await apiRequest<{ run?: unknown }>(target, "GET", `/api/replay/runs/${encodeURIComponent(run.id)}`);
    if (!isRunView(polled?.run)) throw new RequestError("the API's answer is not a replay job");
    run = polled.run;
  }
  return { run, timedOut: false };
}

/** Prints the verdict of a finished job, writes the JUnit file and returns the exit code. */
function conclude(args: ParsedArgs, io: CliIo, run: JobView): number {
  const code = replayJobExitCode(run);
  if (args.booleans.has("json")) io.stdout.write(`${JSON.stringify({ ...run, exitCode: code }, null, 2)}\n`);
  else write(io.stdout, formatJob(run, code));
  writeJunit(args, io, run, null);
  return code;
}

function requestFailed(args: ParsedArgs, io: CliIo, error: RequestError, what: string, run: JobView | null): number {
  if (error.status === 400) {
    write(io.stderr, `l2m: ${rejectedMessage(error)}`);
    return EXIT_USAGE;
  }
  write(io.stderr, `l2m: ${what} is inconclusive: ${cleanServerText(error.message)}`);
  writeJunit(args, io, run, cleanServerText(error.message));
  return EXIT_INCOMPLETE;
}

// --- replay run --set ---------------------------------------------------------

interface JobEstimate {
  cases: number;
  runsPerCase?: number;
  modelCallsEstimate?: number;
  estimatedCostUsd?: number | null;
  costUnknown?: boolean;
  warnings?: string[];
}

function formatEstimate(estimate: JobEstimate): string {
  const lines = [
    `Estimate: ${estimate.cases} case${estimate.cases === 1 ? "" : "s"}${estimate.runsPerCase ? `, ${estimate.runsPerCase} run${estimate.runsPerCase === 1 ? "" : "s"} each` : ""}` +
      `${typeof estimate.modelCallsEstimate === "number" ? `, about ${estimate.modelCallsEstimate} model calls` : ""}` +
      `${typeof estimate.estimatedCostUsd === "number" ? `, about $${estimate.estimatedCostUsd.toFixed(4)}${estimate.costUnknown ? " or more (some calls are unpriced)" : ""}` : estimate.costUnknown ? ", cost unknown (unpriced models)" : ""}`
  ];
  for (const warning of estimate.warnings ?? []) lines.push(`  warning: ${cleanServerText(warning)}`);
  return lines.join("\n");
}

export async function runReplayJob(args: ParsedArgs, io: CliIo, sets: string[]): Promise<number> {
  const body = jobRequestBody(args, sets);
  const timeoutS = timeoutSeconds(args);
  const target = apiTarget(args, io);

  if (args.booleans.has("estimate")) {
    try {
      const estimate = await apiRequest<unknown>(target, "POST", "/api/replay/estimate", body);
      if (!isObject(estimate) || typeof estimate.cases !== "number") {
        write(io.stderr, "l2m: the estimate is inconclusive: the API's answer is not an estimate (does the server have the estimate route, Phase 15.3?)");
        return EXIT_INCOMPLETE;
      }
      if (args.booleans.has("json")) io.stdout.write(`${JSON.stringify(estimate, null, 2)}\n`);
      else write(io.stdout, formatEstimate(estimate as unknown as JobEstimate));
      return EXIT_OK;
    } catch (error) {
      if (error instanceof RequestError) {
        if (error.status === 404 || error.status === 405) {
          write(io.stderr, "l2m: this server has no estimate route; --estimate needs a server with replay candidates (Phase 15.3).");
          return EXIT_USAGE;
        }
        if (error.status === 400) {
          write(io.stderr, `l2m: ${rejectedMessage(error)}`);
          return EXIT_USAGE;
        }
        write(io.stderr, `l2m: the estimate is inconclusive: ${cleanServerText(error.message)}`);
        return EXIT_INCOMPLETE;
      }
      throw error;
    }
  }

  let run: JobView | null = null;
  try {
    const started = await apiRequest<{ run?: unknown }>(target, "POST", "/api/replay/runs", body);
    if (!isRunView(started?.run)) {
      write(io.stderr, "l2m: replay job is inconclusive: the API's answer is not a replay job (is the CLI the same version as the API?)");
      writeJunit(args, io, null, "the API's answer is not a replay job");
      return EXIT_INCOMPLETE;
    }
    run = started.run;
    if (args.booleans.has("no-wait")) {
      if (args.booleans.has("json")) io.stdout.write(`${JSON.stringify({ runId: run.id, status: run.status }, null, 2)}\n`);
      else write(io.stdout, `Started replay job ${cleanServerText(run.id)} (${cleanServerText(run.status)}). Follow it with: l2m replay status ${cleanServerText(run.id)} --wait`);
      return EXIT_OK;
    }
    const waited = await waitForJob(target, io, run, timeoutS);
    run = waited.run;
    if (waited.timedOut) {
      const message = `replay job ${run.id} is still ${run.status} after ${timeoutS} s; it keeps running on the server.`;
      write(io.stderr, `l2m: ${cleanServerText(message)}`);
      writeJunit(args, io, run, message);
      return EXIT_INCOMPLETE;
    }
  } catch (error) {
    if (error instanceof RequestError) return requestFailed(args, io, error, "replay job", run);
    throw error;
  }
  return conclude(args, io, run);
}

// --- replay status ------------------------------------------------------------

export async function runReplayStatus(args: ParsedArgs, io: CliIo): Promise<number> {
  const [, , runId, extra] = args.positionals;
  if (!runId || extra) throw new UsageError("l2m replay status needs exactly one replay job id");
  const timeoutS = timeoutSeconds(args);
  const target = apiTarget(args, io);
  let run: JobView | null = null;
  try {
    const fetched = await apiRequest<{ run?: unknown }>(target, "GET", `/api/replay/runs/${encodeURIComponent(runId)}`);
    if (!isRunView(fetched?.run)) {
      write(io.stderr, "l2m: replay job is inconclusive: the API's answer is not a replay job");
      return EXIT_INCOMPLETE;
    }
    run = fetched.run;
    if (args.booleans.has("wait")) {
      const waited = await waitForJob(target, io, run, timeoutS);
      run = waited.run;
      if (waited.timedOut) {
        const message = `replay job ${run.id} is still ${run.status} after ${timeoutS} s; it keeps running on the server.`;
        write(io.stderr, `l2m: ${cleanServerText(message)}`);
        writeJunit(args, io, run, message);
        return EXIT_INCOMPLETE;
      }
    } else if (run.status === "queued" || run.status === "running") {
      // Without --wait a job still running has no verdict yet.
      if (args.booleans.has("json")) io.stdout.write(`${JSON.stringify({ ...run, exitCode: EXIT_INCOMPLETE }, null, 2)}\n`);
      else write(io.stdout, `Replay job ${cleanServerText(run.id)} is ${cleanServerText(run.status)}${run.progress ? ` (${run.progress.done} of ${run.progress.total} cases done)` : ""}. Add --wait to wait for the verdict.`);
      writeJunit(args, io, run, `the replay job is ${run.status}`);
      return EXIT_INCOMPLETE;
    }
  } catch (error) {
    if (error instanceof RequestError) return requestFailed(args, io, error, "replay job", run);
    throw error;
  }
  return conclude(args, io, run);
}
