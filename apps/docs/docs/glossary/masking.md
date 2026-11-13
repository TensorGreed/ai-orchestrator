---
title: "Data masking for AI prompts and logs"
term: "Masking"
topic: security
definition: "Replacing a sensitive value, such as an email address or a card number, with a partly hidden form before the text reaches a model, a log or a person."
description: "Masking replaces sensitive values (emails, card numbers) with placeholders before text reaches a model or a log. Masking vs hashing vs tokens."
related: [pii, protection-token, sensitive-information-disclosure, secret-reference, data-labels]
guide: [/learn/security/sensitive-data-in-prompts]
---

# Masking

**Replacing a sensitive value, such as an email address or a card number, with a partly hidden form before the text reaches a model, a log or a person.**

A masked value keeps just enough to be recognised (its type, sometimes its last digits) and nothing more. Masking is one-way: nobody can turn `•••• •••• •••• 1111` back into the card number. That makes it the safe default for anything people read later, such as logs, traces and rule evidence, and for <Term id="pii">personal data</Term> a model does not need to see at all.

## Example

A support message arrives: "Refund to card 4111 1111 1111 1111, contact jo@example.org". Before it is logged, a detector finds both values and the log line reads "Refund to card •••• •••• •••• 1111, contact j•@e••••••.org". The model, if it gets the masked text, can still tell that a card and an email were given.

## Common confusion

Masking is one of several ways to replace a value, and they are not interchangeable:

- **Keyed hashing** gives the same output for the same input under one key, so records can be counted or joined. Masking does not promise that: two different cards that end in 1111 mask alike.
- **Encryption** can be undone by anyone with the key.
- **A <Term id="protection-token">protection token</Term>** stands in for the value and can be exchanged for it later, where a rule allows.
- **A surrogate** is a realistic fake of the same shape (a valid-looking card number), useful in test data.

The word is also used loosely for any of these replacements: L2M's production capture calls its surrogate step masking.

Masking is also not anonymisation. What is left around the value (the rest of the message, the timing, the account) can still identify the person.

## In L2M

L2M offers masking in several places, all optional. A Content Rules step can apply the `mask` action, or a `mask` provider on its [protection port](/product/content-rules#protection-port), to the data classes its rule set detects. Rule events always store evidence in masked form. [Production capture](/product/production-capture#masking) replaces personal data in captured runs with keyed surrogates rather than masks, so replays still line up.

## Further reading

- [LLM02:2025 Sensitive Information Disclosure](https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/) (OWASP Gen AI Security Project)
