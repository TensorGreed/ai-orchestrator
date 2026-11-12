---
title: "RAG with a built-in knowledge base, no vector DB"
description: "Ingest documents into L2M's built-in knowledge base and answer questions from them, with no external vector database and no API key to start."
keys: "none"
keysNote: "No API key to start"
tags: ["rag","knowledge-base","starter"]
nodeCount: 5
sample: "rag-knowledge-base-flow.json"
demo: "wf-rag-knowledge-base-flow"
demoRecorded: false
related: ["rag","vector-store","hybrid-search","grounding"]
---

<!--
  Generated from samples/workflows/rag-knowledge-base-flow.json and apps/docs/recipes.config.json.
  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).
-->

# RAG with a built-in knowledge base, no vector DB

**What you get:** A question-answering workflow that retrieves from a knowledge base stored in L2M's own database, with no vector database and no API key.

**Needs:** No API key to start · **Time:** 10 minutes · **Nodes:** 5

A **Question** node holds the question. **RAG Retrieve** searches a built-in knowledge base for the three nearest chunks, a **Prompt Template** puts them into a grounded prompt, and an **LLM** node answers. The sample uses `token-embedder`, a hash-based demo embedder that needs no key (its search quality is poor), and the echo model. Echo returns the prompt it was given, which is useful here: the answer shows exactly what a real model would read. Swap both for real ones to get real answers.

<div class="recipe-actions">
  <a class="hub-button" href="/docs/recipes/files/rag-knowledge-base-flow.json" download>Download the workflow JSON</a>
  <a class="hub-button hub-button-quiet" href="/demo/?mode=editor&amp;workflowId=wf-rag-knowledge-base-flow" target="_self">Open it in the demo</a>
</div>

## Steps

1. Download <a href="/docs/recipes/files/rag-knowledge-base-flow.json" download>rag-knowledge-base-flow.json</a>, or take it from the [samples folder on GitHub](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/rag-knowledge-base-flow.json).
2. In the studio's workflow editor, import the file (see [import and export](/product/workflow-editor)).
3. As an admin, create a knowledge base with the `token-embedder` and add a document, under **Knowledge** in the sidebar or with the API (below). Get its id (`kb_...`) from the create response or from `GET /api/knowledge-bases`; the Knowledge page does not show it.
4. Open the **RAG Retrieve (KB)** node and replace `<your-kb-id>` with that id. Save.
5. Run it, then change the question on the **Question** node and run it again.

## How it works

<figure class="recipe-diagram">
<svg viewBox="46 196 1458 102" role="img" aria-labelledby="rd-rag-knowledge-base-title rd-rag-knowledge-base-desc" xmlns="http://www.w3.org/2000/svg"><title id="rd-rag-knowledge-base-title">Diagram of the RAG with Knowledge Base workflow</title><desc id="rd-rag-knowledge-base-desc">Runs Question, then RAG Retrieve (KB), then Grounded Prompt, then LLM, then Output.</desc><defs><marker id="rd-rag-knowledge-base-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M260 247 C309 247 309 247 358 247" marker-end="url(#rd-rag-knowledge-base-arrow)"/><path class="rd-edge" d="M550 247 C609 247 609 247 668 247" marker-end="url(#rd-rag-knowledge-base-arrow)"/><path class="rd-edge" d="M260 247 C464 247 464 247 668 247" marker-end="url(#rd-rag-knowledge-base-arrow)"/><path class="rd-edge" d="M860 247 C919 247 919 247 978 247" marker-end="url(#rd-rag-knowledge-base-arrow)"/><path class="rd-edge" d="M1170 247 C1229 247 1229 247 1288 247" marker-end="url(#rd-rag-knowledge-base-arrow)"/><g class="rd-node" data-kind="step" transform="translate(70 220)"><title>Question (text_input)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Question</text><text class="rd-type" x="12" y="40">text_input</text></g><g class="rd-node" data-kind="step" transform="translate(360 220)"><title>RAG Retrieve (KB) (rag_retrieve)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">RAG Retrieve (KB)</text><text class="rd-type" x="12" y="40">rag_retrieve</text></g><g class="rd-node" data-kind="step" transform="translate(670 220)"><title>Grounded Prompt (prompt_template)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Grounded Prompt</text><text class="rd-type" x="12" y="40">prompt_template</text></g><g class="rd-node" data-kind="model" transform="translate(980 220)"><title>LLM (llm_call)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">LLM</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="step" transform="translate(1290 220)"><title>Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Output</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>
</figure>

