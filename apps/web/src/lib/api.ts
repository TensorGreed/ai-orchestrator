import type {
  McpPolicyShadowHits,
  McpPolicySimulationRequest,
  McpPolicySimulationResult,
  McpPolicySuggestion,
  McpPolicySuggestionGenerateResult,
  DataDestinationInput,
  DataDestinationRow,
  DestinationRulesStatus,
  UnclassifiedDestination,
  ReplayCapturePromoteOutcome,
  ReplayCaptureSettingsUpdate,
  ReplayCaptureSettingsView,
  ReplayCaptureView,
  ReplayFindSubjectDeleteResult,
  ReplayFindSubjectMatch,
  ReplayFindSubjectQuery,
  ReplayFindSubjectResult,
  ApprovalRequestView,
  GuardSimulationView,
  GateCaseRequestView,
  ReleaseApprovalRequestView,
  ReleaseGateCasesView,
  ReleaseGateCaseView,
  ReleaseGateSettingsInput,
  ReleaseGateView,
  ReleasePublishPreview,
  ReleaseStateView,
  ReleaseUnpublishResult,
  WorkflowRelease,
  WorkflowReleasesView,
  AuditSigningKeysResponse,
  AuditSigningKeyView,
  RunManifestView,
  GuardBindingMode,
  GuardEventView,
  GuardProfileSummary,
  GuardProfileVersionView,
  GuardResolutionView,
  McpBreakerSettings,
  NodeActivityEvent,
  McpCredentialMode,
  McpDelegatedFallback,
  McpMyConnection,
  McpRuntimeLimits,
  McpRuntimeStateView,
  McpSandboxPolicyView,
  McpSandboxSettings,
  McpSandboxStatus,
  McpToolLimitRule,
  McpUserConnectionView
} from "@ai-orchestrator/shared";
import type {
  McpCatalogEntry,
  McpCatalogStatus,
  McpConfigImportResponse,
  McpImportDecision,
  McpPlaygroundCallResponse
} from "@ai-orchestrator/shared";
import { EVAL_RUN_FINISHED_STATUSES } from "@ai-orchestrator/shared";
import type {
  EvalCaseDetail,
  EvalCaseResult,
  EvalCaseStatus,
  EvalRunEvent,
  EvalRunProgress,
  EvalRunSummary,
  EvalRunView,
  EvalScoreDetail,
  EvalScorerSpec,
  EvalScorerType,
  LlmJudgeMode,
  ReplayCaseDiff,
  ReplayJobCandidate,
  ReplayJobOptions,
  ReplayJobEstimate,
  ReplayJobRequest,
  ToolSequenceMode
} from "@ai-orchestrator/shared";
import type {
  ReplayGoldenBadge,
  ReplayMcpMode,
  ReplayRecordingDetail,
  ReplayRecordingSummary,
  ReplayRunRequest,
  ReplayRunResponse
} from "@ai-orchestrator/shared";
import type {
  McpCassette,
  McpCassetteBadge,
  McpCassetteEntry,
  McpCassetteExchange,
  McpCassetteRecord,
  McpCassetteSummary,
  McpReplayMode,
  McpReplayReport
} from "@ai-orchestrator/shared";
import type {
  Folder,
  ImportReport,
  LLMProviderConfig,
  McpClient,
  McpGatewayHiddenToolView,
  McpGatewayToolView,
  McpPolicyRole,
  McpToolset,
  McpToolsetMember,
  McpToolsetMemberSpec,
  McpToolAnnotations,
  McpToolClassification,
  McpToolHintCondition,
  McpOAuthConnectionStatus,
  McpElicitationAction,
  McpElicitationView,
  McpPolicyKind,
  McpPrompt,
  McpPromptGetResult,
  McpResource,
  McpResourceContent,
  McpResourceTemplate,
  McpSamplingSettings,
  McpServerCapabilities,
  McpToolPolicyRule,
  McpToolPolicyConditions,
  McpToolPolicyEffect,
  McpToolPolicyMode,
  McpGatewayApproval,
  MCPToolDefinition,
  Project,
  Workflow,
  WorkflowExecutionResult,
  WorkflowListItem,
  WorkflowValidationResult
} from "@ai-orchestrator/shared";
import { apiFetch, openEventSource } from "./transport";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly payload?: Record<string, unknown>
  ) {
    super(message);
  }
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const body = init?.body;
  if (body !== undefined && body !== null && !(body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await apiFetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers
  });

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  if (!response.ok) {
    const payload = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    throw new ApiError(String(payload.error ?? "API request failed"), response.status, payload);
  }

  return (json ?? {}) as T;
}

export interface AuthUser {
  id: string;
  email: string;
  role: "admin" | "builder" | "operator" | "viewer";
}

