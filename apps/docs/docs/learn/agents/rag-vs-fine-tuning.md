---
title: "RAG vs fine-tuning for agents: which to use"
sidebarTitle: "RAG vs fine-tuning"
description: "RAG adds knowledge at query time; fine-tuning changes model behaviour. Cost, freshness, access control and evaluation compared, with a decision table."
level: intermediate
about: rag
related: [rag, vector-store, grounding, hybrid-search, eval, context-window]
---

# RAG vs fine-tuning

<Term id="rag">Retrieval-augmented generation (RAG)</Term> and fine-tuning solve different problems. RAG looks up documents when a question arrives and puts the relevant passages in the prompt, so the model answers from text you control and can cite. Fine-tuning trains an existing model further on your examples, so its weights change and it behaves differently on every call: a fixed output format, a house tone, a narrow classification task done reliably by a smaller model. Use RAG when the model needs to *know* something that changes, is private, or must be traceable to a source. Use fine-tuning when the model needs to *do* something in a consistent way that prompting alone does not get right. Many teams need neither, and some need both.

## Two places to put knowledge

The original RAG paper (Lewis et al., 2020) frames the choice well. A pre-trained model stores facts in its weights, its "parametric" memory. RAG adds a second, "non-parametric" memory: in the paper, "a dense vector index of Wikipedia, accessed with a pre-trained neural retriever". The authors point at the weakness of weights alone: "providing provenance for their decisions and updating their world knowledge remain open research problems."

That sentence is the core of the comparison. Facts held in weights cannot point to where they came from, and changing them means training again. Facts held in an index can be cited, replaced and deleted one document at a time.

<figure>
<svg viewBox="0 0 640 250" role="img" aria-labelledby="rft-fig-title rft-fig-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:640px">
  <title id="rft-fig-title">Where RAG and fine-tuning act</title>
  <desc id="rft-fig-desc">Top row, at query time: a question goes to a retriever, which reads an index of your documents and adds the top passages to the prompt sent to the model. Bottom row, before deployment: training examples go into a training job that produces new model weights, which the model then uses on every call.</desc>
  <g font-family="inherit" font-size="13" fill="currentColor">
    <text x="20" y="22" font-size="12">At query time (RAG)</text>
    <rect x="20" y="35" width="120" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="80" y="60" text-anchor="middle">Question</text>
    <rect x="180" y="35" width="130" height="40" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="245" y="60" text-anchor="middle">Retriever</text>
    <rect x="180" y="105" width="130" height="36" rx="8" fill="none" stroke="currentColor" stroke-dasharray="4 3"/>
    <text x="245" y="128" text-anchor="middle" font-size="12">Index of your docs</text>
    <rect x="350" y="35" width="130" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="415" y="60" text-anchor="middle">Prompt + passages</text>
    <rect x="520" y="85" width="100" height="60" rx="8" fill="none" stroke="currentColor"/>
    <text x="570" y="120" text-anchor="middle">Model</text>
    <path d="M140 55 L180 55" stroke="currentColor" fill="none"/>
    <path d="M245 75 L245 105" stroke="currentColor" fill="none"/>
    <path d="M310 55 L350 55" stroke="currentColor" fill="none"/>
    <path d="M480 55 L540 85" stroke="currentColor" fill="none"/>
    <text x="20" y="182" font-size="12">Before deployment (fine-tuning)</text>
    <rect x="20" y="195" width="150" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="95" y="220" text-anchor="middle">Training examples</text>
    <rect x="210" y="195" width="130" height="40" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="275" y="220" text-anchor="middle">Training job</text>
    <rect x="380" y="195" width="120" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="440" y="220" text-anchor="middle">New weights</text>
    <path d="M170 215 L210 215" stroke="currentColor" fill="none"/>
    <path d="M340 215 L380 215" stroke="currentColor" fill="none"/>
    <path d="M500 215 L570 145" stroke="currentColor" fill="none"/>
  </g>
</svg>
<figcaption>RAG changes what the model reads on each call. Fine-tuning changes the model itself, once, before it is used.</figcaption>
</figure>

## What fine-tuning is for

Provider documentation is consistent about what fine-tuning does well, and it is mostly about behaviour, not facts:

- OpenAI's model optimization guide says fine-tuning can "enable a model to consistently format responses in a certain way", and that you can "train a smaller, cheaper, faster model to excel at a particular task". It also names shorter prompts as a benefit, since examples baked into the weights no longer need to be sent on each call.
- Google's Vertex AI tuning guide recommends supervised fine-tuning for "Strict output formatting, classification, sentiment analysis, entity extraction, and domain-specific style or tone", and says it suits cases where "the output of your model isn't complex". Its typical dataset size is "Hundreds to thousands of labeled examples".

Both guides put evaluation and prompting first. OpenAI's describes optimization as "a combination of evals, prompt engineering, and fine-tuning" and starts with evals that establish a baseline; it also notes that "The prompt engineering process may be all you need". Provider offerings change, too: as of November 2026 that same guide says "OpenAI is winding down the fine-tuning platform" and that it is closed to new users. Check what your provider offers before you plan around it.

Neither guide presents fine-tuning as a way to load a knowledge base into a model. That is the job RAG was designed for.

## The comparison

