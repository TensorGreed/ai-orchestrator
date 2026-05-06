import type { ActionResult, ChatMessage } from "./protocol";
import { EMPTY_SESSION_MEMORY } from "./sessionMemory";
import type { SessionMemoryState } from "./sessionMemory";

export const DEFAULT_SESSION_TITLE = "New chat";

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  pinnedFiles: string[];
  memory: SessionMemoryState;
  actionResults: ActionResult[];
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessageText: string;
  searchText: string;
}

export function createChatSession(
  id: string,
  now = new Date().toISOString(),
  overrides: Partial<Omit<ChatSession, "id">> = {}
): ChatSession {
  return {
    id,
    title: overrides.title || DEFAULT_SESSION_TITLE,
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
    messages: overrides.messages ?? [],
    pinnedFiles: overrides.pinnedFiles ?? [],
    memory: normalizeSessionMemory(overrides.memory),
    actionResults: overrides.actionResults ?? []
  };
}

export function normalizeSessions(value: unknown): ChatSession[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeSession(item))
    .filter((session): session is ChatSession => !!session);
}

export function summarizeSessions(sessions: ChatSession[]): ChatSessionSummary[] {
  return sessions.map((session) => {
    const lastMessage = session.messages.at(-1);
    const lastMessageText = summarizeText(lastMessage?.text ?? "", 180);
    return {
      id: session.id,
      title: session.title || DEFAULT_SESSION_TITLE,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
      lastMessageText,
      searchText: buildSearchText(session)
    };
  });
}

export function applyMessageToSession(session: ChatSession, message: ChatMessage, maxMessages: number): ChatSession {
  const messages = [...session.messages, message].slice(-maxMessages);
  return {
    ...session,
    title: inferNextTitle(session, message),
    updatedAt: message.createdAt || new Date().toISOString(),
    messages
  };
}

export function cloneSessionAsBranch(source: ChatSession, id: string, now = new Date().toISOString()): ChatSession {
  return {
    ...source,
    id,
    title: buildBranchTitle(source.title),
    createdAt: now,
    updatedAt: now,
    messages: source.messages.map((message) => ({ ...message })),
    pinnedFiles: [...source.pinnedFiles],
    memory: { ...source.memory },
    actionResults: source.actionResults.map((result) => ({ ...result }))
  };
}

export function sortSessionsByUpdatedAt(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((left, right) => {
    const rightTime = Date.parse(right.updatedAt);
    const leftTime = Date.parse(left.updatedAt);
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  });
}

export function limitSessionsKeepingActive(
  sessions: ChatSession[],
  activeSessionId: string,
  maxSessions: number
): ChatSession[] {
  const sorted = sortSessionsByUpdatedAt(sessions);
  if (sorted.length <= maxSessions) {
    return sorted;
  }

  const active = sorted.find((session) => session.id === activeSessionId);
  const limited = sorted.filter((session) => session.id !== activeSessionId).slice(0, Math.max(0, maxSessions - 1));
  return active ? [active, ...limited] : sorted.slice(0, maxSessions);
}

export function inferSessionTitle(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user" && message.text.trim());
  return firstUserMessage ? summarizeText(firstUserMessage.text, 60) : DEFAULT_SESSION_TITLE;
}

function normalizeSession(value: unknown): ChatSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "";
  if (!id) {
    return null;
  }

  const messages = Array.isArray(record.messages) ? record.messages.filter(isChatMessage) : [];
  const createdAt = stringValue(record.createdAt) || messages[0]?.createdAt || new Date().toISOString();
  const updatedAt = stringValue(record.updatedAt) || messages.at(-1)?.createdAt || createdAt;
  return {
    id,
    title: stringValue(record.title) || inferSessionTitle(messages),
    createdAt,
    updatedAt,
    messages,
    pinnedFiles: Array.isArray(record.pinnedFiles) ? record.pinnedFiles.filter(isNonEmptyString) : [],
    memory: normalizeSessionMemory(record.memory),
    actionResults: Array.isArray(record.actionResults) ? record.actionResults.filter(isActionResult) : []
  };
}

function normalizeSessionMemory(value: unknown): SessionMemoryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...EMPTY_SESSION_MEMORY };
  }

  const record = value as Partial<SessionMemoryState>;
  return {
    ...EMPTY_SESSION_MEMORY,
    compactedMemory: typeof record.compactedMemory === "string" ? record.compactedMemory : "",
    compactedThroughMessageId: typeof record.compactedThroughMessageId === "string" ? record.compactedThroughMessageId : "",
    compactedThroughCreatedAt: typeof record.compactedThroughCreatedAt === "string" ? record.compactedThroughCreatedAt : "",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : ""
  };
}

function inferNextTitle(session: ChatSession, message: ChatMessage): string {
  if (session.title !== DEFAULT_SESSION_TITLE || message.role !== "user") {
    return session.title || DEFAULT_SESSION_TITLE;
  }

  const title = summarizeText(message.text, 60);
  return title || DEFAULT_SESSION_TITLE;
}

function buildBranchTitle(title: string): string {
  const base = title && title !== DEFAULT_SESSION_TITLE ? title : DEFAULT_SESSION_TITLE;
  return summarizeText(`${base} branch`, 80);
}

function buildSearchText(session: ChatSession): string {
  return summarizeText(
    [
      session.title,
      ...session.messages.map((message) => message.text)
    ].join(" "),
    5_000
  ).toLowerCase();
}

function summarizeText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && !!value.trim();
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<ChatMessage>;
  return typeof record.id === "string"
    && (record.role === "user" || record.role === "assistant" || record.role === "system")
    && typeof record.text === "string"
    && typeof record.createdAt === "string";
}

function isActionResult(value: unknown): value is ActionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<ActionResult>;
  return typeof record.id === "string"
    && typeof record.actionId === "string"
    && (record.type === "patch" || record.type === "command")
    && typeof record.title === "string"
    && typeof record.message === "string"
    && typeof record.createdAt === "string";
}
