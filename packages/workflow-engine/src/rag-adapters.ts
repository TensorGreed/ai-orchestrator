import type { ConnectorDocument } from "@ai-orchestrator/shared";
import pg from "pg";

export interface EmbeddingAdapter {
  id: string;
  embed(text: string): Promise<number[]>;
}

export interface SyncEmbeddingAdapter extends EmbeddingAdapter {
  embedSync(text: string): number[];
}

export interface VectorStoreItem {
  document: ConnectorDocument;
  vector: number[];
}

export interface VectorStoreAdapter {
  id: string;
  upsert(documents: ConnectorDocument[], embedder: EmbeddingAdapter): Promise<void>;
  similaritySearch(query: string, topK: number, embedder: EmbeddingAdapter): Promise<ConnectorDocument[]>;
}

export interface RetrieverAdapter {
  id: string;
  retrieve(query: string, documents: ConnectorDocument[], topK: number): Promise<ConnectorDocument[]>;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

export class TokenEmbeddingAdapter implements SyncEmbeddingAdapter {
  readonly id = "token-embedder";

  embedSync(text: string): number[] {
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

  async embed(text: string): Promise<number[]> {
    return this.embedSync(text);
  }
}

export class OpenAIEmbeddingAdapter implements EmbeddingAdapter {
  readonly id = "openai-embedder";

  constructor(private config: { baseUrl?: string; model?: string; apiKey: string }) {}

  async embed(text: string): Promise<number[]> {
    const baseUrl = this.config.baseUrl || "https://api.openai.com/v1";
    const model = this.config.model || "text-embedding-3-small";
    
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({ model, input: text })
    });

    if (!response.ok) {
      throw new Error(`OpenAI Embedding API error: ${response.statusText} - ${await response.text()}`);
    }

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding || [];
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export class AzureOpenAIEmbeddingAdapter implements EmbeddingAdapter {
  readonly id = "azure-openai-embedder";

  constructor(
    private config: { endpoint: string; deployment: string; apiVersion?: string; apiKey: string }
  ) {}

  async embed(text: string): Promise<number[]> {
    const endpoint = this.config.endpoint.replace(/\/+$/, "");
    const deployment = this.config.deployment.trim();
    if (!endpoint || !deployment) {
      throw new Error("AzureOpenAIEmbeddingAdapter requires endpoint and deployment.");
    }

    const apiVersion = this.config.apiVersion?.trim() || "2024-10-21";
    const trimmedAuth = this.config.apiKey.trim();
    const isBearer = trimmedAuth.split(".").length === 3 || /^bearer\s+/i.test(trimmedAuth);
    const authHeaderName = isBearer ? "Authorization" : "api-key";
    const authHeaderValue = isBearer ? `Bearer ${trimmedAuth.replace(/^bearer\s+/i, "").trim()}` : trimmedAuth;

    const response = await fetch(
      `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/embeddings?api-version=${encodeURIComponent(apiVersion)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [authHeaderName]: authHeaderValue
        },
        body: JSON.stringify({
          input: text
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Azure OpenAI Embedding API error: ${response.statusText} - ${await response.text()}`);
    }

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding || [];
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

  async upsert(documents: ConnectorDocument[], embedder: EmbeddingAdapter): Promise<void> {
    const mapped = await Promise.all(
      documents.map(async (document) => ({
        document,
        vector: await embedder.embed(document.text)
      }))
    );
    this.items = mapped;
  }

  async similaritySearch(query: string, topK: number, embedder: EmbeddingAdapter): Promise<ConnectorDocument[]> {
    const queryVector = await embedder.embed(query);
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

export class PineconeVectorStoreAdapter implements VectorStoreAdapter {
  readonly id = "pinecone-vector-store";

  constructor(
    private config: { apiKey: string; indexName: string; environment?: string; namespace?: string }
  ) {}

  async upsert(documents: ConnectorDocument[], embedder: EmbeddingAdapter): Promise<void> {
    // simplified version for REST invocation
    const vectors = await Promise.all(
      documents.map(async (doc) => {
        const values = await embedder.embed(doc.text);
        return {
          id: doc.id,
          values,
          metadata: { text: doc.text, ...doc.metadata }
        };
      })
    );

    const baseUrl = `https://api.pinecone.io/indexes/${this.config.indexName}`; // generic, robust resolution required for prod
    
    // Using v1 data plane REST API 
    // Usually Pinecone requires host from describeIndex, mocking a simplified direct call format
    const response = await fetch(`${baseUrl}/vectors/upsert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": this.config.apiKey
      },
      body: JSON.stringify({
        vectors,
        namespace: this.config.namespace
      })
    });

    if (!response.ok) {
       throw new Error(`Pinecone upsert failed: ${await response.text()}`);
    }
  }

  async similaritySearch(query: string, topK: number, embedder: EmbeddingAdapter): Promise<ConnectorDocument[]> {
    const vector = await embedder.embed(query);
    const baseUrl = `https://api.pinecone.io/indexes/${this.config.indexName}`;
    
    const response = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": this.config.apiKey
      },
      body: JSON.stringify({
        vector,
        topK,
        namespace: this.config.namespace,
        includeMetadata: true
      })
    });

    if (!response.ok) {
      throw new Error(`Pinecone query failed: ${await response.text()}`);
    }

    const json = (await response.json()) as any;
    return json.matches.map((match: any) => ({
      id: match.id,
      text: match.metadata.text,
      metadata: match.metadata,
      source: "pinecone"
    }));
  }
}

export class PGVectorStoreAdapter implements VectorStoreAdapter {
  readonly id = "pgvector-store";

