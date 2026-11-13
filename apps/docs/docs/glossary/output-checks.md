---
title: "Output checks: validating what an AI answer says"
term: "Output checks"
topic: security
definition: "Tests run on a model's answer before anything uses it: whether it parses and fits a schema, stays on allowed topics, avoids unsafe content and sticks to its sources."
description: "Output checks test a model's answer before it is used: schema, allowed topics, content safety, grounding. What they catch and what they miss."
related: [grounding, improper-output-handling, prompt-injection, eval]
guide: [/learn/security/owasp-llm-top-10]
---

# Output checks

**Tests run on a model's answer before anything uses it: whether it parses and fits a schema, stays on allowed topics, avoids unsafe content and sticks to its sources.**

A model's answer is untrusted input to whatever comes next. It can be malformed, off topic, harmful, made up, or steered by an attacker through the prompt. OWASP's LLM05 (Improper Output Handling) puts it plainly: "Treat the model as any other user, adopting a zero-trust approach", and validate responses before they reach backend functions.

Output checks fall into a few groups:

- **Structure.** The answer is valid JSON and matches a schema: the fields, types and allowed values the next step expects.
- **Topic.** The answer is about what this assistant is for, and not about a denied subject.
- **Safety.** The answer does not encourage self-harm, threaten violence or carry similar content.
- **Grounding.** Its claims are supported by the documents it was given (<Term id="grounding">grounding</Term>).

When a check fails, the application blocks the answer, asks the model to try again, or holds it for a person to review. Checks are not the whole of safe output handling: anything that passes still needs encoding for where it goes, such as escaping for HTML or parameterised queries for SQL.

## Example

A refund agent must return `{"action": "refund", "amount": <number>}`. The model replies "Sure, I'll refund $50 right away!". A schema check fails it, the application retries with the error message, and the second answer is valid JSON. Nothing reached the payments step until it was.

## Common confusion

Output checks are not evals. An <Term id="eval">eval</Term> runs on test cases before release and scores how good the answers are; an output check runs on every live answer and decides whether this one may be used. And a passing check does not make an answer right: a valid schema can carry the wrong amount.

## In L2M

The Output Guardrail node checks an answer for personal data, profanity, valid JSON or a JSON Schema, topics, content safety and grounding, and on failure either stops with an error or asks the upstream model again, up to three times. Optionally, the same schema, topic, safety and grounding checks can run as [output checks](/product/content-rules-output-checks) in a content rules rule set. All of them are off until you add them.

## Further reading

- [OWASP LLM05:2025 Improper Output Handling](https://genai.owasp.org/llmrisk/llm052025-improper-output-handling/) (owasp.org)
