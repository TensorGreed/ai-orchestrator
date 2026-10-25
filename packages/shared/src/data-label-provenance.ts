import { getNodeDefinition } from "./definitions";
import { inputProvenance, PROVENANCE_LABELS, type DataLabels, type ProvenanceLabel } from "./data-labels";

/**
 * Phase 16 — the capture provenance rules (Phase 15.6), shared by production
 * capture and the engine's label propagation so both use one copy.
 */

/** Node categories that bring in content from outside the workflow. */
const EXTERNAL_NODE_CATEGORIES = new Set(["Connector", "RAG", "MCP"]);
/** Node types that fetch from outside the workflow whatever their category. */
const EXTERNAL_NODE_TYPES = new Set(["http_request", "web_browse", "mcp_tool"]);

const categoryByType = new Map<string, string>();

/**
 * Where a node's own content comes from, by its type: `input` for input
 * nodes (they carry the run's input), `external` for nodes that fetch from
 * outside the workflow (HTTP, web browse, MCP tools, connectors, RAG), null
 * for the rest.
 */
export function nodeContentSource(nodeType: string): "input" | "external" | null {
  let category = categoryByType.get(nodeType);
  if (category === undefined) {
    category = getNodeDefinition(nodeType)?.category ?? "";
    categoryByType.set(nodeType, category);
  }
  if (category === "Input") return "input";
  if (EXTERNAL_NODE_CATEGORIES.has(category) || EXTERNAL_NODE_TYPES.has(nodeType)) return "external";
  return null;
}

/** Where a node's content came from: input nodes carry the run's input provenance, nodes that fetch from outside are external. */
export function provenanceFor(nodeType: string, input: ProvenanceLabel): ProvenanceLabel[] {
  const source = nodeContentSource(nodeType);
  if (source === "input") return [input];
  if (source === "external") return ["untrusted_external"];
  return [];
}

/** Provenance labels in their canonical order, de-duplicated. */
export function orderedProvenance(labels: Iterable<ProvenanceLabel>): ProvenanceLabel[] {
  const set = new Set(labels);
  return PROVENANCE_LABELS.filter((label) => set.has(label));
}

/** Triggers a signed-in user or an API key starts (the editor, retries, replays of such runs, evals). */
const USER_STARTED_TRIGGERS = new Set(["manual", "manual_stream", "manual_retry", "mcp_replay", "eval"]);

/**
 * Phase 16 (Q7) — the input labels of a run that replays a recorded one (a
 * replay, a gate or simulation case, an MCP replay, an eval of a recorded
 * case): where the recorded run's input came from, never where the replay
 * was started. The recording's input-node labels win; else the source
 * trigger decides (runs a user started — the editor, hand-saved golden runs
 * — are `user`, everything else is judged by the capture rules, which never
 * give `trusted` without the server's own scheduler). Labels read from an
 * imported file never carry `trusted`, and a recording imported from a file
 * always adds `untrusted_external`: its trigger type and labels are the
 * file's claim, so it can never make its input count as only a user's.
 */
export function recordedInputLabels(recording: {
  nodes?: ReadonlyArray<{ nodeType?: string; labels?: DataLabels | null }> | null;
  sourceTriggerType?: string | null;
  /** The recording came from an imported golden-set file. */
  imported?: boolean;
}): DataLabels {
  const provenance = new Set<ProvenanceLabel>();
  for (const node of recording.nodes ?? []) {
    if (!node?.labels || typeof node.nodeType !== "string" || nodeContentSource(node.nodeType) !== "input") continue;
    for (const label of node.labels.provenance ?? []) {
      if (label === "trusted" && node.labels.source === "file") continue;
      provenance.add(label);
    }
  }
  if (provenance.size === 0) {
    const trigger = recording.sourceTriggerType ?? null;
    provenance.add(trigger && USER_STARTED_TRIGGERS.has(trigger) ? "user" : inputProvenance(trigger, undefined));
  }
  if (recording.imported) provenance.add("untrusted_external");
  return { provenance: orderedProvenance(provenance), dataClasses: [], source: "propagated" };
}
