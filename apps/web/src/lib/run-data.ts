import type { NodeExecutionResult, WorkflowExecutionResult } from "@ai-orchestrator/shared";

/**
 * The status a node's result is shown with: "handled" for a failure the run handled (routed to the node's Error
 * output, caught by a Try/Catch or continued past), shown amber, not red; otherwise the result's own status.
 */
export function displayNodeStatus(result: { status: string; handled?: boolean }): string {
  return result.status === "error" && result.handled === true ? "handled" : result.status;
}

/**
 * Run data shown in the editor, derived only from the execution record (what run history stores).
 * Nothing here fetches or reconstructs values: masked or placeholder values stay as they were stored.
 */

/** Keys the engine puts in every node's input snapshot for the whole run (not data from an upstream node). */
export const RUN_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "vars",
  "webhook",
  "system_prompt",
  "user_prompt",
  "session_id",
  "images",
  "trigger_type",
  "input_trigger_type",
  "scheduled_at",
  "execution_id",
  "execution_custom_data"
]);

const PARENT_OUTPUTS_KEY = "parent_outputs";

export interface ReceivedInput {
  nodeId: string;
  label: string;
  value: unknown;
}

export interface SplitNodeInput {
  /** One entry per upstream node whose output this node received, in the order the engine recorded them. */
  receivedFrom: ReceivedInput[];
  /** Fields that are neither run context nor a copy of an upstream field: the run's own input. */
  otherFields: Record<string, unknown>;
  /** Run-wide context: prompt fields, variables, webhook body, session, trigger and execution ids. */
  runContext: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The prompt a run started with, when it is a first node's real input: the node has no upstream node and no test
 * data of its own (a manual trigger with test data ignores the editor's prompt field).
 */
export function runPromptInput(input: unknown, hasOwnTestData: boolean): string | undefined {
  if (!isRecord(input) || hasOwnTestData) return undefined;
  const parents = input[PARENT_OUTPUTS_KEY];
  if (isRecord(parents) && Object.keys(parents).length > 0) return undefined;
  const prompt = input.user_prompt;
  return typeof prompt === "string" && prompt.trim() ? prompt : undefined;
}

/** True when a node's config carries its own test data (a manual trigger's `testData`). */
export function hasTestData(config: unknown): boolean {
  const testData = isRecord(config) ? config.testData : undefined;
  if (testData === undefined || testData === null || testData === "") return false;
  return !(isRecord(testData) && Object.keys(testData).length === 0);
}

/**
 * Splits a stored node input snapshot (`{...run context, ...upstream fields, parent_outputs}`) into what the node
 * received from each upstream node, other fields in scope, and the run context. With `promptIsInput`, the run's
 * prompt counts as the node's input (a first node that takes the prompt) rather than context.
 */
export function splitNodeInput(
  input: unknown,
  labelFor: (nodeId: string) => string = (id) => id,
  options: { promptIsInput?: boolean } = {}
): SplitNodeInput {
  const split: SplitNodeInput = { receivedFrom: [], otherFields: {}, runContext: {} };
  if (input === undefined || input === null) return split;
  if (!isRecord(input)) {
    split.otherFields.value = input;
    return split;
  }
  const parents = isRecord(input[PARENT_OUTPUTS_KEY]) ? (input[PARENT_OUTPUTS_KEY] as Record<string, unknown>) : {};
  for (const [nodeId, value] of Object.entries(parents)) {
    split.receivedFrom.push({ nodeId, label: labelFor(nodeId), value });
  }
  const parentValues = Object.values(parents).filter(isRecord);
  const hasOwn = (record: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(record, key);
  for (const [key, value] of Object.entries(input)) {
    if (key === PARENT_OUTPUTS_KEY) continue;
    if (key === "user_prompt" && options.promptIsInput) {
      split.otherFields[key] = value;
      continue;
    }
    if (RUN_CONTEXT_KEYS.has(key)) {
      split.runContext[key] = value;
      continue;
    }
    // The engine also keys each parent's output by its node id and spreads its fields: both are copies.
    // Parent fields win over run input of the same name, so a key any parent has is that parent's copy.
    if (hasOwn(parents, key)) continue;
    if (parentValues.some((parent) => hasOwn(parent, key))) continue;
    split.otherFields[key] = value;
  }
  return split;
}

/** Number of items a node produced: an array's length, the length of an `items` list, 0 for no output, else 1. */
export function outputItemCount(output: unknown): number {
  if (output === undefined || output === null) return 0;
  if (Array.isArray(output)) return output.length;
  if (isRecord(output) && Array.isArray(output.items)) return output.items.length;
  return 1;
}

export function formatItemCount(count: number): string {
  return `${count} item${count === 1 ? "" : "s"}`;
}

export function formatRunDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} m ${seconds} s`;
}

const PREFERRED_PREVIEW_KEYS = ["result", "text", "answer", "output", "message", "response", "content", "summary", "error"];
const PREVIEW_SKIP_KEYS = new Set(["execution_custom_data"]);

function inlineValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  return "{…}";
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One line of a node's output that shows values, not key names: strings and numbers first by a preferred key order,
 * internal `_` keys skipped, repeated values shown once.
 */
export function compactOutputPreview(output: unknown, max = 140): string {
  if (output === undefined) return "";
  if (!isRecord(output)) {
    if (Array.isArray(output)) {
      if (output.length === 0) return "[] (no items)";
      const first = compactOutputPreview(output[0], max);
      return clip(flatten(`[${output.length}] ${first}`), max);
    }
    return clip(flatten(inlineValue(output)), max);
  }
  const entries = Object.entries(output).filter(([key]) => !key.startsWith("_") && !PREVIEW_SKIP_KEYS.has(key));
  if (entries.length === 0) return "{}";
  const rank = (key: string) => {
    const index = PREFERRED_PREVIEW_KEYS.indexOf(key.toLowerCase());
    return index === -1 ? PREFERRED_PREVIEW_KEYS.length : index;
  };
  const isScalar = (value: unknown) => value === null || typeof value !== "object";
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const scalar = Number(isScalar(b.entry[1])) - Number(isScalar(a.entry[1]));
      if (scalar !== 0) return scalar;
      const ranked = rank(a.entry[0]) - rank(b.entry[0]);
      return ranked !== 0 ? ranked : a.index - b.index;
    })
    .map(({ entry }) => entry);
  const parts: string[] = [];
  const seen = new Set<string>();
  let length = 0;
  for (const [key, value] of ordered) {
    const shown = flatten(inlineValue(value));
    if (typeof value === "string" && seen.has(shown)) continue;
    seen.add(shown);
    const part = `${key}: ${shown}`;
    parts.push(part);
    length += part.length + 3;
    if (length >= max) break;
  }
  return clip(parts.join(" · "), max);
}

export interface AttachmentUse {
  usedByNodeId: string;
  handle?: string;
}

/** The engine's record for a node consumed through an agent port (chat model, memory, tool, worker, rules). */
export function attachmentUse(result: Pick<NodeExecutionResult, "output"> | undefined): AttachmentUse | undefined {
  const output = result?.output;
  if (!isRecord(output) || output.reason !== "attachment_consumed_by_agent") return undefined;
  if (typeof output.usedByNodeId !== "string" || !output.usedByNodeId) return undefined;
  return { usedByNodeId: output.usedByNodeId, handle: typeof output.handle === "string" ? output.handle : undefined };
}

const PORT_NAMES: Record<string, string> = {
  chat_model: "chat model",
  memory: "memory",
  tool: "tool",
  worker: "worker",
  guard: "content rules",
  protection: "protection provider"
};

export function portName(handle: string | undefined): string {
  return handle ? (PORT_NAMES[handle] ?? handle.replace(/_/g, " ")) : "attachment";
}

/** True when the engine reused the node's pinned data instead of running it. */
export function usedPinnedData(result: Pick<NodeExecutionResult, "warnings"> | undefined): boolean {
  return Boolean(result?.warnings?.some((warning) => warning.startsWith("Used pinned data")));
}

/** The run's steps in the order they started; attachment records are left out (they are not steps). */
export function runStepOrder(result: WorkflowExecutionResult | null | undefined): string[] {
  if (!result) return [];
  return result.nodeResults
    .map((entry, index) => ({ entry, index, at: Date.parse(entry.startedAt ?? "") }))
    .filter(({ entry }) => !attachmentUse(entry))
    .sort((a, b) => {
      const left = Number.isFinite(a.at) ? a.at : Number.POSITIVE_INFINITY;
      const right = Number.isFinite(b.at) ? b.at : Number.POSITIVE_INFINITY;
      return left !== right ? left - right : a.index - b.index;
    })
    .map(({ entry }) => entry.nodeId)
    .filter((nodeId, index, all) => all.indexOf(nodeId) === index);
}

/**
 * A Loop body node's passes: its results whose input carries the pass's `_loop_index` (the engine records one result
 * per pass). Results of the same node from anything else (a run that went on after a resume) are not passes.
 */
export function loopPassResults(results: readonly NodeExecutionResult[], nodeId: string): NodeExecutionResult[] {
  return results.filter((entry) => entry.nodeId === nodeId && isRecord(entry.input) && typeof entry.input._loop_index === "number");
}

/** How much a status says about a node, for picking the one result its card shows (higher wins; later wins a tie). */
const CARD_STATUS_RANK: Readonly<Record<string, number>> = { error: 5, handled: 4, running: 3, success: 2, skipped: 0 };

/**
 * The one result each node's canvas card shows. A Loop body node has a result per pass, and the run walk records it once
 * more (skipped) when the Loop itself failed: the card shows the worst of them (a failed pass over a later success or
 * that skipped record), else the last one. The same order as the HUD's count (deriveRunStatus).
 */
export function nodeCardResults<T extends Pick<NodeExecutionResult, "nodeId" | "status" | "handled">>(results: readonly T[]): Map<string, T> {
  const shown = new Map<string, T>();
  const rank = (result: T) => CARD_STATUS_RANK[displayNodeStatus(result)] ?? 1;
  for (const result of results) {
    const before = shown.get(result.nodeId);
    if (before === undefined || rank(result) >= rank(before)) shown.set(result.nodeId, result);
  }
  return shown;
}

export interface CanvasRunPreview {
  /** "success · 1 item · 28 ms" style summary. */
  meta?: string;
  /** The run's prompt, on a first node that takes it as its input. */
  input?: string;
  output?: string;
  usedBy?: string;
  pinned?: boolean;
}

/** What a canvas card shows for one node of the run. */
export function canvasRunPreview(
  result: NodeExecutionResult,
  labelFor: (nodeId: string) => string,
  options: { hasOwnTestData?: boolean; passes?: readonly NodeExecutionResult[] } = {}
): CanvasRunPreview {
  const attachment = attachmentUse(result);
  if (attachment) {
    return { usedBy: `used by ${labelFor(attachment.usedByNodeId)} as its ${portName(attachment.handle)}` };
  }
  const parts: string[] = [displayNodeStatus(result)];
  const passes = options.passes && options.passes.length > 1 ? options.passes : undefined;
  if (passes) {
    // A Loop body node runs once per item: count every pass and all their items, not only the last pass.
    parts.push(`${passes.length} passes`);
    const items = passes.reduce((sum, entry) => sum + (entry.status === "success" ? outputItemCount(entry.output) : 0), 0);
    parts.push(formatItemCount(items));
  } else if (result.status === "success" || (result.status === "error" && result.output !== undefined)) {
    parts.push(formatItemCount(outputItemCount(result.output)));
  }
  const durationMs = passes ? passes.reduce((sum, entry) => sum + (typeof entry.durationMs === "number" ? entry.durationMs : 0), 0) : result.durationMs;
  const duration = result.status === "running" || result.status === "skipped" ? undefined : formatRunDuration(durationMs);
  if (duration) parts.push(duration);
  const preview: CanvasRunPreview = { meta: parts.join(" · ") };
  const prompt = runPromptInput(result.input, Boolean(options.hasOwnTestData));
  if (prompt) preview.input = clip(flatten(prompt), 140);
  if (result.output !== undefined && result.status !== "running") preview.output = compactOutputPreview(result.output);
  if (usedPinnedData(result)) preview.pinned = true;
  return preview;
}