  constructor(
    private config: { connectionString: string; tableName: string; embeddingDimension?: number }
  ) {}

  private async getClient() {
     const client = new pg.Client({ connectionString: this.config.connectionString });
     await client.connect();
     return client;
  }

  async upsert(documents: ConnectorDocument[], embedder: EmbeddingAdapter): Promise<void> {
    const dim = this.config.embeddingDimension || 1536;
    const client = await this.getClient();
    
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.config.tableName} (
          id TEXT PRIMARY KEY,
          content TEXT,
          metadata JSONB,
          embedding vector(${dim})
        )
      `);

      for (const doc of documents) {
        const vector = await embedder.embed(doc.text);
        const vectorString = `[${vector.join(",")}]`;
        await client.query(`
          INSERT INTO ${this.config.tableName} (id, content, metadata, embedding) 
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (id) DO UPDATE SET 
            content = EXCLUDED.content, 
            metadata = EXCLUDED.metadata, 
            embedding = EXCLUDED.embedding
        `, [doc.id, doc.text, JSON.stringify(doc.metadata), vectorString]);
      }
    } finally {
      await client.end();
    }
  }

  async similaritySearch(query: string, topK: number, embedder: EmbeddingAdapter): Promise<ConnectorDocument[]> {
    const vector = await embedder.embed(query);
    const vectorString = `[${vector.join(",")}]`;
    const client = await this.getClient();
    
    try {
      const res = await client.query(`
        SELECT id, content, metadata
        FROM ${this.config.tableName}
        ORDER BY embedding <=> $1
        LIMIT $2
      `, [vectorString, topK]);

      return res.rows.map(row => ({
        id: row.id,
        text: row.content,
        metadata: row.metadata,
        source: "pgvector"
      }));
    } finally {
      await client.end();
    }
  }
}

export class AzureAiSearchVectorStoreAdapter implements VectorStoreAdapter {
  readonly id = "azure-ai-search-vector-store";

  constructor(
    private config: {
      endpoint: string;
      indexName: string;
      apiKey: string;
      apiVersion?: string;
      vectorField?: string;
      contentField?: string;
      idField?: string;
      metadataField?: string;
    }
  ) {}

  private get apiVersion() {
    return this.config.apiVersion?.trim() || "2024-07-01";
  }

  private get baseUrl() {
    return this.config.endpoint.replace(/\/+$/, "");
  }

  private get authHeader() {
    const apiKey = this.config.apiKey.trim();
    const isBearer = apiKey.split(".").length === 3 || /^bearer\s+/i.test(apiKey);
    return isBearer
      ? { name: "Authorization", value: `Bearer ${apiKey.replace(/^bearer\s+/i, "").trim()}` }
      : { name: "api-key", value: apiKey };
  }

  private get fields() {
    return {
      vectorField: this.config.vectorField?.trim() || "embedding",
      contentField: this.config.contentField?.trim() || "content",
      idField: this.config.idField?.trim() || "id",
      metadataField: this.config.metadataField?.trim() || "metadata"
    };
  }

  private buildIndexUrl(pathSuffix: string) {
    return `${this.baseUrl}/indexes/${encodeURIComponent(this.config.indexName)}/${pathSuffix}?api-version=${encodeURIComponent(this.apiVersion)}`;
  }

  async upsert(documents: ConnectorDocument[], embedder: EmbeddingAdapter): Promise<void> {
    if (!this.baseUrl || !this.config.indexName || !this.config.apiKey.trim()) {
      throw new Error("AzureAiSearchVectorStoreAdapter requires endpoint, indexName, and apiKey.");
    }

    const { idField, contentField, metadataField, vectorField } = this.fields;
    const value = await Promise.all(
      documents.map(async (document) => ({
        "@search.action": "mergeOrUpload",
        [idField]: document.id,
        [contentField]: document.text,
        [metadataField]: document.metadata ?? {},
        [vectorField]: await embedder.embed(document.text)
      }))
    );

    const auth = this.authHeader;
    const response = await fetch(this.buildIndexUrl("docs/index"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [auth.name]: auth.value
      },
      body: JSON.stringify({ value })
    });

    if (!response.ok) {
      throw new Error(`Azure AI Search upsert failed: ${await response.text()}`);
    }
  }

  async similaritySearch(query: string, topK: number, embedder: EmbeddingAdapter): Promise<ConnectorDocument[]> {
    if (!this.baseUrl || !this.config.indexName || !this.config.apiKey.trim()) {
      throw new Error("AzureAiSearchVectorStoreAdapter requires endpoint, indexName, and apiKey.");
    }

    const { idField, contentField, metadataField, vectorField } = this.fields;
    const vector = await embedder.embed(query);
    const auth = this.authHeader;

    const response = await fetch(this.buildIndexUrl("docs/search"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [auth.name]: auth.value
      },
      body: JSON.stringify({
        search: query || "*",
        top: topK,
        select: `${idField},${contentField},${metadataField}`,
        vectorQueries: [
          {
            kind: "vector",
            vector,
            fields: vectorField,
            k: topK
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Azure AI Search query failed: ${await response.text()}`);
    }

