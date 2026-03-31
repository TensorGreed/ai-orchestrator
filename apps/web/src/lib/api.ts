import type { Workflow, WorkflowExecutionResult, WorkflowListItem } from "@ai-orchestrator/shared";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error ?? "API request failed");
  }

  return json as T;
}

export async function fetchWorkflows() {
  return apiRequest<WorkflowListItem[]>("/api/workflows");
}

export async function fetchWorkflow(id: string) {
  return apiRequest<Workflow>(`/api/workflows/${id}`);
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

export async function importWorkflow(payload: { json?: string; workflow?: unknown }) {
  return apiRequest<Workflow>("/api/workflows/import", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function executeWorkflow(
  workflowId: string,
  payload: {
    input?: Record<string, unknown>;
    variables?: Record<string, unknown>;
    system_prompt?: string;
    user_prompt?: string;
    sessionId?: string;
  }
) {
  return apiRequest<WorkflowExecutionResult>(`/api/workflows/${workflowId}/execute`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function runWebhook(payload: {
  workflow_id?: string;
  session_id?: string;
  system_prompt: string;
  user_prompt: string;
  variables?: Record<string, unknown>;
}) {
  return apiRequest<WorkflowExecutionResult & { workflowId: string }>("/api/webhooks/execute", {
    method: "POST",
    body: JSON.stringify(payload)
  });
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
    mcpServers: unknown[];
  }>("/api/definitions");
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
