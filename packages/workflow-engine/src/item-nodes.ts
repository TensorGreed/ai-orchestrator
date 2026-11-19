import { isSetValueType, type SetValueType } from "@ai-orchestrator/shared";
import { renderTemplate, renderTemplateValue } from "./template";

/**
 * Item semantics of the Set, Filter, Loop and Merge nodes (see `@ai-orchestrator/shared` item-nodes for the
 * settings). Pure helpers: the executor supplies the template data and records what a node read.
 */

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
const isRecord = isRecordValue;

function looksLikeJsonContainer(text: string): boolean {
  const trimmed = text.trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

/** Text that is a JSON object or list is parsed; other text stays as it is (a Set field without a type, and `auto`). */
function parseJsonContainer(text: string): unknown {
  if (!text.trim() || !looksLikeJsonContainer(text)) return text;
  try {
    return JSON.parse(text.trim());
  } catch {
    return text;
  }
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

const TRUE_WORDS = new Set(["true", "yes", "y", "on", "1"]);
const FALSE_WORDS = new Set(["false", "no", "n", "off", "0"]);

/**
 * Converts a field's value to its type. `single` is the value of a template that is one `{{ }}` (its type kept);
 * otherwise `rendered` is the template's text. An empty or missing value is `null` for the number, boolean and JSON
 * types. Throws when a value cannot be converted; the message names the field but not the value.
 */
export function typedSetValue(key: string, type: SetValueType, result: { single: true; value: unknown } | { single: false; rendered: string }): unknown {
  const raw = result.single ? result.value : result.rendered;
  const text = result.single ? asText(result.value) : result.rendered;
  switch (type) {
    case "auto":
      if (result.single) return result.value === undefined ? null : result.value;
      return parseJsonContainer(result.rendered);
    case "string":
      return text;
    case "number": {
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      if (!text.trim()) return null;
      const parsed = typeof raw === "boolean" ? Number(raw) : Number(text.trim());
      if (!Number.isFinite(parsed)) throw new Error(`Set field '${key}' is typed number, but its value is not a number.`);
      return parsed;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (!text.trim()) return null;
      const word = text.trim().toLowerCase();
      if (TRUE_WORDS.has(word)) return true;
      if (FALSE_WORDS.has(word)) return false;
      throw new Error(`Set field '${key}' is typed boolean, but its value is not true or false (or yes/no, 1/0, on/off).`);
    }
    case "json": {
      if (result.single && typeof raw !== "string") return raw === undefined ? null : raw;
      if (!text.trim()) return null;
      try {
        return JSON.parse(text.trim());
      } catch {
        throw new Error(`Set field '${key}' is typed JSON, but its value is not valid JSON.`);
      }
    }
  }
}

/**
 * A Set node's output. A field without a type renders to text and parses a JSON object or list, as Set always did,
 * so saved workflows give the same output; a typed field keeps or converts its value's type. An unknown type fails
 * the node (validation reports it before a run).
 */
export function buildSetOutput(assignments: unknown[], templateData: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const entry of assignments) {
    const assignment = isRecord(entry) ? entry : {};
    const key = typeof assignment.key === "string" ? assignment.key.trim() : "";
    if (!key) continue;
    const template = typeof assignment.valueTemplate === "string" ? assignment.valueTemplate : "";
    const type = assignment.type;
    if (type === undefined || type === null || type === "") {
      output[key] = parseJsonContainer(renderTemplate(template, templateData));
      continue;
    }
    if (!isSetValueType(type)) {
      throw new Error(`Set field '${key}' has an unknown type '${String(type)}'. Use auto, string, number, boolean or json.`);
    }
    const value = type === "string" ? { single: false as const, rendered: renderTemplate(template, templateData) } : renderTemplateValue(template, templateData);
    output[key] = typedSetValue(key, type, value);
  }
  return output;
}

/** Keys the engine adds to a node's template data that are not data from an upstream node. */
const NOT_ITEM_SOURCES = new Set(["parent_outputs", "results", "vars", "workflow", "execution", "webhook", "images"]);

/**
 * The first list in a node's input, breadth first (top-level fields before nested ones), up to three levels deep:
 * `products`, then `body.items`, then `body.data.rows`. Internal keys (`_…`) and engine context are skipped.
 * Returns the path to it, or undefined when the input has no list.
 */
export function findFirstList(input: Record<string, unknown>, maxDepth = 3): string | undefined {
  let level: Array<{ path: string; value: Record<string, unknown> }> = [{ path: "", value: input }];
  for (let depth = 0; depth < maxDepth && level.length > 0; depth += 1) {
    const next: Array<{ path: string; value: Record<string, unknown> }> = [];
    for (const { path, value } of level) {
      for (const [key, child] of Object.entries(value)) {
        if (key.startsWith("_") || key.startsWith("$")) continue;
        if (depth === 0 && NOT_ITEM_SOURCES.has(key)) continue;
        const childPath = path ? `${path}.${key}` : key;
        if (Array.isArray(child)) return childPath;
        if (isRecord(child)) next.push({ path: childPath, value: child });
      }
    }
    level = next;
  }
  return undefined;
}

/**
 * A node's input as one item, for a Filter in items mode whose input has no list: the one parent's output, or with
 * several parents their fields together (without the copies keyed by parent id, or internal `_…` keys).
 */
export function singleInputItem(parentOutputs: Record<string, unknown>, merged: Record<string, unknown>): unknown {
  const parents = Object.values(parentOutputs);
  if (parents.length === 1) return parents[0];
  const item: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (key.startsWith("_") || Object.prototype.hasOwnProperty.call(parentOutputs, key)) continue;
    item[key] = value;
  }
  return item;
}

/** A Filter's Items from: a path (`body.items`) or one `{{ path }}`; empty means the first list in the input. */
export function normalizeItemsFrom(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const match = /^{{\s*([A-Za-z0-9_.$-]+)\s*}}$/.exec(trimmed);
  return (match ? match[1] : trimmed).replace(/^\$json\./, "");
}

/**
 * What a Loop's `results` holds for one pass: the body node's output when the body is one node, else the pass's
 * outputs keyed by body node id.
 */
export function loopPassResult(outputs: Record<string, unknown>, bodyNodeIds: readonly string[]): unknown {
  if (bodyNodeIds.length === 1) return outputs[bodyNodeIds[0]];
  const keyed: Record<string, unknown> = {};
  for (const id of bodyNodeIds) if (id in outputs) keyed[id] = outputs[id];
  return keyed;
}

/**
 * Every pass of a Loop body node, read from the Loop's output (`items[].outputs.<bodyId>`), so it is the same after a
 * run resumes. Undefined when `loopOutput` has no pass that ran the node.
 */
export function loopPassesOf(loopOutput: unknown, bodyNodeId: string): unknown[] | undefined {
  if (!isRecord(loopOutput) || !Array.isArray(loopOutput.items)) return undefined;
  const passes: unknown[] = [];
  let found = false;
  for (const pass of loopOutput.items) {
    const outputs = isRecord(pass) && isRecord(pass.outputs) ? pass.outputs : undefined;
    if (outputs && Object.prototype.hasOwnProperty.call(outputs, bodyNodeId)) {
      found = true;
      passes.push(outputs[bodyNodeId]);
    }
  }
  return found ? passes : undefined;
}