    const json = (await response.json()) as Record<string, unknown>;
    const value = Array.isArray(json.value) ? (json.value as Array<Record<string, unknown>>) : [];

    return value.map((entry, index) => ({
      id: typeof entry[idField] === "string" ? (entry[idField] as string) : `azure-search-doc-${index + 1}`,
      text: typeof entry[contentField] === "string" ? (entry[contentField] as string) : JSON.stringify(entry),
      metadata: {
        source: "azure-ai-search",
        score: entry["@search.score"],
        ...(entry[metadataField] && typeof entry[metadataField] === "object" && !Array.isArray(entry[metadataField])
          ? (entry[metadataField] as Record<string, unknown>)
          : {})
      }
    }));
  }
}

export class QdrantVectorStoreAdapter implements VectorStoreAdapter {
  readonly id = "qdrant-vector-store";

  constructor(
    private config: {
      endpoint: string;
      collectionName: string;
      apiKey?: string;
      apiKeyHeaderName?: string;
      contentField?: string;
      metadataField?: string;
      filter?: Record<string, unknown>;
    }
  ) {}

  private get baseUrl() {
    return this.config.endpoint.replace(/\/+$/, "");
  }

  private get headers() {
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (this.config.apiKey?.trim()) {
      headers[this.config.apiKeyHeaderName?.trim() || "api-key"] = this.config.apiKey.trim();
    }
    return headers;
  }

