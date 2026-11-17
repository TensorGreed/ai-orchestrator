---
title: "Research agent that cites its sources"
sidebarTitle: "Research with citations"
description: "A supervisor and worker agents research a question over your sources and return claims with checkable citations, plus a test that catches made-up sources."
level: intermediate
demo: wf-demo-research-swarm
demoRecorded: true
related: [supervisor-agent, worker-agent, grounding, rag, eval]
---

# Research agent that cites its sources

A research agent with citations answers a question in a few paragraphs, and every claim carries a marker such as `[2]` that points at the passage it came from. The design that works is to fix the set of sources first, let a supervisor agent plan and delegate checks to worker agents, then resolve every marker against the sources and fail the run when a claim cites a source that does not exist or does not support it. L2M gives you the parts: a knowledge base with hybrid retrieval, the Supervisor node, Extract Citations, and a grounding check.

## The job

| | |
|---|---|
| **Input** | A research question ("What changed in our incident process this year, and why?") |
| **Sources** | Documents you chose: reports, papers, notes, web pages you saved, in a knowledge base |
| **Output** | A short brief whose claims end in `[N]` markers, each resolved to a chunk id and source id |
| **Never** | A citation to a source that was not retrieved, or a claim its cited source does not support |

Made-up and mismatched citations are a measured problem, not a rare one. The ALCE benchmark by Gao et al. scores cited answers along "fluency, correctness, and citation quality", and reports that "on the ELI5 dataset, even the best models lack complete citation support 50% of the time". A research agent therefore needs a citation check built into the run, not just a prompt that asks for citations.

**Why a supervisor here, and when not.** A single retrieve-then-answer workflow handles "what does our policy say about X". Research questions are wider: they have parts (what changed, when, why, what it costs), some parts need arithmetic, and a draft benefits from a second pass that checks claims against the sources. A <Term id="supervisor-agent">supervisor</Term> that delegates those parts to narrow <Term id="worker-agent">workers</Term> fits that shape. It also costs more model calls and is harder to test. If your questions are narrow, use the [internal docs Q&A](/learn/use-cases/internal-docs-qa-agent) design instead; [supervisor and workers](/learn/agents/supervisor-and-workers) explains the pattern in depth.

## The design

<figure class="recipe-diagram">
<svg viewBox="0 0 800 220" role="img" aria-labelledby="rac-title rac-desc" xmlns="http://www.w3.org/2000/svg"><title id="rac-title">Research supervisor with a citation check</title><desc id="rac-desc">A Text Input question goes to RAG Retrieve, which finds numbered passages in a knowledge base. The Supervisor Node gets the passages and the question, uses its own chat model, and can delegate to a checker worker and an analyst worker; the analyst has a calculator MCP tool. Extract Citations resolves the supervisor's markers against the retrieved passages, and an Output Guardrail with the grounding check fails the run on a citation that resolves to nothing or does not support its claim.</desc><path class="rd-edge" d="M140 47 L170 47"/><path class="rd-edge" d="M300 47 L330 47"/><path class="rd-edge" d="M460 47 L490 47"/><path class="rd-edge" d="M620 47 L650 47"/><path class="rd-edge" d="M235 20 L235 8 L555 8 L555 20"/><path class="rd-edge is-port" d="M395 74 L395 112 L235 112 L235 150"/><path class="rd-edge is-port" d="M395 74 L395 150"/><path class="rd-edge is-port" d="M395 112 L555 112 L555 150"/><path class="rd-edge is-port" d="M620 177 L650 177"/><g class="rd-node" data-kind="step" transform="translate(10 20)"><rect width="130" height="54" rx="10"/><text class="rd-name" x="10" y="22">Question</text><text class="rd-type" x="10" y="40">text_input</text></g><g class="rd-node" data-kind="step" transform="translate(170 20)"><rect width="130" height="54" rx="10"/><text class="rd-name" x="10" y="22">Sources</text><text class="rd-type" x="10" y="40">rag_retrieve</text></g><g class="rd-node" data-kind="agent" transform="translate(330 20)"><rect width="130" height="54" rx="10"/><text class="rd-name" x="10" y="22">Supervisor</text><text class="rd-type" x="10" y="40">supervisor_node</text></g><g class="rd-node" data-kind="step" transform="translate(490 20)"><rect width="130" height="54" rx="10"/><text class="rd-name" x="10" y="22">Citations</text><text class="rd-type" x="10" y="40">extract_citations</text></g><g class="rd-node" data-kind="step" transform="translate(650 20)"><rect width="130" height="54" rx="10"/><text class="rd-name" x="10" y="22">Grounding check</text><text class="rd-type" x="10" y="40">output_guardrail</text></g><g class="rd-node" data-kind="model" transform="translate(170 150)"><rect width="130" height="54" rx="10"/><text class="rd-name" x="10" y="22">Chat model</text><text class="rd-type" x="10" y="40">llm_call</text></g><g class="rd-node" data-kind="agent" transform="translate(330 150)"><rect width="130" height="54" rx="10"/><text class="rd-name" x="10" y="22">checker</text><text class="rd-type" x="10" y="40">agent_orchestrator</text></g><g class="rd-node" data-kind="agent" transform="translate(490 150)"><rect width="130" height="54" rx="10"/><text class="rd-name" x="10" y="22">analyst</text><text class="rd-type" x="10" y="40">agent_orchestrator</text></g><g class="rd-node" data-kind="tool" transform="translate(650 150)"><rect width="130" height="54" rx="10"/><text class="rd-name" x="10" y="22">calculator</text><text class="rd-type" x="10" y="40">mcp_tool</text></g></svg>
<figcaption>Solid lines are the run order; Sources also feeds Citations directly. Dashed lines are attachments: the supervisor's chat model and workers, and the analyst's tool. Each worker has its own chat model too (not drawn).</figcaption>
</figure>

