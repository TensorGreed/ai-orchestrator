/**
 * Which node a model-usage blob belongs to.
 *
 * Usage is counted from the `_telemetry` (and `_childTelemetry`) fields of node outputs. A node that passes its input
 * on (an Approval Gate after its approval, If, Switch, Filter, No-op, a disabled node, a Code node returning its
 * input, an Execute Workflow node returning its child's output) would carry the producing node's blob too, and the
 * same model call would be counted twice. So each node runs as an owner: the engine code that makes a model call
 * marks the blob it creates (`ownUsage`), and when the node finishes only the blobs it made itself stay on its output
 * (`keepOwnUsage`). Everything else (copied from a parent, from a child run, from pinned or recorded data, or written
 * by user code) is removed from that node's output; the producing node's own output still holds it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** The output fields that hold model usage. */
export const USAGE_OUTPUT_KEYS = ["_telemetry", "_childTelemetry"] as const;

const owners = new AsyncLocalStorage<object>();
const ownerOf = new WeakMap<object, object>();

/** Runs a node's handler as the owner of the usage it makes; returns its output keeping only that usage. */
export async function runAsUsageOwner(body: () => Promise<unknown>): Promise<unknown> {
  const owner = {};
  const output = await owners.run(owner, body);
  return keepOwnUsage(output, owner);
}

/** Marks a usage blob (or a list of them) as made by the node that is running. Returns it unchanged. */
export function ownUsage<T>(blob: T): T {
  const owner = owners.getStore();
  if (owner && blob !== null && typeof blob === "object") ownerOf.set(blob as object, owner);
  return blob;
}

/** Marks the usage fields an output already holds (a recorded answer that stands in for the node's own call). */
export function ownUsageOf<T>(output: T): T {
  if (isPlainObject(output)) for (const key of USAGE_OUTPUT_KEYS) ownUsage(output[key]);
  return output;
}

/** The output without usage fields (pinned data made no model call). Unchanged when it has none. */
export function withoutUsage<T>(output: T): T {
  if (!isPlainObject(output) || !USAGE_OUTPUT_KEYS.some((key) => key in output)) return output;
  const copy: Record<string | symbol, unknown> = { ...output };
  for (const key of USAGE_OUTPUT_KEYS) delete copy[key];
  return copy as T;
}

function keepOwnUsage(output: unknown, owner: object): unknown {
  if (!isPlainObject(output)) return output;
  const foreign = USAGE_OUTPUT_KEYS.filter((key) => {
    if (!(key in output)) return false;
    const value = output[key];
    return value === null || typeof value !== "object" || ownerOf.get(value) !== owner;
  });
  if (foreign.length === 0) return output;
  // A copy: the object may be a parent's output, which keeps its own usage.
  const copy: Record<string | symbol, unknown> = { ...output };
  for (const key of foreign) delete copy[key];
  return copy;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
