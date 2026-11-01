/**
 * The shapes a run is started with: the input of the app's run function (app.ts runWorkflowExecution) and the
 * event hooks a run reports through. Shared by app.ts and the route modules that start runs.
 */
import type {
  DataLabels,
  McpElicitationView,
  McpToolPolicySubject,
  McpToolProgressEvent,
  NodeActivityEvent,
  ReleaseChannel,
  Workflow,
  WorkflowExecutionState
} from "@ai-orchestrator/shared";
import type { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type { ReplayNodeHook } from "@ai-orchestrator/workflow-engine";
import type { SafeUser } from "./services/auth-service.js";
import type { CaptureSource } from "./services/replay-capture-service.js";
import type { CaptureInputOrigin } from "./services/capture-masking.js";
import type { ReplaySandbox } from "./services/replay-sandbox.js";
import type { GuardSimulationRun } from "./services/guard-simulation-sink.js";
import type { McpCassetteRunPlan } from "./services/mcp-cassette-service.js";

export type WorkflowExecutionEventHooks = {
  onNodeStart?: (event: { nodeId: string; nodeType: string; startedAt: string; input?: unknown }) => Promise<void> | void;
  onNodeComplete?: (event: {
    nodeId: string;
    nodeType: string;
    status: string;
    completedAt: string;
    durationMs: number;
    input?: unknown;
    output?: unknown;
    error?: string;
  }) => Promise<void> | void;
  onLLMDelta?: (event: { nodeId: string; delta: string; index: number }) => Promise<void> | void;
  /** Phase 10.5 — `notifications/progress` from an MCP server during an MCP Tool node or agent tool call. */
  onMcpProgress?: (event: McpToolProgressEvent & { nodeId: string }) => Promise<void> | void;
  /** Step-by-step node activity: resolved inputs, model calls, retries, agent steps and tool calls. */
  onNodeActivity?: (event: NodeActivityEvent) => Promise<void> | void;
  /** Phase 10.5 — an `elicitation/create` request started waiting for a person, or was settled. */
  onMcpElicitation?: (event: { phase: "created" | "settled"; elicitation: McpElicitationView }) => Promise<void> | void;
};

/** What a run is started with (app.ts runWorkflowExecution). */
export interface RunWorkflowExecutionInput {
  workflow: Workflow;
  startNodeId?: string;
  runMode?: "workflow" | "single_node";
  usePinnedData?: boolean;
  pinnedData?: Record<string, unknown>;
  nodeOutputs?: Record<string, unknown>;
  webhookPayload?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  systemPrompt?: string;
  userPrompt?: string;
  sessionId?: string;
  directInput?: Record<string, unknown>;
  executionId?: string;
  triggerType?: string;
  triggeredBy?: string;
  /**
   * Phase 10.2 — the signed-in user who started this run. Set only by
   * routes that authenticate a user; never derived from a request body.
   * Without it the tool policy uses the workflow owner's role.
   */
  policyActor?: SafeUser | null;
  /**
   * Phase 10.4 — an explicit policy subject (an MCP gateway client). Wins
   * over `policyActor` and the owner fallback.
   */
  policySubject?: McpToolPolicySubject;
  /**
   * MCP elicitations from this run belong to the workflow, not to
   * `policyActor`: anyone with workflow:execute on it may answer them.
   * Set for queued jobs, whose enqueuer is usually not watching.
   */
  elicitationsForWorkflow?: boolean;
  executionTimeoutMs?: number;
  customData?: Record<string, unknown>;
  resumeState?: WorkflowExecutionState;
  approvalDecision?: {
    decision: "approve" | "reject" | "timeout";
    actedBy?: string;
    reason?: string;
    edits?: Record<string, unknown>;
    editedFields?: string[];
    requestId?: string;
  };
  hooks?: WorkflowExecutionEventHooks;
  /** Phase 10.8 — record this run's MCP calls, or answer them from a cassette. */
  mcpPlan?: McpCassetteRunPlan;
  /**
   * Phase 15.1 — a golden-run replay: stubbed nodes answered by the plan's
   * hook, session state in the sandbox's own stores, no error workflow,
   * no notifications, no paused state, no elicitation prompts.
   */
  replay?: { hook: ReplayNodeHook; sandbox: ReplaySandbox };
  /** Phase 15.3 — model calls answered from a golden run's model tape (a replay with `models: "replay"`). */
  providerRegistry?: ProviderRegistry;
  /** Phase 15.3 — a replay candidate's guard profile, evaluated in place of the bindings. */
  guardProfileOverride?: { profileId: string; version?: number };
  /** Phase 15.6 — a guard policy simulation's execution: the profile it swaps in, and where its verdicts and tokens go. */
  guardSimulation?: GuardSimulationRun;
  /**
   * Phase 15.4 — `production` for production traffic (the caller resolved
   * the published version): sub-workflows and the error workflow load their
   * published versions too, and a pause remembers it for the resume.
   * Default `draft`.
   */
  channel?: ReleaseChannel;
  /** The published version a production run runs (default: the version the resolver returned this workflow object as). */
  releaseVersion?: number | null;
  /**
   * Phase 15.6 — who produced the run's input, as the server knows it:
   * `scheduler` for the scheduler's own runs, `user` for a signed-in user
   * or API key. Never derived from a caller-supplied trigger name.
   */
  captureInputOrigin?: CaptureInputOrigin;
  /**
   * Phase 15.6 — set by the execute routes when an API key started the run
   * on the production channel. The run keeps its `manual` trigger (the
   * workflow, history and filters see it as before); this server-side
   * marker alone makes it eligible for capture.
   */
  captureSource?: CaptureSource;
  /**
   * Phase 16 — where the run's input came from, when the server knows better
   * than the starter: a replay, gate case, simulation, MCP replay or eval of a
   * recorded case takes the recording's input origin (Q7), not the user who
   * started it. Absent: decided from the trigger and who started the run.
   */
  inputLabels?: DataLabels;
  /**
   * 12.2 — set with `inputLabels` by a route that derived them from the trigger itself (a webhook's verified auth or
   * an admin's trust setting): the trigger node records them on its result even when the run does not track labels,
   * so replays of the run keep them.
   */
  recordInputLabels?: boolean;
}
