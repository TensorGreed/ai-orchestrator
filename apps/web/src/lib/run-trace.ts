import { NODE_ACTIVITY_LIMIT } from "@ai-orchestrator/shared";
import type { NodeActivityEvent, NodeExecutionResult, WorkflowExecutionResult } from "@ai-orchestrator/shared";
import type {
  StreamLlmDeltaEvent,
  StreamNodeActivityEvent,
  StreamNodeCompleteEvent,
  StreamNodeProgressEvent,
  StreamNodeStartEvent
} from "./api";

/** Most streamed model text kept per node; older text is dropped from the front. */
export const LIVE_TEXT_LIMIT = 20_000;

/** A node result plus the client-only fields the editor adds while a run streams in. */
export type LiveNodeResult = NodeExecutionResult & {
  /** Model text streamed so far (client only, never persisted). */
  liveText?: string;
  /** Browser clock when the node started, so elapsed time can tick (client only). */
  liveStartedAtMs?: number;
};

type NodeResults = WorkflowExecutionResult["nodeResults"];

export function buildExecutionErrorResult(workflowId: string, message: string): WorkflowExecutionResult {
  const now = new Date().toISOString();
  return {
    workflowId,
    status: "error",
    startedAt: now,
    completedAt: now,
    nodeResults: [],
    error: message
  };
}

export function createPartialExecutionResult(workflowId: string, at: string): WorkflowExecutionResult {
  return {
    workflowId,
    status: "partial",
    startedAt: at,
    completedAt: at,
    nodeResults: []
  };
}

export function upsertNodeResult(nodeResults: NodeResults, next: NodeResults[number]): NodeResults {
  const existingIndex = nodeResults.findIndex((entry) => entry.nodeId === next.nodeId);
  if (existingIndex < 0) {
    return [...nodeResults, next];
  }
  const updated = [...nodeResults];
  updated[existingIndex] = {
    ...updated[existingIndex],
    ...next
  };
  return updated;
}

export function applyNodeStartToExecutionResult(
  current: WorkflowExecutionResult,
  event: StreamNodeStartEvent,
  nowMs: number = Date.now()
): WorkflowExecutionResult {
  const existing = current.nodeResults.find((entry) => entry.nodeId === event.nodeId) as LiveNodeResult | undefined;
  const nextNodeResult: LiveNodeResult = {
    nodeId: event.nodeId,
    status: "running",
    startedAt: existing?.startedAt ?? event.startedAt,
    input: event.input ?? existing?.input,
    output: existing?.output,
    error: existing?.error,
    activity: existing?.activity,
    liveText: undefined,
    liveStartedAtMs: existing?.liveStartedAtMs ?? nowMs
  };

  return {
    ...current,
    status: "partial",
    completedAt: event.startedAt,
    nodeResults: upsertNodeResult(current.nodeResults, nextNodeResult)
  };
}

export function applyNodeCompleteToExecutionResult(
  current: WorkflowExecutionResult,
  event: StreamNodeCompleteEvent
): WorkflowExecutionResult {
  const existing = current.nodeResults.find((entry) => entry.nodeId === event.nodeId);
  const nextNodeResult: LiveNodeResult = {
    nodeId: event.nodeId,
    status: event.status as NodeExecutionResult["status"],
    startedAt: existing?.startedAt ?? event.completedAt,
    completedAt: event.completedAt,
    durationMs: event.durationMs,
    input: event.input ?? existing?.input,
    output: event.output ?? existing?.output,
    error: event.error,
    errorCategory: event.errorCategory,
    errorRemediation: event.errorRemediation,
    retryable: event.retryable,
    activity: existing?.activity,
    liveText: undefined
  };

  return {
    ...current,
    status: "partial",
    completedAt: event.completedAt,
    nodeResults: upsertNodeResult(current.nodeResults, nextNodeResult)
  };
}

/** Phase 10.5 — keep the latest MCP tool progress on the node's result (the run tape shows it). */
export function applyNodeProgressToExecutionResult(
  current: WorkflowExecutionResult | null,
  event: StreamNodeProgressEvent
): WorkflowExecutionResult | null {
  if (!current) return current;
  const existing = current.nodeResults.find((entry) => entry.nodeId === event.nodeId);
  if (!existing) return current;
  const { nodeId: _nodeId, ...progress } = event;
  return {
    ...current,
    nodeResults: upsertNodeResult(current.nodeResults, { ...existing, progress })
  };
}

