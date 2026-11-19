---
title: "Knowledge bases: built-in vector store for RAG"
description: "Built-in L2M knowledge bases: a SQLite-backed vector store with no external dependencies. Create one, ingest documents and query it from RAG Retrieve."
---

# Knowledge Bases (built-in persistent vector store)

Phase 9.1 ships a SQLite-backed vector store with no external dependencies. Create a knowledge base, ingest documents (on the **Knowledge** page or with the API), and target it from a `rag_retrieve` node — chunks survive across workflow runs.

Concepts: <Term id="rag">retrieval-augmented generation</Term>, <Term id="vector-store">vector store</Term>, <Term id="hybrid-search">hybrid search</Term>. The [RAG knowledge base recipe](/recipes/rag-knowledge-base) builds one that runs with no API key.

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

The Studio UI under **Knowledge** in the left sidebar drives all of the above through forms — no curl needed.

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

- `token-embedder` — built in, needs no key, and nothing leaves the server. Its 64-d vectors are a hash of the words,
  so on their own they rank poorly; searches with it therefore run [hybrid](#hybrid-search-phase-9-3) by default
  (keywords and vectors, fused), which finds the passages that share the question's words. For search by meaning, use
  one of the model embedders below.
- `openai-embedder`, `azure-openai-embedder`, `cohere-embedder`, `mistral-embedder`, `google-vertex-embedder`, `huggingface-embedder` — real embedders. Pass credentials via `embedderConfig.secretRef.secretId` (preferred) or the matching `*_API_KEY` env var.

Without a key, use the `token-embedder`: L2M ships no model weights and has no local model embedder. `pnpm install`
reports `Ignored build scripts: ... onnxruntime-node`: that package belongs to the optional
[names and addresses service](../operations/entity-service.md), not to knowledge bases. Its install script only
downloads GPU libraries, and the CPU build it uses is already in the package, so the warning is safe to ignore.

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
{ "sourceId": "support-faq-v1", "documentsLoaded": 1, "chunksInserted": 4, "dimensions": 64, "kind": "markdown" }
```

Loaders ship for:

- **Plain text** / **Markdown** — passed through as-is
- **HTML** — `<script>` / `<style>` / `<head>` blocks dropped, tags stripped, entities decoded. The `<title>` becomes `metadata.title`.
- **CSV** — RFC-4180-ish parser; either pick a `csv.textColumn` (other columns become metadata) or omit it to flatten every column into `key: value` lines per row
- **JSON** / **NDJSON** — array elements become docs; objects with `{ text, metadata }` are honored verbatim

- **PDF** — sent as the file's bytes in `contentBase64` (below). The text of each page is read and every chunk keeps
  its page in `metadata.page` (1-based), with `metadata.pageCount`.

`kind` is auto-inferred from the filename extension; pass an explicit `kind` to override.

### PDFs and other files

Send a PDF as its bytes, base64-encoded, in `contentBase64` instead of `content`. The Knowledge page does this when you
pick a `.pdf` file.

```bash
curl -X POST http://localhost:4000/api/knowledge-bases/<id>/upload \
  -H "content-type: application/json" \
  --cookie "ao_session=..." \
  -d "{\"filename\": \"loyalty.pdf\", \"contentBase64\": \"$(base64 -w0 loyalty.pdf)\"}"
```

```json
{ "sourceId": "loyalty.pdf", "documentsLoaded": 2, "chunksInserted": 2, "dimensions": 64, "kind": "pdf", "pageCount": 2 }
```

- The bytes decide what the file is, not its name. A PDF is read in the same sandboxed reader that content rule
  document scans and Extract from File use, under the same limits (`CONTENT_SCAN_MAX_BYTES`,
  `CONTENT_SCAN_MAX_PAGES`, `CONTENT_SCAN_MAX_CHARS`, `CONTENT_SCAN_PDF_TIMEOUT_MS`). Comments, form fields and
  attachments are not added.
- **Scanned PDFs** (pictures of pages) have no text, and there is no text recognition (OCR): such a PDF is refused
  with `400` and code `pdf_no_text`. Pages without text in an otherwise readable PDF are skipped, and the answer's
  `notice` says how many.
- A password-protected PDF (`pdf_password`) or a damaged one (`pdf_unreadable`) is refused, and so is one that takes
  longer than `CONTENT_SCAN_PDF_TIMEOUT_MS` to read (`422`, `pdf_timeout`).
- Text files sent as bytes may be UTF-8, UTF-16 (with a byte order mark) or Latin-1 / Windows-1252.
- **Word, Excel, PowerPoint** and other office files cannot be read yet (`office_file`): save them as a PDF with
  selectable text, or as plain text. Images and other binary files are refused too (`not_text`).
- A PDF sent as text in `content` is refused (`pdf_as_text`): reading a PDF as text loses its contents.

Nothing is stored when an upload is refused; the answer is `{ "error": "...", "code": "..." }`.

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

In the editor, set **Vector Store** to **Knowledge Base (built in)** and pick the knowledge base under **Knowledge Base**: the list shows the knowledge bases of the workflow's project, and picking one also sets the node's **Embedder** to the one the knowledge base was built with. The editor saves the id as `knowledgeBaseId` on the node; a `vectorStoreConfig.knowledgeBaseId` takes precedence when both are set. **Search Mode** and the hybrid settings below show there too (the hybrid ones under **More**).

The full sample is at [samples/workflows/rag-knowledge-base-flow.json](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/rag-knowledge-base-flow.json).

Each retrieved document carries provenance metadata:

- `knowledgeBaseId`
- `chunkId` — stable ID for the chunk row
- `chunkIndex`
- `sourceId`
- `page` and `pageCount` — for chunks of an uploaded PDF
- `similarityScore` — cosine similarity, 0–1, rounded to 3 decimals

Use these in downstream prompt templates to ask the LLM for source-cited answers (Phase 9.4 will make citations first-class).

Chunks that a sensitive run adds through a workflow are marked `sensitive` (chunks added through the API are not), and a
run that retrieves a marked chunk keeps its content out of OpenTelemetry content capture. See
[Content copied from sensitive runs](../operations/opentelemetry.md#content-copied-from-sensitive-runs).

## Standalone search

For testing without wrapping in a workflow:

```bash
curl -X POST http://localhost:4000/api/knowledge-bases/:id/search \
  -H "content-type: application/json" \
  --cookie "ao_session=..." \
  -d '{ "query": "how do I change my password", "topK": 5 }'
```

Returns the top-K chunks with the same provenance metadata as the workflow path, and `mode`: `hybrid` for a knowledge
base built with the `token-embedder`, `vector` otherwise.

## Hybrid search (Phase 9.3)

Built-in KBs index every chunk for keyword search at insert time, so keyword search and dense vector search both target the same content. On SQLite the index is an FTS5 table ranked with BM25; on Postgres it is a `tsvector` column (`to_tsvector('english', content)`, GIN-indexed) ranked with `ts_rank_cd`. The mode is called `bm25` on both. The `rag_retrieve` node accepts `searchMode`:

- `vector` — cosine over dense embeddings only. Catches paraphrases and semantic similarity. The default with every
  model embedder.
- `bm25` — keyword search only. Catches exact-keyword matches, rare terms, identifiers, error codes.
- `hybrid` — fuses both via Reciprocal Rank Fusion (RRF). Industry-standard combiner — each ranker contributes `1 / (k + rank)` per doc; the sum across rankers is the final score. Great for catching both kinds of matches in one query.
  The default with the built-in `token-embedder` (and when no embedder is set): its vectors alone rank poorly. The
  editor says so under **Search Mode**; pick **Vector** to keep vector-only search. The editor saves the mode you
  pick. Before this release it saved **Vector** as no mode, so such a node now runs hybrid: pick Vector again.

The Knowledge page's test search (`POST /api/knowledge-bases/:id/search`) ranks the same way a node with no
`searchMode` does, and its answer says which: `"mode": "hybrid"` or `"mode": "vector"`.

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
EVAL_JUDGE_ALLOW_ENV_CREDENTIALS=true    # faithfulness / answer_relevance take no secretRef
EVAL_JUDGE_PROVIDER_ID=openai            # any registered provider
EVAL_JUDGE_MODEL=gpt-4o-mini             # cheap default
EVAL_JUDGE_TEMPERATURE=0
EVAL_JUDGE_MAX_TOKENS=512
```

`faithfulness` and `answer_relevance` authenticate with the server's provider environment keys (such as `OPENAI_API_KEY`), which the operator must allow with `EVAL_JUDGE_ALLOW_ENV_CREDENTIALS=true`. An `llm_judge` scorer can use a `secretRef` from the secret store instead.

Golden sets, replay jobs and the newer scorers (JSON, schema, tool sequence, content rules, budget, rubric and pairwise judges with a `secretRef`) are described in [Golden sets, replay jobs and scorers](../product/golden-sets.md).

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
- **Storage**: vectors are stored as JSON arrays in a text column, on SQLite and on Postgres alike (the built-in KB does not use pgvector). ~6 bytes/dimension on disk. For a 1536-d OpenAI model, that's ~10 KB per chunk.
- **Concurrency**: on SQLite, writes serialize through the SqliteStore. Read-heavy workloads are unaffected.
- **No HNSW**: every query reads every vector for the KB. `sqlite-vec` is the obvious follow-up if linear scan becomes a bottleneck.
- **Keyword search**: indexed automatically on insert, with no re-indexing step. SQLite uses an FTS5 table kept in step by triggers (tokenizer `porter unicode61`, English stemming) and ranks with BM25. Postgres uses a generated `tsvector` column with the `english` configuration (stemming and English stop words) and ranks with `ts_rank_cd`, which ties more often than BM25. Both scale the scores to 0..1, best first, so rankings are close but not identical across the two databases.
- **Query words**: the query is split into runs of `a`–`z` and `0`–`9` of two or more characters, lower-cased, and a chunk matches when it contains any of them. Other characters, including accented and non-Latin letters, split words, so keyword search suits English and identifiers; use `vector` mode for other languages.
