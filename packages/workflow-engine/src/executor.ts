import { randomUUID } from "node:crypto";
import type { AgentRuntimeAdapter, AgentSessionMemoryStore, AgentSessionToolDataStore } from "@ai-orchestrator/agent-runtime";
import { azureStorageEndpointFor, type ConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import {
  classifyMcpTool,
  evaluateMcpToolAccess,
  invokeDirectMCPTool,
  McpToolPolicyError,
  policyDecisionRecord,
  policyNeedsAnnotations,
  policyNeedsArguments,
  resolveMCPTools,
  openWorldRequestFields,
  policyReadsOpenWorld,
  resolveToolOpenWorld,
  serverOpenWorldDestination,
  type McpToolAccessCall,
  type McpToolAccessCheck,
  type McpToolAccessDecision,
  type McpToolAccessSubjectTool,
  type MCPExecutionContext,
  type MCPRegistry,
  isDelegatedCredentialError,
  parseMcpRuntimeRejection,
  withDelegatedUser
} from "@ai-orchestrator/mcp-sdk";
import type { ProviderExecutionContext, ProviderRegistry, ResilientFetchRetryInfo } from "@ai-orchestrator/provider-sdk";
import { providerDestinationRef } from "@ai-orchestrator/provider-sdk";
import {
  GUARD_EFFECTIVE_PROFILE_REF,
  NODE_ACTIVITY_LIMIT,
  NODE_ACTIVITY_PREVIEW_CHARS,
  azureStorageSecretAddressConfig,
  connectorAddressInSecret,
  destinationHostOfSetting,
  inputProvenance,
  mcpServerDestinationRef,
  networkDestinationRef,
  nodeContentSource,
  withoutDataClasses,
  canonicalPolicyJson,
  policyRulesNeedLabelTracking,
  workflowMayCallMcpTools,
  recordedCallLabels,
  type DataDestinationRow,
  type DestinationRef,
  type McpToolOpenWorldOverride
} from "@ai-orchestrator/shared";
import type {
  DataLabels,
  ApprovalDecisionValue,
  ApprovalHandoffState,
  ChatMessage,
  ConnectorDocument,
  LLMProviderConfig,
  MCPServerConfig,
  McpHiddenTool,
  McpToolAnnotations,
  McpToolAttribution,
  McpToolClassificationOverride,
  McpToolPolicyRule,
  McpToolPolicySubject,
  McpToolPolicyDecisionRecord,
  McpToolPolicyTrace,
  McpToolProgressEvent,
  McpElicitationTraceEntry,
  McpListChangedEvent,
  McpSamplingTraceEntry,
  NodeActivity,
  NodeActivityEvent,
  NodeExecutionResult,
  SecretReference,
  Workflow,
  WorkflowExecutionResult,
  WorkflowExecutionState,
  WorkflowNode
} from "@ai-orchestrator/shared";
import { isAuxiliaryEdge, isExecutionEdge, DescendantCache } from "./graph";
import {
  type RetrieverAdapter,
  InMemoryRetrieverAdapter,
  TokenEmbeddingAdapter,
  OpenAIEmbeddingAdapter,
  AzureOpenAIEmbeddingAdapter,
  CohereEmbeddingAdapter,
  MistralEmbeddingAdapter,
  GoogleVertexEmbeddingAdapter,
  HuggingFaceEmbeddingAdapter,
  InMemoryVectorStoreAdapter,
  PineconeVectorStoreAdapter,
  PGVectorStoreAdapter,
  AzureAiSearchVectorStoreAdapter,
  QdrantVectorStoreAdapter,
  ChromaVectorStoreAdapter,
  WeaviateVectorStoreAdapter,
  RedisVectorStoreAdapter,
  KnowledgeBaseVectorStoreAdapter,
  CohereRerankAdapter,
  JinaRerankAdapter,
  VoyageRerankAdapter,
  type RerankAdapter,
  type EmbeddingRegistry,
  type VectorStoreRegistry,
  type KnowledgeBaseStore,
  type RagFetch
} from "./rag-adapters";
import {
  extractCitationsFromText,
  DEFAULT_CITATION_INSTRUCTIONS
} from "./citations";
import { renderChart } from "./chart";
import { browseUrl, type WebBrowseOptions } from "./web-browse";
import {
  DEFAULT_OUTBOUND_GUARD,
  assertOutboundUrlAllowed,
  guardedFetch,
  playwrightOutboundGuard,
  playwrightWebSocketGuard,
  OutboundUrlBlockedError,
  type EgressUrlJudge,
  type OutboundGuardConfig
} from "./outbound-url-guard";
import { bindCheckedRenderings, renderTemplate, tryParseJson } from "./template";
import {
  createMcpElicitationHandler,
  createMcpSamplingHandler,
  readMcpResource,
  readServerPromptBinding,
  resolveServerPrompt,
  serverPromptTrace,
  type McpElicitationHandlerOptions,
  type McpPolicyEvaluator,
  type McpSamplingCheck,
  type McpSamplingHandler,
  type ServerPromptTrace
} from "./mcp-client-features";
import { executePhase2Node } from "./phase2-dispatch";
import { executeTier1Node, TIER1_NODE_TYPES } from "./connectors/tier1-dispatch";
import { executeTier2Node, TIER2_NODE_TYPES } from "./connectors/tier2-dispatch";
import { executePhase35TriggerNode, PHASE35_TRIGGER_NODE_TYPES } from "./connectors/triggers-dispatch";
import { NO_CODE_SANDBOX_PLAN, codeNodesDisabledError, runJavaScriptCode, runPythonCode, type CodeSandboxPlan } from "./code-sandbox";
import { runWithSandboxOwner } from "./quickjs-sandbox";
import { sortWorkflowNodes, validateWorkflowGraph, computeDepthLevels } from "./validation";
import { ErrorCategory, WorkflowError, remediationForCategory } from "@ai-orchestrator/shared";
import { AgentGuardInterrupt, isAgentGuardInterrupt } from "@ai-orchestrator/agent-runtime";
import { ApprovalHandoffSignal, approvedHandoffKeysFromState, isApprovalHandoffSignal, withoutReservedKeys, type ApprovalHandoffRequest } from "./approval-handoff";
import { executeGuardNodeStep } from "./guard-node";
import {
  approvalGateOutcome,
  approvalGatePause,
  writeToolApprovalKey,
  writeToolApprovalPause,
  writeToolPolicyKeyPrefix,
  writeToolGateSkips,
  WriteToolCallLedger,
  type WriteToolCallSession
} from "./approval-gate-node";
import type { ReplayNodeHook, ReplayNodeStub } from "./replay-plan";
import {
  checkEgressRequest,
  checkOutbound,
  describeEgressRequest,
  describeMcpPromptRequest,
  describeMcpToolRequest,
  httpDestinationRef,
  isEgressNodeType,
  outboundProfilesFor,
  secretReferencesIn,
  urlContent,
  type EgressOverride,
  type EgressRequest,
  type OutboundCheckInput
} from "./destination-guard";
import {
  builtInGuardProfile,
  createAgentGuardSession,
  GuardBlockedError,
  guardMayUseLabels,
  isGuardBlockedError,
  issuedSurrogatesOf,
  resolveGuardRun,
  type AgentGuardSession,
  type GuardEvalScope,
  type GuardRuntimeDependencies
} from "./guard-runtime";
import { profileUsesLabels, type GuardDictionary } from "@ai-orchestrator/guard-sdk";
import {
  createLabelScanner,
  currentLabelScope,
  labelsOf,
  runInLabelScope,
  RunLabelState,
  unionLabels,
  type NodeLabelScope
} from "./data-labels";

const MAX_SUB_WORKFLOW_DEPTH = 10;
/** Phase 16 — label segments of an agent node: its user prompt's reads, and reads made while its loop runs. */
const AGENT_USER_PROMPT_SEGMENT = "user_prompt";
const AGENT_RUN_SEGMENT = "agent_run";

export interface WorkflowExecutionDependencies {
  providerRegistry: ProviderRegistry;
  mcpRegistry: MCPRegistry;
  connectorRegistry: ConnectorRegistry;
  embeddingRegistry?: EmbeddingRegistry;
  vectorStoreRegistry?: VectorStoreRegistry;
  /**
   * Phase 9.1 — built-in persistent vector store. When supplied,
   * `rag_retrieve` accepts `vectorStoreId: "knowledge-base"` and reads /
   * writes through this store.
   */
  knowledgeBaseStore?: KnowledgeBaseStore;
  agentRuntime: AgentRuntimeAdapter;
  memoryStore?: AgentSessionMemoryStore;
  toolDataStore?: AgentSessionToolDataStore;
  sessionArtifactStore?: AgentSessionArtifactStore;
  /**
   * Loads an Execute Workflow node's target. Returns undefined for an
   * unknown id; may throw to refuse one the run is not allowed to call.
   */
  loadWorkflow?: (workflowId: string) => Workflow | undefined | Promise<Workflow | undefined>;
  /**
   * Dependencies scoped to a sub-workflow (its own project's secrets,
   * knowledge bases, session stores, guard and sub-workflow loader). Applied
   * on top of the parent's dependencies when an Execute Workflow node runs.
   */
  scopeSubWorkflow?: (workflow: Workflow) => Partial<WorkflowExecutionDependencies>;
  resolveSecret: (secretRef?: SecretReference) => Promise<string | undefined>;
  /**
   * Phase 10.1 — resolves an MCP server registry entry to the adapter,
   * connection and secretRef to use. Throws when the entry is missing or
   * blocked (for example by an unaccepted breaking tool schema change).
   */
  resolveRegisteredMcpServer?: (registryServerId: string) => MCPServerConfig | Promise<MCPServerConfig>;
  /**
   * Phase 10.2 — MCP tool policy rules and admin read-only overrides. Loaded
   * when an agent or MCP Tool node starts. Without it only the workflow's
   * "no write tools" setting is enforced.
   */
  loadMcpToolPolicy?: () => McpToolPolicySnapshot | Promise<McpToolPolicySnapshot>;
  /**
   * Phase 12.1 — L2M Guard: stored profiles, the run's bindings, the token
   * vault and where verdicts are recorded. Without it guard nodes evaluate
   * the built-in default profile and agents run unguarded.
   */
  guard?: GuardRuntimeDependencies;
  persistPausedExecution?: (input: {
    executionId: string;
    workflowId: string;
    workflowName: string;
    triggerType?: string;
    triggeredBy?: string;
    waitingNodeId: string;
    approvalMessage: string;
    timeoutMinutes: number;
    startedAt: string;
    state: WorkflowExecutionState;
  }) => Promise<void>;
  onNodeStart?: (event: {
    nodeId: string;
    nodeType: string;
    startedAt: string;
    input?: unknown;
  }) => Promise<void> | void;
  onNodeComplete?: (event: {
    nodeId: string;
    nodeType: string;
    status: NodeExecutionResult["status"];
    completedAt: string;
    durationMs: number;
    input?: unknown;
    output?: unknown;
    error?: string;
    errorCategory?: string;
    errorRemediation?: string;
    retryable?: boolean;
  }) => Promise<void> | void;
  onLLMDelta?: (event: {
    nodeId: string;
    delta: string;
    index: number;
  }) => Promise<void> | void;
  binaryDataStore?: import("@ai-orchestrator/shared").BinaryDataStore;
  onNodeProgress?: (event: {
    nodeId: string;
    processed: number;
    total: number;
  }) => Promise<void> | void;
  /**
   * Phase 10.5 — `notifications/progress` from an upstream MCP server while
   * an MCP Tool node or an agent's tool call runs.
   */
  onMcpProgress?: (event: McpToolProgressEvent & { nodeId: string }) => Promise<void> | void;
  /**
   * Step-by-step node activity (resolved inputs, model calls, retries, agent
   * steps, tool calls). Called fire-and-forget: a slow or throwing consumer
   * never delays or fails a node.
   */
  onNodeActivity?: (event: NodeActivityEvent) => Promise<void> | void;
  /** Set by the engine for the duration of a run; not part of the caller contract. */
  activityRecorder?: NodeActivityRecorder;
  /** Phase 10.5 — a `list_changed` notification from an upstream server; the API re-probes the registry entry. */
  onMcpListChanged?: (event: McpListChangedEvent & { nodeId: string }) => Promise<void> | void;
  /**
   * Phase 10.5 — answers `elicitation/create` for the run: the API pauses the
   * run, asks a person and resumes with their answer (or declines for
   * unattended runs). Without it every request is declined.
   */
  onMcpElicitation?: McpElicitationHandlerOptions["onElicitation"];
  /** Phase 10.5 — size limit for `resources/read` in MCP Tool nodes (bytes). */
  mcpResourceMaxBytes?: number;
  /** Where code nodes run (container, isolated in-process realm, or disabled). Default: in-process. */
  codeSandbox?: CodeSandboxPlan;
  /**
   * Policy for URLs that user-supplied nodes fetch (HTTP Request, Web Browse,
   * Chart data.url, HTML-render PDF). When unset, the default policy applies
   * (block file/data/other schemes, metadata and link-local; allow private
   * and localhost). A custom DNS resolver can be injected for tests.
   */
  outboundGuard?: OutboundGuardConfig;
  outboundDnsResolver?: (hostname: string) => Promise<string[]>;
  abortSignal?: AbortSignal;
  logger?: (message: string, metadata?: unknown) => void;
  /**
   * Phase 15.1 — replay: asked before any node handler runs (top level, loop
   * bodies, workers, sub-workflows). A returned stub replaces the handler,
   * which is then never called; null lets the node run. See replay-plan.ts.
   */
  replayNodeHook?: ReplayNodeHook;
  triggerErrorWorkflow?: (input: {
    errorWorkflowId: string;
    sourceWorkflowId: string;
    sourceWorkflowName: string;
    executionId?: string;
    error: string;
    errorStack?: string;
    timestamp: string;
  }) => Promise<void>;
}

export interface McpToolPolicySnapshot {
  rules: McpToolPolicyRule[];
  classifications: McpToolClassificationOverride[];
  /** Phase 12.2 — admin open-world overrides of registry tools; absent = none. */
  openWorldOverrides?: McpToolOpenWorldOverride[];
  /**
   * Phase 12.2 — the admin's destination rows, for the tier of a tool's server (with the built-in rows). Absent: the
   * built-in rows alone classify servers.
   */
  destinations?: DataDestinationRow[];
}

export interface AgentSessionArtifactRecord {
  namespace: string;
  sessionId: string;
  artifactKey: string;
  value: unknown;
  /** Phase 16 — labels of what the saving run put in the artifact; absent or null when it did not track labels. */
  labels?: DataLabels | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSessionArtifactStore {
  saveArtifact(input: {
    namespace: string;
    sessionId: string;
    artifactKey: string;
    value: unknown;
    /** Phase 16 — given only while the run tracks labels; replaces the stored labels with the value. */
    labels?: DataLabels;
  }): Promise<AgentSessionArtifactRecord>;
  loadArtifact(input: {
    namespace: string;
    sessionId: string;
    artifactKey: string;
  }): Promise<AgentSessionArtifactRecord | null>;
}

export interface ExecuteWorkflowRequest {
  workflow: Workflow;
  startNodeId?: string;
  runMode?: "workflow" | "single_node";
  usePinnedData?: boolean;
  pinnedData?: Record<string, unknown>;
  nodeOutputs?: Record<string, unknown>;
  input?: Record<string, unknown>;
  webhookPayload?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  systemPrompt?: string;
  userPrompt?: string;
  sessionId?: string;
  executionId?: string;
  customData?: Record<string, unknown>;
  triggerType?: string;
  triggeredBy?: string;
  /**
   * Phase 10.2 — whose role the MCP tool policy is evaluated with. Absent →
   * the lowest role, `viewer`. A resumed run keeps the subject it paused with.
   */
  toolPolicySubject?: McpToolPolicySubject;
  callStack?: string[];
  /**
   * Phase 16 — labels of the run's input: where it came from (the trigger,
   * the editor, the scheduler) and, for a sub-workflow, the Execute Workflow
   * node's input labels. Absent: the trigger type decides.
   */
  inputLabels?: DataLabels;
  resumeState?: WorkflowExecutionState;
  approvalDecision?: ApprovalDecisionInput;
  executionTimeoutMs?: number;
  maxConcurrency?: number;
}

/**
 * A decision about a paused run. Phase 11.2 — `timeout` is the timeout
 * sweeper's decision: Approval Gates route it by their timeout outcome,
 * every other pause handles it as a rejection. `edits` are the approver's
 * already validated values for an Approval Gate's editable fields.
 */
export interface ApprovalDecisionInput {
  decision: ApprovalDecisionValue;
  actedBy?: string;
  reason?: string;
  edits?: Record<string, unknown>;
  editedFields?: string[];
  requestId?: string;
}

export interface ResumeWorkflowRequest {
  executionId: string;
  state: WorkflowExecutionState;
  decision: ApprovalDecisionValue;
  actedBy?: string;
  reason?: string;
  edits?: Record<string, unknown>;
  editedFields?: string[];
  requestId?: string;
}

/** Phase 11.2 — a resumed decision for the node that paused, consumed when that node runs again. */
interface NodeResumeDecision extends ApprovalDecisionInput {
  nodeId: string;
  decidedAt: string;
  handoff: Extract<ApprovalHandoffState, { kind: "gate" | "sub_workflow" }>;
}

interface NodeRuntimeContext {
  globals: Record<string, unknown>;
  merged: Record<string, unknown>;
  parentOutputs: Record<string, unknown>;
  /** Outputs of every node that has completed so far, keyed by node id (exposed to templates as `results`). */
  nodeOutputs?: Map<string, unknown>;
  workflow: Workflow;
  nodeById: Map<string, WorkflowNode>;
  attachmentsBySource: Map<string, Map<AgentAttachmentHandle, string[]>>;
  callStack: string[];
  /** Phase 10.2 — subject the MCP tool policy is evaluated with for this run. */
  toolPolicySubject?: McpToolPolicySubject;
  /** Phase 12.1 — guard approvals granted by a resumed `rerun` hand-off (never from globals). */
  approvedHandoffKeys?: ReadonlySet<string>;
  /** Phase 11.2 — set only for the node a resumed run paused at (an Approval Gate or a sync Execute Workflow). */
  resumeDecision?: NodeResumeDecision;
  /** Phase 11.2 — the run's approved write-tool calls and their stored results. */
  writeToolCalls?: WriteToolCallLedger;
  /** Phase 11.2 — the agent execution a worker runs inside, so the worker shares its replay position. */
  writeToolSession?: WriteToolCallSession;
  /** Phase 16 — this node's data labels while it runs (what it read, what it adds). */
  labelScope?: NodeLabelScope;
  recordAttachmentUsage?: (usage: {
    attachedNodeId: string;
    usedByNodeId: string;
    handle: AgentAttachmentHandle;
    input?: unknown;
    output?: unknown;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
  }) => Promise<void> | void;
}

type AgentAttachmentHandle = "chat_model" | "memory" | "tool" | "worker" | "guard" | "protection";
const AGENT_ATTACHMENT_HANDLES = new Set<AgentAttachmentHandle>(["chat_model", "memory", "tool", "worker", "guard", "protection"]);
const ALL_MCP_TOOLS_SENTINEL = "__all__";
/** Marks the per-node `results` snapshot so passthrough nodes can tell it apart from user data. */
const DERIVED_RESULTS_MARKER = Symbol("derivedResults");

function nowIso() {
  return new Date().toISOString();
}

class WorkflowCanceledError extends Error {
  constructor(message = "Workflow execution canceled.") {
    super(message);
    this.name = "WorkflowCanceledError";
  }
}

/**
 * Closes the MCP sessions an execution context opened. `onAbort` closes them
 * early when the run is canceled or times out, so a child process does not
 * wait for the node to unwind; `close` runs from `finally` and also catches
 * anything opened after an early close. Failures are logged, never thrown, so
 * cleanup cannot replace the node's own result or error.
 */
function createMcpSessionReleaser(
  registry: MCPRegistry,
  mcpContext: MCPExecutionContext,
  nodeId: string
): { onAbort: () => void; close: () => Promise<void> } {
  const close = async () => {
    try {
      const errors = await registry.closeSessions(mcpContext);
      for (const error of errors) {
        console.warn(`[MCP] Failed to close sessions for node '${nodeId}': ${error.message}`);
      }
    } catch (error) {
      console.warn(
        `[MCP] Failed to close sessions for node '${nodeId}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
  return {
    onAbort: () => {
      void close();
    },
    close
  };
}

/** Progress events kept on a node's output (`_mcpProgress`), newest last. */
const MAX_NODE_PROGRESS_EVENTS = 20;

interface NodeMcpContextOptions {
  /** The attached chat model, for sampling; absent for direct MCP Tool nodes. */
  provider?: LLMProviderConfig;
  /** Servers the node talks to, for their sampling settings. */
  serverConfigs: MCPServerConfig[];
  evaluatePolicy?: McpPolicyEvaluator;
  /** Phase 16 — destination rules on sampling requests. */
  checkSampling?: McpSamplingCheck;
}

interface NodeMcpContext {
  context: MCPExecutionContext;
  progress: McpToolProgressEvent[];
  elicitations: McpElicitationTraceEntry[];
  sampling: McpSamplingTraceEntry[];
  samplingHandler: McpSamplingHandler;
}

/** Per-run store of node activity: numbers entries per node and keeps the last NODE_ACTIVITY_LIMIT. */
export interface NodeActivityRecorder {
  emit(nodeId: string, activity: NodeActivity, workerNodeId?: string): void;
  snapshot(nodeId: string): NodeActivityEvent[];
}

const NOOP_ACTIVITY_RECORDER: NodeActivityRecorder = { emit: () => undefined, snapshot: () => [] };

function createNodeActivityRecorder(onNodeActivity?: WorkflowExecutionDependencies["onNodeActivity"]): NodeActivityRecorder {
  const buffers = new Map<string, NodeActivityEvent[]>();
  const sequence = new Map<string, number>();
  return {
    emit(nodeId, activity, workerNodeId) {
      const seq = sequence.get(nodeId) ?? 0;
      sequence.set(nodeId, seq + 1);
      const event = { ...activity, nodeId, at: nowIso(), seq, ...(workerNodeId ? { workerNodeId } : {}) } as NodeActivityEvent;
      const buffer = buffers.get(nodeId) ?? [];
      buffer.push(event);
      if (buffer.length > NODE_ACTIVITY_LIMIT) buffer.shift();
      buffers.set(nodeId, buffer);
      if (!onNodeActivity) return;
      try {
        const pending = onNodeActivity(event);
        if (pending && typeof (pending as Promise<void>).catch === "function") {
          (pending as Promise<void>).catch(() => undefined);
        }
      } catch {
        // Activity reporting never fails a node.
      }
    },
    snapshot: (nodeId) => [...(buffers.get(nodeId) ?? [])]
  };
}

/** Records activity for a node. Never throws. */
function emitNodeActivity(
  dependencies: Pick<WorkflowExecutionDependencies, "activityRecorder">,
  nodeId: string,
  activity: NodeActivity,
  workerNodeId?: string
): void {
  try {
    dependencies.activityRecorder?.emit(nodeId, activity, workerNodeId);
  } catch {
    // Activity reporting never fails a node.
  }
}

/** Routes a worker's activity to its parent Supervisor, tagged with the worker's node id. */
function workerActivityRecorder(parent: NodeActivityRecorder | undefined, parentNodeId: string): NodeActivityRecorder | undefined {
  if (!parent) return undefined;
  return {
    emit: (nodeId, activity, workerNodeId) => parent.emit(parentNodeId, activity, workerNodeId ?? nodeId),
    snapshot: () => []
  };
}

function previewForActivity(value: string): string {
  return value.length > NODE_ACTIVITY_PREVIEW_CHARS ? `${value.slice(0, NODE_ACTIVITY_PREVIEW_CHARS)}...` : value;
}

/** A URL with userinfo, query string and fragment removed, so it is safe to show. */
// Webhook-style URLs carry their credential in the path (Slack, Discord, Telegram /bot<token>/).
// Long or colon-bearing segments are masked; short, readable route segments stay.
function maskPathTokens(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => (segment.length >= 20 || segment.includes(":") ? "•••" : segment))
    .join("/");
}

function urlForActivity(raw: string): string {
  try {
    const parsed = new URL(raw);
    return previewForActivity(`${parsed.protocol}//${parsed.host}${maskPathTokens(parsed.pathname)}`);
  } catch {
    const stripped = raw.replace(/[?#].*$/s, "").replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
    const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(stripped)?.[0] ?? "";
    return previewForActivity(origin + maskPathTokens(stripped.slice(origin.length)));
  }
}

/**
 * Phase 10.5 — the MCP execution context for one agent or MCP Tool node: the
 * run's abort signal (adapters cancel in-flight calls with it), a progress
 * sink that forwards to `onMcpProgress` and keeps the last events for the
 * node's output, the `list_changed` relay, and the elicitation and sampling
 * handlers whose outcomes the node output keeps.
 */
function createNodeMcpContext(
  dependencies: Pick<
    WorkflowExecutionDependencies,
    "resolveSecret" | "abortSignal" | "onMcpProgress" | "onMcpListChanged" | "onMcpElicitation" | "providerRegistry"
  >,
  nodeId: string,
  options: NodeMcpContextOptions
): NodeMcpContext {
  const progress: McpToolProgressEvent[] = [];
  const elicitations: McpElicitationTraceEntry[] = [];
  const sampling: McpSamplingTraceEntry[] = [];
  const samplingHandler = createMcpSamplingHandler({
    providerRegistry: dependencies.providerRegistry,
    resolveSecret: dependencies.resolveSecret,
    ...(options.provider ? { provider: options.provider } : {}),
    serverConfigs: options.serverConfigs,
    ...(options.evaluatePolicy ? { evaluatePolicy: options.evaluatePolicy } : {}),
    ...(options.checkSampling ? { checkModelCall: options.checkSampling } : {}),
    trace: sampling,
    ...(dependencies.abortSignal ? { signal: dependencies.abortSignal } : {}),
    nodeId
  });
  const context: MCPExecutionContext = {
    resolveSecret: dependencies.resolveSecret,
    runtimeState: new Map<string, unknown>(),
    ...(dependencies.abortSignal ? { signal: dependencies.abortSignal } : {}),
    onProgress: (event) => {
      progress.push(event);
      if (progress.length > MAX_NODE_PROGRESS_EVENTS) progress.shift();
      if (!dependencies.onMcpProgress) return;
      try {
        const pending = dependencies.onMcpProgress({ ...event, nodeId });
        if (pending && typeof (pending as Promise<void>).catch === "function") {
          (pending as Promise<void>).catch(() => undefined);
        }
      } catch {
        // Progress reporting never fails the tool call.
      }
    },
    onListChanged: (event) => {
      if (!dependencies.onMcpListChanged) return;
      try {
        const pending = dependencies.onMcpListChanged({ ...event, nodeId });
        if (pending && typeof (pending as Promise<void>).catch === "function") {
          (pending as Promise<void>).catch(() => undefined);
        }
      } catch {
        // A re-probe that cannot be scheduled never fails the tool call.
      }
    },
    onElicitation: createMcpElicitationHandler({
      nodeId,
      ...(dependencies.onMcpElicitation ? { onElicitation: dependencies.onMcpElicitation } : {}),
      trace: elicitations
    }),
    onSampling: samplingHandler.onSampling
  };
  return { context, progress, elicitations, sampling, samplingHandler };
}

/** Node-output fields for what the MCP client did during the node (`_mcp*`), only when there is something to show. */
function mcpTraceFields(nodeContext: Pick<NodeMcpContext, "progress" | "elicitations" | "sampling">): Record<string, unknown> {
  return {
    ...(nodeContext.progress.length > 0 ? { _mcpProgress: nodeContext.progress } : {}),
    ...(nodeContext.elicitations.length > 0 ? { _mcpElicitations: nodeContext.elicitations } : {}),
    ...(nodeContext.sampling.length > 0 ? { _mcpSampling: nodeContext.sampling } : {})
  };
}

function getAbortMessage(signal?: AbortSignal): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.trim()) {
    return reason.trim();
  }
  return "Workflow execution canceled.";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new WorkflowCanceledError(getAbortMessage(signal));
  }
}

function isCancellationError(error: unknown): boolean {
  return error instanceof WorkflowCanceledError;
}

interface ExecutionTimeoutFields {
  error: string;
  errorCategory: string;
  errorRemediation: string;
  retryable: boolean;
}

/**
 * True when the run was aborted by its execution timeout rather than by a
 * person: the caller aborts with a WORKFLOW_TIMEOUT `WorkflowError` as the
 * reason. Checked by category, not `instanceof`, so a reason built from
 * another copy of the shared package still counts.
 */
function isExecutionTimeoutAbort(signal?: AbortSignal): boolean {
  if (!signal?.aborted) {
    return false;
  }
  const reason: unknown = signal.reason;
  return Boolean(
    reason && typeof reason === "object" && (reason as { category?: unknown }).category === ErrorCategory.WORKFLOW_TIMEOUT
  );
}

/** Error fields for a node or run that ran out of execution time. */
function executionTimeoutFields(timeoutMs: number, reason?: unknown, message?: string): ExecutionTimeoutFields {
  const record = reason && typeof reason === "object" ? (reason as Record<string, unknown>) : {};
  const metadata = record.metadata && typeof record.metadata === "object" ? (record.metadata as Record<string, unknown>) : {};
  const limitMs = typeof metadata.timeoutMs === "number" ? metadata.timeoutMs : timeoutMs;
  const reasonMessage = typeof record.message === "string" && record.message.trim() ? record.message.trim() : undefined;
  return {
    error: message ?? reasonMessage ?? `Workflow exceeded the ${limitMs}ms execution timeout.`,
    errorCategory: ErrorCategory.WORKFLOW_TIMEOUT,
    errorRemediation:
      typeof record.remediation === "string" && record.remediation.trim()
        ? record.remediation
        : remediationForCategory(ErrorCategory.WORKFLOW_TIMEOUT, { timeoutMs: limitMs }),
    retryable: false
  };
}

/**
 * The provider call context for a node: the run's abort signal, so Stop and
 * the execution timeout interrupt in-flight model calls, and a retry hook
 * that reports backoff waits to the run logger.
 */
function providerCallContext(
  dependencies: Pick<WorkflowExecutionDependencies, "resolveSecret" | "abortSignal" | "logger" | "activityRecorder">,
  nodeId?: string
): ProviderExecutionContext {
  const logger = dependencies.logger;
  return {
    resolveSecret: dependencies.resolveSecret,
    ...(dependencies.abortSignal ? { signal: dependencies.abortSignal } : {}),
    // Phase 15.3 — the model tape keys calls by the node that made them.
    ...(nodeId ? { callSite: { nodeId } } : {}),
    ...(logger || (nodeId && dependencies.activityRecorder)
      ? {
          onRetry: (info: ResilientFetchRetryInfo) => {
            logger?.("LLM provider request is being retried", { ...(nodeId ? { nodeId } : {}), ...info });
            if (nodeId) {
              emitNodeActivity(dependencies, nodeId, {
                kind: "retry",
                scope: "provider",
                attempt: info.attempt,
                maxAttempts: info.maxRetries + 1,
                delayMs: info.delayMs,
                reason:
                  info.reason === "status"
                    ? `HTTP ${info.status ?? "error"} from ${info.provider}`
                    : info.reason === "timeout"
                      ? `${info.provider} request timed out`
                      : `${info.provider} network error`
              });
            }
          }
        }
      : {})
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function hasOwnRecordKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

const ERROR_CATEGORIES = new Set<string>(Object.values(ErrorCategory));

// LLMProviderError (provider-sdk) tags HTTP failures as auth / quota / transient.
function categorizedProviderError(
  error: unknown
): { category: ErrorCategory; provider?: string; retryable?: boolean } | undefined {
  if (!(error instanceof Error) || error.name !== "LLMProviderError") return undefined;
  const fields = error as Error & { category?: unknown; provider?: unknown; retryable?: unknown };
  if (typeof fields.category !== "string" || !ERROR_CATEGORIES.has(fields.category)) return undefined;
  return {
    category: fields.category as ErrorCategory,
    provider: typeof fields.provider === "string" ? fields.provider : undefined,
    retryable: typeof fields.retryable === "boolean" ? fields.retryable : undefined
  };
}

function isWebhookTrigger(globals: Record<string, unknown>): boolean {
  const triggerType = typeof globals.trigger_type === "string" ? globals.trigger_type.trim().toLowerCase() : "";
  return triggerType.startsWith("webhook");
}

// A prompt sent with the run (chat message, API call) wins over the text saved
// on a Text Input / User Prompt node; the saved text is the default for runs
// that send none, such as the editor's Run button.
function resolveRuntimeUserPrompt(globals: Record<string, unknown>): string | undefined {
  const prompt = globals.user_prompt;
  return typeof prompt === "string" && prompt.trim() ? prompt : undefined;
}

function resolveWebhookPrompt(globals: Record<string, unknown>): string | undefined {
  const webhook = toRecord(globals.webhook);
  const candidates = [webhook.user_prompt, webhook.prompt, webhook.message, webhook.text, globals.user_prompt];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}

/** The name of the synthetic tool a Supervisor gets for an attached worker node. */
export function workerDelegateToolName(workerName: string): string {
  return `delegate_to_${workerName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function getAttachmentHandle(sourceHandle: string | undefined): AgentAttachmentHandle | undefined {
  if (!sourceHandle || !AGENT_ATTACHMENT_HANDLES.has(sourceHandle as AgentAttachmentHandle)) {
    return undefined;
  }

  return sourceHandle as AgentAttachmentHandle;
}

const CHAT_MODEL_NODE_TYPES = new Set([
  "llm_call",
  "openai_chat_model",
  "anthropic_chat_model",
  "ollama_chat_model",
  "openai_compatible_chat_model",
  "ai_gateway_chat_model",
  "azure_openai_chat_model",
  "google_gemini_chat_model"
]);

function isChatModelNodeType(type: string): boolean {
  return CHAT_MODEL_NODE_TYPES.has(type);
}

function normalizeProvider(value: unknown): LLMProviderConfig | undefined {
  const provider = toRecord(value);
  if (typeof provider.providerId !== "string" || typeof provider.model !== "string") {
    return undefined;
  }

  return provider as unknown as LLMProviderConfig;
}

function normalizeSecretRef(value: unknown): SecretReference | undefined {
  const record = toRecord(value);
  const secretId = typeof record.secretId === "string" ? record.secretId.trim() : "";
  return secretId ? { secretId } : undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildSimpleChatProvider(
  providerId: string,
  config: Record<string, unknown>,
  fallbackModel: string,
  options: { requiresBaseUrl?: boolean; defaultBaseUrl?: string; allowSecret?: boolean } = {}
): LLMProviderConfig | undefined {
  const model = typeof config.model === "string" && config.model.trim() ? config.model.trim() : fallbackModel;
  const baseUrl = typeof config.baseUrl === "string" && config.baseUrl.trim() ? config.baseUrl.trim() : options.defaultBaseUrl;
  if (!model || (options.requiresBaseUrl && !baseUrl)) {
    return undefined;
  }

  return {
    providerId,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(options.allowSecret === false ? {} : { secretRef: normalizeSecretRef(config.secretRef) }),
    temperature: normalizeOptionalNumber(config.temperature),
    maxTokens:
      typeof config.maxTokens === "number" && Number.isFinite(config.maxTokens)
        ? Math.max(1, Math.floor(config.maxTokens))
        : undefined
  };
}

/** Env var each hosted chat model node falls back to when it has no API key secret. */
const CHAT_MODEL_API_KEY_ENV: Record<string, { env: string; label: string }> = {
  openai_chat_model: { env: "OPENAI_API_KEY", label: "OpenAI" },
  anthropic_chat_model: { env: "ANTHROPIC_API_KEY", label: "Anthropic" },
  google_gemini_chat_model: { env: "GEMINI_API_KEY", label: "Gemini" }
};

/**
 * Fails with a message that names the chat model node when it has no API key
 * secret and the server has no env var to fall back to. The provider adapters
 * only know the provider, not which node on the canvas holds its config.
 */
export function assertChatModelCredentials(
  node: WorkflowNode,
  provider: LLMProviderConfig,
  env: Record<string, string | undefined> = process.env
): void {
  const requirement = CHAT_MODEL_API_KEY_ENV[node.type];
  if (!requirement || provider.secretRef?.secretId) {
    return;
  }
  if (typeof env[requirement.env] === "string" && env[requirement.env]!.trim()) {
    return;
  }
  const nodeName = node.name?.trim() || node.type;
  throw new Error(
    `Chat model node "${nodeName}" (${node.id}) has no ${requirement.label} API key. ` +
      `Open the node, select an API key secret, and save the node and the workflow ` +
      `(or set ${requirement.env} on the API server).`
  );
}

function buildProviderFromModelNode(node: WorkflowNode): LLMProviderConfig | undefined {
  const nodeConfig = toRecord(node.config);
  if (node.type === "llm_call") {
    return normalizeProvider(nodeConfig.provider);
  }

  if (node.type === "openai_chat_model") {
    return buildSimpleChatProvider("openai", nodeConfig, "gpt-4o-mini");
  }

  if (node.type === "anthropic_chat_model") {
    return buildSimpleChatProvider("anthropic", nodeConfig, "claude-sonnet-5-5");
  }

  if (node.type === "ollama_chat_model") {
    return buildSimpleChatProvider("ollama", nodeConfig, "llama3.1", {
      defaultBaseUrl: "http://localhost:11434/v1",
      allowSecret: false
    });
  }

  if (node.type === "openai_compatible_chat_model") {
    return buildSimpleChatProvider("openai_compatible", nodeConfig, "", { requiresBaseUrl: true });
  }

  if (node.type === "ai_gateway_chat_model") {
    const rawProvider = typeof nodeConfig.apiProvider === "string" ? nodeConfig.apiProvider.trim() : "openai_compatible";
    const providerId =
      rawProvider === "openai" || rawProvider === "anthropic" || rawProvider === "openai_compatible"
        ? rawProvider
        : "openai_compatible";
    const provider = buildSimpleChatProvider(providerId, nodeConfig, "", { requiresBaseUrl: true });
    if (!provider) {
      return undefined;
    }

    return {
      ...provider,
      extra: {
        ...(provider.extra ?? {}),
        ...(nodeConfig.enableThinking === true ? { enableThinking: true } : {}),
        ...(typeof nodeConfig.thinkingTokens === "number" && Number.isFinite(nodeConfig.thinkingTokens)
          ? { thinkingTokens: Math.max(1, Math.floor(nodeConfig.thinkingTokens)) }
          : {})
      }
    };
  }

  if (node.type === "azure_openai_chat_model") {
    const endpoint = typeof nodeConfig.endpoint === "string" ? nodeConfig.endpoint.trim() : "";
    const deployment = typeof nodeConfig.deployment === "string" ? nodeConfig.deployment.trim() : "";
    if (!endpoint || !deployment) {
      return undefined;
    }

    const apiVersion = typeof nodeConfig.apiVersion === "string" && nodeConfig.apiVersion.trim()
      ? nodeConfig.apiVersion.trim()
      : "2024-10-21";

    return {
      providerId: "azure_openai",
      model: deployment,
      baseUrl: endpoint,
      secretRef: normalizeSecretRef(nodeConfig.secretRef),
      temperature:
        typeof nodeConfig.temperature === "number" && Number.isFinite(nodeConfig.temperature)
          ? nodeConfig.temperature
          : undefined,
      maxTokens:
        typeof nodeConfig.maxTokens === "number" && Number.isFinite(nodeConfig.maxTokens)
          ? Math.max(1, Math.floor(nodeConfig.maxTokens))
          : undefined,
      extra: {
        deployment,
        apiVersion
      }
    };
  }

  if (node.type === "google_gemini_chat_model") {
    const model = typeof nodeConfig.model === "string" ? nodeConfig.model.trim() : "gemini-2.5-flash";
    if (!model) {
      return undefined;
    }

    return {
      providerId: "gemini",
      model,
      secretRef: normalizeSecretRef(nodeConfig.secretRef),
      temperature:
        typeof nodeConfig.temperature === "number" && Number.isFinite(nodeConfig.temperature)
          ? nodeConfig.temperature
          : undefined,
      maxTokens:
        typeof nodeConfig.maxTokens === "number" && Number.isFinite(nodeConfig.maxTokens)
          ? Math.max(1, Math.floor(nodeConfig.maxTokens))
          : undefined
    };
  }

  return undefined;
}

function buildServerConfigKey(server: MCPServerConfig): string {
  const connection = JSON.stringify(server.connection ?? {});
  const secretId = server.secretRef?.secretId ?? "";
  return `${server.registryServerId ?? ""}::${server.serverId}::${secretId}::${connection}`;
}

function buildMcpToolAttribution(
  resolved: Array<{ exposedName: string; originalName: string; serverId: string; registryServerId?: string }>
): Record<string, McpToolAttribution> {
  const out: Record<string, McpToolAttribution> = {};
  for (const entry of resolved) {
    out[entry.exposedName] = {
      adapterId: entry.serverId,
      toolName: entry.originalName,
      ...(entry.registryServerId ? { registryServerId: entry.registryServerId } : {})
    };
  }
  return out;
}

const FALLBACK_POLICY_SUBJECT: McpToolPolicySubject = {
  role: "viewer",
  source: "fallback",
  fallbackReason: "no user or workflow owner was supplied for this run"
};

interface RunToolPolicy {
  trace: McpToolPolicyTrace;
  accessCheck: McpToolAccessCheck;
  /** Without `call`: the tool as discovery sees it. With `call`: one call, with its arguments and labels. */
  evaluate: (tool: McpToolAccessSubjectTool, call?: McpToolAccessCall) => McpToolAccessDecision;
  /** Phase 10.5 — some rule has an annotation condition, so a tool's hints must be known to decide. */
  needsAnnotations: boolean;
  /** Phase 12.4 — some rule has conditions, so a call's arguments must be readable to decide. */
  needsArguments: boolean;
  /**
   * Phase 12.4 — records one call's decision on the trace (`decisions`) when
   * some rule, enforced or shadow, matched it; returns the record.
   */
  record: (
    tool: McpToolAccessSubjectTool,
    decision: McpToolAccessDecision,
    /** Phase 12.2 — `labels`: what the call was decided with; `tracked`: the run tracks labels (data classes are kept). */
    extra?: { toolCallId?: string; approval?: "pending" | "approved"; labels?: DataLabels | null; tracked?: boolean }
  ) => McpToolPolicyDecisionRecord | undefined;
}

/** Phase 12.4 — what one agent tool call needs before it runs (see planToolCall in the agent handler). */
type ToolCallPlan =
  | { kind: "allow"; decision?: McpToolAccessDecision; policyTool?: McpToolAccessSubjectTool }
  | { kind: "deny"; message: string; hidden: McpHiddenTool; decision?: McpToolAccessDecision; policyTool?: McpToolAccessSubjectTool }
  | {
      kind: "approval";
      /** One request for everything that asks; its key is `policyKey` when a policy rule asks, else `callKey`. */
      pause: ApprovalHandoffRequest;
      /** The call's own key (node, server, tool, arguments). */
      callKey: string;
      /** Set when a require_approval rule asks: the call's key bound to that rule (admins decide). */
      policyKey?: string;
      /** The workflow's write-tool gate asks too. */
      gateAsks: boolean;
      decision?: McpToolAccessDecision;
      policyTool?: McpToolAccessSubjectTool;
    };

/** Phase 12.4 — the subset of a run's data labels a policy condition reads. */
function policyLabels(labels: DataLabels | null | undefined): McpToolAccessCall["dataLabels"] {
  return labels ? { provenance: labels.provenance, dataClasses: labels.dataClasses } : undefined;
}

/**
 * Phase 10.2 — the tool policy for one agent or MCP Tool node. Returns
 * undefined when nothing can be enforced: no policy store and the workflow
 * allows write tools.
 */
async function buildRunToolPolicy(
  context: Pick<NodeRuntimeContext, "workflow" | "toolPolicySubject">,
  dependencies: Pick<WorkflowExecutionDependencies, "loadMcpToolPolicy">
): Promise<RunToolPolicy | undefined> {
  const noWriteTools = context.workflow.settings?.noWriteTools === true;
  if (!dependencies.loadMcpToolPolicy && !noWriteTools) {
    return undefined;
  }
  const snapshot = dependencies.loadMcpToolPolicy
    ? await dependencies.loadMcpToolPolicy()
    : { rules: [], classifications: [] };
  const subject = context.toolPolicySubject ?? FALLBACK_POLICY_SUBJECT;
  const projectId = context.workflow.projectId;
  const overrides = new Map<string, boolean>();
  for (const entry of snapshot.classifications) {
    overrides.set(`${entry.registryServerId}::${entry.toolName}`, entry.readOnly);
  }
  // Phase 12.2 — open world is resolved only when some rule reads it, and only for tool calls.
  const readsOpenWorld = policyReadsOpenWorld(snapshot.rules);
  const openWorldOverrides = new Map<string, boolean>();
  for (const entry of snapshot.openWorldOverrides ?? []) {
    openWorldOverrides.set(`${entry.registryServerId}::${entry.toolName}`, entry.openWorld);
  }
  const destinationRows = snapshot.destinations ?? [];
  const openWorldOf = (tool: McpToolAccessSubjectTool) => {
    if (!readsOpenWorld || (tool.kind ?? "tool") !== "tool") return {};
    return openWorldRequestFields(
      resolveToolOpenWorld({
        override: tool.registryServerId ? openWorldOverrides.get(`${tool.registryServerId}::${tool.toolName}`) : undefined,
        destination: serverOpenWorldDestination(tool, destinationRows),
        annotations: tool.annotations
      })
    );
  };
  const trace: McpToolPolicyTrace = {
    subject,
    ...(projectId ? { projectId } : {}),
    noWriteTools,
    hidden: []
  };
  const evaluate = (tool: McpToolAccessSubjectTool, call?: McpToolAccessCall) =>
    evaluateMcpToolAccess({
      rules: snapshot.rules,
      projectId: projectId ?? null,
      role: subject.role,
      // Phase 12.4 — workflow and gateway-client principals, and the call itself.
      workflowId: context.workflow.id,
      clientId: subject.clientId ?? null,
      ...(call ? { arguments: call.arguments, dataLabels: call.dataLabels ?? null } : {}),
      adapterId: tool.adapterId,
      registryServerId: tool.registryServerId,
      toolName: tool.toolName,
      ...(tool.kind ? { kind: tool.kind } : {}),
      annotations: tool.annotations,
      // Inline servers have no registry entry, so only annotations classify them.
      manualReadOnly: tool.registryServerId ? overrides.get(`${tool.registryServerId}::${tool.toolName}`) : undefined,
      ...openWorldOf(tool),
      noWriteTools,
      ...(tool.serverLabel ? { serverLabel: tool.serverLabel } : {})
    });
  const accessCheck: McpToolAccessCheck = (tool, call) => {
    const decision = evaluate(tool, call);
    if (decision.allowed) {
      return { allowed: true };
    }
    return {
      allowed: false,
      message: decision.message ?? `MCP tool '${tool.toolName}' is blocked.`,
      hidden: {
        tool: tool.toolName,
        server: tool.adapterId,
        ...(tool.registryServerId ? { registryServerId: tool.registryServerId } : {}),
        reason: decision.reason ?? "policy",
        ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
        ...(decision.ruleName ? { ruleName: decision.ruleName } : {})
      }
    };
  };
  const record: RunToolPolicy["record"] = (tool, decision, extra = {}) => {
    // Phase 12.2 — the labels the call was decided with, for every call (simulation reads them from telemetry).
    const labels = recordedCallLabels(extra.labels, extra.tracked === true);
    if (labels) {
      trace.callLabels = [
        ...(trace.callLabels ?? []),
        {
          tool: tool.toolName,
          server: tool.adapterId,
          ...(tool.registryServerId ? { registryServerId: tool.registryServerId } : {}),
          ...(extra.toolCallId ? { toolCallId: extra.toolCallId } : {}),
          labels
        }
      ];
    }
    const entry = policyDecisionRecord(decision.policy, extra.approval, labels);
    if (!entry) return undefined;
    trace.decisions = [
      ...(trace.decisions ?? []),
      {
        ...entry,
        tool: tool.toolName,
        server: tool.adapterId,
        ...(tool.registryServerId ? { registryServerId: tool.registryServerId } : {}),
        ...(extra.toolCallId ? { toolCallId: extra.toolCallId } : {})
      }
    ];
    return entry;
  };
  return {
    trace,
    accessCheck,
    evaluate,
    needsAnnotations: policyNeedsAnnotations(snapshot.rules),
    needsArguments: policyNeedsArguments(snapshot.rules),
    record
  };
}

/**
 * Phase 12.4 — when some rule reads arguments, a direct MCP Tool call's
 * arguments template must render to a JSON object: otherwise the node would
 * quietly send `{}` and the rules would judge that instead of what the
 * template meant. `rendered` is the rendered template (undefined when the
 * arguments came from elsewhere).
 */
function assertPolicyReadableArguments(node: WorkflowNode, toolPolicy: RunToolPolicy, rendered: string | undefined): void {
  if (!toolPolicy.needsArguments || rendered === undefined) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered);
  } catch {
    parsed = undefined;
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return;
  const got = Array.isArray(parsed) ? "an array" : parsed === undefined ? "text that is not JSON" : parsed === null ? "null" : `a ${typeof parsed}`;
  throw WorkflowError.nodeConfig(
    `MCP Tool node '${node.name || node.id}' must send its arguments as a JSON object (got ${got}); tool policy rules read the call's arguments by name.`
  );
}

/** Phase 12.4 — the approval request of a direct MCP Tool call a require_approval rule matched. */
function directMcpApprovalPause(
  node: WorkflowNode,
  context: Pick<NodeRuntimeContext, "workflow">,
  serverConfig: MCPServerConfig,
  toolName: string,
  args: unknown,
  policy: NonNullable<McpToolAccessDecision["approval"]>
): ApprovalHandoffRequest {
  const serverKey = serverConfig.registryServerId ?? serverConfig.serverId;
  return writeToolApprovalPause({
    settings: context.workflow.settings?.writeToolApproval ?? { enabled: false },
    nodeId: node.id,
    nodeName: node.name || node.id,
    serverKey,
    serverLabel: serverConfig.label ?? serverKey,
    toolName,
    args,
    classificationSource: "tool_policy",
    policy,
    writeGate: false,
    caller: "node"
  });
}

/**
 * Phase 12.4 — the tool policy decides a direct MCP Tool call before the
 * guard's destination check (which runs ahead of every node handler): a deny
 * fails the node and an unapproved require_approval pauses it, before any
 * guard verdict. The handler checks again with the arguments it sends and
 * records the decision. Rules that need the tool's annotations are left to
 * the handler, which reads them from the server.
 */
async function directMcpPolicyPreCheck(
  node: WorkflowNode,
  config: Record<string, unknown>,
  context: NodeRuntimeContext,
  dependencies: WorkflowExecutionDependencies
): Promise<void> {
  if (node.type !== "mcp_tool" || !dependencies.guard || !dependencies.loadMcpToolPolicy || dependencies.replayNodeHook) return;
  if (config.operation === "read_resource") return;
  const toolName = String(config.toolName ?? "");
  if (!toolName.trim() || toolName.trim() === ALL_MCP_TOOLS_SENTINEL) return;
  const toolPolicy = await buildRunToolPolicy(context, dependencies);
  if (!toolPolicy || toolPolicy.needsAnnotations) return;
  const argsTemplate = typeof config.argsTemplate === "string" ? config.argsTemplate : "{}";
  const renderedArgs = renderTemplate(argsTemplate, buildTemplateData(context, config));
  assertPolicyReadableArguments(node, toolPolicy, renderedArgs);
  const args = tryParseJson(renderedArgs);
  let serverConfig: MCPServerConfig;
  try {
    serverConfig = await applyRegisteredMcpServer(
      { serverId: String(config.serverId ?? ""), registryServerId: readRegistryServerId(config), connection: toRecord(config.connection) },
      dependencies,
      context.toolPolicySubject
    );
  } catch {
    // The handler reports a server it cannot resolve.
    return;
  }
  const policyTool: McpToolAccessSubjectTool = {
    adapterId: serverConfig.serverId,
    ...(serverConfig.registryServerId ? { registryServerId: serverConfig.registryServerId } : {}),
    ...(serverConfig.label ? { serverLabel: serverConfig.label } : {}),
    ...(serverConfig.connection ? { connection: serverConfig.connection } : {}),
    toolName
  };
  const decision = toolPolicy.evaluate(policyTool, { arguments: toRecord(args), dataLabels: policyLabels(context.labelScope?.inputLabels()) });
  if (!decision.allowed && decision.reason === "policy") {
    throw mcpToolBlockedError(decision.message ?? `MCP tool '${toolName}' is blocked.`, {
      tool: toolName,
      server: serverConfig.serverId,
      ...(serverConfig.registryServerId ? { registryServerId: serverConfig.registryServerId } : {}),
      reason: "policy",
      ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
      ...(decision.ruleName ? { ruleName: decision.ruleName } : {})
    });
  }
  if (decision.allowed && decision.approval) {
    const pause = directMcpApprovalPause(node, context, serverConfig, toolName, args, decision.approval);
    const approvalKey = pause.handoff.kind === "rerun" ? pause.handoff.approvalKey : "";
    if (!context.writeToolCalls?.session().ready(approvalKey)) throw new ApprovalHandoffSignal(pause);
  }
}

const MCP_TOOL_BLOCKED_REMEDIATION =
  "An MCP tool policy or this workflow's \"No write tools\" setting blocks this tool. An admin can review the rules on the MCP servers page (Policies), or pick a different tool.";

function mcpToolBlockedError(message: string, hidden: McpHiddenTool): WorkflowError {
  return new WorkflowError(message, ErrorCategory.NODE_CONFIG, false, { mcpToolPolicy: hidden }, MCP_TOOL_BLOCKED_REMEDIATION);
}

/** Phase 11.2 — an Approval Gate rejection is a person's decision: retrying cannot change it. */
function isApprovalDecisionError(error: unknown): boolean {
  return error instanceof WorkflowError && Boolean(error.metadata?.approval);
}

/** Policy blocks are decisions, not failures: retrying cannot change them. */
function isMcpToolPolicyBlock(error: unknown): boolean {
  return error instanceof WorkflowError && Boolean(error.metadata?.mcpToolPolicy);
}

/** Annotations for one tool, read with tools/list; only needed when a direct node must classify it. */
async function discoverToolAnnotations(
  serverConfig: MCPServerConfig,
  toolName: string,
  registry: MCPRegistry,
  mcpContext: MCPExecutionContext
): Promise<McpToolAnnotations | undefined> {
  try {
    const tools = await registry.get(serverConfig.serverId).discoverTools(serverConfig, mcpContext);
    return tools.find((tool) => tool.name === toolName)?.annotations;
  } catch {
    // Unreadable annotations leave the tool unclassified, which counts as a write tool.
    return undefined;
  }
}

function readRegistryServerId(config: Record<string, unknown>): string | undefined {
  const value = typeof config.registryServerId === "string" ? config.registryServerId.trim() : "";
  return value || undefined;
}

/**
 * Swap a registry reference for the registered server's adapter, connection
 * and secretRef. Phase 10.7 — a delegated server also gets the user whose
 * own token the calls use, decided from the run subject (the person who
 * started the run; for unattended runs the workflow owner, only when the
 * server allows it).
 */
async function applyRegisteredMcpServer(
  server: MCPServerConfig,
  dependencies: Pick<WorkflowExecutionDependencies, "resolveRegisteredMcpServer">,
  subject?: McpToolPolicySubject
): Promise<MCPServerConfig> {
  if (!server.registryServerId) {
    // Runtime safety settings come only from the registry; an inline node config cannot carry them.
    const { sandbox: _sandbox, limits: _limits, credentialMode: _mode, delegatedFallback: _fallback, delegatedUser: _user, ...inline } = server;
    return inline;
  }
  if (!dependencies.resolveRegisteredMcpServer) {
    throw WorkflowError.nodeConfig(
      `MCP server '${server.registryServerId}' comes from the server registry, which is not available in this runtime.`
    );
  }
  const registered = await dependencies.resolveRegisteredMcpServer(server.registryServerId);
  const { delegatedUser: _ignored, ...resolved } = registered;
  return withDelegatedUser(
    {
      ...resolved,
      registryServerId: server.registryServerId,
      allowedTools: server.allowedTools,
      manualTools: server.manualTools
    },
    subject
  );
}

function mergeMCPServerConfigs(base: MCPServerConfig[], additional: MCPServerConfig[]): MCPServerConfig[] {
  const grouped = new Map<
    string,
    {
      server: MCPServerConfig;
      allowedTools?: Set<string>;
    }
  >();

  for (const entry of [...base, ...additional]) {
    const key = buildServerConfigKey(entry);
    const current = grouped.get(key);

    if (!current) {
      grouped.set(key, {
        server: {
          ...entry,
          allowedTools: entry.allowedTools ? [...entry.allowedTools] : undefined
        },
        allowedTools: entry.allowedTools ? new Set(entry.allowedTools) : undefined
      });
      continue;
    }

    if (!current.allowedTools || !entry.allowedTools) {
      current.allowedTools = undefined;
      current.server.allowedTools = undefined;
      continue;
    }

    for (const tool of entry.allowedTools) {
      current.allowedTools.add(tool);
    }
    current.server.allowedTools = [...current.allowedTools];
  }

  return [...grouped.values()].map((entry) => entry.server);
}

function mergeParentOutputs(parentOutputs: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  for (const [nodeId, output] of Object.entries(parentOutputs)) {
    merged[nodeId] = output;
    if (output && typeof output === "object" && !Array.isArray(output)) {
      Object.assign(merged, output as Record<string, unknown>);
    }
  }

  return merged;
}

function looksLikeJson(input: string): boolean {
  const trimmed = input.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function parseTemplateValue(rendered: string): unknown {
  const trimmed = rendered.trim();
  if (!trimmed) {
    return rendered;
  }
  if (!looksLikeJson(trimmed)) {
    return rendered;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return rendered;
  }
}

function isErrorLikeOutput(output: unknown): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }
  const asRecord = output as Record<string, unknown>;
  return typeof asRecord.error === "string" && asRecord.error.trim().length > 0;
}

/**
 * Phase 9.4 — dot-path resolver for `extract_citations` config. "answer"
 * returns templateData.answer; "result.documents" returns
 * templateData.result.documents. Returns undefined when any segment is
 * missing rather than throwing — the citation node handles it gracefully.
 */
/** Phase 16 — a configured path into a node's template data (a chart's data, citations' answer): recorded as a read. */
function resolveDottedPathRead(templateData: Record<string, unknown>, path: string): unknown {
  currentLabelScope()?.readPath(path);
  return resolveDottedPath(templateData, path);
}

function resolveDottedPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (!part) continue;
    if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function normalizeDocuments(raw: unknown): ConnectorDocument[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item, index) => {
      if (typeof item === "string") {
        return {
          id: `doc-${index + 1}`,
          text: item
        };
      }

      if (item && typeof item === "object") {
        const asRecord = item as Record<string, unknown>;
        const text =
          typeof asRecord.text === "string"
            ? asRecord.text
            : typeof asRecord.content === "string"
              ? asRecord.content
              : JSON.stringify(asRecord);

        return {
          id: typeof asRecord.id === "string" ? asRecord.id : `doc-${index + 1}`,
          text,
          metadata: toRecord(asRecord.metadata)
        };
      }

      return {
        id: `doc-${index + 1}`,
        text: String(item)
      };
    })
    .filter((document) => Boolean(document.text?.trim()));
}

function applyInputMapping(
  data: Record<string, unknown>,
  inputMapping: Record<string, string> | undefined
): Record<string, unknown> {
  if (!inputMapping || typeof inputMapping !== "object") {
    return data;
  }

  const remapped = { ...data };
  for (const [sourceKey, targetKey] of Object.entries(inputMapping)) {
    const src = String(sourceKey ?? "").trim();
    const tgt = String(targetKey ?? "").trim();
    if (!src || !tgt) {
      continue;
    }

    let value = remapped[src];
    currentLabelScope()?.readPath(src);
    if (value === undefined) {
      value = getValueByPath(remapped, src);
    }
    if (value !== undefined) {
      remapped[tgt] = value;
    }
  }
  return remapped;
}

function buildTemplateData(
  context: NodeRuntimeContext,
  nodeConfig?: Record<string, unknown>
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ...context.globals,
    ...context.merged,
    $workflow: {
      id: context.workflow.id,
      name: context.workflow.name
    },
    workflow: {
      id: context.workflow.id,
      name: context.workflow.name
    },
    $execution: {
      id: typeof context.globals.execution_id === "string" ? context.globals.execution_id : "",
      customData: toRecord(context.globals.execution_custom_data)
    },
    execution: {
      id: typeof context.globals.execution_id === "string" ? context.globals.execution_id : "",
      customData: toRecord(context.globals.execution_custom_data)
    },
    vars: toRecord(context.globals.vars),
    parent_outputs: context.parentOutputs
  };

  // `results.<nodeId>.<key>` addresses any completed node, not just direct parents.
  // It is always rebuilt here so a node that spreads its input (for example a code
  // node returning `{ ...input }`) cannot hand a stale copy to later nodes.
  if (context.nodeOutputs) {
    const snapshot = serializeNodeOutputs(context.nodeOutputs);
    Object.defineProperty(snapshot, DERIVED_RESULTS_MARKER, { value: true, enumerable: false });
    base.results = snapshot;
  }

  const inputMapping = nodeConfig
    ? toRecord(nodeConfig.inputMapping) as Record<string, string>
    : undefined;
  const hasMapping = inputMapping && Object.keys(inputMapping).length > 0;

  return hasMapping ? applyInputMapping(base, inputMapping) : base;
}

function captureNodeInputSnapshot(
  globals: Record<string, unknown>,
  merged: Record<string, unknown>,
  parentOutputs: Record<string, unknown>
): unknown {
  return toJsonSafeValue({
    ...globals,
    ...merged,
    parent_outputs: parentOutputs
  });
}

function resolveSessionArtifactScope(
  config: Record<string, unknown>,
  templateData: Record<string, unknown>,
  workflow: Workflow,
  node: WorkflowNode
): { namespace: string; sessionId: string; artifactKey: string } {
  const namespaceTemplate =
    typeof config.namespace === "string" && config.namespace.trim()
      ? config.namespace
      : `${workflow.id}:${node.id}`;
  const sessionTemplate =
    typeof config.sessionIdTemplate === "string" && config.sessionIdTemplate.trim()
      ? config.sessionIdTemplate
      : "{{session_id}}";
  const artifactKeyTemplate =
    typeof config.artifactKey === "string" && config.artifactKey.trim()
      ? config.artifactKey
      : "latest";

  return {
    namespace: renderTemplate(namespaceTemplate, templateData).trim() || `${workflow.id}:${node.id}`,
    sessionId: renderTemplate(sessionTemplate, templateData).trim(),
    artifactKey: renderTemplate(artifactKeyTemplate, templateData).trim() || "latest"
  };
}

function resolveConfiguredValue(
  config: Record<string, unknown>,
  templateData: Record<string, unknown>
): unknown {
  const valueKey = typeof config.valueKey === "string" && config.valueKey.trim() ? config.valueKey.trim() : "";
  if (valueKey) {
    return getValueByPath(templateData, valueKey);
  }

  const valueTemplate = typeof config.valueTemplate === "string" ? config.valueTemplate : "";
  if (valueTemplate) {
    return parseTemplateValue(renderTemplate(valueTemplate, templateData));
  }

  return undefined;
}

function buildSessionArtifactValue(
  config: Record<string, unknown>,
  templateData: Record<string, unknown>
): unknown {
  const fields = Array.isArray(config.fields) ? config.fields.map((entry) => toRecord(entry)) : [];
  if (fields.length > 0) {
    const value: Record<string, unknown> = {};
    for (const field of fields) {
      const key = typeof field.key === "string" ? field.key.trim() : "";
      if (!key) {
        continue;
      }
      const resolved = resolveConfiguredValue(field, templateData);
      value[key] = resolved === undefined ? null : resolved;
    }
    return value;
  }

  const resolved = resolveConfiguredValue(config, templateData);
  return resolved === undefined ? templateData : resolved;
}

function normalizeLabel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeKeywordList(value: unknown, fallback: string[]): string[] {
  const raw = Array.isArray(value)
    ? value.map((item) => String(item))
    : typeof value === "string"
      ? value.split(/[\n,]+/)
      : fallback;

  return raw
    .map((item) => item.trim().toLowerCase())
    .filter((item, index, all) => item.length > 0 && all.indexOf(item) === index);
}

function valueToString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === undefined || value === null) {
    return fallback;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function resolveValueByConfiguredPath(
  config: Record<string, unknown>,
  pathKey: string,
  templateData: Record<string, unknown>,
  defaultPath = ""
): unknown {
  const configuredPath = typeof config[pathKey] === "string" ? config[pathKey].trim() : "";
  const path = configuredPath || defaultPath;
  return path ? getValueByPath(templateData, path) : undefined;
}

function resolveStringByConfiguredPath(
  config: Record<string, unknown>,
  pathKey: string,
  templateData: Record<string, unknown>,
  defaultPath = "",
  fallback = ""
): string {
  return valueToString(resolveValueByConfiguredPath(config, pathKey, templateData, defaultPath), fallback);
}

function normalizeChatIntent(value: unknown): "report" | "code" | "message" | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "report" || normalized === "pdf" || normalized === "dashboard") {
    return "report";
  }
  if (normalized === "code" || normalized === "script" || normalized === "python") {
    return "code";
  }
  if (normalized === "message" || normalized === "answer" || normalized === "chat") {
    return "message";
  }
  return undefined;
}

function hasSessionArtifactValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

function textMatchesKeyword(text: string, keywords: string[]): boolean {
  const normalized = text.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword));
}

function inferHelperChatIntent(
  message: string,
  reportKeywords: string[],
  codeKeywords: string[]
): { intent: "report" | "code" | "message"; source: string } {
  if (textMatchesKeyword(message, codeKeywords)) {
    return { intent: "code", source: "keyword" };
  }
  if (textMatchesKeyword(message, reportKeywords)) {
    return { intent: "report", source: "keyword" };
  }
  return { intent: "message", source: "default" };
}

function mimeTypeFromDataUrl(value: string): string {
  const match = /^data:([^;,]+)/i.exec(value.trim());
  return match ? match[1].toLowerCase() : "";
}

function normalizeHelperChatAttachment(raw: unknown): Record<string, unknown> | null {
  const record = toRecord(raw);
  if (!Object.keys(record).length) {
    return null;
  }

  const explicitDataUrl =
    typeof record.downloadUrl === "string" && record.downloadUrl.trim()
      ? record.downloadUrl.trim()
      : typeof record.dataUrl === "string" && record.dataUrl.trim()
        ? record.dataUrl.trim()
        : typeof record.url === "string" && record.url.trim()
          ? record.url.trim()
          : "";
  const mimeType =
    typeof record.mimeType === "string" && record.mimeType.trim()
      ? record.mimeType.trim()
      : mimeTypeFromDataUrl(explicitDataUrl) || "application/octet-stream";
  const downloadUrl =
    explicitDataUrl ||
    (typeof record.base64 === "string" && record.base64.trim()
      ? `data:${mimeType};base64,${record.base64.trim()}`
      : "");

  if (!downloadUrl) {
    return null;
  }

  const filename =
    typeof record.filename === "string" && record.filename.trim()
      ? record.filename.trim()
      : typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : mimeType === "application/pdf"
          ? "report.pdf"
          : "download";

  const attachment: Record<string, unknown> = {
    filename,
    mimeType,
    downloadUrl
  };
  if (typeof record.sizeBytes === "number" && Number.isFinite(record.sizeBytes)) {
    attachment.sizeBytes = record.sizeBytes;
  }
  return attachment;
}

function parsePathSegments(path: string): string[] {
  const input = String(path ?? "").trim();
  if (!input) {
    return [];
  }

  const segments: string[] = [];
  let current = "";
  let index = 0;

  while (index < input.length) {
    const char = input[index];

    if (char === ".") {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = "";
      index += 1;
      continue;
    }

    if (char === "[") {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = "";
      index += 1;

      let bracketContent = "";
      let quote: "'" | '"' | null = null;
      while (index < input.length) {
        const inner = input[index];
        if (!quote && (inner === "'" || inner === '"')) {
          quote = inner;
          index += 1;
          continue;
        }
        if (quote && inner === quote) {
          quote = null;
          index += 1;
          continue;
        }
        if (!quote && inner === "]") {
          break;
        }
        bracketContent += inner;
        index += 1;
      }

      const normalizedBracket = bracketContent.trim();
      if (normalizedBracket) {
        segments.push(normalizedBracket);
      }

      if (index < input.length && input[index] === "]") {
        index += 1;
      }
      continue;
    }

    current += char;
    index += 1;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
}

function normalizeLookupPath(path: string): string {
  const trimmed = String(path ?? "").trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
    return trimmed.slice(2, -2).trim();
  }

  return trimmed;
}

/** Phase 16 — a handler's direct read of one top-level template value, recorded like a `{{ key }}` path. */
function readData(templateData: Record<string, unknown>, key: string): unknown {
  currentLabelScope()?.readPath(key);
  return templateData[key];
}

/** Phase 16 — a handler uses the whole template data: every node in context and the run input. */
function readWholeData<T extends Record<string, unknown>>(templateData: T): T {
  currentLabelScope()?.readEverything();
  return templateData;
}

function getValueByPath(input: Record<string, unknown>, path: string): unknown {
  const trimmedPath = normalizeLookupPath(path);
  if (!trimmedPath) {
    return undefined;
  }
  // Phase 16 — a configured lookup into a node's template data is a read, like a {{ }} path.
  if (isDerivedResultsSnapshot(input.results)) {
    currentLabelScope()?.readPath(trimmedPath);
  }

  if (trimmedPath in input) {
    return input[trimmedPath];
  }

  const parts = parsePathSegments(trimmedPath);
  if (!parts.length) {
    return undefined;
  }

  let current: unknown = input;
  for (const part of parts) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) {
        return undefined;
      }
      const index = Number(part);
      current = current[index];
      continue;
    }

    if (!current || typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function branchPassthrough(templateData: Record<string, unknown>): Record<string, unknown> {
  const next = { ...templateData };
  delete next.parent_outputs;
  // The derived `results` snapshot is rebuilt for every node; copying it forward would nest snapshots.
  if (isDerivedResultsSnapshot(next.results)) {
    delete next.results;
  }
  return next;
}

function isDerivedResultsSnapshot(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && (value as Record<symbol, unknown>)[DERIVED_RESULTS_MARKER] === true;
}

function normalizePdfFilename(value: string): string {
  const fallback = "workflow-output.pdf";
  const trimmed = typeof value === "string" ? value.trim() : "";
  const base = trimmed || fallback;
  const sanitized = base
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const withDefault = sanitized || fallback;
  const withExtension = withDefault.toLowerCase().endsWith(".pdf") ? withDefault : `${withDefault}.pdf`;
  return withExtension.slice(0, 120);
}

function decodeBufferLikeText(value: unknown): string | null {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.type === "Buffer" && Array.isArray(record.data)) {
      const bytes = record.data.filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255) as number[];
      if (bytes.length === record.data.length) {
        return Buffer.from(bytes).toString("utf8");
      }
    }
  }

  return null;
}

function toPdfSourceText(value: unknown): string {
  const decodedBufferText = decodeBufferLikeText(value);
  if (decodedBufferText !== null) {
    return decodedBufferText;
  }

  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sanitizePdfAscii(value: string): string {
  const punctuationMap: Array<[RegExp, string]> = [
    [/[\u2018\u2019\u201A\u201B\u2032]/g, "'"],
    [/[\u201C\u201D\u201E\u201F\u2033]/g, "\""],
    [/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-"],
    [/\u2026/g, "..."],
    [/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " "],
    [/[\u2022\u2043\u00B7]/g, "*"],
    [/\u00D7/g, "x"],
    [/\u2192/g, "->"],
    [/\u2190/g, "<-"],
    [/\u2264/g, "<="],
    [/\u2265/g, ">="]
  ];

  let normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const [pattern, replacement] of punctuationMap) {
    normalized = normalized.replace(pattern, replacement);
  }

  return normalized.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?");
}

function escapePdfTextLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapPdfLines(text: string, maxLineLength = 92): string[] {
  const lines: string[] = [];
  const sourceLines = text.split("\n");

  for (const sourceLine of sourceLines) {
    let remaining = sourceLine;
    if (remaining.length === 0) {
      lines.push("");
      continue;
    }

    while (remaining.length > maxLineLength) {
      lines.push(remaining.slice(0, maxLineLength));
      remaining = remaining.slice(maxLineLength);
    }
    lines.push(remaining);
  }

  return lines.length ? lines : [""];
}

function createSimplePdfBuffer(text: string): Buffer {
  const normalized = sanitizePdfAscii(text);
  const wrappedLines = wrapPdfLines(normalized);
  const linesPerPage = 48;
  const pages: string[][] = [];

  for (let index = 0; index < wrappedLines.length; index += linesPerPage) {
    pages.push(wrappedLines.slice(index, index + linesPerPage));
  }
  if (!pages.length) {
    pages.push([""]);
  }

  const pageCount = pages.length;
  const firstPageObjectId = 3;
  const fontObjectId = firstPageObjectId + pageCount * 2;
  const objectBodies: string[] = new Array(fontObjectId);

  objectBodies[0] = "<< /Type /Catalog /Pages 2 0 R >>";

  const pageKids = pages
    .map((_, pageIndex) => `${firstPageObjectId + pageIndex * 2} 0 R`)
    .join(" ");
  objectBodies[1] = `<< /Type /Pages /Kids [ ${pageKids} ] /Count ${pageCount} >>`;

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageObjectId = firstPageObjectId + pageIndex * 2;
    const contentObjectId = pageObjectId + 1;
    const pageLines = pages[pageIndex] ?? [""];
    const streamLines = [
      "BT",
      "/F1 11 Tf",
      "50 760 Td",
      "14 TL"
    ];

    for (let lineIndex = 0; lineIndex < pageLines.length; lineIndex += 1) {
      const escaped = escapePdfTextLiteral(pageLines[lineIndex] ?? "");
      streamLines.push(`(${escaped}) Tj`);
      if (lineIndex < pageLines.length - 1) {
        streamLines.push("T*");
      }
    }
    streamLines.push("ET");

    const stream = streamLines.join("\n");
    const streamLength = Buffer.byteLength(stream, "ascii");

    objectBodies[pageObjectId - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`;
    objectBodies[contentObjectId - 1] =
      `<< /Length ${streamLength} >>\nstream\n${stream}\nendstream`;
  }

  objectBodies[fontObjectId - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let objectId = 1; objectId <= objectBodies.length; objectId += 1) {
    offsets[objectId] = Buffer.byteLength(pdf, "ascii");
    pdf += `${objectId} 0 obj\n${objectBodies[objectId - 1]}\nendobj\n`;
  }

  const startXref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objectBodies.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let objectId = 1; objectId <= objectBodies.length; objectId += 1) {
    const offset = String(offsets[objectId]).padStart(10, "0");
    pdf += `${offset} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objectBodies.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF`;

  return Buffer.from(pdf, "ascii");
}

type PdfPageFormat = "A4" | "Letter" | "Legal" | "A3" | "A5";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function looksLikeHtmlDocument(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return /<(html|body|head|div|section|article|table|img|svg|canvas|h1|h2|h3|p)\b/i.test(trimmed);
}

function wrapTextAsHtmlDocument(text: string): string {
  const escaped = escapeHtml(text);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: Arial, sans-serif; color: #111827; margin: 32px; }
      pre { white-space: pre-wrap; word-break: break-word; line-height: 1.5; font-size: 13px; }
    </style>
  </head>
  <body>
    <pre>${escaped}</pre>
  </body>
</html>`;
}

function stripJsonFence(value: string): string {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = stripJsonFence(value);
  if (!looksLikeJson(trimmed)) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function extractFinalHtmlFromStructuredOutput(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === undefined || value === null) {
    return null;
  }

  const decodedBufferText = decodeBufferLikeText(value);
  if (decodedBufferText !== null) {
    return extractFinalHtmlFromStructuredOutput(decodedBufferText, depth + 1);
  }

  if (typeof value === "string") {
    const parsed = parseJsonObject(value);
    return parsed ? extractFinalHtmlFromStructuredOutput(parsed, depth + 1) : null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const direct = record.final_html;
  if (typeof direct === "string" && direct.trim()) {
    return direct;
  }

  for (const key of ["parsed", "answer", "result", "output", "code_result"]) {
    const nested = record[key];
    const nestedHtml = extractFinalHtmlFromStructuredOutput(nested, depth + 1);
    if (nestedHtml) {
      return nestedHtml;
    }
  }

  return null;
}

function toPdfHtmlSource(value: unknown): string {
  const structuredHtml = extractFinalHtmlFromStructuredOutput(value);
  if (structuredHtml !== null) {
    return structuredHtml;
  }

  const text = toPdfSourceText(value);
  if (looksLikeHtmlDocument(text)) {
    return text;
  }
  return wrapTextAsHtmlDocument(text);
}

async function createHtmlPdfBuffer(input: {
  html: string;
  format: PdfPageFormat;
  printBackground: boolean;
  timeoutMs: number;
  outboundGuard: OutboundGuardConfig;
  resolver?: (hostname: string) => Promise<string[]>;
  /** Phase 16 — judges each URL the HTML loads against the destination rules. */
  judge?: EgressUrlJudge;
}): Promise<Buffer> {
  type PlaywrightModule = typeof import("playwright");
  let playwright: PlaywrightModule;
  try {
    playwright = (await import("playwright")) as PlaywrightModule;
  } catch {
    throw new Error(
      "HTML PDF rendering requires Playwright. Install dependencies and run `pnpm exec playwright install chromium`."
    );
  }

  const executablePath = process.env.PDF_CHROMIUM_EXECUTABLE_PATH?.trim();
  const browser = await playwright.chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage();
    // Every sub-resource the HTML loads (<img>, <script>, fetch) is checked; a
    // blocked one is aborted, so an injected URL cannot read internal hosts.
    await page.route("**/*", playwrightOutboundGuard(input.outboundGuard, input.resolver, input.judge));
    // WebSockets bypass page.route; they get the same check.
    await page.routeWebSocket(/.*/, playwrightWebSocketGuard(input.outboundGuard, input.resolver, input.judge));
    await page.setContent(input.html, {
      waitUntil: "networkidle",
      timeout: input.timeoutMs
    });
    const buffer = await page.pdf({
      format: input.format,
      printBackground: input.printBackground,
      preferCSSPageSize: true
    });
    return Buffer.from(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown renderer error";
    throw new Error(
      `HTML PDF render failed: ${message}. Ensure Chromium is installed (pnpm exec playwright install chromium).`
    );
  } finally {
    await browser.close();
  }
}

function extractJsonFromText(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

function extractBalancedJsonCandidates(text: string, maxCandidates = 40): string[] {
  const source = String(text ?? "");
  const openerToCloser: Record<string, string> = {
    "{": "}",
    "[": "]"
  };
  const closers = new Set(Object.values(openerToCloser));
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (let start = 0; start < source.length; start += 1) {
    const first = source[start];
    if (!(first in openerToCloser)) {
      continue;
    }

    const stack: string[] = [];
    let inString = false;
    let quote: "\"" | "'" | null = null;
    let escaped = false;

    for (let index = start; index < source.length; index += 1) {
      const char = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === quote) {
          inString = false;
          quote = null;
        }
        continue;
      }

      if (char === "\"" || char === "'") {
        inString = true;
        quote = char;
        continue;
      }

      const expectedCloser = openerToCloser[char];
      if (expectedCloser) {
        stack.push(expectedCloser);
        continue;
      }

      if (!stack.length) {
        continue;
      }

      if (char === stack[stack.length - 1]) {
        stack.pop();
        if (stack.length === 0) {
          const candidate = source.slice(start, index + 1).trim();
          if (candidate && !seen.has(candidate)) {
            seen.add(candidate);
            candidates.push(candidate);
            if (candidates.length >= maxCandidates) {
              return candidates;
            }
          }
          break;
        }
        continue;
      }

      if (closers.has(char)) {
        break;
      }
    }
  }

  return candidates;
}

function extractLikelyJsonFromText(text: string): string {
  const initial = extractJsonFromText(text);
  const trimmed = initial.trim();
  if (!trimmed) {
    return trimmed;
  }

  const startsAsJsonLike =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (startsAsJsonLike) {
    return trimmed;
  }

  const balanced = extractBalancedJsonCandidates(trimmed, 1)[0];
  return balanced ?? trimmed;
}

type OutputParserParsingMode = "strict" | "lenient" | "anything_goes";
type OutputParserParseStrategy =
  | "json_parse"
  | "double_encoded_json"
  | "balanced_json_extract"
  | "json_like_repair"
  | "yaml_key_value";

interface OutputParserParseAttempt {
  strategy: OutputParserParseStrategy;
  candidatePreview: string;
  ok: boolean;
  error?: string;
  warnings?: string[];
  confidence?: number;
}

interface OutputParserParseTrace {
  strictness: OutputParserParsingMode;
  strategy: OutputParserParseStrategy | "none";
  confidence: number;
  warnings: string[];
  candidateCount: number;
  attempts: OutputParserParseAttempt[];
}

type OutputParserParseOutcome =
  | {
      ok: true;
      parsed: unknown;
      trace: OutputParserParseTrace;
    }
  | {
      ok: false;
      error: string;
      trace: OutputParserParseTrace;
    };

function normalizeOutputParserParsingMode(value: unknown): OutputParserParsingMode {
  if (value === "lenient" || value === "anything_goes" || value === "strict") {
    return value;
  }
  return "strict";
}

function previewParserCandidate(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) {
    return normalized;
  }
  return `${normalized.slice(0, 180)}...`;
}

function addUniqueParserCandidate(target: string[], seen: Set<string>, candidate: string): void {
  const normalized = String(candidate ?? "").trim();
  if (!normalized || seen.has(normalized)) {
    return;
  }
  target.push(normalized);
  seen.add(normalized);
}

function buildJsonParserCandidates(text: string): string[] {
  const source = String(text ?? "");
  const trimmed = source.trim();
  if (!trimmed) {
    return [];
  }

  const candidates: string[] = [];
  const seen = new Set<string>();

  addUniqueParserCandidate(candidates, seen, trimmed);
  addUniqueParserCandidate(candidates, seen, extractJsonFromText(trimmed));
  const balancedFromSource = extractBalancedJsonCandidates(source, 40);
  for (const candidate of balancedFromSource) {
    addUniqueParserCandidate(candidates, seen, candidate);
  }
  const balancedFromLikely = extractBalancedJsonCandidates(extractLikelyJsonFromText(trimmed), 20);
  for (const candidate of balancedFromLikely) {
    addUniqueParserCandidate(candidates, seen, candidate);
  }

  return candidates.slice(0, 40);
}

function normalizeJsonLikeText(input: string): { text: string; warnings: string[] } {
  let current = String(input ?? "");
  const warnings: string[] = [];
  const apply = (next: string, warning: string) => {
    if (next !== current) {
      current = next;
      warnings.push(warning);
    }
  };

  apply(current.replace(/^\uFEFF/, ""), "removed_byte_order_mark");
  apply(current.replace(/[“”]/g, "\"").replace(/[‘’]/g, "'"), "normalized_smart_quotes");
  apply(current.replace(/\bNone\b/g, "null"), "normalized_none_literal");
  apply(current.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false"), "normalized_python_booleans");
  apply(current.replace(/([{,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'(?=\s*:)/g, "$1\"$2\""), "quoted_single_quoted_keys");
  apply(
    current.replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'(\s*[,}\]])/g, ": \"$1\"$2"),
    "converted_single_quoted_string_values"
  );
  apply(
    current.replace(/([\[,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'(\s*[,}\]])/g, "$1\"$2\"$3"),
    "converted_single_quoted_array_values"
  );
  apply(current.replace(/,\s*([}\]])/g, "$1"), "removed_trailing_commas");
  apply(current.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, "$1\"$2\"$3"), "quoted_unquoted_keys");

  return {
    text: current.trim(),
    warnings
  };
}

function parseYamlScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const lower = trimmed.toLowerCase();
  if (lower === "null" || lower === "none") {
    return null;
  }
  if (lower === "true") {
    return true;
  }
  if (lower === "false") {
    return false;
  }

  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  if (looksLikeJson(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function parseSimpleYamlObject(text: string): Record<string, unknown> | null {
  const source = String(text ?? "").trim();
  if (!source || source.startsWith("{") || source.startsWith("[")) {
    return null;
  }

  const lines = source
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#") && !line.startsWith("- "));

  if (!lines.length) {
    return null;
  }

  const output: Record<string, unknown> = {};
  let parsedPairs = 0;

  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const rawKey = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    if (!rawKey) {
      continue;
    }

    const key =
      (rawKey.startsWith("\"") && rawKey.endsWith("\"")) || (rawKey.startsWith("'") && rawKey.endsWith("'"))
        ? rawKey.slice(1, -1)
        : rawKey;
    output[key] = parseYamlScalar(rawValue);
    parsedPairs += 1;
  }

  return parsedPairs > 0 ? output : null;
}

function tryParseJsonCandidate(
  candidate: string
): { ok: true; parsed: unknown; strategy: "json_parse" | "double_encoded_json" } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(candidate);
    if (typeof parsed === "string") {
      const nestedCandidate = extractLikelyJsonFromText(parsed);
      if (looksLikeJson(nestedCandidate)) {
        try {
          const reparsed = JSON.parse(nestedCandidate);
          return {
            ok: true,
            parsed: reparsed,
            strategy: "double_encoded_json"
          };
        } catch {
          return {
            ok: true,
            parsed,
            strategy: "json_parse"
          };
        }
      }
    }

    return {
      ok: true,
      parsed,
      strategy: "json_parse"
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "parse error"
    };
  }
}

function parseWithOutputParserStrategies(text: string, strictness: OutputParserParsingMode): OutputParserParseOutcome {
  const candidates = buildJsonParserCandidates(text);
  const attempts: OutputParserParseAttempt[] = [];

  const success = (
    strategy: OutputParserParseStrategy,
    parsed: unknown,
    confidence: number,
    warnings: string[],
    candidate: string
  ): OutputParserParseOutcome => ({
    ok: true,
    parsed,
    trace: {
      strictness,
      strategy,
      confidence,
      warnings,
      candidateCount: candidates.length,
      attempts: [
        ...attempts,
        {
          strategy,
          candidatePreview: previewParserCandidate(candidate),
          ok: true,
          confidence,
          warnings: warnings.length ? warnings : undefined
        }
      ]
    }
  });

  const fail = (strategy: OutputParserParseStrategy, error: string, candidate: string, warnings: string[] = []) => {
    attempts.push({
      strategy,
      candidatePreview: previewParserCandidate(candidate),
      ok: false,
      error,
      warnings: warnings.length ? warnings : undefined
    });
  };

  if (!candidates.length) {
    return {
      ok: false,
      error: "No parseable content found in parser input.",
      trace: {
        strictness,
        strategy: "none",
        confidence: 0,
        warnings: [],
        candidateCount: 0,
        attempts
      }
    };
  }

  for (const candidate of candidates) {
    const parsed = tryParseJsonCandidate(candidate);
    if (parsed.ok) {
      if (parsed.strategy === "double_encoded_json") {
        return success("double_encoded_json", parsed.parsed, 0.95, [], candidate);
      }
      return success("json_parse", parsed.parsed, 1, [], candidate);
    }
    fail("json_parse", parsed.error, candidate);
  }

  for (const candidate of candidates) {
    const balancedCandidates = extractBalancedJsonCandidates(candidate, 20).filter((balanced) => balanced !== candidate);
    for (const balanced of balancedCandidates) {
      const parsed = tryParseJsonCandidate(balanced);
      if (parsed.ok) {
        if (parsed.strategy === "double_encoded_json") {
          return success("double_encoded_json", parsed.parsed, 0.9, ["extracted_balanced_json"], balanced);
        }
        return success("balanced_json_extract", parsed.parsed, 0.88, [], balanced);
      }
      fail("balanced_json_extract", parsed.error, balanced);
    }
  }

  if (strictness !== "strict") {
    for (const candidate of candidates) {
      const repaired = normalizeJsonLikeText(candidate);
      if (!repaired.text || repaired.text === candidate) {
        continue;
      }

      const parsed = tryParseJsonCandidate(repaired.text);
      if (parsed.ok) {
        if (parsed.strategy === "double_encoded_json") {
          return success("double_encoded_json", parsed.parsed, 0.8, repaired.warnings, repaired.text);
        }
        return success("json_like_repair", parsed.parsed, 0.72, repaired.warnings, repaired.text);
      }
      fail("json_like_repair", parsed.error, repaired.text, repaired.warnings);
    }
  }

  if (strictness === "anything_goes") {
    for (const candidate of candidates) {
      const parsed = parseSimpleYamlObject(candidate);
      if (parsed) {
        return success("yaml_key_value", parsed, 0.55, ["parsed_as_simple_key_value"], candidate);
      }
      fail("yaml_key_value", "did not match simple key-value block format", candidate);
    }
  }

  const failedAttempts = attempts.filter((attempt) => !attempt.ok);
  const summary = failedAttempts
    .slice(-3)
    .map((attempt) => `${attempt.strategy}: ${attempt.error}`)
    .join(" | ");
  const errorMessage = summary || "No parser strategy succeeded.";

  return {
    ok: false,
    error: errorMessage,
    trace: {
      strictness,
      strategy: "none",
      confidence: 0,
      warnings: [],
      candidateCount: candidates.length,
      attempts
    }
  };
}

function validateGuardrailChecks(text: string, checks: string[]): string[] {
  const failures: string[] = [];
  const normalizedText = String(text ?? "");

  for (const check of checks) {
    if (check === "no_pii") {
      const piiPatterns = [
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
        /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/,
        /\b\d{3}-\d{2}-\d{4}\b/,
        /\b(?:\d[ -]*?){13,16}\b/
      ];
      if (piiPatterns.some((pattern) => pattern.test(normalizedText))) {
        failures.push("no_pii");
      }
      continue;
    }

    if (check === "no_profanity") {
      const profanityTokens = ["damn", "shit", "fuck", "bitch", "bastard"];
      const lower = normalizedText.toLowerCase();
      if (profanityTokens.some((token) => lower.includes(token))) {
        failures.push("no_profanity");
      }
      continue;
    }

    if (check === "must_contain_json") {
      const candidate = extractJsonFromText(normalizedText);
      try {
        JSON.parse(candidate);
      } catch {
        failures.push("must_contain_json");
      }
    }

    if (check === "matches_schema") {
      // Check if content is valid JSON matching a provided schema structure
      try {
        JSON.parse(normalizedText);
      } catch {
        failures.push("matches_schema");
      }
    }
  }

  return failures;
}

/**
 * Phase 10.5 — when an LLM node binds a registry server prompt, fetch it and
 * use its text as the system or user prompt. The server session opened for
 * the fetch is closed before the model is called.
 */
async function applyServerPromptToLlmNode(input: {
  node: WorkflowNode;
  config: Record<string, unknown>;
  templateData: Record<string, unknown>;
  context: NodeRuntimeContext;
  dependencies: WorkflowExecutionDependencies;
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ systemPrompt: string; userPrompt: string; trace?: ServerPromptTrace }> {
  const binding = readServerPromptBinding(input.config.serverPrompt);
  if (!binding) return { systemPrompt: input.systemPrompt, userPrompt: input.userPrompt };
  const serverConfig = await applyRegisteredMcpServer(
    { serverId: "", registryServerId: binding.registryServerId, connection: {} },
    input.dependencies,
    input.context.toolPolicySubject
  );
  const toolPolicy = await buildRunToolPolicy(input.context, input.dependencies);
  const scoped = createNodeMcpContext(input.dependencies, input.node.id, {
    serverConfigs: [serverConfig],
    ...(toolPolicy ? { evaluatePolicy: toolPolicy.evaluate } : {}),
    // Phase 16 — a sampling request the server makes while the prompt is fetched is a model call.
    checkSampling: samplingGuardFor(input.node, input.context, input.dependencies)
  });
  const release = createMcpSessionReleaser(input.dependencies.mcpRegistry, scoped.context, input.node.id);
  try {
    const resolved = await resolveServerPrompt({
      binding,
      renderArgument: (template) => renderTemplate(template, input.templateData),
      serverConfig,
      registry: input.dependencies.mcpRegistry,
      context: scoped.context,
      ...(toolPolicy ? { evaluatePolicy: toolPolicy.evaluate } : {}),
      checkArguments: serverPromptArgumentCheck(input.node, input.context, input.dependencies, serverConfig, binding.name)
    });
    return {
      systemPrompt: resolved.target === "system" ? resolved.text : input.systemPrompt,
      userPrompt: resolved.target === "user" ? resolved.text : input.userPrompt,
      trace: serverPromptTrace(resolved)
    };
  } finally {
    await release.close();
  }
}

/**
 * Phase 16 — the arguments of a server prompt (`prompts/get`) are judged
 * against the MCP server before they are sent, like an MCP Tool node's
 * arguments: a block or an approval throws, a rewrite sends the rewritten
 * arguments. Unchanged when no profile has destination rules.
 */
function serverPromptArgumentCheck(
  node: WorkflowNode,
  context: NodeRuntimeContext,
  dependencies: WorkflowExecutionDependencies,
  serverConfig: MCPServerConfig,
  promptName: string
): (args: Record<string, string>) => Promise<Record<string, string>> {
  return async (args) => {
    const profiles = await outboundProfilesFor(dependencies.guard, "destinations");
    if (profiles.length === 0) return args;
    const request = describeMcpPromptRequest(node, serverConfig, promptName, args);
    if (!request) return args;
    const checked = await checkEgressRequest(request, {
      scope: guardScopeFor(node, context, dependencies, "node"),
      profiles,
      dataLabels: context.labelScope?.inputLabels() ?? labelsOf([]),
      ...(context.approvedHandoffKeys ? { approvals: context.approvedHandoffKeys } : {}),
      replay: Boolean(dependencies.replayNodeHook)
    });
    if (checked.declassified.length > 0) context.labelScope?.declassify(checked.declassified);
    return checked.override.kind === "mcp_args" ? (checked.override.args as Record<string, string>) : args;
  };
}

/**
 * Phase 16 — destination rules on a model call made outside the agent loop
 * (LLM nodes, the chains, Output Parser and Output Guardrail retries): the
 * system and user prompt, judged against the provider the call goes to. A
 * block throws; an approval pauses the run (re-run on approval); a rewrite
 * returns the rewritten prompts. Unchanged when no profile has rules.
 */
async function guardModelPrompt(
  node: WorkflowNode,
  context: NodeRuntimeContext,
  dependencies: WorkflowExecutionDependencies,
  provider: LLMProviderConfig,
  prompts: { systemPrompt: string; userPrompt: string },
  what = "model call"
): Promise<{ systemPrompt: string; userPrompt: string }> {
  const profiles = await outboundProfilesFor(dependencies.guard, "destinations");
  const ref = profiles.length > 0 ? providerDestinationRef(provider) : null;
  if (!ref) return prompts;
  const outcome = await checkOutbound({
    scope: guardScopeFor(node, context, dependencies, "node"),
    profiles,
    channel: "prompt",
    content: { system_prompt: prompts.systemPrompt, user_prompt: prompts.userPrompt },
    refs: [ref],
    dataLabels: context.labelScope?.inputLabels() ?? labelsOf([]),
    destinationOnly: true,
    ...(context.approvedHandoffKeys ? { approvals: context.approvedHandoffKeys } : {}),
    replay: Boolean(dependencies.replayNodeHook),
    what: `${node.name || node.type} (${what} to ${ref.host || ref.id || "an unknown host"})`,
    approvalTag: ref.host || ref.id || ""
  });
  if (!outcome.transformed) return prompts;
  const rewritten = toRecord(outcome.content);
  if (typeof rewritten.system_prompt !== "string" || typeof rewritten.user_prompt !== "string") {
    throw new GuardBlockedError(`${node.name || node.type} was blocked by the guard: the rewritten prompt could not be used`, outcome.result.verdicts);
  }
  context.labelScope?.declassify(outcome.declassified);
  return { systemPrompt: rewritten.system_prompt, userPrompt: rewritten.user_prompt };
}

/**
 * Phase 16 — destination rules on an MCP server's sampling request (a model
 * call the server asks for), judged against the provider that answers it.
 * A sampling request cannot wait for an approval or carry on after a block:
 * either refuses the request (the server gets an error, nothing is sent).
 */
function samplingGuardFor(
  node: WorkflowNode,
  context: NodeRuntimeContext,
  dependencies: WorkflowExecutionDependencies
): McpSamplingCheck {
  return async (provider, messages) => {
    const profiles = await outboundProfilesFor(dependencies.guard, "destinations");
    const ref = profiles.length > 0 ? providerDestinationRef(provider) : null;
    if (!ref) return messages;
    const outcome = await checkOutbound({
      scope: guardScopeFor(node, context, dependencies, "node"),
      profiles,
      channel: "prompt",
      content: messages.map((message) => message.content),
      refs: [ref],
      dataLabels: context.labelScope?.inputLabels() ?? labelsOf([]),
      destinationOnly: true,
      replay: true,
      what: `${node.name || node.type} (an MCP sampling request to ${ref.host || ref.id || "an unknown host"})`,
      approvalTag: ref.host || ref.id || ""
    });
    if (!outcome.transformed) return messages;
    const rewritten = Array.isArray(outcome.content) ? outcome.content : null;
    if (!rewritten || rewritten.length !== messages.length) {
      throw new GuardBlockedError("The sampling request was blocked by the guard: the rewritten messages could not be used", outcome.result.verdicts);
    }
    return messages.map((message, index) => ({ ...message, content: String(rewritten[index] ?? "") }));
  };
}

async function runLlmNode(input: {
  nodeId: string;
  provider: LLMProviderConfig;
  userPrompt: string;
  systemPrompt: string;
  dependencies: WorkflowExecutionDependencies;
  /** Phase 16 — the calling node, for destination rules on the model call. */
  outbound?: { node: WorkflowNode; context: NodeRuntimeContext };
}): Promise<Record<string, unknown>> {
  let { systemPrompt, userPrompt } = input;
  if (input.outbound) {
    // Phase 16 — destination rules: what this model call sends, judged against the provider it goes to.
    ({ systemPrompt, userPrompt } = await guardModelPrompt(input.outbound.node, input.outbound.context, input.dependencies, input.provider, { systemPrompt, userPrompt }));
  }
  const messages = [] as Array<{ role: "system" | "user"; content: string }>;
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: userPrompt });

  const providerAdapter = input.dependencies.providerRegistry.get(input.provider.providerId);
  const llmIdentity = { providerId: String(input.provider.providerId), model: input.provider.model };
  emitNodeActivity(input.dependencies, input.nodeId, {
    kind: "resolved_input",
    fields: {
      ...llmIdentity,
      systemPrompt: previewForActivity(systemPrompt),
      userPrompt: previewForActivity(userPrompt)
    }
  });
  emitNodeActivity(input.dependencies, input.nodeId, { kind: "llm_call", phase: "start", ...llmIdentity });
  const llmStartedMs = Date.now();
  try {
    const output = await runLlmCall(input, providerAdapter, messages);
    const latency = (output._telemetry as { latencyMs?: unknown } | undefined)?.latencyMs;
    emitNodeActivity(input.dependencies, input.nodeId, {
      kind: "llm_call",
      phase: "end",
      ...llmIdentity,
      latencyMs: typeof latency === "number" ? latency : Math.max(0, Date.now() - llmStartedMs)
    });
    return output;
  } catch (error) {
    emitNodeActivity(input.dependencies, input.nodeId, {
      kind: "llm_call",
      phase: "end",
      ...llmIdentity,
      latencyMs: Math.max(0, Date.now() - llmStartedMs),
      error: previewForActivity((error instanceof Error ? error.message : String(error)).slice(0, 200))
    });
    throw error;
  }
}

async function runLlmCall(
  input: {
    nodeId: string;
    provider: LLMProviderConfig;
    dependencies: WorkflowExecutionDependencies;
  },
  providerAdapter: ReturnType<ProviderRegistry["get"]>,
  messages: Array<{ role: "system" | "user"; content: string }>
): Promise<Record<string, unknown>> {
  if (input.dependencies.onLLMDelta && providerAdapter.generateStream) {
    let streamedText = "";
    const toolCallById = new Map<string, { id: string; name: string; argumentsText: string }>();
    let llmDeltaIndex = 0;

    throwIfAborted(input.dependencies.abortSignal);
    for await (const chunk of providerAdapter.generateStream(
      {
        provider: input.provider,
        messages
      },
      providerCallContext(input.dependencies, input.nodeId)
    )) {
      throwIfAborted(input.dependencies.abortSignal);
      if (chunk.type === "text_delta" && chunk.textDelta) {
        streamedText += chunk.textDelta;
        await input.dependencies.onLLMDelta({
          nodeId: input.nodeId,
          delta: chunk.textDelta,
          index: llmDeltaIndex
        });
        llmDeltaIndex += 1;
      } else if (chunk.type === "tool_call_delta") {
        const toolCallId = chunk.toolCallId ?? `toolcall_${toolCallById.size}`;
        const existing = toolCallById.get(toolCallId) ?? {
          id: toolCallId,
          name: chunk.name ?? `tool_${toolCallById.size}`,
          argumentsText: ""
        };
        if (typeof chunk.name === "string" && chunk.name) {
          existing.name = chunk.name;
        }
        if (typeof chunk.argumentsDelta === "string") {
          existing.argumentsText += chunk.argumentsDelta;
        }
        toolCallById.set(toolCallId, existing);
      }
    }

    const toolCalls = [...toolCallById.values()].map((entry) => {
      let parsedArguments: Record<string, unknown> = {};
      try {
        parsedArguments = JSON.parse(entry.argumentsText || "{}") as Record<string, unknown>;
      } catch {
        parsedArguments = {};
      }
      return {
        id: entry.id,
        name: entry.name,
        arguments: parsedArguments
      };
    });

    return {
      text: streamedText,
      answer: streamedText,
      toolCalls,
      raw: {
        streamed: true
      },
      _provider: input.provider
    };
  }

  const response = await providerAdapter.generate(
    {
      provider: input.provider,
      messages
    },
    providerCallContext(input.dependencies, input.nodeId)
  );
  throwIfAborted(input.dependencies.abortSignal);

  return {
    text: response.content,
    answer: response.content,
    toolCalls: response.toolCalls,
    raw: response.raw,
    _provider: input.provider,
    // Phase 7.1 — surface telemetry on the node output so execution_history
    // captures token counts + provider-call latency. The Studio canvas reads
    // these via getExecutionHistory's nodeResults.
    _telemetry: {
      providerId: input.provider.providerId,
      model: input.provider.model,
      usage: response.usage,
      latencyMs: response.latencyMs
    }
  };
}

export interface CodeNodeExecutionInput {
  code: string;
  input: Record<string, unknown>;
  timeoutMs?: number;
}

export interface CodeNodeExecutionOutput {
  result: unknown;
  logs: string[];
}

function toJsonSafeValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

/** The outbound guard's pinned fetch, for RAG endpoints that come from a node's own config. */
function guardedRagFetch(dependencies: { outboundGuard?: OutboundGuardConfig; outboundDnsResolver?: (hostname: string) => Promise<string[]> }): RagFetch {
  return (url, init) =>
    guardedFetch(url, init, {
      config: dependencies.outboundGuard ?? DEFAULT_OUTBOUND_GUARD,
      ...(dependencies.outboundDnsResolver ? { resolver: dependencies.outboundDnsResolver } : {})
    });
}

/**
 * Runs code-node JavaScript under a sandbox plan (see code-sandbox.ts; with no
 * plan, code is refused). `input` is what the code sees as `input`; the
 * result and logs come back as JSON-safe values.
 */
export async function executeCodeNodeSandbox(input: CodeNodeExecutionInput, plan: CodeSandboxPlan = NO_CODE_SANDBOX_PLAN): Promise<CodeNodeExecutionOutput> {
  const [output] = await runJavaScriptCode(plan, String(input.code ?? ""), [input.input], codeNodeTimeout(input.timeoutMs));
  return output!;
}

function codeNodeTimeout(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 1500;
}

interface GraphIndexes {
  nodeById: Map<string, WorkflowNode>;
  incomingExecution: Map<string, string[]>;
  outgoingExecution: Map<string, string[]>;
  incomingAttachments: Map<string, string[]>;
  attachmentsBySource: Map<string, Map<AgentAttachmentHandle, string[]>>;
}

function buildGraphIndexes(workflow: Workflow): GraphIndexes {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const incomingExecution = new Map<string, string[]>();
  const outgoingExecution = new Map<string, string[]>();
  const incomingAttachments = new Map<string, string[]>();
  const attachmentsBySource = new Map<string, Map<AgentAttachmentHandle, string[]>>();

  for (const node of workflow.nodes) {
    incomingExecution.set(node.id, []);
    outgoingExecution.set(node.id, []);
    incomingAttachments.set(node.id, []);
  }

  for (const edge of workflow.edges) {
    const attachmentHandle = getAttachmentHandle(edge.sourceHandle);
    if (attachmentHandle) {
      const incoming = incomingAttachments.get(edge.target);
      if (incoming) {
        incoming.push(edge.source);
      }

      let sourceMap = attachmentsBySource.get(edge.source);
      if (!sourceMap) {
        sourceMap = new Map<AgentAttachmentHandle, string[]>();
        attachmentsBySource.set(edge.source, sourceMap);
      }
      const targets = sourceMap.get(attachmentHandle) ?? [];
      targets.push(edge.target);
      sourceMap.set(attachmentHandle, targets);
      continue;
    }

    if (!isExecutionEdge(edge)) {
      continue;
    }

    const incoming = incomingExecution.get(edge.target);
    if (incoming) {
      incoming.push(edge.source);
    }

    const outgoing = outgoingExecution.get(edge.source);
    if (outgoing) {
      outgoing.push(edge.target);
    }
  }

  return {
    nodeById,
    incomingExecution,
    outgoingExecution,
    incomingAttachments,
    attachmentsBySource
  };
}

/** Phase 12.1 — without guard dependencies, guard nodes use the built-in default profile and agents run unguarded. */
const STANDALONE_GUARD: GuardRuntimeDependencies = {
  resolveRun: () => ({ source: "none", stack: [], chain: [] }),
  loadProfile: (profileId) => (profileId === "default" ? builtInGuardProfile() : undefined)
};

function guardScopeFor(
  node: WorkflowNode,
  context: NodeRuntimeContext,
  dependencies: WorkflowExecutionDependencies,
  placement: GuardEvalScope["placement"]
): GuardEvalScope {
  return {
    guard: dependencies.guard ?? STANDALONE_GUARD,
    resolveSecret: dependencies.resolveSecret,
    executionId: typeof context.globals.execution_id === "string" ? context.globals.execution_id : "",
    workflowId: context.workflow.id,
    nodeId: node.id,
    placement,
    ...(context.toolPolicySubject ? { subject: context.toolPolicySubject } : {}),
    ...(dependencies.logger ? { logger: dependencies.logger } : {})
  };
}

/** Protection Provider nodes on a guard node's protection port. */
function protectionNodesFor(guardNode: WorkflowNode, context: NodeRuntimeContext): WorkflowNode[] {
  const ids = context.attachmentsBySource.get(guardNode.id)?.get("protection") ?? [];
  return ids.map((id) => context.nodeById.get(id)).filter((entry): entry is WorkflowNode => Boolean(entry));
}

/**
 * Phase 16 — the outbound check of an egress node (HTTP, Web Browse,
 * connector senders) or an MCP Tool call, before its handler or replay stub.
 * Null when nothing checks it (the zero-config case pays one cheap check).
 * Returns what the handler sends instead after a rewrite, and for HTTP
 * Request the check each redirect hop gets.
 */
async function outboundPreCheck(
  node: WorkflowNode,
  config: Record<string, unknown>,
  context: NodeRuntimeContext,
  dependencies: WorkflowExecutionDependencies
): Promise<{ override: EgressOverride; onRedirect?: (url: string) => Promise<void>; judgeUrl?: EgressUrlJudge } | null> {
  const egress = isEgressNodeType(node.type);
  const mcp = node.type === "mcp_tool";
  if (!egress && !mcp) return null;
  const profiles = await outboundProfilesFor(dependencies.guard, egress ? "egress" : "destinations");
  if (profiles.length === 0) return null;
  const templateData = buildTemplateData(context, config);
  let request: EgressRequest | null;
  if (egress) {
    // The values of the secrets the node references never enter the check; a connector whose address lives in its
    // secret is judged by that address (read for the host only).
    const secretValues: string[] = [];
    for (const ref of secretReferencesIn(config)) {
      try {
        const value = await dependencies.resolveSecret(ref);
        if (typeof value === "string" && value) secretValues.push(value);
      } catch {
        // The handler reports a secret it cannot resolve.
      }
    }
    let secretAddress: string | undefined;
    if (connectorAddressInSecret(node.type, config)) {
      // Azure Storage: the endpoint the adapter will call, computed from its settings and the secret (never shown).
      const azure = azureStorageSecretAddressConfig(node.type, config);
      try {
        const value = (await dependencies.resolveSecret(normalizeSecretRef((azure ?? config).secretRef))) ?? undefined;
        secretAddress = azure ? azureStorageEndpointFor(azure, value) || undefined : value;
      } catch {
        // Unreadable: the address is unknown (public).
        secretAddress = undefined;
      }
    }
    request = describeEgressRequest(node, config, templateData, {
      secretValues,
      ...(secretAddress ? { secretAddress } : {}),
      ...(isRagEgressNode(node.type) ? { ragRefs: ragDestinationRefs(node.type, config, dependencies) } : {})
    });
  } else {
    const operation = config.operation === "read_resource" ? "read_resource" : "call_tool";
    // A resource read sends its URI (rendered once, here); a tool call its arguments.
    const uri = operation === "read_resource" ? renderTemplate(typeof config.resourceUri === "string" ? config.resourceUri : "", templateData).trim() : "";
    const toolName = operation === "read_resource" ? "read_resource" : String(config.toolName ?? "");
    const argsTemplate = typeof config.argsTemplate === "string" ? config.argsTemplate : "{}";
    const args = operation === "read_resource" ? { uri } : tryParseJson(renderTemplate(argsTemplate, templateData));
    let server: MCPServerConfig = { serverId: String(config.serverId ?? ""), registryServerId: readRegistryServerId(config), connection: toRecord(config.connection) };
    try {
      server = await applyRegisteredMcpServer(server, dependencies, context.toolPolicySubject);
    } catch {
      // The handler reports a server it cannot resolve; until then the host is unknown (public).
      server = { ...server, connection: {} };
    }
    request = describeMcpToolRequest(node, server, toolName, args);
    // A resource URI cannot be rewritten into another resource: a rewrite is blocked.
    if (request && operation === "read_resource") request = { ...request, apply: () => null };
  }
  if (!request) return null;
  const scope = guardScopeFor(node, context, dependencies, "node");
  const dataLabels = context.labelScope?.inputLabels() ?? labelsOf([]);
  const common = {
    scope,
    profiles,
    dataLabels,
    ...(context.approvedHandoffKeys ? { approvals: context.approvedHandoffKeys } : {}),
    replay: Boolean(dependencies.replayNodeHook)
  };
  const checked = await checkEgressRequest(request, common);
  if (checked.declassified.length > 0) context.labelScope?.declassify(checked.declassified);
  const first = request;
  const onRedirect =
    node.type === "http_request"
      ? async (url: string) => {
          const chain = [...first.refs, httpDestinationRef(url)];
          first.refs.push(chain[chain.length - 1]!);
          // A hop that needs an approval cannot wait: the first request was already sent, so it is stopped instead.
          const hop = await checkOutbound({ ...common, replay: true, channel: "egress", content: first.content, ...(first.ignoredValues ? { ignoredValues: first.ignoredValues } : {}), refs: chain, what: `${first.what}, redirected to ${chain[chain.length - 1]!.host || "an unknown host"}`, approvalTag: chain.map((ref) => ref.host ?? "").join(">") });
          if (hop.transformed) {
            throw new GuardBlockedError(`${first.what} was redirected somewhere the guard would rewrite the request for; it was stopped instead`, hop.result.verdicts);
          }
        }
      : undefined;
  // Web Browse: every later load (redirects, navigations, sub-resources) is judged as it happens.
  const judgeUrl = node.type === "web_browse" ? egressUrlJudge(common, first.refs, `${node.name || node.type}`) : undefined;
  return { override: checked.override, ...(onRedirect ? { onRedirect } : {}), ...(judgeUrl ? { judgeUrl } : {}) };
}

/**
 * Phase 16 — judges a URL a browser or a fetcher is about to load (a
 * redirect, a navigation, an image or data URL) against the destination
 * rules: its address and query values go to its host, judged with the
 * chain that led there by the strictest hop. A load cannot wait for an
 * approval or be rewritten, so either stops it (GuardBlockedError).
 */
function egressUrlJudge(
  common: Omit<OutboundCheckInput, "channel" | "content" | "refs" | "what" | "approvalTag">,
  startRefs: DestinationRef[],
  what: string
): EgressUrlJudge {
  return async (url, chain = []) => {
    const parts = urlContent(url);
    const refs = [...startRefs, ...chain.map((hop) => httpDestinationRef(hop)), httpDestinationRef(url)];
    const outcome = await checkOutbound({
      ...common,
      replay: true,
      channel: "egress",
      content: { url: parts.url, query: parts.query },
      refs,
      what: `${what} (loading ${parts.host || "an unknown host"})`,
      approvalTag: refs.map((ref) => ref.host ?? "").join(">")
    });
    if (outcome.transformed) {
      throw new GuardBlockedError(`${what} was stopped from loading ${parts.host || "an unknown host"}: the guard would rewrite that address, which cannot be done for a page load`, outcome.result.verdicts);
    }
  };
}

/**
 * Phase 16 — a URL judge that remembers why it stopped a load: a browser
 * only sees an aborted request, so the node fails afterwards with the
 * guard's plain reason (the first one), whatever the page did next.
 */
function recordingJudge(judge: EgressUrlJudge | undefined): { judge?: EgressUrlJudge & { refuse(message: string): void }; run<T>(work: () => Promise<T>): Promise<T> } {
  if (!judge) return { run: (work) => work() };
  const stopped: unknown[] = [];
  const recording = Object.assign(
    async (url: string, chain: string[]) => {
      try {
        await judge(url, chain);
      } catch (error) {
        stopped.push(error);
        throw error;
      }
    },
    { refuse: (message: string) => void stopped.push(new GuardBlockedError(message, [])) }
  );
  return {
    judge: recording,
    async run(work) {
      let result: Awaited<ReturnType<typeof work>>;
      try {
        result = await work();
      } catch (error) {
        if (stopped.length > 0) throw stopped[0];
        throw error;
      }
      if (stopped.length > 0) throw stopped[0];
      return result;
    }
  };
}

/** Phase 16 — the URL judge for nodes that load URLs while rendering (PDF HTML, charts), or null when nothing checks them. */
async function renderUrlJudge(
  node: WorkflowNode,
  context: NodeRuntimeContext,
  dependencies: WorkflowExecutionDependencies
): Promise<EgressUrlJudge | null> {
  const profiles = await outboundProfilesFor(dependencies.guard, "egress");
  if (profiles.length === 0) return null;
  return egressUrlJudge(
    {
      scope: guardScopeFor(node, context, dependencies, "node"),
      profiles,
      dataLabels: context.labelScope?.inputLabels() ?? labelsOf([]),
      ...(context.approvedHandoffKeys ? { approvals: context.approvedHandoffKeys } : {}),
      replay: true
    },
    [],
    node.name || node.type
  );
}

/** Phase 16 — RAG nodes whose services are checked as egress. */
function isRagEgressNode(type: string): boolean {
  return type === "rag_retrieve" || type === "embeddings_azure_openai" || type === "rerank";
}

/** Host of a setting, or of an environment fallback the handler would use. */
function hostOrEnv(value: unknown, envName: string | undefined, fallback?: string): string | undefined {
  const text = typeof value === "string" && value.trim() ? value.trim() : envName ? process.env[envName]?.trim() || fallback : fallback;
  return text ? destinationHostOfSetting(text) : undefined;
}

/**
 * Phase 16 — where a RAG node's embedder, vector store and reranker send
 * (the query and the documents): a fixed vendor host, else the configured
 * endpoint or base URL (or the environment fallback the handler uses). The
 * token embedder, the in-memory store and the knowledge base stay in the
 * process (no ref). An unknown service is an unknown host (public).
 */
function ragDestinationRefs(type: string, config: Record<string, unknown>, _dependencies: WorkflowExecutionDependencies): DestinationRef[] {
  const settings = toRecord(config.vectorStoreConfig);
  const ref = (id: string, host: string | undefined) => networkDestinationRef("connector", id, host);
  if (type === "embeddings_azure_openai") return [ref("azure-openai-embedder", hostOrEnv(config.endpoint, undefined))];
  if (type === "rerank") {
    const providerId = typeof config.providerId === "string" ? config.providerId : "cohere";
    const host = providerId === "cohere" ? "api.cohere.com" : providerId === "jina" ? "api.jina.ai" : providerId === "voyage" ? "api.voyageai.com" : undefined;
    return [ref(`${providerId}-reranker`, host)];
  }
  const refs: DestinationRef[] = [];
  const embedderId = typeof config.embedderId === "string" ? config.embedderId : "token-embedder";
  const embedderHosts: Record<string, () => string | undefined> = {
    "openai-embedder": () => hostOrEnv(settings.baseUrl, undefined, "https://api.openai.com/v1"),
    "azure-openai-embedder": () => hostOrEnv(settings.endpoint, "AZURE_OPENAI_ENDPOINT"),
    "cohere-embedder": () => "api.cohere.ai",
    "mistral-embedder": () => "api.mistral.ai",
    "google-vertex-embedder": () => "generativelanguage.googleapis.com",
    "huggingface-embedder": () => "api-inference.huggingface.co"
  };
  if (embedderId !== "token-embedder") refs.push(ref(embedderId, embedderHosts[embedderId]?.()));
  const storeId = typeof config.vectorStoreId === "string" ? config.vectorStoreId : "in-memory-vector-store";
  const storeHosts: Record<string, () => string | undefined> = {
    "pinecone-vector-store": () => "api.pinecone.io",
    // The connection string lives in a secret or DATABASE_URL: unknown unless it is in the environment.
    "pgvector-store": () => (typeof config.embeddingSecretRef === "object" && config.embeddingSecretRef ? undefined : hostOrEnv(undefined, "DATABASE_URL")),
    "azure-ai-search-vector-store": () => hostOrEnv(settings.endpoint, "AZURE_AI_SEARCH_ENDPOINT"),
    "qdrant-vector-store": () => hostOrEnv(settings.endpoint, "QDRANT_ENDPOINT"),
    "chroma-vector-store": () => hostOrEnv(settings.endpoint, "CHROMA_ENDPOINT", "http://localhost:8000"),
    "weaviate-vector-store": () => hostOrEnv(settings.endpoint, "WEAVIATE_ENDPOINT", "http://localhost:8080"),
    "redis-vector-store": () => hostOrEnv(settings.endpoint, "REDIS_ENDPOINT", "http://localhost:6379")
  };
  if (storeId !== "in-memory-vector-store" && storeId !== "knowledge-base") refs.push(ref(storeId, storeHosts[storeId]?.()));
  return refs;
}

/** Phase 15.1 — the replay stub for a node, if the run is a replay and the node is stubbed. */
function replayStubFor(node: WorkflowNode, dependencies: WorkflowExecutionDependencies): ReplayNodeStub | null {
  if (!dependencies.replayNodeHook || node.type === "sticky_note" || node.disabled === true) {
    return null;
  }
  return dependencies.replayNodeHook(node);
}

function resolveReplayStub(stub: ReplayNodeStub, context: NodeRuntimeContext): unknown {
  if (stub.kind === "pass_through") {
    return mergeParentOutputs(context.parentOutputs);
  }
  if (stub.kind === "error") {
    throw new Error(`Replayed from the recording: ${stub.message}`);
  }
  return stub.output;
}

/** Runs a node's handler with its label scope current, so its template reads are recorded on it. */
function executeNode(
  node: WorkflowNode,
  context: NodeRuntimeContext,
  dependencies: WorkflowExecutionDependencies
): Promise<unknown> {
  return runInLabelScope(context.labelScope, () => executeNodeHandler(node, context, dependencies));
}

async function executeNodeHandler(
  node: WorkflowNode,
  context: NodeRuntimeContext,
  dependencies: WorkflowExecutionDependencies
): Promise<unknown> {
  throwIfAborted(dependencies.abortSignal);
  const config = toRecord(node.config);

  // Visual-only nodes are never executed; downstream receives the merged parent outputs so the DAG stays intact.
  if (node.type === "sticky_note") {
    return mergeParentOutputs(context.parentOutputs);
  }

  // Disabled nodes pass through their parent outputs unchanged so the rest of the graph still runs.
  if (node.disabled === true) {
    return mergeParentOutputs(context.parentOutputs);
  }

  // Phase 12.4 — the MCP tool policy decides a direct tool call before the guard's destination check.
  await directMcpPolicyPreCheck(node, config, context, dependencies);
  // Phase 16 — outbound checks (egress, MCP destination rules) run before the handler, and before a replay's stub.
  const outbound = await outboundPreCheck(node, config, context, dependencies);

  const replayStub = replayStubFor(node, dependencies);
  if (replayStub) {
    return resolveReplayStub(replayStub, context);
  }

  const templateData = buildTemplateData(context, config);
  // Phase 16 — a connector handler sends the renderings the check judged; it never renders them again.
  if (outbound?.override.kind === "renderings") bindCheckedRenderings(templateData, outbound.override.renderings);

  switch (node.type) {
    case "schedule_trigger": {
      return {
        trigger_type: context.globals.trigger_type ?? "manual",
        scheduled_at: context.globals.scheduled_at ?? nowIso(),
        schedule: {
          cronExpression: typeof config.cronExpression === "string" ? config.cronExpression : "",
          timezone: typeof config.timezone === "string" ? config.timezone : "UTC",
          active: config.active !== false
        }
      };
    }

    case "webhook_input": {
      const webhook = toRecord(context.globals.webhook);
      const passThrough = Array.isArray(config.passThroughFields)
        ? config.passThroughFields.map((value) => String(value))
        : [];

      if (!passThrough.length) {
        return webhook;
      }

      const picked: Record<string, unknown> = {};
      for (const field of passThrough) {
        if (field in webhook) {
          picked[field] = webhook[field];
        }
      }
      return picked;
    }

    case "http_request": {
      const method = typeof config.method === "string" ? config.method.trim().toUpperCase() : "GET";
      const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
      const safeMethod = allowedMethods.has(method) ? method : "GET";

      // Phase 16 — under outbound checks the handler sends the checked rendering (rewritten when the check rewrote it).
      const httpOverride = outbound?.override.kind === "http" ? outbound.override : undefined;
      const urlTemplate = typeof config.urlTemplate === "string" ? config.urlTemplate : "";
      const renderedUrl = httpOverride ? httpOverride.url : renderTemplate(urlTemplate, templateData).trim();
      if (!renderedUrl) {
        throw new Error("HTTP Request node requires a non-empty rendered URL.");
      }

      emitNodeActivity(dependencies, node.id, {
        kind: "resolved_input",
        fields: { method: safeMethod, url: urlForActivity(renderedUrl) }
      });

      const headersTemplate = typeof config.headersTemplate === "string" ? config.headersTemplate : "{}";
      let headersPayload: Record<string, unknown> = {};
      if (httpOverride) {
        headersPayload = httpOverride.headers;
      } else {
        const renderedHeaders = renderTemplate(headersTemplate, templateData);
        try {
          headersPayload = toRecord(JSON.parse(renderedHeaders || "{}"));
        } catch {
          throw new Error("HTTP Request node headersTemplate must render valid JSON object.");
        }
      }

      const requestHeaders = new Headers();
      for (const [key, value] of Object.entries(headersPayload)) {
        requestHeaders.set(key, String(value));
      }

      const secretRef = toRecord(config.secretRef);
      if (typeof secretRef.secretId === "string" && secretRef.secretId.trim()) {
        const secretValue = await dependencies.resolveSecret({ secretId: secretRef.secretId.trim() });
        if (!secretValue) {
          throw new Error("HTTP Request node secretRef is set but secret value could not be resolved.");
        }
        requestHeaders.set("Authorization", `Bearer ${secretValue}`);
      }

      const bodyTemplate = typeof config.bodyTemplate === "string" ? config.bodyTemplate : "";
      const renderedBody = httpOverride ? httpOverride.body : renderTemplate(bodyTemplate, templateData);
      const timeoutMs =
        typeof config.timeoutMs === "number" && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
          ? Math.floor(config.timeoutMs)
          : 15000;
      const responseType = config.responseType === "text" ? "text" : "json";

      const controller = new AbortController();
      const abortFromExecution = () => {
        controller.abort(dependencies.abortSignal?.reason);
      };
      if (dependencies.abortSignal?.aborted) {
        abortFromExecution();
      } else {
        dependencies.abortSignal?.addEventListener("abort", abortFromExecution, { once: true });
      }
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const requestInit: RequestInit = {
          method: safeMethod,
          headers: requestHeaders,
          signal: controller.signal
        };

        if (safeMethod !== "GET" && safeMethod !== "DELETE" && renderedBody.trim()) {
          requestInit.body = renderedBody;
        }

        const response = await guardedFetch(renderedUrl, requestInit, {
          config: dependencies.outboundGuard ?? DEFAULT_OUTBOUND_GUARD,
          ...(dependencies.outboundDnsResolver ? { resolver: dependencies.outboundDnsResolver } : {}),
          // Phase 16 — a redirect is judged again, by the strictest hop of the chain so far.
          ...(outbound?.onRedirect ? { onRedirect: outbound.onRedirect } : {})
        });
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        let parsedBody: unknown = null;
        if (responseType === "text") {
          parsedBody = await response.text();
        } else {
          try {
            parsedBody = await response.json();
          } catch {
            parsedBody = await response.text();
          }
        }

        return {
          status: response.status,
          headers: responseHeaders,
          body: parsedBody,
          ok: response.ok
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          if (dependencies.abortSignal?.aborted) {
            throw new WorkflowCanceledError(getAbortMessage(dependencies.abortSignal));
          }
          throw new Error(`HTTP Request node timed out after ${timeoutMs}ms.`);
        }
        throw error;
      } finally {
        clearTimeout(timeoutHandle);
        dependencies.abortSignal?.removeEventListener("abort", abortFromExecution);
      }
    }

    case "text_input": {
      const webhookPrompt = isWebhookTrigger(context.globals) ? resolveWebhookPrompt(context.globals) : undefined;
      const text =
        typeof webhookPrompt === "string"
          ? webhookPrompt
          : resolveRuntimeUserPrompt(context.globals) ??
            (typeof config.text === "string" ? config.text : "");

      return {
        text,
        user_prompt: text
      };
    }

    case "system_prompt": {
      return {
        system_prompt:
          typeof config.text === "string"
            ? config.text
            : typeof context.globals.system_prompt === "string"
              ? context.globals.system_prompt
              : ""
      };
    }

    case "user_prompt": {
      return {
        user_prompt: resolveRuntimeUserPrompt(context.globals) ?? (typeof config.text === "string" ? config.text : "")
      };
    }

    case "input_validator": {
      const rules = Array.isArray(config.rules)
        ? config.rules.map((entry) => toRecord(entry))
        : [];
      const onFail = config.onFail === "branch" ? "branch" : "error";
      // Phase 16 — the validator reads the run's globals directly: the run input.
      context.labelScope?.readRunInput();
      const payloadSources = [
        toRecord(context.globals.webhook),
        toRecord(context.globals),
        toRecord(readData(templateData, "input"))
      ];
      const payload = Object.assign({}, ...payloadSources);
      const errors: Array<{ field: string; check: string; message: string }> = [];

      for (const rule of rules) {
        const field = String(rule.field ?? "").trim();
        const check = String(rule.check ?? "").trim();
        const expectedValue = String(rule.value ?? "");
        if (!field || !check) {
          continue;
        }

        const actualValue = getValueByPath(payload, field);
        if (check === "required") {
          const missing =
            actualValue === undefined ||
            actualValue === null ||
            (typeof actualValue === "string" && actualValue.trim() === "");
          if (missing) {
            errors.push({
              field,
              check,
              message: `Field '${field}' is required.`
            });
          }
          continue;
        }

        if (check === "max_length") {
          const maxLength = Number(expectedValue);
          const currentLength = String(actualValue ?? "").length;
          if (Number.isFinite(maxLength) && currentLength > maxLength) {
            errors.push({
              field,
              check,
              message: `Field '${field}' exceeds max length of ${maxLength}.`
            });
          }
          continue;
        }

        if (check === "regex") {
          try {
            const pattern = new RegExp(expectedValue);
            if (!pattern.test(String(actualValue ?? ""))) {
              errors.push({
                field,
                check,
                message: `Field '${field}' does not match regex '${expectedValue}'.`
              });
            }
          } catch {
            errors.push({
              field,
              check,
              message: `Invalid regex for field '${field}'.`
            });
          }
        }
      }

      if (errors.length > 0 && onFail === "error") {
        throw new Error(`Input validation failed: ${errors.map((error) => error.message).join(" ")}`);
      }

      return {
        valid: errors.length === 0,
        errors
      };
    }

    case "merge_node": {
      const mode =
        config.mode === "append" || config.mode === "combine_by_key" || config.mode === "choose_branch"
          ? config.mode
          : "append";
      const entries = Object.entries(context.parentOutputs);

      if (mode === "append") {
        const mergedOutput: Record<string, unknown> = {};
        for (const [parentId, parentOutput] of entries) {
          if (parentOutput && typeof parentOutput === "object" && !Array.isArray(parentOutput)) {
            Object.assign(mergedOutput, parentOutput as Record<string, unknown>);
          } else {
            mergedOutput[parentId] = parentOutput;
          }
        }
        return mergedOutput;
      }

      if (mode === "combine_by_key") {
        const combineKey = typeof config.combineKey === "string" ? config.combineKey.trim() : "";
        if (!combineKey) {
          throw new Error("Merge node combine_by_key mode requires a combineKey.");
        }

        const grouped: Record<string, unknown[]> = {};
        for (const [, parentOutput] of entries) {
          const candidates = Array.isArray(parentOutput) ? parentOutput : [parentOutput];
          for (const candidate of candidates) {
            const candidateRecord = toRecord(candidate);
            const keyValue = candidateRecord[combineKey];
            const groupKey = keyValue === undefined || keyValue === null ? "__undefined__" : String(keyValue);
            if (!grouped[groupKey]) {
              grouped[groupKey] = [];
            }
            grouped[groupKey].push(candidate);
          }
        }

        return grouped;
      }

      for (const [parentId, parentOutput] of entries) {
        if (parentOutput !== undefined && parentOutput !== null && !isErrorLikeOutput(parentOutput)) {
          if (parentOutput && typeof parentOutput === "object" && !Array.isArray(parentOutput)) {
            return {
              ...(parentOutput as Record<string, unknown>),
              _selectedParentId: parentId
            };
          }
          return {
            value: parentOutput,
            _selectedParentId: parentId
          };
        }
      }

      return {};
    }

    case "sub_workflow_trigger": {
      // Entry point for sub-workflows — pass through the injected input context
      return {
        trigger_type: "sub_workflow",
        ...context.globals,
        ...context.merged
      };
    }

    case "error_trigger": {
      return {
        trigger_type: "error",
        source_workflow_id: context.globals.source_workflow_id ?? "",
        source_workflow_name: context.globals.source_workflow_name ?? "",
        execution_id: context.globals.execution_id ?? "",
        error: context.globals.error ?? "",
        error_stack: context.globals.error_stack ?? "",
        timestamp: context.globals.timestamp ?? nowIso()
      };
    }

    case "filter_node": {
      const conditions = Array.isArray(config.conditions) ? config.conditions : [];
      const combineWith = config.combineWith === "OR" ? "OR" : "AND";
      const passMode = config.passMode === "reject" ? "reject" : "pass";

      function evaluateFilterCondition(cond: Record<string, unknown>): boolean {
        const field = typeof cond.field === "string" ? cond.field : "";
        const operator = typeof cond.operator === "string" ? cond.operator : "eq";
        const expectedRaw =
          typeof cond.value === "string" ? renderTemplate(String(cond.value), templateData) : cond.value;

        let actual: unknown = readData(templateData, field);
        if (actual === undefined) actual = getValueByPath(templateData, field);

        const actualStr = actual == null ? "" : String(actual);
        const expectedStr = expectedRaw == null ? "" : String(expectedRaw);

        switch (operator) {
          case "eq": return actualStr === expectedStr;
          case "neq": return actualStr !== expectedStr;
          case "gt": return Number(actual) > Number(expectedRaw);
          case "gte": return Number(actual) >= Number(expectedRaw);
          case "lt": return Number(actual) < Number(expectedRaw);
          case "lte": return Number(actual) <= Number(expectedRaw);
          case "contains": return actualStr.includes(expectedStr);
          case "not_contains": return !actualStr.includes(expectedStr);
          case "starts_with": return actualStr.startsWith(expectedStr);
          case "ends_with": return actualStr.endsWith(expectedStr);
          case "is_empty":
            return actual == null || actualStr === "" || (Array.isArray(actual) && actual.length === 0);
          case "is_not_empty":
            return actual != null && actualStr !== "" && !(Array.isArray(actual) && actual.length === 0);
          case "regex": {
            try { return new RegExp(expectedStr).test(actualStr); } catch { return false; }
          }
          default: return false;
        }
      }

      const results = conditions.map((c: unknown) => evaluateFilterCondition(toRecord(c)));
      const passed = combineWith === "OR" ? results.some(Boolean) : results.every(Boolean);
      const shouldPass = passMode === "pass" ? passed : !passed;

      return {
        _branchHandle: shouldPass ? "pass" : "filtered",
        passed: shouldPass,
        input: { ...context.merged },
        ...context.merged
      };
    }

    case "stop_and_error": {
      const messageTemplate =
        typeof config.message === "string" && config.message.trim()
          ? config.message
          : "Workflow stopped by stop_and_error node.";
      const errorCode =
        typeof config.errorCode === "string" && config.errorCode.trim()
          ? config.errorCode
          : "WORKFLOW_STOPPED";
      const renderedMessage = renderTemplate(messageTemplate, templateData);
      throw new WorkflowError(renderedMessage, ErrorCategory.WORKFLOW_STOPPED, false, { errorCode });
    }

    case "noop_node": {
      return { ...context.merged };
    }

    case "wait_node": {
      const resumeMode =
        typeof config.resumeMode === "string" ? config.resumeMode : "timer";
      const maxDelay =
        typeof config.maxDelayMs === "number" && Number.isFinite(config.maxDelayMs) && config.maxDelayMs > 0
          ? Math.floor(config.maxDelayMs)
          : 30000;

      if (resumeMode === "datetime" && typeof config.resumeAt === "string" && config.resumeAt.trim()) {
        const resumeAtMs = Date.parse(config.resumeAt.trim());
        if (!Number.isNaN(resumeAtMs)) {
          const delayUntil = Math.max(0, resumeAtMs - Date.now());
          const clampedDelay = Math.min(delayUntil, maxDelay);
          await sleep(clampedDelay, dependencies.abortSignal);
          return mergeParentOutputs(context.parentOutputs);
        }
      }

      const requestedDelay =
        typeof config.delayMs === "number" && Number.isFinite(config.delayMs) && config.delayMs >= 0
          ? Math.floor(config.delayMs)
          : 1000;
      const clampedDelay = Math.min(requestedDelay, maxDelay);
      await sleep(clampedDelay, dependencies.abortSignal);
      return mergeParentOutputs(context.parentOutputs);
    }

    case "set_node": {
      const assignments = Array.isArray(config.assignments) ? config.assignments.map((entry) => toRecord(entry)) : [];
      const output: Record<string, unknown> = {};

      for (const assignment of assignments) {
        const key = typeof assignment.key === "string" ? assignment.key.trim() : "";
        const valueTemplate = typeof assignment.valueTemplate === "string" ? assignment.valueTemplate : "";
        if (!key) {
          continue;
        }
        const rendered = renderTemplate(valueTemplate, templateData);
        output[key] = parseTemplateValue(rendered);
      }

      return output;
    }

    case "execute_workflow": {
      const workflowId = typeof config.workflowId === "string" ? config.workflowId.trim() : "";
      if (!workflowId) {
        throw new Error("Execute Workflow node requires a workflowId.");
      }

      if (!dependencies.loadWorkflow) {
        throw new Error("Execute Workflow node requires a loadWorkflow dependency.");
      }

      if (context.callStack.length >= MAX_SUB_WORKFLOW_DEPTH) {
        throw new Error(
          `Maximum sub-workflow depth of ${MAX_SUB_WORKFLOW_DEPTH} exceeded. Call stack: ${context.callStack.join(" -> ")}`
        );
      }

      if (context.callStack.includes(workflowId)) {
        throw new Error(
          `Circular sub-workflow reference detected: ${[...context.callStack, workflowId].join(" -> ")}`
        );
      }

      const targetWorkflow = await dependencies.loadWorkflow(workflowId);
      if (!targetWorkflow) {
        throw new Error(`Sub-workflow '${workflowId}' was not found.`);
      }

      const childDependencies: WorkflowExecutionDependencies = dependencies.scopeSubWorkflow
        ? { ...dependencies, ...dependencies.scopeSubWorkflow(targetWorkflow) }
        : dependencies;
      const mode = config.mode === "async" ? "async" : "sync";
      const inputMapping = toRecord(config.inputMapping);
      const mappedInput: Record<string, unknown> = {};
      for (const [parentKey, childKeyValue] of Object.entries(inputMapping)) {
        const parentPath = String(parentKey ?? "").trim();
        const childKey = String(childKeyValue ?? "").trim();
        if (!parentPath || !childKey) {
          continue;
        }

        let mappedValue = readData(templateData, parentPath);
        context.labelScope?.readPath(parentPath);
        if (mappedValue === undefined) {
          mappedValue = getValueByPath(templateData, parentPath);
        }
        mappedInput[childKey] = mappedValue;
      }

      // Phase 16 — the child's trigger takes this node's input labels.
      const childInputLabels = context.labelScope?.inputLabels();
      if (mode === "async") {
        // Fire-and-forget
        executeWorkflow(
          {
            workflow: targetWorkflow,
            input: mappedInput,
            ...(childInputLabels ? { inputLabels: childInputLabels } : {}),
            triggerType: "sub_workflow",
            triggeredBy: context.workflow.id,
            toolPolicySubject: context.toolPolicySubject,
            callStack: [...context.callStack]
          },
          childDependencies
        ).catch(() => {
          // Intentionally ignored — async sub-workflow errors do not propagate
        });
        return { async: true, workflowId, status: "enqueued" };
      }

      // Phase 11.2 — a paused child is not saved on its own: its paused state
      // travels in this run's hand-off, and the parent pauses at this node.
      let childPause: Parameters<NonNullable<WorkflowExecutionDependencies["persistPausedExecution"]>>[0] | undefined;
      const pauseCapturingDependencies: WorkflowExecutionDependencies = {
        ...childDependencies,
        persistPausedExecution: async (paused) => {
          childPause = paused;
        }
      };
      const resume = context.resumeDecision;
      const resumingChild = resume && resume.nodeId === node.id && resume.handoff.kind === "sub_workflow" ? resume.handoff : undefined;
      // The child resumes under the scope of the workflow this node calls
      // now (checked by loadWorkflow above), never a stored one of another id.
      if (resumingChild && resumingChild.childState.workflow?.id !== targetWorkflow.id) {
        throw new Error(`The paused sub-workflow does not match '${workflowId}', so this run cannot resume it.`);
      }
      const childResult = resumingChild
        ? await executeWorkflow(
            {
              workflow: resumingChild.childState.workflow,
              triggerType: "sub_workflow",
              triggeredBy: context.workflow.id,
              toolPolicySubject: context.toolPolicySubject,
              callStack: [...context.callStack],
              resumeState: resumingChild.childState,
              approvalDecision: {
                decision: resume!.decision,
                ...(resume!.actedBy ? { actedBy: resume!.actedBy } : {}),
                ...(resume!.reason ? { reason: resume!.reason } : {}),
                ...(resume!.edits ? { edits: resume!.edits } : {}),
                ...(resume!.editedFields ? { editedFields: resume!.editedFields } : {}),
                ...(resume!.requestId ? { requestId: resume!.requestId } : {})
              }
            },
            pauseCapturingDependencies
          )
        : await executeWorkflow(
            {
              workflow: targetWorkflow,
              input: mappedInput,
              ...(childInputLabels ? { inputLabels: childInputLabels } : {}),
              triggerType: "sub_workflow",
              triggeredBy: context.workflow.id,
              toolPolicySubject: context.toolPolicySubject,
              callStack: [...context.callStack]
            },
            pauseCapturingDependencies
          );

      if (childResult.status === "error") {
        throw new Error(childResult.error ?? `Sub-workflow '${workflowId}' execution failed.`);
      }

      if (childResult.status === "waiting_approval") {
        if (!childPause) {
          throw new Error(`Sub-workflow '${workflowId}' paused for approval, but its paused state was not handed back.`);
        }
        throw new ApprovalHandoffSignal({
          message: childPause.approvalMessage,
          timeoutMinutes: childPause.timeoutMinutes,
          handoff: {
            kind: "sub_workflow",
            source: "execute_workflow",
            workflowId: childPause.workflowId,
            workflowName: childPause.workflowName,
            childState: childPause.state
          },
          details: { subWorkflowId: childPause.workflowId, subWorkflowName: childPause.workflowName, waitingNodeId: childPause.waitingNodeId }
        });
      }

      // Phase 16 — this node's output is the child's output, and takes its labels.
      const childOutputLabels = runOutputLabels.get(childResult);
      if (childOutputLabels) context.labelScope?.replace(childOutputLabels);

      // Apply outputMapping if configured
      const outputMapping = toRecord(config.outputMapping);
      const childOutput = toRecord(childResult.output);
      const outputMappingEntries = Object.entries(outputMapping);
      if (outputMappingEntries.length > 0) {
        const projected: Record<string, unknown> = {};
        for (const [childKey, parentKey] of outputMappingEntries) {
          const ck = String(childKey ?? "").trim();
          const pk = String(parentKey ?? "").trim();
          if (!ck || !pk) continue;
          let val = childOutput[ck];
          if (val === undefined) val = getValueByPath(childOutput, ck);
          projected[pk] = val;
        }
        return projected;
      }

      return childResult.output;
    }

    case "code_node": {
      const timeout =
        typeof config.timeout === "number" && Number.isFinite(config.timeout) && config.timeout > 0
          ? Math.floor(config.timeout)
          : 1500;
      const code = typeof config.code === "string" ? config.code : "";
      if (!code.trim()) {
        throw new Error("Code Node requires a non-empty code script.");
      }

      const language = typeof config.language === "string" ? config.language : "javascript";
      const mode = config.mode === "runOnceForEachItem" ? "runOnceForEachItem" : "runOnceForAllItems";

      const codeSandbox = dependencies.codeSandbox ?? NO_CODE_SANDBOX_PLAN;
      if (codeSandbox.kind === "disabled") throw codeNodesDisabledError(codeSandbox);
      // Phase 16 — code can read anything it is given: every node in context and the run input.
      context.labelScope?.readEverything();

      if (language === "python") {
        const items = Array.isArray(templateData.items)
          ? (templateData.items as unknown[])
          : [templateData];
        const py = await runPythonCode(codeSandbox, { code, items, mode, timeoutMs: timeout });
        if (py.result && typeof py.result === "object" && !Array.isArray(py.result)) {
          return {
            ...(py.result as Record<string, unknown>),
            code_result: py.result,
            code_logs: py.logs
          };
        }
        return { code_result: py.result, code_logs: py.logs };
      }

      // JS path — supports runOnceForEachItem too
      if (mode === "runOnceForEachItem" && Array.isArray(templateData.items)) {
        // One sandbox for all items (one container, or a fresh realm per item in-process).
        const itemInputs = (templateData.items as unknown[]).map((item, i) => ({ ...templateData, item, _itemIndex: i, input: { ...templateData, item } }));
        const runs = await runJavaScriptCode(codeSandbox, code, itemInputs, timeout);
        const outputs = runs.map((r) => r.result);
        return { code_result: outputs, items: outputs, code_logs: runs.flatMap((r) => r.logs) };
      }

      const sandboxInput = {
        ...templateData,
        input: templateData
      };
      const result = await executeCodeNodeSandbox({
        code,
        input: sandboxInput,
        timeoutMs: timeout
      }, codeSandbox);

      if (result.result && typeof result.result === "object" && !Array.isArray(result.result)) {
        return {
          ...(result.result as Record<string, unknown>),
          code_result: result.result,
          code_logs: result.logs
        };
      }

      return {
        code_result: result.result,
        code_logs: result.logs
      };
    }

    case "prompt_template": {
      const template = typeof config.template === "string" ? config.template : "{{user_prompt}}";
      const outputKey = typeof config.outputKey === "string" && config.outputKey ? config.outputKey : "prompt";
      const rendered = renderTemplate(template, templateData);
      return {
        [outputKey]: rendered,
        prompt: rendered
      };
    }

    case "llm_call": {
      const provider = config.provider as LLMProviderConfig;
      const promptKey = typeof config.promptKey === "string" ? config.promptKey : "prompt";
      const systemPromptKey = typeof config.systemPromptKey === "string" ? config.systemPromptKey : "system_prompt";
      const prompts = await applyServerPromptToLlmNode({
        node,
        config,
        templateData,
        context,
        dependencies,
        userPrompt: String(readData(templateData, promptKey) ?? readData(templateData, "user_prompt") ?? ""),
        systemPrompt: String(readData(templateData, systemPromptKey) ?? "")
      });
      const output = await runLlmNode({
        outbound: { node, context },
        nodeId: node.id,
        provider,
        userPrompt: prompts.userPrompt,
        systemPrompt: prompts.systemPrompt,
        dependencies
      });
      return prompts.trace ? { ...output, _serverPrompt: prompts.trace } : output;
    }

    case "openai_chat_model":
    case "anthropic_chat_model":
    case "ollama_chat_model":
    case "openai_compatible_chat_model":
    case "ai_gateway_chat_model": {
      const provider = buildProviderFromModelNode(node);
      if (!provider) {
        throw new Error(`${node.name || node.type} requires a valid model configuration.`);
      }
      assertChatModelCredentials(node, provider);

      const promptKey = typeof config.promptKey === "string" ? config.promptKey : "prompt";
      const systemPromptKey = typeof config.systemPromptKey === "string" ? config.systemPromptKey : "system_prompt";
      const prompts = await applyServerPromptToLlmNode({
        node,
        config,
        templateData,
        context,
        dependencies,
        userPrompt: String(readData(templateData, promptKey) ?? readData(templateData, "user_prompt") ?? ""),
        systemPrompt: String(readData(templateData, systemPromptKey) ?? "")
      });
      const output = await runLlmNode({
        outbound: { node, context },
        nodeId: node.id,
        provider,
        userPrompt: prompts.userPrompt,
        systemPrompt: prompts.systemPrompt,
        dependencies
      });
      return prompts.trace ? { ...output, _serverPrompt: prompts.trace } : output;
    }

    case "azure_openai_chat_model": {
      const endpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
      const deployment = typeof config.deployment === "string" ? config.deployment.trim() : "";
      if (!endpoint || !deployment) {
        throw new Error("Azure OpenAI Chat Model requires endpoint and deployment.");
      }

      const promptKey = typeof config.promptKey === "string" ? config.promptKey : "prompt";
      const systemPromptKey = typeof config.systemPromptKey === "string" ? config.systemPromptKey : "system_prompt";
      const prompts = await applyServerPromptToLlmNode({
        node,
        config,
        templateData,
        context,
        dependencies,
        userPrompt: String(readData(templateData, promptKey) ?? readData(templateData, "user_prompt") ?? ""),
        systemPrompt: String(readData(templateData, systemPromptKey) ?? "")
      });
      const provider: LLMProviderConfig = {
        providerId: "azure_openai",
        model: deployment,
        baseUrl: endpoint,
        secretRef: normalizeSecretRef(config.secretRef),
        temperature: typeof config.temperature === "number" && Number.isFinite(config.temperature) ? config.temperature : undefined,
        maxTokens: typeof config.maxTokens === "number" && Number.isFinite(config.maxTokens) ? Math.max(1, Math.floor(config.maxTokens)) : undefined,
        extra: {
          deployment,
          apiVersion:
            typeof config.apiVersion === "string" && config.apiVersion.trim()
              ? config.apiVersion.trim()
              : "2024-10-21"
        }
      };

      const output = await runLlmNode({
        outbound: { node, context },
        nodeId: node.id,
        provider,
        userPrompt: prompts.userPrompt,
        systemPrompt: prompts.systemPrompt,
        dependencies
      });
      return prompts.trace ? { ...output, _serverPrompt: prompts.trace } : output;
    }

    case "google_gemini_chat_model": {
      const model = typeof config.model === "string" ? config.model.trim() : "gemini-2.5-flash";
      if (!model) {
        throw new Error("Google Gemini Chat Model requires a model name.");
      }

      const promptKey = typeof config.promptKey === "string" ? config.promptKey : "prompt";
      const systemPromptKey = typeof config.systemPromptKey === "string" ? config.systemPromptKey : "system_prompt";
      const userPrompt = String(readData(templateData, promptKey) ?? readData(templateData, "user_prompt") ?? "");
      const systemPrompt = String(readData(templateData, systemPromptKey) ?? "");
      const provider: LLMProviderConfig = {
        providerId: "gemini",
        model,
        secretRef: normalizeSecretRef(config.secretRef),
        temperature: typeof config.temperature === "number" && Number.isFinite(config.temperature) ? config.temperature : undefined,
        maxTokens: typeof config.maxTokens === "number" && Number.isFinite(config.maxTokens) ? Math.max(1, Math.floor(config.maxTokens)) : undefined
      };
      assertChatModelCredentials(node, provider);

      return runLlmNode({
        nodeId: node.id,
        provider,
        userPrompt,
        systemPrompt,
        dependencies,
        outbound: { node, context }
      });
    }

    case "connector_source": {
      const connectorId = String(config.connectorId ?? "");
      const connector = dependencies.connectorRegistry.get(connectorId);
      const connectorConfig = {
        ...toRecord(config.connectorConfig ?? config),
        ...(config.authSecretRef ? { secretRef: config.authSecretRef } : {}),
        ...(config.secretRef ? { secretRef: config.secretRef } : {})
      };
      const output = await connector.fetchData(connectorConfig, {
        resolveSecret: dependencies.resolveSecret
      });

      return {
        documents: output.documents,
        connectorRaw: output.raw
      };
    }

    case "google_drive_source": {
      const connector = dependencies.connectorRegistry.get("google-drive");
      const output = await connector.fetchData(
        {
          ...config
        },
        {
          resolveSecret: dependencies.resolveSecret
        }
      );

      return {
        documents: output.documents,
        connectorRaw: output.raw
      };
    }

    case "azure_storage": {
      const connector = dependencies.connectorRegistry.get("azure-storage");
      const output = await connector.fetchData(
        {
          ...config
        },
        {
          resolveSecret: dependencies.resolveSecret
        }
      );

      return {
        documents: output.documents,
        connectorRaw: output.raw,
        result: output.raw
      };
    }

    case "azure_cosmos_db": {
      const connector = dependencies.connectorRegistry.get("azure-cosmos-db");
      const output = await connector.fetchData(
        {
          ...config
        },
        {
          resolveSecret: dependencies.resolveSecret
        }
      );

      return {
        documents: output.documents,
        connectorRaw: output.raw,
        result: output.raw
      };
    }

    case "azure_monitor_http": {
      const connector = dependencies.connectorRegistry.get("azure-monitor");
      const output = await connector.fetchData(
        {
          ...config
        },
        {
          resolveSecret: dependencies.resolveSecret
        }
      );

      return {
        documents: output.documents,
        connectorRaw: output.raw,
        result: output.raw
      };
    }

    case "azure_ai_search_vector_store": {
      const connector = dependencies.connectorRegistry.get("azure-ai-search");
      const output = await connector.fetchData(
        {
          ...config
        },
        {
          resolveSecret: dependencies.resolveSecret
        }
      );

      return {
        documents: output.documents,
        connectorRaw: output.raw,
        result: output.raw
      };
    }

    case "qdrant_vector_store": {
      const connector = dependencies.connectorRegistry.get("qdrant");
      const output = await connector.fetchData(
        {
          ...config
        },
        {
          resolveSecret: dependencies.resolveSecret
        }
      );

      return {
        documents: output.documents,
        connectorRaw: output.raw,
        result: output.raw
      };
    }

    case "document_chunker": {
      const chunkSize = typeof config.chunkSize === "number" && config.chunkSize > 0 ? Math.floor(config.chunkSize) : 500;
      const chunkOverlap = typeof config.chunkOverlap === "number" && config.chunkOverlap >= 0 ? Math.floor(config.chunkOverlap) : 50;
      const separator = typeof config.separator === "string" ? config.separator : "\n\n";
      const strategy = typeof config.strategy === "string" ? config.strategy : "separator";

      const upstreamDocs = normalizeDocuments(readData(templateData, "documents"));
      const chunkedDocs: ConnectorDocument[] = [];

      if (strategy === "separator") {
        for (const doc of upstreamDocs) {
          const text = doc.text.trim();
          if (!text) continue;

          const chunks = text.split(separator).filter(Boolean);
          let currentChunk = "";
          let index = 0;

          for (const chunk of chunks) {
            if ((currentChunk + separator + chunk).length > chunkSize && currentChunk.length > 0) {
              chunkedDocs.push({
                id: `${doc.id}-chunk-${index++}`,
                text: currentChunk,
                metadata: { ...toRecord(doc.metadata), chunkIndex: index - 1, originalId: doc.id }
              });

              // Very naive overlap implementation for string lengths
              const overlapAmount = Math.min(chunkOverlap, currentChunk.length);
              currentChunk = currentChunk.slice(-overlapAmount) + separator + chunk;
            } else {
              currentChunk = currentChunk ? currentChunk + separator + chunk : chunk;
            }
          }

          if (currentChunk) {
            chunkedDocs.push({
               id: `${doc.id}-chunk-${index}`,
               text: currentChunk,
               metadata: { ...toRecord(doc.metadata), chunkIndex: index, originalId: doc.id }
            });
          }
        }
      }

      if (strategy === "character") {
        // Split by character count
        for (const doc of upstreamDocs) {
          const text = doc.text;
          for (let i = 0; i < text.length; i += chunkSize - chunkOverlap) {
            const chunk = text.slice(i, i + chunkSize);
            if (!chunk.trim()) continue;
            chunkedDocs.push({ id: `${doc.id}-chunk-${chunkedDocs.length}`, text: chunk, metadata: { ...toRecord(doc.metadata), chunkIndex: chunkedDocs.length, originalId: doc.id } });
          }
        }
      }

      if (strategy === "recursive") {
        // Recursively split using multiple separators: \n\n, \n, ". ", " "
        const separators = ["\n\n", "\n", ". ", " "];
        function recursiveSplit(text: string, seps: string[], maxSize: number): string[] {
          if (text.length <= maxSize) return [text];
          const sep = seps[0] || "";
          const parts = sep ? text.split(sep) : [text];
          const chunks: string[] = [];
          let current = "";
          for (const part of parts) {
            const candidate = current ? current + sep + part : part;
            if (candidate.length > maxSize && current) {
              chunks.push(current);
              current = part;
            } else {
              current = candidate;
            }
          }
          if (current) chunks.push(current);
          // Recursively split chunks that are still too large
          const result: string[] = [];
          for (const chunk of chunks) {
            if (chunk.length > maxSize && seps.length > 1) {
              result.push(...recursiveSplit(chunk, seps.slice(1), maxSize));
            } else {
              result.push(chunk);
            }
          }
          return result;
        }
        for (const doc of upstreamDocs) {
          const pieces = recursiveSplit(doc.text, separators, chunkSize);
          for (const piece of pieces) {
            if (!piece.trim()) continue;
            chunkedDocs.push({ id: `${doc.id}-chunk-${chunkedDocs.length}`, text: piece, metadata: { ...toRecord(doc.metadata), chunkIndex: chunkedDocs.length, originalId: doc.id } });
          }
        }
      }

      if (strategy === "token") {
        // Approximate token-based splitting (1 token ≈ 4 chars)
        const charsPerToken = 4;
        const charLimit = chunkSize * charsPerToken;
        const charOverlap = chunkOverlap * charsPerToken;
        for (const doc of upstreamDocs) {
          const text = doc.text;
          for (let i = 0; i < text.length; i += charLimit - charOverlap) {
            // Try to break at word boundaries
            let end = Math.min(i + charLimit, text.length);
            if (end < text.length) {
              const lastSpace = text.lastIndexOf(" ", end);
              if (lastSpace > i + charLimit * 0.8) end = lastSpace;
            }
            const chunk = text.slice(i, end).trim();
            if (!chunk) continue;
            chunkedDocs.push({ id: `${doc.id}-chunk-${chunkedDocs.length}`, text: chunk, metadata: { ...toRecord(doc.metadata), chunkIndex: chunkedDocs.length, originalId: doc.id } });
          }
        }
      }

      return {
        documents: chunkedDocs,
        count: chunkedDocs.length
      };
    }

    case "embeddings_azure_openai": {
      const endpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
      const deployment = typeof config.deployment === "string" ? config.deployment.trim() : "";
      if (!endpoint || !deployment) {
        throw new Error("Embeddings Azure OpenAI requires endpoint and deployment.");
      }

      const inputKey = typeof config.inputKey === "string" && config.inputKey.trim() ? config.inputKey.trim() : "user_prompt";
      const outputKey = typeof config.outputKey === "string" && config.outputKey.trim() ? config.outputKey.trim() : "embedding";
      const inputText = String(readData(templateData, inputKey) ?? readData(templateData, "user_prompt") ?? "");
      if (!inputText.trim()) {
        throw new Error("Embeddings Azure OpenAI requires non-empty input text.");
      }

      const secret = await dependencies.resolveSecret(normalizeSecretRef(config.secretRef));
      const apiKey = typeof secret === "string" ? secret.trim() : "";
      if (!apiKey) {
        throw new Error("Embeddings Azure OpenAI requires secretRef credential.");
      }

      const embedder = new AzureOpenAIEmbeddingAdapter({
        endpoint,
        // The endpoint is node config, so it goes through the outbound guard (pinned).
        fetcher: guardedRagFetch(dependencies),
        deployment,
        apiVersion:
          typeof config.apiVersion === "string" && config.apiVersion.trim()
            ? config.apiVersion.trim()
            : "2024-10-21",
        apiKey
      });
      const vector = await embedder.embed(inputText);
      return {
        [outputKey]: vector,
        embedding: vector,
        model: deployment,
        dimensions: vector.length
      };
    }

    case "rag_retrieve": {
      const queryTemplate = typeof config.queryTemplate === "string" ? config.queryTemplate : "{{user_prompt}}";
      // Phase 16 — the query the outbound check judged, when one did.
      const query = outbound?.override.kind === "rag" ? outbound.override.query : renderTemplate(queryTemplate, templateData).trim();
      const topK = typeof config.topK === "number" && config.topK > 0 ? Math.floor(config.topK) : 3;

      const inlineDocs = normalizeDocuments(config.documents);
      const upstreamDocs = normalizeDocuments(readData(templateData, "documents"));
      const allDocs = [...upstreamDocs, ...inlineDocs];

      const embedderId = typeof config.embedderId === "string" ? config.embedderId : "token-embedder";
      const vectorStoreId = typeof config.vectorStoreId === "string" ? config.vectorStoreId : "in-memory-vector-store";
      const vectorStoreConfig = toRecord(config.vectorStoreConfig);
      // An endpoint or baseUrl set on the node (not a deployment env fallback) goes through the outbound guard.
      const nodeFetch = (key: "endpoint" | "baseUrl") =>
        typeof vectorStoreConfig[key] === "string" && String(vectorStoreConfig[key]).trim() ? guardedRagFetch(dependencies) : undefined;
      // The deployment's env key only ever goes to the deployment's own endpoint. When the node names its own
      // endpoint (or baseUrl), only the node's secret is sent there, or no key at all.
      const ragKey = async (envName: string, endpointKey: "endpoint" | "baseUrl"): Promise<string | undefined> => {
        const ref = config.embeddingSecretRef;
        if (typeof ref === "object" && ref) return dependencies.resolveSecret(ref as SecretReference);
        if (nodeFetch(endpointKey)) return undefined;
        return process.env[envName];
      };

      let embedder = dependencies.embeddingRegistry?.get(embedderId);
      if (!embedder) {
        if (embedderId === "token-embedder") embedder = new TokenEmbeddingAdapter();
        else if (embedderId === "openai-embedder") {
           const apiKey = await ragKey("OPENAI_API_KEY", "baseUrl");
           embedder = new OpenAIEmbeddingAdapter({ apiKey: apiKey || "", ...vectorStoreConfig, fetcher: nodeFetch("baseUrl") });
        } else if (embedderId === "azure-openai-embedder") {
           const apiKey = await ragKey("AZURE_OPENAI_API_KEY", "endpoint");
           const endpoint = typeof vectorStoreConfig.endpoint === "string" ? vectorStoreConfig.endpoint : process.env.AZURE_OPENAI_ENDPOINT;
           const deployment =
             typeof vectorStoreConfig.deployment === "string" && vectorStoreConfig.deployment.trim()
               ? vectorStoreConfig.deployment
               : typeof vectorStoreConfig.model === "string"
                 ? vectorStoreConfig.model
                 : "text-embedding-3-small";
           embedder = new AzureOpenAIEmbeddingAdapter({
             endpoint: endpoint || "",
             fetcher: nodeFetch("endpoint"),
             deployment,
             apiVersion: typeof vectorStoreConfig.apiVersion === "string" ? vectorStoreConfig.apiVersion : process.env.AZURE_OPENAI_API_VERSION,
             apiKey: apiKey || ""
           });
        } else if (embedderId === "cohere-embedder") {
           const apiKeyRef = config.embeddingSecretRef;
           const apiKey = typeof apiKeyRef === "object" && apiKeyRef ? await dependencies.resolveSecret(apiKeyRef as SecretReference) : process.env.COHERE_API_KEY;
           embedder = new CohereEmbeddingAdapter({ apiKey: apiKey || "", model: typeof vectorStoreConfig.model === "string" ? vectorStoreConfig.model : undefined });
        } else if (embedderId === "mistral-embedder") {
           const apiKeyRef = config.embeddingSecretRef;
           const apiKey = typeof apiKeyRef === "object" && apiKeyRef ? await dependencies.resolveSecret(apiKeyRef as SecretReference) : process.env.MISTRAL_API_KEY;
           embedder = new MistralEmbeddingAdapter({ apiKey: apiKey || "", model: typeof vectorStoreConfig.model === "string" ? vectorStoreConfig.model : undefined });
        } else if (embedderId === "google-vertex-embedder") {
           const apiKeyRef = config.embeddingSecretRef;
           const apiKey = typeof apiKeyRef === "object" && apiKeyRef ? await dependencies.resolveSecret(apiKeyRef as SecretReference) : process.env.GEMINI_API_KEY;
           embedder = new GoogleVertexEmbeddingAdapter({ apiKey: apiKey || "", model: typeof vectorStoreConfig.model === "string" ? vectorStoreConfig.model : undefined });
        } else if (embedderId === "huggingface-embedder") {
           const apiKeyRef = config.embeddingSecretRef;
           const apiKey = typeof apiKeyRef === "object" && apiKeyRef ? await dependencies.resolveSecret(apiKeyRef as SecretReference) : process.env.HUGGINGFACE_API_KEY;
           embedder = new HuggingFaceEmbeddingAdapter({ apiKey: apiKey || "", model: typeof vectorStoreConfig.model === "string" ? vectorStoreConfig.model : undefined });
        }
        else throw new Error(`Unknown embedder ID: ${embedderId}`);
      }

      let store = dependencies.vectorStoreRegistry?.get(vectorStoreId);
      if (!store) {
         if (vectorStoreId === "in-memory-vector-store") store = new InMemoryVectorStoreAdapter();
         else if (vectorStoreId === "pinecone-vector-store") {
           const apiKeyRef = config.embeddingSecretRef;
           const apiKey = typeof apiKeyRef === "object" && apiKeyRef ? await dependencies.resolveSecret(apiKeyRef as SecretReference) : process.env.PINECONE_API_KEY;
           store = new PineconeVectorStoreAdapter({ apiKey: apiKey || "", indexName: typeof vectorStoreConfig.indexName === "string" ? vectorStoreConfig.indexName : "" });
         } else if (vectorStoreId === "pgvector-store") {
           const connRef = config.embeddingSecretRef;
           const connStr = typeof connRef === "object" && connRef ? await dependencies.resolveSecret(connRef as SecretReference) : process.env.DATABASE_URL;
           store = new PGVectorStoreAdapter({ connectionString: connStr || "", tableName: typeof vectorStoreConfig.tableName === "string" ? vectorStoreConfig.tableName as string : "vectors" });
         } else if (vectorStoreId === "azure-ai-search-vector-store") {
           const apiKey = await ragKey("AZURE_AI_SEARCH_API_KEY", "endpoint");
           store = new AzureAiSearchVectorStoreAdapter({
             fetcher: nodeFetch("endpoint"),
             endpoint: typeof vectorStoreConfig.endpoint === "string" ? vectorStoreConfig.endpoint : process.env.AZURE_AI_SEARCH_ENDPOINT || "",
             indexName: typeof vectorStoreConfig.indexName === "string" ? vectorStoreConfig.indexName : "",
             apiVersion: typeof vectorStoreConfig.apiVersion === "string" ? vectorStoreConfig.apiVersion : undefined,
             vectorField: typeof vectorStoreConfig.vectorField === "string" ? vectorStoreConfig.vectorField : undefined,
             contentField: typeof vectorStoreConfig.contentField === "string" ? vectorStoreConfig.contentField : undefined,
             idField: typeof vectorStoreConfig.idField === "string" ? vectorStoreConfig.idField : undefined,
             metadataField: typeof vectorStoreConfig.metadataField === "string" ? vectorStoreConfig.metadataField : undefined,
             apiKey: apiKey || ""
           });
         } else if (vectorStoreId === "qdrant-vector-store") {
           const apiKey = await ragKey("QDRANT_API_KEY", "endpoint");
           const parsedFilter = (() => {
             const raw = vectorStoreConfig.filter;
             if (raw && typeof raw === "object" && !Array.isArray(raw)) {
               return raw as Record<string, unknown>;
             }
             if (typeof vectorStoreConfig.filterJson === "string" && vectorStoreConfig.filterJson.trim()) {
               try {
                 const parsed = JSON.parse(vectorStoreConfig.filterJson);
                 return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                   ? (parsed as Record<string, unknown>)
                   : undefined;
               } catch {
                 return undefined;
               }
             }
             return undefined;
           })();
           store = new QdrantVectorStoreAdapter({
             fetcher: nodeFetch("endpoint"),
             endpoint:
               typeof vectorStoreConfig.endpoint === "string"
                 ? vectorStoreConfig.endpoint
                 : process.env.QDRANT_ENDPOINT || "",
             collectionName:
               typeof vectorStoreConfig.collectionName === "string"
                 ? vectorStoreConfig.collectionName
                 : typeof vectorStoreConfig.collection === "string"
                   ? vectorStoreConfig.collection
                   : "",
             apiKey: apiKey || "",
             apiKeyHeaderName:
               typeof vectorStoreConfig.apiKeyHeaderName === "string"
                 ? vectorStoreConfig.apiKeyHeaderName
                 : undefined,
             contentField:
               typeof vectorStoreConfig.contentField === "string"
                 ? vectorStoreConfig.contentField
                 : undefined,
             metadataField:
               typeof vectorStoreConfig.metadataField === "string"
                 ? vectorStoreConfig.metadataField
                 : undefined,
             filter: parsedFilter
           });
         } else if (vectorStoreId === "chroma-vector-store") {
           const apiKey = await ragKey("CHROMA_API_KEY", "endpoint");
           store = new ChromaVectorStoreAdapter({
             fetcher: nodeFetch("endpoint"),
             endpoint: typeof vectorStoreConfig.endpoint === "string" ? vectorStoreConfig.endpoint : process.env.CHROMA_ENDPOINT || "http://localhost:8000",
             collectionName: typeof vectorStoreConfig.collectionName === "string" ? vectorStoreConfig.collectionName : "",
             apiKey: apiKey || undefined
           });
         } else if (vectorStoreId === "weaviate-vector-store") {
           const apiKey = await ragKey("WEAVIATE_API_KEY", "endpoint");
           store = new WeaviateVectorStoreAdapter({
             fetcher: nodeFetch("endpoint"),
             endpoint: typeof vectorStoreConfig.endpoint === "string" ? vectorStoreConfig.endpoint : process.env.WEAVIATE_ENDPOINT || "http://localhost:8080",
             className: typeof vectorStoreConfig.className === "string" ? vectorStoreConfig.className : "",
             apiKey: apiKey || undefined
           });
         } else if (vectorStoreId === "redis-vector-store") {
           const apiKey = await ragKey("REDIS_API_KEY", "endpoint");
           store = new RedisVectorStoreAdapter({
             fetcher: nodeFetch("endpoint"),
             endpoint: typeof vectorStoreConfig.endpoint === "string" ? vectorStoreConfig.endpoint : process.env.REDIS_ENDPOINT || "http://localhost:6379",
             indexName: typeof vectorStoreConfig.indexName === "string" ? vectorStoreConfig.indexName : "",
             apiKey: apiKey || undefined
           });
         } else if (vectorStoreId === "knowledge-base") {
           // Phase 9.1 — built-in persistent KB. The KB ID identifies which
           // collection the chunks live in; the embedder set on the KB at
           // creation time is used implicitly here too (same embedderId is
           // expected on the rag_retrieve node).
           const kbId = typeof vectorStoreConfig.knowledgeBaseId === "string"
             ? vectorStoreConfig.knowledgeBaseId
             : typeof config.knowledgeBaseId === "string"
               ? config.knowledgeBaseId
               : "";
           if (!kbId) {
             throw new Error("knowledge-base vector store requires vectorStoreConfig.knowledgeBaseId");
           }
           if (!dependencies.knowledgeBaseStore) {
             throw new Error(
               "knowledge-base vector store unavailable — dependencies.knowledgeBaseStore not wired"
             );
           }
           store = new KnowledgeBaseVectorStoreAdapter(dependencies.knowledgeBaseStore, kbId);
         }
         else throw new Error(`Unknown vector store ID: ${vectorStoreId}`);
      }

      await store.upsert(allDocs, embedder);

      // Phase 9.3 — searchMode picks vector / bm25 / hybrid. Default
      // "vector" preserves Phase 9.1 behavior; bm25 + hybrid only work
      // when the underlying store supports them (currently the
      // KnowledgeBaseVectorStoreAdapter via FTS5).
      const searchMode = typeof config.searchMode === "string" ? config.searchMode : "vector";
      let documents;
      if (searchMode === "hybrid" && store instanceof KnowledgeBaseVectorStoreAdapter) {
        const candidatesPerRanker = typeof config.candidatesPerRanker === "number" && config.candidatesPerRanker > 0
          ? Math.floor(config.candidatesPerRanker)
          : undefined;
        documents = await store.hybridSearch(query, topK, embedder, {
          candidatesPerRanker,
          bm25Weight: typeof config.bm25Weight === "number" ? config.bm25Weight : undefined,
          vectorWeight: typeof config.vectorWeight === "number" ? config.vectorWeight : undefined,
          rrfK: typeof config.rrfK === "number" ? config.rrfK : undefined
        });
      } else if (searchMode === "bm25" && store instanceof KnowledgeBaseVectorStoreAdapter) {
        documents = await store.bm25Search(query, topK);
      } else {
        if ((searchMode === "hybrid" || searchMode === "bm25") && !(store instanceof KnowledgeBaseVectorStoreAdapter)) {
          // Vector-only fallback when the user asked for hybrid/bm25 but
          // the store doesn't implement them (e.g. Pinecone). Documented
          // behavior — surfaces in the node output via metadata.
        }
        documents = await store.similaritySearch(query, topK, embedder);
      }

      return {
        query,
        documents,
        context: documents.map((doc, index) => `[${index + 1}] ${doc.text}`).join("\n"),
        // Phase 9.4 — drop into a prompt template (e.g. {{citationInstructions}})
        // to teach the model to emit [N] markers that extract_citations
        // can resolve back to chunks.
        citationInstructions: DEFAULT_CITATION_INSTRUCTIONS
      };
    }

    case "rerank": {
      // Phase 9.3 — cross-encoder reranking. Pulls candidate docs from
      // upstream (typically a rag_retrieve node), scores each (query, doc)
      // pair via a hosted cross-encoder, and returns top-N by relevance.
      const queryTemplate = typeof config.queryTemplate === "string" ? config.queryTemplate : "{{user_prompt}}";
      // Phase 16 — the query the outbound check judged, when one did.
      const query = outbound?.override.kind === "rag" ? outbound.override.query : renderTemplate(queryTemplate, templateData).trim();
      const topN = typeof config.topN === "number" && config.topN > 0 ? Math.floor(config.topN) : 3;
      const providerId = typeof config.providerId === "string" ? config.providerId : "cohere";

      const upstreamDocs = normalizeDocuments(readData(templateData, "documents"));
      if (upstreamDocs.length === 0) {
        return { query, documents: [], context: "" };
      }

      const apiKeyRef = config.secretRef;
      const apiKey =
        typeof apiKeyRef === "object" && apiKeyRef
          ? await dependencies.resolveSecret(apiKeyRef as SecretReference)
          : providerId === "cohere"
            ? process.env.COHERE_API_KEY
            : providerId === "jina"
              ? process.env.JINA_API_KEY
              : providerId === "voyage"
                ? process.env.VOYAGE_API_KEY
                : undefined;
      if (!apiKey) {
        throw new Error(
          `Reranker "${providerId}" requires an API key — pass via secretRef or set ${providerId.toUpperCase()}_API_KEY`
        );
      }

      const model = typeof config.model === "string" ? config.model : undefined;
      let adapter: RerankAdapter;
      if (providerId === "cohere") {
        adapter = new CohereRerankAdapter({ apiKey, model });
      } else if (providerId === "jina") {
        adapter = new JinaRerankAdapter({ apiKey, model });
      } else if (providerId === "voyage") {
        adapter = new VoyageRerankAdapter({ apiKey, model });
      } else {
        throw new Error(`Unknown reranker providerId: ${providerId}`);
      }

      const documents = await adapter.rerank({ query, documents: upstreamDocs, topN });
      return {
        query,
        documents,
        context: documents.map((doc, index) => `[${index + 1}] ${doc.text}`).join("\n"),
        citationInstructions: DEFAULT_CITATION_INSTRUCTIONS
      };
    }

    case "web_browse": {
      // Drive headless Chromium to fetch a URL and extract structured page
      // data. URL can be supplied verbatim (config.url) or templated
      // (config.urlTemplate); the templated form lets upstream nodes feed
      // dynamic URLs in.
      let url: string | undefined;
      if (outbound?.override.kind === "browse") {
        // Phase 16 — the address the outbound check judged.
        url = outbound.override.url;
      } else if (typeof config.url === "string" && config.url.trim()) {
        url = config.url.trim();
      } else if (typeof config.urlTemplate === "string" && config.urlTemplate.trim()) {
        url = renderTemplate(config.urlTemplate, templateData).trim();
      }
      if (!url) {
        throw new Error("web_browse node requires either config.url or config.urlTemplate");
      }

      let extraHeaders: Record<string, string> | undefined;
      if (typeof config.extraHeadersJson === "string" && config.extraHeadersJson.trim()) {
        try {
          const parsed = JSON.parse(config.extraHeadersJson);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            extraHeaders = Object.fromEntries(
              Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)])
            );
          }
        } catch {
          throw new Error("web_browse: extraHeadersJson must be a JSON object");
        }
      }

      const viewportWidth = typeof config.viewportWidth === "number" && config.viewportWidth > 0
        ? Math.floor(config.viewportWidth)
        : undefined;
      const viewportHeight = typeof config.viewportHeight === "number" && config.viewportHeight > 0
        ? Math.floor(config.viewportHeight)
        : undefined;
      const viewport = viewportWidth && viewportHeight
        ? { width: viewportWidth, height: viewportHeight }
        : undefined;

      const screenshotOption: WebBrowseOptions["screenshot"] = config.screenshot === false
        ? false
        : config.screenshot === "fullPage"
          ? "fullPage"
          : true;

      const browseJudge = recordingJudge(outbound?.judgeUrl);
      const browseOptions: WebBrowseOptions = {
        url,
        ...(typeof config.waitUntil === "string"
          ? { waitUntil: config.waitUntil as WebBrowseOptions["waitUntil"] }
          : {}),
        ...(typeof config.timeoutMs === "number" && config.timeoutMs > 0
          ? { timeoutMs: Math.floor(config.timeoutMs) }
          : {}),
        ...(typeof config.userAgent === "string" && config.userAgent.trim()
          ? { userAgent: config.userAgent.trim() }
          : {}),
        ...(extraHeaders ? { extraHeaders } : {}),
        ...(viewport ? { viewport } : {}),
        screenshot: screenshotOption,
        ...(config.extractText === false ? { extractText: false } : {}),
        ...(config.extractLinks === false ? { extractLinks: false } : {}),
        ...(config.extractImages === false ? { extractImages: false } : {}),
        ...(typeof config.waitForSelector === "string" && config.waitForSelector.trim()
          ? { waitForSelector: config.waitForSelector.trim() }
          : {}),
        // Phase 16 — under destination rules every later load (redirects, navigations, sub-resources) is judged too.
        requestGuard: playwrightOutboundGuard(dependencies.outboundGuard ?? DEFAULT_OUTBOUND_GUARD, dependencies.outboundDnsResolver, browseJudge.judge),
        webSocketGuard: playwrightWebSocketGuard(dependencies.outboundGuard ?? DEFAULT_OUTBOUND_GUARD, dependencies.outboundDnsResolver, browseJudge.judge)
      };

      const outputKey = typeof config.outputKey === "string" && config.outputKey.trim()
        ? config.outputKey.trim()
        : "page";

      const result = await browseJudge.run(() => browseUrl(browseOptions));
      return {
        [outputKey]: result,
        // Mirror the most-used fields at the top level so downstream
        // template nodes can reference them without nesting.
        url: result.finalUrl,
        title: result.title,
        text: result.text,
        html: result.html,
        screenshot: result.screenshot,
        meta: result.meta,
        links: result.links,
        images: result.images
      };
    }

    case "chart": {
      // Render a Vega-Lite spec to SVG. The spec can be supplied either:
      //   - inline as a config.spec object (LLM-generated specs land here),
      //   - or as a config.specTemplate string with {{...}} placeholders that
      //     resolve from upstream data, then JSON.parse'd.
      // Data is either embedded in the spec (data.values) or pointed at via
      // config.dataPath which resolves against templateData.
      let specObject: Record<string, unknown> | null = null;
      if (config.spec && typeof config.spec === "object" && !Array.isArray(config.spec)) {
        specObject = config.spec as Record<string, unknown>;
      } else if (typeof config.specTemplate === "string" && config.specTemplate.trim()) {
        const rendered = renderTemplate(config.specTemplate, templateData);
        try {
          const parsed = JSON.parse(rendered);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            specObject = parsed as Record<string, unknown>;
          }
        } catch (err) {
          throw new Error(
            `chart specTemplate did not produce valid JSON after interpolation: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
      if (!specObject) {
        throw new Error("chart node requires either config.spec (object) or config.specTemplate (string)");
      }

      const dataPath = typeof config.dataPath === "string" && config.dataPath.trim()
        ? config.dataPath.trim()
        : undefined;
      const dataValue = dataPath ? resolveDottedPathRead(templateData, dataPath) : undefined;
      const data = Array.isArray(dataValue) ? dataValue : undefined;

      const width = typeof config.width === "number" && config.width > 0 ? Math.floor(config.width) : undefined;
      const height = typeof config.height === "number" && config.height > 0 ? Math.floor(config.height) : undefined;
      const themeConfig =
        config.theme && typeof config.theme === "object" && !Array.isArray(config.theme)
          ? (config.theme as Record<string, unknown>)
          : undefined;

      const outputKey = typeof config.outputKey === "string" && config.outputKey.trim() ? config.outputKey.trim() : "chart";

      // Vega draws without data whose load failed: the recording judge fails the node with the guard's reason instead.
      const chartGuard = recordingJudge(dependencies.replayNodeHook ? undefined : (await renderUrlJudge(node, context, dependencies)) ?? undefined);
      const chartJudge = chartGuard.judge;
      const result = await chartGuard.run(() => renderChart({
        spec: specObject,
        data,
        width,
        height,
        config: themeConfig,
        // Phase 15.1 — a replay never lets a chart load data from a URL or file.
        offline: Boolean(dependencies.replayNodeHook),
        // Live charts run every data/image URL through the outbound guard, and fetch over a pinned connection.
        // Phase 16 — under destination rules each URL (and each redirect) is judged as egress before it is loaded.
        urlGuard: async (url: string) => {
          await assertOutboundUrlAllowed(url, dependencies.outboundGuard ?? DEFAULT_OUTBOUND_GUARD, dependencies.outboundDnsResolver);
          if (chartJudge) await chartJudge(url, []);
        },
        fetcher: (url: string) =>
          guardedFetch(url, {}, {
            config: dependencies.outboundGuard ?? DEFAULT_OUTBOUND_GUARD,
            ...(dependencies.outboundDnsResolver ? { resolver: dependencies.outboundDnsResolver } : {}),
            ...(chartJudge ? { onRedirect: (next: string) => chartJudge(next, [url]) } : {})
          })
      }));

      return {
        [outputKey]: {
          svg: result.svg,
          dataUrl: result.dataUrl
        },
        svg: result.svg,
        dataUrl: result.dataUrl,
        // Useful for chaining: an <img> tag the caller can drop into pdf_output's htmlTemplate.
        imgTag: `<img src="${result.dataUrl}" alt="chart" />`
      };
    }

    case "extract_citations": {
      // Phase 9.4 — resolves [N] / [chunkId] markers in an LLM answer back
      // to the upstream documents. Pure post-processing — the answer text
      // is preserved verbatim so downstream nodes / the UI can render
      // markers as React links using the returned offsets.
      const answerPath = typeof config.answerPath === "string" && config.answerPath.trim()
        ? config.answerPath.trim()
        : "answer";
      const documentsPath = typeof config.documentsPath === "string" && config.documentsPath.trim()
        ? config.documentsPath.trim()
        : "documents";

      const answerRaw = resolveDottedPathRead(templateData, answerPath);
      const answer = typeof answerRaw === "string"
        ? answerRaw
        : answerRaw === undefined || answerRaw === null
          ? ""
          : String(answerRaw);
      const documents = normalizeDocuments(resolveDottedPathRead(templateData, documentsPath));

      const result = extractCitationsFromText(answer, documents);
      return {
        answer: result.answer,
        citations: result.citations,
        uniqueCitedDocuments: result.uniqueCitedDocuments,
        hasCitations: result.hasCitations,
        documents // pass through so downstream nodes still see them
      };
    }

    case "local_memory": {
      const namespaceTemplate =
        typeof config.namespace === "string" && config.namespace.trim()
          ? config.namespace
          : `${context.workflow.id}:${node.id}`;
      const sessionTemplate = typeof config.sessionIdTemplate === "string" ? config.sessionIdTemplate : "{{session_id}}";
      const maxMessages = typeof config.maxMessages === "number" && config.maxMessages > 0 ? Math.floor(config.maxMessages) : 20;
      const sessionId = renderTemplate(sessionTemplate, templateData).trim();
      const namespace = renderTemplate(namespaceTemplate, templateData).trim() || `${context.workflow.id}:${node.id}`;

      if (!sessionId || !dependencies.memoryStore) {
        return {
          namespace,
          sessionId,
          maxMessages,
          messages: []
        };
      }

      const messages = await dependencies.memoryStore.loadMessages(namespace, sessionId);
      // Phase 16 — what earlier runs stored with this memory comes along (older rows have no labels: nothing added).
      if (context.labelScope?.run.tracked && messages.length > 0 && dependencies.memoryStore.loadLabels) {
        context.labelScope.add(await dependencies.memoryStore.loadLabels(namespace, sessionId));
      }
      return {
        namespace,
        sessionId,
        maxMessages,
        messages: messages.slice(-maxMessages)
      };
    }

    case "session_artifact_load": {
      if (!dependencies.sessionArtifactStore) {
        throw new Error("Session Artifact Load requires a sessionArtifactStore dependency.");
      }

      const scope = resolveSessionArtifactScope(config, templateData, context.workflow, node);
      const outputKey = typeof config.outputKey === "string" && config.outputKey.trim() ? config.outputKey.trim() : "artifact";
      if (!scope.sessionId) {
        return {
          ...context.merged,
          namespace: scope.namespace,
          sessionId: scope.sessionId,
          artifactKey: scope.artifactKey,
          found: false,
          [outputKey]: null,
          artifact: null,
          session_artifact: null,
          reason: "missing_session_id"
        };
      }

      const record = await dependencies.sessionArtifactStore.loadArtifact(scope);
      const artifact = record?.value ?? null;
      // Phase 16 — what the run that saved it read comes along (rows saved while labels were not tracked add nothing).
      context.labelScope?.add(record?.labels ?? null);
      return {
        ...context.merged,
        namespace: scope.namespace,
        sessionId: scope.sessionId,
        artifactKey: scope.artifactKey,
        found: Boolean(record),
        [outputKey]: artifact,
        artifact,
        session_artifact: record
          ? {
              namespace: record.namespace,
              sessionId: record.sessionId,
              artifactKey: record.artifactKey,
              value: record.value,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt
            }
          : null
      };
    }

    case "session_artifact_save": {
      if (!dependencies.sessionArtifactStore) {
        throw new Error("Session Artifact Save requires a sessionArtifactStore dependency.");
      }

      const scope = resolveSessionArtifactScope(config, templateData, context.workflow, node);
      const outputKey = typeof config.outputKey === "string" && config.outputKey.trim() ? config.outputKey.trim() : "saved_artifact";
      const value = buildSessionArtifactValue(config, templateData);
      // Phase 16 — without configured fields the whole template data is saved: every completed node and the run input.
      if (value === templateData) context.labelScope?.readEverything();
      if (!scope.sessionId) {
        return {
          ...context.merged,
          namespace: scope.namespace,
          sessionId: scope.sessionId,
          artifactKey: scope.artifactKey,
          saved: false,
          [outputKey]: value,
          artifact: value,
          reason: "missing_session_id"
        };
      }

      // Phase 16 — on a tracked run the artifact keeps the labels of what it saved, for the runs that load it.
      const artifactLabels = context.labelScope?.run.tracked ? context.labelScope.inputLabels() : undefined;
      const saved = await dependencies.sessionArtifactStore.saveArtifact({
        ...scope,
        value,
        ...(artifactLabels ? { labels: artifactLabels } : {})
      });
      // Labels stay beside outputs, never inside them.
      const { labels: _savedLabels, ...record } = saved;
      return {
        ...context.merged,
        namespace: record.namespace,
        sessionId: record.sessionId,
        artifactKey: record.artifactKey,
        saved: true,
        [outputKey]: record.value,
        artifact: record.value,
        session_artifact: record
      };
    }

    case "chat_intent_router": {
      const outputKey = normalizeLabel(config.outputKey, "intent");
      const inputTemplate = typeof config.inputTemplate === "string" && config.inputTemplate.trim()
        ? config.inputTemplate
        : "{{user_prompt}}";
      const intentKey = typeof config.intentKey === "string" ? config.intentKey.trim() : "parsed.intent";
      const artifactPath = typeof config.artifactPath === "string" ? config.artifactPath.trim() : "latest_report";
      const reportKeywords = normalizeKeywordList(config.reportKeywords, [
        "report",
        "pdf",
        "dashboard",
        "chart",
        "analytics",
        "summary",
        "visualize",
        "visualization"
      ]);
      const codeKeywords = normalizeKeywordList(config.codeKeywords, [
        "python",
        "code",
        "script",
        "automate",
        "automation",
        "nightly",
        "regenerate",
        "reproduce",
        "without ai",
        "without l2m"
      ]);

      const explicitIntent = intentKey ? normalizeChatIntent(getValueByPath(templateData, intentKey)) : undefined;
      const renderedMessage = renderTemplate(inputTemplate, templateData);
      const inferred = explicitIntent
        ? { intent: explicitIntent, source: "explicit" }
        : inferHelperChatIntent(renderedMessage, reportKeywords, codeKeywords);
      const artifactValue = artifactPath ? getValueByPath(templateData, artifactPath) : undefined;
      const artifactAvailable = hasSessionArtifactValue(artifactValue);
      const requiresArtifact = config.requireArtifactForCode === true;
      const route =
        inferred.intent === "code" && requiresArtifact && !artifactAvailable
          ? "missing_context"
          : inferred.intent === "report"
            ? "report"
            : inferred.intent === "code"
              ? "code"
              : "message";

      return {
        ...branchPassthrough(templateData),
        [outputKey]: inferred.intent,
        intent: inferred.intent,
        route,
        intentSource: inferred.source,
        artifactAvailable,
        requiresArtifact,
        _branchHandle: route,
        _branchHandleFallback: route
      };
    }

    case "helper_chat_response": {
      const outputKey = normalizeLabel(config.outputKey, "answer");
      const statusValue = resolveStringByConfiguredPath(config, "statusKey", templateData, "parsed.status", "complete").trim();
      const status = statusValue === "needs_more_info" ? "needs_more_info" : "complete";
      const finalHtml = resolveStringByConfiguredPath(config, "finalHtmlKey", templateData, "parsed.final_html");
      const pythonCode = resolveStringByConfiguredPath(config, "pythonCodeKey", templateData, "parsed.python_code");
      const followUpQuestion = resolveStringByConfiguredPath(
        config,
        "followUpQuestionKey",
        templateData,
        "parsed.follow_up_question"
      );
      const message = resolveStringByConfiguredPath(config, "messageKey", templateData, "parsed.message");
      const codeLanguage = normalizeLabel(config.codeLanguage, "python");
      const chartData =
        resolveValueByConfiguredPath(config, "chartDataKey", templateData, "parsed.chart_data") ??
        { title: "Chart data", labels: [], values: [] };
      const artifactContext =
        resolveValueByConfiguredPath(config, "artifactContextKey", templateData, "parsed.artifact_context") ?? {};

      const attachments: Record<string, unknown>[] = [];
      const includePdfAttachment = config.includePdfAttachment !== false;
      if (includePdfAttachment) {
        const pdfValue = resolveValueByConfiguredPath(config, "pdfKey", templateData, "pdf");
        const pdfAttachment = normalizeHelperChatAttachment(pdfValue);
        if (pdfAttachment) {
          attachments.push(pdfAttachment);
        }
      }

      const codes = pythonCode.trim()
        ? [{ language: codeLanguage, source: pythonCode }]
        : [];

      const answer: Record<string, unknown> = {
        status,
        final_html: finalHtml,
        python_code: pythonCode,
        follow_up_question: followUpQuestion,
        chart_data: chartData,
        artifact_context: artifactContext,
        codes,
        attachments
      };
      if (message.trim()) {
        answer.message = message;
      }

      return {
        [outputKey]: answer,
        answer,
        result: answer,
        codes,
        attachments
      };
    }

    case "mcp_tool": {
      const serverId = String(config.serverId ?? "");
      const toolName = String(config.toolName ?? "");
      const operation = config.operation === "read_resource" ? "read_resource" : "call_tool";
      if (operation === "call_tool" && toolName.trim() === ALL_MCP_TOOLS_SENTINEL) {
        throw new Error("Direct MCP Tool execution requires a specific tool name (single-tool mode).");
      }
      const argsTemplate = typeof config.argsTemplate === "string" ? config.argsTemplate : "{}";
      // Phase 12.4 — the rendered template, kept so the tool policy can refuse one that is not a JSON object.
      const renderedArgs =
        operation === "call_tool" && outbound?.override.kind !== "mcp_args" ? renderTemplate(argsTemplate, templateData) : undefined;
      const args =
        outbound?.override.kind === "mcp_args" && operation === "call_tool"
          ? outbound.override.args
          : renderedArgs !== undefined
            ? tryParseJson(renderedArgs)
            : {};
      const serverConfig = await applyRegisteredMcpServer(
        {
          serverId,
          registryServerId: readRegistryServerId(config),
          connection: toRecord(config.connection),
          secretRef: config.secretRef as SecretReference | undefined,
          allowedTools: Array.isArray(config.allowedTools)
            ? config.allowedTools.map((tool) => String(tool))
            : undefined
        },
        dependencies,
        context.toolPolicySubject
      );
      emitNodeActivity(dependencies, node.id, {
        kind: "resolved_input",
        fields: {
          serverId: serverConfig.registryServerId ?? serverConfig.serverId,
          toolName,
          ...(operation === "call_tool" ? { argsPreview: previewForActivity(JSON.stringify(args) ?? "") } : {})
        }
      });

      // Phase 10.2 — policy first (no server call needed), then the
      // workflow's "no write tools" switch, which may need the tool's
      // annotations from tools/list.
      const toolPolicy = await buildRunToolPolicy(context, dependencies);
      // A per-node context keeps a spawned stdio server scoped to this call
      // instead of the adapter-wide fallback cache, which would keep it alive
      // for the life of the process. Sampling has no attached model here, so
      // only a server with a default sampling model can use it.
      const directMcp = createNodeMcpContext(dependencies, node.id, {
        serverConfigs: [serverConfig],
        ...(toolPolicy ? { evaluatePolicy: toolPolicy.evaluate } : {}),
        checkSampling: samplingGuardFor(node, context, dependencies)
      });
      const directMcpContext = directMcp.context;
      const releaseDirectMcpSessions = createMcpSessionReleaser(dependencies.mcpRegistry, directMcpContext, node.id);
      dependencies.abortSignal?.addEventListener("abort", releaseDirectMcpSessions.onAbort, { once: true });

      if (operation === "read_resource") {
        // Phase 10.5 — read one resource into the workflow instead of calling a tool.
        const uriTemplate = typeof config.resourceUri === "string" ? config.resourceUri : "";
        // Phase 16 — the URI the outbound check judged, when one did.
        const checkedUri = outbound?.override.kind === "mcp_args" ? toRecord(outbound.override.args).uri : undefined;
        const uri = typeof checkedUri === "string" ? checkedUri : renderTemplate(uriTemplate, templateData).trim();
        if (!uri) {
          throw WorkflowError.nodeConfig("MCP Tool node in read-resource mode needs a resource URI.");
        }
        try {
          const read = await readMcpResource({
            uri,
            serverConfig,
            registry: dependencies.mcpRegistry,
            context: directMcpContext,
            ...(dependencies.mcpResourceMaxBytes ? { maxBytes: dependencies.mcpResourceMaxBytes } : {}),
            ...(toolPolicy ? { evaluatePolicy: toolPolicy.evaluate } : {})
          });
          return { ...read, ...mcpTraceFields(directMcp) };
        } finally {
          dependencies.abortSignal?.removeEventListener("abort", releaseDirectMcpSessions.onAbort);
          await releaseDirectMcpSessions.close();
        }
      }

      let result: Awaited<ReturnType<typeof invokeDirectMCPTool>>;
      // Phase 12.4 — the policy decision for this call when a rule matched, for the trace and telemetry.
      let directPolicyDecision: McpToolPolicyDecisionRecord | undefined;
      try {
        if (toolPolicy) {
          const policyTool: McpToolAccessSubjectTool = {
            adapterId: serverConfig.serverId,
            ...(serverConfig.registryServerId ? { registryServerId: serverConfig.registryServerId } : {}),
            ...(serverConfig.label ? { serverLabel: serverConfig.label } : {}),
            ...(serverConfig.connection ? { connection: serverConfig.connection } : {}),
            toolName
          };
          // Phase 10.5 — rules with an annotation condition need the tool's hints up front.
          if (toolPolicy.needsAnnotations) {
            const annotations = await discoverToolAnnotations(serverConfig, toolName, dependencies.mcpRegistry, directMcpContext);
            if (annotations) {
              policyTool.annotations = annotations;
            }
          }
          // Phase 12.4 — the call's arguments and the node's input labels decide argument-aware rules.
          assertPolicyReadableArguments(node, toolPolicy, renderedArgs);
          const callLabels = context.labelScope?.inputLabels();
          // Phase 12.2 — what the decision is recorded with: the labels it read (names only).
          const recordLabels = { labels: callLabels, tracked: context.labelScope?.run.tracked === true };
          const policyCall: McpToolAccessCall = {
            arguments: toRecord(args),
            dataLabels: policyLabels(callLabels)
          };
          let decision = toolPolicy.evaluate(policyTool, policyCall);
          if (
            !decision.allowed &&
            decision.reason === "no_write_tools" &&
            decision.classification.source === "unknown" &&
            !policyTool.annotations
          ) {
            const annotations = await discoverToolAnnotations(serverConfig, toolName, dependencies.mcpRegistry, directMcpContext);
            if (annotations) {
              decision = toolPolicy.evaluate({ ...policyTool, annotations }, policyCall);
            }
          }
          if (!decision.allowed) {
            toolPolicy.record(policyTool, decision, recordLabels);
            throw mcpToolBlockedError(decision.message ?? `MCP tool '${toolName}' is blocked.`, {
              tool: toolName,
              server: serverConfig.serverId,
              ...(serverConfig.registryServerId ? { registryServerId: serverConfig.registryServerId } : {}),
              reason: decision.reason ?? "policy",
              ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
              ...(decision.ruleName ? { ruleName: decision.ruleName } : {})
            });
          }
          if (decision.approval && !dependencies.replayNodeHook) {
            // Phase 12.4 — a require_approval rule: the node pauses, and runs the call once a person approves it.
            const pause = directMcpApprovalPause(node, context, serverConfig, toolName, args, decision.approval);
            const approvalKey = pause.handoff.kind === "rerun" ? pause.handoff.approvalKey : undefined;
            if (!approvalKey || !context.writeToolCalls?.session().takeApproval(approvalKey)) {
              toolPolicy.record(policyTool, decision, { ...recordLabels, approval: "pending" });
              throw new ApprovalHandoffSignal(pause);
            }
            directPolicyDecision = toolPolicy.record(policyTool, decision, { ...recordLabels, approval: "approved" });
          } else {
            directPolicyDecision = toolPolicy.record(policyTool, decision, recordLabels);
          }
        }
        directMcp.samplingHandler.beginCall(toolName);
        result = await invokeDirectMCPTool(serverConfig, toolName, args as Record<string, unknown>, dependencies.mcpRegistry, directMcpContext);
      } finally {
        dependencies.abortSignal?.removeEventListener("abort", releaseDirectMcpSessions.onAbort);
        await releaseDirectMcpSessions.close();
      }

      if (!result.ok) {
        throw new Error(result.error ?? "MCP tool invocation failed");
      }

      const samplingUsage = directMcp.samplingHandler.usage();
      const samplingModel = directMcp.sampling.find((entry) => entry.ok)?.model;
      const samplingProvider = directMcp.sampling.find((entry) => entry.ok)?.providerId;
      return {
        invocation_request: {
          server_id: serverConfig.serverId,
          ...(serverConfig.registryServerId ? { registry_server_id: serverConfig.registryServerId } : {}),
          tool_name: toolName,
          tool_args: args
        },
        tool_output: result.output,
        // Phase 10.5 — the validated structuredContent, for {{results.<node>.structured.<field>}}.
        ...(result.structured ? { structured: result.structured } : {}),
        ...(result.content !== undefined ? { content: result.content } : {}),
        tool_name: toolName,
        ...mcpTraceFields(directMcp),
        // Phase 12.4 — what the tool policy decided for this call, when a rule (enforced or shadow) matched.
        ...(toolPolicy && directPolicyDecision ? { _toolPolicy: toolPolicy.trace } : {}),
        // Phase 12.2 — the labels the decision read (names only), for the call's telemetry row when no rule matched.
        ...(toolPolicy && !directPolicyDecision && toolPolicy.trace.callLabels?.length ? { _toolCallLabels: toolPolicy.trace.callLabels.at(-1)!.labels } : {}),
        // Phase 10.5 — sampling requests the tool made count in the run's usage like any model call.
        ...(directMcp.samplingHandler.requestCount() > 0 && samplingModel && samplingProvider
          ? {
              _telemetry: {
                providerId: samplingProvider,
                model: samplingModel,
                usage: samplingUsage,
                llmCallCount: directMcp.samplingHandler.requestCount(),
                samplingUsage
              }
            }
          : {})
      };
    }

    case "agent_orchestrator":
    case "supervisor_node": {
      const attachedByHandle = context.attachmentsBySource.get(node.id);
      const getAttachedNodes = (handle: AgentAttachmentHandle) => {
        const ids = attachedByHandle?.get(handle) ?? [];
        return ids
          .map((id) => context.nodeById.get(id))
          .filter((attached): attached is WorkflowNode => Boolean(attached));
      };

      const attachedModelNodes = getAttachedNodes("chat_model").filter((attached) => isChatModelNodeType(attached.type));
      const attachedModelNode = attachedModelNodes.length ? attachedModelNodes[attachedModelNodes.length - 1] : undefined;
      const provider = attachedModelNode ? buildProviderFromModelNode(attachedModelNode) : undefined;
      if (!provider) {
        throw new Error("Agent Orchestrator requires an attached Chat Model node on chat_model.");
      }
      if (attachedModelNode) {
        assertChatModelCredentials(attachedModelNode, provider);
      }

      const maxIterations = typeof config.maxIterations === "number" ? Math.max(1, Math.floor(config.maxIterations)) : 4;
      const toolCallingEnabled = config.toolCallingEnabled !== false;
      const toOptionalPositiveInteger = (value: unknown): number | undefined => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 1) {
          return undefined;
        }
        return Math.floor(parsed);
      };
      const toolOutputLimits = {
        messageMaxChars: toOptionalPositiveInteger(config.toolMessageMaxChars),
        payloadMaxDepth: toOptionalPositiveInteger(config.toolPayloadMaxDepth),
        payloadMaxObjectKeys: toOptionalPositiveInteger(config.toolPayloadMaxObjectKeys),
        payloadMaxArrayItems: toOptionalPositiveInteger(config.toolPayloadMaxArrayItems),
        payloadMaxStringChars: toOptionalPositiveInteger(config.toolPayloadMaxStringChars)
      };
      const hasCustomToolOutputLimits = Object.values(toolOutputLimits).some((value) => value !== undefined);

      const systemTemplate =
        typeof config.systemPromptTemplate === "string" ? config.systemPromptTemplate : "{{system_prompt}}";
      const userTemplate = typeof config.userPromptTemplate === "string" ? config.userPromptTemplate : "{{user_prompt}}";
      const sessionTemplate = typeof config.sessionIdTemplate === "string" ? config.sessionIdTemplate : "{{session_id}}";
      let systemPrompt = renderTemplate(systemTemplate, templateData);
      // Phase 16 — the user prompt's reads are kept apart: a guard rewrite of the prompt declassifies them alone.
      let userPrompt = context.labelScope
        ? context.labelScope.segment(AGENT_USER_PROMPT_SEGMENT, () => renderTemplate(userTemplate, templateData))
        : renderTemplate(userTemplate, templateData);
      // Phase 10.5 — a registry server prompt can replace the system or user prompt; it is fetched below.
      const serverPromptBinding = readServerPromptBinding(config.serverPrompt);

      // --- Empty prompt guard ---
      if (!userPrompt.trim() && serverPromptBinding?.target !== "user") {
        const webhookData = toRecord(templateData.webhook);
        const fallbackUserPrompt =
          (typeof templateData.user_prompt === "string" && templateData.user_prompt.trim()) ||
          (typeof webhookData.user_prompt === "string" && (webhookData.user_prompt as string).trim()) ||
          (typeof webhookData.message === "string" && (webhookData.message as string).trim()) ||
          "";
        if (!fallbackUserPrompt) {
          throw WorkflowError.nodeConfig("Agent Orchestrator user prompt is empty after template rendering. Check your template variables or webhook payload.");
          throw new Error("Agent Orchestrator user prompt is empty after template rendering. Check your template variables or webhook payload.");
        }
      }
      const resolvedSessionId = renderTemplate(sessionTemplate, templateData).trim();
      const sessionId =
        resolvedSessionId || (typeof templateData.session_id === "string" ? String(templateData.session_id) : undefined);
      const modelMessages = [] as Array<{ role: "system" | "user"; content: string }>;
      const inlineServerConfigs = Array.isArray(config.mcpServers)
        ? config.mcpServers
            .map((entry) => toRecord(entry))
            .filter((entry) => typeof entry.serverId === "string" || readRegistryServerId(entry) !== undefined)
            .map(
              (entry) =>
                ({
                  serverId: typeof entry.serverId === "string" ? entry.serverId : "",
                  registryServerId: readRegistryServerId(entry),
                  label: typeof entry.label === "string" ? entry.label : undefined,
                  connection: toRecord(entry.connection),
                  secretRef: entry.secretRef as SecretReference | undefined,
                  allowedTools: Array.isArray(entry.allowedTools)
                      ? entry.allowedTools.map((tool) => String(tool))
                      : undefined
                }) satisfies MCPServerConfig
            )
        : [];

      const attachedToolServerConfigs: MCPServerConfig[] = [];
      const attachedToolNodes = getAttachedNodes("tool").filter((entry) => entry.type === "mcp_tool");
      for (const attached of attachedToolNodes) {
        const attachedConfig = toRecord(attached.config);
        const serverId = String(attachedConfig.serverId ?? "").trim();
        const registryServerId = readRegistryServerId(attachedConfig);
        if (!serverId && !registryServerId) {
          continue;
        }

        const allowedTools = new Set<string>();
        if (Array.isArray(attachedConfig.allowedTools)) {
          for (const tool of attachedConfig.allowedTools) {
            const normalized = String(tool ?? "").trim();
            if (normalized) {
              allowedTools.add(normalized);
            }
          }
        }

        const toolName = String(attachedConfig.toolName ?? "").trim();
        if (toolName && toolName !== ALL_MCP_TOOLS_SENTINEL) {
          allowedTools.add(toolName);
        }

        attachedToolServerConfigs.push({
          serverId,
          registryServerId,
          connection: toRecord(attachedConfig.connection),
          secretRef: attachedConfig.secretRef as SecretReference | undefined,
          allowedTools: allowedTools.size ? [...allowedTools] : undefined
        });
      }

      const resolvedAttachedConfigs = await Promise.all(
        attachedToolServerConfigs.map((entry) => applyRegisteredMcpServer(entry, dependencies, context.toolPolicySubject))
      );
      const resolvedInlineConfigs = await Promise.all(
        inlineServerConfigs.map((entry) => applyRegisteredMcpServer(entry, dependencies, context.toolPolicySubject))
      );
      const serverConfigs =
        resolvedAttachedConfigs.length > 0
          ? mergeMCPServerConfigs([], resolvedAttachedConfigs)
          : mergeMCPServerConfigs(resolvedInlineConfigs, resolvedAttachedConfigs);
      // Phase 10.2 — tools denied by policy or by the workflow's "no write
      // tools" switch are dropped here, before the model sees the tool set.
      // Workers run through executeNode and apply the same policy to their own tools.
      const toolPolicy = await buildRunToolPolicy(context, dependencies);
      // Phase 10.5 — the server the bound prompt comes from, resolved like a tool server.
      const serverPromptServerConfig = serverPromptBinding
        ? await applyRegisteredMcpServer(
            { serverId: "", registryServerId: serverPromptBinding.registryServerId, connection: {} },
            dependencies,
            context.toolPolicySubject
          )
        : undefined;
      const agentMcp = createNodeMcpContext(dependencies, node.id, {
        provider,
        serverConfigs: serverPromptServerConfig ? [...serverConfigs, serverPromptServerConfig] : serverConfigs,
        ...(toolPolicy ? { evaluatePolicy: toolPolicy.evaluate } : {}),
        checkSampling: samplingGuardFor(node, context, dependencies)
      });
      const mcpExecutionContext = agentMcp.context;
      // Stdio MCP servers spawned for this node live in this context only.
      // Close them once the node is done, however it ends: success, error,
      // clarification pause, or cancellation/timeout through the abort signal.
      // Workers reached through delegation run executeNode with their own
      // context, so closing here never touches a session a worker still uses,
      // and a worker closing its own sessions leaves this node's alone.
      const releaseMcpSessions = createMcpSessionReleaser(dependencies.mcpRegistry, mcpExecutionContext, node.id);
      dependencies.abortSignal?.addEventListener("abort", releaseMcpSessions.onAbort, { once: true });
      try {
        let serverPromptUsed: ServerPromptTrace | undefined;
        if (serverPromptBinding && serverPromptServerConfig) {
          const resolvedPrompt = await resolveServerPrompt({
            binding: serverPromptBinding,
            renderArgument: (template) => renderTemplate(template, templateData),
            serverConfig: serverPromptServerConfig,
            registry: dependencies.mcpRegistry,
            context: mcpExecutionContext,
            ...(toolPolicy ? { evaluatePolicy: toolPolicy.evaluate } : {}),
            checkArguments: serverPromptArgumentCheck(node, context, dependencies, serverPromptServerConfig, serverPromptBinding.name)
          });
          if (resolvedPrompt.target === "user") userPrompt = resolvedPrompt.text;
          else systemPrompt = resolvedPrompt.text;
          // Phase 16 — a prompt an MCP server wrote is outside content.
          context.labelScope?.add(labelsOf(["untrusted_external"]));
          serverPromptUsed = serverPromptTrace(resolvedPrompt);
        }
        if (systemPrompt.trim()) {
          modelMessages.push({ role: "system", content: systemPrompt });
        }
        modelMessages.push({ role: "user", content: userPrompt });

        const resolvedTools = await resolveMCPTools(
          serverConfigs,
          dependencies.mcpRegistry,
          mcpExecutionContext,
          toolPolicy ? { accessCheck: toolPolicy.accessCheck } : {}
        );

        for (const attachedToolNode of attachedToolNodes) {
          const attachedConfig = toRecord(attachedToolNode.config);
          await context.recordAttachmentUsage?.({
            attachedNodeId: attachedToolNode.id,
            usedByNodeId: node.id,
            handle: "tool",
            input: {
              serverId: String(attachedConfig.serverId ?? ""),
              ...(readRegistryServerId(attachedConfig) ? { registryServerId: readRegistryServerId(attachedConfig) } : {}),
              toolName: String(attachedConfig.toolName ?? "")
            },
            output: {
              resolvedTools: resolvedTools.resolved.length
            }
          });
        }

        const attachedMemoryNode = getAttachedNodes("memory").find((attached) => attached.type === "local_memory");
        let memory: { namespace?: string; maxMessages?: number; persistToolMessages?: boolean } | undefined;
        if (attachedMemoryNode) {
          const memoryConfig = toRecord(attachedMemoryNode.config);
          const namespaceTemplate =
            typeof memoryConfig.namespace === "string" && memoryConfig.namespace.trim()
              ? memoryConfig.namespace
              : `${context.workflow.id}:${node.id}`;
          const namespace = renderTemplate(namespaceTemplate, templateData).trim() || `${context.workflow.id}:${node.id}`;
          const maxMessages =
            typeof memoryConfig.maxMessages === "number" && memoryConfig.maxMessages > 0
              ? Math.floor(memoryConfig.maxMessages)
              : 20;
          const persistToolMessages = memoryConfig.persistToolMessages === true;
          memory = {
            namespace,
            maxMessages,
            persistToolMessages
          };
          await context.recordAttachmentUsage?.({
            attachedNodeId: attachedMemoryNode.id,
            usedByNodeId: node.id,
            handle: "memory",
            input: {
              sessionId
            },
            output: {
              namespace,
              maxMessages,
              persistToolMessages
            }
          });
        }

        const attachedWorkerNodes = getAttachedNodes("worker");
        const workerTools = attachedWorkerNodes.map(worker => {
          const workerConfig = toRecord(worker.config);
          const descriptionHint = typeof workerConfig.systemPromptTemplate === "string" ? workerConfig.systemPromptTemplate.slice(0, 100) : worker.name;
          return {
            serverId: `worker-${worker.id}`,
            name: workerDelegateToolName(worker.name),
            description: `Delegate task to ${worker.name}. Hint: ${descriptionHint}`,
            inputSchema: {
              type: "object",
              properties: {
                task_prompt: { type: "string", description: "The explicit prompt, context, or task instructions to give this worker." }
              },
              required: ["task_prompt"]
            }
          };
        });

        const allToolsForModel = [
          ...resolvedTools.resolved.map((entry) => ({
            serverId: entry.serverId,
            name: entry.exposedName,
            description: entry.definition.description,
            inputSchema: entry.definition.inputSchema
          })),
          ...workerTools
        ];

        const rawImages = Array.isArray(readData(templateData, "images")) ? readData(templateData, "images") as Array<{data: string; mimeType: string}> : [];
        const images = rawImages.filter(img => img && typeof img.data === "string" && img.data && typeof img.mimeType === "string" && img.mimeType.startsWith("image/"));


        // Phase 12.1 — guard hooks: the guard node on the guard port, or the
        // run's automatic profiles. Attachment port, never a DAG step.
        const portGuardNode = getAttachedNodes("guard").find((attached) => attached.type === "guard" && attached.disabled !== true);
        const guardSession: AgentGuardSession | undefined =
          dependencies.guard || portGuardNode
            ? await createAgentGuardSession({
                scope: guardScopeFor(node, context, dependencies, "agent"),
                ...(context.approvedHandoffKeys ? { approvals: context.approvedHandoffKeys } : {}),
                ...(portGuardNode ? { portGuardNode } : {}),
                protectionNodes: portGuardNode ? protectionNodesFor(portGuardNode, context) : [],
                // Phase 16 — where the agent's calls go, for destination rules.
                modelDestination: providerDestinationRef(provider),
                toolDestination: (exposedName) => {
                  const resolved = resolvedTools.resolved.find((entry) => entry.exposedName === exposedName);
                  if (!resolved) return null;
                  const server = serverConfigs.find(
                    (entry) => entry.serverId === resolved.serverId && (entry.registryServerId ?? "") === (resolved.registryServerId ?? "")
                  );
                  return mcpServerDestinationRef(server ?? { serverId: resolved.serverId, ...(resolved.registryServerId ? { registryServerId: resolved.registryServerId } : {}) });
                },
                describeTool: (exposedName) => {
                  const resolved = resolvedTools.resolved.find((entry) => entry.exposedName === exposedName);
                  if (resolved) {
                    return {
                      serverId: resolved.registryServerId ?? resolved.serverId,
                      toolName: resolved.originalName,
                      inputSchema: resolved.definition.inputSchema,
                      ...(resolved.annotations ? { annotations: resolved.annotations } : {})
                    };
                  }
                  const worker = workerTools.find((entry) => entry.name === exposedName);
                  return worker ? { serverId: worker.serverId, toolName: worker.name, inputSchema: worker.inputSchema } : undefined;
                }
              })
            : undefined;
        let workerPendingApproval: ApprovalHandoffRequest | undefined;
        let toolGatePendingApproval: ApprovalHandoffRequest | undefined;
        const writeToolSession = context.writeToolSession ?? context.writeToolCalls?.session();
        const writeGate = context.workflow.settings?.writeToolApproval;
        /**
         * Phase 12.4 — what one MCP tool call needs: the tool policy with the
         * call's arguments and labels (deny, require_approval, allow), then
         * the workflow's write-tool gate. When both ask for approval the
         * call pauses once, with one request that names the rule.
         */
        const planToolCall = (
          resolvedEntry: (typeof resolvedTools.resolved)[number],
          args: Record<string, unknown>,
          labels: DataLabels | undefined
        ): ToolCallPlan => {
          // Phase 12.2 — the tool's own server's connection (two inline servers may share an adapter id).
          const connection = resolvedEntry.connection;
          const policyTool: McpToolAccessSubjectTool = {
            adapterId: resolvedEntry.serverId,
            ...(resolvedEntry.registryServerId ? { registryServerId: resolvedEntry.registryServerId } : {}),
            toolName: resolvedEntry.originalName,
            ...(resolvedEntry.annotations ? { annotations: resolvedEntry.annotations } : {}),
            ...(connection ? { connection } : {})
          };
          const decision = toolPolicy?.evaluate(policyTool, { arguments: args, dataLabels: policyLabels(labels) });
          if (decision && !decision.allowed) {
            return {
              kind: "deny",
              message: decision.message ?? `MCP tool '${resolvedEntry.originalName}' is blocked.`,
              hidden: {
                tool: resolvedEntry.originalName,
                server: resolvedEntry.serverId,
                ...(resolvedEntry.registryServerId ? { registryServerId: resolvedEntry.registryServerId } : {}),
                reason: decision.reason ?? "policy",
                ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
                ...(decision.ruleName ? { ruleName: decision.ruleName } : {})
              },
              decision,
              policyTool
            };
          }
          if (dependencies.replayNodeHook) return { kind: "allow", ...(decision ? { decision, policyTool } : {}) };
          const classification = decision ? decision.classification : classifyMcpTool({ annotations: resolvedEntry.annotations });
          const gateAsks = writeGate?.enabled === true && !writeToolGateSkips(classification);
          if (!gateAsks && !decision?.approval) return { kind: "allow", ...(decision ? { decision, policyTool } : {}) };
          const serverKey = resolvedEntry.registryServerId ?? resolvedEntry.serverId;
          const callKey = writeToolApprovalKey(node.id, serverKey, resolvedEntry.originalName, args);
          const pause = writeToolApprovalPause({
            settings: writeGate ?? { enabled: false },
            nodeId: node.id,
            nodeName: node.name || node.id,
            serverKey,
            serverLabel: serverKey,
            toolName: resolvedEntry.originalName,
            args,
            classificationSource: classification.source === "manual" ? "manual" : "not_marked_read_only",
            ...(decision?.approval ? { policy: decision.approval } : {}),
            writeGate: gateAsks
          });
          const policyKey = decision?.approval && pause.handoff.kind === "rerun" ? pause.handoff.approvalKey : undefined;
          return { kind: "approval", pause, callKey, ...(policyKey ? { policyKey } : {}), gateAsks, ...(decision ? { decision, policyTool } : {}) };
        };
        /**
         * Phase 12.4 — the tool-call check's plan for the call it just let
         * through to the guard. The runtime calls the check, then the guard,
         * then invokeTool for the same call, one call at a time, so the last
         * plan belongs to the call invokeTool runs (a guard block leaves it
         * behind, and the next check replaces it).
         */
        let checkedCall: { toolName: string; argsKey: string; plan: ToolCallPlan; toolCallId: string } | undefined;
        /**
         * Phase 12.4 — the approval keys that can carry one call, in order:
         * the policy approval the check asked for before the guard (it still
         * covers the call when the guard rewrote the arguments, unless they
         * now need a different rule's approval), then the call's own policy
         * key, or, when only the write-tool gate asks, the call's key and any
         * policy approval of the same call (a policy approval is the stricter
         * one, so it covers the gate).
         */
        const approvalCandidates = (plan: ToolCallPlan, checked: typeof checkedCall): string[] => {
          const keys: string[] = [];
          const before = checked?.plan.kind === "approval" ? checked.plan : undefined;
          const now = plan.kind === "approval" ? plan : undefined;
          if (before?.policyKey && (!now?.policyKey || now.decision?.approval?.ruleId === before.decision?.approval?.ruleId)) keys.push(before.policyKey);
          if (now?.policyKey) keys.push(now.policyKey);
          else if (now) keys.push(now.callKey, ...(writeToolSession?.keysWithPrefix(writeToolPolicyKeyPrefix(now.callKey)) ?? []));
          return [...new Set(keys)];
        };

        emitNodeActivity(dependencies, node.id, {
          kind: "resolved_input",
          fields: {
            providerId: String(provider.providerId),
            model: provider.model,
            systemPrompt: previewForActivity(systemPrompt),
            userPrompt: previewForActivity(userPrompt),
            tools: allToolsForModel.map((tool) => tool.name),
            maxIterations,
            ...(node.type === "supervisor_node" ? { workers: attachedWorkerNodes.map((worker) => worker.id) } : {})
          }
        });
        const agentProviderRetry = providerCallContext(dependencies, node.id).onRetry;
        // Phase 16 — the labels of each worker call's result, keyed by tool name and call id.
        const workerResultLabels = new Map<string, DataLabels>();
        const workerResultKey = (toolName: string, toolCallId: string | undefined) => `${toolName}\u0000${toolCallId ?? ""}`;
        const labelScope = context.labelScope;
        const modelRunStarted = Date.now();
        const modelRunStartedAt = nowIso();
        let agentState: Awaited<ReturnType<typeof dependencies.agentRuntime.run>>;
        try {
        const runAgent = () => dependencies.agentRuntime.run(
          {
            provider,
            systemPrompt,
            userPrompt,
            maxIterations,
            toolCallingEnabled,
            agentType: typeof config.agentType === "string" ? config.agentType as "tools" | "react" | "plan-and-execute" | "sql" : "tools",
            tools: allToolsForModel,
            toolOutputLimits: hasCustomToolOutputLimits ? toolOutputLimits : undefined,
            sessionId,
            memory,
            bypassToolFiltering: attachedToolServerConfigs.length > 0,
            images: images.length > 0 ? images : undefined
          },
          {
            tools: [
              ...resolvedTools.tools,
              ...workerTools.map(wt => ({ name: wt.name, description: wt.description, inputSchema: wt.inputSchema }))
            ],
            describeUnavailableTool: (toolName) => resolvedTools.describeBlocked(toolName),
            // Phase 16 — a worker's result carries the worker's labels; any other tool's result is external.
            resultLabels: (toolName, toolCallId) => workerResultLabels.get(workerResultKey(toolName, toolCallId)),
            invokeTool: async (toolName, args, invocation) => {
               const matchingWorker = workerTools.find(wt => wt.name === toolName);
               if (matchingWorker) {
                  const workerId = matchingWorker.serverId.replace("worker-", "");
                  const workerNode = attachedWorkerNodes.find(wn => wn.id === workerId);
                  if (!workerNode) throw new Error(`Worker node ${workerId} not found.`);
                
                  const workerGlobals = { ...context.globals, user_prompt: String(args.task_prompt ?? "") };
                  // Phase 16 — the worker starts with what the supervisor's context holds at the call.
                  const workerScope = labelScope?.child(workerNode.id, workerNode.type, invocation?.labels ?? labelScope.inputLabels(), workerGlobals);
                  const workerContext: NodeRuntimeContext = {
                     ...context,
                     ...(writeToolSession ? { writeToolSession } : {}),
                     globals: workerGlobals,
                     parentOutputs: { ...context.parentOutputs },
                     callStack: [...context.callStack, node.id],
                     labelScope: workerScope
                  };
                
                  // Phase 12.1 — the worker runs its own guard; a pause there pauses this agent too.
                  try {
                    const workerResult = await executeNode(workerNode, workerContext, {
                      ...dependencies,
                      activityRecorder: workerActivityRecorder(dependencies.activityRecorder, node.id)
                    });
                    if (workerScope) workerResultLabels.set(workerResultKey(toolName, invocation?.toolCallId), workerScope.finish(workerResult));
                    return workerResult;
                  } catch (error) {
                    if (isApprovalHandoffSignal(error)) {
                      workerPendingApproval = error.request;
                      throw new AgentGuardInterrupt("approval_required", "tool_result", 0, error.message);
                    }
                    throw error;
                  }
               }
               const resolvedEntry = resolvedTools.resolved.find((entry) => entry.exposedName === toolName);
               // Phase 12.4 — the plan the tool-call check made for this call; planned again when the guard rewrote the arguments.
               const argsKey = canonicalPolicyJson(args);
               const checked =
                 checkedCall && checkedCall.toolName === toolName && (!invocation?.toolCallId || invocation.toolCallId === checkedCall.toolCallId)
                   ? checkedCall
                   : undefined;
               checkedCall = undefined;
               const plan = resolvedEntry
                 ? (checked && checked.argsKey === argsKey ? checked.plan : planToolCall(resolvedEntry, args, invocation?.labels))
                 : ({ kind: "allow" } as ToolCallPlan);
               const toolCallId = invocation?.toolCallId ?? checked?.toolCallId;
               // Phase 12.2 — the labels the call is decided with, recorded with the decision (names only).
               const recordExtra = { ...(toolCallId ? { toolCallId } : {}), labels: invocation?.labels, tracked: labelScope?.run.tracked === true };
               if (plan.kind === "deny") {
                 if (plan.decision && plan.policyTool) toolPolicy?.record(plan.policyTool, plan.decision, recordExtra);
                 throw new McpToolPolicyError(plan.message, plan.hidden);
               }
               // Phase 11.2 — the workflow's write-tool gate (after the guard, as before 12.4), and (12.4) a
               // require_approval policy rule (asked before the guard by the check): a person approves this exact
               // call first, in one request when both ask.
               let approvedCallKey: string | undefined;
               const candidates = approvalCandidates(plan, checked);
               if (candidates.length > 0) {
                 const approvalTrace = (approval: "pending" | "approved") => {
                   if (plan.decision && plan.policyTool) toolPolicy?.record(plan.policyTool, plan.decision, { ...recordExtra, approval });
                 };
                 // An approved call already ran in an earlier re-run: answer from its result.
                 for (const key of candidates) {
                   const replayed = writeToolSession?.replay(key);
                   if (replayed?.hit) {
                     approvalTrace("approved");
                     return replayed.result as Awaited<ReturnType<typeof resolvedTools.invokeByExposedName>>;
                   }
                 }
                 approvedCallKey = candidates.find((key) => writeToolSession?.takeApproval(key) === true);
                 if (!approvedCallKey) {
                   approvalTrace("pending");
                   const pending = plan.kind === "approval" ? plan : checked?.plan;
                   toolGatePendingApproval = pending?.kind === "approval" ? pending.pause : undefined;
                   throw new AgentGuardInterrupt("approval_required", "tool_arguments", 0, toolGatePendingApproval?.message ?? "This tool call needs approval.");
                 }
                 approvalTrace("approved");
               } else if (plan.decision && plan.policyTool) {
                 toolPolicy?.record(plan.policyTool, plan.decision, recordExtra);
               }
               // Phase 10.5 — each tool call gets a fresh sampling budget.
               const originalName = resolvedEntry?.originalName ?? toolName;
               agentMcp.samplingHandler.beginCall(originalName);
               const toolResult = await resolvedTools.invokeByExposedName(toolName, args, {
                 ...(invocation?.labels ? { dataLabels: policyLabels(invocation.labels) } : {}),
                 ...(toolCallId ? { toolCallId } : {})
               });
               if (approvedCallKey) writeToolSession?.record(approvedCallKey, toolResult);
               return toolResult;
            },
            // Phase 12.4 — the tool policy decides each MCP tool call before the guard: a deny becomes a tool error
            // the model sees, a call that needs approval pauses the agent (unless it was approved or already ran).
            checkToolCall: (toolName, args, call) => {
              checkedCall = undefined;
              const resolvedEntry = resolvedTools.resolved.find((entry) => entry.exposedName === toolName);
              if (!resolvedEntry) return { outcome: "allow" };
              const plan = planToolCall(resolvedEntry, args, call.labels);
              if (plan.kind === "deny") {
                if (plan.decision && plan.policyTool) toolPolicy?.record(plan.policyTool, plan.decision, { toolCallId: call.toolCallId });
                return { outcome: "block", message: plan.message };
              }
              // Only a policy rule's approval is asked before the guard; the write-tool gate alone keeps its place
              // after the guard, so a call the guard blocks or rewrites is never put to a person first.
              if (plan.kind === "approval" && plan.policyKey && !writeToolSession?.ready(plan.policyKey)) {
                if (plan.decision && plan.policyTool) toolPolicy?.record(plan.policyTool, plan.decision, { toolCallId: call.toolCallId, approval: "pending" });
                toolGatePendingApproval = plan.pause;
                return { outcome: "pause", message: plan.pause.message };
              }
              checkedCall = { toolName, argsKey: canonicalPolicyJson(args), plan, toolCallId: call.toolCallId };
              return { outcome: "allow" };
            }
          },
          {
            providerRegistry: dependencies.providerRegistry,
            resolveSecret: dependencies.resolveSecret,
            callSite: { nodeId: node.id },
            memoryStore: dependencies.memoryStore,
            toolDataStore: dependencies.toolDataStore,
            ...(labelScope
              ? {
                  dataLabels: {
                    input: labelScope.inputLabelsExcept([AGENT_USER_PROMPT_SEGMENT]),
                    prompt: labelScope.segmentLabels(AGENT_USER_PROMPT_SEGMENT),
                    persist: labelScope.run.tracked,
                    ...(labelScope.run.scanner ? { scan: labelScope.run.scanner } : {})
                  }
                }
              : {}),
            ...(guardSession ? { guard: guardSession.hooks } : {}),
            ...(dependencies.abortSignal ? { signal: dependencies.abortSignal } : {}),
            ...(agentProviderRetry ? { onProviderRetry: agentProviderRetry } : {}),
            ...(dependencies.activityRecorder ? { onEvent: (event) => emitNodeActivity(dependencies, node.id, event) } : {})
          }
        );
        // Phase 16 — reads made while the agent runs (tool configs rendered at call time) join its labels.
        agentState = labelScope ? await labelScope.segmentAsync(AGENT_RUN_SEGMENT, runAgent) : await runAgent();
        } catch (error) {
          if (isAgentGuardInterrupt(error)) {
            if (error.reason === "approval_required") {
              const request = toolGatePendingApproval ?? guardSession?.takePendingApproval() ?? workerPendingApproval;
              if (request) throw new ApprovalHandoffSignal(request);
            }
            throw new GuardBlockedError(
              `Guard blocked the agent's ${error.channel.replace("_", " ")}: ${error.message}`,
              guardSession?.trace().verdicts.at(-1)?.verdicts ?? []
            );
          }
          throw error;
        }
        if (portGuardNode && guardSession) {
          const guardTrace = guardSession.trace();
          await context.recordAttachmentUsage?.({
            attachedNodeId: portGuardNode.id,
            usedByNodeId: node.id,
            handle: "guard",
            output: { profiles: guardTrace.profiles, verdicts: guardTrace.verdicts.length }
          });
          for (const protectionNode of protectionNodesFor(portGuardNode, context)) {
            await context.recordAttachmentUsage?.({
              attachedNodeId: protectionNode.id,
              usedByNodeId: portGuardNode.id,
              handle: "protection",
              output: { providerId: toRecord(protectionNode.config).providerId }
            });
          }
        }
        // Phase 16 — the answer carries everything its model context held, and what the agent read while it ran;
        // classes a final-answer rewrite removed stay out.
        if (labelScope && agentState.labels) {
          labelScope.replace(
            withoutDataClasses(unionLabels([agentState.labels, labelScope.segmentLabels(AGENT_RUN_SEGMENT)]), agentState.labelsDeclassified ?? [])
          );
        }
        const modelRunCompletedAt = nowIso();
        if (attachedModelNode) {
          const lastStep = agentState.steps.at(-1);
          await context.recordAttachmentUsage?.({
            attachedNodeId: attachedModelNode.id,
            usedByNodeId: node.id,
            handle: "chat_model",
            startedAt: modelRunStartedAt,
            completedAt: modelRunCompletedAt,
            durationMs: Math.max(0, Date.now() - modelRunStarted),
            input: {
              provider,
              messages: modelMessages
            },
            output: {
              stopReason: agentState.stopReason,
              iterations: agentState.iterations,
              answer: agentState.finalAnswer,
              model_output: lastStep?.modelOutput ?? agentState.finalAnswer,
              requested_tool_calls: lastStep?.requestedTools.length ?? 0
            }
          });
        }

        // Phase 10.5 — tokens spent answering the servers' sampling requests
        // count in the node's usage (and so in the run's cost).
        const samplingUsage = agentMcp.samplingHandler.usage();
        const samplingRequests = agentMcp.samplingHandler.requestCount();
        const usageWithSampling =
          samplingRequests > 0
            ? {
                inputTokens: (agentState.usage?.inputTokens ?? 0) + (samplingUsage.inputTokens ?? 0),
                outputTokens: (agentState.usage?.outputTokens ?? 0) + (samplingUsage.outputTokens ?? 0),
                totalTokens: (agentState.usage?.totalTokens ?? 0) + (samplingUsage.totalTokens ?? 0),
                cachedInputTokens: (agentState.usage?.cachedInputTokens ?? 0) + (samplingUsage.cachedInputTokens ?? 0)
              }
            : agentState.usage;
        return {
          answer: agentState.finalAnswer,
          iterations: agentState.iterations,
          stopReason: agentState.stopReason,
          steps: agentState.steps,
          messages: agentState.messages,
          _provider: provider,
          // Phase 10.1 — map exposed tool names back to their MCP server so
          // per-tool telemetry can attribute each call in `steps`.
          _mcpTools: buildMcpToolAttribution(resolvedTools.resolved),
          ...mcpTraceFields(agentMcp),
          ...(serverPromptUsed ? { _serverPrompt: serverPromptUsed } : {}),
          // Phase 10.2 — whose role the tool policy used and which tools it hid.
          ...(toolPolicy ? { _toolPolicy: { ...toolPolicy.trace, hidden: resolvedTools.hidden } } : {}),
          // Phase 12.1 — which profiles guarded this agent and every verdict (masked evidence only).
          ...(guardSession ? { _guard: guardSession.trace() } : {}),
          // Phase 7.1 — surface cumulative agent telemetry on the node output.
          _telemetry: {
            providerId: provider.providerId,
            model: provider.model,
            usage: usageWithSampling,
            latencyMs: agentState.llmLatencyMs,
            llmCallCount: (agentState.llmCallCount ?? 0) + samplingRequests || agentState.llmCallCount,
            ...(samplingRequests > 0 ? { samplingUsage, samplingRequests } : {})
          },
          // Phase: agent_clarify — when the agent paused to ask the user a
          // question, surface the clarification details on the node output
          // so workflow consumers (chat UI, /executions response, downstream
          // nodes) can detect the awaiting state. `clarification` is
          // undefined when the agent finished normally.
          ...(agentState.clarification ? { clarification: agentState.clarification } : {})
        };
      } finally {
        dependencies.abortSignal?.removeEventListener("abort", releaseMcpSessions.onAbort);
        await releaseMcpSessions.close();
      }
    }

    case "output_parser": {
      const mode = typeof config.mode === "string" ? config.mode : "json_schema";
      const parsingMode = normalizeOutputParserParsingMode(config.parsingMode);
      const inputKey = typeof config.inputKey === "string" && config.inputKey ? config.inputKey : "answer";
      const resolvedInput =
        getValueByPath(templateData, inputKey) ??
        readData(templateData, inputKey) ??
        readData(templateData, "text") ??
        readData(templateData, "answer");
      const rawInput =
        typeof resolvedInput === "string"
          ? resolvedInput
          : resolvedInput === undefined || resolvedInput === null
            ? ""
            : JSON.stringify(resolvedInput);
      const maxRetries = typeof config.maxRetries === "number" && config.maxRetries > 0 ? Math.floor(config.maxRetries) : 2;

      if (!rawInput.trim()) {
        throw new Error(`Output Parser input is empty for key '${inputKey}'.`);
      }

      if (mode === "item_list") {
        const separator = typeof config.itemSeparator === "string" ? config.itemSeparator : "\n";
        const items = rawInput.split(separator).map((item) => item.trim()).filter(Boolean);
        return { items, count: items.length, raw: rawInput };
      }

      // json_schema and auto_fix modes
      let schemaObj: Record<string, unknown> | undefined;
      if (mode === "json_schema" && typeof config.jsonSchema === "string") {
        try {
          schemaObj = JSON.parse(config.jsonSchema) as Record<string, unknown>;
        } catch {
          throw new Error("Output Parser: jsonSchema config is not valid JSON.");
        }
      }

      const validateJsonOutput = (
        text: string
      ): { ok: boolean; parsed?: unknown; error?: string; trace?: OutputParserParseTrace } => {
        const parsedResult = parseWithOutputParserStrategies(text, parsingMode);
        if (!parsedResult.ok) {
          return {
            ok: false,
            error: `Invalid JSON (${parsingMode}): ${parsedResult.error}`,
            trace: parsedResult.trace
          };
        }
        const parsed = parsedResult.parsed;

        if (mode === "auto_fix") {
          return { ok: true, parsed, trace: parsedResult.trace };
        }

        // json_schema mode: validate required fields and types
        if (schemaObj && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          const required = Array.isArray(schemaObj.required) ? schemaObj.required.map(String) : [];
          for (const field of required) {
            if (!(field in record)) {
              return { ok: false, parsed, error: `Missing required field: ${field}`, trace: parsedResult.trace };
            }
          }
          const properties = toRecord(schemaObj.properties);
          for (const [key, propSchema] of Object.entries(properties)) {
            if (!(key in record)) continue;
            const prop = toRecord(propSchema);
            if (typeof prop.type === "string" && record[key] !== undefined && record[key] !== null) {
              const actualType = typeof record[key];
              if (prop.type === "string" && actualType !== "string") {
                return { ok: false, parsed, error: `Field '${key}' should be string, got ${actualType}`, trace: parsedResult.trace };
              }
              if (prop.type === "number" && actualType !== "number") {
                return { ok: false, parsed, error: `Field '${key}' should be number, got ${actualType}`, trace: parsedResult.trace };
              }
              if (prop.type === "boolean" && actualType !== "boolean") {
                return { ok: false, parsed, error: `Field '${key}' should be boolean, got ${actualType}`, trace: parsedResult.trace };
              }
            }
            if (Array.isArray(prop.enum) && record[key] !== undefined) {
              if (!prop.enum.includes(record[key])) {
                return {
                  ok: false,
                  parsed,
                  error: `Field '${key}' value '${String(record[key])}' not in enum: ${prop.enum.join(", ")}`,
                  trace: parsedResult.trace
                };
              }
            }
          }
        }
        return { ok: true, parsed, trace: parsedResult.trace };
      };

      let result = validateJsonOutput(rawInput);
      let retries = 0;

      if (!result.ok) {
        // Find a provider to use for retry calls from templateData or upstream nodes.
        const upstreamProvider =
          normalizeProvider((templateData as Record<string, unknown>).__output_parser_provider) ??
          normalizeProvider((templateData as Record<string, unknown>)._provider);

        if (upstreamProvider) {
          const providerAdapter = dependencies.providerRegistry.get(upstreamProvider.providerId);
          for (let attempt = 0; attempt < maxRetries && !result.ok; attempt += 1) {
            const MAX_RETRY_PROMPT_RAW_INPUT_CHARS = 12_000;
            const truncatedRawInput =
              rawInput.length > MAX_RETRY_PROMPT_RAW_INPUT_CHARS
                ? `${rawInput.slice(0, MAX_RETRY_PROMPT_RAW_INPUT_CHARS)}...[truncated ${rawInput.length - MAX_RETRY_PROMPT_RAW_INPUT_CHARS} chars]`
                : rawInput;
            const correctionPrompt = mode === "json_schema" && schemaObj
              ? `Your previous output was invalid. Error: ${result.error}. Required schema: ${JSON.stringify(schemaObj)}. Original output: ${truncatedRawInput}. Please output ONLY valid JSON matching the schema, with no other text.`
              : `Your previous output was not valid JSON. Error: ${result.error}. Original output: ${truncatedRawInput}. Please output ONLY valid JSON with no other text.`;

            // Phase 16 — the retry sends the upstream text to the model: destination rules judge it first (a block stops the node).
            const retryPrompts = await guardModelPrompt(
              node,
              context,
              dependencies,
              upstreamProvider,
              { systemPrompt: "You are a JSON formatting assistant. Output ONLY valid JSON.", userPrompt: correctionPrompt },
              "parser retry model call"
            );
            let retryResponse: Awaited<ReturnType<typeof providerAdapter.generate>>;
            try {
              retryResponse = await providerAdapter.generate(
                {
                  provider: upstreamProvider,
                  messages: [
                    { role: "system", content: retryPrompts.systemPrompt },
                    { role: "user", content: retryPrompts.userPrompt }
                  ]
                },
                providerCallContext(dependencies, node.id)
              );
            } catch (error) {
              // A stopped or timed-out run ends here; it is not a parse failure to fall back from.
              throwIfAborted(dependencies.abortSignal);
              // Graceful fallback: don't crash the workflow if the retry LLM call fails
              break; // Exit retry loop, use best heuristic result;
            }
            result = validateJsonOutput(retryResponse.content);
            retries += 1;
          }
        }
      }

      if (!result.ok) {
        if (parsingMode === "anything_goes") {
        return { parsed: null, raw: rawInput, retries, parserTrace: result.trace, warning: "Output parsing failed: " + result.error };
      }
      throw WorkflowError.parserError(`Output Parser failed after ${retries} retries: ${result.error}`);
      }

      return { parsed: result.parsed, raw: rawInput, retries, parserTrace: result.trace };
    }

    case "guard": {
      const protectionNodes = protectionNodesFor(node, context);
      const connectedHandles = new Set(
        context.workflow.edges.filter((edge) => edge.source === node.id && edge.sourceHandle).map((edge) => edge.sourceHandle as string)
      );
      const output = await executeGuardNodeStep({
        node,
        scope: guardScopeFor(node, context, dependencies, "node"),
        merged: context.merged,
        parentIds: Object.keys(context.parentOutputs),
        globals: context.globals,
        protectionNodes,
        connectedHandles,
        ...(context.labelScope ? { labelScope: context.labelScope } : {})
      });
      for (const protectionNode of protectionNodes) {
        await context.recordAttachmentUsage?.({
          attachedNodeId: protectionNode.id,
          usedByNodeId: node.id,
          handle: "protection",
          output: { providerId: toRecord(protectionNode.config).providerId }
        });
      }
      return output;
    }

    case "guard_protection": {
      // Only meaningful on a guard node's protection port, where it is consumed, not executed.
      return { ...mergeParentOutputs(context.parentOutputs), note: "Protection Provider nodes take effect only on a Guard node's protection port." };
    }

    case "output_guardrail": {
      const checks = Array.isArray(config.checks)
        ? config.checks.map((value) => String(value)).filter(Boolean)
        : [];
      const onFail = config.onFail === "retry" ? "retry" : "error";
      const inputKey = typeof config.inputKey === "string" && config.inputKey ? config.inputKey : "answer";
      const guardrailInput =
        getValueByPath(templateData, inputKey) ??
        readData(templateData, inputKey) ??
        readData(templateData, "answer") ??
        readData(templateData, "text");
      let candidate =
        typeof guardrailInput === "string"
          ? guardrailInput
          : guardrailInput === undefined || guardrailInput === null
            ? ""
            : JSON.stringify(guardrailInput);
      let failures = validateGuardrailChecks(candidate, checks);
      let attempts = 0;

      if (failures.length > 0 && onFail === "retry") {
        const provider = normalizeProvider(templateData._provider);
        if (!provider) {
          throw new Error("Output Guardrail retry requested but no upstream provider context was found.");
        }

        const providerAdapter = dependencies.providerRegistry.get(provider.providerId);
        while (attempts < 3 && failures.length > 0) {
          attempts += 1;
          // Phase 16 — the retry sends the output to the model: destination rules judge it first.
          const retryPrompts = await guardModelPrompt(
            node,
            context,
            dependencies,
            provider,
            {
              systemPrompt: "You must rewrite the assistant output so it passes all guardrail checks. Return revised content only.",
              userPrompt: `Failed checks: ${failures.join(", ")}\n\nOriginal output:\n${candidate}`
            },
            "guardrail retry model call"
          );
          const retryResponse = await providerAdapter.generate(
            {
              provider,
              messages: [
                { role: "system", content: retryPrompts.systemPrompt },
                { role: "user", content: retryPrompts.userPrompt }
              ]
            },
            providerCallContext(dependencies, node.id)
          );
          candidate = retryResponse.content;
          failures = validateGuardrailChecks(candidate, checks);
        }
      }

      if (failures.length > 0) {
        throw new Error(`Output guardrail checks failed: ${failures.join(", ")}`);
      }

      return {
        answer: candidate,
        text: candidate,
        guardrail: {
          checks,
          attempts,
          passed: true
        }
      };
    }

    case "basic_llm_chain": {
      const provider = normalizeProvider(config.provider) ?? normalizeProvider(templateData._provider);
      if (!provider) throw new Error("Basic LLM Chain requires a provider. Attach a Chat Model node upstream or configure provider in settings.");
      const promptKey = typeof config.promptKey === "string" ? config.promptKey : "prompt";
      const systemPromptKey = typeof config.systemPromptKey === "string" ? config.systemPromptKey : "system_prompt";
      const userPrompt = String(readData(templateData, promptKey) ?? readData(templateData, "user_prompt") ?? "");
      const systemPrompt = String(readData(templateData, systemPromptKey) ?? "You are a helpful assistant.");
      return runLlmNode({ nodeId: node.id, provider, userPrompt, systemPrompt, dependencies, outbound: { node, context } });
    }

    case "qa_chain": {
      const provider = normalizeProvider(config.provider) ?? normalizeProvider(templateData._provider);
      if (!provider) throw new Error("Q&A Chain requires a provider.");
      const contextKey = typeof config.contextKey === "string" ? config.contextKey : "context";
      const questionKey = typeof config.questionKey === "string" ? config.questionKey : "question";
      const contextText = String(readData(templateData, contextKey) ?? "");
      const question = String(readData(templateData, questionKey) ?? readData(templateData, "user_prompt") ?? "");
      const maxLen = typeof config.maxContextLength === "number" ? config.maxContextLength : 4000;
      const truncatedContext = contextText.slice(0, maxLen);
      const systemPrompt = "You are a question-answering assistant. Answer the question based ONLY on the provided context. If the answer is not found in the context, say so. Cite specific parts of the context that support your answer.";
      const userPrompt = `Context:\n${truncatedContext}\n\nQuestion: ${question}`;
      return runLlmNode({ nodeId: node.id, provider, userPrompt, systemPrompt, dependencies, outbound: { node, context } });
    }

    case "summarization_chain": {
      const provider = normalizeProvider(config.provider) ?? normalizeProvider(templateData._provider);
      if (!provider) throw new Error("Summarization Chain requires a provider.");
      const textKey = typeof config.textKey === "string" ? config.textKey : "text";
      const text = String(readData(templateData, textKey) ?? readData(templateData, "prompt") ?? "");
      const maxLength = typeof config.maxLength === "number" ? config.maxLength : 500;
      const style = typeof config.style === "string" ? config.style : "brief";
      const styleInstructions: Record<string, string> = {
        brief: `Provide a brief summary in ${maxLength} characters or less.`,
        detailed: `Provide a detailed summary covering all key points. Target length: ${maxLength} characters.`,
        bullet_points: `Summarize as bullet points. Maximum ${Math.ceil(maxLength / 80)} bullet points.`,
        executive: `Write an executive summary suitable for senior leadership. Be concise and focus on actionable insights. Target: ${maxLength} characters.`
      };
      const systemPrompt = `You are a summarization assistant. ${styleInstructions[style] ?? styleInstructions.brief}`;
      const userPrompt = `Summarize the following text:\n\n${text}`;
      return runLlmNode({ nodeId: node.id, provider, userPrompt, systemPrompt, dependencies, outbound: { node, context } });
    }

    case "information_extractor": {
      const provider = normalizeProvider(config.provider) ?? normalizeProvider(templateData._provider);
      if (!provider) throw new Error("Information Extractor requires a provider.");
      const textKey = typeof config.textKey === "string" ? config.textKey : "text";
      const text = String(readData(templateData, textKey) ?? readData(templateData, "prompt") ?? "");
      const schema = typeof config.extractionSchema === "string" ? config.extractionSchema : '{ "key": "value" }';
      const systemPrompt = `You are an information extraction assistant. Extract structured data from the provided text according to the given schema. Return ONLY valid JSON matching the schema. If a field cannot be found, use null.`;
      const userPrompt = `Schema to extract:\n${schema}\n\nText:\n${text}`;
      const result = await runLlmNode({ nodeId: node.id, provider, userPrompt, systemPrompt, dependencies, outbound: { node, context } });
      const answer = typeof result.answer === "string" ? result.answer : String(result.text ?? "");
      let extracted: unknown = answer;
      try { extracted = JSON.parse(answer.replace(/^```json?\s*/i, "").replace(/```\s*$/i, "").trim()); } catch { /* keep as string */ }
      return { ...result, extracted, answer };
    }

    case "text_classifier": {
      const provider = normalizeProvider(config.provider) ?? normalizeProvider(templateData._provider);
      if (!provider) throw new Error("Text Classifier requires a provider.");
      const textKey = typeof config.textKey === "string" ? config.textKey : "text";
      const text = String(readData(templateData, textKey) ?? readData(templateData, "prompt") ?? "");
      const categories = typeof config.categories === "string" ? config.categories : "positive, negative, neutral";
      const multiLabel = config.multiLabel === true;
      const systemPrompt = multiLabel
        ? `You are a text classification assistant. Classify the text into one or more of these categories: ${categories}. Return a JSON object with: { "categories": ["category1", "category2"], "confidence": { "category1": 0.9, "category2": 0.7 }, "reasoning": "brief explanation" }`
        : `You are a text classification assistant. Classify the text into exactly ONE of these categories: ${categories}. Return a JSON object with: { "category": "chosen_category", "confidence": 0.95, "reasoning": "brief explanation" }`;
      const userPrompt = `Classify this text:\n\n${text}`;
      const result = await runLlmNode({ nodeId: node.id, provider, userPrompt, systemPrompt, dependencies, outbound: { node, context } });
      const answer = typeof result.answer === "string" ? result.answer : String(result.text ?? "");
      let classification: unknown = answer;
      try { classification = JSON.parse(answer.replace(/^```json?\s*/i, "").replace(/```\s*$/i, "").trim()); } catch { /* keep as string */ }
      return { ...result, classification, answer };
    }

    case "sentiment_analysis": {
      const provider = normalizeProvider(config.provider) ?? normalizeProvider(templateData._provider);
      if (!provider) throw new Error("Sentiment Analysis requires a provider.");
      const textKey = typeof config.textKey === "string" ? config.textKey : "text";
      const text = String(readData(templateData, textKey) ?? readData(templateData, "prompt") ?? "");
      const systemPrompt = `You are a sentiment analysis assistant. Analyze the sentiment of the provided text. Return a JSON object with: { "sentiment": "positive" | "negative" | "neutral" | "mixed", "score": <number from -1.0 to 1.0>, "confidence": <number from 0.0 to 1.0>, "explanation": "brief explanation of the sentiment" }`;
      const userPrompt = `Analyze the sentiment of this text:\n\n${text}`;
      const result = await runLlmNode({ nodeId: node.id, provider, userPrompt, systemPrompt, dependencies, outbound: { node, context } });
      const answer = typeof result.answer === "string" ? result.answer : String(result.text ?? "");
      let sentiment: unknown = answer;
      try { sentiment = JSON.parse(answer.replace(/^```json?\s*/i, "").replace(/```\s*$/i, "").trim()); } catch { /* keep as string */ }
      return { ...result, sentiment, answer };
    }

    case "ai_transform": {
      const provider = normalizeProvider(config.provider) ?? normalizeProvider(templateData._provider);
      if (!provider) throw new Error("AI Transform requires a provider.");
      const inputKey = typeof config.inputKey === "string" ? config.inputKey : "text";
      const input = String(readData(templateData, inputKey) ?? readData(templateData, "prompt") ?? "");
      const instruction = typeof config.instruction === "string" ? config.instruction : "Transform the input";
      const outputFormat = typeof config.outputFormat === "string" ? config.outputFormat : "text";
      const formatInstructions: Record<string, string> = {
        text: "Return plain text.",
        json: "Return valid JSON only. No markdown fences.",
        code: "Return code only. No explanations."
      };
      const systemPrompt = `You are a data transformation assistant. Apply the user's transformation instruction to the input data. ${formatInstructions[outputFormat] ?? formatInstructions.text}`;
      const userPrompt = `Instruction: ${instruction}\n\nInput:\n${input}`;
      const result = await runLlmNode({ nodeId: node.id, provider, userPrompt, systemPrompt, dependencies, outbound: { node, context } });
      let transformed: unknown = result.answer ?? result.text;
      if (outputFormat === "json" && typeof transformed === "string") {
        try { transformed = JSON.parse((transformed as string).replace(/^```json?\s*/i, "").replace(/```\s*$/i, "").trim()); } catch { /* keep as string */ }
      }
      return { ...result, transformed };
    }

    case "if_node": {
      const conditionTemplate = typeof config.condition === "string" ? config.condition : "";
      const evaluated = renderTemplate(conditionTemplate, templateData).trim();
      const isTruthy = Boolean(evaluated) && evaluated !== "false" && evaluated !== "0" && evaluated !== "null" && evaluated !== "undefined";
      return {
        ...branchPassthrough(templateData),
        result: isTruthy,
        evaluatedValue: evaluated,
        _branchHandle: isTruthy ? "true" : "false"
      };
    }

    case "switch_node": {
      const switchTemplate = typeof config.switchValue === "string" ? config.switchValue : "";
      const evaluated = renderTemplate(switchTemplate, templateData).trim();
      const cases = Array.isArray(config.cases) ? config.cases as Array<{ value: string; label: string }> : [];
      const defaultLabel = typeof config.defaultLabel === "string" ? config.defaultLabel : "default";
      let matchedLabel = defaultLabel;
      let matchedCaseHandle = "default";
      for (const switchCase of cases) {
        if (String(switchCase.value).trim() === evaluated) {
          matchedLabel = switchCase.label;
          break;
        }
      }

      for (let index = 0; index < cases.length; index += 1) {
        const switchCase = cases[index];
        if (String(switchCase.value).trim() === evaluated) {
          matchedCaseHandle = `case_${index}`;
          break;
        }
      }
      return {
        ...branchPassthrough(templateData),
        matched: matchedLabel,
        evaluatedValue: evaluated,
        _branchHandle: matchedLabel,
        _branchHandleFallback: matchedCaseHandle
      };
    }

    case "try_catch": {
      // try_catch is structural — execution routing is handled by the executor loop
      return { _branchHandle: "success" };
    }

    case "human_approval": {
      return {
        waiting: true
      };
    }

    case "approval_gate": {
      const resume = context.resumeDecision;
      if (resume && resume.nodeId === node.id && resume.handoff.kind === "gate") {
        const connectedHandles = new Set(
          context.workflow.edges.filter((edge) => edge.source === node.id && edge.sourceHandle && !isAuxiliaryEdge(edge)).map((edge) => edge.sourceHandle as string)
        );
        return approvalGateOutcome({
          decision: resume,
          request: resume.handoff.request,
          connectedHandles,
          merged: context.merged,
          parentIds: Object.keys(context.parentOutputs),
          timeoutMinutes: typeof config.timeoutMinutes === "number" ? config.timeoutMinutes : undefined
        });
      }
      throw approvalGatePause(config, (template) => renderTemplate(template, templateData));
    }

    case "pdf_output": {
      const renderMode = config.renderMode === "html" ? "html" : "text";
      const inputKey = typeof config.inputKey === "string" && config.inputKey.trim() ? config.inputKey.trim() : "result";
      const textTemplate = typeof config.textTemplate === "string" ? config.textTemplate : "";
      const htmlTemplate = typeof config.htmlTemplate === "string" ? config.htmlTemplate : "";
      const pageFormat: PdfPageFormat =
        config.pageFormat === "Letter" ||
        config.pageFormat === "Legal" ||
        config.pageFormat === "A3" ||
        config.pageFormat === "A5"
          ? config.pageFormat
          : "A4";
      const printBackground = config.printBackground !== false;
      const htmlRenderTimeoutMs =
        typeof config.htmlRenderTimeoutMs === "number" && Number.isFinite(config.htmlRenderTimeoutMs) && config.htmlRenderTimeoutMs >= 1_000
          ? Math.floor(config.htmlRenderTimeoutMs)
          : 45_000;
      const filenameTemplate =
        typeof config.filenameTemplate === "string" && config.filenameTemplate.trim()
          ? config.filenameTemplate
          : "workflow-output-{{session_id}}.pdf";
      const outputKey = typeof config.outputKey === "string" && config.outputKey.trim() ? config.outputKey.trim() : "pdf";

      const sourceValue = getValueByPath(templateData, inputKey);
      const resolvedSource =
        sourceValue ??
        readData(templateData, inputKey) ??
        readData(templateData, "result") ??
        readData(templateData, "answer") ??
        readData(templateData, "text") ??
        readData(templateData, "user_prompt") ??
        templateData;

      const renderedFilename = renderTemplate(filenameTemplate, templateData);
      const filename = normalizePdfFilename(renderedFilename);
      let pdfBuffer: Buffer;
      if (renderMode === "html") {
        const html = htmlTemplate.trim() ? renderTemplate(htmlTemplate, templateData) : toPdfHtmlSource(resolvedSource);
        // Phase 16 — under destination rules every URL the HTML loads is judged as egress before it goes out.
        const pdfJudge = recordingJudge((await renderUrlJudge(node, context, dependencies)) ?? undefined);
        pdfBuffer = await pdfJudge.run(() => createHtmlPdfBuffer({
          ...(pdfJudge.judge ? { judge: pdfJudge.judge } : {}),
          html,
          format: pageFormat,
          printBackground,
          timeoutMs: htmlRenderTimeoutMs,
          outboundGuard: dependencies.outboundGuard ?? DEFAULT_OUTBOUND_GUARD,
          ...(dependencies.outboundDnsResolver ? { resolver: dependencies.outboundDnsResolver } : {})
        }));
      } else {
        let sourceText = textTemplate.trim() ? renderTemplate(textTemplate, templateData) : toPdfSourceText(resolvedSource);
        const maxSourceLength = 50_000;
        if (sourceText.length > maxSourceLength) {
          sourceText =
            `${sourceText.slice(0, maxSourceLength)}\n\n[truncated: content exceeded ${maxSourceLength} characters]`;
        }
        pdfBuffer = createSimplePdfBuffer(sourceText);
      }
      const base64 = pdfBuffer.toString("base64");
      const downloadUrl = `data:application/pdf;base64,${base64}`;

      const payload = {
        filename,
        mimeType: "application/pdf",
        sizeBytes: pdfBuffer.byteLength,
        downloadUrl,
        base64,
        renderMode
      };

      return {
        [outputKey]: payload,
        pdf: payload,
        result: downloadUrl
      };
    }

    case "output": {
      const outputKey = typeof config.outputKey === "string" && config.outputKey ? config.outputKey : "result";
      const responseTemplate = typeof config.responseTemplate === "string" ? config.responseTemplate : undefined;

      let value: unknown;
      if (responseTemplate) {
        value = renderTemplate(responseTemplate, templateData);
      } else {
        value =
          readData(templateData, "answer") ??
          readData(templateData, "text") ??
          readData(templateData, "prompt") ??
          readData(templateData, "user_prompt") ??
          readData(templateData, "system_prompt") ??
          readWholeData(templateData);
      }

      return {
        [outputKey]: value,
        result: value
      };
    }

    case "webhook_response": {
      const statusCode =
        typeof config.statusCode === "number" && Number.isFinite(config.statusCode)
          ? Math.max(100, Math.min(599, Math.floor(config.statusCode)))
          : 200;
      const headersTemplate = typeof config.headersTemplate === "string" ? config.headersTemplate : "{}";
      const bodyTemplate = typeof config.bodyTemplate === "string" ? config.bodyTemplate : "{{result}}";

      const renderedHeaders = renderTemplate(headersTemplate, templateData);
      let headersRecord: Record<string, unknown> = {};
      try {
        headersRecord = toRecord(JSON.parse(renderedHeaders || "{}"));
      } catch {
        throw new Error("Webhook Response node headersTemplate must render valid JSON object.");
      }

      const normalizedHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(headersRecord)) {
        normalizedHeaders[key] = String(value);
      }

      const renderedBody = renderTemplate(bodyTemplate, templateData);
      const body = parseTemplateValue(renderedBody);

      return {
        __webhookResponse: {
          statusCode,
          headers: normalizedHeaders,
          body
        },
        result: body
      };
    }

    case "aggregate_node":
    case "split_out_node":
    case "sort_node":
    case "limit_node":
    case "remove_duplicates_node":
    case "summarize_node":
    case "compare_datasets_node":
    case "rename_keys_node":
    case "edit_fields_node":
    case "date_time_node":
    case "crypto_node":
    case "jwt_node":
    case "xml_node":
    case "html_node":
    case "convert_to_file_node":
    case "extract_from_file_node":
    case "compression_node":
    case "edit_image_node": {
      return executePhase2Node(node, config, {
        templateData,
        parentOutputs: context.parentOutputs,
        getValueByPath
      });
    }

    case "slack_send_message":
    case "slack_trigger":
    case "smtp_send_email":
    case "imap_email_trigger":
    case "google_sheets_read":
    case "google_sheets_append":
    case "google_sheets_update":
    case "google_sheets_trigger":
    case "postgres_query":
    case "postgres_trigger":
    case "mysql_query":
    case "mongo_operation":
    case "redis_command":
    case "redis_trigger":
    case "github_action":
    case "github_webhook_trigger": {
      return executeTier1Node(node, config, {
        templateData,
        resolveSecret: dependencies.resolveSecret
      });
    }

    case "teams_send_message":
    case "notion_create_page":
    case "notion_query_database":
    case "airtable_create_record":
    case "airtable_list_records":
    case "airtable_update_record":
    case "jira_create_issue":
    case "jira_search_issues":
    case "salesforce_create_record":
    case "salesforce_query":
    case "hubspot_create_contact":
    case "hubspot_get_contact":
    case "stripe_create_customer":
    case "stripe_create_charge":
    case "stripe_webhook_trigger":
    case "aws_s3_put_object":
    case "aws_s3_get_object":
    case "aws_s3_list_objects":
    case "telegram_send_message":
    case "telegram_trigger":
    case "discord_send_message":
    case "discord_trigger":
    case "google_drive_trigger":
    case "google_calendar_create_event":
    case "google_calendar_list_events":
    case "twilio_send_sms": {
      return executeTier2Node(node, config, {
        templateData,
        resolveSecret: dependencies.resolveSecret
      });
    }

    case "manual_trigger":
    case "form_trigger":
    case "chat_trigger":
    case "file_trigger":
    case "rss_trigger":
    case "sse_trigger":
    case "mcp_server_trigger":
    case "kafka_trigger":
    case "rabbitmq_trigger":
    case "mqtt_trigger": {
      return executePhase35TriggerNode(node, config, {
        templateData,
        globals: context.globals,
        webhookPayload: toRecord(context.globals.webhook)
      });
    }

    default:
      throw new Error(`Unsupported node type '${String(node.type)}'`);
  }
}

interface RetryConfig {
  enabled: boolean;
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier: number;
}

function getRetryConfig(config: Record<string, unknown>): RetryConfig | undefined {
  const retry = toRecord(config.retry);
  if (!retry || retry.enabled !== true) {
    return undefined;
  }
  return {
    enabled: true,
    maxAttempts: typeof retry.maxAttempts === "number" && retry.maxAttempts >= 1 ? Math.floor(retry.maxAttempts) : 3,
    delayMs: typeof retry.delayMs === "number" && retry.delayMs >= 0 ? Math.floor(retry.delayMs) : 1000,
    backoffMultiplier: typeof retry.backoffMultiplier === "number" && retry.backoffMultiplier >= 1 ? retry.backoffMultiplier : 2
  };
}


const RETRYABLE_NODE_TYPES = new Set([
  "llm_call",
  "openai_chat_model",
  "anthropic_chat_model",
  "ollama_chat_model",
  "openai_compatible_chat_model",
  "ai_gateway_chat_model",
  "azure_openai_chat_model",
  "google_gemini_chat_model",
  "agent_orchestrator",
  "supervisor_node",
  "basic_llm_chain",
  "qa_chain",
  "summarization_chain",
  "information_extractor",
  "text_classifier",
  "sentiment_analysis",
  "ai_transform",
  "mcp_tool",
  "connector_source",
  "google_drive_source",
  "azure_storage",
  "azure_cosmos_db",
  "azure_monitor_http",
  "http_request",
  "rag_retrieve",
  "embeddings_azure_openai",
  ...Array.from(TIER1_NODE_TYPES),
  ...Array.from(TIER2_NODE_TYPES)
]);

function getRetryConfigForNode(node: WorkflowNode): RetryConfig | undefined {
  // Check node-level errorConfig first
  if (node.errorConfig?.retryOnFail === true) {
    return {
      enabled: true,
      maxAttempts: (node.errorConfig.maxRetries ?? 2) + 1,
      delayMs: node.errorConfig.retryIntervalMs ?? 1000,
      backoffMultiplier: 2
    };
  }
  const config = toRecord(node.config);
  const explicit = getRetryConfig(config);
  if (explicit) return explicit;
  const retry = toRecord(config.retry);
  if (retry && retry.enabled === false) return undefined;
  if (RETRYABLE_NODE_TYPES.has(node.type)) {
    return {
      enabled: true,
      maxAttempts: 2,
      delayMs: node.type === "agent_orchestrator" || node.type === "supervisor_node" ? 3000 : 2000,
      backoffMultiplier: 2
    };
  }
  return undefined;
}

function getOnError(config: Record<string, unknown>): "stop" | "continue" | "branch" {
  const value = config.onError;
  if (value === "continue" || value === "branch") {
    return value;
  }
  return "stop";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new WorkflowCanceledError(getAbortMessage(signal)));
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function executeNodeWithRetry(
  node: WorkflowNode,
  context: NodeRuntimeContext,
  dependencies: WorkflowExecutionDependencies
): Promise<{ output: unknown; attempts: number }> {
  const config = toRecord(node.config);
  // A replayed node is answered once from the recording; a recorded failure is not retried.
  const replayStub = replayStubFor(node, dependencies);
  if (replayStub) {
    throwIfAborted(dependencies.abortSignal);
    // Phase 16 — the egress check runs just before the stub: nothing is sent, nothing pauses.
    await runInLabelScope(context.labelScope, () => outboundPreCheck(node, config, context, dependencies));
    return { output: resolveReplayStub(replayStub, context), attempts: 1 };
  }
  const retry = getRetryConfigForNode(node);
  if (!retry) {
    return { output: await executeNode(node, context, dependencies), attempts: 1 };
  }

  let lastError: Error | undefined;
  // Phase 11.2 — a resume decision is used by the first attempt only: a
  // retry of an Execute Workflow node whose resumed child failed starts the
  // child again (and it asks again), instead of resuming it twice.
  const { resumeDecision: _firstAttemptOnly, ...retryContext } = context;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    try {
      const output = await executeNode(node, attempt === 1 ? context : retryContext, dependencies);
      return { output, attempts: attempt };
    } catch (error) {
      // Phase 12.1 — a guard block or an approval pause is a decision, not a transient failure.
      if (
        isCancellationError(error) ||
        dependencies.abortSignal?.aborted ||
        isMcpToolPolicyBlock(error) ||
        isGuardBlockedError(error) ||
        isApprovalHandoffSignal(error) ||
        isApprovalDecisionError(error) ||
        // A rejection or timeout is final: the resumed child must not restart and ask again.
        (context.resumeDecision?.nodeId === node.id && context.resumeDecision.decision !== "approve")
      ) {
        throw error;
      }
      // A URL the outbound guard refuses is refused again on every attempt.
      if (error instanceof OutboundUrlBlockedError) {
        throw error;
      }
      if (error instanceof WorkflowError) {
        lastError = error;
      } else {
        lastError = error instanceof Error ? error : new Error("Node execution failed");
      }
      // Phase 10.7 — a missing delegated connection, an open breaker or a spent rate
      // limit will not change within the retry delays; fail with the actionable message.
      if (isDelegatedCredentialError(error) || /uses each user's own account/.test(lastError.message) || parseMcpRuntimeRejection(lastError.message)) {
        throw lastError;
      }
      const errMsg = lastError.message.toLowerCase();
      if (errMsg.includes("quota") || errMsg.includes("billing") || errMsg.includes("limit: 0") || errMsg.includes("rate_limit_exceeded")) {
        throw lastError;
      }
      if (attempt < retry.maxAttempts) {
        const delay = retry.delayMs * Math.pow(retry.backoffMultiplier, attempt - 1);
        emitNodeActivity(dependencies, node.id, {
          kind: "retry",
          scope: "node",
          attempt,
          maxAttempts: retry.maxAttempts,
          delayMs: delay,
          reason: previewForActivity(lastError.message.slice(0, 200))
        });
        await sleep(delay, dependencies.abortSignal);
      }
    }
  }

  throw lastError ?? new Error("Node execution failed after retries");
}

function collectDescendants(
  nodeId: string,
  outgoingExecution: Map<string, string[]>,
  workflow: { edges: { source: string; target: string; sourceHandle?: string }[] }
): Set<string> {
  const descendants = new Set<string>();
  const queue = [nodeId];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const targets = outgoingExecution.get(current) ?? [];
    for (const target of targets) {
      if (!descendants.has(target)) {
        descendants.add(target);
        queue.push(target);
      }
    }
  }
  return descendants;
}

function collectNodeAndDescendants(
  nodeId: string,
  outgoingExecution: Map<string, string[]>,
  workflow: { edges: { source: string; target: string; sourceHandle?: string }[] }
): Set<string> {
  const nodes = new Set<string>([nodeId]);
  for (const descendant of collectDescendants(nodeId, outgoingExecution, workflow)) {
    nodes.add(descendant);
  }
  return nodes;
}

function collectReachableFromRoots(
  roots: Iterable<string>,
  outgoingExecution: Map<string, string[]>,
  workflow: { edges: { source: string; target: string; sourceHandle?: string }[] }
): Set<string> {
  const reachable = new Set<string>();
  for (const root of roots) {
    for (const nodeId of collectNodeAndDescendants(root, outgoingExecution, workflow)) {
      reachable.add(nodeId);
    }
  }
  return reachable;
}

/**
 * The first Approval Gate that will not run but whose downstream (execution
 * edges, plus agent attachments of every visited node) contains a node that will.
 */
function skippedApprovalGate(
  gateIds: ReadonlySet<string>,
  willRun: ReadonlySet<string>,
  outgoingExecution: Map<string, string[]>,
  attachmentsBySource: Map<string, Map<AgentAttachmentHandle, string[]>>
): string | undefined {
  for (const gateId of gateIds) {
    if (willRun.has(gateId)) continue;
    const seen = new Set<string>([gateId]);
    const queue = [gateId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const next = [...(outgoingExecution.get(current) ?? [])];
      for (const targets of attachmentsBySource.get(current)?.values() ?? []) next.push(...targets);
      for (const target of next) {
        if (seen.has(target)) continue;
        if (willRun.has(target)) return gateId;
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return undefined;
}

function serializeNodeOutputs(nodeOutputs: Map<string, unknown>): Record<string, unknown> {
  const serialized: Record<string, unknown> = {};
  for (const [nodeId, output] of nodeOutputs.entries()) {
    serialized[nodeId] = output;
  }
  return serialized;
}

function deserializeNodeOutputs(nodeOutputs: Record<string, unknown>): Map<string, unknown> {
  const restored = new Map<string, unknown>();
  for (const [nodeId, output] of Object.entries(nodeOutputs ?? {})) {
    restored.set(nodeId, output);
  }
  return restored;
}

function serializeTryCatchScopes(
  scopes: Map<string, { errorTargets: string[]; successDescendants: Set<string> }>
): WorkflowExecutionState["tryCatchScopes"] {
  return [...scopes.entries()].map(([nodeId, scope]) => ({
    nodeId,
    errorTargets: scope.errorTargets,
    successDescendants: [...scope.successDescendants]
  }));
}

function deserializeTryCatchScopes(
  serialized: WorkflowExecutionState["tryCatchScopes"]
): Map<string, { errorTargets: string[]; successDescendants: Set<string> }> {
  const scopes = new Map<string, { errorTargets: string[]; successDescendants: Set<string> }>();
  for (const entry of serialized ?? []) {
    scopes.set(entry.nodeId, {
      errorTargets: Array.isArray(entry.errorTargets) ? entry.errorTargets : [],
      successDescendants: new Set(Array.isArray(entry.successDescendants) ? entry.successDescendants : [])
    });
  }
  return scopes;
}

function appendSkippedNodes(nodeOrder: string[], startIndex: number, nodeResults: NodeExecutionResult[]): void {
  for (let index = startIndex; index < nodeOrder.length; index += 1) {
    nodeResults.push({
      nodeId: nodeOrder[index],
      status: "skipped",
      startedAt: nowIso(),
      completedAt: nowIso(),
      durationMs: 0
    });
  }
}

function appendCanceledRemainder(nodeOrder: string[], startIndex: number, nodeResults: NodeExecutionResult[]): void {
  const canceledAt = nowIso();
  for (let index = startIndex; index < nodeOrder.length; index += 1) {
    nodeResults.push({
      nodeId: nodeOrder[index],
      status: "skipped",
      startedAt: canceledAt,
      completedAt: canceledAt,
      durationMs: 0,
      output: { reason: "execution_canceled" }
    });
  }
}

/** Phase 16 — the labels of each finished run's output, for the Execute Workflow node that ran it (never part of the result). */
const runOutputLabels = new WeakMap<WorkflowExecutionResult, DataLabels>();

/** The labels of a finished run's output (its output node, else its last node), when the engine computed them. */
export function outputLabelsOf(result: WorkflowExecutionResult): DataLabels | undefined {
  return runOutputLabels.get(result);
}

/** Phase 16 — a Guard node's inline profile override asks for propagated labels. */
function overrideUsesLabels(node: WorkflowNode): boolean {
  const override = toRecord(toRecord(node.config).profileOverride);
  return override.labels === "propagated";
}

/** Phase 16 — the dictionaries of a Guard node's inline profile override (they feed the scan when it opts in). */
function overrideDictionaries(node: WorkflowNode): GuardDictionary[] {
  const dictionaries = toRecord(toRecord(node.config).profileOverride).dictionaries;
  return Array.isArray(dictionaries) ? (dictionaries as GuardDictionary[]) : [];
}

/**
 * Phase 16 — whether a run tracks labels: a profile in its resolved guard
 * stack, a profile a Guard node names, or a Guard node's inline override
 * asks for propagated labels. Such profiles' dictionaries feed the output
 * scan. Without guard dependencies, or when nothing opts in, nothing is
 * scanned or stored. When the guard dependencies say no profile could opt
 * in (`mayUseLabels`), nothing is resolved at all: zero-config runs pay one
 * cheap check.
 */
/**
 * Whether the run tracks labels (stores them and scans outputs for data classes), and the dictionaries it scans
 * with. A guard profile or Guard node that uses labels turns it on; so does (Phase 12.2) an enabled MCP tool rule,
 * enforced or shadow, with a `sensitive` or data class condition (`toolRulesNeedTracking`), which would otherwise
 * never match on an untracked run. The guard profiles' dictionaries are then scanned too, so a dictionary class a
 * rule names can be found.
 */
async function labelTrackingFor(
  workflow: Workflow,
  guard: GuardRuntimeDependencies | undefined,
  toolRulesNeedTracking = false
): Promise<{ tracked: boolean; dictionaries: GuardDictionary[] }> {
  if (!guard) return { tracked: toolRulesNeedTracking, dictionaries: [] };
  const guardNodes = workflow.nodes.filter((node) => node.type === "guard" && node.disabled !== true);
  const overriding = guardNodes.filter(overrideUsesLabels);
  if (!toolRulesNeedTracking && overriding.length === 0 && !await guardMayUseLabels(guard)) return { tracked: false, dictionaries: [] };
  const profiles: Array<{ labels?: "fixed" | "propagated"; dictionaries: GuardDictionary[] }> = [];
  try {
    const resolution = await resolveGuardRun(guard);
    if (resolution.enforced) profiles.push(resolution.enforced.profile);
    for (const entry of resolution.stack) profiles.push(entry.profile);
  } catch {
    // The run's guard resolution fails where it is used (an agent or a guard node), exactly as before.
  }
  const nodeDictionaries: GuardDictionary[] = [];
  for (const node of guardNodes) {
    const profileId = typeof toRecord(node.config).profileId === "string" ? String(toRecord(node.config).profileId) : "";
    const opts = overrideUsesLabels(node);
    if (opts) nodeDictionaries.push(...overrideDictionaries(node));
    if (!profileId || profileId === GUARD_EFFECTIVE_PROFILE_REF) continue;
    try {
      const loaded = await guard.loadProfile(profileId);
      // A node whose override opts in scans with its profile's dictionaries as well.
      if (loaded) profiles.push(opts ? { ...loaded.profile, labels: "propagated" } : loaded.profile);
    } catch {
      // A missing profile fails the guard node when it runs.
    }
  }
  const opted = profiles.filter((profile) => profileUsesLabels(profile));
  const tracked = opted.length > 0 || overriding.length > 0 || toolRulesNeedTracking;
  const scanned = toolRulesNeedTracking ? profiles : opted;
  return {
    tracked,
    dictionaries: tracked ? [...scanned.flatMap((profile) => profile.dictionaries ?? []), ...nodeDictionaries] : []
  };
}

/**
 * Phase 12.2 — true when the run's MCP tool rules need it to track labels (see `policyRulesNeedLabelTracking`: only
 * rules covering this workflow, and only when it may call an MCP tool); false when no rules load. A workflow that
 * calls no MCP tool never loads the rules for it.
 */
async function toolRulesNeedLabelTracking(workflow: Workflow, dependencies: WorkflowExecutionDependencies): Promise<boolean> {
  if (!dependencies.loadMcpToolPolicy || !workflowMayCallMcpTools(workflow)) return false;
  try {
    return policyRulesNeedLabelTracking((await dependencies.loadMcpToolPolicy()).rules, workflow);
  } catch {
    // The tool policy fails where it is used (an agent or MCP Tool node), exactly as before.
    return false;
  }
}

async function initRunLabels(request: ExecuteWorkflowRequest, workflow: Workflow, dependencies: WorkflowExecutionDependencies): Promise<RunLabelState> {
  const tracking = await labelTrackingFor(workflow, dependencies.guard, await toolRulesNeedLabelTracking(workflow, dependencies));
  const scan = tracking.tracked ? createLabelScanner(tracking.dictionaries, dependencies.guard ? issuedSurrogatesOf(dependencies.guard) : undefined) : undefined;
  if (request.resumeState) {
    // A run that tracked labels when it paused carries on with them (and keeps tracking).
    const restoredScan = scan ?? (request.resumeState.dataLabels?.tracked ? createLabelScanner([]) : undefined);
    const restored = RunLabelState.fromState(request.resumeState.dataLabels, restoredScan, tracking.tracked);
    if (restored) return restored;
    // Paused without labels (it did not track them then): where its input and finished nodes came from is not known,
    // so they count as outside content. The resume request's own origin (who answered) is not the run's input.
    const unknown = labelsOf(["untrusted_external"]);
    const resumed = new RunLabelState({ input: unknown, tracked: tracking.tracked, ...(scan ? { scan } : {}) });
    for (const nodeId of Object.keys(request.resumeState.nodeOutputs ?? {})) resumed.set(nodeId, unknown);
    return resumed;
  }
  return new RunLabelState({
    input: request.inputLabels ?? labelsOf([inputProvenance(request.triggerType, undefined)]),
    tracked: tracking.tracked,
    ...(scan ? { scan } : {})
  });
}

export async function executeWorkflow(
  request: ExecuteWorkflowRequest,
  dependencies: WorkflowExecutionDependencies
): Promise<WorkflowExecutionResult> {
  // Sandbox sessions started by this run count against its workflow's circuit breaker (see quickjs-sandbox.ts).
  const owner = (request.resumeState?.workflow ?? request.workflow)?.id;
  const run = async (): Promise<WorkflowExecutionResult> => {
    // A sub-workflow run reuses its parent's dependencies: its nodes report nothing of their own.
    // Its template reads belong to its own nodes, never to the parent node that started it.
    if (dependencies.activityRecorder) {
      return runInLabelScope(undefined, () =>
        executeWorkflowRun(request, { ...dependencies, activityRecorder: NOOP_ACTIVITY_RECORDER, onNodeActivity: undefined })
      );
    }
    const recorder = createNodeActivityRecorder(dependencies.onNodeActivity);
    const result = await executeWorkflowRun(request, { ...dependencies, activityRecorder: recorder });
    attachNodeActivity(result.nodeResults, recorder);
    return result;
  };
  return owner ? runWithSandboxOwner(`workflow:${owner}`, run) : run();
}

/** Copies each node's recorded activity onto its results; nodes restored from a paused run keep theirs. */
function attachNodeActivity(nodeResults: NodeExecutionResult[], recorder: NodeActivityRecorder | undefined): void {
  if (!recorder) return;
  for (const nodeResult of nodeResults) {
    const activity = recorder.snapshot(nodeResult.nodeId);
    if (activity.length > 0) nodeResult.activity = activity;
  }
}

async function executeWorkflowRun(
  request: ExecuteWorkflowRequest,
  dependencies: WorkflowExecutionDependencies
): Promise<WorkflowExecutionResult> {
  const workflow = request.resumeState?.workflow ?? request.workflow;
  const startedAt = request.resumeState?.startedAt ?? nowIso();
  const validation = validateWorkflowGraph(workflow);

  if (!validation.valid) {
    return {
      workflowId: workflow.id,
      status: "error",
      startedAt,
      completedAt: nowIso(),
      executionId: request.executionId,
      nodeResults: [],
      error: validation.issues.map((issue) => issue.message).join("; ")
    };
  }

  const callStack = request.callStack?.length ? [...request.callStack] : [];
  if (callStack.includes(workflow.id)) {
    return {
      workflowId: workflow.id,
      status: "error",
      startedAt,
      completedAt: nowIso(),
      executionId: request.executionId,
      nodeResults: [],
      error: `Circular workflow execution detected: ${[...callStack, workflow.id].join(" -> ")}`
    };
  }
  callStack.push(workflow.id);
  const toolPolicySubject = request.resumeState?.toolPolicySubject ?? request.toolPolicySubject;

  let nodeOrder =
    request.resumeState?.nodeOrder?.length ? request.resumeState.nodeOrder : validation.orderedNodeIds ?? sortWorkflowNodes(workflow);
  const graphIndexes = buildGraphIndexes(workflow);
  const descendantCache = new DescendantCache(graphIndexes.outgoingExecution);
  const runMode = request.runMode === "single_node" ? "single_node" : "workflow";
  const explicitStartNodeId =
    !request.resumeState && typeof request.startNodeId === "string" && request.startNodeId.trim()
      ? request.startNodeId.trim()
      : undefined;
  const forceExecuteNodeIds = new Set<string>();

  if (explicitStartNodeId) {
    const startNode = graphIndexes.nodeById.get(explicitStartNodeId);
    if (!startNode) {
      return {
        workflowId: workflow.id,
        status: "error",
        startedAt,
        completedAt: nowIso(),
        executionId: request.executionId,
        nodeResults: [],
        error: `Start node '${explicitStartNodeId}' was not found in workflow '${workflow.id}'.`
      };
    }

    forceExecuteNodeIds.add(explicitStartNodeId);
    if (runMode === "single_node") {
      nodeOrder = [explicitStartNodeId];
    } else {
      const executableNodeIds = new Set<string>(
        descendantCache.getNodeAndDescendants(explicitStartNodeId)
      );
      const queue = [...executableNodeIds];

      while (queue.length) {
        const nodeId = queue.shift()!;
        const attachments = graphIndexes.attachmentsBySource.get(nodeId);
        if (!attachments) {
          continue;
        }

        for (const targets of attachments.values()) {
          for (const targetNodeId of targets) {
            if (executableNodeIds.has(targetNodeId)) {
              continue;
            }
            executableNodeIds.add(targetNodeId);
            queue.push(targetNodeId);
          }
        }
      }

      nodeOrder = nodeOrder.filter((nodeId) => executableNodeIds.has(nodeId));
    }
  }

  // Phase 11.2 — an Approval Gate is a separation-of-duties control: a run
  // that may start must not be able to skip it. A start node or single-node
  // run below a gate is refused (replays answer gates from the recording).
  const enforceApprovalGates = !dependencies.replayNodeHook && !request.resumeState;
  const approvalGateIds = new Set(workflow.nodes.filter((entry) => entry.type === "approval_gate").map((entry) => entry.id));
  if (enforceApprovalGates && explicitStartNodeId && approvalGateIds.size > 0) {
    // Attached workers and tools run when their agent does, so they count as running.
    const willRun = new Set(nodeOrder);
    for (const pending = [...willRun]; pending.length > 0; ) {
      const id = pending.pop()!;
      for (const targets of graphIndexes.attachmentsBySource.get(id)?.values() ?? []) {
        for (const target of targets) {
          if (!willRun.has(target)) {
            willRun.add(target);
            pending.push(target);
          }
        }
      }
    }
    const skippedGate = skippedApprovalGate(approvalGateIds, willRun, graphIndexes.outgoingExecution, graphIndexes.attachmentsBySource);
    if (skippedGate) {
      const error = WorkflowError.nodeConfig(`This run would start after Approval Gate '${skippedGate}'. Start at or before the gate.`);
      return {
        workflowId: workflow.id,
        status: "error",
        startedAt,
        completedAt: nowIso(),
        executionId: request.executionId,
        nodeResults: [],
        error: error.message
      };
    }
  }

  const globals: Record<string, unknown> = request.resumeState
    ? toRecord(request.resumeState.globals)
    : {
        ...withoutReservedKeys(request.input),
        ...withoutReservedKeys(request.variables),
        vars: toRecord(workflow.variables),
        webhook: request.webhookPayload ?? {},
        system_prompt:
          request.systemPrompt ??
          (typeof request.webhookPayload?.system_prompt === "string" ? request.webhookPayload.system_prompt : ""),
        user_prompt:
          request.userPrompt ??
          (typeof request.webhookPayload?.user_prompt === "string" ? request.webhookPayload.user_prompt : ""),
        session_id:
          request.sessionId ??
          (typeof request.webhookPayload?.session_id === "string" ? request.webhookPayload.session_id : undefined),
        images: Array.isArray(request.webhookPayload?.images) ? request.webhookPayload.images : undefined,
        trigger_type: request.triggerType ?? "manual",
        scheduled_at: request.triggerType === "cron" ? nowIso() : undefined
      };
  const approvedHandoffKeys = approvedHandoffKeysFromState(request.resumeState);
  const writeToolCalls = new WriteToolCallLedger(approvedHandoffKeys, request.resumeState?.approvedToolResults);
  const customData = request.resumeState
    ? toRecord(globals.execution_custom_data)
    : toRecord(request.customData);
  globals.execution_id = request.executionId ?? "";
  globals.execution_custom_data = customData;

  if (!request.resumeState) {
    globals.vars = toRecord(workflow.variables);
  } else if (!globals.vars || typeof globals.vars !== "object" || Array.isArray(globals.vars)) {
    globals.vars = toRecord(workflow.variables);
  }

  const nodeOutputs = request.resumeState
    ? deserializeNodeOutputs(toRecord(request.resumeState.nodeOutputs))
    : deserializeNodeOutputs(toRecord(request.nodeOutputs));
  const workflowPinnedData = toRecord(workflow.pinnedData);
  const requestPinnedData = request.pinnedData === undefined ? workflowPinnedData : toRecord(request.pinnedData);
  const pinnedData = request.usePinnedData === false ? {} : { ...requestPinnedData };
  if (enforceApprovalGates) {
    // A gate's output only ever comes from a person's decision, never from pins or seeded outputs.
    for (const gateId of approvalGateIds) {
      delete pinnedData[gateId];
      nodeOutputs.delete(gateId);
    }
  }
  if (!request.resumeState) {
    for (const [nodeId, output] of Object.entries(pinnedData)) {
      nodeOutputs.set(nodeId, output);
    }
  }
  // Phase 16 — labels beside the outputs. Outputs seeded by the editor and pinned data were given by a user,
  // and keep the origin of the node type that usually produces them (a pinned HTTP result was fetched from outside).
  const labelState = await initRunLabels(request, workflow, dependencies);
  const workflowNodeTypes = new Map(workflow.nodes.map((entry) => [entry.id, entry.type]));
  const givenLabels = (nodeId: string): DataLabels => {
    const source = nodeContentSource(workflowNodeTypes.get(nodeId) ?? "");
    return unionLabels([labelsOf(["user"]), source === "external" ? labelsOf(["untrusted_external"]) : undefined, source === "input" ? labelState.input : undefined]);
  };
  if (!request.resumeState) {
    for (const nodeId of nodeOutputs.keys()) labelState.set(nodeId, givenLabels(nodeId));
  }
  const nodeResults: NodeExecutionResult[] = request.resumeState ? [...request.resumeState.nodeResults] : [];
  const attachmentOnlyResultIndexByNodeId = new Map<string, number>();
  const attachmentCompletionEventEmitted = new Set<string>();
  const attachmentUsageByNodeId = new Map<
    string,
    {
      attachedNodeId: string;
      usedByNodeId: string;
      handle: AgentAttachmentHandle;
      input?: unknown;
      output?: unknown;
      startedAt: string;
      completedAt: string;
      durationMs: number;
    }
  >();
  const toAttachmentConsumedResult = (
    usage: {
      attachedNodeId: string;
      usedByNodeId: string;
      handle: AgentAttachmentHandle;
      input?: unknown;
      output?: unknown;
      startedAt: string;
      completedAt: string;
      durationMs: number;
    }
  ): NodeExecutionResult => ({
    nodeId: usage.attachedNodeId,
    status: "success",
    startedAt: usage.startedAt,
    completedAt: usage.completedAt,
    durationMs: usage.durationMs,
    input: toJsonSafeValue(usage.input),
    output: {
      reason: "attachment_consumed_by_agent",
      message: "Node was consumed by an attached agent during execution.",
      handle: usage.handle,
      usedByNodeId: usage.usedByNodeId,
      details: toJsonSafeValue(usage.output)
    }
  });
  const recordAttachmentUsage = async (usage: {
    attachedNodeId: string;
    usedByNodeId: string;
    handle: AgentAttachmentHandle;
    input?: unknown;
    output?: unknown;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
  }) => {
    const completedAt = usage.completedAt ?? nowIso();
    const startedAt = usage.startedAt ?? completedAt;
    const durationMs =
      typeof usage.durationMs === "number" && Number.isFinite(usage.durationMs) && usage.durationMs >= 0
        ? Math.floor(usage.durationMs)
        : 0;
    const normalized = {
      attachedNodeId: usage.attachedNodeId,
      usedByNodeId: usage.usedByNodeId,
      handle: usage.handle,
      input: usage.input,
      output: usage.output,
      startedAt,
      completedAt,
      durationMs
    };
    attachmentUsageByNodeId.set(usage.attachedNodeId, normalized);

    const existingIndex = attachmentOnlyResultIndexByNodeId.get(usage.attachedNodeId);
    if (existingIndex !== undefined) {
      nodeResults[existingIndex] = toAttachmentConsumedResult(normalized);
    }

    if (!attachmentCompletionEventEmitted.has(usage.attachedNodeId)) {
      const attachedNodeType = graphIndexes.nodeById.get(usage.attachedNodeId)?.type ?? "unknown";
      await dependencies.onNodeComplete?.({
        nodeId: usage.attachedNodeId,
        nodeType: attachedNodeType,
        status: "success",
        completedAt: normalized.completedAt,
        durationMs: normalized.durationMs,
        input: normalized.input,
        output: {
          reason: "attachment_consumed_by_agent",
          message: "Node was consumed by an attached agent during execution.",
          handle: normalized.handle,
          usedByNodeId: normalized.usedByNodeId,
          details: toJsonSafeValue(normalized.output)
        }
      });
      attachmentCompletionEventEmitted.add(usage.attachedNodeId);
    }
  };
  let finalOutput: unknown = request.resumeState?.finalOutput;
  let failedError: string | undefined;
  let hadContinuedErrors = request.resumeState?.hadContinuedErrors === true;
  let startIndex = request.resumeState?.nextNodeIndex ?? 0;

  // Branch-aware skip tracking:
  // When a branching node (if_node, switch_node, try_catch) runs, we add
  // all nodes on non-taken branches to this set.
  const skippedByBranch = new Set<string>(request.resumeState?.skippedByBranch ?? []);
  const loopInlineExecutedNodes = new Set<string>();

  // try_catch error routing: maps try_catch nodeId -> error branch target nodeIds
  const tryCatchScopes = request.resumeState
    ? deserializeTryCatchScopes(request.resumeState.tryCatchScopes)
    : new Map<string, { errorTargets: string[]; successDescendants: Set<string> }>();

  let pendingResumeDecision: NodeResumeDecision | undefined;

  if (request.resumeState && !request.approvalDecision) {
    return {
      workflowId: workflow.id,
      status: "error",
      startedAt,
      completedAt: nowIso(),
      executionId: request.executionId,
      nodeResults,
      error: "Resume execution requires an approval decision."
    };
  }

  // Build a map of sourceHandle -> target nodeIds for branching edges
  const branchTargets = new Map<string, Map<string, string[]>>();
  for (const edge of workflow.edges) {
    if (!edge.sourceHandle || isAuxiliaryEdge(edge)) {
      continue;
    }
    let handleMap = branchTargets.get(edge.source);
    if (!handleMap) {
      handleMap = new Map();
      branchTargets.set(edge.source, handleMap);
    }
    const targets = handleMap.get(edge.sourceHandle) ?? [];
    targets.push(edge.target);
    handleMap.set(edge.sourceHandle, targets);
  }

  const applySuccessfulNodeRouting = (node: WorkflowNode, output: unknown) => {
    const outputRecord = toRecord(output);
    const activeBranch = typeof outputRecord._branchHandle === "string" ? outputRecord._branchHandle : undefined;
    const activeBranchFallback =
      typeof outputRecord._branchHandleFallback === "string" ? outputRecord._branchHandleFallback : undefined;

    if (activeBranch && branchTargets.has(node.id)) {
      const handleMap = branchTargets.get(node.id)!;
      const takenHandles = new Set<string>();
      takenHandles.add(activeBranch);
      if (activeBranchFallback) {
        takenHandles.add(activeBranchFallback);
      }
      const takenTargets = new Set<string>();
      for (const takenHandle of takenHandles) {
        for (const target of handleMap.get(takenHandle) ?? []) {
          takenTargets.add(target);
        }
      }
      const protectedNodes = descendantCache.getReachableFromRoots(takenTargets);

      for (const [handle, targets] of handleMap.entries()) {
        if (takenHandles.has(handle)) {
          continue;
        }
        for (const target of targets) {
          for (const candidate of descendantCache.getNodeAndDescendants(target)) {
            if (!protectedNodes.has(candidate)) {
              skippedByBranch.add(candidate);
            }
          }
        }
      }
    }

    if (node.type === "try_catch") {
      const handleMap = branchTargets.get(node.id);
      const successTargets = handleMap?.get("success") ?? [];
      const errorTargets = handleMap?.get("error") ?? [];
      const successDescendants = new Set<string>();
      for (const target of successTargets) {
        successDescendants.add(target);
        for (const descendant of descendantCache.getDescendants(target)) {
          successDescendants.add(descendant);
        }
      }
      tryCatchScopes.set(node.id, { errorTargets, successDescendants });
    }
  };

  if (request.resumeState && request.approvalDecision) {
    const waitingNode = graphIndexes.nodeById.get(request.resumeState.waitingNodeId);
    if (!waitingNode) {
      return {
        workflowId: workflow.id,
        status: "error",
        startedAt,
        completedAt: nowIso(),
        executionId: request.executionId,
        nodeResults,
        error: "Unable to resume: waiting approval node is missing from the workflow."
      };
    }

    const filteredNodeResults = nodeResults.filter(
      (entry) => !(entry.nodeId === waitingNode.id && entry.status === "waiting_approval")
    );
    nodeResults.splice(0, nodeResults.length, ...filteredNodeResults);

    const decidedAt = nowIso();
    // Phase 11.2 — outside an Approval Gate, a timeout is a rejection.
    const timedOut = request.approvalDecision.decision === "timeout";
    const decisionPayload = {
      approved: request.approvalDecision.decision === "approve",
      rejected: request.approvalDecision.decision !== "approve",
      ...(timedOut ? { timedOut: true } : {}),
      timestamp: decidedAt,
      actedBy: request.approvalDecision.actedBy
    };
    const decisionInput = toJsonSafeValue({
      decision: timedOut ? "reject" : request.approvalDecision.decision,
      actedBy: request.approvalDecision.actedBy,
      reason: request.approvalDecision.reason ?? (timedOut ? "Approval timed out" : undefined),
      ...(timedOut ? { timedOut: true } : {})
    });

    // Phase 12.1 — approval hand-off: a guard node routes the decision, an
    // agent re-runs with the approval granted (a rejection fails it below).
    const handoff = request.resumeState.approvalHandoff;
    const approved = request.approvalDecision.decision === "approve";
    let handledByHandoff = false;
    if (handoff?.kind === "gate" || handoff?.kind === "sub_workflow") {
      // Phase 11.2 — the gate (or the Execute Workflow node of a paused
      // child) runs again first and turns the decision into its output.
      pendingResumeDecision = { ...request.approvalDecision, nodeId: waitingNode.id, decidedAt, handoff };
      handledByHandoff = true;
    } else if (handoff?.kind === "route") {
      const routed = approved ? handoff.onApprove : handoff.onReject;
      nodeOutputs.set(waitingNode.id, routed);
      // Phase 16 — the paused node's labels were saved with the run; the decision comes from a person; the routed
      // output is scanned like any output.
      labelState.set(waitingNode.id, labelState.finalize(unionLabels([labelState.get(waitingNode.id), labelsOf(["user"])]), routed));
      nodeResults.push({
        nodeId: waitingNode.id,
        status: "success",
        startedAt: decidedAt,
        completedAt: decidedAt,
        durationMs: 0,
        input: decisionInput,
        output: routed,
        ...labelState.resultField(waitingNode.id)
      });
      applySuccessfulNodeRouting(waitingNode, routed);
      handledByHandoff = true;
    } else if (handoff?.kind === "rerun") {
      if (approved) {
        approvedHandoffKeys.add(handoff.approvalKey);
        handledByHandoff = true;
      } else {
        // The rejected node is not run again.
        startIndex += 1;
      }
    }

    if (handledByHandoff) {
      // Nothing more to record: the routed output or the re-run carries on below.
    } else if (request.approvalDecision.decision === "approve") {
      nodeOutputs.set(waitingNode.id, decisionPayload);
      // Phase 16 — the decision comes from a person.
      labelState.set(waitingNode.id, unionLabels([labelState.get(waitingNode.id), labelsOf(["user"])]));
      nodeResults.push({
        nodeId: waitingNode.id,
        status: "success",
        startedAt: decidedAt,
        completedAt: decidedAt,
        durationMs: 0,
        input: decisionInput,
        output: decisionPayload,
        ...labelState.resultField(waitingNode.id)
      });
    } else {
      const rejectionError = request.approvalDecision.reason?.trim() || (timedOut ? "Human approval timed out" : "Human approval rejected");
      labelState.set(waitingNode.id, unionLabels([labelState.get(waitingNode.id), labelsOf(["user"])]));
      nodeResults.push({
        nodeId: waitingNode.id,
        status: "error",
        startedAt: decidedAt,
        completedAt: decidedAt,
        durationMs: 0,
        input: decisionInput,
        output: decisionPayload,
        error: rejectionError
      });

      let caughtByTryCatch = false;
      for (const [tryCatchId, scope] of tryCatchScopes.entries()) {
        if (scope.successDescendants.has(waitingNode.id)) {
          for (const desc of scope.successDescendants) {
            if (desc !== waitingNode.id) {
              skippedByBranch.add(desc);
            }
          }
          for (const errorTarget of scope.errorTargets) {
            skippedByBranch.delete(errorTarget);
            for (const desc of descendantCache.getDescendants(errorTarget)) {
              skippedByBranch.delete(desc);
            }
          }
          nodeOutputs.set(tryCatchId, {
            error: rejectionError,
            failedNodeId: waitingNode.id,
            failedNodeType: waitingNode.type,
            caught: true
          });
          labelState.set(tryCatchId, unionLabels([labelState.get(tryCatchId), labelState.get(waitingNode.id)]));
          hadContinuedErrors = true;
          caughtByTryCatch = true;
          break;
        }
      }

      if (!caughtByTryCatch) {
        // A rejected Approval Gate or Human Approval never continues (see the node loop below).
        const requestedOnError = getOnError(toRecord(waitingNode.config));
        const onError = requestedOnError === "continue" && (waitingNode.type === "approval_gate" || waitingNode.type === "human_approval") ? "stop" : requestedOnError;
        if (onError === "continue") {
          nodeOutputs.set(waitingNode.id, {
            ...decisionPayload,
            error: rejectionError
          });
          hadContinuedErrors = true;
        } else if (onError === "branch" && branchTargets.has(waitingNode.id)) {
          const handleMap = branchTargets.get(waitingNode.id)!;
          const errorBranchTargets = handleMap.get("error") ?? [];
          if (errorBranchTargets.length > 0) {
            const protectedNodes = descendantCache.getReachableFromRoots(errorBranchTargets);
            for (const [handle, targets] of handleMap.entries()) {
              if (handle === "error") {
                for (const target of targets) {
                  skippedByBranch.delete(target);
                  for (const desc of descendantCache.getDescendants(target)) {
                    skippedByBranch.delete(desc);
                  }
                }
              } else {
                for (const target of targets) {
                  for (const candidate of descendantCache.getNodeAndDescendants(target)) {
                    if (!protectedNodes.has(candidate)) {
                      skippedByBranch.add(candidate);
                    }
                  }
                }
              }
            }
            nodeOutputs.set(waitingNode.id, {
              ...decisionPayload,
              error: rejectionError
            });
            hadContinuedErrors = true;
          } else {
            appendSkippedNodes(nodeOrder, startIndex, nodeResults);
            return {
              workflowId: workflow.id,
              status: "error",
              startedAt,
              completedAt: nowIso(),
              executionId: request.executionId,
              nodeResults,
              error: rejectionError
            };
          }
        } else {
          appendSkippedNodes(nodeOrder, startIndex, nodeResults);
          return {
            workflowId: workflow.id,
            status: "error",
            startedAt,
            completedAt: nowIso(),
            executionId: request.executionId,
            nodeResults,
            error: rejectionError
          };
        }
      }
    }
  }

  // --- Execution timeout ---
  const executionTimeoutMs = typeof (request as unknown as Record<string, unknown>).executionTimeoutMs === "number" ? (request as unknown as Record<string, unknown>).executionTimeoutMs as number : 300000;
  const workflowWarnings: string[] = [];
  const retriedNodes: Array<{ nodeId: string; attempts: number; nodeType: string }> = [];
  const executionStartTime = Date.now();

  /**
   * Pause the run for a person's decision: a Human Approval node, or an
   * approval hand-off (`ApprovalHandoffSignal`). A `route` hand-off resumes
   * after the node; a `rerun` hand-off runs the node again once approved.
   */
  const pauseForApproval = async (pause: {
    node: WorkflowNode;
    index: number;
    nodeInput: unknown;
    startedAtNode: string;
    started: number;
    approvalMessage: string;
    timeoutMinutes: number;
    handoff?: WorkflowExecutionState["approvalHandoff"];
    details?: Record<string, unknown>;
    labelScope?: NodeLabelScope;
  }): Promise<WorkflowExecutionResult> => {
    // Phase 16 — the paused node's labels so far travel with the run, for the output it routes or decides on resume.
    if (pause.labelScope) labelState.set(pause.node.id, pause.labelScope.pendingLabels());
    const waitingOutput = {
      message: pause.approvalMessage,
      timeoutMinutes: pause.timeoutMinutes,
      ...(pause.handoff ? { handoff: pause.handoff.source } : {}),
      ...(pause.details ? toRecord(toJsonSafeValue(pause.details)) : {})
    };
    nodeResults.push({
      nodeId: pause.node.id,
      status: "waiting_approval",
      startedAt: pause.startedAtNode,
      completedAt: nowIso(),
      durationMs: Date.now() - pause.started,
      input: pause.nodeInput,
      output: waitingOutput
    });
    await dependencies.onNodeComplete?.({
      nodeId: pause.node.id,
      nodeType: pause.node.type,
      status: "waiting_approval",
      completedAt: nowIso(),
      durationMs: Date.now() - pause.started,
      input: pause.nodeInput,
      output: waitingOutput
    });

    const executionId = request.executionId ?? randomUUID();
    // The paused state is saved now and resumed later, so it must carry the activity recorded so far.
    attachNodeActivity(nodeResults, dependencies.activityRecorder);
    const stateSnapshot: WorkflowExecutionState = {
      workflow,
      nodeOrder,
      // Re-run hand-offs, gates and paused sub-workflows run the node again on resume.
      nextNodeIndex: pause.handoff && pause.handoff.kind !== "route" ? pause.index : pause.index + 1,
      waitingNodeId: pause.node.id,
      startedAt,
      globals,
      nodeOutputs: serializeNodeOutputs(nodeOutputs),
      nodeResults,
      skippedByBranch: [...skippedByBranch],
      tryCatchScopes: serializeTryCatchScopes(tryCatchScopes),
      hadContinuedErrors,
      finalOutput,
      ...(toolPolicySubject ? { toolPolicySubject } : {}),
      ...(pause.handoff ? { approvalHandoff: pause.handoff } : {}),
      ...(approvedHandoffKeys.size > 0 ? { approvedHandoffKeys: [...approvedHandoffKeys] } : {}),
      ...(writeToolCalls.toState() ? { approvedToolResults: writeToolCalls.toState() } : {}),
      // Phase 16 — stored only on runs that track labels: otherwise no check reads them, and nothing new is stored.
      ...(labelState.tracked ? { dataLabels: labelState.toState() } : {})
    };

    if (dependencies.persistPausedExecution) {
      await dependencies.persistPausedExecution({
        executionId,
        workflowId: workflow.id,
        workflowName: workflow.name,
        triggerType: request.triggerType,
        triggeredBy: request.triggeredBy,
        waitingNodeId: pause.node.id,
        approvalMessage: pause.approvalMessage,
        timeoutMinutes: pause.timeoutMinutes,
        startedAt,
        state: stateSnapshot
      });
    }

    return {
      workflowId: workflow.id,
      status: "waiting_approval",
      startedAt,
      completedAt: nowIso(),
      executionId,
      customData,
      nodeResults,
      output: {
        waitingForApproval: true,
        waitingNodeId: pause.node.id,
        approvalMessage: pause.approvalMessage,
        timeoutMinutes: pause.timeoutMinutes
      }
    };
  };

  /**
   * End the run on its execution timeout. The node that was running, if
   * any, fails with WORKFLOW_TIMEOUT and the remediation, so the failure
   * shows on the node rather than only on the run; later nodes are skipped
   * and the error workflow runs as for any other failure.
   */
  const finishOnExecutionTimeout = async (
    remainderStart: number,
    fields: ExecutionTimeoutFields,
    running?: { node: WorkflowNode; nodeInput: unknown; startedAtNode: string; started: number }
  ): Promise<WorkflowExecutionResult> => {
    const completedAt = nowIso();
    if (running) {
      const durationMs = Date.now() - running.started;
      nodeResults.push({
        nodeId: running.node.id,
        status: "error",
        startedAt: running.startedAtNode,
        completedAt,
        durationMs,
        input: running.nodeInput,
        ...fields
      });
      await dependencies.onNodeComplete?.({
        nodeId: running.node.id,
        nodeType: running.node.type,
        status: "error",
        completedAt,
        durationMs,
        input: running.nodeInput,
        ...fields
      });
    }
    for (let remaining = remainderStart; remaining < nodeOrder.length; remaining += 1) {
      nodeResults.push({
        nodeId: nodeOrder[remaining],
        status: "skipped",
        startedAt: completedAt,
        completedAt,
        durationMs: 0,
        output: { reason: "execution_timeout" }
      });
    }
    if (workflow.settings?.errorWorkflowId && dependencies.triggerErrorWorkflow) {
      dependencies.triggerErrorWorkflow({
        errorWorkflowId: workflow.settings.errorWorkflowId,
        sourceWorkflowId: workflow.id,
        sourceWorkflowName: workflow.name,
        executionId: request.executionId,
        error: fields.error,
        timestamp: completedAt
      }).catch(() => {
        // Intentionally ignored — error workflow trigger failures do not affect the result
      });
    }
    return {
      workflowId: workflow.id,
      status: "error",
      startedAt,
      completedAt,
      executionId: request.executionId,
      customData,
      nodeResults,
      error: fields.error,
      errorCategory: fields.errorCategory,
      errorRemediation: fields.errorRemediation,
      warnings: workflowWarnings,
      retriedNodes
    };
  };

  for (let index = startIndex; index < nodeOrder.length; index += 1) {
    if (isExecutionTimeoutAbort(dependencies.abortSignal)) {
      return await finishOnExecutionTimeout(index, executionTimeoutFields(executionTimeoutMs, dependencies.abortSignal?.reason));
    }
    if (dependencies.abortSignal?.aborted) {
      appendCanceledRemainder(nodeOrder, index, nodeResults);
      return {
        workflowId: workflow.id,
        status: "canceled",
        startedAt,
        completedAt: nowIso(),
        executionId: request.executionId,
        customData,
        nodeResults,
        error: getAbortMessage(dependencies.abortSignal),
        warnings: workflowWarnings,
        retriedNodes
      };
    }

    // Check execution timeout
    const elapsedMs = Date.now() - executionStartTime;
    if (elapsedMs > executionTimeoutMs) {
      return await finishOnExecutionTimeout(
        index,
        executionTimeoutFields(
          executionTimeoutMs,
          undefined,
          `Workflow execution timed out after ${elapsedMs}ms (limit: ${executionTimeoutMs}ms)`
        )
      );
    }
    const nodeId = nodeOrder[index];
    const node = graphIndexes.nodeById.get(nodeId);
    if (!node) {
      continue;
    }

    // Skip nodes on non-taken branches
    if (skippedByBranch.has(node.id)) {
      nodeResults.push({
        nodeId: node.id,
        status: "skipped",
        startedAt: nowIso(),
        completedAt: nowIso(),
        durationMs: 0,
        output: { reason: "branch_not_taken" }
      });
      continue;
    }

    if (loopInlineExecutedNodes.has(node.id)) {
      continue;
    }

    const hasExecutionIncoming = (graphIndexes.incomingExecution.get(node.id)?.length ?? 0) > 0;
    const hasExecutionOutgoing = (graphIndexes.outgoingExecution.get(node.id)?.length ?? 0) > 0;
    const hasAttachmentIncoming = (graphIndexes.incomingAttachments.get(node.id)?.length ?? 0) > 0;
    const isAttachmentOnlyNode = hasAttachmentIncoming && !hasExecutionIncoming && !hasExecutionOutgoing;
    const isDisconnectedNode = !hasAttachmentIncoming && !hasExecutionIncoming && !hasExecutionOutgoing;

    if (isAttachmentOnlyNode && !forceExecuteNodeIds.has(node.id)) {
      const consumedUsage = attachmentUsageByNodeId.get(node.id);
      if (consumedUsage) {
        nodeResults.push(toAttachmentConsumedResult(consumedUsage));
        if (!attachmentCompletionEventEmitted.has(node.id)) {
          await dependencies.onNodeComplete?.({
            nodeId: node.id,
            nodeType: node.type,
            status: "success",
            completedAt: consumedUsage.completedAt,
            durationMs: consumedUsage.durationMs,
            input: toJsonSafeValue(consumedUsage.input),
            output: {
              reason: "attachment_consumed_by_agent",
              message: "Node was consumed by an attached agent during execution.",
              handle: consumedUsage.handle,
              usedByNodeId: consumedUsage.usedByNodeId,
              details: toJsonSafeValue(consumedUsage.output)
            }
          });
          attachmentCompletionEventEmitted.add(node.id);
        }
      } else {
        nodeResults.push({
          nodeId: node.id,
          status: "skipped",
          startedAt: nowIso(),
          completedAt: nowIso(),
          durationMs: 0,
          output: {
            reason: "attachment_only_node",
            message: "Node is attached to an agent port and is not part of the execution DAG."
          }
        });
        await dependencies.onNodeComplete?.({
          nodeId: node.id,
          nodeType: node.type,
          status: "skipped",
          completedAt: nowIso(),
          durationMs: 0,
          output: {
            reason: "attachment_only_node",
            message: "Node is attached to an agent port and is not part of the execution DAG."
          }
        });
      }
      attachmentOnlyResultIndexByNodeId.set(node.id, nodeResults.length - 1);
      continue;
    }

    if (isDisconnectedNode && !forceExecuteNodeIds.has(node.id)) {
      nodeResults.push({
        nodeId: node.id,
        status: "skipped",
        startedAt: nowIso(),
        completedAt: nowIso(),
        durationMs: 0,
        output: {
          reason: "disconnected_node",
          message: "Node is not connected to any execution edge and was not executed."
        }
      });
      await dependencies.onNodeComplete?.({
        nodeId: node.id,
        nodeType: node.type,
        status: "skipped",
        completedAt: nowIso(),
        durationMs: 0,
        output: {
          reason: "disconnected_node",
          message: "Node is not connected to any execution edge and was not executed."
        }
      });
      continue;
    }

    const started = Date.now();
    const startedAtNode = nowIso();
    const nodeConfig = toRecord(node.config);
    const requestedOnError: "stop" | "continue" | "branch" =
      node.errorConfig?.continueOnFail === true ? "continue" : getOnError(nodeConfig);
    // Phase 11.2 — a failed Approval Gate or Human Approval (rejected with
    // nowhere to go, or a request that could not be rendered) never continues:
    // "continue" would run the next step with nobody asked. The error branch still works.
    const onError = (node.type === "approval_gate" || node.type === "human_approval") && requestedOnError === "continue" ? "stop" : requestedOnError;
    const parentIds = graphIndexes.incomingExecution.get(node.id) ?? [];
    const parentOutputs: Record<string, unknown> = {};
    for (const parentId of parentIds) {
      if (nodeOutputs.has(parentId)) {
        parentOutputs[parentId] = nodeOutputs.get(parentId);
      }
    }
    const merged = mergeParentOutputs(parentOutputs);
    // Phase 16 — the node's labels: its own source and the parents that ran, plus what it reads.
    const labelScope = labelState.scope({
      nodeId: node.id,
      nodeType: node.type,
      parents: Object.keys(parentOutputs).map((parentId) => labelState.get(parentId)),
      merged,
      globals
    });
    let nodeInput: unknown = captureNodeInputSnapshot(globals, merged, parentOutputs);
    await dependencies.onNodeStart?.({
      nodeId: node.id,
      nodeType: node.type,
      startedAt: startedAtNode,
      input: nodeInput
    });

    try {
      if (hasOwnRecordKey(pinnedData, node.id)) {
        const output = pinnedData[node.id];
        nodeOutputs.set(node.id, output);
        // Phase 16 — pinned data was given by a user (plus the node type's own origin).
        labelState.set(node.id, labelState.finalize(givenLabels(node.id), output));
        const completedAt = nowIso();
        const durationMs = Date.now() - started;
        nodeResults.push({
          nodeId: node.id,
          status: "success",
          startedAt: startedAtNode,
          completedAt,
          durationMs,
          input: nodeInput,
          output,
          warnings: ["Used pinned data; node executor was not called."],
          ...labelState.resultField(node.id)
        });
        await dependencies.onNodeComplete?.({
          nodeId: node.id,
          nodeType: node.type,
          status: "success",
          completedAt,
          durationMs,
          input: nodeInput,
          output
        });
        if (node.type === "output") {
          finalOutput = output;
          labelState.outputNodeId = node.id;
        }
        applySuccessfulNodeRouting(node, output);
        continue;
      }

      if (node.type === "loop_node") {
        const inputKey = typeof nodeConfig.inputKey === "string" ? nodeConfig.inputKey.trim() : "";
        const itemVariable =
          typeof nodeConfig.itemVariable === "string" && nodeConfig.itemVariable.trim()
            ? nodeConfig.itemVariable.trim()
            : "item";
        const maxIterations =
          typeof nodeConfig.maxIterations === "number" && Number.isFinite(nodeConfig.maxIterations) && nodeConfig.maxIterations > 0
            ? Math.floor(nodeConfig.maxIterations)
            : 100;
        const templateData: Record<string, unknown> = {
          ...globals,
          ...merged,
          parent_outputs: parentOutputs
        };
        let candidateItems = inputKey ? templateData[inputKey] : undefined;
        if (inputKey) labelScope.readPath(inputKey);
        if (candidateItems === undefined && inputKey) {
          candidateItems = getValueByPath(templateData, inputKey);
        }
        const rawItems = Array.isArray(candidateItems) ? candidateItems : [candidateItems];
        const scopedItems = rawItems.slice(0, maxIterations);
        const downstreamNodeIds = graphIndexes.outgoingExecution.get(node.id) ?? [];
        const downstreamNodes = downstreamNodeIds
          .map((childId) => graphIndexes.nodeById.get(childId))
          .filter((child): child is WorkflowNode => Boolean(child));

        for (const child of downstreamNodes) {
          const childParents = graphIndexes.incomingExecution.get(child.id) ?? [];
          const isLoopScopedChild = childParents.length > 0 && childParents.every((parentId) => parentId === node.id);
          if (isLoopScopedChild) {
            loopInlineExecutedNodes.add(child.id);
          }
        }

        const loopItems: Array<{
          index: number;
          item: unknown;
          outputs: Record<string, unknown>;
        }> = [];
        // Phase 16 — each pass's child labels; the loop's output is their union.
        const itemLabels = labelScope.inputLabels();
        const passLabels: DataLabels[] = [];

        for (let loopIndex = 0; loopIndex < scopedItems.length; loopIndex += 1) {
          const loopItem = scopedItems[loopIndex];
          const iterationGlobals: Record<string, unknown> = {
            ...globals,
            [itemVariable]: loopItem,
            _loop_index: loopIndex
          };
          const iterationOutputs: Record<string, unknown> = {};

          for (const childNode of downstreamNodes) {
            const childStarted = Date.now();
            const childStartedAt = nowIso();
            const childParentIds = graphIndexes.incomingExecution.get(childNode.id) ?? [];
            const childParentOutputs: Record<string, unknown> = {};
            for (const parentId of childParentIds) {
              if (parentId === node.id) {
                childParentOutputs[parentId] = {
                  [itemVariable]: loopItem,
                  item: loopItem,
                  _loop_index: loopIndex
                };
                continue;
              }

              if (nodeOutputs.has(parentId)) {
                childParentOutputs[parentId] = nodeOutputs.get(parentId);
              }
            }

            const childMerged = mergeParentOutputs(childParentOutputs);
            childMerged[itemVariable] = loopItem;
            childMerged._loop_index = loopIndex;
            const childLabelScope = labelState.scope({
              nodeId: childNode.id,
              nodeType: childNode.type,
              parents: Object.keys(childParentOutputs).map((parentId) => (parentId === node.id ? itemLabels : labelState.get(parentId))),
              merged: childMerged,
              globals: iterationGlobals
            });
            const childInput = captureNodeInputSnapshot(iterationGlobals, childMerged, childParentOutputs);
            await dependencies.onNodeStart?.({
              nodeId: childNode.id,
              nodeType: childNode.type,
              startedAt: childStartedAt,
              input: childInput
            });

            try {
              const { output: childOutput, attempts: childAttempts } = await executeNodeWithRetry(
                childNode,
                {
                  globals: iterationGlobals,
                  merged: childMerged,
                  parentOutputs: childParentOutputs,
                  nodeOutputs,
                  workflow,
                  nodeById: graphIndexes.nodeById,
                  attachmentsBySource: graphIndexes.attachmentsBySource,
                  callStack,
                  toolPolicySubject,
                  approvedHandoffKeys,
                  writeToolCalls,
                  recordAttachmentUsage,
                  labelScope: childLabelScope
                },
                dependencies
              );
              approvedHandoffKeys.clear();
              writeToolCalls.clear();

              iterationOutputs[childNode.id] = childOutput;
              nodeOutputs.set(childNode.id, childOutput);
              const childLabels = childLabelScope.finish(childOutput);
              labelState.set(childNode.id, childLabels);
              passLabels.push(childLabels);
              if (childNode.type === "output") {
                finalOutput = childOutput;
                labelState.outputNodeId = childNode.id;
              }
              nodeResults.push({
                nodeId: childNode.id,
                status: "success",
                startedAt: childStartedAt,
                completedAt: nowIso(),
                durationMs: Date.now() - childStarted,
                input: childInput,
                output: childOutput,
                attempts: childAttempts > 1 ? childAttempts : undefined,
                ...labelState.resultField(childNode.id)
              });
              await dependencies.onNodeComplete?.({
                nodeId: childNode.id,
                nodeType: childNode.type,
                status: "success",
                completedAt: nowIso(),
                durationMs: Date.now() - childStarted,
                input: childInput,
                output: childOutput
              });
            } catch (caughtChildError) {
              // Phase 11.2 — loop bodies run inline and cannot pause part-way.
              const childError = isApprovalHandoffSignal(caughtChildError)
                ? WorkflowError.nodeConfig(
                    `Approvals cannot pause inside a Loop body: '${childNode.id}' asked for approval ("${caughtChildError.message}"). Move the approval before or after the Loop node.`
                  )
                : caughtChildError;
              const childErrorMessage = childError instanceof Error ? childError.message : "Loop iteration failed";
              nodeResults.push({
                nodeId: childNode.id,
                status: "error",
                startedAt: childStartedAt,
                completedAt: nowIso(),
                durationMs: Date.now() - childStarted,
                input: childInput,
                error: childErrorMessage
              });
              await dependencies.onNodeComplete?.({
                nodeId: childNode.id,
                nodeType: childNode.type,
                status: "error",
                completedAt: nowIso(),
                durationMs: Date.now() - childStarted,
                input: childInput,
                error: childErrorMessage
              });
              throw new Error(
                `Loop node '${node.id}' failed at iteration ${loopIndex} on child '${childNode.id}': ${childErrorMessage}`
              );
            }
          }

          loopItems.push({
            index: loopIndex,
            item: loopItem,
            outputs: iterationOutputs
          });
        }

        const output = {
          items: loopItems,
          count: loopItems.length
        };

        nodeOutputs.set(node.id, output);
        labelState.set(node.id, labelState.finalize(unionLabels([itemLabels, ...passLabels]), output));
        nodeResults.push({
          nodeId: node.id,
          status: "success",
          startedAt: startedAtNode,
          completedAt: nowIso(),
          durationMs: Date.now() - started,
          input: nodeInput,
          output,
          ...labelState.resultField(node.id)
        });
        await dependencies.onNodeComplete?.({
          nodeId: node.id,
          nodeType: node.type,
          status: "success",
          completedAt: nowIso(),
          durationMs: Date.now() - started,
          input: nodeInput,
          output
        });
        continue;
      }

      // Phase 15.1 — a replay answers the approval from the recording below instead of pausing for a person.
      if (node.type === "human_approval" && !dependencies.replayNodeHook) {
        const approvalMessageTemplate =
          typeof nodeConfig.approvalMessage === "string" && nodeConfig.approvalMessage.trim()
            ? nodeConfig.approvalMessage
            : "Approval required to continue.";
        const timeoutMinutes =
          typeof nodeConfig.timeoutMinutes === "number" && Number.isFinite(nodeConfig.timeoutMinutes) && nodeConfig.timeoutMinutes > 0
            ? Math.floor(nodeConfig.timeoutMinutes)
            : 60;
        const approvalMessage = renderTemplate(approvalMessageTemplate, {
          ...globals,
          ...merged,
          parent_outputs: parentOutputs
        });

        return await pauseForApproval({ node, index, nodeInput, startedAtNode, started, approvalMessage, timeoutMinutes, labelScope });
      }

      // Phase 11.2 — the decision belongs to the node the run paused at, once.
      const resumeDecision = pendingResumeDecision?.nodeId === node.id ? pendingResumeDecision : undefined;
      pendingResumeDecision = undefined;
      const { output, attempts } = await executeNodeWithRetry(
        node,
        {
          globals,
          merged,
          parentOutputs,
          nodeOutputs,
          workflow,
          nodeById: graphIndexes.nodeById,
          attachmentsBySource: graphIndexes.attachmentsBySource,
          callStack,
          toolPolicySubject,
          approvedHandoffKeys,
          writeToolCalls,
          ...(resumeDecision ? { resumeDecision } : {}),
          recordAttachmentUsage,
          labelScope
        },
        dependencies
      );
      // Single use: a granted approval covers the re-run of the node it paused, not later nodes or runs.
      approvedHandoffKeys.clear();
      writeToolCalls.clear();

      nodeOutputs.set(node.id, output);
      labelState.set(node.id, labelScope.finish(output));

      nodeResults.push({
        nodeId: node.id,
        status: "success",
        startedAt: startedAtNode,
        completedAt: nowIso(),
        durationMs: Date.now() - started,
        input: nodeInput,
        output,
        attempts: attempts > 1 ? attempts : undefined,
        ...labelState.resultField(node.id)
      });
      await dependencies.onNodeComplete?.({
        nodeId: node.id,
        nodeType: node.type,
        status: "success",
        completedAt: nowIso(),
        durationMs: Date.now() - started,
        input: nodeInput,
        output
      });

      if (node.type === "output") {
        finalOutput = output;
        labelState.outputNodeId = node.id;
      }

      applySuccessfulNodeRouting(node, output);
    } catch (error) {
      // Phase 12.1 — approval hand-off: the node asked for a person's decision.
      if (isApprovalHandoffSignal(error) && !dependencies.abortSignal?.aborted) {
        return await pauseForApproval({
          node,
          index,
          nodeInput,
          startedAtNode,
          started,
          approvalMessage: error.request.message,
          timeoutMinutes: error.request.timeoutMinutes,
          handoff: error.request.handoff,
          ...(error.request.details ? { details: error.request.details } : {}),
          labelScope
        });
      }
      // The execution timeout fires while a node runs: that node failed, it was not canceled.
      if (isExecutionTimeoutAbort(dependencies.abortSignal)) {
        return await finishOnExecutionTimeout(
          index + 1,
          executionTimeoutFields(executionTimeoutMs, dependencies.abortSignal?.reason),
          { node, nodeInput, startedAtNode, started }
        );
      }
      if (isCancellationError(error) || dependencies.abortSignal?.aborted) {
        const canceledAt = nowIso();
        const cancelMessage = getAbortMessage(dependencies.abortSignal);
        nodeResults.push({
          nodeId: node.id,
          status: "canceled",
          startedAt: startedAtNode,
          completedAt: canceledAt,
          durationMs: Date.now() - started,
          input: nodeInput,
          error: cancelMessage
        });
        await dependencies.onNodeComplete?.({
          nodeId: node.id,
          nodeType: node.type,
          status: "canceled",
          completedAt: canceledAt,
          durationMs: Date.now() - started,
          input: nodeInput,
          error: cancelMessage
        });
        appendCanceledRemainder(nodeOrder, index + 1, nodeResults);
        return {
          workflowId: workflow.id,
          status: "canceled",
          startedAt,
          completedAt: canceledAt,
          executionId: request.executionId,
          customData,
          nodeResults,
          error: cancelMessage,
          warnings: workflowWarnings,
          retriedNodes
        };
      }

      const errorMessage = error instanceof Error ? error.message : "Node execution failed";
      // Surface a structured error block (category + remediation + retryable)
      // alongside the raw message so the UI can render an actionable hint
      // without parsing strings. Provider errors carry their own category;
      // other throws fall back to UNKNOWN with its generic remediation.
      const providerError = error instanceof WorkflowError ? undefined : categorizedProviderError(error);
      const errorCategoryName =
        error instanceof WorkflowError ? error.category : providerError?.category ?? ErrorCategory.UNKNOWN;
      const errorRemediation =
        error instanceof WorkflowError
          ? error.remediation
          : remediationForCategory(errorCategoryName, providerError ? { providerId: providerError.provider } : undefined);
      const errorRetryable =
        error instanceof WorkflowError ? error.retryable : providerError?.retryable;
      const errorFields = {
        error: errorMessage,
        errorCategory: errorCategoryName,
        errorRemediation,
        retryable: errorRetryable
      };

      // Check if this node is inside a try_catch scope
      let caughtByTryCatch = false;
      for (const [tryCatchId, scope] of tryCatchScopes.entries()) {
        if (scope.successDescendants.has(node.id)) {
          // Skip remaining nodes in the success branch
          for (const desc of scope.successDescendants) {
            if (desc !== node.id) {
              skippedByBranch.add(desc);
            }
          }
          // Un-skip error branch targets (they were initially skipped by branch routing)
          for (const errorTarget of scope.errorTargets) {
            skippedByBranch.delete(errorTarget);
            for (const desc of descendantCache.getDescendants(errorTarget)) {
              skippedByBranch.delete(desc);
            }
          }
          // Set error info as output for the error branch
          nodeOutputs.set(tryCatchId, {
            error: errorMessage,
            failedNodeId: node.id,
            failedNodeType: node.type,
            caught: true
          });
          // Phase 16 — an error message can quote what the failed node read.
          labelState.set(tryCatchId, unionLabels([labelState.get(tryCatchId), labelScope.pendingLabels()]));

          caughtByTryCatch = true;
          nodeResults.push({
            nodeId: node.id,
            status: "error",
            startedAt: startedAtNode,
            completedAt: nowIso(),
            durationMs: Date.now() - started,
            input: nodeInput,
            ...errorFields
          });
          await dependencies.onNodeComplete?.({
            nodeId: node.id,
            nodeType: node.type,
            status: "error",
            completedAt: nowIso(),
            durationMs: Date.now() - started,
            input: nodeInput,
            ...errorFields
          });
          hadContinuedErrors = true;
          break;
        }
      }

      if (!caughtByTryCatch) {
        if (onError === "continue") {
          nodeOutputs.set(node.id, { error: errorMessage });
          labelState.set(node.id, labelScope.pendingLabels());
          nodeResults.push({
            nodeId: node.id,
            status: "error",
            startedAt: startedAtNode,
            completedAt: nowIso(),
            durationMs: Date.now() - started,
            input: nodeInput,
            ...errorFields
          });
          await dependencies.onNodeComplete?.({
            nodeId: node.id,
            nodeType: node.type,
            status: "error",
            completedAt: nowIso(),
            durationMs: Date.now() - started,
            input: nodeInput,
            ...errorFields
          });
          hadContinuedErrors = true;
          continue;
        }

        if (onError === "branch" && branchTargets.has(node.id)) {
          const handleMap = branchTargets.get(node.id)!;
          const errorBranchTargets = handleMap.get("error") ?? [];
          if (errorBranchTargets.length > 0) {
            const protectedNodes = descendantCache.getReachableFromRoots(errorBranchTargets);
            // Skip non-error branches, un-skip error branch
            for (const [handle, targets] of handleMap.entries()) {
              if (handle === "error") {
                for (const t of targets) {
                  skippedByBranch.delete(t);
                  for (const desc of descendantCache.getDescendants(t)) {
                    skippedByBranch.delete(desc);
                  }
                }
              } else {
                for (const t of targets) {
                  for (const candidate of descendantCache.getNodeAndDescendants(t)) {
                    if (!protectedNodes.has(candidate)) {
                      skippedByBranch.add(candidate);
                    }
                  }
                }
              }
            }
            nodeOutputs.set(node.id, { error: errorMessage });
            labelState.set(node.id, labelScope.pendingLabels());
            nodeResults.push({
              nodeId: node.id,
              status: "error",
              startedAt: startedAtNode,
              completedAt: nowIso(),
              durationMs: Date.now() - started,
              input: nodeInput,
              ...errorFields
            });
            await dependencies.onNodeComplete?.({
              nodeId: node.id,
              nodeType: node.type,
              status: "error",
              completedAt: nowIso(),
              durationMs: Date.now() - started,
              input: nodeInput,
              ...errorFields
            });
            hadContinuedErrors = true;
            continue;
          }
        }

        // Default: stop execution
        failedError = errorMessage;
        nodeResults.push({
          nodeId: node.id,
          status: "error",
          startedAt: startedAtNode,
          completedAt: nowIso(),
          durationMs: Date.now() - started,
          input: nodeInput,
          ...errorFields
        });
        await dependencies.onNodeComplete?.({
          nodeId: node.id,
          nodeType: node.type,
          status: "error",
          completedAt: nowIso(),
          durationMs: Date.now() - started,
          input: nodeInput,
          ...errorFields
        });

        // Skip remaining nodes
        for (let remaining = index + 1; remaining < nodeOrder.length; remaining += 1) {
          const remainingId = nodeOrder[remaining];
          nodeResults.push({
            nodeId: remainingId,
            status: "skipped",
            startedAt: nowIso(),
            completedAt: nowIso(),
            durationMs: 0
          });
        }

        // Trigger error workflow if configured
        if (workflow.settings?.errorWorkflowId && dependencies.triggerErrorWorkflow) {
          dependencies.triggerErrorWorkflow({
            errorWorkflowId: workflow.settings.errorWorkflowId,
            sourceWorkflowId: workflow.id,
            sourceWorkflowName: workflow.name,
            executionId: request.executionId,
            error: failedError ?? "Unknown error",
            timestamp: nowIso()
          }).catch(() => {
            // Intentionally ignored — error workflow trigger failures do not affect the result
          });
        }

        return {
          workflowId: workflow.id,
          status: "error",
          startedAt,
          completedAt: nowIso(),
          executionId: request.executionId,
          customData,
          nodeResults,
          error: failedError,
          errorCategory: errorCategoryName,
          errorRemediation
        };
      }
    }
  }

  if (finalOutput === undefined && nodeOrder.length > 0) {
    finalOutput = nodeOutputs.get(nodeOrder[nodeOrder.length - 1]);
    labelState.outputNodeId = nodeOrder[nodeOrder.length - 1];
  }

  // Phase: agent_clarify — surface the clarification at the top of the
  // result so chat UIs and webhook callers don't have to dig into
  // nodeResults to find it. Status stays "success" — the agent did
  // successfully complete a turn by asking a question — but the
  // clarification field tells consumers the answer isn't final.
  const clarificationFromAgent = findClarificationInNodeResults(nodeResults);

  const completedResult: WorkflowExecutionResult = {
    workflowId: workflow.id,
    status: hadContinuedErrors ? "partial" : "success",
    startedAt,
    completedAt: nowIso(),
    executionId: request.executionId,
    customData,
    nodeResults,
    output: finalOutput,
    ...(clarificationFromAgent ? { clarification: clarificationFromAgent } : {})
  };
  const finalLabels = labelState.outputNodeId ? labelState.get(labelState.outputNodeId) : undefined;
  if (finalLabels) runOutputLabels.set(completedResult, finalLabels);
  return completedResult;
}

/**
 * Phase: agent_clarify. Walk node results from the end and find the last
 * `agent_orchestrator` output carrying a `clarification` field. Last-wins
 * is intentional — if two agent nodes both paused (rare but possible),
 * the most recent question is the one the user needs to answer.
 */
function findClarificationInNodeResults(
  nodeResults: NodeExecutionResult[]
): { question: string; reason?: string; toolCallId: string; nodeId: string } | undefined {
  for (let i = nodeResults.length - 1; i >= 0; i--) {
    const r = nodeResults[i]!;
    const out = r.output;
    if (!out || typeof out !== "object") continue;
    const c = (out as { clarification?: unknown }).clarification;
    if (!c || typeof c !== "object") continue;
    const obj = c as { question?: unknown; reason?: unknown; toolCallId?: unknown };
    if (typeof obj.question !== "string" || typeof obj.toolCallId !== "string") continue;
    return {
      question: obj.question,
      ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
      toolCallId: obj.toolCallId,
      nodeId: r.nodeId
    };
  }
  return undefined;
}

export async function resumeWorkflowExecution(
  request: ResumeWorkflowRequest,
  dependencies: WorkflowExecutionDependencies
): Promise<WorkflowExecutionResult> {
  return executeWorkflow(
    {
      workflow: request.state.workflow,
      executionId: request.executionId,
      triggerType: "approval_resume",
      triggeredBy: request.actedBy,
      resumeState: request.state,
      approvalDecision: {
        decision: request.decision,
        actedBy: request.actedBy,
        reason: request.reason,
        ...(request.edits ? { edits: request.edits } : {}),
        ...(request.editedFields ? { editedFields: request.editedFields } : {}),
        ...(request.requestId ? { requestId: request.requestId } : {})
      }
    },
    dependencies
  );
}

