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
 * Exit codes: 0 every case passed, 1 a case failed (or the server refused a
 * status poll with 400), 2 usage (also flags the API refuses with 400 when the
 * job is started), 4 inconclusive (a case could not be judged, the job did
 * not complete, or a request failed: unreachable, timed out, 401, 403, 404
 * or 5xx). Exit 4 for failed requests is long-standing behaviour and is
 * kept so existing pipelines do not change meaning.
 *
 * When the job ran over a golden set of an enforced release gate, the output
 * also says how the gate counts its cases: admitted, pending admission (run
 * but not counted) and required, with every required case that would block
 * a publish; the counts come from the same shared function the gate judges
 * with. The server judges the job's case results as the gate does, and for
 * a completed job the exit code follows that verdict: 1 when the gate
 * blocks (a failing admitted or required case, the pass rate, a limit), 0
 * when it does not (a failing pending case does not count). Whether the job
 * may prove a release is reported on its own line.
 *
 * Every request gives up after 60 s, or what is left of --timeout if that
 * is less. Status polls (GET) are tried again twice, after 1 s and 3 s, when
 * the server cannot be reached, does not answer in time or answers 5xx.
 */
import {
  REPLAY_IGNORE_PATHS_MAX,
  REPLAY_AGGREGATE_RULES,
  REPLAY_COMPARE_MODES,
  REPLAY_INLINE_WORKFLOW_MAX_BYTES,
  REPLAY_MCP_MODES,
  REPLAY_MODEL_MODES,
  REPLAY_SERVER_MODES,
  REPLAY_REPEATS_MAX,
  aggregateReleaseRepeats,
  replayIgnorePathSchema,
  replayJobExitCode,
  summarizeReleaseGateAdmission,
  type ReleaseCaseStatus,
  type ReleaseGateAdmissionStats,
  type ReleaseGateVerdict,
  type EvalCaseResult,
  type EvalRunView,
  type ReplayCandidateOverrides,
  type ReplayJobEstimate,
  type ReplayJobRequest
} from "@ai-orchestrator/shared";
import { apiGetWithRetry, apiRequest, apiTarget, cleanServerText, isObject, readJsonFile, REQUEST_TIMEOUT_MS, RequestError, write, writePrivateFile, type ApiTarget, type CliIo } from "./api";
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
export const JOB_ONLY_FLAGS = ["file", "model", "provider-model", "model-secret", "guard-profile", "mcp-server", "live-read", "models", "compare", "repeats", "aggregate", "max-cost", "timeout", "junit"];
export const JOB_ONLY_BOOLEANS = ["estimate", "no-wait", "wait"];

// The enums are the API's own (packages/shared replay.ts), so a value the server adds is one the CLI accepts.
const MCP_SERVER_MODES = REPLAY_SERVER_MODES;
const MODELS_MODES = REPLAY_MODEL_MODES;
const COMPARE_MODES = REPLAY_COMPARE_MODES;
const AGGREGATE_MODES = REPLAY_AGGREGATE_RULES;

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

type JobModelOverride = NonNullable<ReplayCandidateOverrides["models"]>[number];

