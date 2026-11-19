import { z } from "zod";

/**
 * Item semantics of the Filter, Set, Loop and Merge nodes: the settings they share between the engine, the editor
 * and the importer. A setting that is absent keeps the behaviour the node had before it existed, so stored workflows
 * run as they did; new nodes start from the definitions' sample config, which sets them.
 */

/**
 * How a Set field's value is typed.
 * - `auto`: a value that is one `{{ }}` keeps its type (number, boolean, object, list); other values are text, and
 *   text that is a JSON object or list is parsed.
 * - `string`, `number`, `boolean`, `json`: the value is converted to that type, and a value that cannot be is an error.
 * A field without a type (saved before types existed) renders to text and parses a JSON object or list, as before.
 */
export const SET_VALUE_TYPES = ["auto", "string", "number", "boolean", "json"] as const;
export type SetValueType = (typeof SET_VALUE_TYPES)[number];
export const setValueTypeSchema = z.enum(SET_VALUE_TYPES);

export function isSetValueType(value: unknown): value is SetValueType {
  return typeof value === "string" && (SET_VALUE_TYPES as readonly string[]).includes(value);
}

/**
 * Filter modes.
 * - `items`: keeps the items of a list (`itemsFrom`, or the first list in the input) that match the conditions.
 * - `gate`: judges the whole input once and reports `passed` (the only behaviour before modes existed, and still the
 *   behaviour of a Filter without a mode).
 */
export const FILTER_MODES = ["items", "gate"] as const;
export type FilterMode = (typeof FILTER_MODES)[number];
export const filterModeSchema = z.enum(FILTER_MODES);

/** A Filter without a mode is a gate: it was saved before item filtering existed. */
export function filterModeOf(config: Record<string, unknown>): FilterMode {
  return config.mode === "items" ? "items" : "gate";
}

/**
 * What the next node on an items-mode Filter's Rejected output (`filtered`) receives: the rejected items as `items`,
 * with `count`, `total` and `items_from`. Any other output is returned as it is.
 */
export function filterRejectedView(output: unknown): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) return output;
  const record = output as Record<string, unknown>;
  if (!Array.isArray(record.rejected)) return output;
  return { items: record.rejected, count: record.rejected.length, total: record.total, items_from: record.items_from };
}

/**
 * True when a node reads an items-mode Filter only through its Rejected output: every edge from the Filter to it
 * leaves by `filtered` (an edge without a handle, or from Kept, passes the whole output).
 */
export function readsFilterRejected(parent: { type?: string; config?: Record<string, unknown> }, handles: ReadonlyArray<string | null | undefined>): boolean {
  if (parent.type !== "filter_node" || filterModeOf(parent.config ?? {}) !== "items") return false;
  return handles.length > 0 && handles.every((handle) => handle === "filtered");
}

/**
 * Merge modes. `collect_loop_passes` gathers every pass of a Loop body node connected into the Merge (one entry
 * per pass), where the other modes see only the body's last pass.
 */
export const MERGE_MODES = ["append", "combine_by_key", "choose_branch", "collect_loop_passes"] as const;
export type MergeMode = (typeof MERGE_MODES)[number];
export const mergeModeSchema = z.enum(MERGE_MODES);

export function isMergeMode(value: unknown): value is MergeMode {
  return typeof value === "string" && (MERGE_MODES as readonly string[]).includes(value);
}

/** True when a Loop node adds `collected` (one entry per pass) to its output. Off for Loops saved before it existed. */
export function loopCollectsResults(config: Record<string, unknown>): boolean {
  return config.collectResults === true;
}

/**
 * True when IF, Switch, Filter and the other branching nodes route inside a Loop's body: each pass runs only the
 * outputs they take, and the nodes on those outputs are part of the body. Off for Loops saved before it existed (the
 * nodes on every output run once, after the loop); new Loops have it on.
 */
export function loopRoutesBranches(config: Record<string, unknown>): boolean {
  return config.routeBranches === true;
}
