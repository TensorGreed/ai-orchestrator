export interface L2MAgentConfig {
  apiBaseUrl: string;
  workflowId: string;
  webhookPath: string;
  authToken: string;
  streamResponses: boolean;
  requestTimeoutMs: number;
  maxContextChars: number;
  maxFileChars: number;
  maxGitDiffChars: number;
  maxDiagnostics: number;
  maxOpenEditors: number;
  maxPinnedFiles: number;
  nearbyLineCount: number;
  recentTurnCount: number;
  maxCompactedMemoryChars: number;
}

export interface L2MExecuteInput {
  sessionId: string;
  userPrompt: string;
  systemPrompt?: string;
  variables?: Record<string, unknown>;
}

export interface L2MWebhookPayload {
  workflow_id?: string;
  webhook_path?: string;
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

export interface ChatCodeBlock {
  language: string;
  source: string;
  label?: string;
}

export interface ChatAttachment {
  filename: string;
  mimeType: string;
  downloadUrl: string;
  sizeBytes?: number;
}

export type ChatActionType = "patch" | "command";

export type ChatActionStatus = "pending" | "running" | "applied" | "failed" | "rejected";

export interface ChatAction {
  id: string;
  type: ChatActionType;
  title: string;
  description?: string;
  file?: string;
  diff?: string;
  command?: string;
  cwd?: string;
  requiresApproval?: boolean;
  status?: ChatActionStatus;
}

export interface ActionResult {
  id: string;
  actionId: string;
  type: ChatActionType;
  title: string;
  status: ChatActionStatus;
  message: string;
  createdAt: string;
  details?: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  codes?: ChatCodeBlock[];
  attachments?: ChatAttachment[];
  actions?: ChatAction[];
  variant?: "normal" | "error";
}

export interface ParsedAssistantResponse {
  text: string;
  codes: ChatCodeBlock[];
  attachments: ChatAttachment[];
  actions: ChatAction[];
  contextUpdate: string;
}

export type WebviewMessage =
  | { type: "sendPrompt"; text: string }
  | { type: "newSession" }
  | { type: "switchSession"; sessionId: string }
  | { type: "renameSession"; sessionId: string; title?: string }
  | { type: "deleteSession"; sessionId: string }
  | { type: "branchSession"; sessionId: string }
  | { type: "copyCode"; source: string }
  | { type: "insertCode"; source: string }
  | { type: "openAttachment"; attachment: ChatAttachment }
  | { type: "resetMemory" }
  | { type: "previewAction"; action: ChatAction }
  | { type: "runAction"; action: ChatAction };

export type ExtensionToWebviewMessage =
  | { type: "setDraft"; text: string }
  | { type: "appendMessage"; message: ChatMessage }
  | { type: "assistantDelta"; text: string }
  | { type: "updateActionStatus"; actionId: string; status: ChatActionStatus; result: ActionResult }
  | { type: "progressMessage"; text: string }
  | { type: "errorMessage"; text: string }
  | { type: "requestStarted" }
  | { type: "requestFinished" };
