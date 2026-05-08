# Knowledge Bases (built-in persistent vector store)

Phase 9.1 ships a SQLite-backed vector store with no external dependencies. Create a knowledge base, ingest documents (programmatically or via the upcoming Studio UI), and target it from a `rag_retrieve` node — chunks survive across workflow runs.

For larger corpora (~10k+ chunks per KB) move to pgvector or Qdrant; the same `rag_retrieve` node accepts those vector store IDs unchanged. The built-in KB is designed for the "install and have working RAG in five minutes" path, not as a global production-scale store.

## Lifecycle

```
POST   /api/knowledge-bases                       Create a KB (admin)
GET    /api/knowledge-bases                       List KBs (builder)
GET    /api/knowledge-bases/:id                   Read a KB + its sources (builder)
PUT    /api/knowledge-bases/:id                   Update name / config (admin)
DELETE /api/knowledge-bases/:id                   Delete a KB and all its chunks (admin)

POST   /api/knowledge-bases/:id/ingest            Ingest documents or pre-embedded chunks (builder)
GET    /api/knowledge-bases/:id/chunks            Preview chunks (builder)
POST   /api/knowledge-bases/:id/search            Standalone similarity search (builder)
DELETE /api/knowledge-bases/:id/sources/:sourceId Drop all chunks from one source (admin)
```

## Creating a KB

```bash
curl -X POST http://localhost:4000/api/knowledge-bases \
  -H "content-type: application/json" \
  --cookie "ao_session=..." \
  -d '{
    "name": "Helpdesk corpus",
    "description": "Q1 support transcripts",
    "embedderId": "token-embedder",
    "embedderConfig": {}
  }'
```

`embedderId` is one of:

- `token-embedder` — zero-deps hash-based 64-d embedder. Demo only — quality is poor.
- `openai-embedder`, `azure-openai-embedder`, `cohere-embedder`, `mistral-embedder`, `google-vertex-embedder`, `huggingface-embedder` — real embedders. Pass credentials via `embedderConfig.secretRef.secretId` (preferred) or the matching `*_API_KEY` env var.

`embedderConfig` is the same shape that `rag_retrieve.vectorStoreConfig` uses (`baseUrl`, `model`, `endpoint`, `deployment`, `apiVersion`, `secretRef`). Whatever you set here is what the API uses on `/ingest` and `/search`; on a workflow run you must pass the matching `embedderId` on the `rag_retrieve` node so the query vector lives in the same space as the indexed chunks.

The KB's `dimensions` are locked the first time you ingest a chunk. Subsequent ingests must produce vectors of the same length or the request is rejected with HTTP 400.

## Ingesting documents

Two payload shapes:

### Plain documents — server embeds for you

```json
{
  "sourceId": "support-faq-v1",
  "documents": [
    { "content": "To reset your password, ...", "metadata": { "topic": "auth" } },
    { "content": "We accept Visa, Mastercard, ...", "metadata": { "topic": "billing" } }
  ]
}
```

The server runs the KB's configured embedder on each `content` and writes the resulting vectors. `sourceId` groups chunks so you can drop them later (`DELETE /knowledge-bases/:id/sources/:sourceId`); if you omit it, a generated id is returned in the response.

### Pre-embedded chunks — bring your own vectors

```json
{
  "chunks": [
    {
      "sourceId": "doc-42",
      "chunkIndex": 0,
      "content": "...",
      "metadata": { "page": 1 },
      "vector": [0.123, -0.456, ...]
    }
  ]
}
```

Use this when you've already embedded externally (notebook, batch job) — the server skips the embedding step and writes directly.

## Querying from a workflow

Configure a `rag_retrieve` node with `vectorStoreId: "knowledge-base"` and pass the KB id under `vectorStoreConfig.knowledgeBaseId`:

```json
{
  "type": "rag_retrieve",
  "config": {
    "queryTemplate": "{{user_prompt}}",
    "topK": 3,
    "embedderId": "openai-embedder",
    "vectorStoreId": "knowledge-base",
    "vectorStoreConfig": {
      "knowledgeBaseId": "kb_..."
    }
  }
}
```

The full sample is at [samples/workflows/rag-knowledge-base-flow.json](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/rag-knowledge-base-flow.json).

Each retrieved document carries provenance metadata:

- `knowledgeBaseId`
- `chunkId` — stable ID for the chunk row
- `chunkIndex`
- `sourceId`
- `similarityScore` — cosine similarity, 0–1, rounded to 3 decimals

Use these in downstream prompt templates to ask the LLM for source-cited answers (Phase 9.4 will make citations first-class).

## Standalone search

For testing without wrapping in a workflow:

```bash
curl -X POST http://localhost:4000/api/knowledge-bases/:id/search \
  -H "content-type: application/json" \
  --cookie "ao_session=..." \
  -d '{ "query": "how do I change my password", "topK": 5 }'
```

Returns the top-K chunks with the same provenance metadata as the workflow path.

## Tradeoffs

- **Algorithm**: cosine similarity, computed in JavaScript. Fine up to ~10k chunks per KB. Larger fleets should use pgvector / Qdrant / Azure AI Search — `rag_retrieve` accepts those vector-store IDs unchanged.
- **Storage**: vectors are stored as JSON arrays in SQLite. ~6 bytes/dimension on disk. For a 1536-d OpenAI model, that's ~10 KB per chunk.
- **Concurrency**: writes serialize through the SqliteStore. Read-heavy workloads are unaffected.
- **No HNSW**: every query reads every vector for the KB. `sqlite-vec` is the obvious follow-up if linear scan becomes a bottleneck.
