import type { ConnectorDocument } from "@ai-orchestrator/shared";

export interface EmbeddingAdapter {
  id: string;
  embed(text: string): number[];
}

export interface VectorStoreItem {
  document: ConnectorDocument;
  vector: number[];
}

export interface VectorStoreAdapter {
  id: string;
  upsert(documents: ConnectorDocument[], embedder: EmbeddingAdapter): void;
  similaritySearch(query: string, topK: number, embedder: EmbeddingAdapter): ConnectorDocument[];
}

export interface RetrieverAdapter {
  id: string;
  retrieve(query: string, documents: ConnectorDocument[], topK: number): ConnectorDocument[];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

export class TokenEmbeddingAdapter implements EmbeddingAdapter {
  readonly id = "token-embedder";

  embed(text: string): number[] {
    const tokens = tokenize(text);
    const buckets = new Array<number>(64).fill(0);

    for (const token of tokens) {
      let hash = 0;
      for (let index = 0; index < token.length; index += 1) {
        hash = (hash * 31 + token.charCodeAt(index)) % buckets.length;
      }
      buckets[hash] += 1;
    }

    return buckets;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const length = Math.max(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const va = a[index] ?? 0;
    const vb = b[index] ?? 0;
    dot += va * vb;
    magA += va * va;
    magB += vb * vb;
  }

  if (!magA || !magB) {
    return 0;
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export class InMemoryVectorStoreAdapter implements VectorStoreAdapter {
  readonly id = "in-memory-vector-store";

  private items: VectorStoreItem[] = [];

  upsert(documents: ConnectorDocument[], embedder: EmbeddingAdapter): void {
    const mapped = documents.map((document) => ({
      document,
      vector: embedder.embed(document.text)
    }));

    this.items = mapped;
  }

  similaritySearch(query: string, topK: number, embedder: EmbeddingAdapter): ConnectorDocument[] {
    const queryVector = embedder.embed(query);
    return this.items
      .map((item) => ({
        item,
        score: cosineSimilarity(queryVector, item.vector)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((entry) => entry.item.document);
  }
}

export class InMemoryRetrieverAdapter implements RetrieverAdapter {
  readonly id = "in-memory-retriever";

  retrieve(query: string, documents: ConnectorDocument[], topK: number): ConnectorDocument[] {
    const embedder = new TokenEmbeddingAdapter();
    const store = new InMemoryVectorStoreAdapter();
    store.upsert(documents, embedder);
    return store.similaritySearch(query, topK, embedder);
  }
}