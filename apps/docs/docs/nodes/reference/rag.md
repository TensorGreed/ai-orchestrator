<!--
  Generated from packages/shared/src/definitions.ts.
  DO NOT EDIT BY HAND — run `pnpm --filter @ai-orchestrator/docs gen:nodes`
  (or `pnpm docs:build`) to regenerate.
-->

# RAG nodes

Retrieval-Augmented Generation: embedders, vector stores, document loaders, retrievers.

3 nodes.

---
### `document_chunker` — Document Chunker

Splits documents into smaller chunks for embeddings.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `chunkSize` | `number` | no | — |
| `chunkOverlap` | `number` | no | — |
| `separator` | `string` | no | — |
| `strategy` | `string` | no | `separator` \| `character` \| `recursive` \| `token` |

**Example config**

```json
{
  "chunkSize": 500,
  "chunkOverlap": 50,
  "separator": "\\n\\n",
  "strategy": "separator"
}
```

---

### `embeddings_azure_openai` — Embeddings Azure OpenAI

Generates embedding vectors using Azure OpenAI embedding deployments.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `endpoint` | `string` | yes | — |
| `deployment` | `string` | yes | — |
| `apiVersion` | `string` | no | — |
| `secretRef` | `object` | yes | — |
| `inputKey` | `string` | no | — |
| `outputKey` | `string` | no | — |

**Example config**

```json
{
  "endpoint": "https://my-azure-openai.openai.azure.com",
  "deployment": "text-embedding-3-large",
  "apiVersion": "2024-10-21",
  "inputKey": "user_prompt",
  "outputKey": "embedding"
}
```

---

### `rag_retrieve` — RAG Retrieve

Retrieves context chunks from provided documents or vector store.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `queryTemplate` | `string` | no | — |
| `topK` | `number` | no | — |
| `documents` | `array<string>` | no | — |
| `embedderId` | `string` | no | — |
| `vectorStoreId` | `string` | no | `in-memory-vector-store` \| `knowledge-base` \| `pinecone-vector-store` \| `pgvector-store` \| `azure-ai-search-vector-store` \| `qdrant-vector-store` \| `chroma-vector-store` \| `weaviate-vector-store` \| `redis-vector-store` |
| `knowledgeBaseId` | `string` | no | — |
| `vectorStoreConfig` | `object` | no | — |
| `embeddingSecretRef` | `object` | no | — |

**Example config**

```json
{
  "queryTemplate": "{{user_prompt}}",
  "topK": 3,
  "embedderId": "token-embedder",
  "vectorStoreId": "in-memory-vector-store"
}
```
