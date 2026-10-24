import { z } from "zod";
import type { Workflow, WorkflowNode, WorkflowNodeType } from "./types";
import type { DataLabels } from "./data-labels";

/**
 * Phase 15.1 — golden runs and replay: the shared contract.
 *
 * A golden run is a scrubbed, self-contained copy of one finished
 * execution. Replaying it runs a candidate workflow (the draft or a saved
 * version) on the recorded input, with every node that reaches outside the
 * engine (connectors, HTTP, databases, sub-workflows, MCP) and every code
 * node answered from the recording instead of being run, and compares the
 * two runs.
 *
 * User expressions inside nodes that do run (`{{ }}` templates, sort
 * expressions) are evaluated in an isolated realm with no host access (see
 * workflow-engine/expression-sandbox.ts), so they cannot reach the network or
 * the file system, in a replay or any other run.
 *
 * What a node does in a replay is decided by its class:
 *
 *   trigger    the run's own input; the recorded output is replayed
 *   logic      transforms and control flow; runs (user expressions in them run in an isolated realm)
 *   model      model calls; run live (they are usually what is under test)
 *   guard      guard checks; run live
 *   mcp        MCP calls; answered from the recording's cassette, never a live server
 *   sandboxed  session memory and artifacts; run against stores that live only for the replay
 *   approval   human approvals; the recorded decision is replayed, nobody is asked
 *   wait       delays; passed through without waiting
 *   read       external reads; the recorded output is replayed
 *   write      external side effects; the recorded output is replayed
 *   code       user code (JavaScript and Python code nodes); the recorded output is replayed
 *
 * A node type this table does not know (a community node, a type added
 * later) is a `write`: it is stubbed, never run live.
 */

export type ReplayNodeClass = "trigger" | "logic" | "model" | "guard" | "mcp" | "sandboxed" | "approval" | "wait" | "read" | "write" | "code";

export const REPLAY_NODE_CLASSES: Readonly<Record<WorkflowNodeType, ReplayNodeClass>> = {
  // Triggers: their output is the run's input.
  schedule_trigger: "trigger",
  webhook_input: "trigger",
  manual_trigger: "trigger",
  form_trigger: "trigger",
  chat_trigger: "trigger",
  file_trigger: "trigger",
  rss_trigger: "trigger",
  sse_trigger: "trigger",
  mcp_server_trigger: "trigger",
  kafka_trigger: "trigger",
  rabbitmq_trigger: "trigger",
  mqtt_trigger: "trigger",
  sub_workflow_trigger: "trigger",
  error_trigger: "trigger",
  slack_trigger: "trigger",
  github_webhook_trigger: "trigger",
  stripe_webhook_trigger: "trigger",
  telegram_trigger: "trigger",
  discord_trigger: "trigger",
  // Triggers that poll an external system when they run.
  imap_email_trigger: "read",
  google_sheets_trigger: "read",
  postgres_trigger: "read",
  redis_trigger: "read",
  google_drive_trigger: "read",

  // Inputs, transforms and control flow.
  text_input: "logic",
  system_prompt: "logic",
  user_prompt: "logic",
  prompt_template: "logic",
  loop_node: "logic",
  merge_node: "logic",
  set_node: "logic",
  chat_intent_router: "logic",
  helper_chat_response: "logic",
  input_validator: "logic",
  if_node: "logic",
  switch_node: "logic",
  try_catch: "logic",
  filter_node: "logic",
  stop_and_error: "logic",
  noop_node: "logic",
  aggregate_node: "logic",
  split_out_node: "logic",
  sort_node: "logic",
  limit_node: "logic",
  remove_duplicates_node: "logic",
  summarize_node: "logic",
  compare_datasets_node: "logic",
  rename_keys_node: "logic",
  edit_fields_node: "logic",
  date_time_node: "logic",
  crypto_node: "logic",
  jwt_node: "logic",
  xml_node: "logic",
  html_node: "logic",
  convert_to_file_node: "logic",
  extract_from_file_node: "logic",
  compression_node: "logic",
  edit_image_node: "logic",
  extract_citations: "logic",
  document_chunker: "logic",
  // Runs, but in a replay a chart never loads data from a URL or file (the
  // engine refuses the load and the replay is inconclusive).
  chart: "logic",
  // Text mode runs; HTML mode renders in Chromium, which loads whatever the
  // page asks for, so it is answered from the recording (`replayNodeClass`).
  pdf_output: "logic",
  output: "logic",
  webhook_response: "logic",
  sticky_note: "logic",

  // Models.
  llm_call: "model",
  openai_chat_model: "model",
  anthropic_chat_model: "model",
  ollama_chat_model: "model",
  openai_compatible_chat_model: "model",
  ai_gateway_chat_model: "model",
  azure_openai_chat_model: "model",
  google_gemini_chat_model: "model",
  agent_orchestrator: "model",
  supervisor_node: "model",
  basic_llm_chain: "model",
  qa_chain: "model",
  summarization_chain: "model",
  information_extractor: "model",
  text_classifier: "model",
  sentiment_analysis: "model",
  ai_transform: "model",
  // Parses text; can ask the upstream model to repair output that does not parse.
  output_parser: "model",

  // Guard.
  guard: "guard",
  guard_protection: "guard",
  output_guardrail: "guard",

  // MCP.
  mcp_tool: "mcp",

  // User code: neither the JavaScript sandbox (a `vm` context, not an
  // isolate) nor the Python subprocess is cut off from the network, so code
  // nodes are answered from the recording.
  code_node: "code",

  // Session state: replays get their own in-memory stores.
  local_memory: "sandboxed",
  session_artifact_save: "sandboxed",
  session_artifact_load: "sandboxed",

  // People and time.
  human_approval: "approval",
  approval_gate: "approval",
  wait_node: "wait",

  // External reads.
  web_browse: "read",
  connector_source: "read",
  google_drive_source: "read",
  rag_retrieve: "read",
  rerank: "read",
  embeddings_azure_openai: "read",
  google_sheets_read: "read",
  notion_query_database: "read",
  airtable_list_records: "read",
  jira_search_issues: "read",
  salesforce_query: "read",
  hubspot_get_contact: "read",
  aws_s3_get_object: "read",
  aws_s3_list_objects: "read",
  google_calendar_list_events: "read",

  // External side effects (and anything that can be one: any HTTP method,
  // queries that can write, stores that can upsert, sub-workflows).
  http_request: "write",
  azure_storage: "write",
  azure_cosmos_db: "write",
  azure_monitor_http: "write",
  azure_ai_search_vector_store: "write",
  qdrant_vector_store: "write",
  execute_workflow: "write",
  slack_send_message: "write",
  smtp_send_email: "write",
  google_sheets_append: "write",
  google_sheets_update: "write",
  postgres_query: "write",
  mysql_query: "write",
  mongo_operation: "write",
  redis_command: "write",
  github_action: "write",
  teams_send_message: "write",
  notion_create_page: "write",
  airtable_create_record: "write",
  airtable_update_record: "write",
  jira_create_issue: "write",
  salesforce_create_record: "write",
  hubspot_create_contact: "write",
  stripe_create_customer: "write",
  stripe_create_charge: "write",
  aws_s3_put_object: "write",
  telegram_send_message: "write",
  discord_send_message: "write",
  google_calendar_create_event: "write",
  twilio_send_sms: "write"
};