| Node | Type | Role |
| --- | --- | --- |
| Question | [`text_input`](/nodes/reference/input#text-input-—-text-input) | Step in the run |
| RAG Retrieve (KB) | [`rag_retrieve`](/nodes/reference/rag#rag-retrieve-—-rag-retrieve) | Step in the run |
| Grounded Prompt | [`prompt_template`](/nodes/reference/utility#prompt-template-—-prompt-template) | Step in the run |
| LLM | [`llm_call`](/nodes/reference/llm#llm-call-—-llm-call) | Step in the run |
| Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |

5 node types. Each type links to its config fields in the [node reference](/nodes/reference/).

## Create a knowledge base with the API

```bash
# An admin's API key, from Settings › Account › API Keys.
export L2M_API_KEY=ao_...

# Create a knowledge base. The response holds its id: kb_...
curl -X POST http://localhost:4000/api/knowledge-bases \
  -H "Authorization: Bearer $L2M_API_KEY" -H "Content-Type: application/json" \
  -d '{"name": "Helpdesk FAQ", "embedderId": "token-embedder", "embedderConfig": {}}'

# Load, chunk, embed and store a Markdown file in one call.
export KB_ID=kb_...   # the id from the response above
curl -X POST http://localhost:4000/api/knowledge-bases/$KB_ID/upload \
  -H "Authorization: Bearer $L2M_API_KEY" -H "Content-Type: application/json" \
  -d '{"filename": "helpdesk-faq.md", "sourceId": "helpdesk-faq-v1",
       "content": "# Helpdesk FAQ\n\n## Reset your password\nTo reset your password, open the sign-in page, choose Forgot password, and enter your work email. The reset link is valid for 30 minutes.\n\n## Change your billing plan\nAdmins can change the billing plan under Settings, then Billing. Changes apply from the next invoice.\n\n## Export your data\nGo to Settings, then Data, and choose Export. You get a ZIP file with one CSV per table.",
       "chunking": {"strategy": "recursive", "chunkSize": 300, "chunkOverlap": 0}}'
```

On our install the upload answered `{"sourceId":"helpdesk-faq-v1","documentsLoaded":1,"chunksInserted":2,"dimensions":64}`. The embedder you create the knowledge base with must match the `embedderId` on the RAG Retrieve node, or the question and the chunks are not compared in the same space.

## What a run does

We ran the sample on a fresh install, against a knowledge base holding a short helpdesk FAQ (a password-reset section, a billing section and a data-export section, stored as 2 chunks):

- **RAG Retrieve** returned both chunks, the password-reset chunk first (similarity 0.375, against 0.131 for the other), each with its `chunkId`, `sourceId` and score.
- **Grounded Prompt** numbered them `[1]` and `[2]` under "Context:" and added the question.
- **LLM** (echo) returned that whole prompt, prefixed with `Echo: `, and **Output** returned it as `result`.

Two things to know:

- **A missing id fails quietly.** Run the sample without replacing `<your-kb-id>` and it still succeeds: retrieval returns no documents and the prompt's context is empty. If answers look ungrounded, check the retrieve node's `documents` first.
- **The template asks for chunk ids, but the context shows numbers.** The prompt says "Cite the chunkId for every claim" while the context lists `[1]`, `[2]`. For citations that resolve to their sources, use the `citationInstructions` the retrieve node emits and the citation tools in [Knowledge bases](/nodes/knowledge-bases#citations-phase-9-4).

## Variant: retrieve from a connector

[`rag-flow.json`](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/rag-flow.json) loads documents from a **Connector Source** (Google Drive) on every run and retrieves from them in memory, with no knowledge base. As shipped it calls a local Ollama model (`llama3.1`). We ran it with the echo model and no Google credentials: the connector ran in demo-fallback mode and returned five built-in sample documents, and retrieval put the three closest to "How does MCP fit into an AI workflow builder?" into the prompt. Use a knowledge base when the documents should be ingested once and kept; use a connector for small sets that change between runs.

## Make it yours

- Use a real embedder (for example `openai-embedder`, with its key as a [secret](/security/secrets)) for the knowledge base and the same `embedderId` on the node. A knowledge base keeps the vector size of its first chunks, so start a new one when you change embedders.
- Replace the echo model with a real one on the **LLM** node.
- Set `searchMode` to `hybrid` to add keyword (BM25) matches to vector search, and add a **Rerank** node for better ordering. See [hybrid search](/nodes/knowledge-bases#hybrid-search-phase-9-3).

## Make it safer

These controls are optional; the recipe runs without them.

- Retrieved documents are outside content: a document can carry instructions for the model. [Content rules](/product/content-rules#outside-content-at-the-model-boundary) can check each retrieved document before it reaches the model.
- Cap model spend with a [budget](/product/budgets) once you switch to a paid model.

## Further reading

- [Knowledge bases](/nodes/knowledge-bases)
- [Vector stores](/nodes/vector-stores)
- [Pattern library](/patterns/)
