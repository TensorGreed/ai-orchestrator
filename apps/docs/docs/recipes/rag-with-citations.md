---
title: "RAG with citations: answers that show their sources"
description: "Have the model mark each claim with [N], resolve every marker to the chunk and document it came from, and check that the cited sources back the claims."
keys: "model"
keysNote: "An OpenAI key as shipped; none with the demo embedder and echo"
tags: ["rag","knowledge-base","citations"]
nodeCount: 6
sample: "rag-with-citations-flow.json"
demo: "wf-rag-with-citations-flow"
demoRecorded: false
related: ["grounding","rag","hybrid-search","output-checks","misinformation"]
---

<!--
  Generated from samples/workflows/rag-with-citations-flow.json and apps/docs/recipes.config.json.
  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).
-->

# RAG with citations: answers that show their sources

**What you get:** A RAG workflow whose answer carries [1]-style markers, each resolved to the chunk id, source id and score of the document it cites.

**Needs:** An OpenAI key as shipped; none with the demo embedder and echo · **Time:** 15 minutes · **Nodes:** 6

**Retrieve** runs a hybrid search over a built-in knowledge base and returns the four best chunks as numbered context. It also emits `citationInstructions`, a short instruction that tells the model to end each claim with the number of its source, such as `[2]`. The **Grounded Prompt** puts both into the prompt, the **LLM** answers, and **Extract Citations** finds every marker in the answer and maps it back to its chunk. As shipped, retrieval uses `openai-embedder` and the LLM uses `gpt-4o-mini`, both with the server's `OPENAI_API_KEY`. To try the wiring without a key, switch to the `token-embedder` demo embedder and the echo model.

<div class="recipe-actions">
  <a class="hub-button" href="/docs/recipes/files/rag-with-citations-flow.json" download>Download the workflow JSON</a>
  <a class="hub-button hub-button-quiet" href="/demo/?mode=editor&amp;workflowId=wf-rag-with-citations-flow" target="_self">Open it in the demo</a>
</div>

## Steps

