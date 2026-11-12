---
title: "RAG (retrieval-augmented generation) explained"
term: "RAG (retrieval-augmented generation)"
topic: agents
definition: "A pattern that first retrieves documents relevant to a question and puts them in the prompt, so the model answers from that text instead of from memory alone."
description: "RAG fetches relevant documents and puts them in the prompt so the model answers from them. The pipeline, citations, and where it goes wrong."
related: [context-window, indirect-prompt-injection]
---

# RAG (retrieval-augmented generation)

**A pattern that first retrieves documents relevant to a question and puts them in the prompt, so the model answers from that text instead of from memory alone.**

A model only knows what was in its training data, and it cannot say where a fact came from. RAG adds a lookup step. The name comes from a 2020 paper by Lewis and others, which combined a generator with "a dense vector index of Wikipedia, accessed with a pre-trained neural retriever". Today the term covers any pipeline that searches your own content and hands the results to the model.

## The pipeline

1. **Ingest.** Split documents into chunks and store them, usually with an embedding (a vector) per chunk in a vector store.
2. **Retrieve.** Turn the question into the same kind of vector and fetch the nearest chunks. Hybrid search also matches keywords, which catches names and error codes that vectors miss.
3. **Generate.** Put the chunks in the prompt with an instruction to answer only from them, and ideally to cite them.

## Example

A helpdesk bot is asked "How do I reset my password?". Retrieval returns the FAQ chunk about password resets; the prompt says "Use the context to answer"; the model replies with the steps from that chunk and marks it as its source.

## Where it goes wrong

- **Bad retrieval.** The right chunk is never found, so the model answers from nothing, or guesses.
- **Ignored context.** The model answers from memory anyway. Citations make this visible.
- **Poisoned content.** A retrieved document can carry instructions for the model, a form of <Term id="indirect-prompt-injection">indirect prompt injection</Term>. OWASP lists vector and embedding weaknesses as LLM08.

## Common confusion

RAG is not fine-tuning. Fine-tuning changes the model's weights; RAG leaves the model alone and changes the prompt, so new documents count as soon as they are ingested.

## In L2M

[Knowledge bases](/nodes/knowledge-bases) give you a built-in vector store in the L2M database. The RAG Retrieve node searches one by vector, keyword (BM25) or hybrid, and can emit citation instructions; a Rerank node can reorder results. Try it with no API key in the [RAG knowledge base recipe](/recipes/rag-knowledge-base).

## Further reading

- [Lewis et al., Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401) (arXiv, 2020)
- [OWASP Top 10 for LLM Applications 2025](https://genai.owasp.org/llm-top-10/) (owasp.org)
