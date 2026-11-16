---
title: "RAG vs long context windows: trade-offs"
sidebarTitle: "RAG vs long context"
description: "When to retrieve a few chunks and when to put whole documents in the prompt: cost, latency, accuracy in the middle of long inputs, and access control."
level: intermediate
about: context-window
related: [context-window, rag, token-llm, vector-store, hybrid-search, grounding]
---

# RAG vs long context

With a large <Term id="context-window">context window</Term>, you can skip retrieval and put whole documents in the prompt. With <Term id="rag">retrieval-augmented generation (RAG)</Term>, you search first and send only the few passages that match the question. Long context is simpler to build and does not miss a passage the search failed to find, but every call pays for every token, and models use text in the middle of a long input less reliably than text at the start or end. RAG costs a search and some engineering, and it fails when retrieval misses, but each call is small, cheap and limited to what the caller may see. A rough rule: if the material is small, fixed and readable by everyone who asks, put it in the prompt; if it is large, changing or permissioned, retrieve.

## What "long context" means here

A model's context window is the most text, counted in <Term id="token-llm">tokens</Term>, that one call can read: the system prompt, the conversation, tool definitions, tool results and any documents you add. Windows have grown large enough that a contract, a product manual or a small code base can fit in one call. The question this page answers is narrow: given a window that can hold the material, should you send all of it, or retrieve a part?

<figure>
<svg viewBox="0 0 640 240" role="img" aria-labelledby="rlc-fig-title rlc-fig-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:640px">
  <title id="rlc-fig-title">What each approach puts in the prompt</title>
  <desc id="rlc-fig-desc">Left: with long context, the prompt holds the question and every document, so the relevant passage may sit in the middle of a long input. Right: with RAG, a search picks three passages, and the prompt holds only the question and those passages.</desc>
  <g font-family="inherit" font-size="13" fill="currentColor">
    <text x="150" y="20" text-anchor="middle">Long context</text>
    <rect x="40" y="30" width="220" height="200" rx="8" fill="none" stroke="currentColor"/>
    <text x="150" y="52" text-anchor="middle" font-size="12">Question</text>
    <rect x="55" y="62" width="190" height="22" rx="4" fill="none" stroke="currentColor" stroke-dasharray="4 3"/>
    <rect x="55" y="90" width="190" height="22" rx="4" fill="none" stroke="currentColor" stroke-dasharray="4 3"/>
    <rect x="55" y="118" width="190" height="22" rx="4" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="150" y="134" text-anchor="middle" font-size="12">the passage that matters</text>
    <rect x="55" y="146" width="190" height="22" rx="4" fill="none" stroke="currentColor" stroke-dasharray="4 3"/>
    <rect x="55" y="174" width="190" height="22" rx="4" fill="none" stroke="currentColor" stroke-dasharray="4 3"/>
    <text x="150" y="217" text-anchor="middle" font-size="12">every document, every call</text>
    <text x="480" y="20" text-anchor="middle">RAG</text>
    <rect x="310" y="60" width="110" height="40" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="365" y="85" text-anchor="middle">Search</text>
    <rect x="310" y="140" width="110" height="40" rx="8" fill="none" stroke="currentColor" stroke-dasharray="4 3"/>
    <text x="365" y="165" text-anchor="middle" font-size="12">Index</text>
    <path d="M365 100 L365 140" stroke="currentColor" fill="none"/>
    <rect x="460" y="30" width="160" height="130" rx="8" fill="none" stroke="currentColor"/>
    <text x="540" y="52" text-anchor="middle" font-size="12">Question</text>
    <rect x="475" y="62" width="130" height="22" rx="4" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <rect x="475" y="90" width="130" height="22" rx="4" fill="none" stroke="currentColor" stroke-dasharray="4 3"/>
    <rect x="475" y="118" width="130" height="22" rx="4" fill="none" stroke="currentColor" stroke-dasharray="4 3"/>
    <text x="540" y="180" text-anchor="middle" font-size="12">top 3 passages</text>
    <path d="M420 80 L460 80" stroke="currentColor" fill="none"/>
  </g>
</svg>
<figcaption>Long context sends everything and relies on the model to find the passage. RAG relies on the search to find it and sends little else.</figcaption>
</figure>

## Accuracy: lost in the middle

A larger window does not mean the model uses all of it equally. Liu et al. tested this in "Lost in the Middle" (2023) on two tasks, "multi-document question answering and key-value retrieval". They found that "performance is often highest when relevant information occurs at the beginning or end of the input context", and that it "significantly degrades when models must access relevant information in the middle of long contexts", "even for explicitly long-context models".

The models tested in 2023 are not today's models, and newer ones may do better on this test. The practical lesson still holds: fitting in the window is not the same as being used. If you choose long context, test with the answer placed at different depths of the input, not only at the top. If you choose RAG, the problem shrinks, because the prompt is short and the best passages can go first.

RAG has its own accuracy failure, and it is the mirror image. Long context never misses a passage that was sent; RAG can fail to retrieve the passage at all, and then the model answers from nothing or guesses. <Term id="hybrid-search">Hybrid search</Term> (keywords plus vectors) and reranking reduce misses, and a retrieval evaluation tells you how often they happen.

## Cost and latency

Input tokens are billed on every call. A 200-page manual sent with every question costs the same each time, whether the question needs one page or all of them. In an agent, the cost multiplies: each iteration of the <Term id="agent-loop">agent loop</Term> sends the conversation again, so a large document added at the start is paid for on every model call of the run.