/** Classes whose nodes never run their handler in a replay. */
export const REPLAY_STUBBED_CLASSES: ReadonlySet<ReplayNodeClass> = new Set<ReplayNodeClass>(["trigger", "approval", "wait", "read", "write", "code"]);

/** Classes that are stubbed even when the recording has nothing for the node. */
export const REPLAY_ALWAYS_STUBBED_CLASSES: ReadonlySet<ReplayNodeClass> = new Set<ReplayNodeClass>(["approval", "wait", "read", "write", "code"]);

/**
 * The class of a node in a replay. Unknown types (and prototype keys) are
 * `write`. A PDF Output node in HTML mode is a `read`: Chromium loads every
 * image, script and stylesheet the rendered page points at, so the recorded
 * PDF is replayed instead.
 */
export function replayNodeClass(node: { type: string; config?: unknown }): ReplayNodeClass {
  if (!Object.prototype.hasOwnProperty.call(REPLAY_NODE_CLASSES, node.type)) return "write";
  if (node.type === "pdf_output") {
    const config = node.config && typeof node.config === "object" ? (node.config as Record<string, unknown>) : {};
    if (config.renderMode === "html") return "read";
  }
  return REPLAY_NODE_CLASSES[node.type as WorkflowNodeType];
}

/** Marker key on the synthetic output a stubbed node gets when the recording has nothing for it. */
export const REPLAY_STUB_MARKER = "_replayStub";
/**
 * In the error of a node that tried to load data from a URL or file during a
 * replay (a chart's `data.url`). The load is refused and the replay is
 * inconclusive.
 */
export const REPLAY_BLOCKED_LOAD_MARKER = "replay_blocked_load";
/** Marker key on a recorded node output that was cut to fit the size limit. */
export const REPLAY_TRUNCATED_MARKER = "_replayTruncated";

// ---------------------------------------------------------------------------
// Run facts: what a run did, normalised and scrubbed, for comparison
// ---------------------------------------------------------------------------

export interface RunFactNode {
  nodeId: string;
  nodeType: string;
  status: string;
  durationMs: number | null;
  errorCategory: string | null;
  /**
   * Phase 15.6 — what the node's recorded content holds: the data classes a
   * production capture's masking pass found in it (`source: "scan"`) and
   * where it came from. Absent on runs that were not scanned.
   */
  labels?: DataLabels;
}

export interface RunFactToolCall {
  nodeId: string;
  iteration: number | null;
  /** Registry server id, else the adapter id. */
  server: string;
  tool: string;
  /** Scrubbed arguments, canonical. */
  args: unknown;
  /** SHA-256 of the canonical scrubbed arguments. */
  argsHash: string;
  outcome: string;
  durationMs: number | null;
}

export interface RunFactModelCall {
  nodeId: string;
  iteration: number | null;
  providerId: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
}

export interface RunFactGuardVerdict {
  nodeId: string | null;
  placement: string;
  channel: string;
  detectorId: string | null;
  effectiveAction: string;
  shadow: boolean;
  /**
   * Phase 15.6 — the finding's data class (DLP), when it has one. Absent on
   * facts built before 15.6.
   */
  dataClass?: string | null;
  /**
   * Phase 15.6 — which verdict of the run the row belongs to (0-based, in the
   * order verdicts were first recorded): a verdict with several findings has
   * one row per finding. Absent on facts built before 15.6.
   */
  verdict?: number;
}

export interface RunFactTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
  durationMs: number | null;
  modelCalls: number;
  toolCalls: number;
}

export interface RunFacts {
  status: string;
  error: string | null;
  output: unknown;
  nodes: RunFactNode[];
  toolCalls: RunFactToolCall[];
  modelCalls: RunFactModelCall[];
  guard: RunFactGuardVerdict[];
  totals: RunFactTotals;
}

// ---------------------------------------------------------------------------
// Golden runs (recordings)
// ---------------------------------------------------------------------------

export interface ReplayRecordedRun {
  status: string;
  output?: unknown;
  error?: string | null;
}

export interface ReplayRecordedNode extends ReplayRecordedRun {
  nodeId: string;
  nodeType: string;
  /**
   * Every finished result of the node in run order, when it ran more than
   * once (a loop body). A replay answers the n-th call with the n-th entry.
   * The top-level fields hold the last one.
   */
  runs?: ReplayRecordedRun[];
}

