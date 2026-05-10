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

POST   /api/knowledge-bases/:id/upload            Load -> chunk -> embed -> ingest in one call (builder, Phase 9.2)
POST   /api/knowledge-bases/:id/ingest            Ingest documents or pre-embedded chunks (builder)
GET    /api/knowledge-bases/:id/chunks            Preview chunks (builder)
POST   /api/knowledge-bases/:id/search            Standalone similarity search (builder)
DELETE /api/knowledge-bases/:id/sources/:sourceId Drop all chunks from one source (admin)
```

The Studio UI under **KB** in the left sidebar drives all of the above through forms — no curl needed.

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

## Uploading a document (Phase 9.2)

`POST /api/knowledge-bases/:id/upload` is a one-shot pipeline that loads → chunks → embeds → ingests. Ideal for "I have a markdown file, get it into the KB":

```bash
curl -X POST http://localhost:4000/api/knowledge-bases/<id>/upload \
  -H "content-type: application/json" \
  --cookie "ao_session=..." \
  -d '{
    "filename": "support-faq.md",
    "content": "# FAQ\n\n## Reset password\n...",
    "sourceId": "support-faq-v1",
    "chunking": { "strategy": "recursive", "chunkSize": 800, "chunkOverlap": 80 }
  }'
```

Response:

```json
{ "sourceId": "support-faq-v1", "documentsLoaded": 1, "chunksInserted": 4, "dimensions": 64 }
```

Loaders ship for:

- **Plain text** / **Markdown** — passed through as-is
- **HTML** — `<script>` / `<style>` / `<head>` blocks dropped, tags stripped, entities decoded. The `<title>` becomes `metadata.title`.
- **CSV** — RFC-4180-ish parser; either pick a `csv.textColumn` (other columns become metadata) or omit it to flatten every column into `key: value` lines per row
- **JSON** / **NDJSON** — array elements become docs; objects with `{ text, metadata }` are honored verbatim

`kind` is auto-inferred from the filename extension; pass an explicit `kind` to override. PDF and DOCX are intentionally deferred (each needs a binary parser); use `POST /ingest` with externally pre-extracted text in the meantime.

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

## Hybrid search (Phase 9.3)

Built-in KBs index every chunk in a SQLite FTS5 table at insert time, so BM25 lexical search and dense vector search both target the same content. The `rag_retrieve` node accepts `searchMode`:

- `vector` (default) — cosine over dense embeddings only. Catches paraphrases and semantic similarity.
- `bm25` — full-text search only. Catches exact-keyword matches, rare terms, identifiers, error codes.
- `hybrid` — fuses both via Reciprocal Rank Fusion (RRF). Industry-standard combiner — each ranker contributes `1 / (k + rank)` per doc; the sum across rankers is the final score. Great for catching both kinds of matches in one query.

```json
{
  "type": "rag_retrieve",
  "config": {
    "queryTemplate": "{{user_prompt}}",
    "topK": 5,
    "embedderId": "openai-embedder",
    "vectorStoreId": "knowledge-base",
    "vectorStoreConfig": { "knowledgeBaseId": "kb_..." },
    "searchMode": "hybrid",
    "candidatesPerRanker": 50,
    "bm25Weight": 1.0,
    "vectorWeight": 1.0,
    "rrfK": 60
  }
}
```

Tunables:

- `candidatesPerRanker` — how many docs each ranker emits before fusion. Defaults to `max(20, 4 * topK)`.
- `bm25Weight` / `vectorWeight` — per-ranker weighting in the fusion. Defaults to 1.0 each.
- `rrfK` — RRF constant. Default 60 (Cormack et al. 2009). Higher k flattens the curve; lower k makes top-1 of each ranker dominate.

Result metadata identifies the retrieval mode and ranker provenance:

```json
{
  "id": "kbc_...",
  "text": "...",
  "metadata": {
    "knowledgeBaseId": "kb_...",
    "chunkId": "kbc_...",
    "sourceId": "support-faq-v1",
    "retrieval": {
      "mode": "hybrid",
      "rrfScore": 0.0319,
      "rankers": ["vector", "bm25"]
    }
  }
}
```

Hybrid + BM25 are KB-only today. External adapters (Pinecone, Qdrant, etc.) silently fall back to vector-only when `searchMode != "vector"` since they don't expose a unified BM25 interface; per-store hybrid wiring is a follow-up.

## Reranker node (Phase 9.3)

The `rerank` node sits after a retrieval step and reorders candidates via a hosted cross-encoder. Cross-encoders score each (query, doc) pair end-to-end — much higher precision than independent embeddings, but slower and per-call billed.

Three providers wired today:

- `cohere` — Cohere Rerank v3 (`rerank-english-v3.0` default)
- `jina` — Jina Reranker v2 (`jina-reranker-v2-base-multilingual` default)
- `voyage` — Voyage rerank-2 (`rerank-2` default)

```json
{
  "type": "rerank",
  "config": {
    "queryTemplate": "{{user_prompt}}",
    "topN": 3,
    "providerId": "cohere",
    "secretRef": { "secretId": "sec_..." }
  }
}
```

Wire `rag_retrieve` (with `topK: 20-50`) → `rerank` (with `topN: 3-5`) for the canonical "high recall, then high precision" pattern. Sample at [samples/workflows/rag-hybrid-rerank-flow.json](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/rag-hybrid-rerank-flow.json).

API keys can come from a `secretRef.secretId` (preferred — encrypted at rest) or the matching env var (`COHERE_API_KEY`, `JINA_API_KEY`, `VOYAGE_API_KEY`).

## Citations (Phase 9.4)

Every chunk that comes out of `rag_retrieve` / `hybrid_search` / `rerank` carries stable provenance — `chunkId`, `sourceId`, `knowledgeBaseId`, `similarityScore`, `retrieval.mode`. Phase 9.4 turns that into clickable footnotes in the chat UI via two pieces:

### `citationInstructions` on `rag_retrieve` output

`rag_retrieve` (and `rerank`) now emit a `citationInstructions` string alongside `context`. Drop it into your prompt template to teach the model to mark its claims with `[N]` brackets that match the bracketed context numbers `rag_retrieve` already emits:

```
Answer using only the context below.

