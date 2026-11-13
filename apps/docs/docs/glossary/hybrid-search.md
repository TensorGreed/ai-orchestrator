---
title: "Hybrid search: keyword plus vector retrieval"
term: "Hybrid search"
topic: agents
definition: "Retrieval that runs a keyword search (such as BM25) and a vector search for the same query, then merges the two ranked lists into one."
description: "Hybrid search combines keyword (BM25) and vector results, often fused with reciprocal rank fusion, then reranked. Why it finds what each misses."
related: [rag, vector-store, grounding]
guide: [/learn/security/owasp-llm-top-10]
---

# Hybrid search

**Retrieval that runs a keyword search (such as BM25) and a vector search for the same query, then merges the two ranked lists into one.**

Each kind of search misses things the other finds. Vector search matches meaning, so "can't log in" finds a chunk about account recovery, but it is weak on exact strings like `E1042`, a part number or a surname. Keyword search ranks by the words a document shares with the query, weighting rare words more (BM25 is the usual formula), so it finds `E1042` at once but misses a paraphrase. Hybrid search runs both.

The two lists cannot be merged by their scores, because a BM25 score and a cosine similarity are on different scales. The common fix is reciprocal rank fusion (RRF), from Cormack, Clarke and Büttcher (SIGIR 2009). It uses only each document's rank in each list:

```
score(d) = sum over lists of 1 / (k + rank of d in that list)
```

The paper fixed k = 60 in a pilot run, found that value "near-optimal, but that the choice was not critical", and reported that RRF "consistently yields better results than any individual system, and better results than the standard method Condorcet Fuse" in its experiments.

A reranker often comes next: a model that reads the query and each candidate together and scores them again. It is more precise than either search, but slower and usually paid per call, so it runs on the top few dozen fused results only.

## Example

With k = 60, chunk A is first in the keyword list and third in the vector list: 1/61 + 1/63 ≈ 0.0323. Chunk B is first in the vector list only: 1/61 ≈ 0.0164. A ranks above B, because both searches agreed on it.

## Common confusion

Hybrid search is not reranking. Fusion merges ranked lists without reading the text again; a reranker reads the text and scores each pair. Many pipelines use both, fusion first.

## In L2M

On a [knowledge base](/nodes/knowledge-bases#hybrid-search-phase-9-3), the RAG Retrieve node's `searchMode` is `vector` (the default), `bm25` or `hybrid`. Hybrid fuses both lists with RRF: `rrfK` defaults to 60, each search returns `candidatesPerRanker` results (by default the larger of 20 and four times `topK`), and each can be weighted. External <Term id="vector-store">vector stores</Term> fall back to vector search. A [Rerank node](/nodes/knowledge-bases#reranker-node-phase-9-3) can reorder the results with a hosted reranker.

## Further reading

- [Cormack, Clarke and Büttcher, Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) (SIGIR 2009, PDF)