function jobOverrides(args: ParsedArgs): ReplayCandidateOverrides | undefined {
  const overrides: ReplayCandidateOverrides = {};
  const models: JobModelOverride[] = [];
  // --model-secret <nodeId or provider>=<secretId>: the secret a model override uses (the API requires one when the provider changes).
  const secrets = new Map<string, string>();
  for (const value of args.values.get("model-secret") ?? []) {
    const [key, secretId] = pair("model-secret", value);
    secrets.set(key, secretId);
  }
  const used = new Set<string>();
  for (const value of args.values.get("model") ?? []) {
    const [nodeId, model] = pair("model", value);
    const secretId = secrets.get(nodeId);
    if (secretId) used.add(nodeId);
    models.push({ nodeId, model, ...(secretId ? { secretRef: { secretId } } : {}) });
  }
  for (const value of args.values.get("provider-model") ?? []) {
    const [provider, model] = pair("provider-model", value);
    const secretId = secrets.get(provider);
    if (secretId) used.add(provider);
    models.push({ provider, model, ...(secretId ? { secretRef: { secretId } } : {}) });
  }
  for (const key of secrets.keys()) {
    if (!used.has(key)) throw new UsageError(`--model-secret ${JSON.stringify(key.slice(0, 60))} matches no --model node or --provider-model provider`);
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
  const servers: Record<string, (typeof REPLAY_SERVER_MODES)[number]> = {};
  for (const value of args.values.get("mcp-server") ?? []) {
    const [id, mode] = pair("mcp-server", value);
    if (!(MCP_SERVER_MODES as readonly string[]).includes(mode)) throw new UsageError(`--mcp-server mode must be ${MCP_SERVER_MODES.join(", ")}`);
    servers[id] = mode as (typeof REPLAY_SERVER_MODES)[number];
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
  // The API takes a workflow, or an export file holding one under `workflow`.
  const holdsWorkflow = isObject(parsed) && !Array.isArray(parsed.nodes) && isObject(parsed.workflow) && Array.isArray(parsed.workflow.nodes);
  if (!isObject(parsed) || (!Array.isArray(parsed.nodes) && !holdsWorkflow)) throw new UsageError(`${file} is not a workflow (a JSON object with nodes and edges)`);
  const bytes = Buffer.byteLength(JSON.stringify(parsed), "utf8");
  if (bytes > REPLAY_INLINE_WORKFLOW_MAX_BYTES) throw new UsageError(`${file} is ${bytes} bytes; the API takes a candidate workflow of at most ${REPLAY_INLINE_WORKFLOW_MAX_BYTES} bytes (2 MiB)`);
  return parsed;
}

/** The POST body of `/api/replay/runs` and `/api/replay/estimate` for these flags. */
export function jobRequestBody(args: ParsedArgs, sets: string[]): ReplayJobRequest {
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
    if (!/^\d+$/.test(repeatsFlag.trim()) || Number(repeatsFlag) < 1 || Number(repeatsFlag) > REPLAY_REPEATS_MAX) throw new UsageError(`--repeats must be a whole number from 1 to ${REPLAY_REPEATS_MAX}`);
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
    ...(mcpMode ? { mcpMode: mcpMode as ReplayJobRequest["mcpMode"] } : {}),
    ...(ignorePaths.length > 0 ? { ignorePaths } : {}),
    ...(numberTolerance !== undefined ? { numberTolerance } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {})
  } as ReplayJobRequest;
}

/** What a 400 means for the person at the terminal: the API's text, and which request fields this server does not know. */
export function rejectedMessage(error: RequestError): string {
  const details = isObject(error.body) && Array.isArray(error.body.details) ? error.body.details : [];
  const unknown = details.flatMap((issue) => (isObject(issue) && issue.code === "unrecognized_keys" && Array.isArray(issue.keys) ? issue.keys.map(String) : []));
  const base = cleanServerText(error.message);
  if (unknown.length === 0) return base;
  return `${base}\n  This server does not support: ${unknown.map(cleanServerText).join(", ")}. It is older than this CLI; upgrade the server or leave those flags out.`;
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

const caseStatus = (status: unknown): ReleaseCaseStatus => (status === "pass" || status === "fail" || status === "error" || status === "skipped" ? status : "error");

/**
 * How the job's enforced release gate counts its cases (null when the job ran
 * over no enforced gate's sets): repeats aggregated as the job did, through
 * the same `summarizeReleaseGateAdmission` the gate judges with.
 */
export function gateAdmissionOf(
  run: JobView
): (ReleaseGateAdmissionStats & {
  pendingIds: Set<string>;
  requiredIds: Set<string>;
  inGateIds: Set<string>;
  verdict: ReleaseGateVerdict | null;
  reasons: string[];
  setsChanged: boolean;
}) | null {
  const gate = run.releaseGate;
  if (!isObject(gate) || !Array.isArray(gate.admittedFixtureIds) || !Array.isArray(gate.requiredFixtureIds)) return null;
  const admitted = gate.admittedFixtureIds.map(String);
  const pending = Array.isArray(gate.pendingFixtureIds) ? gate.pendingFixtureIds.map(String) : [];
  const inGate = new Set([...admitted, ...pending]);
  const aggregate = run.options && typeof run.options.aggregate === "string" ? run.options.aggregate : "all";
  const groups = new Map<string, ReleaseCaseStatus[]>();
  const names: Record<string, string> = {};
  for (const result of (run.results ?? []) as Array<EvalCaseResult & Record<string, unknown>>) {
    if (result.role === "baseline" || result.baseline === true || !inGate.has(result.fixtureId)) continue;
    groups.set(result.fixtureId, [...(groups.get(result.fixtureId) ?? []), caseStatus(result.status)]);
    names[result.fixtureId] = result.fixtureName ?? result.fixtureId;
  }
  const cases = [...groups].map(([id, statuses]) => ({ id, status: aggregateReleaseRepeats(statuses, aggregate as "all" | "majority" | "any") }));
  const requiredNames = isObject(gate.requiredCaseNames) ? gate.requiredCaseNames : {};
  for (const id of gate.requiredFixtureIds.map(String)) names[id] ??= typeof requiredNames[id] === "string" ? String(requiredNames[id]) : id;
  const stats = summarizeReleaseGateAdmission(cases, { admittedIds: admitted, requiredIds: gate.requiredFixtureIds.map(String), caseNames: names });
  const verdict = gate.verdict === "passed" || gate.verdict === "blocked" || gate.verdict === "needs_approval" ? gate.verdict : null;
  const reasons = Array.isArray(gate.reasons) ? gate.reasons.map(String) : [];
  return {
    ...stats,
    pendingIds: new Set(pending),
    requiredIds: new Set(gate.requiredFixtureIds.map(String)),
    inGateIds: inGate,
    verdict,
    reasons,
    setsChanged: gate.setsChanged === true
  };
}

/**
 * The exit code: the job's own verdict, or, for a completed job over an
 * enforced release gate's sets, 1 when the gate blocks its case results, and
 * otherwise the job's own verdict over the cases outside the gate's sets
 * (1 for a failure, 4 for an inconclusive case; 0 when there are none).
 */
export function jobExitCode(run: JobView): number {
  const own = replayJobExitCode(run);
  if (run.status !== "completed") return own;
  const gate = gateAdmissionOf(run);
  if (!gate?.verdict) return own;
  if (gate.verdict === "blocked") return EXIT_FAILED;
  const aggregate = (run.options && typeof run.options.aggregate === "string" ? run.options.aggregate : "all") as "all" | "majority" | "any";
  const outside = new Map<string, ReleaseCaseStatus[]>();
  for (const result of (run.results ?? []) as Array<EvalCaseResult & Record<string, unknown>>) {
    if (result.role === "baseline" || result.baseline === true || gate.inGateIds.has(result.fixtureId)) continue;
    const key = result.fixtureId || String(result.id);
    outside.set(key, [...(outside.get(key) ?? []), caseStatus(result.status)]);
  }
  if (outside.size === 0) return EXIT_OK;
  const summary = { total: outside.size, pass: 0, fail: 0, error: 0, skipped: 0 };
  for (const statuses of outside.values()) summary[aggregateReleaseRepeats(statuses, aggregate)] += 1;
  return replayJobExitCode({ status: "completed", summary: summary as unknown as NonNullable<JobView["summary"]> });
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
  // Whether the job can count as release proof; only a server with release gates says (older jobs carry no flag).
  if (run.candidate?.releaseEligible === false) {
    lines.push("  not release proof: a release gate will not accept this job");
    for (const reason of run.candidate.releaseIneligibleReasons ?? []) lines.push(`    - ${cleanServerText(reason)}`);
  } else if (run.candidate?.releaseEligible === true) lines.push("  release eligible: a release gate may accept this job");
  const gate = gateAdmissionOf(run);
  if (gate) {
    lines.push(
      `  enforced release gate: ${gate.admitted} admitted, ${gate.pending} pending admission (they run but do not count yet), ${gate.required} required`
    );
    for (const failure of gate.requiredFailures) lines.push(`    - required case "${cleanServerText(failure.name)}" ${cleanServerText(failure.problem)}: it blocks a publish whatever the pass rate`);
    if (gate.verdict === "blocked") {
      lines.push("  the release gate blocks these results:");
      for (const reason of gate.reasons) lines.push(`    - ${cleanServerText(reason)}`);
    } else if (gate.verdict) {
      lines.push("  the release gate accepts these results");
      if (gate.setsChanged) {
        lines.push("    but the gate's golden sets changed after this job was queued, so publishing may still refuse it (`l2m release publish` decides)");
      }
    }
  }
  for (const result of run.results ?? []) {
    if (result.status === "pass") continue;
    const failed = (result.score?.details ?? []).filter((detail) => !detail.pass).map((detail) => `${cleanServerText(detail.type)}: ${cleanServerText(detail.reason)}`);
    const marks = gate ? [gate.requiredIds.has(result.fixtureId) ? "required" : null, gate.pendingIds.has(result.fixtureId) ? "pending admission, not counted" : null].filter(Boolean) : [];
    lines.push(
      `  ${cleanServerText(result.status)} ${cleanServerText(result.fixtureName ?? result.fixtureId)}${marks.length > 0 ? ` (${marks.join("; ")})` : ""}${result.error ? `: ${cleanServerText(result.error)}` : ""}`
    );
    for (const reason of failed) lines.push(`    - ${reason}`);
  }
  return lines.join("\n");
}

function writeJunit(args: ParsedArgs, io: CliIo, run: JobView | null, message: string | null): void {
  const file = oneFlag(args, "junit");
  if (!file) return;
  try {
    const gate = run ? gateAdmissionOf(run) : null;
    writePrivateFile(
      file,
      buildJunit({
        run,
        message,
        ...(gate
          ? {
              gate: {
                admitted: gate.admitted,
                pending: gate.pending,
                required: gate.required,
                pendingIds: gate.pendingIds,
                requiredIds: gate.requiredIds,
                requiredFailures: gate.requiredFailures,
                verdict: gate.verdict
              }
            }
          : {})
      })
    );
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

/** A failed status poll (GET): a 400 there is not the caller's flags, so it exits 1 rather than 2. */
class PollRequestError extends RequestError {}

const sleeper = (io: CliIo) => io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** One status poll, tried again on network errors, timeouts and 5xx. */
async function pollJob(target: ApiTarget, io: CliIo, runId: string, deadline: number): Promise<JobView> {
  let polled: { run?: unknown };
  try {
    polled = await apiGetWithRetry<{ run?: unknown }>(target, `/api/replay/runs/${encodeURIComponent(runId)}`, { sleep: sleeper(io), deadline });
  } catch (error) {
    if (error instanceof RequestError) throw new PollRequestError(error.message, error.status, error.body);
    throw error;
  }
  if (!isRunView(polled?.run)) throw new RequestError("the API's answer is not a replay job");
  return polled.run;
}

/** Polls until the job leaves queued and running, or the time is up (`timedOut`). */
async function waitForJob(target: ApiTarget, io: CliIo, first: JobView, deadline: number): Promise<{ run: JobView; timedOut: boolean }> {
  const sleep = sleeper(io);
  let run = first;
  while (run.status === "queued" || run.status === "running") {
    if (Date.now() >= deadline) return { run, timedOut: true };
    await sleep(JOB_POLL_MS);
    run = await pollJob(target, io, run.id, deadline);
  }
  return { run, timedOut: false };
}

/** Prints the verdict of a finished job, writes the JUnit file and returns the exit code. */
function conclude(args: ParsedArgs, io: CliIo, run: JobView): number {
  const code = jobExitCode(run);
  if (args.booleans.has("json")) io.stdout.write(`${JSON.stringify({ ...run, exitCode: code }, null, 2)}\n`);
  else write(io.stdout, formatJob(run, code));
  writeJunit(args, io, run, null);
  return code;
}

function requestFailed(args: ParsedArgs, io: CliIo, error: RequestError, what: string, run: JobView | null): number {
  if (error.status === 400 && error instanceof PollRequestError) {
    write(io.stderr, `l2m: ${what} status could not be read: ${cleanServerText(error.message)}`);
    writeJunit(args, io, run, cleanServerText(error.message));
    return EXIT_FAILED;
  }
  if (error.status === 400) {
    write(io.stderr, `l2m: ${rejectedMessage(error)}`);
    return EXIT_USAGE;
  }
  write(io.stderr, `l2m: ${what} is inconclusive: ${cleanServerText(error.message)}`);
  writeJunit(args, io, run, cleanServerText(error.message));
  return EXIT_INCOMPLETE;
}

// --- replay run --set ---------------------------------------------------------

function formatEstimate(estimate: Partial<ReplayJobEstimate> & { cases: number }): string {
  const lines = [
    `Estimate: ${estimate.cases} case${estimate.cases === 1 ? "" : "s"}${estimate.runsPerCase ? `, ${estimate.runsPerCase} run${estimate.runsPerCase === 1 ? "" : "s"} each` : ""}` +
      `${typeof estimate.modelCallsEstimate === "number" ? `, about ${estimate.modelCallsEstimate} model calls` : ""}` +
      `${typeof estimate.estimatedCostUsd === "number" ? `, about $${estimate.estimatedCostUsd.toFixed(4)}${estimate.costUnknown ? " or more (some calls are unpriced)" : ""}` : estimate.costUnknown ? ", cost unknown (unpriced models)" : ""}`
  ];
  if (typeof estimate.executions === "number") lines.push(`  ${estimate.executions} executions${typeof estimate.maxExecutions === "number" ? ` (a job may run at most ${estimate.maxExecutions})` : ""}`);
  for (const warning of estimate.warnings ?? []) lines.push(`  warning: ${cleanServerText(warning)}`);
  return lines.join("\n");
}

export async function runReplayJob(args: ParsedArgs, io: CliIo, sets: string[]): Promise<number> {
  const body = jobRequestBody(args, sets);
  const timeoutS = timeoutSeconds(args);
  const deadline = Date.now() + timeoutS * 1000;
  const requestTimeout = Math.min(REQUEST_TIMEOUT_MS, timeoutS * 1000);
  const target = apiTarget(args, io);

  if (args.booleans.has("estimate")) {
    try {
      const estimate = await apiRequest<unknown>(target, "POST", "/api/replay/estimate", body, { timeoutMs: requestTimeout });
      if (!isObject(estimate) || typeof estimate.cases !== "number") {
        write(io.stderr, "l2m: the estimate is inconclusive: the API's answer is not an estimate (is the CLI the same version as the API?)");
        return EXIT_INCOMPLETE;
      }
      if (args.booleans.has("json")) io.stdout.write(`${JSON.stringify(estimate, null, 2)}\n`);
      else write(io.stdout, formatEstimate(estimate as Partial<ReplayJobEstimate> & { cases: number }));
      return EXIT_OK;
    } catch (error) {
      if (error instanceof RequestError) {
        if (error.status === 404 && isObject(error.body) && error.body.error === "Not Found") {
          write(io.stderr, "l2m: this server has no estimate route; --estimate needs a server that supports replay estimates.");
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
    const started = await apiRequest<{ run?: unknown }>(target, "POST", "/api/replay/runs", body, { timeoutMs: requestTimeout });
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
    const waited = await waitForJob(target, io, run, deadline);
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
  const deadline = Date.now() + timeoutS * 1000;
  const target = apiTarget(args, io);
  let run: JobView | null = null;
  try {
    try {
      run = await pollJob(target, io, runId, deadline);
    } catch (error) {
      if (error instanceof RequestError && !(error instanceof PollRequestError)) {
        write(io.stderr, "l2m: replay job is inconclusive: the API's answer is not a replay job");
        return EXIT_INCOMPLETE;
      }
      throw error;
    }
    if (args.booleans.has("wait")) {
      const waited = await waitForJob(target, io, run, deadline);
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
