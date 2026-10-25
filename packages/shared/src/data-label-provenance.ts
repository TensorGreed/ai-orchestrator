import { getNodeDefinition } from "./definitions";
import { PROVENANCE_LABELS, type ProvenanceLabel } from "./data-labels";

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
