---
title: "Hybrid search and reranking for better RAG"
description: "Fuse BM25 keyword and vector search with reciprocal rank fusion, then rerank the top chunks, so RAG finds exact error codes and paraphrases alike."
keys: "services"
keysNote: "A rerank key (Cohere, Jina or Voyage) and an OpenAI key"
tags: ["rag","knowledge-base","search"]
nodeCount: 6
sample: "rag-hybrid-rerank-flow.json"
related: ["hybrid-search","rag","vector-store","grounding"]
---

<!--
  Generated from samples/workflows/rag-hybrid-rerank-flow.json and apps/docs/recipes.config.json.
  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).
-->

# Hybrid search and reranking for better RAG

**What you get:** A RAG workflow that takes 20 candidates from keyword and vector search combined, reranks them, and answers from the best 3.

**Needs:** A rerank key (Cohere, Jina or Voyage) and an OpenAI key · **Time:** 15 minutes · **Nodes:** 6

**Retrieve (hybrid)** searches a built-in knowledge base two ways at once: BM25 keyword search and vector search, 50 candidates each. It merges the two lists with reciprocal rank fusion and keeps the top 20. **Rerank** sends those 20 to a hosted reranking model (Cohere as shipped), which scores each chunk against the question and keeps the best 3. The **Grounded Prompt** and **LLM** answer from those. As shipped it needs a Cohere key for the rerank and an OpenAI key for the embedder and the model. Without them you can still compare the search modes with the demo embedder.

<div class="recipe-actions">
  <a class="hub-button" href="/docs/recipes/files/rag-hybrid-rerank-flow.json" download>Download the workflow JSON</a>
</div>

## Steps