export async function registerUser(payload: {
  email: string;
  password: string;
  role?: "admin" | "builder" | "operator" | "viewer";
}) {
  return apiRequest<{ user: AuthUser }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function loginUser(payload: { email: string; password: string }) {
  return apiRequest<LoginResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function logoutUser() {
  return apiRequest<{ ok: boolean }>("/api/auth/logout", {
    method: "POST"
  });
}

export async function fetchAuthMe() {
  return apiRequest<{ user: AuthUser }>("/api/auth/me");
}

/**
 * Phase 13.2 — where "Sign in with SSO (OIDC)" sends the browser, or null when the API has OIDC off (its metadata
 * route answers `enabled: false`, or 404 on an older API) or cannot be reached.
 */
export async function fetchOidcLoginUrl(): Promise<string | null> {
  try {
    const metadata = await apiRequest<{ enabled?: boolean; loginPath?: string }>("/api/auth/oidc/metadata");
    if (metadata.enabled !== true) return null;
    const loginPath = typeof metadata.loginPath === "string" && metadata.loginPath.startsWith("/api/") ? metadata.loginPath : "/api/auth/oidc/login";
    return `${API_BASE}${loginPath}`;
  } catch {
    return null;
  }
}

/** Phase 13.2 — the message for the `sso_error` code the API puts on the login page URL after a failed SSO login. */
export function ssoErrorMessage(code: string): string {
  switch (code) {
    case "oidc_state":
      return "Single sign-on did not complete: the sign-in attempt expired or was started in another browser. Try again.";
    case "oidc_denied":
      return "Single sign-on was cancelled or denied by your identity provider.";
    case "oidc_email":
      return "Your identity provider did not share a verified email address, so no account could be matched. Ask your administrator.";
    case "oidc_not_allowed":
    case "saml_not_allowed":
      return "Your account is not allowed to sign in to this workspace. Ask your administrator.";
    case "sso_mfa_required":
      return "This workspace requires multi-factor authentication. Sign in again and complete MFA at your identity provider, or ask your administrator.";
    case "saml_unavailable":
    case "oidc_unavailable":
      return "Single sign-on is unavailable right now. Try again later or sign in with your password.";
    default:
      return "Single sign-on failed. Try again or contact your administrator.";
  }
}

export async function fetchWorkflows(
  filters: { projectId?: string; folderId?: string | null; tag?: string; search?: string } = {}
) {
  const query = new URLSearchParams();
  if (filters.projectId) query.set("projectId", filters.projectId);
  if (filters.folderId === null) query.set("folderId", "__none__");
  else if (typeof filters.folderId === "string") query.set("folderId", filters.folderId);
  if (filters.tag) query.set("tag", filters.tag);
  if (filters.search) query.set("search", filters.search);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return apiRequest<WorkflowListItem[]>(`/api/workflows${suffix}`);
}

export async function fetchWorkflow(id: string) {
  return apiRequest<Workflow>(`/api/workflows/${id}`);
}

export async function fetchWorkflowVariables(workflowId: string) {
  return apiRequest<{
    workflowId: string;
    variables: Record<string, string>;
  }>(`/api/workflows/${workflowId}/variables`);
}

export async function updateWorkflowVariables(workflowId: string, variables: Record<string, string>) {
  return apiRequest<{
    workflowId: string;
    variables: Record<string, string>;
  }>(`/api/workflows/${workflowId}/variables`, {
    method: "PUT",
    body: JSON.stringify({ variables })
  });
}

export async function saveWorkflow(workflow: Workflow) {
  return apiRequest<Workflow>("/api/workflows", {
    method: "POST",
    body: JSON.stringify(workflow)
  });
}

export async function updateWorkflow(workflow: Workflow) {
  return apiRequest<Workflow>(`/api/workflows/${workflow.id}`, {
    method: "PUT",
    body: JSON.stringify(workflow)
  });
}

export async function deleteWorkflow(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/workflows/${id}`, {
    method: "DELETE"
  });
}

export async function duplicateWorkflow(
  id: string,
  payload: {
    name: string;
    id?: string;
  }
) {
  return apiRequest<Workflow>(`/api/workflows/${id}/duplicate`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function importWorkflow(payload: { json?: string; workflow?: unknown }) {
  return apiRequest<Workflow>("/api/workflows/import", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export interface ExternalImportResponse {
  workflow: Workflow;
  report: ImportReport;
  dryRun?: boolean;
}

/**
 * Converts a workflow exported from another builder. With `dryRun` nothing is
 * stored and the converted workflow plus its mapping report are returned.
 */
export async function importExternalWorkflow(payload: {
  sourceText?: string;
  source?: unknown;
  projectId?: string;
  folderId?: string;
  name?: string;
  dryRun?: boolean;
}) {
  return apiRequest<ExternalImportResponse>("/api/workflows/import/external", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function validateStoredWorkflow(id: string) {
  return apiRequest<WorkflowValidationResult>(`/api/workflows/${encodeURIComponent(id)}/validate`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export async function executeWorkflow(
  workflowId: string,
  payload: {
    startNodeId?: string;
    runMode?: "workflow" | "single_node";
    usePinnedData?: boolean;
    pinnedData?: Record<string, unknown>;
    nodeOutputs?: Record<string, unknown>;
    sourceExecutionId?: string;
    input?: Record<string, unknown>;
    variables?: Record<string, unknown>;
    system_prompt?: string;
    user_prompt?: string;
    sessionId?: string;
    session_id?: string;
    executionTimeoutMs?: number;
    execution_timeout_ms?: number;
    customData?: Record<string, unknown>;
    /** Phase 10.8 — record every MCP call of the run into a cassette. */
    record?: boolean;
  }
) {
  return apiRequest<WorkflowExecutionResult>(`/api/workflows/${workflowId}/execute`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export interface StreamNodeStartEvent {
  nodeId: string;
  nodeType: string;
  startedAt: string;
  input?: unknown;
}

export interface StreamExecutionStartedEvent {
  executionId: string;
  workflowId?: string;
  triggerType?: string;
  startedAt?: string;
}

export interface StreamNodeCompleteEvent {
  nodeId: string;
  nodeType: string;
  status: string;
  completedAt: string;
  durationMs: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  errorCategory?: string;
  errorRemediation?: string;
  retryable?: boolean;
}

export interface StreamLlmDeltaEvent {
  nodeId: string;
  delta: string;
  index: number;
}

export interface StreamErrorEvent {
  message: string;
}

/** Phase 10.5 — MCP `notifications/progress` for a running node's tool call. */
export interface StreamNodeProgressEvent {
  nodeId: string;
  toolName: string;
  serverId: string;
  registryServerId?: string;
  progress: number;
  total?: number;
  message?: string;
  percent?: number;
  at: string;
}

/** One step a running node took (resolved input, model call, retry, agent step, tool call). */
export type StreamNodeActivityEvent = NodeActivityEvent;

/** Phase 10.5 — an MCP server's question to the person running the workflow, as it starts waiting or is settled. */
export interface StreamElicitationEvent {
  phase: "created" | "settled";
  elicitation: McpElicitationView;
}

interface WorkflowExecuteStreamHandlers {
  onExecutionStarted?: (event: StreamExecutionStartedEvent) => void;
  onNodeStart?: (event: StreamNodeStartEvent) => void;
  onNodeComplete?: (event: StreamNodeCompleteEvent) => void;
  onLlmDelta?: (event: StreamLlmDeltaEvent) => void;
  onNodeProgress?: (event: StreamNodeProgressEvent) => void;
  onNodeActivity?: (event: StreamNodeActivityEvent) => void;
  onElicitation?: (event: StreamElicitationEvent) => void;
  onError?: (event: StreamErrorEvent) => void;
}

function parseSseFrame(frame: string): { event: string; data: string } | null {
  const lines = frame.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim() || "message";
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) {
    return null;
  }

  return {
    event,
    data: dataLines.join("\n")
  };
}

/**
 * How long a run stream may stay silent before the client gives up on the
 * connection. The server sends a `: ping` comment every 15s, so 45s of no
 * bytes at all means the connection is gone, not that the run is quiet.
 */
export const STREAM_IDLE_TIMEOUT_MS = 45_000;

/** Thrown when a run stream stops delivering bytes; the run itself may still be going on the server. */
export class StreamConnectionLostError extends Error {
  readonly executionId?: string;

  constructor(executionId?: string) {
    super(
      executionId
        ? `Lost connection to the run; it may still be running on the server (execution ${executionId}).`
        : "Lost connection to the run; it may still be running on the server."
    );
    this.name = "StreamConnectionLostError";
    this.executionId = executionId;
  }
}

/**
 * One `reader.read()` raced against the idle watchdog. Any bytes, pings
 * included, settle the read and so restart the watchdog for the next one.
 */
async function readStreamWithWatchdog(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  executionId: () => string | undefined
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StreamConnectionLostError(executionId())), idleTimeoutMs);
  });
  try {
    return await Promise.race([reader.read(), watchdog]);
  } catch (error) {
    if (error instanceof StreamConnectionLostError) {
      void reader.cancel().catch(() => undefined);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function streamWorkflowExecutionRequest(
  path: string,
  payload: Record<string, unknown>,
  handlers: WorkflowExecuteStreamHandlers = {}
): Promise<WorkflowExecutionResult> {
  const response = await apiFetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let payloadJson: unknown = null;
    try {
      payloadJson = await response.json();
    } catch {
      payloadJson = null;
    }
    const normalized = payloadJson && typeof payloadJson === "object" ? (payloadJson as Record<string, unknown>) : {};
    throw new ApiError(String(normalized.error ?? "Streaming request failed"), response.status, normalized);
  }

  if (!response.body) {
    throw new Error("Streaming response body was empty.");
  }

  const decoder = new TextDecoder("utf-8");
  const reader = response.body.getReader();
  let buffer = "";
  let finalResult: WorkflowExecutionResult | null = null;
  let streamExecutionId: string | undefined;

  while (true) {
    const { done, value } = await readStreamWithWatchdog(reader, STREAM_IDLE_TIMEOUT_MS, () => streamExecutionId);
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) {
        break;
      }

      const rawFrame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsedFrame = parseSseFrame(rawFrame);
      if (!parsedFrame) {
        continue;
      }

      let data: unknown = null;
      try {
        data = JSON.parse(parsedFrame.data);
      } catch {
        data = null;
      }

      if (parsedFrame.event === "node_start" && data && typeof data === "object") {
        handlers.onNodeStart?.(data as StreamNodeStartEvent);
        continue;
      }

      if (parsedFrame.event === "execution_started" && data && typeof data === "object") {
        const startedExecutionId = (data as StreamExecutionStartedEvent).executionId;
        if (typeof startedExecutionId === "string" && startedExecutionId) {
          streamExecutionId = startedExecutionId;
        }
        handlers.onExecutionStarted?.(data as StreamExecutionStartedEvent);
        continue;
      }

      if (parsedFrame.event === "node_complete" && data && typeof data === "object") {
        handlers.onNodeComplete?.(data as StreamNodeCompleteEvent);
        continue;
      }

      if (parsedFrame.event === "llm_delta" && data && typeof data === "object") {
        handlers.onLlmDelta?.(data as StreamLlmDeltaEvent);
        continue;
      }

      if (parsedFrame.event === "node_progress" && data && typeof data === "object") {
        handlers.onNodeProgress?.(data as StreamNodeProgressEvent);
        continue;
      }

      if (parsedFrame.event === "node_activity" && data && typeof data === "object") {
        handlers.onNodeActivity?.(data as StreamNodeActivityEvent);
        continue;
      }

      if (parsedFrame.event === "mcp_elicitation" && data && typeof data === "object") {
        handlers.onElicitation?.(data as StreamElicitationEvent);
        continue;
      }

      if (parsedFrame.event === "error") {
        const streamError: StreamErrorEvent = {
          message:
            data && typeof data === "object" && typeof (data as Record<string, unknown>).message === "string"
              ? String((data as Record<string, unknown>).message)
              : "Streaming request failed"
        };
        handlers.onError?.(streamError);
        continue;
      }

      if (parsedFrame.event === "result" && data && typeof data === "object") {
        finalResult = data as WorkflowExecutionResult;
      }
    }
  }

  if (!finalResult) {
    throw new Error("Streaming request completed without a final result event.");
  }

  return finalResult;
}

export async function executeWorkflowStream(
  workflowId: string,
  payload: {
    startNodeId?: string;
    runMode?: "workflow" | "single_node";
    usePinnedData?: boolean;
    pinnedData?: Record<string, unknown>;
    nodeOutputs?: Record<string, unknown>;
    sourceExecutionId?: string;
    input?: Record<string, unknown>;
    variables?: Record<string, unknown>;
    system_prompt?: string;
    user_prompt?: string;
    sessionId?: string;
    session_id?: string;
    executionTimeoutMs?: number;
    execution_timeout_ms?: number;
    customData?: Record<string, unknown>;
    record?: boolean;
  },
  handlers: WorkflowExecuteStreamHandlers = {}
): Promise<WorkflowExecutionResult> {
  return streamWorkflowExecutionRequest(`/api/workflows/${workflowId}/execute/stream`, payload, handlers);
}

export async function fetchWorkflowPins(workflowId: string) {
  return apiRequest<{
    workflowId: string;
    pinnedData: Record<string, unknown>;
  }>(`/api/workflows/${workflowId}/pins`);
}

export async function saveWorkflowPin(workflowId: string, nodeId: string, data: unknown) {
  return apiRequest<{
    workflowId: string;
    nodeId: string;
    data: unknown;
    pinnedData: Record<string, unknown>;
  }>(`/api/workflows/${workflowId}/pins/${encodeURIComponent(nodeId)}`, {
    method: "PUT",
    body: JSON.stringify({ data })
  });
}

export async function deleteWorkflowPin(workflowId: string, nodeId: string) {
  return apiRequest<{
    ok: boolean;
    workflowId: string;
    nodeId: string;
    pinnedData: Record<string, unknown>;
  }>(`/api/workflows/${workflowId}/pins/${encodeURIComponent(nodeId)}`, {
    method: "DELETE"
  });
}

export async function runWebhook(payload: {
  workflow_id?: string;
  webhook_path?: string;
  webhookPath?: string;
  session_id?: string;
  executionTimeoutMs?: number;
  execution_timeout_ms?: number;
  customData?: Record<string, unknown>;
  system_prompt?: string;
  user_prompt?: string;
  variables?: Record<string, unknown>;
}) {
  return apiRequest<WorkflowExecutionResult & { workflowId: string }>("/api/webhooks/execute", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function runWebhookStream(
  payload: {
    workflow_id?: string;
    webhook_path?: string;
    webhookPath?: string;
    session_id?: string;
    executionTimeoutMs?: number;
    execution_timeout_ms?: number;
    customData?: Record<string, unknown>;
    system_prompt?: string;
    user_prompt?: string;
    variables?: Record<string, unknown>;
  },
  handlers: WorkflowExecuteStreamHandlers = {}
) {
  return streamWorkflowExecutionRequest("/api/webhooks/execute/stream", payload, handlers);
}

export async function fetchDefinitions() {
  return apiRequest<{
    nodes: Array<{
      type: string;
      label: string;
      category: string;
      description: string;
      sampleConfig: Record<string, unknown>;
    }>;
    providers: unknown[];
    connectors: unknown[];
    mcpServers: Array<{ id: string; label: string; description: string }>;
  }>("/api/definitions");
}

export async function discoverMcpTools(payload: {
  serverId: string;
  label?: string;
  connection?: Record<string, unknown>;
  secretRef?: { secretId: string };
  allowedTools?: string[];
  /** Phase 10.2 — project whose tool policy marks the tools. */
  projectId?: string;
}) {
  return apiRequest<{
    serverId: string;
    policy?: { role: McpPolicyRole; projectId: string };
    tools: Array<MCPToolDefinition & Partial<McpToolPolicyMarks>>;
  }>("/api/mcp/discover-tools", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export interface McpTestToolResult {
  ok: boolean;
  output: unknown;
  error?: string;
  durationMs: number;
}

export async function testMcpTool(payload: {
  serverId: string;
  label?: string;
  connection?: Record<string, unknown>;
  secretRef?: { secretId: string };
  toolName: string;
  args?: Record<string, unknown>;
}) {
  return apiRequest<McpTestToolResult>("/api/mcp/test-tool", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export type {
  McpBreakerSettings,
  McpCredentialMode,
  McpDelegatedFallback,
  McpMyConnection,
  McpRuntimeLimits,
  McpRuntimeStateView,
  McpSandboxPolicyView,
  McpSandboxSettings,
  McpSandboxStatus,
  McpToolLimitRule,
  McpUserConnectionView
};

export interface McpPreset {
  id: string;
  name: string;
  category: string;
  description: string;
  source: string;
  serverAdapter: "stdio_mcp" | "http_mcp";
  connection: Record<string, unknown>;
  credentialHint?: {
    envVar: string;
    secretEnvVar?: string;
    description: string;
  };
  notes?: string;
  /** Phase 10.7 — sandbox the form starts with (catalog entries may carry one). */
  sandbox?: McpSandboxSettings;
  /** Phase 10.6 — built-in preset or an approved entry of the deployment catalog. */
  origin?: "builtin" | "catalog";
  tags?: string[];
  requiredSecrets?: Array<{ name: string; description?: string }>;
}

export async function fetchMcpPresets() {
  return apiRequest<{ presets: McpPreset[]; catalog?: McpCatalogStatus }>("/api/mcp/presets");
}

export interface SecretListItem {
  id: string;
  name: string;
  provider: string;
  createdAt: string;
  projectId?: string;
  source?: "local" | "external";
  externalProviderId?: string | null;
  externalKey?: string | null;
}

export async function fetchSecrets(options: { projectId?: string } = {}) {
  const query = options.projectId ? `?projectId=${encodeURIComponent(options.projectId)}` : "";
  return apiRequest<SecretListItem[]>(`/api/secrets${query}`);
}

export async function createSecret(payload: {
  name: string;
  provider: string;
  value: string;
  projectId?: string;
}) {
  return apiRequest<{
    id: string;
    name: string;
    provider: string;
    projectId: string;
    /** Non-blocking notes about the saved value; they never contain it. */
    warnings?: string[];
  }>("/api/secrets", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

// --- Phase 4.2: projects, folders, workflow move ---------------------------

export async function fetchProjects() {
  return apiRequest<{ projects: Project[] }>("/api/projects");
}

export async function createProject(payload: { name: string; description?: string; id?: string }) {
  return apiRequest<Project>("/api/projects", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateProject(
  id: string,
  payload: { name: string; description?: string }
) {
  return apiRequest<Project>(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export async function deleteProject(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function fetchFolders(projectId?: string) {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return apiRequest<{ folders: Folder[] }>(`/api/folders${query}`);
}

export async function createFolder(payload: {
  name: string;
  projectId: string;
  parentId?: string;
  id?: string;
}) {
  return apiRequest<Folder>("/api/folders", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateFolder(
  id: string,
  payload: { name: string; projectId: string; parentId?: string }
) {
  return apiRequest<Folder>(`/api/folders/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export async function deleteFolder(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/folders/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function moveWorkflow(
  workflowId: string,
  payload: { projectId?: string; folderId?: string | null; tags?: string[] }
) {
  return apiRequest<Workflow>(`/api/workflows/${encodeURIComponent(workflowId)}/move`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function testConnector(payload: {
  connectorId: string;
  connectorConfig?: Record<string, unknown>;
}) {
  return apiRequest<{
    ok: boolean;
    message: string;
  }>("/api/connectors/test", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function testProvider(payload: {
  provider: LLMProviderConfig;
  prompt?: string;
  systemPrompt?: string;
}): Promise<{
  ok: boolean;
  message: string;
  providerId?: string;
  model?: string;
  latencyMs?: number;
  preview?: string;
}> {
  const response = await apiFetch(`${API_BASE}/api/providers/test`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const json = await response.json().catch(() => null);
  if (json && typeof json === "object" && "ok" in json) {
    return json as { ok: boolean; message: string; providerId?: string; model?: string; latencyMs?: number; preview?: string };
  }

  throw new ApiError(
    (json && typeof json === "object" && "error" in json) ? String((json as Record<string, unknown>).error) : "API request failed",
    response.status
  );
}

export async function fetchProviderModels(payload: {
  providerId: string;
  secretRef?: { secretId: string };
  baseUrl?: string;
  extra?: Record<string, unknown>;
}) {
  return apiRequest<{
    models: Array<{ id: string; label: string }>;
  }>("/api/providers/models", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function previewExpression(payload: {
  expression: string;
  mode?: "expression" | "template";
  context?: {
    input?: unknown;
    vars?: Record<string, unknown>;
    nodeOutputs?: Record<string, unknown>;
    workflow?: { id?: string; name?: string };
    executionId?: string;
    customData?: Record<string, unknown>;
  };
}) {
  return apiRequest<{
    ok: boolean;
    result?: unknown;
    error?: string;
  }>("/api/expressions/preview", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export interface ExecutionHistorySummary {
  id: string;
  workflowId: string;
  workflowName: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  triggerType: string | null;
  triggeredBy: string | null;
  customData: unknown;
  error: string | null;
  createdAt: string;
  /** Phase 10.8 — present when the run was recorded into a cassette. */
  mcpCassette?: McpCassetteBadge;
  /** Phase 15.1 — present when the run was saved as one or more golden runs. */
  goldenRuns?: ReplayGoldenBadge;
}

export interface ExecutionHistoryDetail extends ExecutionHistorySummary {
  input: unknown;
  output: unknown;
  nodeResults: unknown;
}

export async function fetchExecutions(input?: {
  page?: number;
  pageSize?: number;
  status?: string;
  workflowId?: string;
  triggerType?: string;
  startedFrom?: string;
  startedTo?: string;
}) {
  const params = new URLSearchParams();
  if (typeof input?.page === "number") {
    params.set("page", String(input.page));
  }
  if (typeof input?.pageSize === "number") {
    params.set("pageSize", String(input.pageSize));
  }
  if (input?.status) {
    params.set("status", input.status);
  }
  if (input?.workflowId) {
    params.set("workflowId", input.workflowId);
  }
  if (input?.triggerType) {
    params.set("triggerType", input.triggerType);
  }
  if (input?.startedFrom) {
    params.set("startedFrom", input.startedFrom);
  }
  if (input?.startedTo) {
    params.set("startedTo", input.startedTo);
  }

  const suffix = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<{
    total: number;
    page: number;
    pageSize: number;
    items: ExecutionHistorySummary[];
  }>(`/api/executions${suffix}`);
}

export async function fetchExecutionById(id: string) {
  return apiRequest<ExecutionHistoryDetail>(`/api/executions/${id}`);
}

export async function retryExecution(id: string, payload: Record<string, unknown> = {}) {
  return apiRequest<WorkflowExecutionResult>(`/api/executions/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

// --- Phase 10.8: MCP cassettes -------------------------------------------------

export type {
  McpCassette as McpCassetteFile,
  McpCassetteBadge,
  McpCassetteEntry,
  McpCassetteExchange,
  McpCassetteRecord,
  McpCassetteSummary,
  McpReplayMode,
  McpReplayReport
};

export async function fetchMcpCassettes(filter: { workflowId?: string; evalRunId?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (filter.workflowId) params.set("workflowId", filter.workflowId);
  if (filter.evalRunId) params.set("evalRunId", filter.evalRunId);
  if (filter.limit) params.set("limit", String(filter.limit));
  const q = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<{ items: McpCassetteSummary[]; total: number }>(`/api/mcp/cassettes${q}`);
}

export async function fetchMcpCassette(id: string) {
  return apiRequest<{ cassette: McpCassetteRecord }>(`/api/mcp/cassettes/${encodeURIComponent(id)}`);
}

export function mcpCassetteExportUrl(id: string): string {
  return `${API_BASE}/api/mcp/cassettes/${encodeURIComponent(id)}/export`;
}

export async function deleteMcpCassette(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/mcp/cassettes/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// Phase 15.1 — golden runs and replay.
export type { ReplayGoldenBadge, ReplayMcpMode, ReplayRecordingDetail, ReplayRecordingSummary, ReplayRunRequest, ReplayRunResponse };

export async function createReplayRecording(payload: { executionId: string; name: string; notes?: string }) {
  return apiRequest<{ recording: ReplayRecordingSummary }>("/api/replay/recordings", { method: "POST", body: JSON.stringify(payload) });
}

export async function fetchReplayRecordings(filter: { workflowId?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (filter.workflowId) params.set("workflowId", filter.workflowId);
  if (filter.limit) params.set("limit", String(filter.limit));
  const q = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<{ items: ReplayRecordingSummary[]; total: number }>(`/api/replay/recordings${q}`);
}

export async function fetchReplayRecording(id: string) {
  return apiRequest<{ recording: ReplayRecordingDetail }>(`/api/replay/recordings/${encodeURIComponent(id)}`);
}

export async function deleteReplayRecording(id: string) {
  return apiRequest<{ deleted: boolean }>(`/api/replay/recordings/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function runReplay(id: string, payload: ReplayRunRequest = {}) {
  return apiRequest<ReplayRunResponse>(`/api/replay/recordings/${encodeURIComponent(id)}/replay`, { method: "POST", body: JSON.stringify(payload) });
}

export async function replayExecution(id: string, payload: { mode?: McpReplayMode; cassetteId?: string } = {}) {
  return apiRequest<WorkflowExecutionResult & { executionId?: string; mcpReplay?: McpReplayReport }>(
    `/api/executions/${encodeURIComponent(id)}/replay`,
    { method: "POST", body: JSON.stringify(payload) }
  );
}

export async function cancelExecution(id: string, reason?: string) {
  return apiRequest<{
    ok: boolean;
    id: string;
    status: "canceled";
    abortedActiveRun: boolean;
    completedAt: string;
  }>(`/api/executions/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {})
  });
}

export async function testCodeNode(payload: {
  code: string;
  timeout?: number;
  input?: Record<string, unknown>;
}) {
  return apiRequest<{
    result: unknown;
    logs: string[];
  }>("/api/code-node/test", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

// ---------------------------------------------------------------------------
// Phase 5.1 — MFA (TOTP)
// ---------------------------------------------------------------------------

export interface MfaStatus {
  enabled: boolean;
  pending: boolean;
  activatedAt: string | null;
  remainingBackupCodes: number;
}

export async function fetchMfaStatus() {
  return apiRequest<MfaStatus>("/api/auth/mfa/status");
}

export async function enrollMfa() {
  return apiRequest<{ secret: string; otpauthUrl: string; backupCodes: string[] }>(
    "/api/auth/mfa/enroll",
    { method: "POST" }
  );
}

export async function activateMfa(payload: { code: string }) {
  return apiRequest<{ enabled: boolean }>("/api/auth/mfa/activate", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function disableMfa(payload: { code?: string } = {}) {
  return apiRequest<{ ok: boolean }>("/api/auth/mfa/disable", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

/**
 * Phase 13.2 — the challenge id the web app keeps for an SSO sign-in waiting for the TOTP step. The API sent the real
 * challenge in an HttpOnly cookie, so the request carries only the code.
 */
export const SSO_MFA_CHALLENGE = "sso";

/** Phase 13.2 — true when an SSO callback landed here with `?sso_mfa=totp` (the local TOTP step comes next). */
export function isSsoMfaLanding(search: string): boolean {
  return new URLSearchParams(search).get("sso_mfa") === "totp";
}

/** Phase 13.2 — the URL without the one-shot SSO landing parameters (`sso_error`, `sso_mfa`). */
export function stripSsoLandingParams(pathname: string, search: string, hash: string): string | null {
  const params = new URLSearchParams(search);
  if (!params.has("sso_error") && !params.has("sso_mfa")) return null;
  params.delete("sso_error");
  params.delete("sso_mfa");
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}

export async function completeMfaLogin(payload: { challenge: string; code: string }) {
  if (payload.challenge === SSO_MFA_CHALLENGE) {
    return apiRequest<{ user: AuthUser; expiresAt: string }>("/api/auth/login/mfa", {
      method: "POST",
      body: JSON.stringify({ code: payload.code })
    });
  }
  return apiRequest<{ user: AuthUser; expiresAt: string }>("/api/auth/login/mfa", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

// loginUser's response type is refined here so callers can handle MFA challenges.
export interface LoginSuccessResponse {
  user: AuthUser;
  expiresAt: string;
  mfaEnrollmentRequired?: boolean;
}

export interface LoginMfaChallengeResponse {
  mfaChallenge: string;
  expiresInSeconds: number;
}

export type LoginResponse = LoginSuccessResponse | LoginMfaChallengeResponse;

export function isMfaChallenge(response: LoginResponse): response is LoginMfaChallengeResponse {
  return typeof (response as LoginMfaChallengeResponse).mfaChallenge === "string";
}

// ---------------------------------------------------------------------------
// Phase 5.1 — API keys
// ---------------------------------------------------------------------------

export interface ApiKeyRecord {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export async function fetchApiKeys() {
  return apiRequest<{ keys: ApiKeyRecord[] }>("/api/auth/api-keys");
}

export async function createApiKey(payload: { name: string; scopes?: string[]; expiresInDays?: number }) {
  return apiRequest<{ key: string; record: ApiKeyRecord }>("/api/auth/api-keys", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function revokeApiKey(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/auth/api-keys/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

// ---------------------------------------------------------------------------
// Phase 5.1 — SSO group mappings
// ---------------------------------------------------------------------------

export type SsoProvider = "saml" | "ldap" | "oidc";

export interface SsoGroupMapping {
  id: string;
  provider: SsoProvider;
  groupName: string;
  projectId: string | null;
  role: string;
  customRoleId: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function fetchSsoMappings(provider?: SsoProvider) {
  const query = provider ? `?provider=${provider}` : "";
  return apiRequest<{ mappings: SsoGroupMapping[] }>(`/api/auth/sso/mappings${query}`);
}

export async function createSsoMapping(payload: {
  provider: SsoProvider;
  groupName: string;
  projectId?: string | null;
  role: string;
  customRoleId?: string | null;
}) {
  return apiRequest<{ id: string }>("/api/auth/sso/mappings", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function deleteSsoMapping(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/auth/sso/mappings/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

// ---------------------------------------------------------------------------
// Phase 5.2 — Project members
// ---------------------------------------------------------------------------

export interface ProjectMembership {
  userId: string;
  projectId: string;
  role: "project_admin" | "editor" | "viewer" | "custom";
  customRoleId: string | null;
  permissions: string[];
}

export async function fetchProjectMembers(projectId: string) {
  return apiRequest<{ members: ProjectMembership[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/members`
  );
}

export async function addProjectMember(
  projectId: string,
  payload: { userId: string; role: string; customRoleId?: string | null }
) {
  return apiRequest<{ ok: boolean; membership: ProjectMembership }>(
    `/api/projects/${encodeURIComponent(projectId)}/members`,
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );
}

export async function removeProjectMember(projectId: string, userId: string) {
  return apiRequest<{ ok: boolean }>(
    `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" }
  );
}

// ---------------------------------------------------------------------------
// Phase 5.2 — Custom roles
// ---------------------------------------------------------------------------

export interface CustomRoleRecord {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  permissions: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function fetchCustomRoles(projectId?: string) {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return apiRequest<{ roles: CustomRoleRecord[]; availablePermissions: string[] }>(
    `/api/custom-roles${query}`
  );
}

export async function createCustomRole(payload: {
  name: string;
  description?: string | null;
  projectId?: string | null;
  permissions: string[];
}) {
  return apiRequest<{ id: string; role: CustomRoleRecord | null }>("/api/custom-roles", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateCustomRole(
  id: string,
  payload: {
    name?: string;
    description?: string | null;
    projectId?: string | null;
    permissions?: string[];
  }
) {
  return apiRequest<{ role: CustomRoleRecord | null }>(
    `/api/custom-roles/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(payload)
    }
  );
}

export async function deleteCustomRole(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/custom-roles/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

// ---------------------------------------------------------------------------
// Phase 5.2 — Workflow / secret sharing
// ---------------------------------------------------------------------------

export interface WorkflowShareRecord {
  workflowId: string;
  projectId: string;
  accessLevel: "read" | "execute";
  sharedBy: string | null;
  createdAt: string;
}

export async function fetchWorkflowShares(workflowId: string) {
  return apiRequest<{ shares: WorkflowShareRecord[] }>(
    `/api/workflows/${encodeURIComponent(workflowId)}/shares`
  );
}

export async function shareWorkflow(
  workflowId: string,
  payload: { projectId: string; accessLevel?: "read" | "execute" }
) {
  return apiRequest<{ ok: boolean }>(
    `/api/workflows/${encodeURIComponent(workflowId)}/shares`,
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );
}

export async function unshareWorkflow(workflowId: string, projectId: string) {
  return apiRequest<{ ok: boolean }>(
    `/api/workflows/${encodeURIComponent(workflowId)}/shares/${encodeURIComponent(projectId)}`,
    { method: "DELETE" }
  );
}

export interface SecretShareRecord {
  secretId: string;
  projectId: string;
  sharedBy: string | null;
  createdAt: string;
}

export async function fetchSecretShares(secretId: string) {
  return apiRequest<{ shares: SecretShareRecord[] }>(
    `/api/secrets/${encodeURIComponent(secretId)}/shares`
  );
}

export async function shareSecret(secretId: string, payload: { projectId: string }) {
  return apiRequest<{ ok: boolean }>(
    `/api/secrets/${encodeURIComponent(secretId)}/shares`,
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );
}

export async function unshareSecret(secretId: string, projectId: string) {
  return apiRequest<{ ok: boolean }>(
    `/api/secrets/${encodeURIComponent(secretId)}/shares/${encodeURIComponent(projectId)}`,
    { method: "DELETE" }
  );
}

// ---------------------------------------------------------------------------
// Phase 5.3 — External secret providers
// ---------------------------------------------------------------------------

export type ExternalSecretProviderType =
  | "aws-secrets-manager"
  | "hashicorp-vault"
  | "google-secret-manager"
  | "azure-key-vault"
  | "mock";

export interface ExternalSecretProviderRecord {
  id: string;
  name: string;
  type: ExternalSecretProviderType | string;
  config: Record<string, unknown>;
  credentialsSecretId: string | null;
  cacheTtlMs: number;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function fetchExternalProviders() {
  return apiRequest<{ providers: ExternalSecretProviderRecord[] }>("/api/external-providers");
}

export async function createExternalProvider(payload: {
  name: string;
  type: ExternalSecretProviderType | string;
  config?: Record<string, unknown>;
  credentialsSecretId?: string | null;
  cacheTtlMs?: number;
}) {
  return apiRequest<{ id: string; provider: ExternalSecretProviderRecord | null }>(
    "/api/external-providers",
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );
}

export async function updateExternalProvider(
  id: string,
  payload: {
    name?: string;
    config?: Record<string, unknown>;
    credentialsSecretId?: string | null;
    cacheTtlMs?: number;
    enabled?: boolean;
  }
) {
  return apiRequest<{ provider: ExternalSecretProviderRecord | null }>(
    `/api/external-providers/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(payload)
    }
  );
}

export async function deleteExternalProvider(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/external-providers/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export async function testExternalProvider(id: string, payload: { key: string }) {
  return apiRequest<{ ok: boolean; length: number }>(
    `/api/external-providers/${encodeURIComponent(id)}/test`,
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );
}

// Extend createSecret to support external references.
export async function createExternalSecret(payload: {
  name: string;
  provider: string;
  externalProviderId: string;
  externalKey: string;
  projectId?: string;
}) {
  return apiRequest<{
    id: string;
    name: string;
    provider: string;
    projectId: string;
    source: "external";
    warnings?: string[];
  }>("/api/secrets", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function deleteSecret(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/secrets/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

// ---------------------------------------------------------------------------
// Phase 5.4 — Audit log
// ---------------------------------------------------------------------------

export interface AuditLogEntry {
  id: string;
  eventType: string;
  category: string;
  action: string;
  outcome: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorType: string;
  resourceType: string | null;
  resourceId: string | null;
  projectId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
  message: string | null;
  createdAt: string;
}

export interface AuditLogFilter {
  category?: string;
  eventType?: string;
  outcome?: string;
  actorUserId?: string;
  resourceType?: string;
  resourceId?: string;
  projectId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export async function fetchAuditLogs(filter: AuditLogFilter = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<{
    items: AuditLogEntry[];
    total: number;
    page: number;
    pageSize: number;
  }>(`/api/audit${suffix}`);
}

export function auditExportUrl(filter: AuditLogFilter = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return `${API_BASE}/api/audit/export${suffix}`;
}

// ---------------------------------------------------------------------------
// Phase 5.5 — Log streaming
// ---------------------------------------------------------------------------

export type LogStreamDestinationType = "syslog" | "webhook" | "sentry";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogStreamDestination {
  id: string;
  name: string;
  type: LogStreamDestinationType | string;
  enabled: boolean;
  categories: string[];
  minLevel: LogLevel | string;
  config: Record<string, unknown>;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  dispatchedCount: number;
  failedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LogStreamDeliveryEvent {
  id: string;
  destinationId: string;
  category: string;
  eventType: string;
  level: string;
  status: string;
  attempts: number;
  error: string | null;
  createdAt: string;
}

export async function fetchLogStreamDestinations() {
  return apiRequest<{ destinations: LogStreamDestination[] }>("/api/log-streams");
}

export async function createLogStreamDestination(payload: {
  name: string;
  type: LogStreamDestinationType;
  enabled?: boolean;
  categories?: string[];
  minLevel?: LogLevel;
  config: Record<string, unknown>;
}) {
  return apiRequest<{ destination: LogStreamDestination }>("/api/log-streams", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateLogStreamDestination(
  id: string,
  payload: {
    name?: string;
    enabled?: boolean;
    categories?: string[];
    minLevel?: LogLevel;
    config?: Record<string, unknown>;
  }
) {
  return apiRequest<{ destination: LogStreamDestination }>(
    `/api/log-streams/${encodeURIComponent(id)}`,
    { method: "PUT", body: JSON.stringify(payload) }
  );
}

export async function deleteLogStreamDestination(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/log-streams/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export async function testLogStreamDestination(id: string) {
  return apiRequest<{ ok: boolean; error?: string }>(
    `/api/log-streams/${encodeURIComponent(id)}/test`,
    { method: "POST", body: "{}" }
  );
}

export async function fetchLogStreamDeliveryEvents(id: string) {
  return apiRequest<{ events: LogStreamDeliveryEvent[] }>(
    `/api/log-streams/${encodeURIComponent(id)}/events`
  );
}

// ---------------------------------------------------------------------------
// Phase 5.6 — Variables
// ---------------------------------------------------------------------------

export interface VariableRecord {
  id: string;
  projectId: string;
  key: string;
  value: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function fetchVariables(projectId?: string) {
  const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return apiRequest<{ variables: VariableRecord[] }>(`/api/variables${suffix}`);
}

export async function createVariable(payload: { projectId: string; key: string; value: string }) {
  return apiRequest<{ variable: VariableRecord }>("/api/variables", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateVariable(id: string, payload: { key?: string; value?: string }) {
  return apiRequest<{ variable: VariableRecord }>(
    `/api/variables/${encodeURIComponent(id)}`,
    { method: "PUT", body: JSON.stringify(payload) }
  );
}

export async function deleteVariable(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/variables/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

// ---------------------------------------------------------------------------
// Phase 5.6 — Workflow version history
// ---------------------------------------------------------------------------

export interface WorkflowVersionSummary {
  id: string;
  workflowId: string;
  version: number;
  createdBy: string | null;
  changeNote: string | null;
  createdAt: string;
}

export async function fetchWorkflowVersions(workflowId: string) {
  return apiRequest<{ versions: WorkflowVersionSummary[] }>(
    `/api/workflows/${encodeURIComponent(workflowId)}/versions`
  );
}

export async function fetchWorkflowVersion(workflowId: string, version: number) {
  return apiRequest<{
    id: string;
    workflowId: string;
    version: number;
    createdBy: string | null;
    changeNote: string | null;
    createdAt: string;
    workflow: unknown;
  }>(`/api/workflows/${encodeURIComponent(workflowId)}/versions/${version}`);
}

export async function restoreWorkflowVersion(workflowId: string, version: number) {
  return apiRequest<unknown>(
    `/api/workflows/${encodeURIComponent(workflowId)}/versions/${version}/restore`,
    { method: "POST", body: "{}" }
  );
}

// ---------------------------------------------------------------------------
// Phase 5.6 — Git source control
// ---------------------------------------------------------------------------

export interface GitConfigRecord {
  repoUrl: string;
  defaultBranch: string;
  authSecretId: string | null;
  workflowsDir: string;
  variablesFile: string;
  userName: string;
  userEmail: string;
  enabled: boolean;
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface GitStatusRecord {
  configured: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
}

export interface GitSyncResult {
  ok: boolean;
  branch?: string;
  commit?: string;
  error?: string;
  workflowsExported?: number;
  workflowsImported?: number;
  workflowsRefused?: Array<{ workflowId: string; file: string; reason: string }>;
  variablesSynced?: number;
}

export async function fetchGitConfig() {
  return apiRequest<{ config: GitConfigRecord | null; status: GitStatusRecord }>("/api/git");
}

export async function updateGitConfig(payload: {
  repoUrl: string;
  defaultBranch?: string;
  authSecretId?: string | null;
  workflowsDir?: string;
  variablesFile?: string;
  userName?: string;
  userEmail?: string;
  enabled?: boolean;
}) {
  return apiRequest<{ config: GitConfigRecord; status: GitStatusRecord }>("/api/git", {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export async function disconnectGit() {
  return apiRequest<{ ok: boolean }>("/api/git", { method: "DELETE" });
}

export async function pushGit(payload: { branch?: string; message?: string } = {}) {
  return apiRequest<GitSyncResult>("/api/git/push", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function pullGit(payload: { branch?: string } = {}) {
  return apiRequest<GitSyncResult>("/api/git/pull", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

// ---------------------------------------------------------------------------
// Phase 5.7 — Observability
// ---------------------------------------------------------------------------

export interface MetricsSnapshot {
  httpRequestsTotal: number;
  executionsTotal: number;
  executionsSuccess: number;
  executionsFailure: number;
  activeExecutions: number;
  executionP50Ms: number;
  executionP95Ms: number;
  executionP99Ms: number;
  httpP50Ms: number;
  httpP95Ms: number;
  slo: SloStatusRecord;
  uptimeSeconds: number;
}

export interface SloStatusRecord {
  successTarget: number;
  p95LatencyTargetMs: number;
  currentSuccessRate: number;
  currentP95LatencyMs: number;
  successBudgetRemaining: number;
  latencyBudgetRemaining: number;
  healthy: boolean;
}

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  operationName: string;
  startTimeMs: number;
  endTimeMs: number | null;
  durationMs: number | null;
  attributes: Record<string, string | number | boolean>;
  status: "ok" | "error" | "unset";
  events: Array<{ name: string; timestampMs: number; attributes?: Record<string, unknown> }>;
}

export async function fetchObservability() {
  return apiRequest<{ metrics: MetricsSnapshot; tracing: { enabled: boolean } }>(
    "/api/observability"
  );
}

export async function fetchSloStatus() {
  return apiRequest<SloStatusRecord>("/api/observability/slo");
}

export async function fetchRecentTraces(limit = 50) {
  return apiRequest<{ spans: TraceSpan[] }>(
    `/api/observability/traces?limit=${Math.min(200, Math.max(1, limit))}`
  );
}

// ---------------------------------------------------------------------------
// Phase 8.2 — FinOps cost rollups
// ---------------------------------------------------------------------------

export interface UsageTotals {
  executions: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: number;
  llmCallCount: number;
  avgDurationMs: number;
}

export interface UsageRollupRow extends UsageTotals {
  bucket: string;
  workflowId?: string | null;
  workflowName?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  projectId?: string | null;
  providerId?: string | null;
  model?: string | null;
}

export type UsageGroupBy = "day" | "hour" | "workflow" | "user" | "project" | "provider";

export interface UsageEvent {
  id: string;
  executionId: string;
  workflowId: string;
  workflowName: string | null;
  userId: string | null;
  userEmail: string | null;
  projectId: string | null;
  triggerType: string | null;
  status: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: number;
  llmCallCount: number;
  durationMs: number;
  providers: Array<{ providerId: string; model: string; calls: number }>;
  createdAt: string;
}

export interface UsageWindow {
  from: string;
  to: string;
}

function buildUsageQuery(filter: { from?: string; to?: string; workflowId?: string; userId?: string; projectId?: string; groupBy?: UsageGroupBy; limit?: number }): string {
  const params = new URLSearchParams();
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  if (filter.workflowId) params.set("workflowId", filter.workflowId);
  if (filter.userId) params.set("userId", filter.userId);
  if (filter.projectId) params.set("projectId", filter.projectId);
  if (filter.groupBy) params.set("groupBy", filter.groupBy);
  if (filter.limit) params.set("limit", String(filter.limit));
  const s = params.toString();
  return s ? `?${s}` : "";
}

export async function fetchUsageTotals(filter: { from?: string; to?: string; workflowId?: string; userId?: string; projectId?: string } = {}) {
  return apiRequest<{ window: UsageWindow; totals: UsageTotals }>(
    `/api/usage/totals${buildUsageQuery(filter)}`
  );
}

export async function fetchUsageRollup(filter: { from?: string; to?: string; groupBy?: UsageGroupBy; workflowId?: string; userId?: string; projectId?: string; limit?: number } = {}) {
  return apiRequest<{ window: UsageWindow; groupBy: UsageGroupBy; rows: UsageRollupRow[] }>(
    `/api/usage/rollup${buildUsageQuery(filter)}`
  );
}

export async function fetchRecentUsage(filter: { limit?: number; workflowId?: string; userId?: string; projectId?: string } = {}) {
  return apiRequest<{ events: UsageEvent[] }>(
    `/api/usage/recent${buildUsageQuery(filter)}`
  );
}

export async function fetchUsagePricing() {
  return apiRequest<{ pricing: Record<string, Record<string, { inputUsdPer1M: number; outputUsdPer1M: number; cachedInputUsdPer1M?: number }>> }>(
    "/api/usage/pricing"
  );
}

// ---------------------------------------------------------------------------
// Phase 8.3 — Budgets
// ---------------------------------------------------------------------------

export type BudgetScopeType = "global" | "project" | "workflow" | "user";
export type BudgetPeriod = "day" | "week" | "month";
export type BudgetLimitType = "usd" | "tokens";
export type BudgetAction = "warn" | "block";

export interface Budget {
  id: string;
  name: string;
  scopeType: BudgetScopeType;
  scopeId: string | null;
  period: BudgetPeriod;
  limitType: BudgetLimitType;
  limitValue: number;
  warnThresholdPct: number;
  action: BudgetAction;
  notifyChannel: string | null;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetAlert {
  id: string;
  budgetId: string;
  periodStart: string;
  severity: "warn" | "block";
  usageValue: number;
  limitValue: number;
  workflowId: string | null;
  executionId: string | null;
  message: string | null;
  firedAt: string;
}

export async function fetchBudgets() {
  return apiRequest<{ budgets: Budget[] }>("/api/budgets");
}

export async function createBudget(payload: {
  name: string;
  scopeType: BudgetScopeType;
  scopeId?: string | null;
  period: BudgetPeriod;
  limitType: BudgetLimitType;
  limitValue: number;
  warnThresholdPct?: number;
  action: BudgetAction;
  notifyChannel?: string | null;
}) {
  return apiRequest<{ budget: Budget }>("/api/budgets", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateBudget(id: string, patch: Partial<{
  name: string;
  limitValue: number;
  warnThresholdPct: number;
  action: BudgetAction;
  notifyChannel: string | null;
  enabled: boolean;
}>) {
  return apiRequest<{ budget: Budget }>(`/api/budgets/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch)
  });
}

export async function deleteBudgetApi(id: string) {
  return apiRequest<{ ok: true }>(`/api/budgets/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export async function fetchBudgetAlerts(filter: { budgetId?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (filter.budgetId) params.set("budgetId", filter.budgetId);
  if (filter.limit) params.set("limit", String(filter.limit));
  const qs = params.toString();
  return apiRequest<{ alerts: BudgetAlert[] }>(`/api/budget-alerts${qs ? `?${qs}` : ""}`);
}

// ---------------------------------------------------------------------------
// Phase 8.4 — Audit chain + export
// ---------------------------------------------------------------------------

export interface AuditChainStatus {
  ok: boolean;
  rowsChecked: number;
  firstBrokenAt?: { id: string; createdAt: string; expected: string; stored: string };
  /**
   * Rows whose content cannot be checked (a row written before audit text was normalised, or an edit); `ok` is false
   * while present. `position` (1-based walk index), `prevHash` and `entryHash` place the row in the chain; `id` and
   * `createdAt` are as stored, unverified.
   */
  unverifiable?: Array<{ id: string; createdAt: string; position: number; prevHash: string; entryHash: string; reason: string }>;
}

export interface AuditExportDestination {
  id: string;
  name: string;
  kind: "http" | "file";
  config: Record<string, unknown>;
  intervalSeconds: number;
  enabled: boolean;
  lastExportId: string | null;
  lastExportAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function verifyAuditChain() {
  return apiRequest<AuditChainStatus>("/api/audit-log/verify-chain");
}

export async function fetchAuditExportDestinations() {
  return apiRequest<{ destinations: AuditExportDestination[] }>("/api/audit-export/destinations");
}

export async function createAuditExportDestination(payload: {
  name: string;
  kind: "http" | "file";
  config: Record<string, unknown>;
  intervalSeconds?: number;
  enabled?: boolean;
}) {
  return apiRequest<{ destination: AuditExportDestination }>("/api/audit-export/destinations", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function deleteAuditExportDestination(id: string) {
  return apiRequest<{ ok: true }>(`/api/audit-export/destinations/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export async function runAuditExportDestination(id: string) {
  return apiRequest<{ outcome: { status: string; rowsExported: number; firstId: string | null; lastId: string | null; error: string | null } }>(
    `/api/audit-export/destinations/${encodeURIComponent(id)}/run`,
    { method: "POST" }
  );
}

// ---------------------------------------------------------------------------
// Phase 9.1 / 9.2 — Knowledge bases
// ---------------------------------------------------------------------------

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  projectId: string | null;
  embedderId: string;
  embedderConfig: Record<string, unknown>;
  dimensions: number;
  chunkCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseSource {
  sourceId: string;
  chunkCount: number;
}

export interface KnowledgeBaseChunkPreview {
  id: string;
  sourceId: string | null;
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export type ChunkStrategy = "separator" | "character" | "recursive" | "token";
export type DocumentKind = "text" | "markdown" | "html" | "csv" | "json";

export interface ChunkOptions {
  strategy?: ChunkStrategy;
  chunkSize?: number;
  chunkOverlap?: number;
  separator?: string;
}

export async function fetchKnowledgeBases(projectId?: string) {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return apiRequest<{ knowledgeBases: KnowledgeBase[] }>(`/api/knowledge-bases${qs}`);
}

export async function fetchKnowledgeBase(id: string) {
  return apiRequest<{ knowledgeBase: KnowledgeBase; sources: KnowledgeBaseSource[] }>(
    `/api/knowledge-bases/${encodeURIComponent(id)}`
  );
}

export async function createKnowledgeBase(payload: {
  name: string;
  description?: string | null;
  projectId?: string | null;
  embedderId: string;
  embedderConfig?: Record<string, unknown>;
}) {
  return apiRequest<{ knowledgeBase: KnowledgeBase }>("/api/knowledge-bases", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateKnowledgeBase(id: string, patch: Partial<{
  name: string;
  description: string | null;
  embedderConfig: Record<string, unknown>;
}>) {
  return apiRequest<{ knowledgeBase: KnowledgeBase }>(`/api/knowledge-bases/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch)
  });
}

export async function deleteKnowledgeBaseApi(id: string) {
  return apiRequest<{ ok: true }>(`/api/knowledge-bases/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export async function uploadKnowledgeBaseDocument(id: string, payload: {
  filename?: string;
  kind?: DocumentKind;
  content: string;
  sourceId?: string;
  chunking?: ChunkOptions;
  csv?: { textColumn?: string; metadataColumns?: string[] };
  metadata?: Record<string, unknown>;
}) {
  return apiRequest<{
    sourceId: string;
    documentsLoaded: number;
    chunksInserted: number;
    dimensions: number;
  }>(`/api/knowledge-bases/${encodeURIComponent(id)}/upload`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function fetchKnowledgeBaseChunks(id: string, options: { limit?: number; sourceId?: string } = {}) {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  if (options.sourceId) params.set("sourceId", options.sourceId);
  const qs = params.toString();
  return apiRequest<{ chunks: KnowledgeBaseChunkPreview[] }>(
    `/api/knowledge-bases/${encodeURIComponent(id)}/chunks${qs ? `?${qs}` : ""}`
  );
}

export async function deleteKnowledgeBaseSource(id: string, sourceId: string) {
  return apiRequest<{ removed: number }>(
    `/api/knowledge-bases/${encodeURIComponent(id)}/sources/${encodeURIComponent(sourceId)}`,
    { method: "DELETE" }
  );
}

export async function searchKnowledgeBase(id: string, query: string, topK = 5) {
  return apiRequest<{
    query: string;
    results: Array<{
      id: string;
      text: string;
      metadata: Record<string, unknown> & {
        knowledgeBaseId?: string;
        chunkId?: string;
        chunkIndex?: number;
        sourceId?: string | null;
        similarityScore?: number;
      };
    }>;
  }>(`/api/knowledge-bases/${encodeURIComponent(id)}/search`, {
    method: "POST",
    body: JSON.stringify({ query, topK })
  });
}

// ---------------------------------------------------------------------------
// Phase 7.4 — Workflow templates & sharing
// ---------------------------------------------------------------------------

export type TemplateDependencyKind =
  | "provider"
  | "vector_store"
  | "mcp_server"
  | "connector";

export interface TemplateDependency {
  kind: TemplateDependencyKind;
  label: string;
  envVar?: string;
}

export interface TemplateListItem {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  author: string;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
  /** External dependencies detected from the workflow JSON (OpenAI key, Pinecone, etc.).
   *  Empty array = the template runs out-of-the-box (e.g. uses the built-in echo provider). */
  dependencies?: TemplateDependency[];
  /** Server-generated SVG bird's-eye sketch of the workflow's nodes + edges,
   *  embedded inline via dangerouslySetInnerHTML. Empty string when the workflow
   *  has no nodes or its JSON failed to parse. */
  thumbnailSvg?: string;
  /** Curated hero templates: float to the top of the gallery and render with
   *  a "Featured" badge. Set server-side from the FEATURED_TEMPLATE_IDS list. */
  featured?: boolean;
}

export async function fetchTemplates(filters?: { category?: string; search?: string }) {
  const params = new URLSearchParams();
  if (filters?.category) params.set("category", filters.category);
  if (filters?.search) params.set("search", filters.search);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<{ templates: TemplateListItem[] }>(`/api/templates${suffix}`);
}

export async function fetchTemplate(id: string) {
  return apiRequest<TemplateListItem & { workflowJson: string }>(`/api/templates/${id}`);
}

export async function useTemplate(templateId: string) {
  return apiRequest<{ workflowId: string; name: string }>(`/api/templates/${templateId}/use`, {
    method: "POST"
  });
}

export async function createTemplate(payload: {
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  workflowId?: string;
  workflowJson?: string;
}) {
  return apiRequest<{ id: string; name: string }>("/api/templates", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function deleteTemplate(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/templates/${id}`, {
    method: "DELETE"
  });
}

export async function getWorkflowShareLink(workflowId: string) {
  return apiRequest<{ shareUrl: string }>(`/api/workflows/${workflowId}/share-link`);
}

// ---------------------------------------------------------------------------
// Phase 7.5 — Notifications
// ---------------------------------------------------------------------------

export interface NotificationConfig {
  id: string;
  channel: "email" | "slack" | "teams";
  enabled: boolean;
  config: Record<string, unknown>;
  events: string[];
  createdAt: string;
  updatedAt: string;
}

export async function fetchNotificationConfigs() {
  return apiRequest<{ configs: NotificationConfig[] }>("/api/notifications");
}

export async function upsertNotificationConfig(payload: {
  id?: string;
  channel: string;
  enabled: boolean;
  config: Record<string, unknown>;
  events: string[];
}) {
  return apiRequest<{ id: string }>("/api/notifications", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function deleteNotificationConfig(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/notifications/${id}`, {
    method: "DELETE"
  });
}

export async function testNotificationConfig(payload: {
  channel: string;
  config: Record<string, unknown>;
}) {
  return apiRequest<{ ok: boolean; message: string }>("/api/notifications/test", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

// ---------------------------------------------------------------------------
// Phase 6 — Community node SDK
// ---------------------------------------------------------------------------

export interface CommunityNodePackageState {
  packageName: string;
  version: string;
  state: "loaded" | "errored" | "unsupported";
  apiVersion?: number;
  displayName?: string;
  description?: string;
  author?: string;
  homepage?: string;
  license?: string;
  contributions: { providers: number; mcpAdapters: number; connectors: number };
  error?: string;
}

export interface CommunityNodesStatus {
  enabled: boolean;
  pluginsDir?: string;
  allowlist?: string[];
  packages?: CommunityNodePackageState[];
  error?: string;
}

export async function fetchCommunityNodes() {
  return apiRequest<CommunityNodesStatus>("/api/community-nodes");
}

export async function installCommunityNode(packageSpec: string) {
  return apiRequest<{ ok: boolean; package: CommunityNodePackageState }>("/api/community-nodes/install", {
    method: "POST",
    body: JSON.stringify({ packageSpec })
  });
}

export async function uninstallCommunityNode(packageName: string) {
  return apiRequest<{ ok: boolean }>(`/api/community-nodes/${encodeURIComponent(packageName)}`, {
    method: "DELETE"
  });
}

export async function reloadCommunityNodes() {
  return apiRequest<{ ok: boolean; packages: CommunityNodePackageState[] }>("/api/community-nodes/reload", {
    method: "POST"
  });
}

// ---------------------------------------------------------------------------
// Phase 7.3 — Agent eval framework
// ---------------------------------------------------------------------------

export type {
  EvalCaseDetail,
  EvalCaseResult,
  EvalCaseStatus,
  EvalRunEvent,
  EvalRunProgress,
  EvalRunSummary,
  EvalRunView,
  EvalScoreDetail,
  EvalScorerSpec,
  EvalScorerType,
  LlmJudgeMode,
  ReplayCaseDiff,
  ReplayJobCandidate,
  ReplayJobOptions,
  ReplayJobEstimate,
  ReplayJobRequest,
  ToolSequenceMode
};

export interface EvalDataset {
  id: string;
  name: string;
  description: string | null;
  projectId: string | null;
  /** Phase 15.2 — set on a golden set: the workflow its golden runs belong to. */
  workflowId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  fixtureCount: number;
  /** Phase 15.2 — cases that replay a golden run. */
  goldenRunCount: number;
}

export interface EvalFixture {
  id: string;
  datasetId: string;
  name: string;
  input: unknown;
  expected: unknown | null;
  scorers: EvalScorerSpec[] | null;
  /** Phase 15.2 — the golden run this case replays; null on a hand-written fixture. */
  recordingId: string | null;
  /** On an enforced release gate this case must pass whatever the pass rate (admins set it). */
  required?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type EvalRun = EvalRunView & {
  /** Phase 10.8 — how many cassettes the run recorded. */
  mcpCassettes?: number;
};

export type EvalResult = EvalCaseResult & { output: unknown };

/** A replay job as `GET /api/replay/runs/:id` returns it: the run with its case results (without outputs). */
export type ReplayJobDetail = EvalRunView & { results: EvalCaseResult[] };

export async function fetchEvalDatasets(projectId?: string, filter: { workflowId?: string } = {}) {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (filter.workflowId) params.set("workflowId", filter.workflowId);
  const q = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<{ datasets: EvalDataset[] }>(`/api/eval/datasets${q}`);
}

/** `workflowId` makes the dataset a golden set of that workflow (Phase 15.2). */
export async function createEvalDataset(payload: { name: string; description?: string; projectId?: string; workflowId?: string }) {
  return apiRequest<{ dataset: EvalDataset }>("/api/eval/datasets", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function deleteEvalDataset(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/eval/datasets/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function fetchEvalFixtures(datasetId: string) {
  return apiRequest<{ fixtures: EvalFixture[] }>(`/api/eval/datasets/${encodeURIComponent(datasetId)}/fixtures`);
}

export async function createEvalFixture(datasetId: string, payload: { name: string; input: unknown; expected?: unknown; scorers?: EvalScorerSpec[] }) {
  return apiRequest<{ fixture: EvalFixture }>(`/api/eval/datasets/${encodeURIComponent(datasetId)}/fixtures`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function deleteEvalFixture(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/eval/fixtures/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export interface StartEvalRunPayload {
  datasetId: string;
  workflowId: string;
  scorers?: EvalScorerSpec[];
  /** Phase 10.8 — record each fixture's MCP calls into a cassette. */
  record?: boolean;
  /** Phase 10.8 — answer MCP calls from an earlier run's cassettes, or from one cassette. */
  replay?: { evalRunId?: string; cassetteId?: string; mode?: McpReplayMode };
}

/** Phase 15.2 — queues the run and answers 202 at once; follow it with `subscribeEvalRun` or `fetchEvalRun`. */
export async function startEvalRun(payload: StartEvalRunPayload) {
  return apiRequest<{ run: EvalRunView; runId: string }>("/api/eval/runs", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function fetchEvalRuns(filter: { datasetId?: string; workflowId?: string; kind?: "eval" | "replay"; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (filter.datasetId) params.set("datasetId", filter.datasetId);
  if (filter.workflowId) params.set("workflowId", filter.workflowId);
  if (filter.kind) params.set("kind", filter.kind);
  if (filter.limit) params.set("limit", String(filter.limit));
  const q = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<{ runs: EvalRun[] }>(`/api/eval/runs${q}`);
}

export async function fetchEvalRun(id: string) {
  return apiRequest<EvalRun & { results: EvalResult[] }>(`/api/eval/runs/${encodeURIComponent(id)}`);
}

export async function cancelEvalRun(id: string) {
  return apiRequest<{ run: EvalRunView }>(`/api/eval/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

// --- Phase 15.2: golden sets and replay jobs ----------------------------------

/** Adds a golden run of the set's workflow to a golden set as a case. */
export async function addGoldenRunToSet(datasetId: string, payload: { recordingId: string; name?: string; scorers?: EvalScorerSpec[] }) {
  return apiRequest<{ fixture: EvalFixture }>(`/api/eval/datasets/${encodeURIComponent(datasetId)}/recordings`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function startReplayJob(payload: ReplayJobRequest) {
  return apiRequest<{ run: EvalRunView }>("/api/replay/runs", { method: "POST", body: JSON.stringify(payload) });
}

/** Phase 15.3 — what a replay job would run and cost; checked like starting it, nothing runs. */
export async function estimateReplayJob(payload: ReplayJobRequest) {
  return apiRequest<ReplayJobEstimate>("/api/replay/estimate", { method: "POST", body: JSON.stringify(payload) });
}

export async function fetchReplayJobs(filter: { workflowId?: string; datasetId?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (filter.workflowId) params.set("workflowId", filter.workflowId);
  if (filter.datasetId) params.set("datasetId", filter.datasetId);
  if (filter.limit) params.set("limit", String(filter.limit));
  const q = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<{ runs: EvalRunView[] }>(`/api/replay/runs${q}`);
}

export async function fetchReplayJob(id: string) {
  return apiRequest<{ run: ReplayJobDetail }>(`/api/replay/runs/${encodeURIComponent(id)}`);
}

export async function fetchReplayJobCase(runId: string, resultId: string) {
  return apiRequest<{ result: EvalCaseDetail }>(`/api/replay/runs/${encodeURIComponent(runId)}/results/${encodeURIComponent(resultId)}`);
}

/** 409 when the job already finished; the error payload then carries the finished `run`. */
export async function cancelReplayJob(id: string) {
  return apiRequest<{ run: EvalRunView }>(`/api/replay/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

/** Whether an eval run or replay job is still queued or running. */
export function isEvalRunActive(run: Pick<EvalRunView, "status">): boolean {
  return run.status === "queued" || run.status === "running";
}

export const EVAL_RUN_POLL_INTERVAL_MS = 1500;

export interface SubscribeEvalRunOptions {
  /** Used when server-sent events are unavailable; defaults to `GET /api/replay/runs/:id`. */
  poll?: (runId: string) => Promise<EvalRunView>;
  pollIntervalMs?: number;
}

/**
 * Follows a run until it finishes: server-sent events from
 * `/api/eval/runs/:id/events` (same origin, with the session cookie), and
 * polling every ~1.5 s when the stream errors before the run is done or
 * EventSource does not exist. Calls `onEvent` with each update and once with
 * `type: "done"`. Returns an unsubscribe function.
 */
export function subscribeEvalRun(runId: string, onEvent: (event: EvalRunEvent) => void, options: SubscribeEvalRunOptions = {}): () => void {
  const poll = options.poll ?? (async (id: string) => (await fetchReplayJob(id)).run);
  const interval = options.pollIntervalMs ?? EVAL_RUN_POLL_INTERVAL_MS;
  let stopped = false;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const emit = (run: EvalRunView) => {
    if (stopped) return;
    const done = EVAL_RUN_FINISHED_STATUSES.has(run.status);
    onEvent(done ? { type: "done", run } : { type: "progress", run });
    if (done) stop();
  };

  const startPolling = () => {
    if (stopped || timer) return;
    const tick = async () => {
      timer = null;
      if (stopped) return;
      try {
        emit(await poll(runId));
      } catch {
        // A failed poll is retried on the next tick.
      }
      if (!stopped) timer = setTimeout(() => void tick(), interval);
    };
    void tick();
  };

  const stop = () => {
    stopped = true;
    source?.close();
    source = null;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  if (typeof EventSource === "undefined") {
    startPolling();
    return stop;
  }

  try {
    source = openEventSource(`${API_BASE}/api/eval/runs/${encodeURIComponent(runId)}/events`, { withCredentials: true });
  } catch {
    startPolling();
    return stop;
  }
  const handle = (message: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(message.data) as Partial<EvalRunEvent>;
      if (parsed.run) emit(parsed.run);
    } catch {
      // Ignore a malformed frame; the next one, or polling, catches up.
    }
  };
  source.addEventListener("progress", handle as EventListener);
  source.addEventListener("done", handle as EventListener);
  source.onerror = () => {
    if (stopped) return;
    source?.close();
    source = null;
    startPolling();
  };
  return stop;
}

// ---------------------------------------------------------------------------
// Phase 10.1 — MCP server registry
// ---------------------------------------------------------------------------

export type McpServerStatus = "unknown" | "healthy" | "degraded" | "down";

export interface McpLatencyStats {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  errorRate: number | null;
}

export interface McpRegisteredServer {
  id: string;
  name: string;
  description: string | null;
  adapterId: string;
  connection: Record<string, unknown>;
  secretId: string | null;
  owner: string | null;
  projectId: string | null;
  probeEnabled: boolean;
  probeIntervalMs: number | null;
  blockOnBreakingChange: boolean;
  status: McpServerStatus;
  lastProbeAt: string | null;
  lastProbeOk: boolean | null;
  lastProbeLatencyMs: number | null;
  lastProbeError: string | null;
  toolCount: number;
  currentSnapshotId: string | null;
  pendingBreakingSnapshotId: string | null;
  /** Phase 10.5 — whether and how the server may sample a model through the client. */
  sampling: McpSamplingSettings;
  /** Phase 10.7 — stdio sandbox (null: the deployment default), the last sandbox check, limits and credential mode. */
  sandbox?: McpSandboxSettings | null;
  sandboxStatus?: McpSandboxStatus | null;
  limits?: McpRuntimeLimits;
  credentialMode?: McpCredentialMode;
  delegatedFallback?: McpDelegatedFallback;
  /** Phase 10.7 — breaker and limit state on the API instance that answered. */
  runtime?: McpRuntimeStateView;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  latency: McpLatencyStats;
}

export interface McpServerProbe {
  id: string;
  serverId: string;
  startedAt: string;
  ok: boolean;
  latencyMs: number;
  toolCount: number;
  error: string | null;
  snapshotId: string | null;
}

export interface McpToolSchemaChange {
  tool: string;
  kind: string;
  path?: string;
  breaking: boolean;
  detail: string;
}

export interface McpToolSnapshotSummary {
  id: string;
  serverId: string;
  hash: string;
  toolCount: number;
  previousSnapshotId: string | null;
  changes: McpToolSchemaChange[];
  breaking: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  createdAt: string;
}

export interface McpSnapshotTool extends Partial<McpToolPolicyMarks> {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  /** Phase 10.5 — JSON Schema of the tool's structured output, when declared. */
  outputSchema?: Record<string, unknown>;
}

// Phase 10.2 — MCP tool policy.
export interface McpToolAccess {
  allowed: boolean;
  reason?: "policy" | "no_write_tools";
  ruleId?: string;
  ruleName?: string;
  message?: string;
}

/** What the API adds to each listed tool: classification and the caller's access. */
export interface McpToolPolicyMarks {
  classification: McpToolClassification;
  manualReadOnly: boolean | null;
  access: McpToolAccess;
}

export interface McpToolPolicyRuleInput {
  name?: string | null;
  description?: string | null;
  effect: McpToolPolicyEffect;
  projectId?: string | null;
  roles?: McpPolicyRole[];
  serverId?: string | null;
  toolPattern?: string;
  /** Phase 10.5 — only tools with this effective annotation hint; null = any tool. */
  annotationHint?: McpToolHintCondition | null;
  /** Phase 10.5 — what the rule governs; `tool` when left out. */
  kind?: McpPolicyKind;
  enabled?: boolean;
  /** Phase 12.4 — conditions on the call's arguments and data labels; null = every call. */
  conditions?: McpToolPolicyConditions | null;
  /** Phase 12.4 — shadow rules are recorded, never applied. */
  mode?: McpToolPolicyMode;
  workflowIds?: string[];
  clientIds?: string[];
}

/** Phase 12.4 — one rule in a dry run, with its conditions in words. */
export interface McpToolPolicyRuleExplanation {
  ruleId: string;
  ruleName: string | null;
  effect: McpToolPolicyEffect;
  mode: McpToolPolicyMode;
  conditions: string | null;
}

export interface McpToolPolicyEvaluation {
  allowed: boolean;
  reason: "policy" | "no_write_tools" | null;
  ruleId: string | null;
  ruleName: string | null;
  message: string | null;
  decidedBy: "default" | "rule";
  decidingRuleId: string | null;
  matchedRules: McpToolPolicyRule[];
  overriddenDenies: Array<{ denyId: string; byId: string }>;
  classification: McpToolClassification;
  manualReadOnly: boolean | null;
  server: { kind: "registry"; id: string; name: string; adapterId: string } | { kind: "inline"; adapterId: string };
  /** Phase 12.4 — the enforced outcome; absent from servers older than 12.4. */
  effect?: McpToolPolicyEffect;
  approval?: { ruleId: string; ruleName?: string; message: string } | null;
  shadow?: {
    effect: McpToolPolicyEffect;
    ruleId: string | null;
    ruleName: string | null;
    changed: boolean;
    matchedRules: McpToolPolicyRuleExplanation[];
  } | null;
  why?: McpToolPolicyRuleExplanation[];
  /** Rules with conditions that could not decide because no arguments were given. */
  undecided?: McpToolPolicyRuleExplanation[];
}

export async function fetchMcpToolPolicies() {
  return apiRequest<{ rules: McpToolPolicyRule[]; roles: McpPolicyRole[] }>("/api/mcp/policies");
}

export async function createMcpToolPolicy(payload: McpToolPolicyRuleInput) {
  return apiRequest<{ rule: McpToolPolicyRule }>("/api/mcp/policies", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateMcpToolPolicy(id: string, patch: Partial<McpToolPolicyRuleInput>) {
  return apiRequest<{ rule: McpToolPolicyRule }>(`/api/mcp/policies/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch)
  });
}

export async function deleteMcpToolPolicy(id: string) {
  return apiRequest<{ ok: true }>(`/api/mcp/policies/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function evaluateMcpToolPolicy(payload: {
  projectId?: string | null;
  role: McpPolicyRole;
  serverId: string;
  toolName: string;
  noWriteTools?: boolean;
  arguments?: Record<string, unknown>;
  labels?: string[];
  workflowId?: string | null;
  clientId?: string | null;
}) {
  return apiRequest<McpToolPolicyEvaluation>("/api/mcp/policies/evaluate", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

/** Phase 12.4 — what a draft rule set (or one added rule) would have done to recorded calls (admin; nothing is written). */
export async function simulateMcpToolPolicies(payload: McpPolicySimulationRequest) {
  return apiRequest<{ simulation: McpPolicySimulationResult }>("/api/mcp/policies/simulate", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

/** Phase 12.4 — per shadow rule: calls it matched and would have changed, over the last `days` days (admin). */
export async function fetchMcpPolicyShadowHits(days = 7) {
  return apiRequest<{ shadowHits: McpPolicyShadowHits }>(`/api/mcp/policies/shadow-hits?days=${encodeURIComponent(String(days))}`);
}

/** Phase 12.4 — least-privilege suggestions (admin). */
export async function fetchMcpPolicySuggestions(status: "open" | "accepted" | "dismissed" | "all" = "open") {
  return apiRequest<{ suggestions: McpPolicySuggestion[] }>(`/api/mcp/policies/suggestions?status=${encodeURIComponent(status)}`);
}

export async function generateMcpPolicySuggestions(payload: { minCalls?: number } = {}) {
  return apiRequest<{ result: McpPolicySuggestionGenerateResult }>("/api/mcp/policies/suggestions/generate", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

/** Accept names the fingerprint of the proposal the admin reviewed; the API refuses one regenerated since. */
export async function decideMcpPolicySuggestion(id: string, action: "accept" | "dismiss" | "enforce", fingerprint?: string) {
  return apiRequest<{ suggestion: McpPolicySuggestion; rules?: McpToolPolicyRule[] }>(
    `/api/mcp/policies/suggestions/${encodeURIComponent(id)}/${action}`,
    { method: "POST", body: JSON.stringify(action === "accept" ? { fingerprint } : {}) }
  );
}

export async function enforceMcpToolPolicy(id: string) {
  return apiRequest<{ rule: McpToolPolicyRule }>(`/api/mcp/policies/${encodeURIComponent(id)}/enforce`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

/** Phase 12.4 — gateway calls a require_approval rule held back (admin). */
export async function fetchMcpGatewayApprovals(filter: { status?: McpGatewayApproval["status"] } = {}) {
  const suffix = filter.status ? `?status=${encodeURIComponent(filter.status)}` : "";
  return apiRequest<{ approvals: McpGatewayApproval[]; approvalWindowMs: number }>(`/api/mcp/gateway/approvals${suffix}`);
}

export async function decideMcpGatewayApproval(id: string, decision: "approve" | "reject", reason?: string) {
  return apiRequest<{ approval: McpGatewayApproval }>(`/api/mcp/gateway/approvals/${encodeURIComponent(id)}/${decision}`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {})
  });
}

export async function setMcpToolClassification(serverId: string, toolName: string, readOnly: boolean | null) {
  return apiRequest<{
    serverId: string;
    toolName: string;
    classification: McpToolClassification;
    manualReadOnly: boolean | null;
  }>(`/api/mcp/servers/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(toolName)}/classification`, {
    method: "PUT",
    body: JSON.stringify({ readOnly })
  });
}

export interface McpServerUsage {
  workflowId: string;
  workflowName: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
}

export interface McpServerInput {
  name: string;
  description?: string | null;
  adapterId: string;
  connection?: Record<string, unknown>;
  secretRef?: { secretId: string } | null;
  owner?: string | null;
  projectId?: string | null;
  probeEnabled?: boolean;
  probeIntervalMs?: number | null;
  blockOnBreakingChange?: boolean;
  /** Phase 10.5 — partial sampling settings; fields left out keep their value. */
  sampling?: Partial<McpSamplingSettings> | null;
  /** Phase 10.7 — admin-only runtime safety settings. */
  sandbox?: McpSandboxSettings | null;
  limits?: McpRuntimeLimits | null;
  credentialMode?: McpCredentialMode;
  delegatedFallback?: McpDelegatedFallback;
}

export async function fetchMcpServers(projectId?: string) {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return apiRequest<{
    servers: McpRegisteredServer[];
    adapters: Array<{ id: string; label: string }>;
    defaultProbeIntervalMs: number;
    sandboxPolicy?: McpSandboxPolicyView;
  }>(`/api/mcp/servers${qs}`);
}

export async function fetchMcpServer(id: string) {
  return apiRequest<{
    server: McpRegisteredServer;
    sandboxPolicy?: McpSandboxPolicyView;
    probes: McpServerProbe[];
    snapshots: McpToolSnapshotSummary[];
    usages: McpServerUsage[];
  }>(`/api/mcp/servers/${encodeURIComponent(id)}`);
}

// Phase 10.7 — runtime state, breaker reset and delegated credentials (never a token).
export async function resetMcpServerBreaker(id: string) {
  return apiRequest<{ runtime: McpRuntimeStateView }>(`/api/mcp/servers/${encodeURIComponent(id)}/breaker/reset`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export async function fetchMcpServerUserConnections(id: string) {
  return apiRequest<{ credentialMode: McpCredentialMode; delegatedFallback: McpDelegatedFallback; connections: McpUserConnectionView[] }>(
    `/api/mcp/servers/${encodeURIComponent(id)}/connections`
  );
}

export async function revokeMcpServerUserConnection(id: string, userId: string) {
  return apiRequest<{ ok: true }>(`/api/mcp/servers/${encodeURIComponent(id)}/connections/${encodeURIComponent(userId)}`, {
    method: "DELETE"
  });
}

export async function fetchMyMcpConnections() {
  return apiRequest<{ connections: McpMyConnection[] }>("/api/mcp/connections");
}

export async function connectMyMcpConnection(serverId: string, payload: { scope?: string } = {}) {
  return apiRequest<{ authorizationUrl: string; expiresAt: string; redirectUri: string }>(
    `/api/mcp/connections/${encodeURIComponent(serverId)}/connect`,
    { method: "POST", body: JSON.stringify(payload) }
  );
}

export async function disconnectMyMcpConnection(serverId: string) {
  return apiRequest<{ connection: McpMyConnection }>(`/api/mcp/connections/${encodeURIComponent(serverId)}`, { method: "DELETE" });
}

export async function fetchMcpServerTools(id: string, projectId?: string) {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return apiRequest<{
    serverId: string;
    snapshotId: string | null;
    probedAt: string | null;
    policy?: { role: McpPolicyRole; projectId: string };
    tools: McpSnapshotTool[];
  }>(`/api/mcp/servers/${encodeURIComponent(id)}/tools${qs}`);
}

// Phase 10.5 — OAuth 2.1 connection for a registry server (tokens never reach the browser).
export async function fetchMcpServerOAuth(id: string) {
  return apiRequest<{ status: McpOAuthConnectionStatus }>(`/api/mcp/servers/${encodeURIComponent(id)}/oauth`);
}

export async function connectMcpServerOAuth(id: string, payload: { scope?: string } = {}) {
  return apiRequest<{ authorizationUrl: string; expiresAt: string; redirectUri: string }>(
    `/api/mcp/servers/${encodeURIComponent(id)}/oauth/connect`,
    { method: "POST", body: JSON.stringify(payload) }
  );
}

export async function refreshMcpServerOAuth(id: string) {
  return apiRequest<{ status: McpOAuthConnectionStatus }>(`/api/mcp/servers/${encodeURIComponent(id)}/oauth/refresh`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export async function disconnectMcpServerOAuth(id: string) {
  return apiRequest<{ status: McpOAuthConnectionStatus }>(`/api/mcp/servers/${encodeURIComponent(id)}/oauth`, {
    method: "DELETE"
  });
}

export type McpTelemetryWindow = "24h" | "7d" | "30d";

export interface McpTelemetryTotals {
  calls: number;
  errors: number;
  /** 0..1 */
  errorRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
  inputTokens: number;
  outputTokens: number;
  /** null when no call could be priced. */
  costUsd: number | null;
  /** Phase 10.5 — `sampling/createMessage` requests the calls triggered, and the tokens those used. */
  samplingRequests: number;
  samplingInputTokens: number;
  samplingOutputTokens: number;
  /** Phase 10.7 — calls refused before reaching the server (not counted as errors). */
  rateLimited?: number;
  concurrencyLimited?: number;
  breakerRejected?: number;
  lastCalledAt: string | null;
}

export interface McpToolTelemetry extends McpTelemetryTotals {
  toolName: string;
  /** Present on the inline-server rollup, which groups by adapter and tool. */
  adapterId?: string;
}

export interface McpTelemetryResponse {
  window: McpTelemetryWindow;
  since: string;
  totals: McpTelemetryTotals;
  tools: McpToolTelemetry[];
}

export async function fetchMcpServerTelemetry(id: string, window: McpTelemetryWindow = "7d") {
  return apiRequest<McpTelemetryResponse & { serverId: string }>(
    `/api/mcp/servers/${encodeURIComponent(id)}/telemetry?window=${encodeURIComponent(window)}`
  );
}

/** Usage of MCP servers configured inline on nodes (not in the registry). */
export async function fetchInlineMcpTelemetry(window: McpTelemetryWindow = "7d") {
  return apiRequest<McpTelemetryResponse & { scope: "inline" }>(`/api/mcp/telemetry?window=${encodeURIComponent(window)}`);
}

export async function createMcpServer(payload: McpServerInput) {
  return apiRequest<{ server: McpRegisteredServer }>("/api/mcp/servers", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateMcpServer(id: string, patch: Partial<McpServerInput>) {
  return apiRequest<{ server: McpRegisteredServer }>(`/api/mcp/servers/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch)
  });
}

export async function deleteMcpServer(id: string, options: { force?: boolean } = {}) {
  return apiRequest<{ ok: true }>(
    `/api/mcp/servers/${encodeURIComponent(id)}${options.force ? "?force=true" : ""}`,
    { method: "DELETE" }
  );
}

export async function probeMcpServer(id: string) {
  return apiRequest<{ server: McpRegisteredServer; probe: McpServerProbe; snapshot: McpToolSnapshotSummary | null }>(
    `/api/mcp/servers/${encodeURIComponent(id)}/probe`,
    { method: "POST" }
  );
}

export async function acceptMcpServerChange(id: string) {
  return apiRequest<{ server: McpRegisteredServer }>(
    `/api/mcp/servers/${encodeURIComponent(id)}/accept-change`,
    { method: "POST" }
  );
}

// ---------------------------------------------------------------------------
// Phase 10.4 — MCP gateway: toolsets and client credentials
// ---------------------------------------------------------------------------

export type McpToolsetMemberView = McpToolsetMember & { label: string; missing: boolean };

export interface McpToolsetView extends Omit<McpToolset, "members"> {
  endpointPath: string;
  members: McpToolsetMemberView[];
  activeSessions: number;
}

export interface McpToolsetInput {
  name: string;
  slug?: string;
  description?: string | null;
  projectId?: string | null;
  enabled?: boolean;
  members?: McpToolsetMemberSpec[];
}

export interface McpToolsetPreview {
  toolsetId: string;
  role: McpPolicyRole;
  projectId: string | null;
  tools: McpGatewayToolView[];
  hidden: McpGatewayHiddenToolView[];
  warnings: string[];
}

export interface McpToolsetCandidate {
  id: string;
  name: string;
  projectId: string | null;
  tools: string[];
}

export interface McpClientUsageSummary {
  calls: number;
  errors: number;
  lastCalledAt: string | null;
}

export interface McpClientView extends McpClient {
  status: "active" | "revoked" | "expired";
  effectiveRole: McpPolicyRole;
  activeSessions: number;
  usage: McpClientUsageSummary;
}

export async function fetchMcpToolsets() {
  return apiRequest<{ toolsets: McpToolsetView[]; gatewayBaseUrl: string | null; protocolVersions: string[] }>(
    "/api/mcp/toolsets"
  );
}

export async function fetchMcpToolsetCandidates() {
  return apiRequest<{ workflows: McpToolsetCandidate[] }>("/api/mcp/toolsets/candidates");
}

export async function createMcpToolset(payload: McpToolsetInput) {
  return apiRequest<{ toolset: McpToolsetView }>("/api/mcp/toolsets", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateMcpToolset(id: string, patch: Partial<McpToolsetInput>) {
  return apiRequest<{ toolset: McpToolsetView }>(`/api/mcp/toolsets/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch)
  });
}

export async function deleteMcpToolset(id: string) {
  return apiRequest<{ ok: true }>(`/api/mcp/toolsets/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function previewMcpToolset(id: string, role: McpPolicyRole) {
  return apiRequest<McpToolsetPreview>(
    `/api/mcp/toolsets/${encodeURIComponent(id)}/preview?role=${encodeURIComponent(role)}`
  );
}

export async function fetchMcpClients() {
  return apiRequest<{ usageWindow: string; clients: McpClientView[] }>("/api/mcp/clients");
}

export async function createMcpClient(payload: {
  name: string;
  toolsetIds: string[];
  role: McpPolicyRole;
  expiresAt?: string | null;
}) {
  return apiRequest<{ client: McpClientView; token: string }>("/api/mcp/clients", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function revokeMcpClient(id: string) {
  return apiRequest<{ client: McpClientView }>(`/api/mcp/clients/${encodeURIComponent(id)}/revoke`, {
    method: "POST"
  });
}

export async function fetchMcpClientUsage(id: string, window: McpTelemetryWindow = "7d") {
  return apiRequest<McpTelemetryResponse & { clientId: string; lastUsedAt: string | null }>(
    `/api/mcp/clients/${encodeURIComponent(id)}/usage?window=${encodeURIComponent(window)}`
  );
}

// Phase 10.6 — MCP onboarding: config import, deployment catalog, playground.

export interface McpConfigImportEntryOptions {
  decision?: McpImportDecision;
  name?: string;
  /** Slot values by slot id; sent only with the request, never returned. */
  values?: Record<string, string>;
}

export async function importMcpConfig(payload: {
  content: string;
  fileName?: string;
  dryRun?: boolean;
  projectId?: string | null;
  entries?: Record<string, McpConfigImportEntryOptions>;
  probe?: boolean;
}) {
  return apiRequest<McpConfigImportResponse & { servers?: McpRegisteredServer[] }>("/api/mcp/servers/import", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function fetchMcpCatalog() {
  return apiRequest<{ status: McpCatalogStatus; entries: McpCatalogEntry[] }>("/api/mcp/catalog");
}

export async function reloadMcpCatalog() {
  return apiRequest<{ status: McpCatalogStatus; entries: McpCatalogEntry[] }>("/api/mcp/catalog/reload", { method: "POST" });
}

export async function callMcpPlaygroundTool(
  serverId: string,
  payload: { toolName: string; args: Record<string, unknown>; projectId?: string | null; confirmWrite?: boolean }
) {
  return apiRequest<McpPlaygroundCallResponse>(`/api/mcp/servers/${encodeURIComponent(serverId)}/playground/call`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

// ---------------------------------------------------------------------------
// Phase 10.5 — MCP resources, prompts and elicitation
// ---------------------------------------------------------------------------

/** The caller's access to one catalog entry under the tool policy. */
export interface McpCatalogAccess {
  allowed: boolean;
  ruleId?: string;
  ruleName?: string;
  message?: string;
}

export type McpCatalogResource = McpResource & { access: McpCatalogAccess };
export type McpCatalogResourceTemplate = McpResourceTemplate & { access: McpCatalogAccess };
export type McpCatalogPrompt = McpPrompt & { access: McpCatalogAccess };

export async function fetchMcpServerResources(id: string, options: { projectId?: string | null; refresh?: boolean } = {}) {
  const params = new URLSearchParams();
  if (options.projectId) params.set("projectId", options.projectId);
  if (options.refresh) params.set("refresh", "true");
  const qs = params.size > 0 ? `?${params.toString()}` : "";
  return apiRequest<{
    serverId: string;
    capabilities: McpServerCapabilities;
    updatedAt: string | null;
    policy: { role: McpPolicyRole; projectId: string };
    resources: McpCatalogResource[];
    resourceTemplates: McpCatalogResourceTemplate[];
  }>(`/api/mcp/servers/${encodeURIComponent(id)}/resources${qs}`);
}

export interface McpResourceReadResponse {
  serverId: string;
  uri: string;
  bytes: number;
  durationMs: number;
  contents: McpResourceContent[];
  policy: { role: McpPolicyRole; projectId: string };
}

export async function readMcpServerResource(id: string, payload: { uri: string; projectId?: string | null }) {
  return apiRequest<McpResourceReadResponse>(`/api/mcp/servers/${encodeURIComponent(id)}/resources/read`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function fetchMcpServerPrompts(id: string, options: { projectId?: string | null; refresh?: boolean } = {}) {
  const params = new URLSearchParams();
  if (options.projectId) params.set("projectId", options.projectId);
  if (options.refresh) params.set("refresh", "true");
  const qs = params.size > 0 ? `?${params.toString()}` : "";
  return apiRequest<{
    serverId: string;
    capabilities: McpServerCapabilities;
    updatedAt: string | null;
    policy: { role: McpPolicyRole; projectId: string };
    prompts: McpCatalogPrompt[];
  }>(`/api/mcp/servers/${encodeURIComponent(id)}/prompts${qs}`);
}

export async function getMcpServerPrompt(id: string, payload: { name: string; arguments?: Record<string, string>; projectId?: string | null }) {
  return apiRequest<{ serverId: string; durationMs: number; prompt: McpPromptGetResult; policy: { role: McpPolicyRole; projectId: string } }>(
    `/api/mcp/servers/${encodeURIComponent(id)}/prompts/get`,
    { method: "POST", body: JSON.stringify(payload) }
  );
}

export async function fetchMcpElicitations(options: { status?: McpElicitationView["status"] | "all"; executionId?: string } = {}) {
  const params = new URLSearchParams();
  if (options.status) params.set("status", options.status);
  if (options.executionId) params.set("executionId", options.executionId);
  const qs = params.size > 0 ? `?${params.toString()}` : "";
  return apiRequest<{ items: McpElicitationView[] }>(`/api/mcp/elicitations${qs}`);
}

export async function answerMcpElicitation(
  id: string,
  payload: { action: McpElicitationAction; content?: Record<string, string | number | boolean> }
) {
  return apiRequest<{ elicitation: McpElicitationView }>(`/api/mcp/elicitations/${encodeURIComponent(id)}/answer`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

// ---------------------------------------------------------------------------
// Phase 10.3 — MCP control plane: tools catalogue, changes feed, overview
// ---------------------------------------------------------------------------

export interface McpCatalogToolUsage {
  workflowId: string;
  workflowName: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  /** The node offers every tool of the server rather than naming this one. */
  allTools: boolean;
}

export interface McpCatalogServer {
  id: string;
  name: string;
  status: McpServerStatus;
  adapterId: string;
  projectId: string | null;
  lastProbeAt: string | null;
  pendingBreakingSnapshotId: string | null;
  toolCount: number;
  /** Project the access marks were evaluated in. */
  policyProjectId: string;
  /** Phase 10.7 — circuit breaker state on the API instance that answered. */
  breakerState?: "closed" | "open" | "half_open";
  breakerRetryAt?: string | null;
}

export interface McpCatalogTool extends McpToolPolicyMarks {
  serverId: string;
  serverName: string;
  serverStatus: McpServerStatus;
  adapterId: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  /** Present unless the catalogue was fetched with `detail: false`. */
  telemetry?: McpToolTelemetry | null;
  /** Newest first, within the window; at most ten. */
  recentCalls?: McpCatalogRecentCall[];
  usages?: McpCatalogToolUsage[];
}

export interface McpCatalogRecentCall {
  startedAt: string;
  ok: boolean;
  durationMs: number | null;
  source: "workflow" | "gateway" | "playground";
  workflowId: string | null;
  error: string | null;
}

export interface McpToolCatalogResponse {
  window: McpTelemetryWindow;
  since: string;
  policy: { role: McpPolicyRole; projectId: string };
  servers: McpCatalogServer[];
  tools: McpCatalogTool[];
}

export async function fetchMcpToolCatalog(
  options: { projectId?: string | null; window?: McpTelemetryWindow; serverIds?: string[]; detail?: boolean } = {}
) {
  const params = new URLSearchParams();
  if (options.projectId) params.set("projectId", options.projectId);
  if (options.window) params.set("window", options.window);
  if (options.serverIds && options.serverIds.length > 0) params.set("serverIds", options.serverIds.join(","));
  if (options.detail === false) params.set("detail", "false");
  const qs = params.size > 0 ? `?${params.toString()}` : "";
  return apiRequest<McpToolCatalogResponse>(`/api/mcp/tools${qs}`);
}

export type McpChangeKind =
  | "schema"
  | "acceptance"
  | "status"
  | "policy"
  | "classification"
  | "toolset"
  | "client"
  | "oauth"
  | "sampling"
  | "catalog"
  | "breaker"
  | "server";

export interface McpChangeLink {
  page: "servers" | "policies" | "toolsets" | "clients" | "tools";
  serverId?: string;
  policyId?: string;
  toolName?: string;
}

export interface McpChangeItem {
  id: string;
  at: string;
  kind: McpChangeKind;
  severity: "breaking" | "warning" | "change" | "info";
  serverId: string | null;
  serverName: string | null;
  title: string;
  detail: string | null;
  link: McpChangeLink | null;
  changes?: Array<{ tool: string; kind: string; breaking: boolean; detail: string }>;
  transition?: { from: McpServerStatus; to: McpServerStatus };
  /** Admin only. */
  actor?: string | null;
  metadata?: unknown;
}

export async function fetchMcpChanges(options: { serverId?: string | null; kinds?: McpChangeKind[]; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (options.serverId) params.set("serverId", options.serverId);
  if (options.kinds && options.kinds.length > 0) params.set("kind", options.kinds.join(","));
  if (options.limit) params.set("limit", String(options.limit));
  const qs = params.size > 0 ? `?${params.toString()}` : "";
  return apiRequest<{ kinds: McpChangeKind[]; total: number; items: McpChangeItem[] }>(`/api/mcp/changes${qs}`);
}

export interface McpOverviewToolRow {
  serverId: string;
  serverName: string;
  toolName: string;
  calls: number;
  errors: number;
  /** 0..1 */
  errorRate: number;
  p95Ms: number | null;
  costUsd: number | null;
}

export interface McpOverview {
  window: McpTelemetryWindow;
  since: string;
  servers: {
    total: number;
    byStatus: Record<McpServerStatus, number>;
    list: Array<{ id: string; name: string; status: McpServerStatus; lastProbeAt: string | null; latency: McpLatencyStats }>;
  };
  pendingBreaking: Array<{
    serverId: string;
    serverName: string;
    snapshotId: string;
    detectedAt: string | null;
    breakingChanges: number;
    blocksRuns: boolean;
  }>;
  oauthAttention: Array<{
    serverId: string;
    serverName: string;
    state: McpOAuthConnectionStatus["state"];
    expiresAt: string | null;
    /** Admin only. */
    lastError?: string | null;
  }>;
  /** Phase 10.7 — open or half-open circuit breakers on this API instance. */
  breakers?: Array<{
    serverId: string;
    serverName: string;
    state: McpRuntimeStateView["breaker"]["state"];
    since: string | null;
    retryAt: string | null;
    consecutiveFailures: number;
    /** Admin only. */
    lastError?: string | null;
  }>;
  /** Phase 10.7 — stdio servers whose sandbox cannot start. */
  sandboxAttention?: Array<{ serverId: string; serverName: string; mode: string; problems: string[]; checkedAt: string }>;
  elicitations: { pending: number; oldestAt: string | null };
  sampling: Array<{ serverId: string; serverName: string; maxTokens: number; maxRequestsPerCall: number; allowedModels: number }>;
  tools: { calls: number; errors: number; busiest: McpOverviewToolRow[]; errorProne: McpOverviewToolRow[] };
  clients: {
    total: number;
    active: number;
    top: Array<{ id: string; name: string; calls: number; errors: number; lastCalledAt: string | null }>;
  };
  changes: McpChangeItem[];
}

export async function fetchMcpOverview(window: McpTelemetryWindow = "7d") {
  return apiRequest<McpOverview>(`/api/mcp/overview?window=${encodeURIComponent(window)}`);
}

// ---------------------------------------------------------------------------
// Phase 12.1 — Guard: profiles, bindings, verdict events and Security counts.
// ---------------------------------------------------------------------------

export interface GuardFieldIssue {
  path: string;
  message: string;
}

export interface GuardBindingView {
  mode: GuardBindingMode;
  profileId: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface GuardProjectBindingView extends GuardBindingView {
  projectId: string;
  locked: boolean;
}

export interface GuardWorkflowBindingResponse {
  binding: GuardBindingView & { workflowId: string };
  project: GuardProjectBindingView;
  effective: GuardResolutionView;
}

export interface GuardProfileChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

export interface GuardDetectorInfo {
  id: string;
  tier: string;
  description: string;
  channels: string[];
  categories: string[];
}

export interface GuardStats {
  verdicts: Array<{ key: string; count: number }>;
  actions: Array<{ key: string; count: number }>;
  categories: Array<{ key: string; count: number }>;
  channels: Array<{ key: string; count: number }>;
  detectors: Array<{ key: string; count: number }>;
  shadowWouldBlock: number;
  shadowFindings: number;
  budgetExceeded: number;
  daily: Array<{ day: string; action: string; count: number }>;
}

export interface GuardEventFilter {
  projectId?: string;
  workflowId?: string;
  profileId?: string;
  channel?: string;
  action?: string;
  days?: number;
  findings?: boolean;
  limit?: number;
  offset?: number;
}

function guardQuery(filter: GuardEventFilter): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const q = params.toString();
  return q ? `?${q}` : "";
}

export async function fetchGuardProfiles() {
  return apiRequest<{ profiles: GuardProfileSummary[]; autoApply: boolean; builtInId: string }>("/api/guard/profiles");
}

export async function fetchGuardProfile(id: string) {
  return apiRequest<{ profile: GuardProfileSummary; latest: GuardProfileVersionView; bindings: Array<{ scope: string; scopeId: string; mode: GuardBindingMode; profileId: string | null }> }>(
    `/api/guard/profiles/${encodeURIComponent(id)}`
  );
}

export async function createGuardProfile(payload: { id?: string; document: Record<string, unknown>; note?: string }) {
  return apiRequest<{ profile: GuardProfileSummary }>("/api/guard/profiles", { method: "POST", body: JSON.stringify(payload) });
}

export async function updateGuardProfile(id: string, payload: { document: Record<string, unknown>; note?: string }) {
  return apiRequest<{ version: GuardProfileVersionView; changed: boolean }>(`/api/guard/profiles/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export async function deleteGuardProfile(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/guard/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function fetchGuardProfileVersions(id: string) {
  return apiRequest<{ versions: GuardProfileVersionView[] }>(`/api/guard/profiles/${encodeURIComponent(id)}/versions`);
}

export async function fetchGuardProfileDiff(id: string, from: number, to: number) {
  return apiRequest<{ from: GuardProfileVersionView; to: GuardProfileVersionView; changes: GuardProfileChange[] }>(
    `/api/guard/profiles/${encodeURIComponent(id)}/diff?from=${from}&to=${to}`
  );
}

export function guardProfileExportUrl(id: string, version?: number): string {
  return `${API_BASE}/api/guard/profiles/${encodeURIComponent(id)}/export${version ? `?version=${version}` : ""}`;
}

export async function importGuardProfile(payload: { text: string; note?: string }) {
  return apiRequest<{ profile: GuardProfileSummary; created: boolean; changed: boolean }>("/api/guard/profiles/import", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

/** Phase 15.6 — replay recent recorded runs under an unsaved profile document or a saved version. */
export async function simulateGuardProfile(id: string, payload: { document: Record<string, unknown> } | { version: number }) {
  return apiRequest<{ simulation: GuardSimulationView }>(`/api/guard/profiles/${encodeURIComponent(id)}/simulate`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function fetchGuardSimulation(simulationId: string) {
  return apiRequest<{ simulation: GuardSimulationView }>(`/api/guard/simulations/${encodeURIComponent(simulationId)}`);
}

export async function cancelGuardSimulation(simulationId: string) {
  return apiRequest<{ simulation: GuardSimulationView }>(`/api/guard/simulations/${encodeURIComponent(simulationId)}/cancel`, { method: "POST" });
}

export async function fetchGuardSimulations(profileId: string) {
  return apiRequest<{ simulations: GuardSimulationView[] }>(`/api/guard/profiles/${encodeURIComponent(profileId)}/simulations`);
}

export async function fetchGuardDetectors() {
  return apiRequest<{ channels: string[]; detectors: GuardDetectorInfo[] }>("/api/guard/detectors");
}

export async function fetchGuardProjectBinding(projectId: string) {
  return apiRequest<{ binding: GuardProjectBindingView; effective: GuardResolutionView }>(`/api/guard/bindings/projects/${encodeURIComponent(projectId)}`);
}

export async function updateGuardProjectBinding(projectId: string, payload: { mode: GuardBindingMode; profileId?: string | null }) {
  return apiRequest<{ binding: GuardProjectBindingView; effective: GuardResolutionView }>(`/api/guard/bindings/projects/${encodeURIComponent(projectId)}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export async function fetchGuardWorkflowBinding(workflowId: string) {
  return apiRequest<GuardWorkflowBindingResponse>(`/api/guard/bindings/workflows/${encodeURIComponent(workflowId)}`);
}

export async function updateGuardWorkflowBinding(workflowId: string, payload: { mode: "inherit" | "override"; profileId?: string | null }) {
  return apiRequest<GuardWorkflowBindingResponse>(`/api/guard/bindings/workflows/${encodeURIComponent(workflowId)}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export async function fetchExecutionGuardEvents(executionId: string) {
  return apiRequest<{ events: GuardEventView[] }>(`/api/executions/${encodeURIComponent(executionId)}/guard-events`);
}

export async function fetchGuardEvents(filter: GuardEventFilter = {}) {
  return apiRequest<{ events: Array<GuardEventView & { workflowName?: string }>; total: number }>(`/api/guard/events${guardQuery(filter)}`);
}

export async function fetchGuardStats(filter: GuardEventFilter = {}) {
  return apiRequest<{ since: string | null; stats: GuardStats }>(`/api/guard/stats${guardQuery(filter)}`);
}

// Phase 11.1 — signed run manifests, audit bundles and signing keys.

export async function fetchExecutionManifest(executionId: string) {
  return apiRequest<RunManifestView>(`/api/executions/${encodeURIComponent(executionId)}/manifest`);
}

export interface AuditBundleDownload {
  blob: Blob;
  fileName: string;
  manifestDigest: string | null;
  keyId: string | null;
}

/** Fetches the bundle as a blob so a refusal (in progress, too large, no access) can be shown inline. */
export async function downloadAuditBundle(executionId: string): Promise<AuditBundleDownload> {
  const response = await apiFetch(`${API_BASE}/api/executions/${encodeURIComponent(executionId)}/bundle`, { credentials: "include" });
  if (!response.ok) {
    let payload: Record<string, unknown> = {};
    try {
      const json: unknown = await response.json();
      if (json && typeof json === "object") payload = json as Record<string, unknown>;
    } catch {
      payload = {};
    }
    throw new ApiError(String(payload.error ?? "Audit bundle export failed"), response.status, payload);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  return {
    blob: await response.blob(),
    fileName: match?.[1] ?? `l2m-audit-${executionId}.zip`,
    manifestDigest: response.headers.get("x-l2m-manifest-digest"),
    keyId: response.headers.get("x-l2m-signing-key-id")
  };
}

export async function fetchAuditSigningKeys() {
  return apiRequest<AuditSigningKeysResponse>("/api/audit/signing-keys");
}

export async function rotateAuditSigningKey() {
  return apiRequest<{ key: AuditSigningKeyView; keys: AuditSigningKeysResponse }>("/api/audit/signing-keys/rotate", { method: "POST" });
}

// Phase 11.2 — the approvals inbox.
export type { ApprovalEditableField, ApprovalRequestView, ApprovalStatus } from "@ai-orchestrator/shared";

/** Phase 15.4 — the inbox holds paused runs and release requests (kind "release"). */
export type ApprovalInboxItem = ApprovalRequestView | ReleaseApprovalRequestView | GateCaseRequestView;

export type ApprovalListStatus = "pending" | "decided" | "all";

export async function listApprovals(filter: { status?: ApprovalListStatus; workflowId?: string; executionId?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.workflowId) params.set("workflowId", filter.workflowId);
  if (filter.executionId) params.set("executionId", filter.executionId);
  if (filter.limit) params.set("limit", String(filter.limit));
  const q = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<{ items: ApprovalInboxItem[] }>(`/api/approvals${q}`);
}

/**
 * What a decision answered: the resumed run when it ran inline, or `queued`
 * when the resume went onto the execution queue (HTTP 202).
 */
export type ApprovalDecisionResponse =
  | { queued: true; executionId: string; requestId: string; decision: "approve" | "reject" }
  | (WorkflowExecutionResult & { queued?: undefined });

export async function approveApproval(executionId: string, payload: { reason?: string; edits?: Record<string, unknown>; requestId?: string }) {
  return apiRequest<ApprovalDecisionResponse>(`/api/approvals/${encodeURIComponent(executionId)}/approve`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function rejectApproval(executionId: string, payload: { reason?: string; requestId?: string }) {
  return apiRequest<ApprovalDecisionResponse>(`/api/approvals/${encodeURIComponent(executionId)}/reject`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

/** Phase 11.2 — whether anyone but the signed-in user could approve with these approver settings. */
export async function checkApprovalEligibility(payload: {
  workflowId: string;
  projectId?: string;
  approverRoles?: string[];
  approverUsers?: string[];
  allowSelfApproval?: boolean;
}) {
  return apiRequest<{ othersCanApprove: boolean; requesterCanApprove: boolean }>("/api/approvals/eligibility", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

// Phase 15.4 — release gate and publish.
export type { ReleaseApprovalRequestView, ReleaseGateView, ReleasePublishPreview, ReleaseStateView, ReleaseUnpublishResult, WorkflowRelease, WorkflowReleasesView };

const releasePath = (workflowId: string, rest: string) => `/api/workflows/${encodeURIComponent(workflowId)}/${rest}`;

export async function fetchReleaseGate(workflowId: string) {
  return apiRequest<{ gate: ReleaseGateView }>(releasePath(workflowId, "release-gate"));
}

export async function saveReleaseGate(workflowId: string, settings: ReleaseGateSettingsInput) {
  return apiRequest<{ gate: ReleaseGateView }>(releasePath(workflowId, "release-gate"), { method: "PUT", body: JSON.stringify(settings) });
}

export async function fetchReleaseState(workflowId: string) {
  return apiRequest<{ state: ReleaseStateView }>(releasePath(workflowId, "release-state"));
}

export async function fetchPublishPreview(workflowId: string, version: number, replayRunId?: string) {
  const params = new URLSearchParams({ version: String(version) });
  if (replayRunId) params.set("replayRunId", replayRunId);
  return apiRequest<{ preview: ReleasePublishPreview }>(`${releasePath(workflowId, "publish-preview")}?${params.toString()}`);
}

export async function fetchReleases(workflowId: string) {
  return apiRequest<WorkflowReleasesView>(releasePath(workflowId, "releases"));
}

export interface PublishRequest {
  version: number;
  workflowHash?: string;
  replayRunId?: string;
  override?: { reason: string };
  requestApproval?: { reason: string };
}

/** The three answers of a publish: published, sent to approvers, or blocked. */
export type PublishResult =
  | { outcome: "published"; release: WorkflowRelease }
  | { outcome: "needs_approval"; approvalRequestId: string; reasons: string[] }
  | { outcome: "blocked"; reasons: string[]; replayRunId?: string; canRequestApproval: boolean };

export async function publishWorkflowVersion(workflowId: string, payload: PublishRequest): Promise<PublishResult> {
  const response = await apiFetch(`${API_BASE}${releasePath(workflowId, "publish")}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  let json: Record<string, unknown> = {};
  try {
    const parsed = (await response.json()) as unknown;
    if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
  } catch {
    json = {};
  }
  const reasons = Array.isArray(json.reasons) ? json.reasons.map((reason) => String(reason)) : [];
  if (response.status === 200 && json.release) return { outcome: "published", release: json.release as WorkflowRelease };
  if (response.status === 202 && typeof json.approvalRequestId === "string") return { outcome: "needs_approval", approvalRequestId: json.approvalRequestId, reasons };
  if (response.status === 409 && json.verdict === "blocked") {
    return {
      outcome: "blocked",
      reasons,
      ...(typeof json.replayRunId === "string" ? { replayRunId: json.replayRunId } : {}),
      canRequestApproval: json.canRequestApproval === true
    };
  }
  throw new ApiError(String(json.error ?? "Publish failed"), response.status, json);
}

export async function rollbackWorkflowRelease(workflowId: string, payload: { version: number; reason: string }) {
  return apiRequest<{ release: WorkflowRelease }>(releasePath(workflowId, "rollback"), { method: "POST", body: JSON.stringify(payload) });
}

/** Takes the published version down: production runs the draft until a version is published again. */
export async function unpublishWorkflowRelease(workflowId: string, payload: { reason?: string; expectedVersion?: number } = {}) {
  return apiRequest<ReleaseUnpublishResult>(releasePath(workflowId, "unpublish"), { method: "POST", body: JSON.stringify(payload) });
}

// Release gate admission — enforced gates count only admitted cases; required cases must pass.
export type { GateCaseRequestView, ReleaseGateCasesView, ReleaseGateCaseView };

export async function fetchReleaseGateCases(workflowId: string) {
  return apiRequest<{ cases: ReleaseGateCasesView }>(releasePath(workflowId, "release-gate/cases"));
}

export async function admitGateCases(workflowId: string, fixtureIds: string[], reason?: string) {
  return apiRequest<{ cases: ReleaseGateCasesView }>(releasePath(workflowId, "release-gate/cases/admit"), {
    method: "POST",
    body: JSON.stringify({ fixtureIds, ...(reason ? { reason } : {}) })
  });
}

export async function rejectGateCases(workflowId: string, fixtureIds: string[], reason?: string) {
  return apiRequest<{ cases: ReleaseGateCasesView }>(releasePath(workflowId, "release-gate/cases/reject"), {
    method: "POST",
    body: JSON.stringify({ fixtureIds, ...(reason ? { reason } : {}) })
  });
}

export async function setGateCaseRequired(workflowId: string, fixtureId: string, required: boolean) {
  return apiRequest<{ cases: ReleaseGateCasesView }>(releasePath(workflowId, `release-gate/cases/${encodeURIComponent(fixtureId)}/required`), {
    method: "PUT",
    body: JSON.stringify({ required })
  });
}

export async function requestGateCases(workflowId: string, payload: { action: "admit" | "remove"; fixtureIds: string[]; reason: string }) {
  return apiRequest<{ request: GateCaseRequestView }>(releasePath(workflowId, "release-gate/cases/requests"), { method: "POST", body: JSON.stringify(payload) });
}

export async function decideGateCaseRequest(requestId: string, decision: "approve" | "reject", reason?: string) {
  return apiRequest<{ request: GateCaseRequestView }>(`/api/approvals/${encodeURIComponent(requestId)}/${decision}`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {})
  });
}

export async function decideReleaseRequest(requestId: string, decision: "approve" | "reject", reason?: string) {
  return apiRequest<{ request: ReleaseApprovalRequestView; release: WorkflowRelease | null }>(
    `/api/approvals/${encodeURIComponent(requestId)}/${decision}`,
    { method: "POST", body: JSON.stringify(reason ? { reason } : {}) }
  );
}

// --- Phase 15.6: production capture ---------------------------------------------------

export type { ReplayCapturePromoteOutcome, ReplayCaptureSettingsUpdate, ReplayCaptureSettingsView, ReplayCaptureView };
export type { ReplayCaptureStatus } from "@ai-orchestrator/shared";

const capturePath = (workflowId: string, leaf: "replay-capture" | "replay-captures") => `/api/workflows/${encodeURIComponent(workflowId)}/${leaf}`;

export async function fetchReplayCaptureSettings(workflowId: string) {
  return apiRequest<{ settings: ReplayCaptureSettingsView }>(capturePath(workflowId, "replay-capture"));
}

export async function saveReplayCaptureSettings(workflowId: string, settings: ReplayCaptureSettingsUpdate) {
  return apiRequest<{ settings: ReplayCaptureSettingsView }>(capturePath(workflowId, "replay-capture"), {
    method: "PUT",
    body: JSON.stringify(settings)
  });
}

export async function fetchReplayCaptures(
  workflowId: string,
  filter: { runStatus?: string; trigger?: string; from?: string; to?: string; limit?: number; offset?: number } = {}
) {
  const params = new URLSearchParams();
  if (filter.runStatus) params.set("runStatus", filter.runStatus);
  if (filter.trigger) params.set("trigger", filter.trigger);
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  if (filter.limit) params.set("limit", String(filter.limit));
  if (filter.offset) params.set("offset", String(filter.offset));
  const q = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<{ items: ReplayCaptureView[]; total: number }>(`${capturePath(workflowId, "replay-captures")}${q}`);
}

export async function promoteReplayCaptures(ids: string[], datasetId?: string) {
  return apiRequest<{ results: ReplayCapturePromoteOutcome[]; promoted: number }>("/api/replay/captures/promote", {
    method: "POST",
    body: JSON.stringify({ ids, ...(datasetId ? { datasetId } : {}) })
  });
}

export type { ReplayFindSubjectDeleteResult, ReplayFindSubjectMatch, ReplayFindSubjectQuery, ReplayFindSubjectResult } from "@ai-orchestrator/shared";

/** Admins: where a value is stored (raw or as its surrogate). Nothing is deleted. */
export async function findReplaySubject(query: ReplayFindSubjectQuery) {
  return apiRequest<ReplayFindSubjectResult>("/api/replay/recordings/find-subject", { method: "POST", body: JSON.stringify(query) });
}

/** Admins: delete rows a search returned; a possible match is deleted only with `confirmPossible`. */
export async function deleteReplaySubject(query: ReplayFindSubjectQuery, targets: Array<{ kind: ReplayFindSubjectMatch["kind"]; id: string; confirmPossible?: true }>) {
  return apiRequest<ReplayFindSubjectDeleteResult>("/api/replay/recordings/find-subject/delete", { method: "POST", body: JSON.stringify({ ...query, targets }) });
}

export async function discardReplayCaptures(ids: string[]) {
  return apiRequest<{ results: Array<{ id: string; ok: boolean; error?: string }>; discarded: number }>("/api/replay/captures/discard", {
    method: "POST",
    body: JSON.stringify({ ids })
  });
}

// Phase 16 — data destinations (deployment-wide; admins change them).
export async function fetchDataDestinations() {
  return apiRequest<{ destinations: DataDestinationRow[]; builtIns: DataDestinationRow[]; canEdit: boolean }>("/api/data-destinations");
}

export async function fetchUnclassifiedDestinations() {
  return apiRequest<{ destinations: UnclassifiedDestination[] }>("/api/data-destinations/unclassified");
}

export async function createDataDestination(payload: DataDestinationInput) {
  return apiRequest<{ destination: DataDestinationRow }>("/api/data-destinations", { method: "POST", body: JSON.stringify(payload) });
}

export async function updateDataDestination(id: string, payload: DataDestinationInput) {
  return apiRequest<{ destination: DataDestinationRow }>(`/api/data-destinations/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(payload) });
}

export async function deleteDataDestination(id: string) {
  return apiRequest<{ deleted: boolean; id: string }>(`/api/data-destinations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// Phase 16 (p3) — the deployment's destination rules (admins change them) and Preview impact.
export async function fetchDestinationRules() {
  return apiRequest<DestinationRulesStatus>("/api/guard/destination-rules");
}

export async function addStarterDestinationRule() {
  return apiRequest<DestinationRulesStatus>("/api/guard/destination-rules/starter", { method: "POST" });
}

export async function setDestinationRulesEnforcement(enforce: boolean) {
  return apiRequest<DestinationRulesStatus>("/api/guard/destination-rules/enforcement", { method: "POST", body: JSON.stringify({ enforce }) });
}

export async function saveDestinationRules(rules: Array<Record<string, unknown>>) {
  return apiRequest<DestinationRulesStatus>("/api/guard/destination-rules", { method: "PUT", body: JSON.stringify({ rules }) });
}

/** Unsaved rows (an `id` replaces that stored row), validated and never stored. */
export async function startDestinationPreview(payload: { rows: Array<DataDestinationInput & { id?: string }>; removedIds?: string[] }) {
  return apiRequest<{ simulation: GuardSimulationView }>("/api/data-destinations/preview", { method: "POST", body: JSON.stringify(payload) });
}
