const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
async function apiRequest(path, init) {
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
    return json;
}
export async function fetchWorkflows() {
    return apiRequest("/api/workflows");
}
export async function fetchWorkflow(id) {
    return apiRequest(`/api/workflows/${id}`);
}
export async function saveWorkflow(workflow) {
    return apiRequest("/api/workflows", {
        method: "POST",
        body: JSON.stringify(workflow)
    });
}
export async function updateWorkflow(workflow) {
    return apiRequest(`/api/workflows/${workflow.id}`, {
        method: "PUT",
        body: JSON.stringify(workflow)
    });
}
export async function importWorkflow(payload) {
    return apiRequest("/api/workflows/import", {
        method: "POST",
        body: JSON.stringify(payload)
    });
}
export async function executeWorkflow(workflowId, payload) {
    return apiRequest(`/api/workflows/${workflowId}/execute`, {
        method: "POST",
        body: JSON.stringify(payload)
    });
}
export async function runWebhook(payload) {
    return apiRequest("/api/webhooks/execute", {
        method: "POST",
        body: JSON.stringify(payload)
    });
}
export async function fetchDefinitions() {
    return apiRequest("/api/definitions");
}