| Question | RAG | Fine-tuning |
| --- | --- | --- |
| What changes? | The prompt, on each call | The model's weights, once per training run |
| What it is good at | Facts, documents, policies, anything you must cite | Format, tone, classification, a narrow task done by a smaller model |
| Updating a fact | Re-ingest or delete one document; live on the next query | Build new examples, train again, re-test, redeploy |
| Showing the source | Each passage carries its document id, so answers can cite | Weights cannot say where an answer came from |
| Who may see what | Retrieval can be limited per audience; text never enters the model | Anything trained in is available to everyone who can call the model |
| Removing data | Delete the chunks | Retrain without them; the old model may still be deployed |
| Up-front work | Ingest, chunk, embed, tune retrieval | Collect and label hundreds of examples or more, run training |
| Cost per call | Extra input tokens for the passages, plus a search | Often lower: shorter prompts, possibly a smaller model |
| What to evaluate | Retrieval (did the right passage come back?) and the answer | The answer, against a baseline of the untuned model |
| Failure mode | The right passage is not found, or the model ignores it | The model learns the wrong habit, or forgets a general skill |

Two rows deserve more words.

**Access control.** In a RAG system, permissions are a property of the index and the query: one team's documents can live in a separate collection, or carry metadata that a filter excludes. A fine-tuned model has no such boundary. If HR tickets went into the training set, any caller who can reach the model can, in principle, coax that text back out. Train only on data every caller of the model is allowed to see.

**Removing data.** A request to delete a person's data, or a document that turns out to be wrong, is a delete in an index. In a fine-tuned model it is a new training run, and until the old model is retired, the old behaviour is still live.

## When to use which

Work down this list and stop at the first answer that fits.

1. **Better instructions and a few examples in the prompt.** If a clear system prompt and three examples fix the problem, you are done.
2. **RAG** when the model lacks information: product documentation, a policy that changed last week, a customer's contract, the ticket history. Also when you must show the source, or when different users may see different documents.
3. **Fine-tuning** when the model has the information but behaves wrongly in a consistent way you can show with examples: it will not keep to a JSON shape, it labels tickets inconsistently, or a large model does a narrow task well and you want a smaller, cheaper one to do the same.
4. **Neither** when the answer must come from a live system. A stock level or an order status belongs in a tool the agent calls, not in an index that is a copy, and not in weights.

The last point matters most for agents. An <Term id="ai-agent">AI agent</Term> can call tools, so it often does not need knowledge copied anywhere: it can ask the system that owns the data, with the caller's permissions, at the moment it needs it.

### A worked example

A support team wants an assistant that answers questions about their product and tags each ticket with one of 40 categories.

- **Product answers** change with every release, must link to the help article, and some articles are for enterprise customers only. That is RAG: index the help centre, keep enterprise articles in their own collection, and require citations.
- **Ticket tagging** is a fixed classification task. The team has 6,000 tickets tagged by hand. If a prompt with the category list and examples tags poorly, a small fine-tuned classifier is a reasonable next step, judged against the hand-tagged set.
- **Order status** is a live lookup. Neither technique applies; give the agent a read-only tool.

## Using both

RAG and fine-tuning combine without conflict. A model fine-tuned to answer in your support format, cite passages as `[1]` and refuse when the context is empty can then be given retrieved passages at query time. The fine-tuning shapes *how* it uses the context; RAG supplies *what* it reads. Keep the two evaluations apart: when answers get worse, you want to know whether retrieval stopped finding the passage or the model stopped using it.

## RAG in L2M (L2M does not fine-tune)

L2M runs RAG pipelines; it does not train or fine-tune models. A model you fine-tuned with a provider is, to L2M, a model like any other: a chat model node calls it by the model id or Azure deployment name your provider gives it, and [model allowlists](/security/model-allowlists) can limit which models workflows may use.

For the retrieval side:

- **[Knowledge bases](/nodes/knowledge-bases)** are a built-in <Term id="vector-store">vector store</Term> in the L2M database. Upload text, Markdown, HTML, CSV or JSON; L2M chunks and embeds it. Deleting a source (`DELETE /api/knowledge-bases/:id/sources/:sourceId`) removes its chunks, so a corrected document is a re-upload, not a training run.
- **RAG Retrieve** searches a knowledge base by vector, keyword (BM25) or <Term id="hybrid-search">hybrid</Term> search, returns `topK` passages (3 by default) as `documents` and a numbered `context`, and can feed a **Rerank** node. External stores such as Qdrant, pgvector and Azure AI Search plug into the same node.
- **Citations.** RAG Retrieve also emits `citationInstructions` for the prompt, and the **Extract Citations** node maps `[N]` markers in the answer back to chunk and source ids.
- **Access.** A knowledge base that belongs to a project can only be used by workflows in that project ([project access](/security/auth-rbac#project-access)). Within one knowledge base, a search covers every chunk; there is no per-chunk filter. Give each audience its own knowledge base, or use an external store whose filter you set on the node (Qdrant's `filter`).
- **Evaluation.** RAG-aware scorers check retrieval and answers separately: `context_precision` and `context_recall` are programmatic, and `faithfulness` and `answer_relevance` use a judge model (see [agent evals](/learn/testing/agent-evals)).

## Try it in L2M

The [RAG knowledge base recipe](/recipes/rag-knowledge-base) builds a knowledge base and a retrieval workflow that run with no API key. The [RAG with citations recipe](/recipes/rag-with-citations) adds numbered sources to the answer. When you are weighing whether to retrieve at all or to put whole documents in the prompt, read [RAG vs long context](/learn/agents/rag-vs-long-context).

## Further reading

- [Lewis et al., Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401) (arXiv 2005.11401, 2020): parametric and non-parametric memory
- [Model optimization](https://developers.openai.com/api/docs/guides/model-optimization) (OpenAI API docs): evals, prompting and fine-tuning, and the fine-tuning platform's status
- [Tune Gemini models](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/tune-models) (Google Cloud Vertex AI docs): when supervised fine-tuning fits and how much data it needs
- In L2M: [Knowledge bases](/nodes/knowledge-bases), [Vector stores](/nodes/vector-stores), glossary: <Term id="grounding">grounding</Term>, <Term id="context-window">context window</Term>
