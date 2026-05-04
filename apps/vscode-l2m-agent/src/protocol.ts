export interface L2MAgentConfig {
  apiBaseUrl: string;
  workflowId: string;
  authToken: string;
  streamResponses: boolean;
  requestTimeoutMs: number;
}

export interface L2MExecuteInput {
  sessionId: string;
  userPrompt: string;
  systemPrompt?: string;
  variables?: Record<string, unknown>;
}

export interface L2MWebhookPayload {
  workflow_id?: string;
  session_id: string;
  system_prompt?: string;
  user_prompt: string;
  variables?: Record<string, unknown>;
  executionTimeoutMs?: number;
}

export interface L2MSseEvent {
  event: string;
  payload: unknown;
}

export interface L2MStreamHandlers {
  onEvent?: (event: L2MSseEvent) => void;
  onDelta?: (delta: string) => void;
  onProgress?: (message: string) => void;
}

export type WebviewMessage =
  | { type: "sendPrompt"; text: string };

export type ExtensionToWebviewMessage =
  | { type: "setDraft"; text: string }
  | { type: "systemMessage"; text: string }
  | { type: "assistantMessage"; text: string }
  | { type: "progressMessage"; text: string }
  | { type: "errorMessage"; text: string }
  | { type: "requestStarted" }
  | { type: "requestFinished" };