1. Download <a href="/docs/recipes/files/rag-with-citations-flow.json" download>rag-with-citations-flow.json</a>, or take it from the [samples folder on GitHub](https://github.com/TensorGreed/ai-orchestrator/blob/main/samples/workflows/rag-with-citations-flow.json).
2. In the studio's workflow editor, import the file (see [import and export](/product/workflow-editor)).
3. Create a knowledge base and add a document, as in the [knowledge base recipe](/recipes/rag-knowledge-base#create-a-knowledge-base-with-the-api). Create it with the embedder the **Retrieve** node uses: `openai-embedder` as shipped, or `token-embedder` to start with no key.
4. With no OpenAI key, use echo for the **LLM** node. The **Provider** list has no echo entry, so set the node's `providerId` to `echo` in the JSON file and import it again before you edit the nodes below.
5. Open **Retrieve**. **Vector Store** already shows **Knowledge Base (built in)**: pick your knowledge base in **Knowledge Base**, in place of the `<your-kb-id>` placeholder. If you used `token-embedder`, check that **Embedder** shows **Token Based (Local Demo)**. Save.
6. Run it, then open the run and click **Extract Citations** to read the resolved citations.

## How it works

<figure class="recipe-diagram">
<svg viewBox="46 196 1768 102" role="img" aria-labelledby="rd-rag-with-citations-title rd-rag-with-citations-desc" xmlns="http://www.w3.org/2000/svg"><title id="rd-rag-with-citations-title">Diagram of the RAG with Citations workflow</title><desc id="rd-rag-with-citations-desc">Runs Question, then Retrieve, then Grounded Prompt, then LLM, then Extract Citations, then Output.</desc><defs><marker id="rd-rag-with-citations-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="rd-edge" d="M260 247 C309 247 309 247 358 247" marker-end="url(#rd-rag-with-citations-arrow)"/><path class="rd-edge" d="M550 247 C609 247 609 247 668 247" marker-end="url(#rd-rag-with-citations-arrow)"/><path class="rd-edge" d="M260 247 C464 247 464 247 668 247" marker-end="url(#rd-rag-with-citations-arrow)"/><path class="rd-edge" d="M860 247 C919 247 919 247 978 247" marker-end="url(#rd-rag-with-citations-arrow)"/><path class="rd-edge" d="M1170 247 C1229 247 1229 247 1288 247" marker-end="url(#rd-rag-with-citations-arrow)"/><path class="rd-edge" d="M550 247 C919 247 919 247 1288 247" marker-end="url(#rd-rag-with-citations-arrow)"/><path class="rd-edge" d="M1480 247 C1539 247 1539 247 1598 247" marker-end="url(#rd-rag-with-citations-arrow)"/><g class="rd-node" data-kind="step" transform="translate(70 220)"><title>Question (text_input)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Question</text><text class="rd-type" x="12" y="40">text_input</text></g><g class="rd-node" data-kind="step" transform="translate(360 220)"><title>Retrieve (rag_retrieve)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Retrieve</text><text class="rd-type" x="12" y="40">rag_retrieve</text></g><g class="rd-node" data-kind="step" transform="translate(670 220)"><title>Grounded Prompt (prompt_template)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Grounded Prompt</text><text class="rd-type" x="12" y="40">prompt_template</text></g><g class="rd-node" data-kind="model" transform="translate(980 220)"><title>LLM (llm_call)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">LLM</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="step" transform="translate(1290 220)"><title>Extract Citations (extract_citations)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Extract Citations</text><text class="rd-type" x="12" y="40">extract_citations</text></g><g class="rd-node" data-kind="step" transform="translate(1600 220)"><title>Output (output)</title><rect width="190" height="54" rx="10"/><text class="rd-name" x="12" y="22">Output</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>
</figure>

| Node | Type | Role |
| --- | --- | --- |
| Question | [`text_input`](/nodes/reference/input#text-input-—-text-input) | Step in the run |
| Retrieve | [`rag_retrieve`](/nodes/reference/rag#rag-retrieve-—-rag-retrieve) | Step in the run |
| Grounded Prompt | [`prompt_template`](/nodes/reference/utility#prompt-template-—-prompt-template) | Step in the run |
| LLM | [`llm_call`](/nodes/reference/llm#llm-call-—-llm-call) | Step in the run |
| Extract Citations | [`extract_citations`](/nodes/reference/rag#extract-citations-—-extract-citations) | Step in the run |
| Output | [`output`](/nodes/reference/output#output-—-output) | Step in the run |

6 node types. Each type links to its config fields in the [node reference](/nodes/reference/).

## What a run does

We ran the sample on a fresh install against a knowledge base holding a short helpdesk FAQ in 4 chunks (password reset, billing, data export and an error code).

**As shipped, with no OpenAI key**, the run stops at **Retrieve**: `OpenAI Embedding API error: Unauthorized`. The question has to be embedded before anything is searched.

**With `token-embedder` and echo**, the run succeeded. Retrieve returned all 4 chunks, the password-reset chunk first, each with its `chunkId`, `sourceId`, `similarityScore` and `retrieval.mode: "hybrid"`. Echo answered with the whole prompt, so the answer contained `[1]` to `[4]` from the numbered context and `[1]`, `[2]` and `[3]` from the citation instructions' own examples. Extract Citations found 8 markers and `hasCitations: true`. That shows the plumbing, not a model citing: a check that only asks "are there citations?" passes a prompt echoed back.

**With a scripted stand-in model.** To see real resolution without a provider key, we pointed the LLM node at a small local OpenAI-compatible server that returns a fixed answer: "Open the sign-in page, choose Forgot password and enter your work email [1]. The reset link is valid for 30 minutes [1]. If sign-in fails with E1042, your session expired: retry in a new tab [3]." Extract Citations returned 3 citations covering 2 documents (`uniqueCitedDocuments: 2`). Each one carries the marker, the 1-based `index`, the `chunkId`, `sourceId`, `knowledgeBaseId`, the chunk text, the score and the marker's `startIndex` and `endIndex` in the answer. An answer with no markers returned `hasCitations: false` and an empty list. A marker that matches no document, such as `[7]` with four documents, is skipped.

The **Output** node returns only <span v-pre>`{{answer}}`</span>, the text with its markers. The citations stay in the Extract Citations output. The studio's chat panel reads them from there and shows each marker as a link to a footnote. An app calling the workflow through the API gets only the text unless you add <span v-pre>`{{citations}}`</span> to the Output template, which renders the list as JSON.

## Check that the citations hold up

A citation proves which chunk the model pointed at, not that the chunk says what the model claims. To check that, add an **Output Guardrail** node after Extract Citations with the **Grounded in sources** check (`grounding`) and **On Fail** left at **Stop with Error**. It splits the answer into claims and looks for each claim's words in the documents it cites. See [grounding in sources](/product/content-rules-output-checks#grounding-in-sources).

We tried it with the stand-in model. The answer above passed. "The reset link is valid for 24 hours and arrives by text message [2]." failed the run with `Output guardrail checks failed: grounding (block: ungrounded (output.grounding))`, because document 2 is the billing chunk. An answer with no markers passed by default, since its words appear in the documents; with **Every claim must cite a source** (`requireCitations`) turned on, it failed too.

The check is lexical. It catches a claim that cites the wrong chunk or says something no chunk says. A paraphrase in new words can read as unsupported, and a changed figure inside an otherwise matching sentence can slip through. It is optional; simple workflows need none of it.

## Score answers in evals

To test a change to the prompt, the chunking or the embedder, run fixtures through the eval framework with the RAG scorers in [Knowledge bases](/nodes/knowledge-bases#rag-specific-eval-scorers-phase-9-5). `context_precision` and `context_recall` are programmatic and cost nothing per fixture. `faithfulness` and `answer_relevance` call a judge model with the server's provider keys, so they need both `EVAL_JUDGE_ENABLED=true` and `EVAL_JUDGE_ALLOW_ENV_CREDENTIALS=true`. The scorers read `documents` and `answer` from the run's output. This sample's output is only `result`, the answer text, so the context scorers find no chunks. In the copy you evaluate, delete the Output node: the run's output is then the Extract Citations output, which carries both `answer` and `documents`.

## Make it yours

- Use any chat model on the **LLM** node. Run the grounding check above on a few answers to see how well your model cites.
- Write your own instructions in place of the citation instructions, but keep the numbered form `[1]`: that is what Extract Citations resolves first. It also accepts a chunk id in brackets, such as `[kbc_...]`.
- Lower `topK` (4 in the sample) to keep the prompt short, or add a **Rerank** step before the prompt: see [hybrid search and reranking](/recipes/hybrid-search-rerank).

## Make it safer

These controls are optional; the recipe runs without them.

- Retrieved chunks are outside content and can carry instructions for the model. [Content rules](/product/content-rules#outside-content-at-the-model-boundary) can check each retrieved document before it reaches the model.
- Tell readers when an answer has no citations: branch on `hasCitations` with an If node.
- Cap model spend with a [budget](/product/budgets).

## Further reading

- [Knowledge bases: citations](/nodes/knowledge-bases#citations-phase-9-4)
- [Output checks: grounding in sources](/product/content-rules-output-checks#grounding-in-sources)
- [OWASP Top 10 for LLM applications](/learn/security/owasp-llm-top-10)
- [OWASP LLM09:2025 Misinformation](https://genai.owasp.org/llmrisk/llm092025-misinformation/)
- [Pattern library](/patterns/)