  private get fields() {
    return {
      contentField: this.config.contentField?.trim() || "content",
      metadataField: this.config.metadataField?.trim() || "metadata"
    };
  }

  private collectionPath(pathSuffix: string) {
    return `${this.baseUrl}/collections/${encodeURIComponent(this.config.collectionName)}${pathSuffix}`;
  }

  async upsert(documents: ConnectorDocument[], embedder: EmbeddingAdapter): Promise<void> {
    if (!this.baseUrl || !this.config.collectionName.trim()) {
      throw new Error("QdrantVectorStoreAdapter requires endpoint and collectionName.");
    }

    const { contentField, metadataField } = this.fields;
    const points = await Promise.all(
      documents.map(async (document) => ({
        id: document.id,
        vector: await embedder.embed(document.text),
        payload: {
          [contentField]: document.text,
          [metadataField]: document.metadata ?? {}
        }
      }))
    );

    const response = await fetch(this.collectionPath("/points?wait=true"), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ points })
    });

    if (!response.ok) {
      throw new Error(`Qdrant upsert failed: ${await response.text()}`);
    }
  }

  async similaritySearch(query: string, topK: number, embedder: EmbeddingAdapter): Promise<ConnectorDocument[]> {
    if (!this.baseUrl || !this.config.collectionName.trim()) {
      throw new Error("QdrantVectorStoreAdapter requires endpoint and collectionName.");
    }

    const { contentField, metadataField } = this.fields;
    const vector = await embedder.embed(query);
    const response = await fetch(this.collectionPath("/points/search"), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        vector,
        limit: topK,
        with_payload: true,
        with_vector: false,
        ...(this.config.filter ? { filter: this.config.filter } : {})
      })
    });

    if (!response.ok) {
      throw new Error(`Qdrant search failed: ${await response.text()}`);
    }

    const json = (await response.json()) as Record<string, unknown>;
    const result = Array.isArray(json.result) ? (json.result as Array<Record<string, unknown>>) : [];
    return result.map((entry, index) => {
      const payload = asRecord(entry.payload);
      const metadata = asRecord(payload[metadataField]);
      const textCandidate = payload[contentField];
      const text =
        typeof textCandidate === "string" && textCandidate.trim()
          ? textCandidate
          : JSON.stringify(payload);
      return {
        id: typeof entry.id === "string" ? entry.id : `qdrant-doc-${index + 1}`,
        text,
        metadata: {
          ...metadata,
          source: "qdrant",
          score: entry.score
        }
      };
    });
  }
}

export class CohereEmbeddingAdapter implements EmbeddingAdapter {
  readonly id = "cohere-embedder";
  constructor(private config: { apiKey: string; model?: string }) {}
  async embed(text: string): Promise<number[]> {
    const model = this.config.model || "embed-english-v3.0";
    const res = await fetch("https://api.cohere.ai/v1/embed", {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ texts: [text], model, input_type: "search_document", truncate: "END" })
    });
    if (!res.ok) throw new Error(`Cohere embedding failed (${res.status})`);
    const json = await res.json() as { embeddings?: number[][] };
    return json.embeddings?.[0] ?? [];
  }
}

export class MistralEmbeddingAdapter implements EmbeddingAdapter {
  readonly id = "mistral-embedder";
  constructor(private config: { apiKey: string; model?: string }) {}
  async embed(text: string): Promise<number[]> {
    const model = this.config.model || "mistral-embed";
    const res = await fetch("https://api.mistral.ai/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: [text] })
    });
    if (!res.ok) throw new Error(`Mistral embedding failed (${res.status})`);
    const json = await res.json() as { data?: Array<{ embedding: number[] }> };
    return json.data?.[0]?.embedding ?? [];
  }
}

