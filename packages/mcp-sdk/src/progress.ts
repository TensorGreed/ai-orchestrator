import type { McpToolProgressEvent } from "@ai-orchestrator/shared";

/**
 * Phase 10.5 — client-side pieces of MCP progress and cancellation:
 * `notifications/progress` parsing, `notifications/cancelled` messages and an
 * incremental Server-Sent Events reader for Streamable HTTP responses.
 */

/** Protocol version L2M asks for when it initializes a session with an upstream server. */
export const MCP_CLIENT_PROTOCOL_VERSION = "2025-06-18";

/** How long a best-effort `notifications/cancelled` may take before L2M stops waiting for it. */
export const CANCEL_NOTIFICATION_TIMEOUT_MS = 2_000;

export interface ParsedProgress {
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The params of a `notifications/progress` message, or null when `message` is not one. */
export function parseProgressNotification(message: unknown): ParsedProgress | null {
  if (!isRecord(message) || message.method !== "notifications/progress" || "id" in message) return null;
  const params = message.params;
  if (!isRecord(params)) return null;
  const token = params.progressToken;
  if (typeof token !== "string" && typeof token !== "number") return null;
  const progress = Number(params.progress);
  if (!Number.isFinite(progress)) return null;
  const total = params.total === undefined ? undefined : Number(params.total);
  return {
    progressToken: token,
    progress,
    ...(total !== undefined && Number.isFinite(total) ? { total } : {}),
    ...(typeof params.message === "string" && params.message.trim() ? { message: params.message.slice(0, 500) } : {})
  };
}

export function toProgressEvent(
  parsed: ParsedProgress,
  tool: { toolName: string; serverId: string; registryServerId?: string }
): McpToolProgressEvent {
  return {
    toolName: tool.toolName,
    serverId: tool.serverId,
    ...(tool.registryServerId ? { registryServerId: tool.registryServerId } : {}),
    progress: parsed.progress,
    ...(parsed.total !== undefined ? { total: parsed.total } : {}),
    ...(parsed.message ? { message: parsed.message } : {}),
    at: new Date().toISOString()
  };
}

/** `notifications/cancelled` for an in-flight request. */
export function buildCancelledNotification(requestId: string | number, reason?: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId, ...(reason ? { reason: reason.slice(0, 300) } : {}) }
  };
}

/** Why a request was cancelled, from an abort signal's reason. */
export function cancelReason(signal?: AbortSignal): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  return "Workflow execution canceled.";
}

/**
 * Parse an SSE stream incrementally, calling `onEvent` with the `data` of
 * each event as soon as its blank-line terminator arrives. `onEvent` returns
 * true to stop reading (the response the caller waited for has arrived).
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (data: string) => boolean
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const flushFrame = (frame: string): boolean => {
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) return false;
    return onEvent(dataLines.join("\n"));
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match = /\r?\n\r?\n/.exec(buffer);
      while (match) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (flushFrame(frame)) return;
        match = /\r?\n\r?\n/.exec(buffer);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) flushFrame(buffer);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream is already closed.
    }
  }
}