1. Download <a href="/docs/recipes/files/rag-hybrid-rerank-flow.json" download>rag-hybrid-rerank-flow.json</a>, or take it from the [samples folder on GitHub](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/rag-hybrid-rerank-flow.json).
2. In the studio's workflow editor, import the file (see [import and export](/product/workflow-editor)).
3. Create a knowledge base and add documents, as in the [knowledge base recipe](/recipes/rag-knowledge-base#create-a-knowledge-base-with-the-api), with the embedder the **Retrieve (hybrid)** node uses (`openai-embedder` as shipped). Put its id in place of `<your-kb-id>` (on the node, in **Vector Store Extra Config (JSON)**).
4. Store your Cohere key as a [secret](/security/secrets). The Rerank form has no secret field, so put the secret's id in place of `<cohere-key-secret-id>` in the JSON file and import it again. Or delete `secretRef` from the file and set `COHERE_API_KEY` on the server. For Jina or Voyage, change `providerId`, `model` and the key.
5. Run it and open **Retrieve (hybrid)** and **Rerank** in the run to compare their order.

## How it works

<figure class="recipe-diagram">
<svg viewBox="46 196 1768 102" role="img" aria-labelledby="rd-hybrid-search-rerank-title rd-hybrid-search-rerank-desc" xmlns="http://www.w3.org/2000/svg"><title id="rd-hybrid-search-rerank-title">Diagram of the RAG with Hybrid Search + Reranker workflow</title><desc id="rd-hybrid-search-rerank-desc">Runs Question, then Retrieve (hybrid), then Rerank (Cohere), then Grounded Prompt, then LLM, then Output.</desc><defs><marker id="rd-hybrid-search-rerank-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M260 247 C309 247 309 247 358 247" marker-end="url(#rd-hybrid-search-rerank-arrow)"/><path class="rd-edge" d="M550 247 C609 247 609 247 668 247" marker-end="url(#rd-hybrid-search-rerank-arrow)"/><path class="rd-edge" d="M260 247 C464 247 464 247 668 247" marker-end="url(#rd-hybrid-search-rerank-arrow)"/><path class="rd-edge" d="M860 247 C919 247 919 247 978 247" marker-end="url(#rd-hybrid-search-rerank-arrow)"/><path class="rd-edge" d="M260 247 C619 247 619 247 978 247" marker-end="url(#rd-hybrid-search-rerank-arrow)"/><path class="rd-edge" d="M1170 247 C1229 247 1229 247 1288 247" marker-end="url(#rd-hybrid-search-rerank-arrow)"/><path class="rd-edge" d="M1480 247 C1539 247 1539 247 1598 247" marker-end="url(#rd-hybrid-search-rerank-arrow)"/><g class="rd-node" data-kind="step" transform="translate(70 220)"><title>Question (text_input)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Question</text><text class="rd-type" x="12" y="40">text_input</text></g><g class="rd-node" data-kind="step" transform="translate(360 220)"><title>Retrieve (hybrid) (rag_retrieve)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Retrieve (hybrid)</text><text class="rd-type" x="12" y="40">rag_retrieve</text></g><g class="rd-node" data-kind="step" transform="translate(670 220)"><title>Rerank (Cohere) (rerank)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Rerank (Cohere)</text><text class="rd-type" x="12" y="40">rerank</text></g><g class="rd-node" data-kind="step" transform="translate(980 220)"><title>Grounded Prompt (prompt_template)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Grounded Prompt</text><text class="rd-type" x="12" y="40">prompt_template</text></g><g class="rd-node" data-kind="model" transform="translate(1290 220)"><title>LLM (llm_call)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">LLM</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="step" transform="translate(1600 220)"><title>Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Output</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>
</figure>

| Node | Type | Role |
| --- | --- | --- |
| Question | [`text_input`](/nodes/reference/input#text-input-—-text-input) | Step in the run |
| Retrieve (hybrid) | [`rag_retrieve`](/nodes/reference/rag#rag-retrieve-—-rag-retrieve) | Step in the run |
| Rerank (Cohere) | [`rerank`](/nodes/reference/rag#rerank-—-rerank) | Step in the run |
| Grounded Prompt | [`prompt_template`](/nodes/reference/utility#prompt-template-—-prompt-template) | Step in the run |
| LLM | [`llm_call`](/nodes/reference/llm#llm-call-—-llm-call) | Step in the run |
| Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |

6 node types. Each type links to its config fields in the [node reference](/nodes/reference/).

## Why hybrid

Vector search matches meaning: "I forgot my login" finds a chunk about resetting a password. It is weaker on exact strings such as error codes, product ids and rare names. Keyword search is the reverse. Hybrid runs both and merges the two ranked lists with reciprocal rank fusion (RRF): each list gives a chunk `1 / (k + rank)`, and the sums decide the order. A chunk near the top of both lists wins. The sample uses `k = 60`, the constant from the paper that introduced RRF, which found it near-optimal but not critical.

Hybrid and `bm25` modes work only with the built-in knowledge base. With an external vector store the node falls back to vector search without an error. If keyword search finds no chunk at all, hybrid returns the vector results unchanged.

## What a run does

We ran the sample on a fresh install with no provider keys, against a knowledge base holding a short helpdesk FAQ in 4 chunks, one of them about error code E1042.

**As shipped**, the run stops at the first step that needs a key. With `openai-embedder` and no key, that is **Retrieve**: `OpenAI Embedding API error: Unauthorized`. With the `token-embedder` demo embedder, retrieval succeeds and **Rerank** stops: `Reranker "cohere" requires an API key — pass via secretRef or set COHERE_API_KEY`. Note that while the node holds a `secretRef`, even a placeholder one, it uses only that secret and never reads `COHERE_API_KEY`. Delete the `secretRef` to use the environment key.

**The search modes, compared.** We removed the Rerank node and ran the retrieve step in each mode with `topK: 3`:

| Question | `vector` | `bm25` | `hybrid` |
| --- | --- | --- | --- |
| What does E1042 mean? | E1042 chunk first, then billing, then reset | the E1042 chunk only | E1042 chunk first (both rankers), then billing, then reset |
| How do I reset my password? | reset chunk first | the reset chunk only | reset chunk first (both rankers) |

Keyword search returns only chunks that share a word with the question; vector search always fills `topK`. In hybrid mode each chunk records which rankers found it (`retrieval.rankers`) and its `rrfScore`: 0.0328 for a chunk ranked first by both (2/61), 0.0161 and 0.0159 for chunks only vector search found (1/62, 1/63). With 4 small chunks the order barely moves. Hybrid matters more on larger collections, where an exact code can sit far down a vector ranking; measure it on yours (below).

**The rerank step was not observed**, as we had no rerank key. From the code: Rerank sends the question and the text of each upstream chunk to the provider (Cohere's `top_n` is `topN`), keeps the order the provider returns, and adds `rerankerScore` and `reranker: { providerId, model }` to each chunk's metadata. It returns `documents`, a numbered `context` and the same `citationInstructions` as Retrieve. With no upstream chunks it returns an empty list and makes no call. A provider error fails the run with the provider's status, such as `Cohere rerank 401: ...`.

## Measure the difference

Do not take hybrid or a reranker on faith: measure them on your own questions. Build a few fixtures (a question and the answer you expect), then score each variant with `context_precision` (how much of what was retrieved is relevant) and `context_recall` (how much of the expected answer the retrieved text covers). Both are programmatic and free per fixture. They read `documents` from the run's output, and this sample's output is only the answer text, so evaluate a copy that ends at the step you are measuring, **Retrieve (hybrid)** or **Rerank**. See [RAG-specific eval scorers](/nodes/knowledge-bases#rag-specific-eval-scorers-phase-9-5) and [golden sets](/product/golden-sets) for running them on every change.

## Make it yours

- Tune `candidatesPerRanker`, `bm25Weight`, `vectorWeight` and `rrfK` in the retrieve node's config in the JSON file, then import it again; the node's form has no fields for them, nor for `searchMode`. See [hybrid search](/nodes/knowledge-bases#hybrid-search-phase-9-3).
- Swap the reranker: `jina` (default model `jina-reranker-v2-base-multilingual`) or `voyage` (`rerank-2`), with `JINA_API_KEY` or `VOYAGE_API_KEY` or a secret. Change `model` too, or clear it to use the default: the sample's `rerank-english-v3.0` is a Cohere model and is sent as is.
- The prompt asks the model to "Cite chunkIds inline", but the context numbers chunks `[1]`, `[2]`. Put <span v-pre>`{{citationInstructions}}`</span> in the prompt instead and add an Extract Citations step: see [RAG with citations](/recipes/rag-with-citations).

## Make it safer

These controls are optional; the recipe runs without them.

- A reranker is one more service that receives your documents' text. Keep it in mind when you choose which documents to index.
- Retrieved chunks can carry instructions for the model: [content rules](/product/content-rules#outside-content-at-the-model-boundary) can check them before they reach the model.
- The rerank provider bills you directly, and L2M budgets do not count rerank calls. Cap the model side with a [budget](/product/budgets).

## Further reading

- [Knowledge bases: hybrid search](/nodes/knowledge-bases#hybrid-search-phase-9-3)
- [Knowledge bases: reranker node](/nodes/knowledge-bases#reranker-node-phase-9-3)
- [Golden sets, replay jobs and scorers](/product/golden-sets)
- [Cormack, Clarke and Büttcher, "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods" (SIGIR 2009)](http://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf)
