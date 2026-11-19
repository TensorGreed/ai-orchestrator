/**
 * How a knowledge-base search ranks when the RAG Retrieve node (or the Knowledge page's test search) sets no search
 * mode. The built-in Token embedder needs no key but its vectors are a hash of the words, so on its own it ranks
 * poorly; keyword search (BM25) next to it, fused (hybrid), finds the passages that share the question's words. Every
 * other embedder keeps vector search as before. A mode set on the node always wins.
 */

export const TOKEN_EMBEDDER_ID = "token-embedder";

export const RAG_SEARCH_MODES = ["vector", "bm25", "hybrid"] as const;
export type RagSearchMode = (typeof RAG_SEARCH_MODES)[number];

/** The mode a search uses when none is set: hybrid with the Token embedder (also when no embedder is set), else vector. */
export function defaultRagSearchMode(embedderId: unknown): "vector" | "hybrid" {
  const id = typeof embedderId === "string" && embedderId ? embedderId : TOKEN_EMBEDDER_ID;
  return id === TOKEN_EMBEDDER_ID ? "hybrid" : "vector";
}

/** The node's search mode: the one it sets, else the default for its embedder. */
export function resolveRagSearchMode(config: { searchMode?: unknown; embedderId?: unknown }): RagSearchMode {
  const set = config.searchMode;
  if (typeof set === "string" && (RAG_SEARCH_MODES as readonly string[]).includes(set)) return set as RagSearchMode;
  return defaultRagSearchMode(config.embedderId);
}
