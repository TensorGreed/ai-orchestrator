import type { ChatMessage } from "./protocol";

export interface SessionMemoryState {
  compactedMemory: string;
  compactedThroughMessageId: string;
  compactedThroughCreatedAt: string;
  updatedAt: string;
}

export interface SessionMemorySnapshot extends SessionMemoryState {
  recentTurnCount: number;
  recentTurns: Array<Record<string, unknown>>;
}

export interface SessionMemoryOptions {
  recentTurnCount: number;
  maxCompactedMemoryChars: number;
}

export interface SessionCompactionResult {
  state: SessionMemoryState;
  compactedCount: number;
}

export const EMPTY_SESSION_MEMORY: SessionMemoryState = {
  compactedMemory: "",
  compactedThroughMessageId: "",
  compactedThroughCreatedAt: "",
  updatedAt: ""
};

export function compactSessionMemory(
  messages: ChatMessage[],
  state: SessionMemoryState,
  options: SessionMemoryOptions
): SessionCompactionResult {
  const recentTurnCount = normalizeRecentTurnCount(options.recentTurnCount);
  const cutoff = Math.max(0, messages.length - recentTurnCount);
  const olderMessages = messages.slice(0, cutoff).filter((message) =>
    isAfterCompactedCursor(message, state.compactedThroughCreatedAt)
  );

  if (olderMessages.length === 0) {
    return {
      state: limitMemoryState(state, options.maxCompactedMemoryChars),
      compactedCount: 0
    };
  }

  const compactedBlock = buildCompactedBlock(olderMessages);
  const nextMemory = appendMemoryBlock(state.compactedMemory, compactedBlock, options.maxCompactedMemoryChars);
  const last = olderMessages[olderMessages.length - 1];

  return {
    state: {
      compactedMemory: nextMemory,
      compactedThroughMessageId: last?.id ?? state.compactedThroughMessageId,
      compactedThroughCreatedAt: last?.createdAt ?? state.compactedThroughCreatedAt,
      updatedAt: new Date().toISOString()
    },
    compactedCount: olderMessages.length
  };
}

export function mergeContextUpdate(
  state: SessionMemoryState,
  contextUpdate: string,
  maxCompactedMemoryChars: number
): SessionMemoryState {
  const normalized = normalizeWhitespace(contextUpdate);
  if (!normalized) {
    return limitMemoryState(state, maxCompactedMemoryChars);
  }

  if (state.compactedMemory.includes(normalized)) {
    return {
      ...limitMemoryState(state, maxCompactedMemoryChars),
      updatedAt: new Date().toISOString()
    };
  }

  const block = [
    `## L2M context update ${new Date().toISOString()}`,
    normalized
  ].join("\n");

  return {
    ...state,
    compactedMemory: appendMemoryBlock(state.compactedMemory, block, maxCompactedMemoryChars),
    updatedAt: new Date().toISOString()
  };
}

export function buildSessionMemorySnapshot(
  messages: ChatMessage[],
  state: SessionMemoryState,
  options: SessionMemoryOptions
): SessionMemorySnapshot {
  const recentTurnCount = normalizeRecentTurnCount(options.recentTurnCount);
  return {
    ...limitMemoryState(state, options.maxCompactedMemoryChars),
    recentTurnCount,
    recentTurns: buildRecentTurns(messages, recentTurnCount)
  };
}

export function buildRecentTurns(messages: ChatMessage[], recentTurnCount: number): Array<Record<string, unknown>> {
  return messages.slice(-normalizeRecentTurnCount(recentTurnCount)).map((message) => ({
    id: message.id,
    role: message.role,
    text: summarizeMessageText(message.text, 4_000),
    createdAt: message.createdAt,
    codes: (message.codes ?? []).map((code) => ({
      language: code.language,
      label: code.label,
      chars: code.source.length
    })),
    attachments: (message.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes
    })),
    variant: message.variant
  }));
}

function buildCompactedBlock(messages: ChatMessage[]): string {
  const lines = messages.map((message) => {
    const pieces = [
      `- ${message.createdAt || "unknown time"} ${message.role}: ${summarizeMessageText(message.text, 900)}`
    ];
    if (message.codes?.length) {
      pieces.push(`code_blocks=${message.codes.length}`);
    }
    if (message.attachments?.length) {
      pieces.push(`attachments=${message.attachments.map((attachment) => attachment.filename).join(", ")}`);
    }
    if (message.variant === "error") {
      pieces.push("variant=error");
    }
    return pieces.join(" ");
  });

  return [
    `## Deterministic conversation compaction ${new Date().toISOString()}`,
    ...lines
  ].join("\n");
}

function appendMemoryBlock(existing: string, block: string, maxChars: number): string {
  const combined = [existing.trim(), block.trim()].filter(Boolean).join("\n\n");
  return limitMemoryText(combined, maxChars);
}

function limitMemoryState(state: SessionMemoryState, maxChars: number): SessionMemoryState {
  return {
    ...state,
    compactedMemory: limitMemoryText(state.compactedMemory, maxChars)
  };
}

function limitMemoryText(value: string, maxChars: number): string {
  const normalized = value.trim();
  const limit = Math.max(1_000, Math.floor(maxChars));
  if (normalized.length <= limit) {
    return normalized;
  }

  const marker = "[older compacted memory truncated]\n";
  return `${marker}${normalized.slice(-(limit - marker.length))}`;
}

function isAfterCompactedCursor(message: ChatMessage, compactedThroughCreatedAt: string): boolean {
  if (!compactedThroughCreatedAt) {
    return true;
  }

  const messageTime = Date.parse(message.createdAt);
  const cursorTime = Date.parse(compactedThroughCreatedAt);
  if (!Number.isFinite(messageTime) || !Number.isFinite(cursorTime)) {
    return message.createdAt > compactedThroughCreatedAt;
  }

  return messageTime > cursorTime;
}

function summarizeMessageText(text: string, maxChars: number): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 24))} [truncated]`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeRecentTurnCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 12;
  }

  return Math.max(2, Math.floor(value));
}