### 1. Fix the sources before the agent writes

Put the material in a knowledge base first: upload the reports and notes, and for web pages, save the text of the pages you decided to trust and upload it with the page's URL as the `sourceId`. Then one RAG Retrieve step with `searchMode: "hybrid"` and a `topK` of 6 to 10 gives the supervisor a numbered list of passages, and the same list feeds Extract Citations.

Why not let workers browse the open web and cite URLs? You can attach read-only fetch or search tools, but Extract Citations resolves `[N]` markers against a list of retrieved documents, normally a RAG Retrieve or Rerank step's output, and the Output Guardrail's grounding check compares the answer only with the documents of the Retrieve or Rerank steps upstream, not with what a tool fetched. A URL a worker quotes from a fetched page is then just text in the answer: nothing in the run checks that the page says what the claim says. Keeping "gather" and "answer" apart also gives a person the chance to drop a bad source before anything cites it.

### 2. The supervisor and its workers

- **Supervisor** (`supervisor_node`): its user prompt holds the citation instructions, the numbered passages and the question. Its system prompt says: plan the parts, delegate checks and arithmetic, then write the brief and cite only the numbered passages. Give it a `maxIterations` above the workers' (the node's sample config uses 10).
- **checker** (`agent_orchestrator`, no tools): given one draft claim and the passage it cites, it says whether the passage supports it. The supervisor must put both into the `task_prompt`, because a worker does not see the supervisor's conversation.
- **analyst** (`agent_orchestrator`, a calculator MCP tool): does the arithmetic, so the brief does not carry a number the model estimated.

**How workers get their task.** Connect the question to the retrieve step and write the supervisor's prompt with the retrieve step's `query` field. A worker's user prompt is always the `task_prompt` the supervisor wrote, even when an upstream step outputs a `user_prompt` of its own (a Text Input does); the worker can still read the supervisor's other input fields in its templates. On our test install the checker worker received its task: "Check this draft claim against source [1]: the reset link is valid for 30 minutes."

Every tool here only reads. If you add tools from a server that also has write tools, turn on the workflow's **No write tools** setting, which blocks every tool the [MCP tool policy](/product/mcp-tool-policy#no-write-tools) counts as a write tool. A research agent needs an approval only when it publishes something: put an Approval Gate on the step that posts the brief to a channel or a wiki, so a person reads it first ([approval gates](/product/approvals)).

### 3. Resolve and check every citation