export interface ReplayRecordingCapabilities {
  /** `cassette`: MCP calls are answered from a copied cassette; `none`: the source run was not recorded, so every MCP call fails in a replay. */
  mcp: "cassette" | "none";
  /**
   * `tape` (Phase 15.3): the source run recorded its model calls, so a replay
   * job with `models: "replay"` can answer them without calling the model.
   * `live`: no tape; model calls always run live.
   */
  models: "live" | "tape";
  /** `seeded` (Phase 15.3): session memory starts as the source run found it; `empty`: it starts empty. */
  memory: "empty" | "seeded";
  /** `captured`: the workflow as it ran was recorded with the run; `current`: the run predates that, so the workflow as saved when the golden run was made is kept instead. */
  workflowSource: "captured" | "current";
  /**
   * Where secret scrubbing changed a recorded value: the trigger input, the
   * run's final output, and the nodes whose recorded output or error was
   * altered. A replay feeds those scrubbed values to the candidate (a
   * pagination token or a long id becomes `[REDACTED]`), so it warns when it
   * uses one. Absent on golden runs saved before this was recorded.
   */
  scrubbed?: ReplayScrubbedValues;
  /**
   * Phase 15.5: `imported` when the golden run came from a golden-set file
   * (absent, or `recorded`, for a run saved on this deployment). For an
   * imported run the summary's `createdAt` is the time the file claims the
   * run was recorded (never later than the import), so age rules treat it as
   * old as it says it is; `importedAt` is when it was loaded here.
   */
  origin?: "recorded" | "imported";
  /** Imported runs: when the file says the run was recorded. */
  recordedAt?: string;
  /** Imported runs: when the file was imported here. */
  importedAt?: string;
  /** Imported runs: the workflow id the file was exported from. */
  sourceWorkflowId?: string | null;
  /** Phase 15.6 — set on a run captured from production traffic: how it was sampled and masked. */
  capture?: ReplayCaptureInfo;
}

/** Phase 15.6 — how a captured run was taken and masked. Counts and class names only, never values. */
export interface ReplayCaptureInfo {
  /** The sampling rate in force when the run started (0..1). */
  rate: number;
  /** Whether the masking pass ran (DLP on capture). */
  masked: boolean;
  /**
   * False on a run imported from a golden-set file: the file says it was
   * masked, but this server did not mask it, so nothing vouches for it
   * ("imported (masking not verified)"). Absent on runs captured here.
   */
  maskingVerified?: boolean;
  /** Data classes masked anywhere in the run, sorted. */
  dataClasses: string[];
  /** Distinct values masked, per class. */
  values: Record<string, number>;
  /** Masked classes the DLP scan no longer finds after masking (dictionary classes, removed secrets). */
  notDetectableAfterMasking: string[];
  /** Detected values left in place because the workflow definition holds them. */
  keptFromWorkflow: number;
  /** The published version the run ran, when the workflow has one. */
  publishedVersion: number | null;
  /**
   * `api_key`: an API key started the run on the execute routes (its trigger
   * stays `manual`). Set by the server where the run started; a golden-set
   * import drops it.
   */
  source?: "api_key";
}

export interface ReplayScrubbedValues {
  input: boolean;
  output: boolean;
  nodes: string[];
}

export interface ReplayRecordingSummary {
  id: string;
  workflowId: string;
  projectId: string | null;
  name: string;
  notes: string | null;
  sourceExecutionId: string | null;
  sourceTriggerType: string | null;
  sourceStatus: string;
  workflowHash: string;
  workflowSavedVersion: number | null;
  capabilities: ReplayRecordingCapabilities;
  bytes: number;
  truncated: boolean;
  createdAt: string;
  createdBy: string | null;
  /**
   * Phase 15.6 — `candidate`: captured from production and waiting in the
   * "Captured runs" inbox; it is not a golden run until a builder promotes
   * it, and no golden set, replay, gate or export uses it. `golden`: every
   * golden run saved by hand, imported, or promoted.
   */
  status: ReplayRecordingStatus;
  /** Phase 15.6 — when the run was captured from production (kept after promotion); null for runs saved by hand. */
  capturedAt: string | null;
}

export const REPLAY_RECORDING_STATUSES = ["candidate", "golden"] as const;
export type ReplayRecordingStatus = (typeof REPLAY_RECORDING_STATUSES)[number];

export interface ReplayRecordingDetail extends ReplayRecordingSummary {
  input: unknown;
  facts: RunFacts;
  nodes: Record<string, ReplayRecordedNode>;
  /** Number of MCP calls in the copied cassette. */
  mcpCallCount: number;
  /** Phase 15.3 — number of model calls on the copied model tape (0 without one). */
  modelCallCount?: number;
}

/** Runs-page badge: the golden runs saved from an execution. */
export interface ReplayGoldenBadge {
  count: number;
  latestId: string;
}

export const replayRecordingCreateSchema = z.object({
  executionId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(2000).optional()
});
export type ReplayRecordingCreateInput = z.infer<typeof replayRecordingCreateSchema>;

export const REPLAY_MCP_MODES = ["strict", "lenient"] as const;

/** Most ignore paths one replay request may carry (the defaults come on top). */
export const REPLAY_IGNORE_PATHS_MAX = 32;
/** Longest ignore path, in characters. */
export const REPLAY_IGNORE_PATH_MAX_LENGTH = 128;
/** Most `**` segments in one ignore path; more never match anything a smaller pattern cannot. */
export const REPLAY_IGNORE_PATH_MAX_GLOBSTARS = 8;

