---
title: "Grounding: answers backed by the sources given"
term: "Grounding"
topic: agents
definition: "Keeping a model's answer to what the documents it was given actually support, so each claim can be traced back to a source."
description: "A grounded answer says only what its retrieved sources support. How citations and grounding checks catch answers that drift from their sources."
related: [rag, hybrid-search, output-checks, misinformation, vector-store]
guide: [/learn/security/owasp-llm-top-10]
---

# Grounding

**Keeping a model's answer to what the documents it was given actually support, so each claim can be traced back to a source.**

<Term id="rag">RAG</Term> puts retrieved documents in the prompt and tells the model to answer from them. Grounding is whether it did. A model can ignore the context and answer from its training, mix the two, or fill a gap with something plausible. OWASP's LLM09 (Misinformation) describes the result, "false or misleading information that appears credible", and lists retrieval from "trusted external databases" and cross-checking against trusted sources among the ways to reduce it.

Grounding is checked in three common ways:

- **Citations.** The prompt asks the model to mark each claim with the source it came from, such as `[2]`. A citation that names no retrieved document is an easy catch.
- **Claim checks.** Split the answer into claims and test each against the cited text, by word overlap or by asking a second model.
- **Evals.** On test cases, a faithfulness score measures what share of the answer's claims the context supports.

## Example

The retrieved policy says "Refunds are available within 30 days of delivery." The answer says "You can get a refund within 60 days [1]." The citation is valid, since document 1 exists, but the claim is not supported: the number differs. A citation check passes it; a claim check that compares figures flags it.

## Common confusion

Grounded is not the same as true. A grounded answer is only as good as its sources: a stale page or a planted document gives a grounded wrong answer. And a citation is not proof of support. The model can cite a real document for a claim the document never makes.

## In L2M

RAG Retrieve returns `citationInstructions` for the prompt, and the Extract Citations node maps each `[N]` back to its chunk ([citations](/nodes/knowledge-bases#citations-phase-9-4)). Optionally, the Output Guardrail node's `grounding` check flags claims the retrieved documents do not support, and the same check is available as an [output check](/product/content-rules-output-checks#grounding-in-sources) in content rules. The check compares words, so a paraphrase can read as unsupported and a single changed figure, as in the example, can slip through. For test cases, the `faithfulness` eval scorer uses a model judge.

## Further reading

- [OWASP LLM09:2025 Misinformation](https://genai.owasp.org/llmrisk/llm092025-misinformation/) (owasp.org)
