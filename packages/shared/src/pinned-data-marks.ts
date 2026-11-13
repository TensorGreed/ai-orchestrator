import type { Workflow } from "./types";

/**
 * v74 — the pin marks a saved workflow keeps. Every save goes through this, whatever the client sent: a stored mark
 * stays while the node is pinned, even when its data is edited or replaced (an edit of content copied from a
 * sensitive run is still that content, and a client that drops or never knew the field cannot clear it); a mark the
 * saved workflow itself carries is kept for a node that has pinned data; a mark on a node without pinned data is
 * dropped, so removing the pin is what clears it. Returns `incoming` itself when nothing changes.
 */
export function keepPinnedDataMarks<T extends Pick<Workflow, "pinnedData" | "pinnedDataSensitive">>(existing: Pick<Workflow, "pinnedData" | "pinnedDataSensitive"> | null | undefined, incoming: T): T {
  const pins = incoming.pinnedData && typeof incoming.pinnedData === "object" && !Array.isArray(incoming.pinnedData) ? incoming.pinnedData : {};
  const pinned = (nodeId: string) => Object.prototype.hasOwnProperty.call(pins, nodeId);
  const marks = new Set<string>();
  for (const nodeId of Array.isArray(incoming.pinnedDataSensitive) ? incoming.pinnedDataSensitive : []) {
    if (typeof nodeId === "string" && pinned(nodeId)) marks.add(nodeId);
  }
  for (const nodeId of Array.isArray(existing?.pinnedDataSensitive) ? existing.pinnedDataSensitive : []) {
    if (typeof nodeId === "string" && pinned(nodeId)) marks.add(nodeId);
  }
  const next = [...marks].sort();
  const current = incoming.pinnedDataSensitive;
  if (next.length === 0) {
    if (current === undefined) return incoming;
    const { pinnedDataSensitive: _dropped, ...rest } = incoming;
    return rest as T;
  }
  if (Array.isArray(current) && current.length === next.length && current.every((nodeId, index) => nodeId === next[index])) return incoming;
  return { ...incoming, pinnedDataSensitive: next };
}

/** v74 — whether the pinned data of `nodeId` was copied from a run that was sensitive work. */
export function pinnedDataMarked(workflow: Pick<Workflow, "pinnedDataSensitive">, nodeId: string): boolean {
  return Array.isArray(workflow.pinnedDataSensitive) && workflow.pinnedDataSensitive.includes(nodeId);
}