/** One ignore path: printable characters only, within the length and `**` limits. */
export const replayIgnorePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(REPLAY_IGNORE_PATH_MAX_LENGTH)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), { message: "Ignore paths cannot contain control characters" })
  .refine((value) => (value.match(/\*\*/g) ?? []).length <= REPLAY_IGNORE_PATH_MAX_GLOBSTARS, {
    message: `An ignore path can have at most ${REPLAY_IGNORE_PATH_MAX_GLOBSTARS} ** segments`
  });
export type ReplayMcpMode = (typeof REPLAY_MCP_MODES)[number];

/**
 * A replay request. The candidate is the draft (the workflow as saved now)
 * or one saved version. `mcpMode` is how MCP calls are matched against the
 * cassette: both need the same arguments; `strict` answers each recorded
 * call once, `lenient` reuses the last answer for a call made more often
 * than recorded. Neither ever reaches a live MCP server.
 */
export const replayRunRequestSchema = z
  .object({
    draft: z.boolean().optional(),
    version: z.number().int().positive().optional(),
    mcpMode: z.enum(REPLAY_MCP_MODES).optional(),
    ignorePaths: z.array(replayIgnorePathSchema).max(REPLAY_IGNORE_PATHS_MAX).optional(),
    numberTolerance: z.number().min(0).max(1e9).optional()
  })
  .strict()
  .refine((value) => !(value.draft === true && value.version !== undefined), { message: "Choose the draft or a version, not both" });
export type ReplayRunRequest = z.infer<typeof replayRunRequestSchema>;

// ---------------------------------------------------------------------------
// Run diff
// ---------------------------------------------------------------------------

export interface ReplayValueChange {
  /** `answer`, `items[2].id`; empty for the root value. */
  path: string;
  kind: "added" | "removed" | "changed";
  baseline?: unknown;
  candidate?: unknown;
  /** For changed strings: token-overlap similarity, 0..1. */
  similarity?: number;
  /** The values differ below the depth the diff walks to; this change stands for everything below it. */
  truncated?: boolean;
}

export interface ReplayNumberDelta {
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  /** Relative change in percent; null when the baseline is 0 or missing. */
  pct: number | null;
}

export interface ReplayToolStep {
  kind: "matched" | "inserted" | "deleted";
  baseline: RunFactToolCall | null;
  candidate: RunFactToolCall | null;
  /** Matched calls: the arguments differ. */
  argsChanged: boolean;
  argChanges: ReplayValueChange[];
  /** Matched calls: the outcome differs (ok, error, blocked...). */
  outcomeChanged: boolean;
}

export type ReplayHealthKind =
  | "unrecorded_stub"
  | "unknown_node_type"
  | "truncated_recording"
  | "config_changed"
  | "recording_overrun"
  | "mcp_unmatched"
  | "no_cassette"
  | "paused"
  | "blocked_load"
  | "diff_truncated"
  | "scrubbed_recording"
  | "replay_error"
  // Phase 15.3
  | "no_model_tape"
  | "model_unmatched"
  | "model_live"
  | "live_read"
  | "mcp_live_read"
  | "baseline_error"
  | "budget";

export interface ReplayHealthWarning {
  kind: ReplayHealthKind;
  nodeId: string | null;
  message: string;
  /** Makes the replay inconclusive: the verdict is `error`, not pass or fail. */
  blocking: boolean;
}

export interface RunDiff {
  status: { baseline: string; candidate: string; changed: boolean; regression: boolean };
  /** `truncated`: more changes than listed, or some reported without detail (see `ReplayValueChange.truncated`). */
  output: { equal: boolean; changes: ReplayValueChange[]; ignored: number; ignorePaths: string[]; truncated?: boolean };
  toolCalls: { baselineCount: number; candidateCount: number; changed: boolean; steps: ReplayToolStep[]; countDelta: Array<{ server: string; tool: string; baseline: number; candidate: number }> };
  path: {
    added: string[];
    removed: string[];
    statusChanges: Array<{ nodeId: string; baseline: string; candidate: string }>;
  };
  models: {
    changes: Array<{ nodeId: string; baseline: string | null; candidate: string | null }>;
    callDelta: ReplayNumberDelta;
  };
  totals: {
    tokens: ReplayNumberDelta;
    costUsd: ReplayNumberDelta;
    latencyMs: ReplayNumberDelta;
    toolCalls: ReplayNumberDelta;
  };
  guard: {
    added: RunFactGuardVerdict[];
    removed: RunFactGuardVerdict[];
    changed: Array<{ baseline: RunFactGuardVerdict; candidate: RunFactGuardVerdict }>;
  };
  health: ReplayHealthWarning[];
}

export type ReplayVerdict = "pass" | "fail" | "error";

export interface ReplayJudgement {
  verdict: ReplayVerdict;
  reasons: string[];
}

/**
 * Pass or fail for a single replay. `error` when the replay itself could not
 * be trusted (a strict cassette miss, a pause, a run that never finished);
 * `fail` when the run's status regressed or its output changed outside the
 * ignored paths; `pass` otherwise. Tool-call, cost and guard changes are
 * reported but do not fail a single replay. Shared by the API and `l2m`.
 */
export function judgeReplayDiff(diff: RunDiff): ReplayJudgement {
  const blocking = diff.health.filter((warning) => warning.blocking);
  if (blocking.length > 0) {
    return { verdict: "error", reasons: blocking.map((warning) => warning.message) };
  }
  const reasons: string[] = [];
  if (diff.status.regression) reasons.push(`Status regressed: ${diff.status.baseline} → ${diff.status.candidate}`);
  if (!diff.output.equal) {
    const count = diff.output.changes.length;
    reasons.push(`Output changed at ${count} path${count === 1 ? "" : "s"}${count > 0 ? ` (${diff.output.changes.slice(0, 3).map((change) => change.path || "(root)").join(", ")}${count > 3 ? ", …" : ""})` : ""}`);
  }
  return { verdict: reasons.length > 0 ? "fail" : "pass", reasons };
}

