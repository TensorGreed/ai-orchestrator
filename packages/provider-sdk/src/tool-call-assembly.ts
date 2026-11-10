import type { LLMStreamChunk } from "./types";

type ToolCallDelta = Extract<LLMStreamChunk, { type: "tool_call_delta" }>;

export interface AssembledToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

export interface ToolCallAssemblerOptions {
  /** Prefix of the id given to a call that never sent one (`<prefix><position>`). Default `toolcall_`. */
  idPrefix?: string;
  /** A call that never sent a name keeps an empty name instead of `tool_<position>`. */
  blankName?: boolean;
}

/** The largest `index` taken at face value. A larger or non-integer one is a misbehaving server: the delta is grouped as if it had no index. */
export const MAX_TOOL_CALL_INDEX = 1023;

interface Entry extends AssembledToolCall {
  idIsPlaceholder: boolean;
}

function isCompleteJson(text: string): boolean {
  if (!text) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Puts streamed tool-call deltas together into whole calls.
 *
 * OpenAI-style streams send the call id (and the name) only on the first delta of each call; the later argument deltas
 * carry just the call's `index`. So a delta belongs to the call at its `index` when it has one, else to the call with
 * its id, else (no index, no id) to the call before it. Providers that repeat the id on every delta, with or without an
 * index, still group the same way.
 *
 * A server that reuses one index for every call is told apart by what each delta says: a different id, or a name when
 * the call at that index already holds complete arguments, starts a new call. A fresh index is always a new call, even
 * when the id repeats.
 */
export class ToolCallAssembler {
  private readonly entries: Entry[] = [];
  private readonly byIndex = new Map<number, Entry>();
  private readonly byId = new Map<string, Entry>();
  private last: Entry | undefined;

  constructor(private readonly options: ToolCallAssemblerOptions = {}) {}

  /** Adds a delta and returns the position of the call it went to (the order the calls began in). */
  add(chunk: ToolCallDelta): number {
    const id = chunk.toolCallId || undefined;
    const name = chunk.name || undefined;
    const index = typeof chunk.index === "number" && Number.isInteger(chunk.index) && chunk.index >= 0 && chunk.index <= MAX_TOOL_CALL_INDEX ? chunk.index : undefined;
    let entry: Entry | undefined;
    if (index !== undefined) {
      entry = this.byIndex.get(index);
      if (entry && id && !entry.idIsPlaceholder && entry.id !== id) entry = undefined;
      else if (entry && !id && name && isCompleteJson(entry.argumentsText)) entry = undefined;
    } else if (id) {
      entry = this.byId.get(id);
    } else if (!name) {
      entry = this.last;
    }
    if (!entry) {
      const position = this.entries.length;
      entry = {
        id: id ?? `${this.options.idPrefix ?? "toolcall_"}${position}`,
        name: name ?? (this.options.blankName ? "" : `tool_${position}`),
        argumentsText: "",
        idIsPlaceholder: !id
      };
      this.entries.push(entry);
    } else if (id && entry.idIsPlaceholder) {
      entry.id = id;
      entry.idIsPlaceholder = false;
    }
    if (index !== undefined) this.byIndex.set(index, entry);
    if (id) this.byId.set(id, entry);
    if (name) entry.name = name;
    if (typeof chunk.argumentsDelta === "string") entry.argumentsText += chunk.argumentsDelta;
    this.last = entry;
    return this.entries.indexOf(entry);
  }

  /** How many calls have begun. */
  get size(): number {
    return this.entries.length;
  }

  /** The calls in the order they began. */
  calls(): AssembledToolCall[] {
    return this.entries.map(({ id, name, argumentsText }) => ({ id, name, argumentsText }));
  }
}