/** Add a streamed activity entry to its node: ordered by seq, de-duplicated, capped. Unknown nodes are ignored. */
export function applyNodeActivityToExecutionResult(
  current: WorkflowExecutionResult | null,
  event: StreamNodeActivityEvent
): WorkflowExecutionResult | null {
  if (!current) return current;
  const existing = current.nodeResults.find((entry) => entry.nodeId === event.nodeId);
  if (!existing) return current;
  const list = existing.activity ?? [];
  if (list.some((entry) => entry.seq === event.seq)) return current;
  const merged = [...list, event].sort((a, b) => a.seq - b.seq);
  const activity = merged.length > NODE_ACTIVITY_LIMIT ? merged.slice(merged.length - NODE_ACTIVITY_LIMIT) : merged;
  return {
    ...current,
    nodeResults: upsertNodeResult(current.nodeResults, { ...existing, activity })
  };
}

function formatSeconds(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

const RETRY_SCOPE_WORDS = { provider: "model request", agent_llm: "model call", node: "node" } as const;

function clip(text: string, max: number = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function describeResolvedInput(fields: Record<string, string | number | boolean | string[]>): string {
  const text = (key: string) => (typeof fields[key] === "string" ? (fields[key] as string) : "");
  if (text("url")) return `${text("method") || "GET"} ${text("url")}`;
  if (text("toolName")) {
    const server = text("serverId") || text("registryServerId");
    return server ? `Tool ${text("toolName")} on ${server}` : `Tool ${text("toolName")}`;
  }
  if (text("model")) return text("providerId") ? `Using ${text("model")} · ${text("providerId")}` : `Using ${text("model")}`;
  return "Inputs resolved";
}

/** One short line for an activity entry, for the canvas, run tape and timelines. */
export function describeActivity(event: NodeActivityEvent): string {
  const prefix = event.workerNodeId ? `Worker ${event.workerNodeId}: ` : "";
  return `${prefix}${describeActivityBody(event)}`;
}

function describeActivityBody(event: NodeActivityEvent): string {
  switch (event.kind) {
    case "resolved_input":
      return describeResolvedInput(event.fields);
    case "llm_call": {
      if (event.phase === "start") {
        return `Calling ${event.model}${event.iteration !== undefined ? ` (step ${event.iteration})` : ""}`;
      }
      if (event.error) return `Model call failed: ${clip(event.error)}`;
      // "after": the time includes any retry waits inside the call.
      return typeof event.latencyMs === "number" ? `Model replied after ${formatSeconds(event.latencyMs)}` : "Model replied";
    }
    case "retry": {
      const attempts = event.maxAttempts ? ` of ${event.maxAttempts}` : "";
      return `Retrying ${RETRY_SCOPE_WORDS[event.scope]} in ${formatSeconds(event.delayMs)} (attempt ${event.attempt + 1}${attempts}): ${clip(event.reason)}`;
    }
    case "agent_step": {
      if (event.phase === "start") return `Step ${event.iteration} of ${event.maxIterations}`;
      if (event.final) return `Step ${event.iteration} gave the final answer`;
      return event.toolCalls && event.toolCalls.length > 0
        ? `Step ${event.iteration} asked for ${event.toolCalls.join(", ")}`
        : `Step ${event.iteration} done`;
    }
    case "tool_call": {
      if (event.phase === "start") return `Calling ${event.toolName}`;
      if (event.outcome === "blocked") return `${event.toolName} blocked by the guard`;
      if (event.outcome === "error") return `${event.toolName} failed${event.error ? `: ${clip(event.error)}` : ""}`;
      return typeof event.durationMs === "number" ? `${event.toolName} done in ${formatSeconds(event.durationMs)}` : `${event.toolName} done`;
    }
  }
}

/**
 * The entry worth showing as "Now": a retry wait if that is the latest entry, else the last
 * start without a matching end, else the last entry.
 */
export function currentActivity(result: { activity?: NodeActivityEvent[] } | undefined): NodeActivityEvent | undefined {
  const activity = result?.activity;
  if (!activity || activity.length === 0) return undefined;
  const latest = activity[activity.length - 1]!;
  if (latest.kind === "retry") return latest;
  const open: NodeActivityEvent[] = [];
  for (const entry of activity) {
    if (entry.kind !== "llm_call" && entry.kind !== "agent_step" && entry.kind !== "tool_call") continue;
    const same = (other: NodeActivityEvent) =>
      other.kind === entry.kind &&
      other.workerNodeId === entry.workerNodeId &&
      (entry.kind === "tool_call" && other.kind === "tool_call"
        ? entry.toolCallId !== undefined
          ? other.toolCallId === entry.toolCallId
          : other.toolName === entry.toolName
        : entry.kind === "agent_step" && other.kind === "agent_step"
          ? other.iteration === entry.iteration
          : true);
    if (entry.phase === "start") {
      open.push(entry);
    } else {
      const index = open.map(same).lastIndexOf(true);
      if (index >= 0) open.splice(index, 1);
    }
  }
  return open.length > 0 ? open[open.length - 1] : activity[activity.length - 1];
}

/** Keep the tail of `text` once it grows past the limit. */
export function appendCappedText(text: string, delta: string, limit: number = LIVE_TEXT_LIMIT): string {
  const joined = text + delta;
  return joined.length > limit ? joined.slice(joined.length - limit) : joined;
}

/** Append streamed model text to the node's client-only `liveText`. */
export function applyLlmDeltaToExecutionResult(
  current: WorkflowExecutionResult | null,
  event: Pick<StreamLlmDeltaEvent, "nodeId" | "delta">
): WorkflowExecutionResult | null {
  if (!current || !event.delta) return current;
  const existing = current.nodeResults.find((entry) => entry.nodeId === event.nodeId) as LiveNodeResult | undefined;
  // Late tokens flushed after node_complete must not leak into the node's next run.
  if (!existing || existing.status !== "running") return current;
  const next: LiveNodeResult = { ...existing, liveText: appendCappedText(existing.liveText ?? "", event.delta) };
  return {
    ...current,
    nodeResults: upsertNodeResult(current.nodeResults, next)
  };
}

/**
 * The stream broke before a final result: keep the partial trace, mark the run
 * and every node still running as errored. Without any node results there is
 * nothing to keep, so fall back to a bare error result.
 */
export function buildStreamFailureResult(
  current: WorkflowExecutionResult | null,
  workflowId: string,
  message: string,
  at: string = new Date().toISOString()
): WorkflowExecutionResult {
  if (!current || current.nodeResults.length === 0) {
    return buildExecutionErrorResult(workflowId, message);
  }
  const nodeResults = current.nodeResults.map((entry) => {
    if (entry.status !== "running") return entry;
    return {
      ...entry,
      status: "error" as const,
      completedAt: at,
      error: `Stream ended before the node finished: ${message}`
    };
  });
  return {
    ...current,
    status: "error",
    completedAt: at,
    nodeResults,
    error: message
  };
}

const GENERIC_STREAM_END = "Streaming request completed without a final result event";

/** Prefer the server's own error message over the client's generic "no final result" one. */
export function pickStreamFailureMessage(streamError: string | null, thrown: string): string {
  if (streamError && streamError.trim() && thrown.includes(GENERIC_STREAM_END)) {
    return streamError;
  }
  return thrown;
}

/** One-line preview of a node's input: the prompt text when there is one, else `summarize(value)`. */
export function summarizeInputPreview(value: unknown, summarize: (value: unknown) => string): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["user_prompt", "prompt", "userPrompt", "message"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
  }
  return summarize(value);
}

/** Last `max` characters of streamed text on one line, for the canvas preview. */
export function tailPreview(text: string, max: number = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `…${flat.slice(flat.length - max + 1)}` : flat;
}

/** Elapsed ms for a running node (browser clock when known, else its server start time). */
export function runningElapsedMs(result: { startedAt?: string; liveStartedAtMs?: number }, nowMs: number): number {
  const started =
    typeof result.liveStartedAtMs === "number" ? result.liveStartedAtMs : result.startedAt ? Date.parse(result.startedAt) : Number.NaN;
  return Number.isFinite(started) ? Math.max(nowMs - started, 0) : 0;
}

export interface TraceStreamHandlerOptions<S extends string = string> {
  workflowId: string;
  /** Only build a trace when debug mode is on. */
  enabled: boolean;
  setExecutionResult: (update: (current: WorkflowExecutionResult | null) => WorkflowExecutionResult | null) => void;
  setLiveNodeStatuses: (update: (current: Record<string, S>) => Record<string, S>) => void;
  normalizeStatus: (status: unknown) => S | undefined;
  flushMs?: number;
}

export interface TraceStreamHandlers {
  onNodeStart: (event: StreamNodeStartEvent) => void;
  onNodeComplete: (event: StreamNodeCompleteEvent) => void;
  onNodeProgress: (event: StreamNodeProgressEvent) => void;
  onNodeActivity: (event: StreamNodeActivityEvent) => void;
  onLlmDelta: (event: StreamLlmDeltaEvent) => void;
  onError: (event: { message: string }) => void;
  /** Push buffered deltas now and stop the flush timer. */
  dispose: () => void;
  /** Last message the server sent as an error event. */
  lastError: () => string | null;
}

/** The stream callbacks for a handler set; `onError` also runs the caller's own banner update. */
export function traceStreamCallbacks(trace: TraceStreamHandlers, onError: (event: { message: string }) => void) {
  return {
    onNodeStart: trace.onNodeStart,
    onNodeComplete: trace.onNodeComplete,
    onNodeProgress: trace.onNodeProgress,
    onNodeActivity: trace.onNodeActivity,
    onLlmDelta: trace.onLlmDelta,
    onError: (event: { message: string }) => {
      trace.onError(event);
      onError(event);
    }
  };
}

/**
 * One handler set for every editor run path (workflow, webhook, chat): builds the
 * partial trace, tracks live node statuses and batches llm_delta text so a fast
 * stream does not re-render the canvas per token.
 */
export function createTraceStreamHandlers<S extends string = string>(options: TraceStreamHandlerOptions<S>): TraceStreamHandlers {
  const { workflowId, enabled, setExecutionResult, setLiveNodeStatuses, normalizeStatus, flushMs = 100 } = options;
  let initializedTrace = false;
  let initializedStatuses = false;
  let streamError: string | null = null;
  let pending: Record<string, string> = {};
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const batch = pending;
    pending = {};
    const nodeIds = Object.keys(batch);
    if (nodeIds.length === 0) return;
    setExecutionResult((current) => {
      let next = current;
      for (const nodeId of nodeIds) {
        next = applyLlmDeltaToExecutionResult(next, { nodeId, delta: batch[nodeId] ?? "" });
      }
      return next;
    });
  };

  const setStatus = (nodeId: string, status: S) => {
    const reset = !initializedStatuses;
    initializedStatuses = true;
    setLiveNodeStatuses((current) => ({ ...(reset ? {} : current), [nodeId]: status }));
  };

  return {
    onNodeStart: (event) => {
      if (!enabled) return;
      const reset = !initializedTrace;
      initializedTrace = true;
      setExecutionResult((current) => {
        const base = reset || !current ? createPartialExecutionResult(workflowId, event.startedAt) : current;
        return applyNodeStartToExecutionResult(base, event);
      });
      setStatus(event.nodeId, "running" as S);
    },
    onNodeComplete: (event) => {
      if (!enabled) return;
      delete pending[event.nodeId];
      const reset = !initializedTrace;
      initializedTrace = true;
      setExecutionResult((current) => {
        const base = reset || !current ? createPartialExecutionResult(workflowId, event.completedAt) : current;
        return applyNodeCompleteToExecutionResult(base, event);
      });
      const status = normalizeStatus(event.status);
      if (status) setStatus(event.nodeId, status);
    },
    onNodeProgress: (event) => {
      if (!enabled) return;
      setExecutionResult((current) => applyNodeProgressToExecutionResult(current, event));
    },
    onNodeActivity: (event) => {
      if (!enabled) return;
      setExecutionResult((current) => applyNodeActivityToExecutionResult(current, event));
    },
    onLlmDelta: (event) => {
      if (!enabled || !event.delta) return;
      pending[event.nodeId] = (pending[event.nodeId] ?? "") + event.delta;
      if (timer === null) timer = setTimeout(flush, flushMs);
    },
    onError: (event) => {
      streamError = event.message;
    },
    dispose: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      flush();
    },
    lastError: () => streamError
  };
}
