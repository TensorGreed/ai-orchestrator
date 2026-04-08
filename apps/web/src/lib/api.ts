import type { MCPToolDefinition, Workflow, WorkflowExecutionResult, WorkflowListItem } from "@ai-orchestrator/shared";

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
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
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
  return apiRequest<{ user: AuthUser; expiresAt: string }>("/api/auth/login", {
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

export async function fetchWorkflows() {
  return apiRequest<WorkflowListItem[]>("/api/workflows");
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
    input?: Record<string, unknown>;
    variables?: Record<string, unknown>;
    system_prompt?: string;
    user_prompt?: string;
    sessionId?: string;
    session_id?: string;
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
    input?: Record<string, unknown>;
    variables?: Record<string, unknown>;
    system_prompt?: string;
    user_prompt?: string;
    sessionId?: string;
    session_id?: string;
  },
  handlers: WorkflowExecuteStreamHandlers = {}
): Promise<WorkflowExecutionResult> {
  return streamWorkflowExecutionRequest(`/api/workflows/${workflowId}/execute/stream`, payload, handlers);
}

export async function runWebhook(payload: {
  workflow_id?: string;
  session_id?: string;
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
    session_id?: string;
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

export interface SecretListItem {
  id: string;
  name: string;
  provider: string;
  createdAt: string;
}

export async function fetchSecrets() {
  return apiRequest<SecretListItem[]>("/api/secrets");
}

export async function createSecret(payload: { name: string; provider: string; value: string }) {
  return apiRequest<{
    id: string;
    name: string;
    provider: string;
  }>("/api/secrets", {
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