export interface ReplayRunResponse {
  recordingId: string;
  executionId: string;
  candidate: { kind: "draft" | "version" | "inline"; version: number | null; workflowHash: string };
  status: string;
  diff: RunDiff;
  verdict: ReplayVerdict;
  reasons: string[];
  facts: RunFacts;
  /**
   * Phase 15.3 — set when model calls were answered from the golden run's
   * model tape (`models: "replay"`). Tape answers cost nothing: their cost is
   * left out of `facts` (their tokens stay, so the diff still compares
   * them), and is shown here as what the recorded run spent on them.
   */
  modelTape?: ReplayModelTapeUsage;
}

/** Phase 15.3 — what a model replay answered from the tape, and what those calls cost when they were recorded. */
export interface ReplayModelTapeUsage {
  /** Model calls answered from the tape (no model was called). */
  replayedCalls: number;
  /** Model calls that went to the live model (lenient misses); priced in `facts`. */
  liveCalls: number;
  /**
   * Phase 15.6 — model calls the tape answered with a recorded entry (a
   * strict miss is in `replayedCalls` but not here). Absent on older jobs.
   */
  matchedCalls?: number;
  /** The recorded usage of the replayed calls. `costUsd` is null when none of them has a price. */
  recordedUsage: { inputTokens: number; outputTokens: number; costUsd: number | null };
}

// ---------------------------------------------------------------------------
// Phase 15.3 — candidates
// ---------------------------------------------------------------------------

/**
 * A candidate is what a replay job tests: the draft, a saved version, or a
 * workflow file (inline JSON, never saved), plus overrides. `applyCandidate`
 * turns the workflow and the model overrides into the workflow that runs;
 * the job's candidate hash is that workflow's hash. Guard, MCP and live-read
 * overrides change how the replay runs, not the workflow, and are kept on
 * the job next to the hash.
 */

/** How MCP calls to one server are answered in a replay. */
export const REPLAY_SERVER_MODES = ["strict", "lenient", "live_read_only"] as const;
export type ReplayServerMode = (typeof REPLAY_SERVER_MODES)[number];
/** `live`: model calls run live; `replay`: they are answered from the golden run's model tape. */
export const REPLAY_MODEL_MODES = ["live", "replay"] as const;
export type ReplayModelMode = (typeof REPLAY_MODEL_MODES)[number];
/** `recording`: compare with what the golden run recorded; `baseline_rerun`: also replay the golden run's own version in the same job and compare with that. */
export const REPLAY_COMPARE_MODES = ["recording", "baseline_rerun"] as const;
export type ReplayCompareMode = (typeof REPLAY_COMPARE_MODES)[number];
/** How the repeats of one case make its result. */
export const REPLAY_AGGREGATE_RULES = ["all", "majority", "any"] as const;
export type ReplayAggregateRule = (typeof REPLAY_AGGREGATE_RULES)[number];
export const REPLAY_REPEATS_MAX = 5;
/** The largest inline candidate (a workflow file in the request), as JSON bytes: 2 MiB. */
export const REPLAY_INLINE_WORKFLOW_MAX_BYTES = 2 * 1024 * 1024;
/** Golden runs older than this are compared with a baseline rerun rather than with the recording (decision 3). */
export const REPLAY_STALE_RECORDING_DAYS = 30;

const idSchema = z.string().trim().min(1).max(200);

export const replayModelOverrideSchema = z
  .object({
    /** A model node (LLM call or chat model) or an agent, supervisor or chain whose attached chat model is changed. Omitted: every node of `provider`. */
    nodeId: idSchema.optional(),
    /** Without `nodeId`: the provider whose nodes change. With it: the new provider (LLM Call nodes only). */
    provider: z.string().trim().min(1).max(120).optional(),
    model: z.string().trim().min(1).max(200),
    /**
     * The secret the node uses after the override. Required when the override
     * changes the provider of a node that has a secret or a base URL (the old
     * key must not go to another vendor); the user must be allowed to use it
     * in the workflow's project.
     */
    secretRef: z.object({ secretId: idSchema }).strict().optional()
  })
  .strict()
  .refine((value) => value.nodeId !== undefined || value.provider !== undefined, { message: "A model override names a node, a provider or both" });
export type ReplayModelOverride = z.infer<typeof replayModelOverrideSchema>;

export const replayCandidateOverridesSchema = z
  .object({
    models: z.array(replayModelOverrideSchema).max(50).optional(),
    guardProfile: z.object({ profileId: idSchema, version: z.number().int().positive().optional() }).strict().optional(),
    /** Per MCP server (registry server id, or the adapter id of an inline server). */
    mcpServers: z
      .record(idSchema, z.enum(REPLAY_SERVER_MODES))
      .refine((value) => Object.keys(value).length <= 50, { message: "At most 50 MCP server modes" })
      .optional(),
    /** Nodes that run live instead of being answered from the recording: only types `REPLAY_LIVE_READ_POLICY` allows (400 otherwise). */
    liveReadNodes: z.array(idSchema).max(100).optional()
  })
  .strict();
export type ReplayCandidateOverrides = z.infer<typeof replayCandidateOverridesSchema>;

/** The overrides that change something; undefined when there are none. */
export function normaliseCandidateOverrides(overrides: ReplayCandidateOverrides | null | undefined): ReplayCandidateOverrides | undefined {
  if (!overrides) return undefined;
  const out: ReplayCandidateOverrides = {};
  if (overrides.models && overrides.models.length > 0) out.models = overrides.models;
  if (overrides.guardProfile) out.guardProfile = overrides.guardProfile;
  if (overrides.mcpServers && Object.keys(overrides.mcpServers).length > 0) out.mcpServers = overrides.mcpServers;
  if (overrides.liveReadNodes && overrides.liveReadNodes.length > 0) out.liveReadNodes = [...new Set(overrides.liveReadNodes)];
  return Object.keys(out).length > 0 ? out : undefined;
}

