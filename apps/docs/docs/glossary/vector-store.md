---
title: "Vector store: search by meaning for RAG"
term: "Vector store"
topic: agents
definition: "A database that keeps embeddings (lists of numbers that stand for the meaning of text chunks) and returns the chunks whose embeddings are nearest to a query's."
description: "A vector store keeps embeddings of text chunks and returns the nearest ones to a query. How it fits RAG, what it costs, and where it fails."
related: [rag, hybrid-search, grounding, agent-memory]
guide: [/learn/security/owasp-llm-top-10]
---

# Vector store

**A database that keeps embeddings (lists of numbers that stand for the meaning of text chunks) and returns the chunks whose embeddings are nearest to a query's.**

A vector store is the search engine behind most <Term id="rag">RAG</Term> pipelines. At ingest, each document is split into chunks and an embedding model turns each chunk into a vector. At query time, the same model turns the question into a vector, and the store returns the chunks closest to it, often by cosine similarity. Texts with similar meaning land near each other even when they share no words.

Three things follow from how it works:

- **Same model on both sides.** Vectors from different embedding models are not comparable, so a query must use the model the chunks were indexed with.
- **Costs.** Every chunk is embedded once at ingest, and every query is embedded again. Storage grows with chunks times dimensions. Large stores use special indexes to avoid comparing the query with every vector.
- **Blind spots.** Meaning-based search is weak on exact strings such as error codes, part numbers and names. <Term id="hybrid-search">Hybrid search</Term> adds a keyword search for those.

## Example

A helpdesk store holds a chunk that says "To regain access, use the recovery link on the sign-in page". A user asks "I can't log in". The two share almost no words, but their vectors are close, so the store returns that chunk and the model answers from it.

## Common confusion

A vector store is not the embedding model: the model makes the vectors, the store keeps and searches them. It is also not a source of truth. It returns what is similar, not what is correct or current, and it will return a stale or planted chunk as readily as a good one. OWASP lists vector and embedding weaknesses as LLM08 and recommends "permission-aware vector and embedding stores", so one user's search cannot return another's documents.

## In L2M

[Knowledge bases](/nodes/knowledge-bases) are a built-in vector store in the L2M database, with no extra service, meant for up to about 10,000 chunks each. The RAG Retrieve node searches them, or an external store such as pgvector, Qdrant or Azure AI Search ([vector store nodes](/nodes/vector-stores)). A knowledge base fixes its vector length at the first ingest and refuses chunks of another length.

## Further reading

- [OWASP LLM08:2025 Vector and Embedding Weaknesses](https://genai.owasp.org/llmrisk/llm082025-vector-and-embedding-weaknesses/) (owasp.org)
