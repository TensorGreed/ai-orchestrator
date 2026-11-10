import type { LLMStreamChunk } from "./types";

type ToolCallDelta = Extract<LLMStreamChunk, { type: "tool_call_delta" }>;

export interface AssembledToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

/**
 * Puts streamed tool-call deltas together into whole calls.
 *
 * OpenAI-style streams send the call id (and the name) only on the first delta of each call; the later argument deltas
 * carry just the call's `index`. So a delta belongs to the call at its `index` when it has one, else to the call with
 * its id, else (no index, no id) to the call before it. Providers that repeat the id on every delta, with or without an
 * index, still group the same way. A delta whose id differs from the call already at its index starts a new call, which
 * keeps servers that reuse one index for every call from merging them.
 */
export class ToolCallAssembler {
  private readonly entries: AssembledToolCall[] = [];
  private readonly byIndex = new Map<number, AssembledToolCall>();
  private readonly byId = new Map<string, AssembledToolCall>();
  private last: AssembledToolCall | undefined;

  add(chunk: ToolCallDelta): void {
    const id = chunk.toolCallId || undefined;
    let entry: AssembledToolCall | undefined;
    if (typeof chunk.index === "number") {
      entry = this.byIndex.get(chunk.index);
      if (entry && id && entry.id && entry.id !== id) entry = this.byId.get(id);
      if (!entry && id) entry = this.byId.get(id);
    } else if (id) {
      entry = this.byId.get(id);
    } else if (chunk.name) {
      entry = undefined;
    } else {
      entry = this.last;
    }
    if (!entry) {
      entry = { id: id ?? `toolcall_${this.entries.length}`, name: chunk.name || `tool_${this.entries.length}`, argumentsText: "" };
      this.entries.push(entry);
    } else if (id && entry.id.startsWith("toolcall_") && !this.byId.has(id)) {
      entry.id = id;
    }
    if (typeof chunk.index === "number") this.byIndex.set(chunk.index, entry);
    if (id) this.byId.set(id, entry);
    if (chunk.name) entry.name = chunk.name;
    if (typeof chunk.argumentsDelta === "string") entry.argumentsText += chunk.argumentsDelta;
    this.last = entry;
  }

  /** The calls in the order they began. */
  calls(): AssembledToolCall[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}