export class ReplayCandidateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayCandidateError";
  }
}

/** Chat model node types and the provider each one talks to (`llm_call` carries its own). */
export const REPLAY_CHAT_MODEL_PROVIDERS: Readonly<Record<string, string | null>> = {
  llm_call: null,
  openai_chat_model: "openai",
  anthropic_chat_model: "anthropic",
  ollama_chat_model: "ollama",
  openai_compatible_chat_model: "openai_compatible",
  ai_gateway_chat_model: null,
  azure_openai_chat_model: "azure_openai",
  google_gemini_chat_model: "gemini"
};

const CHAT_MODEL_DEFAULTS: Readonly<Record<string, string>> = {
  openai_chat_model: "gpt-4o-mini",
  anthropic_chat_model: "claude-sonnet-5-5",
  ollama_chat_model: "llama3.1",
  google_gemini_chat_model: "gemini-2.5-flash"
};

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isChatModelNode(node: Pick<WorkflowNode, "type">): boolean {
  return Object.prototype.hasOwnProperty.call(REPLAY_CHAT_MODEL_PROVIDERS, node.type);
}

/** The provider and model a chat model node calls, as the engine builds them; null when it is not configured. */
export function chatModelOf(node: Pick<WorkflowNode, "type" | "config">): { providerId: string; model: string } | null {
  const config = recordOf(node.config);
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  if (node.type === "llm_call") {
    const provider = recordOf(config.provider);
    return text(provider.providerId) && typeof provider.model === "string" ? { providerId: text(provider.providerId), model: provider.model } : null;
  }
  if (node.type === "ai_gateway_chat_model") {
    const api = text(config.apiProvider);
    return { providerId: api === "openai" || api === "anthropic" ? api : "openai_compatible", model: text(config.model) };
  }
  if (node.type === "azure_openai_chat_model") return text(config.deployment) ? { providerId: "azure_openai", model: text(config.deployment) } : null;
  const providerId = REPLAY_CHAT_MODEL_PROVIDERS[node.type];
  if (!providerId) return null;
  return { providerId, model: text(config.model) || CHAT_MODEL_DEFAULTS[node.type] || "" };
}

/** The chat model nodes attached to a node's `chat_model` port. */
function attachedChatModels(workflow: Pick<Workflow, "nodes" | "edges">, nodeId: string): WorkflowNode[] {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  return workflow.edges
    .filter((edge) => edge.source === nodeId && edge.sourceHandle === "chat_model")
    .map((edge) => byId.get(edge.target))
    .filter((node): node is WorkflowNode => Boolean(node && isChatModelNode(node)));
}

/**
 * The model a node calls: its own for a model node, else the last chat
 * model attached to it (the one the engine uses). Null when it calls none.
 */
export function effectiveModelFor(workflow: Pick<Workflow, "nodes" | "edges">, nodeId: string): { providerId: string; model: string } | null {
  const node = workflow.nodes.find((entry) => entry.id === nodeId);
  if (!node) return null;
  if (isChatModelNode(node)) return chatModelOf(node);
  const attached = attachedChatModels(workflow, nodeId);
  const last = attached[attached.length - 1];
  return last ? chatModelOf(last) : null;
}

function setModel(node: WorkflowNode, model: string, provider: string | undefined, secretRef?: { secretId: string }): WorkflowNode {
  const config = { ...recordOf(node.config) };
  if (node.type === "llm_call") {
    const current = recordOf(config.provider);
    const currentProvider = typeof current.providerId === "string" ? current.providerId.trim() : "";
    const switching = Boolean(provider && provider !== currentProvider);
    const hasSecret = Boolean(recordOf(current.secretRef).secretId);
    const hasBaseUrl = typeof current.baseUrl === "string" && current.baseUrl.trim() !== "";
    if (switching && (hasSecret || hasBaseUrl) && !secretRef) {
      throw new ReplayCandidateError(
        `Model override: node ${node.id} calls ${currentProvider || "its provider"} with ${hasSecret ? "its own secret" : "its own base URL"}; switching it to ${provider} needs the override to name the secret to use (secretRef), so the node's key is never sent to another provider.`
      );
    }
    const next: Record<string, unknown> = { ...current, ...(provider ? { providerId: provider } : {}), model };
    // A new provider does not inherit the old one's endpoint.
    if (switching) delete next.baseUrl;
    if (secretRef) next.secretRef = { secretId: secretRef.secretId };
    config.provider = next;
  } else {
    if (secretRef) {
      throw new ReplayCandidateError(`Model override: node ${node.id} is a ${node.type} node; a secretRef can only be given for an LLM Call node.`);
    }
    const current = chatModelOf(node);
    if (provider && current && provider !== current.providerId) {
      throw new ReplayCandidateError(
        `Node ${node.id} is a ${node.type} node, which always calls ${current.providerId}; change its provider in the workflow, or override the model only.`
      );
    }
    if (node.type === "azure_openai_chat_model") config.deployment = model;
    else config.model = model;
  }
  return { ...node, config } as WorkflowNode;
}

/**
 * The workflow a candidate runs: a copy of `workflow` with its model
 * overrides applied, in order. A per-node override on an agent (or another
 * node with a `chat_model` port) changes the chat model attached to it; a
 * chat model shared by several nodes changes for all of them. A provider
 * override changes every chat model of that provider. Throws
 * `ReplayCandidateError` for an override that matches nothing.
 */
