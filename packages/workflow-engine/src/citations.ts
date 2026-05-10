/**
 * Phase 9.4 — Citation extraction.
 *
 * Closes the trust loop on RAG: every chunk retrieved by `rag_retrieve` /
 * `hybrid_search` / `rerank` already carries a stable `chunkId` and
 * `sourceId` (Phase 9.1). This module converts that provenance into
 * structured citations the UI can render as clickable footnotes — and
 * surfaces "uncited claims" / "answer with no citations" as data the eval
 * framework can score against.
 *
 * Two citation marker conventions are recognized in the LLM's answer text:
 *   - Numeric brackets like `[1]`, `[2]` — matches the index `rag_retrieve`
 *     prepends to each chunk in its `context` string. This is the default
 *     and what the shipped citation prompt asks the model to use.
 *   - Direct chunk IDs like `[kbc_abc-xyz]` — matches when the model
 *     references the chunk's stable ID. Useful when the upstream workflow
 *     formats context with explicit IDs.
 *
 * Both are extracted when present; numeric markers take precedence on
 * collision (the 1-based index is what the prompt instructed the model to
 * use, so a literal `[1]` should map to document 0 even if a chunk's id
 * happens to be `1`).
 */

import type { ConnectorDocument } from "@ai-orchestrator/shared";

export interface DocumentCitation {
  /** The verbatim marker as it appeared in the answer, e.g. "[1]" or "[kbc_abc]". */
  marker: string;
  /** 1-based ordinal in the documents array — handy for "Source 3" labels in the UI. */
  index: number;
  /** Stable chunk ID. Always set if the upstream document had one. */
  chunkId?: string;
  sourceId?: string | null;
  knowledgeBaseId?: string;
  /** The chunk's text — keep short tooltip-friendly previews on the consumer side. */
  text: string;
  similarityScore?: number;
  rerankerScore?: number;
  /** "vector" | "bm25" | "hybrid" when the upstream node populated retrieval.mode. */
  retrievalMode?: string;
  /** Char offsets of the marker in the answer string. */
  startIndex: number;
  endIndex: number;
}

export interface ExtractedCitations {
  /** The answer as-is. Markers are NOT stripped — the UI renders over them. */
  answer: string;
  citations: DocumentCitation[];
  /** Distinct chunk IDs (or indexes when the chunk lacked an ID) that were cited. */
  uniqueCitedDocuments: number;
  /** True iff at least one citation marker resolved to a known document. */
  hasCitations: boolean;
}

/**
 * Default instructional snippet a workflow can drop into its prompt template.
 * Stays short to avoid stealing too much of the prompt budget; tells the
 * model to reference the bracketed index `rag_retrieve` already prepended
 * to each context chunk.
 */
export const DEFAULT_CITATION_INSTRUCTIONS = [
  "When you make a claim that comes from the context, end the sentence with a citation marker that matches the bracketed source number, e.g. [1] or [2].",
  "If a claim is supported by multiple sources, cite all of them: [1][3].",
  "If you cannot find an answer in the context, say so plainly — do not fabricate citations."
].join(" ");

interface DocumentRef {
  document: ConnectorDocument;
  index: number;
  chunkId?: string;
}

/**
 * Scan an answer string for citation markers, resolve each one to a known
 * document, and return structured citations. The answer is preserved
 * verbatim — callers that want to render the markers as React links pass
 * the offset pairs to a tokenizer.
 */
export function extractCitationsFromText(
  answer: string,
  documents: ConnectorDocument[]
): ExtractedCitations {
  if (!answer || documents.length === 0) {
    return { answer: answer ?? "", citations: [], uniqueCitedDocuments: 0, hasCitations: false };
  }

  // Build resolution maps once per call: numeric "1", "2", ... → doc and
  // chunkId → doc (for direct-id citations).
  const byNumber = new Map<string, DocumentRef>();
  const byChunkId = new Map<string, DocumentRef>();
  documents.forEach((document, index) => {
    const meta = (document.metadata && typeof document.metadata === "object" ? document.metadata : {}) as Record<string, unknown>;
    const chunkId = typeof meta.chunkId === "string"
      ? meta.chunkId
      : typeof document.id === "string"
        ? document.id
        : undefined;
    const ref: DocumentRef = { document, index, chunkId };
    byNumber.set(String(index + 1), ref);
    if (chunkId) byChunkId.set(chunkId, ref);
  });

  // Match [<token>] where token is a non-empty run of word chars / hyphens
  // / underscores. Excludes anything else (no nested brackets, no spaces).
  const markerRe = /\[([A-Za-z0-9][A-Za-z0-9_\-]*)\]/g;
  const citations: DocumentCitation[] = [];
  const seenDocs = new Set<string>();

  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(answer)) !== null) {
    const token = m[1]!;
    // Numeric markers win — they're what the prompt asked for.
    const ref = byNumber.get(token) ?? byChunkId.get(token);
    if (!ref) continue;
    const meta = (ref.document.metadata && typeof ref.document.metadata === "object"
      ? ref.document.metadata
      : {}) as Record<string, unknown>;
    citations.push({
      marker: m[0]!,
      index: ref.index + 1,
      chunkId: ref.chunkId,
      sourceId: typeof meta.sourceId === "string" || meta.sourceId === null
        ? (meta.sourceId as string | null)
        : undefined,
      knowledgeBaseId: typeof meta.knowledgeBaseId === "string" ? meta.knowledgeBaseId : undefined,
      text: ref.document.text,
      similarityScore: typeof meta.similarityScore === "number" ? meta.similarityScore : undefined,
      rerankerScore: typeof meta.rerankerScore === "number" ? meta.rerankerScore : undefined,
      retrievalMode:
        meta.retrieval && typeof meta.retrieval === "object" && typeof (meta.retrieval as { mode?: unknown }).mode === "string"
          ? ((meta.retrieval as { mode: string }).mode)
          : undefined,
      startIndex: m.index,
      endIndex: m.index + m[0]!.length
    });
    seenDocs.add(ref.chunkId ?? `idx:${ref.index}`);
  }

  return {
    answer,
    citations,
    uniqueCitedDocuments: seenDocs.size,
    hasCitations: citations.length > 0
  };
}

/**
 * Format the documents list as a numbered context block — same shape
 * `rag_retrieve` already uses, but exposed as a free function so the
 * `extract_citations` node and any callers stay consistent.
 */
export function formatNumberedContext(documents: ConnectorDocument[]): string {
  return documents.map((doc, index) => `[${index + 1}] ${doc.text}`).join("\n");
}