export class GoogleVertexEmbeddingAdapter implements EmbeddingAdapter {
  readonly id = "google-vertex-embedder";
  constructor(private config: { apiKey: string; model?: string }) {}
  async embed(text: string): Promise<number[]> {
    const model = this.config.model || "text-embedding-004";
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${this.config.apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `models/${model}`, content: { parts: [{ text }] } })
    });
    if (!res.ok) throw new Error(`Google embedding failed (${res.status})`);
    const json = await res.json() as { embedding?: { values: number[] } };
    return json.embedding?.values ?? [];
  }
}

export class HuggingFaceEmbeddingAdapter implements EmbeddingAdapter {
  readonly id = "huggingface-embedder";
  constructor(private config: { apiKey: string; model?: string }) {}
  async embed(text: string): Promise<number[]> {
    const model = this.config.model || "sentence-transformers/all-MiniLM-L6-v2";
    const res = await fetch(`https://api-inference.huggingface.co/pipeline/feature-extraction/${model}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ inputs: text, options: { wait_for_model: true } })
    });
    if (!res.ok) throw new Error(`HuggingFace embedding failed (${res.status})`);
    const json = await res.json() as number[] | number[][];
    return Array.isArray(json[0]) ? (json as number[][])[0] : json as number[];
  }
}

export class ChromaVectorStoreAdapter implements VectorStoreAdapter {
  readonly id = "chroma-vector-store";
  constructor(private config: { endpoint: string; collectionName: string; apiKey?: string }) {}

  async upsert(documents: ConnectorDocument[], embedder: EmbeddingAdapter): Promise<void> {
    const ids: string[] = [];
    const embeddings: number[][] = [];
    const docs: string[] = [];
    const metadatas: Array<Record<string, unknown>> = [];
    for (const doc of documents) {
      ids.push(doc.id);
      embeddings.push(await embedder.embed(doc.text));
      docs.push(doc.text);
      metadatas.push(doc.metadata ?? {});
    }
    const endpoint = this.config.endpoint.replace(/\/+$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    await fetch(`${endpoint}/api/v1/collections/${this.config.collectionName}/upsert`, {
      method: "POST", headers,
      body: JSON.stringify({ ids, embeddings, documents: docs, metadatas })
    });
  }

  async similaritySearch(query: string, topK: number, embedder: EmbeddingAdapter): Promise<ConnectorDocument[]> {
    const queryEmbedding = await embedder.embed(query);
    const endpoint = this.config.endpoint.replace(/\/+$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    const res = await fetch(`${endpoint}/api/v1/collections/${this.config.collectionName}/query`, {
      method: "POST", headers,
      body: JSON.stringify({ query_embeddings: [queryEmbedding], n_results: topK })
    });
    if (!res.ok) return [];
    const json = await res.json() as { ids?: string[][]; documents?: string[][]; metadatas?: Array<Array<Record<string, unknown>>> };
    const ids = json.ids?.[0] ?? [];
    const texts = json.documents?.[0] ?? [];
    const metas = json.metadatas?.[0] ?? [];
    return ids.map((id, i) => ({ id, text: texts[i] ?? "", metadata: metas[i] ?? {} }));
  }
}

export class WeaviateVectorStoreAdapter implements VectorStoreAdapter {
  readonly id = "weaviate-vector-store";
  constructor(private config: { endpoint: string; className: string; apiKey?: string }) {}

  async upsert(documents: ConnectorDocument[], embedder: EmbeddingAdapter): Promise<void> {
    const endpoint = this.config.endpoint.replace(/\/+$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    for (const doc of documents) {
      const vector = await embedder.embed(doc.text);
      await fetch(`${endpoint}/v1/objects`, {
        method: "POST", headers,
        body: JSON.stringify({ class: this.config.className, id: doc.id, properties: { content: doc.text, metadata: JSON.stringify(doc.metadata ?? {}) }, vector })
      });
    }
  }

  async similaritySearch(query: string, topK: number, embedder: EmbeddingAdapter): Promise<ConnectorDocument[]> {
    const queryVector = await embedder.embed(query);
    const endpoint = this.config.endpoint.replace(/\/+$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    const graphql = { query: `{ Get { ${this.config.className}(limit: ${topK}, nearVector: { vector: [${queryVector.join(",")}] }) { content metadata _additional { id distance } } } }` };
    const res = await fetch(`${endpoint}/v1/graphql`, { method: "POST", headers, body: JSON.stringify(graphql) });
    if (!res.ok) return [];
    const json = await res.json() as { data?: { Get?: Record<string, Array<{ content: string; metadata?: string; _additional?: { id: string } }>> } };
    const results = json.data?.Get?.[this.config.className] ?? [];
    return results.map((r, i) => ({ id: r._additional?.id ?? `result-${i}`, text: r.content ?? "", metadata: r.metadata ? JSON.parse(r.metadata) : {} }));
  }
}

export class RedisVectorStoreAdapter implements VectorStoreAdapter {
  readonly id = "redis-vector-store";
  constructor(private config: { endpoint: string; indexName: string; apiKey?: string }) {}

  async upsert(documents: ConnectorDocument[], embedder: EmbeddingAdapter): Promise<void> {
    // Redis vector store uses the Redis Stack JSON + Search API via HTTP
    const endpoint = this.config.endpoint.replace(/\/+$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    for (const doc of documents) {
      const vector = await embedder.embed(doc.text);
      await fetch(`${endpoint}/JSON.SET/${this.config.indexName}:${doc.id}/$`, {
        method: "POST", headers,
        body: JSON.stringify({ content: doc.text, metadata: doc.metadata ?? {}, embedding: vector })
      });
    }
  }

  async similaritySearch(query: string, topK: number, embedder: EmbeddingAdapter): Promise<ConnectorDocument[]> {
    const queryVector = await embedder.embed(query);
    const endpoint = this.config.endpoint.replace(/\/+$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    const vectorStr = queryVector.map(v => v.toFixed(6)).join(",");
    const res = await fetch(`${endpoint}/FT.SEARCH/${this.config.indexName}/*=>[KNN ${topK} @embedding $vec AS score]/PARAMS/2/vec/${vectorStr}/SORTBY/score/LIMIT/0/${topK}`, {
      method: "POST", headers
    });
    if (!res.ok) return [];
    const json = await res.json() as { results?: Array<{ id: string; extra_attributes?: { content?: string; metadata?: string } }> };
    return (json.results ?? []).map(r => ({ id: r.id, text: r.extra_attributes?.content ?? "", metadata: r.extra_attributes?.metadata ? JSON.parse(r.extra_attributes.metadata) : {} }));
  }
}

export class InMemoryRetrieverAdapter implements RetrieverAdapter {
  readonly id = "in-memory-retriever";

  async retrieve(query: string, documents: ConnectorDocument[], topK: number): Promise<ConnectorDocument[]> {
    const embedder = new TokenEmbeddingAdapter();
    const store = new InMemoryVectorStoreAdapter();
    await store.upsert(documents, embedder);
    return store.similaritySearch(query, topK, embedder);
  }
}

export class EmbeddingRegistry {
  private adapters = new Map<string, EmbeddingAdapter>();

  register(adapter: EmbeddingAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): EmbeddingAdapter | undefined {
    return this.adapters.get(id);
  }
}

export class VectorStoreRegistry {
  private adapters = new Map<string, VectorStoreAdapter>();

  register(adapter: VectorStoreAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): VectorStoreAdapter | undefined {
    return this.adapters.get(id);
  }
}