Extract Citations reads the supervisor's `answer` and the retrieve step's `documents` and returns each marker with its `chunkId`, `sourceId` and the cited text. Then an Output Guardrail with `checks: ["grounding"]` and `onFail: "error"` checks each claim against the passage it cites ([grounding in sources](/product/content-rules-output-checks#grounding-in-sources)).

We ran this design on a local install with a scripted stand-in model, so the answers were fixed text, not a real model's. The knowledge base held three passages: password reset, billing, and an error code. The results:

| Supervisor's final answer | Extract Citations | Grounding check |
|---|---|---|
| Correct claims citing `[1]` and `[2]` | 3 citations, 2 documents | Passed |
| A correct claim citing `[3]`, the billing passage, instead of `[2]` | 3 citations | Failed the run |
| A claim citing `[7]`, with three passages | Only the `[1]` resolved; `[7]` silently skipped; `hasCitations: true` | Failed the run |
| "The reset link is valid for 24 hours and arrives by text message" citing `[2]`, the error-code passage | 1 citation | Failed the run |

The third row is the lesson: `hasCitations` alone does not catch an invented source, because one real marker is enough to make it `true`. The <Term id="grounding">grounding</Term> check does. It compares words, so it misses a claim that changes one figure in an otherwise matching sentence and can flag a fair paraphrase; turn on `grounding.requireCitations` when every sentence must carry a marker.

## How to test it

Research answers vary in wording, so test what must not vary: which sources are cited, that every marker resolves, and that the run passes the grounding check. An <Term id="eval">eval</Term> built on a golden set does that ([golden sets](/product/golden-sets), [AI agent evals](/learn/testing/agent-evals)):

| Case | Input | A pass |
|---|---|---|
| Single-source fact | A question one passage answers | Cites that passage; run status `success` |
| Two-part question | A question whose parts sit in two documents | Cites both; the trace shows the right workers called |
| Arithmetic | "How many uncached lookups a day at 1,250 queries and an 18% miss rate?" | 225, with the delegation to the analyst in the trace |
| Not in the sources | A question no passage answers | Says the sources do not cover it; no marker |
| Planted conflict | Two passages that disagree on a date | Cites both and names the conflict |

Score with `status` (a grounding failure fails the run, so a case that starts inventing sources fails here), `regex` or `contains` for required source ids, and an `llm_judge` rubric for the brief's quality (see [LLM as judge](/glossary/llm-as-judge) for its biases and how to calibrate it). `faithfulness` asks a judge model whether each claim is supported by the retrieved passages. A replay of a recorded run answers the retrieval and the MCP calls from the recording and reruns the models, so it isolates a prompt or model change ([regression testing agents](/learn/testing/regression-testing-agents)).

## What it costs to run

Count model calls. In our run the supervisor made two calls (one delegation, one final answer) and the checker one: three in all. Each delegation adds at least one worker call, and each round of delegation adds a supervisor call. Tokens grow faster than calls: the numbered passages sit in the supervisor's prompt and are sent again on every supervisor iteration, and each worker's full output, including its steps, comes back into the supervisor's context. Keep `topK` modest, cap each agent's `maxIterations`, lower `toolMessageMaxChars` on the supervisor if worker outputs are long, and set a [budget](/product/budgets) so a confused supervisor that keeps delegating cannot run up spend.

## Starting point, honestly

Two recipes cover the parts; you combine them.

- [Supervisor and worker agents](/recipes/supervisor-worker-agents) (`supervisor-worker-swarm-flow.json`): a supervisor with a researcher worker (a mock knowledge-base tool) and a computer worker (calculator and clock), on the echo model and the bundled mock MCP server. Echo never asks for a tool, so as shipped the supervisor answers on its first turn and delegates nothing. It has no retrieval step and no citations.
- [RAG with citations](/recipes/rag-with-citations) (`rag-with-citations-flow.json`): retrieve, citation prompt, LLM, Extract Citations. No agents.

To build the design above: start from the citations sample, replace its prompt and LLM with a Supervisor whose user prompt holds the passages and the citation instructions, attach the workers and their chat models, wire the retrieve step into Extract Citations, add the Output Guardrail, and use a real chat model on each agent. The recipes have the import steps.

The live demo's research team shows delegation: a supervisor sends a lookup to a researcher with a knowledge-base tool and a sum to an analyst with a calculator, then writes a summary. Its recorded run uses a scripted stand-in model, and it has no citation step.

<TryInDemo workflow="wf-demo-research-swarm" recorded />

Related jobs: the [security questionnaire agent](/learn/use-cases/security-questionnaire-agent) uses the same citation check one question at a time, and an [incident triage agent](/learn/use-cases/incident-triage-agent) uses a supervisor to gather evidence.

## Further reading

- [Enabling Large Language Models to Generate Text with Citations](https://arxiv.org/abs/2305.14627) (arxiv.org): Gao et al., 2023, the ALCE benchmark
- [Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401) (arxiv.org): Lewis et al., 2020
- [Multi-agent systems: supervisor and worker agents](/learn/agents/supervisor-and-workers)
- [Knowledge bases: citations](/nodes/knowledge-bases#citations-phase-9-4)
- [Output checks: grounding in sources](/product/content-rules-output-checks#grounding-in-sources)