{{citationInstructions}}

Context:
{{context}}

Question:
{{user_prompt}}
```

The default instruction is intentionally short to preserve prompt budget; the same wiring is exposed via `DEFAULT_CITATION_INSTRUCTIONS` from `@ai-orchestrator/workflow-engine` if you want to override.

### `extract_citations` node

Wire after `llm_call` to resolve `[N]` (or `[chunkId]`) markers back to the upstream documents:

```json
{
  "type": "extract_citations",
  "config": {
    "answerPath": "answer",
    "documentsPath": "documents"
  }
}
```

Output:

```json
{
  "answer": "...",
  "citations": [
    {
      "marker": "[1]",
      "index": 1,
      "chunkId": "kbc_...",
      "sourceId": "support-faq-v1",
      "text": "Reset your password using the recovery email link.",
      "similarityScore": 0.81,
      "retrievalMode": "hybrid",
      "startIndex": 38,
      "endIndex": 41
    }
  ],
  "uniqueCitedDocuments": 1,
  "hasCitations": true
}
```

`startIndex` / `endIndex` are character offsets into the answer string — the chat UI uses them to splice in `<sup>[1]</sup>` links without disturbing the original text. The answer is preserved verbatim.

### Chat UI rendering

When a workflow run produces `extract_citations` output, the chat bubble renders each `[N]` as a clickable superscript that scrolls to a footnote panel below the bubble (with source ID, retrieval mode, score, and the chunk preview). Click on `[1]` to jump to the corresponding source.

The full sample is at [samples/workflows/rag-with-citations-flow.json](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/rag-with-citations-flow.json).

### Wiring the graph

`extract_citations` needs both the LLM answer **and** the documents. Wire two incoming edges:

- `llm_call` → `extract_citations` (carries `answer`)
- `rag_retrieve` → `extract_citations` (carries `documents`)

The Phase 9.5 `faithfulness` and `context_*` scorers compose naturally with this — same `documents` + `answer` shape, same `extract_citations` node makes citations visible in chat, then evals score against the same retrieval.

## RAG-specific eval scorers (Phase 9.5)

The eval framework (Settings → Evals) supports four scorer types that are RAG-aware. Programmatic ones cost nothing per fixture; LLM-judge ones cost one provider call per fixture.

| Scorer | Kind | What it measures |
|---|---|---|
| `context_precision` | programmatic | Of retrieved chunks, what fraction overlap meaningfully with the expected answer. High when the retriever returns mostly-relevant chunks. |
| `context_recall` | programmatic | Of expected-answer tokens, what fraction appear somewhere in the retrieved context. High when retrieval *covers* the answer. |
| `faithfulness` | LLM judge | Of factual claims in the generated answer, what fraction are supported by the retrieved context. Catches hallucinations. |
| `answer_relevance` | LLM judge | Does the answer actually address the question? Catches off-topic or evasive responses. |

All four return a numeric `score` in `[0, 1]` plus `pass = score >= threshold`. Defaults: `0.5` for context scorers, `0.7` for faithfulness, `0.6` for answer_relevance. Per-scorer overrides via `threshold`, `contextPath`, `answerPath`, `questionPath`, `providerId`, `model`.

### Wiring

Programmatic scorers work out of the box. LLM-judge scorers require:

```bash
EVAL_JUDGE_ENABLED=true
EVAL_JUDGE_PROVIDER_ID=openai            # any registered provider
EVAL_JUDGE_MODEL=gpt-4o-mini             # cheap default
EVAL_JUDGE_TEMPERATURE=0
EVAL_JUDGE_MAX_TOKENS=512
```

The judge uses the standard provider-config + secret-resolution path — same OPENAI_API_KEY (or secretRef) that drives normal LLM calls.

### Workflow output shape

The scorers expect a workflow output like:

```json
{
  "documents": [{ "text": "...", "metadata": { "sourceId": "..." } }],
  "answer": "the LLM-generated answer string"
}
```

The default `contextPath` is `documents` (the shape `rag_retrieve` and `rerank` emit) and the default `answerPath` is `answer` (set this on your output node's `outputKey`). When the workflow returns a different shape, point the scorer at it via the per-scorer paths.

### Defaults vs production tuning

The shipped programmatic scorers use bag-of-tokens overlap with stopword filtering — fast, deterministic, free. Quality is good enough for regression smoke tests but trails embedding-similarity scorers from frameworks like Ragas. For research-grade RAG eval, run faithfulness + answer_relevance against `gpt-4o` (not `mini`) and treat the programmatic scorers as guardrails on retrieval changes.

## Tradeoffs

- **Algorithm**: cosine similarity, computed in JavaScript. Fine up to ~10k chunks per KB. Larger fleets should use pgvector / Qdrant / Azure AI Search — `rag_retrieve` accepts those vector-store IDs unchanged.
- **Storage**: vectors are stored as JSON arrays in SQLite. ~6 bytes/dimension on disk. For a 1536-d OpenAI model, that's ~10 KB per chunk.
- **Concurrency**: writes serialize through the SqliteStore. Read-heavy workloads are unaffected.
- **No HNSW**: every query reads every vector for the KB. `sqlite-vec` is the obvious follow-up if linear scan becomes a bottleneck.
- **BM25 (FTS5)**: indexed automatically on insert via SQL triggers. Re-indexing on bulk imports is free. Tokenizer is `porter unicode61` — handles English stemming and unicode word breaks; adjust the migration if you need a language-specific tokenizer.
