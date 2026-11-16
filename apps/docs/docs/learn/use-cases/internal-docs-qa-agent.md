---
title: "Internal docs Q&A agent on your own servers"
sidebarTitle: "Internal docs Q&A"
description: "Answer staff questions from your own documents with a self-hosted knowledge base, hybrid search and citations, and keep restricted files out of answers."
level: intermediate
demo: wf-rag-with-citations-flow
related: [rag, hybrid-search, vector-store, grounding, golden-set, rbac]
---

# Internal docs Q&A agent on your own servers

An internal docs Q&A agent answers staff questions from your own handbooks, runbooks and policies, and shows which document each answer came from. The design choice that matters most is not the model: it is which documents a given person's question can reach, because whatever the retrieval step finds can end up in the answer. In L2M you start from the built-in knowledge base, a retrieval step with hybrid search, and a citation step, all running on your own server; access is controlled per project, not per document.

## The job

| | |
|---|---|
| **Input** | A question in plain words, from a chat box or an internal app ("How do I get a VPN token?", "What does error E1042 mean?") |
| **Knowledge** | Your documents, split into chunks and stored with their embeddings in a <Term id="vector-store">vector store</Term> |
| **Output** | A short answer with numbered markers such as `[1]`, each resolved to the document it came from, or a plain "the docs do not say" |
| **Never** | An answer built from a document the asker is not meant to see, or a confident answer with no source |

This is <Term id="rag">retrieval-augmented generation</Term>: find the passages that match the question, put them in the prompt, and have the model answer from them. The RAG paper by Lewis et al. framed the motivation: a model's ability "to access and precisely manipulate knowledge is still limited", and "providing provenance for their decisions and updating their world knowledge remain open research problems". Retrieval addresses both: you update the documents, not the model, and every answer can point at its source.

**Agent or fixed workflow?** For plain Q&A, a fixed workflow is usually better: retrieve, prompt, answer, cite. It makes one model call per question and is easy to test. Reach for an agent with tools when answering means a chain of lookups the workflow cannot predict, such as checking a ticket's status in another system before quoting the policy that applies. [Workflows vs agents](/learn/agents/workflows-vs-agents) covers that trade-off; this page uses the fixed workflow.

## The design

<figure class="recipe-diagram">
<svg viewBox="0 0 780 250" role="img" aria-labelledby="idqa-title idqa-desc" xmlns="http://www.w3.org/2000/svg"><title id="idqa-title">Docs Q&amp;A workflow</title><desc id="idqa-desc">A Chat Trigger passes the question to RAG Retrieve, which searches a project knowledge base with hybrid search. A Prompt Template puts the numbered chunks and the question into a prompt for an LLM Call. Extract Citations maps each marker in the answer back to its chunk, using the retrieved documents. An Output Guardrail with the grounding check stops answers whose claims the cited chunks do not support, and the Output returns the answer.</desc><path class="rd-edge" d="M190 47 L210 47"/><path class="rd-edge" d="M380 47 L400 47"/><path class="rd-edge" d="M485 74 L485 112 L105 112 L105 150"/><path class="rd-edge" d="M295 74 L295 150"/><path class="rd-edge" d="M190 177 L210 177"/><path class="rd-edge" d="M380 177 L400 177"/><path class="rd-edge" d="M570 177 L590 177"/><g class="rd-node" data-kind="step" transform="translate(20 20)"><rect width="170" height="54" rx="10"/><text class="rd-name" x="12" y="22">Question</text><text class="rd-type" x="12" y="40">chat_trigger</text></g><g class="rd-node" data-kind="step" transform="translate(210 20)"><rect width="170" height="54" rx="10"/><text class="rd-name" x="12" y="22">Retrieve (hybrid)</text><text class="rd-type" x="12" y="40">rag_retrieve</text></g><g class="rd-node" data-kind="step" transform="translate(400 20)"><rect width="170" height="54" rx="10"/><text class="rd-name" x="12" y="22">Grounded prompt</text><text class="rd-type" x="12" y="40">prompt_template</text></g><g class="rd-node" data-kind="model" transform="translate(20 150)"><rect width="170" height="54" rx="10"/><text class="rd-name" x="12" y="22">Answer</text><text class="rd-type" x="12" y="40">llm_call</text></g><g class="rd-node" data-kind="step" transform="translate(210 150)"><rect width="170" height="54" rx="10"/><text class="rd-name" x="12" y="22">Citations</text><text class="rd-type" x="12" y="40">extract_citations</text></g><g class="rd-node" data-kind="step" transform="translate(400 150)"><rect width="170" height="54" rx="10"/><text class="rd-name" x="12" y="22">Grounding check</text><text class="rd-type" x="12" y="40">output_guardrail</text></g><g class="rd-node" data-kind="step" transform="translate(590 150)"><rect width="170" height="54" rx="10"/><text class="rd-name" x="12" y="22">Reply</text><text class="rd-type" x="12" y="40">output</text></g></svg>
<figcaption>Solid lines are the order the steps run in. Retrieve feeds both the prompt and the citation step, so every marker can be resolved to a chunk.</figcaption>
</figure>

