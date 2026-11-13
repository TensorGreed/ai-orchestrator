---
title: "Keeping personal data and secrets out of AI prompts"
sidebarTitle: "Sensitive data in prompts"
description: "Where personal data and secrets leak in an AI app (prompts, tool arguments, logs, answers) and how masking, tokens and a controlled reveal contain them."
level: intermediate
about: sensitive-information-disclosure
related: [pii, masking, protection-token, secret-reference, data-labels, sensitive-information-disclosure]
demo: wf-demo-guarded-intake
demoRecorded: true
---

# Keeping personal data and secrets out of AI prompts

<Term id="pii">Personal data</Term> and secrets leak from an AI application through more doors than the prompt: tool arguments, tool results, the model's answer, logs, traces and agent memory all carry copies. The fix is a short pipeline. Detect the sensitive values, replace each one with a stand-in (a mask, a keyed hash, a ciphertext or a token) before the text reaches a model, a tool or a log, and turn a token back into the real value only at the one step that needs it. Credentials are a different problem: keep them out of the data path altogether and pass references instead of values.

OWASP lists this risk as LLM02, <Term id="sensitive-information-disclosure">Sensitive Information Disclosure</Term>. It names "personal identifiable information (PII), financial details, health records, confidential business data, security credentials, and legal documents" as the data at stake, and among its mitigations it suggests "tokenization to preprocess and sanitize sensitive information."

## Where data leaks

Follow one support ticket through an agent. The customer writes: "My card 4111 1111 1111 1111 was charged twice, email me at ann@example.com." Every place below can end up holding that card number and address.

- **The prompt.** The ticket goes into the model's context. A hosted model provider now has a copy, under its own retention terms.
- **Tool arguments.** The agent calls `lookup_customer(email="ann@example.com")`. The MCP server, its logs and anything it forwards to now hold the value.
- **Tool results.** The CRM answers with the customer's name, address and order history. That is often more personal data than the user typed, and it all lands in the context for the next model call.
- **The answer.** The model can repeat any of it, to this user or, through shared memory or a badly scoped retrieval, to the next one.
- **Logs, traces and telemetry.** Request logs, debug output, tracing spans and <Term id="tool-call-telemetry">tool-call records</Term> copy prompts and arguments. They are often kept longer, and read by more people, than the application database.
- **Stored state.** Run history, agent memory, cached tool results and test recordings keep the data after the request ends, and a later run can send it to a model again.

Two things make agents worse than ordinary apps here. They copy data between steps on their own, so a value typed once can reach five systems. And the model decides what to call, so you cannot list every flow in advance.

## Detect: what detectors can and cannot find

You cannot protect a value you have not found. Detection comes first, and it is less complete than people expect.

**What pattern detectors find well.** Values with a fixed shape and, ideally, a checksum: email addresses, phone numbers, payment card numbers (the Luhn check removes most false hits), IBANs (mod-97), national ID formats such as a US SSN, and credentials with known prefixes, JWTs and private-key blocks. A dictionary of your own terms (product code names, customer ids) adds what only you know about.

**What they miss.** Names, street addresses, dates of birth written in prose, and health or financial details described in words have no fixed shape. "My daughter's asthma got worse after the move to Leeds" contains no pattern at all. Finding these takes a named-entity model, and even that misses some. Pattern detectors also miss values that are split across two fields, encoded (base64, HTML entities) or written in unusual digit scripts.

**Over-matching.** A ten-digit order number can look like a phone number. A detector tuned to miss nothing will mask some harmless values; one tuned to never over-mask will miss real ones. For data that leaves your boundary, prefer the first.

So treat detection as a net with known holes. Pair it with controls that do not depend on it: do not give an agent tools that return more personal data than its task needs, and keep stored copies short-lived.

## Protect: mask, keyed hash, encrypt, token

Once a value is found, there are four common ways to replace it. They differ in whether the original can be recovered and whether equal values stay equal.

| Technique | Example output | Reversible? | Equal values look equal? | Good for |
|---|---|---|---|---|
| Mask | `a••@e••••••.com` | No | Yes, but so do some different values | Logs, evidence, screens people read |
| Keyed hash | `ph_email_3f9a…` | No | Yes, under one key | Counting, joining and comparing without reading |
| Encryption | `enc:k1:Q2x…` | Yes, with the key | No (random nonce) | Values one later step must read |
| Token (vault) | `tok_email_x7Kp…` | Yes, through the vault | Optional | Values that travel through a model and come back |

**Masking** hides most of the value and keeps enough for a person to recognise its type. It is one-way and cheap, which suits evidence in logs. The <Term id="masking">masking</Term> glossary entry compares these techniques side by side.

**A keyed hash** (HMAC with a secret key) turns a value into a fixed string. The same email always gives the same hash, so you can still count "how many calls used this address" without storing the address. A plain, unkeyed hash is weak for personal data: anyone can hash a list of likely emails and compare. A key stops that for outsiders, but not for whoever holds the key.

**Encryption** keeps the value recoverable by anyone with the key. With a random nonce, the same value encrypts differently each time, so ciphertexts cannot be joined.

**A token** is a random stand-in, and a vault maps it back to the value. A <Term id="protection-token">protection token</Term> is the most useful form inside an agent: the model sees `tok_email_x7Kp…`, can reason about "the customer's email" and pass the token to a tool, and never sees the address. Format-preserving tokens keep the shape (a card token is still 16 Luhn-valid digits) for systems that validate formats.

None of these is anonymisation. The GDPR defines pseudonymisation as processing so that the data "can no longer be attributed to a specific data subject without the use of additional information", provided that information is kept separately. A keyed hash, a ciphertext and a vault token all fit that description: the key or the vault is the additional information. The output is still personal data, and the key needs the same care as the data.

