import type {
  Folder,
  LLMProviderConfig,
  MCPToolDefinition,
  Project,
  Workflow,
  WorkflowExecutionResult,
  WorkflowListItem
} from "@ai-orchestrator/shared";

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

  const response = await fetch(`${API_BASE}${path}`, {
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
}

export interface StreamLlmDeltaEvent {
  nodeId: string;
  delta: string;
  index: number;
}

export interface StreamErrorEvent {
  message: string;
}

interface WorkflowExecuteStreamHandlers {
  onExecutionStarted?: (event: StreamExecutionStartedEvent) => void;
  onNodeStart?: (event: StreamNodeStartEvent) => void;
  onNodeComplete?: (event: StreamNodeCompleteEvent) => void;
  onLlmDelta?: (event: StreamLlmDeltaEvent) => void;
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

async function streamWorkflowExecutionRequest(
  path: string,
  payload: Record<string, unknown>,
  handlers: WorkflowExecuteStreamHandlers = {}
): Promise<WorkflowExecutionResult> {
  const response = await fetch(`${API_BASE}${path}`, {
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

  while (true) {
    const { done, value } = await reader.read();
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
}) {
  return apiRequest<{
    serverId: string;
    tools: MCPToolDefinition[];
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
}

export async function fetchMcpPresets() {
  return apiRequest<{ presets: McpPreset[] }>("/api/mcp/presets");
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
  const response = await fetch(`${API_BASE}/api/providers/test`, {
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

export async function completeMfaLogin(payload: { challenge: string; code: string }) {
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

export interface SsoGroupMapping {
  id: string;
  provider: "saml" | "ldap";
  groupName: string;
  projectId: string | null;
  role: string;
  customRoleId: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function fetchSsoMappings(provider?: "saml" | "ldap") {
  const query = provider ? `?provider=${provider}` : "";
  return apiRequest<{ mappings: SsoGroupMapping[] }>(`/api/auth/sso/mappings${query}`);
}

export async function createSsoMapping(payload: {
  provider: "saml" | "ldap";
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

export type EvalScorerSpec =
  | { type: "exact_match"; path?: string; ignoreCase?: boolean }
  | { type: "contains"; path?: string; needle?: string; ignoreCase?: boolean }
  | { type: "regex"; path?: string; pattern?: string; flags?: string };

export interface EvalDataset {
  id: string;
  name: string;
  description: string | null;
  projectId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  fixtureCount: number;
}

export interface EvalFixture {
  id: string;
  datasetId: string;
  name: string;
  input: unknown;
  expected: unknown | null;
  scorers: EvalScorerSpec[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface EvalRunSummary {
  total: number;
  pass: number;
  fail: number;
  error: number;
  passRate: number;
  totalTokenInput: number;
  totalTokenOutput: number;
  totalTokenTotal: number;
  totalDurationMs: number;
  avgDurationMs: number;
}

export interface EvalRun {
  id: string;
  datasetId: string;
  workflowId: string;
  workflowName: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  triggeredBy: string | null;
  summary: EvalRunSummary | null;
  error: string | null;
}

export interface EvalResult {
  id: string;
  runId: string;
  fixtureId: string;
  fixtureName: string | null;
  status: string;
  executionId: string | null;
  score: { pass: boolean; details: Array<{ type: string; path?: string; pass: boolean; reason: string }> } | null;
  output: unknown;
  error: string | null;
  durationMs: number | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  tokenTotal: number | null;
}

export async function fetchEvalDatasets(projectId?: string) {
  const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return apiRequest<{ datasets: EvalDataset[] }>(`/api/eval/datasets${q}`);
}

export async function createEvalDataset(payload: { name: string; description?: string; projectId?: string }) {
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

export async function startEvalRun(payload: { datasetId: string; workflowId: string; scorers?: EvalScorerSpec[] }) {
  return apiRequest<{ ok: boolean; runId: string; summary: EvalRunSummary }>("/api/eval/runs", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function fetchEvalRuns(filter: { datasetId?: string; workflowId?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (filter.datasetId) params.set("datasetId", filter.datasetId);
  if (filter.workflowId) params.set("workflowId", filter.workflowId);
  if (filter.limit) params.set("limit", String(filter.limit));
  const q = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<{ runs: EvalRun[] }>(`/api/eval/runs${q}`);
}

export async function fetchEvalRun(id: string) {
  return apiRequest<EvalRun & { results: EvalResult[] }>(`/api/eval/runs/${encodeURIComponent(id)}`);
}