export function applyCandidate(workflow: Workflow, overrides: ReplayCandidateOverrides | null | undefined): Workflow {
  const out: Workflow = JSON.parse(JSON.stringify(workflow)) as Workflow;
  for (const override of overrides?.models ?? []) {
    if (override.nodeId !== undefined) {
      const node = out.nodes.find((entry) => entry.id === override.nodeId);
      if (!node) throw new ReplayCandidateError(`Model override: the workflow has no node ${override.nodeId}.`);
      const targets = isChatModelNode(node) ? [node] : attachedChatModels(out, node.id);
      if (targets.length === 0) throw new ReplayCandidateError(`Model override: node ${override.nodeId} (${node.type}) has no model to change.`);
      const ids = new Set(targets.map((target) => target.id));
      out.nodes = out.nodes.map((entry) => (ids.has(entry.id) ? setModel(entry, override.model, override.provider, override.secretRef) : entry));
      continue;
    }
    let matched = 0;
    out.nodes = out.nodes.map((entry) => {
      if (!isChatModelNode(entry) || chatModelOf(entry)?.providerId !== override.provider) return entry;
      matched += 1;
      return setModel(entry, override.model, undefined, override.secretRef);
    });
    if (matched === 0) throw new ReplayCandidateError(`Model override: no node of the workflow calls provider ${override.provider}.`);
  }
  return out;
}


// ---------------------------------------------------------------------------
// Phase 15.3 — which nodes may run live in a replay (`liveReadNodes`)
// ---------------------------------------------------------------------------

/**
 * Whether a node type may run live in a replay when a candidate names it in
 * `overrides.liveReadNodes`. This is a decision per node type, separate from
 * the replay class: many `read` nodes are only classed that way so that they
 * are always answered from the recording, and running them live is not safe.
 *
 *   safe      a pure read with no side effects (a list, get or search call)
 *   get_only  safe only when its configuration makes it a read: an HTTP
 *             Request node with `method: "GET"`
 *   refused   never runs live: every trigger (a poll can consume a queue
 *             item or run arbitrary SQL), every node that launches a browser
 *             (Web Browse, PDF Output), Connector Source (connector-defined),
 *             raw query nodes (SQL, SOQL), writes, models, code and the rest
 *
 * A type this table does not list is refused. The drift test in
 * replay-live-read-drift.test.ts fails when a node type is added without a
 * decision here, or when the set of types that may run live changes.
 */
export type ReplayLiveReadDecision = "safe" | "get_only" | "refused";

/*
 * Handlers checked for every entry that is not "refused" (a type stays on the
 * list only if its handler writes nothing: no store, upsert, cache or file,
 * and makes no paid call other than the read itself):
 *   google_drive_source          executor.ts "google_drive_source" -> connector-sdk google-drive fetchData: GET list/export calls; its one POST is the OAuth token exchange
 *   google_sheets_read           connectors/tier1.ts executeGoogleSheetsRead: one GET of the values range
 *   notion_query_database        connectors/tier2.ts: POST /databases/:id/query, a read-only query endpoint
 *   airtable_list_records        connectors/tier2.ts: GET of the records list
 *   jira_search_issues           connectors/tier2.ts: POST /rest/api/3/search, a read-only search endpoint
 *   hubspot_get_contact          connectors/tier2.ts: GET of one contact
 *   aws_s3_get_object            connectors/tier2.ts: signed GET
 *   aws_s3_list_objects          connectors/tier2.ts: signed GET (list)
 *   google_calendar_list_events  connectors/tier2.ts: GET of the events list
 *   http_request                 executor.ts "http_request": live only for a literal GET (no body is sent)
 * Removed after review: rag_retrieve (its handler always upserts the documents
 * into the vector store, and pays for embeddings, before it searches).
 */