| Node | Type | What it does here |
|---|---|---|
| Question | `chat_trigger` | Takes the message as the question. Set **authMode** to `session` (see the next section) |
| Retrieve | `rag_retrieve` | `vectorStoreId: "knowledge-base"`, `vectorStoreConfig.knowledgeBaseId` set to your knowledge base, `searchMode: "hybrid"`, `topK` 4 to 6 |
| Grounded prompt | `prompt_template` | Puts in the numbered `context`, the `citationInstructions` the retrieve step emits, and the question |
| Answer | `llm_call` | Any chat model your deployment allows |
| Citations | `extract_citations` | Resolves `[N]` markers to `chunkId` and `sourceId`; the chat panel shows them as footnotes |
| Grounding check | `output_guardrail` | Optional: `checks: ["grounding"]`, `onFail: "error"` |

**Why hybrid search.** Staff ask in their own words ("the thing for remote access") and with exact strings (an error code, a form number). Dense vectors catch the paraphrase; keyword ranking catches the exact string. <Term id="hybrid-search">Hybrid search</Term> runs both on the built-in knowledge base and fuses the rankings ([hybrid search](/nodes/knowledge-bases#hybrid-search-phase-9-3)). Two limits: the keyword side splits text into runs of `a`–`z` and `0`–`9`, so it suits English and identifiers, and external vector stores fall back to vector-only search when you ask for hybrid.

**Documents in, and kept fresh.** Upload Markdown, HTML, CSV, JSON or plain text under **Knowledge** in the sidebar or with `POST /api/knowledge-bases/:id/upload`. PDF and Word files are not loaded directly: extract their text first and upload that. Give each document a stable `sourceId`. Uploading again does not replace a document: it appends a second copy of its chunks. On our test install, three uploads of one three-chunk FAQ under the same `sourceId` left nine chunks. To update a document, an admin deletes its source (`DELETE /api/knowledge-bases/:id/sources/:sourceId`), then you upload the new version. There is no built-in sync from a drive or wiki, so make re-uploading changed documents somebody's job.

## Keeping restricted files out of answers

Anything in a knowledge base that a workflow can query can appear in that workflow's answers, for anyone who can run it. L2M controls this per project and knowledge base:

- **A knowledge base belongs to a project, or to nobody.** A run sees the knowledge bases of its own workflow's project plus the shared ones that have no project. Any other id reads as missing. On our test install, a workflow in the default project pointed at an HR project's knowledge base: retrieval returned no documents and the run still succeeded, even when an admin started it. The same workflow saved in the HR project retrieved the salary-band chunk. So a wrong id fails quietly: test that answers come back, not just that the run is green.
- **Who can change the content.** Only admins create and delete knowledge bases and delete sources. Builders with write access to a project add documents to that project's knowledge base. A shared knowledge base is read by every project's runs, so only an admin may add to it. Creating, updating and deleting a knowledge base, uploads and source deletions are recorded in the [audit log](/security/audit-log).
- **Who can ask.** A Chat Trigger in `session` mode only answers signed-in users who can read the workflow's project. A Chat Trigger you add in the editor starts in `session` mode, but one saved without a mode (an older or imported workflow) is `public`, which checks nobody, so check the field; `bearer` checks a shared token, not a person. With `PROJECT_ISOLATION=strict`, users see only the projects they are members of ([project access](/security/auth-rbac#project-access)).

What L2M does not do:

- **No per-user or per-document filtering.** Retrieval does not know who asked. It does not read the permissions of the system a document came from, and the built-in knowledge base has no metadata filter on the retrieve step. Everyone who can run the workflow can get any chunk of its knowledge bases.
- So the pattern is **one knowledge base per audience, in that audience's project**: an all-staff handbook shared or in an all-staff project, HR policies in an HR project with an HR-only Q&A workflow, and so on. Never put a restricted file in a shared knowledge base "just for now".

Two optional guards: documents are outside content, and a page can carry instructions aimed at the model. [Content rules](/product/content-rules#outside-content-at-the-model-boundary) can check retrieved chunks before they reach the model. And if the embedder or a reranker is a hosted service, the question and the chunks leave your server; [data labels and destinations](/product/data-labels-and-destinations) can block or require approval for that.

## Approvals

Plain docs Q&A never writes, so it needs no approval per answer; one would only teach people to click through. If you turn it into an agent that can also open a ticket or change a setting through MCP tools, switch on [Ask before write tools](/product/approvals#approval-before-write-tools): the run pauses before each write call and shows the exact arguments.

## Citations and "the docs do not say"

The retrieve step emits `citationInstructions`, a short instruction that asks the model to end each claim with the number of its source and to say plainly when the context has no answer. Extract Citations then resolves every marker to its chunk. Two things to know from our runs with a scripted stand-in model:

- A marker that matches no retrieved chunk, such as `[7]` with three chunks, is skipped, and `hasCitations` stays `true` when any other marker resolved. `hasCitations` alone does not catch an invented source.
- The Output Guardrail's grounding check does. It failed the run for the answer with `[7]`, for an answer that cited chunk 3 for a claim that came from chunk 2, and for a claim no chunk supports, and passed a correct answer. The check compares words, so a paraphrase can be flagged and a changed figure inside a matching sentence can slip through ([grounding in sources](/product/content-rules-output-checks#grounding-in-sources)).

## How to test it

Build a <Term id="golden-set">golden set</Term> of 20 or so real questions before you open it to staff ([golden sets](/product/golden-sets)). Include questions it must refuse, not only ones it must answer:

| Case | Input | A pass |
|---|---|---|
| Plain lookup | "How do I reset my password?" | Cites the helpdesk FAQ; says the link is valid for 30 minutes |
| Exact string | "What does E1042 mean?" | Retrieves the error-code chunk (the case hybrid search is for) |
| Not in the docs | "What is our parental leave in Spain?" | Says the docs do not cover it; no citation |
| Wrong audience | "What does band L5 pay?" asked through the all-staff workflow | No salary figures, because the HR knowledge base is out of reach |
| Stale answer | A question whose answer changed last month | Quotes the new version only (catches duplicate chunks) |

Score with `contains` or `regex` on the path `answer` for the facts, `status`, and the RAG scorers: `context_recall` checks that the retrieved chunks contain the expected answer's words, `faithfulness` asks a judge model whether the answer sticks to the chunks ([RAG scorers](/nodes/knowledge-bases#rag-specific-eval-scorers-phase-9-5)). The RAG scorers read `documents` and `answer` from the run's output by default (`contextPath` and `answerPath` change that), so the workflow you score must return both. The design above does not: the Output Guardrail passes on only the answer, and the Output returns it as `result`. Extract Citations' output holds both `answer` and `documents`, so score a copy of the workflow that ends there.

A replay of a [golden run](/product/golden-runs) answers the retrieval step from the recording, so it tests a prompt or model change on the same chunks. A change to the documents, the chunking or the embedder needs a live eval run of hand-written cases.

## What it costs to run

Per question: one embedding of the question, one model call, and with a reranker one rerank call. The model call is the big one, and its prompt is mostly retrieved text: `topK` times the chunk size, plus the instructions. Halving `topK` or the chunk size roughly halves the input tokens. Uploads cost one embedding per chunk, each time, another reason not to upload a document twice. Cap spend with a [budget](/product/budgets) on the workflow or the project; a blocking budget refuses new runs once it is used up.

## Starting point, honestly

Three samples cover the parts; none is the whole job.

- [`rag-knowledge-base-flow.json`](/recipes/rag-knowledge-base): question, retrieve from a built-in knowledge base, prompt, model. It runs with no key, on the `token-embedder` demo embedder (poor search quality) and the echo model, which returns the prompt. Its template asks for chunk ids while the context shows numbers, so it does not produce resolvable citations.
- [`rag-with-citations-flow.json`](/recipes/rag-with-citations): adds hybrid search, the citation instructions and Extract Citations. As shipped it uses `openai-embedder` and `gpt-4o-mini`.
- `rag-hybrid-rerank-flow.json`: retrieves 20 candidates and reranks them with a hosted reranker (Cohere as shipped, with a key).

What you add yourself: a Chat Trigger in `session` mode in place of the text input, the workflow and its knowledge base in the right project, a real embedder and model, the Output Guardrail, a way to keep documents current, and the golden set. The recipes have the import steps.

In the live demo, the citations workflow opens in the studio's editor so you can read its wiring. It has no recorded run, and the demo does not answer questions.

<TryInDemo workflow="wf-rag-with-citations-flow" />

Related jobs: answering a [security questionnaire](/learn/use-cases/security-questionnaire-agent) is the same retrieval with a review step, and a [research agent with citations](/learn/use-cases/research-agent-with-citations) adds a supervisor. A [Slack assistant](/learn/use-cases/slack-assistant-with-tools) is a natural front door for the same knowledge base.

## Further reading

- [Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401) (arxiv.org): Lewis et al., 2020, the RAG paper
- [Knowledge bases](/nodes/knowledge-bases): uploads, hybrid search, citations and RAG scorers
- [Authentication and RBAC: what a running workflow can reach](/security/auth-rbac#what-a-running-workflow-can-reach)
- [Hybrid search and reranking recipe](/recipes/hybrid-search-rerank)
- [AI agent evals](/learn/testing/agent-evals)
