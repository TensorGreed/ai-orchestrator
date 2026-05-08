/**
 * Phase 9.2 — Shared text chunking helpers.
 *
 * Extracted from the inline `document_chunker` dispatch in executor.ts so the
 * REST ingestion path (apps/api `POST /api/knowledge-bases/:id/upload`) and
 * the workflow node share one implementation. Behavior is identical to the
 * Phase 1 chunker — separator / character / recursive / token strategies —
 * and keeps the same chunk-id pattern (`<docId>-chunk-<index>`) so existing
 * sample workflows still work.
 */

import type { ConnectorDocument } from "@ai-orchestrator/shared";

export type ChunkStrategy = "separator" | "character" | "recursive" | "token";

export interface ChunkOptions {
  /** Max chars (or tokens, when strategy="token") per chunk. Default 500. */
  chunkSize?: number;
  /** Overlap in the same units as chunkSize. Default 50. */
  chunkOverlap?: number;
  /** Separator used by the "separator" strategy. Default "\n\n". */
  separator?: string;
  /** Default "separator". */
  strategy?: ChunkStrategy;
}

const DEFAULT_OPTIONS: Required<ChunkOptions> = {
  chunkSize: 500,
  chunkOverlap: 50,
  separator: "\n\n",
  strategy: "separator"
};

function normalizeOptions(input: ChunkOptions = {}): Required<ChunkOptions> {
  return {
    chunkSize: typeof input.chunkSize === "number" && input.chunkSize > 0 ? Math.floor(input.chunkSize) : DEFAULT_OPTIONS.chunkSize,
    chunkOverlap: typeof input.chunkOverlap === "number" && input.chunkOverlap >= 0 ? Math.floor(input.chunkOverlap) : DEFAULT_OPTIONS.chunkOverlap,
    separator: typeof input.separator === "string" ? input.separator : DEFAULT_OPTIONS.separator,
    strategy: input.strategy ?? DEFAULT_OPTIONS.strategy
  };
}

function asMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Split a single text document into chunks. The result has stable
 * `<docId>-chunk-<index>` IDs so the same input produces the same output
 * across runs (important for re-ingestion idempotency at the source level).
 */
export function chunkDocument(
  doc: ConnectorDocument,
  options: ChunkOptions = {}
): ConnectorDocument[] {
  return chunkDocuments([doc], options);
}

/**
 * Split a batch of documents. Output ordering matches input ordering.
 */
export function chunkDocuments(
  docs: ConnectorDocument[],
  options: ChunkOptions = {}
): ConnectorDocument[] {
  const opts = normalizeOptions(options);
  const out: ConnectorDocument[] = [];

  if (opts.strategy === "separator") {
    for (const doc of docs) {
      const text = doc.text.trim();
      if (!text) continue;

      const pieces = text.split(opts.separator).filter(Boolean);
      let currentChunk = "";
      let index = 0;

      for (const piece of pieces) {
        if ((currentChunk + opts.separator + piece).length > opts.chunkSize && currentChunk.length > 0) {
          out.push({
            id: `${doc.id}-chunk-${index}`,
            text: currentChunk,
            metadata: { ...asMetadata(doc.metadata), chunkIndex: index, originalId: doc.id }
          });
          index += 1;
          const overlapAmount = Math.min(opts.chunkOverlap, currentChunk.length);
          currentChunk = currentChunk.slice(-overlapAmount) + opts.separator + piece;
        } else {
          currentChunk = currentChunk ? currentChunk + opts.separator + piece : piece;
        }
      }

      if (currentChunk) {
        out.push({
          id: `${doc.id}-chunk-${index}`,
          text: currentChunk,
          metadata: { ...asMetadata(doc.metadata), chunkIndex: index, originalId: doc.id }
        });
      }
    }
    return out;
  }

  if (opts.strategy === "character") {
    for (const doc of docs) {
      const text = doc.text;
      const stride = Math.max(1, opts.chunkSize - opts.chunkOverlap);
      for (let i = 0; i < text.length; i += stride) {
        const piece = text.slice(i, i + opts.chunkSize);
        if (!piece.trim()) continue;
        out.push({
          id: `${doc.id}-chunk-${out.length}`,
          text: piece,
          metadata: { ...asMetadata(doc.metadata), chunkIndex: out.length, originalId: doc.id }
        });
      }
    }
    return out;
  }

  if (opts.strategy === "recursive") {
    const separators = ["\n\n", "\n", ". ", " "];
    for (const doc of docs) {
      const pieces = recursiveSplit(doc.text, separators, opts.chunkSize);
      for (const piece of pieces) {
        if (!piece.trim()) continue;
        out.push({
          id: `${doc.id}-chunk-${out.length}`,
          text: piece,
          metadata: { ...asMetadata(doc.metadata), chunkIndex: out.length, originalId: doc.id }
        });
      }
    }
    return out;
  }

  if (opts.strategy === "token") {
    // Approximate: 1 token ≈ 4 chars (English-text rule of thumb). Real
    // tokenizers vary by model — for accurate counts, embed first then
    // measure, or wire tiktoken in a follow-up.
    const charsPerToken = 4;
    const charLimit = opts.chunkSize * charsPerToken;
    const charOverlap = opts.chunkOverlap * charsPerToken;
    const stride = Math.max(1, charLimit - charOverlap);
    for (const doc of docs) {
      const text = doc.text;
      for (let i = 0; i < text.length; i += stride) {
        let end = Math.min(i + charLimit, text.length);
        // Snap to nearest word boundary if we're not at the end
        if (end < text.length) {
          const lastSpace = text.lastIndexOf(" ", end);
          if (lastSpace > i + charLimit * 0.8) end = lastSpace;
        }
        const piece = text.slice(i, end).trim();
        if (!piece) continue;
        out.push({
          id: `${doc.id}-chunk-${out.length}`,
          text: piece,
          metadata: { ...asMetadata(doc.metadata), chunkIndex: out.length, originalId: doc.id }
        });
      }
    }
    return out;
  }

  throw new Error(`Unknown chunking strategy: ${opts.strategy}`);
}

function recursiveSplit(text: string, seps: string[], maxSize: number): string[] {
  if (text.length <= maxSize) return [text];
  const sep = seps[0] || "";
  const parts = sep ? text.split(sep) : [text];
  const chunks: string[] = [];
  let current = "";
  for (const part of parts) {
    const candidate = current ? current + sep + part : part;
    if (candidate.length > maxSize && current) {
      chunks.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length > maxSize && seps.length > 1) {
      result.push(...recursiveSplit(chunk, seps.slice(1), maxSize));
    } else {
      result.push(chunk);
    }
  }
  return result;
}