export const REPLAY_LIVE_READ_POLICY: Readonly<Record<WorkflowNodeType, ReplayLiveReadDecision>> = {
  schedule_trigger: "refused",
  webhook_input: "refused",
  manual_trigger: "refused",
  form_trigger: "refused",
  chat_trigger: "refused",
  file_trigger: "refused",
  rss_trigger: "refused",
  sse_trigger: "refused",
  mcp_server_trigger: "refused",
  kafka_trigger: "refused",
  rabbitmq_trigger: "refused",
  mqtt_trigger: "refused",
  sub_workflow_trigger: "refused",
  error_trigger: "refused",
  slack_trigger: "refused",
  github_webhook_trigger: "refused",
  stripe_webhook_trigger: "refused",
  telegram_trigger: "refused",
  discord_trigger: "refused",
  imap_email_trigger: "refused",
  google_sheets_trigger: "refused",
  postgres_trigger: "refused",
  redis_trigger: "refused",
  google_drive_trigger: "refused",
  text_input: "refused",
  system_prompt: "refused",
  user_prompt: "refused",
  prompt_template: "refused",
  loop_node: "refused",
  merge_node: "refused",
  set_node: "refused",
  chat_intent_router: "refused",
  helper_chat_response: "refused",
  input_validator: "refused",
  if_node: "refused",
  switch_node: "refused",
  try_catch: "refused",
  filter_node: "refused",
  stop_and_error: "refused",
  noop_node: "refused",
  aggregate_node: "refused",
  split_out_node: "refused",
  sort_node: "refused",
  limit_node: "refused",
  remove_duplicates_node: "refused",
  summarize_node: "refused",
  compare_datasets_node: "refused",
  rename_keys_node: "refused",
  edit_fields_node: "refused",
  date_time_node: "refused",
  crypto_node: "refused",
  jwt_node: "refused",
  xml_node: "refused",
  html_node: "refused",
  convert_to_file_node: "refused",
  extract_from_file_node: "refused",
  compression_node: "refused",
  edit_image_node: "refused",
  extract_citations: "refused",
  document_chunker: "refused",
  chart: "refused",
  pdf_output: "refused",
  output: "refused",
  webhook_response: "refused",
  sticky_note: "refused",
  llm_call: "refused",
  openai_chat_model: "refused",
  anthropic_chat_model: "refused",
  ollama_chat_model: "refused",
  openai_compatible_chat_model: "refused",
  ai_gateway_chat_model: "refused",
  azure_openai_chat_model: "refused",
  google_gemini_chat_model: "refused",
  agent_orchestrator: "refused",
  supervisor_node: "refused",
  basic_llm_chain: "refused",
  qa_chain: "refused",
  summarization_chain: "refused",
  information_extractor: "refused",
  text_classifier: "refused",
  sentiment_analysis: "refused",
  ai_transform: "refused",
  output_parser: "refused",
  guard: "refused",
  guard_protection: "refused",
  output_guardrail: "refused",
  mcp_tool: "refused",
  code_node: "refused",
  local_memory: "refused",
  session_artifact_save: "refused",
  session_artifact_load: "refused",
  human_approval: "refused",
  approval_gate: "refused",
  wait_node: "refused",
  web_browse: "refused",
  connector_source: "refused",
  google_drive_source: "safe",
  rag_retrieve: "refused",
  rerank: "refused",
  embeddings_azure_openai: "refused",
  google_sheets_read: "safe",
  notion_query_database: "safe",
  airtable_list_records: "safe",
  jira_search_issues: "safe",
  salesforce_query: "refused",
  hubspot_get_contact: "safe",
  aws_s3_get_object: "safe",
  aws_s3_list_objects: "safe",
  google_calendar_list_events: "safe",
  http_request: "get_only",
  azure_storage: "refused",
  azure_cosmos_db: "refused",
  azure_monitor_http: "refused",
  azure_ai_search_vector_store: "refused",
  qdrant_vector_store: "refused",
  execute_workflow: "refused",
  slack_send_message: "refused",
  smtp_send_email: "refused",
  google_sheets_append: "refused",
  google_sheets_update: "refused",
  postgres_query: "refused",
  mysql_query: "refused",
  mongo_operation: "refused",
  redis_command: "refused",
  github_action: "refused",
  teams_send_message: "refused",
  notion_create_page: "refused",
  airtable_create_record: "refused",
  airtable_update_record: "refused",
  jira_create_issue: "refused",
  salesforce_create_record: "refused",
  hubspot_create_contact: "refused",
  stripe_create_customer: "refused",
  stripe_create_charge: "refused",
  aws_s3_put_object: "refused",
  telegram_send_message: "refused",
  discord_send_message: "refused",
  google_calendar_create_event: "refused",
  twilio_send_sms: "refused"
};

/**
 * Why a node may not run live in a replay, or null when it may. Unknown
 * types (and prototype keys) are refused.
 */
export function replayLiveReadRefusal(node: { id?: string; type: string; config?: unknown }): string | null {
  const label = `${node.id ? `node ${node.id} ` : ""}(${node.type})`;
  if (!Object.prototype.hasOwnProperty.call(REPLAY_LIVE_READ_POLICY, node.type)) {
    return `Live read: ${label} is not a node type that may run live in a replay.`;
  }
  const decision = REPLAY_LIVE_READ_POLICY[node.type as WorkflowNodeType];
  if (decision === "safe") return null;
  if (decision === "get_only") {
    const config = node.config && typeof node.config === "object" ? (node.config as Record<string, unknown>) : {};
    const method = typeof config.method === "string" ? config.method.trim().toUpperCase() : "";
    return method === "GET" ? null : `Live read: ${label} runs live only as a GET request (it is ${method || "not set"}).`;
  }
  const nodeClass = replayNodeClass(node);
  if (nodeClass === "write") return `Live read: ${label} can change external systems, and replays never run those live.`;
  if (nodeClass === "trigger" || node.type.endsWith("_trigger")) return `Live read: ${label} is a trigger; triggers never run live in a replay (a poll can consume or change what it reads).`;
  if (nodeClass === "read") return `Live read: ${label} is not on the list of reads that may run live in a replay.`;
  return `Live read: ${label} is not an external read (it is a ${nodeClass} node).`;
}
/**
 * Problems with `liveReadNodes`: a node that is not in the candidate, or
 * whose type may not run live (`replayLiveReadRefusal`; writes, triggers and
 * anything not on `REPLAY_LIVE_READ_POLICY` never run live in a replay).
 */
export function liveReadNodeProblems(workflow: Pick<Workflow, "nodes">, nodeIds: readonly string[]): string[] {
  const problems: string[] = [];
  for (const nodeId of nodeIds) {
    const node = workflow.nodes.find((entry) => entry.id === nodeId);
    if (!node) {
      problems.push(`Live read: the workflow has no node ${nodeId}.`);
      continue;
    }
    const refusal = replayLiveReadRefusal(node);
    if (refusal) problems.push(refusal);
  }
  return problems;
}

/** One repeat of a case: its result and, for a baseline rerun, the baseline execution. */
export type ReplayAttemptStatus = "pass" | "fail" | "error";

/**
 * A case's result from its repeats. `all`: any fail fails it, else any error
 * makes it inconclusive. `majority`: more than half pass, else a fail fails
 * it, else inconclusive. `any`: one pass is enough, else as `all`.
 */
export function aggregateReplayAttempts(statuses: readonly ReplayAttemptStatus[], rule: ReplayAggregateRule): ReplayAttemptStatus {
  if (statuses.length === 0) return "error";
  const pass = statuses.filter((status) => status === "pass").length;
  const fail = statuses.filter((status) => status === "fail").length;
  const error = statuses.length - pass - fail;
  if (rule === "any" && pass > 0) return "pass";
  if (rule === "majority" && pass * 2 > statuses.length) return "pass";
  if (rule === "all" && fail === 0 && error === 0) return "pass";
  if (fail > 0) return "fail";
  return error > 0 ? "error" : "fail";
}
