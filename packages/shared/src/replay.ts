import { z } from "zod";
import type { WorkflowNodeType } from "./types";

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
 * What this does not cover yet: user expressions inside nodes that do run
 * (`{{ }}` templates, sort expressions) are evaluated in the host realm, as
 * in any run, so an expression written to make a network call can still
 * make one in a replay. Sandboxing those expressions is separate work.
 *
 * What a node does in a replay is decided by its class:
 *
 *   trigger    the run's own input; the recorded output is replayed
 *   logic      transforms and control flow; runs (user expressions in them run too)
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
  /** Model calls run live in a replay. */
  models: "live";
  /** Session memory starts empty in a replay. */
  memory: "empty";
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
}

export interface ReplayRecordingDetail extends ReplayRecordingSummary {
  input: unknown;
  facts: RunFacts;
  nodes: Record<string, ReplayRecordedNode>;
  /** Number of MCP calls in the copied cassette. */
  mcpCallCount: number;
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
  | "replay_error";

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
  candidate: { kind: "draft" | "version"; version: number | null; workflowHash: string };
  status: string;
  diff: RunDiff;
  verdict: ReplayVerdict;
  reasons: string[];
  facts: RunFacts;
}