Prompt caching softens this. When the same prefix is sent again, some providers reuse the work: Anthropic's documentation says caching lets "the API resume from specific prefixes in your prompts", and that cache reads are billed at a fraction of the base input price, with writes billed above it and a default lifetime of five minutes. Caching helps most when many calls share an identical, large prefix within that window, for example a batch of questions about one contract. It does not help when each user's documents differ, and the model still reads every token, so it does not fix the middle-of-the-input problem.

Latency follows input size too: a model has to read the whole prompt before it starts answering. A search adds its own step, usually small next to a long model read, but it is not free, and a reranker adds another call.

## Access control and data handling

This is the row teams forget. Whatever is in the prompt is visible to the model for that call, and can come back out in the answer. With long context, the simplest build puts the same documents in every user's prompt, so every user can, in principle, get any of them back. Per-user prompts are possible, but then you are choosing documents per caller, which is retrieval by another name.

RAG puts the decision before the prompt: search only the collection, or the filtered subset, that this caller may read. It also keeps sensitive text out of calls that do not need it, which shortens what lands in traces and provider logs (see [keeping personal data out of prompts](/learn/security/sensitive-data-in-prompts)). Retrieved text is still outside content, though. A poisoned document can carry instructions, a form of <Term id="indirect-prompt-injection">indirect prompt injection</Term>, and that risk is the same whichever way the text reaches the prompt.

## The comparison

| Question | Long context | RAG |
| --- | --- | --- |
| Build effort | Low: read the files, put them in the prompt | Higher: chunk, embed, index, tune the search |
| Misses a relevant passage? | No, if it was sent | Yes, when retrieval fails |
| Uses what it was sent? | Less reliably in the middle of long inputs | Short prompt; best passages first |
| Cost per call | Grows with all the material, every call | Grows with the passages sent, plus a search |
| Latency | Grows with input length | A search step, then a short read |
| Corpus size | Bounded by the window | Bounded by the index, not the window |
| Fresh content | Re-read the files | Re-ingest the changed documents |
| Who sees what | Everyone gets what is in the prompt | Search only what the caller may read |
| Citations | Possible, by section or page | Each passage carries its source id |

## When to use which

**Put it in the prompt** when the material is small and stable, every caller may read all of it, and the task needs the whole thing at once: summarising one contract, comparing two policies clause by clause, answering questions about a single uploaded file. Retrieval would only add a way to miss.

**Retrieve** when the corpus is larger than you want to pay for on each call, or larger than the window; when it changes often; when different callers may see different parts; or when you need answers tied to a source.

**Do both** for a common middle case: retrieve to pick the right few documents, then send those documents whole rather than as small chunks. The search does the narrowing, and the model gets enough surrounding text to reason about each one.

And for agents, there is another option for live data: neither copy it into the prompt nor into an index, but give the agent a tool that fetches exactly the record it needs. Large tool results raise the same cost and middle-of-the-input questions as long context, so return what the model needs, not everything.

### An example

A legal team asks questions about 4,000 contracts. Sending all of them is not possible. RAG finds the five contracts that mention the supplier in question. For the follow-up, "summarise the termination terms of this one contract", the team sends that one contract whole: it is 30 pages, and the question needs all of it.

## In L2M

L2M supports both shapes in a workflow.

- **Long context.** A **Prompt Template** node can place a whole document from an earlier step in the prompt with <span v-pre>`{{results.<nodeId>.field}}`</span> ([templates and expressions](/runtime/templates-and-expressions)), and an **LLM Call** node sends that prompt without shortening it; the window limit is the provider's. Agents are different: the agent loop caps its system prompt at 8,000 characters and the user prompt and each kept message at 3,000 ([agent loop limits](/runtime/agent-loop)). For one long document, use an LLM Call step, not an agent's prompt.
- **Retrieval.** **RAG Retrieve** searches a [knowledge base](/nodes/knowledge-bases) by vector, keyword or hybrid search, or an external [vector store](/nodes/vector-stores) by vector search, and returns `topK` passages, 3 by default, as `documents` and a numbered `context` for the prompt. A **Rerank** node can reorder a larger candidate list and keep the best few.
- **Tool results in agents.** The agent loop also caps each tool result it sends to the model (`toolMessageMaxChars`, 6,000 characters by default) and compacts larger results first, so an agent reads documents through retrieval or tools in small pieces. With a session id, full results stay in the session tool cache instead of the prompt.
- **Cost.** Each model call's token counts show on the node's trace, and optional [budgets](/product/budgets) cap spend or tokens per scope. Comparing the same question both ways on the trace is a quick way to see what long context costs you.

## Try it in L2M

The [RAG knowledge base recipe](/recipes/rag-knowledge-base) runs retrieval with no API key, and the [hybrid search and rerank recipe](/recipes/hybrid-search-rerank) shows the retrieve-many, keep-few pattern. To choose between retrieval and training a model, see [RAG vs fine-tuning](/learn/agents/rag-vs-fine-tuning); for how an agent keeps a conversation within its window, see [agent memory](/learn/agents/agent-memory).

## Further reading

- [Liu et al., Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172) (arXiv 2307.03172, 2023; TACL, 2024)
- [Lewis et al., Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401) (arXiv 2005.11401, 2020)
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) (Anthropic docs): prefix caching, cache lifetime and pricing
- In L2M: [Knowledge bases](/nodes/knowledge-bases), [Agent loop](/runtime/agent-loop), [LLM cost control](/learn/operations/llm-cost-control)