## Reveal only at the step that needs it

Most of a workflow does not need the real value. The model that drafts the reply can work with tokens. The step that sends the email, or writes to the CRM, cannot.

So place the reveal as late as possible:

1. Protect the values as the request comes in, before the first model call.
2. Let the model and the read-only tools work with tokens.
3. Turn the tokens back into values in the step just before the action that needs them.
4. After that step, put the tokens back wherever the run stores or sends data.

Three rules keep the reveal itself from becoming the leak. Decide who may reveal which kinds of data, per role or service account, and default to nobody. Require a person's approval for the most sensitive classes, and do not let the requester approve their own reveal. And treat a revealed value as sensitive again, so the next step's outbound checks still apply.

## Keep it out of telemetry and stored runs

Telemetry is where good intentions fail. A team masks the prompt carefully, then turns on prompt capture in its tracing backend to debug a slow agent, and every raw prompt is now in another system, readable by everyone with tracing access and kept under that system's retention.

Some habits that hold up:

- **Record shape, not content, by default.** For a tool call, the useful facts are which tool, how long, whether it failed, and roughly what kind of arguments it took. A tool-call record can keep types, lengths and keyed hashes of the arguments and still support "which callers send this value" questions.
- **Make content capture opt-in and cleaned.** If traces must carry prompts, mask detected values and remove secrets before export, and drop content entirely for work you know is sensitive.
- **Remember state that outlives the run.** Agent memory and cached tool results written during a sensitive conversation can be read by a later run that looks harmless. Mark them, and let the mark travel with the data.
- **Keep test data masked.** Production runs copied into a test set are personal data. Mask them before they are stored, with stable surrogates so replays still line up.
- **Keep retention short where content lives.** Whatever detection misses, a short life limits.

## Secrets are a separate problem

API keys, database passwords and OAuth tokens should never be in a prompt, a tool argument or a log, and masking is the wrong tool for them. If a model can see a key, a prompt injection can make it repeat the key.

The pattern is references, not values. A workflow stores a <Term id="secret-reference">secret reference</Term>, an id that points at an encrypted secret. The platform resolves it only inside the step that opens the connection, and the value never enters the model's context, the run history or an export. On top of that, scrub known secret values from anything that leaves: logs, audit exports and traces. That catches the case where a value slipped into data by accident.

## Sensitive data in L2M

In L2M, each step above has a matching control. A simple workflow needs no setup: argument summaries and secret encryption are on by default, and everything else is opt-in.

- **Detectors.** The data rule detectors find emails, phone numbers, card numbers (Luhn), IBANs (mod-97), US SSNs, UK National Insurance numbers, credentials with known prefixes, high-entropy values next to credential-like names, JWTs, private-key blocks and custom dictionaries. Names, addresses and free-text health details are not detected ([detectors and their limits](/product/content-rules-engine#detectors)).
- **Protection.** Optionally, a [content rules](/product/content-rules#protection-port) step replaces detected values through the **Protection Provider** nodes attached to its protection port: `mask`, `keyed_hash` (HMAC-SHA-256), `aes_gcm` (AES-256-GCM), `token_vault` (random, deterministic or format-preserving tokens) or `surrogate` (a one-way, same-shape stand-in). Providers that need a key take a stored secret by reference.
- **Reveal.** A **Reveal** node turns tokens back into values in one field, and only for data classes that an admin-saved reveal rule allows the run's starter, optionally after an approval. Everything the run stores (history, memory, session stores) holds the tokens again wherever the value appears unchanged ([the Reveal node](/product/content-rules#reveal-node)).
- **Data labels.** Optionally, with label tracking on, data carries the <Term id="data-labels">data labels</Term> of where it came from and which data classes it holds; a tool rule that checks for `sensitive` counts any detected class, so tool policy and destination rules can decide where it may go.
- **Tool-call telemetry.** Each MCP tool call's argument summary keeps safe values only and stores everything else as its shape plus an HMAC keyed from the master key. Set `MCP_TOOL_ARGUMENT_SUMMARIES=false` to turn summaries off ([the argument summary](/product/mcp-tool-call-telemetry#the-argument-summary)).
- **Traces.** <Term id="opentelemetry">OpenTelemetry</Term> content capture is off by default. When on, L2M removes secret values and masks detected data before export, and leaves content out for sensitive runs, including runs that read session state written by sensitive work ([content capture](/operations/opentelemetry#content-capture)).
- **Test data.** Production capture masks personal data with keyed surrogates before a run is stored ([masking](/product/production-capture#masking)).
- **Secrets.** Workflows hold `secretRef.secretId`, values are encrypted with AES-256-GCM at rest, and the API never returns them ([secrets](/security/secrets)).

The live demo has a workflow whose prompt rules block a request containing an email address before any model sees it.

<TryInDemo workflow="wf-demo-guarded-intake" recorded />

See also: [AI data retention, erasure requests and legal holds](/learn/operations/ai-data-retention-and-erasure), for how long the copies you could not avoid are kept and how to delete one person's data.

## Further reading

- [LLM02:2025 Sensitive Information Disclosure](https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/) (OWASP Gen AI Security Project)
- [GDPR Article 4: Definitions](https://gdpr-info.eu/art-4-gdpr/) (gdpr-info.eu, reproducing Regulation (EU) 2016/679), for "pseudonymisation"
- In L2M: [Content rules engine](/product/content-rules-engine), [MCP tool-call telemetry](/product/mcp-tool-call-telemetry), [Secrets](/security/secrets)
