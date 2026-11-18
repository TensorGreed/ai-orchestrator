---
title: "Content rules engine: how content is inspected"
description: "The content rules engine inspects content flowing between users, models and tools, channel by channel, decides what to do with it and records why."
---

# Content rules engine

The content rules engine checks AI traffic. It inspects what flows between users, models and tools, decides what to do with it, and records why. The engine lives in `@ai-orchestrator/guard-sdk` as a standalone library: it knows nothing about workflows, nodes or HTTP, and it never makes a network call of its own.

Concepts: [Prompt injection](/learn/security/prompt-injection) and [the OWASP Top 10 for LLM apps](/learn/security/owasp-llm-top-10) explain the attacks these checks address.

This page describes the engine. [Content rules in workflows](./content-rules.md) covers the Content Rules node, the agent rules port, stored rule sets and bindings, the protection port and rule events. What is still to come is listed under [Not yet available](#not-yet-available).

## Concepts

### Channels

Every piece of content is inspected on one channel. Rule sets configure each channel separately because the same text means different things in different places: a phrase that is a harmless question in a prompt is an attack inside a tool result.

| Channel | What it carries | Typical concerns |
|---|---|---|
| `prompt` | What the user, or a template, sends to the model | direct injection, jailbreaks, credentials pasted by mistake |
| `model_output` | What the model produced before anything acts on it | leaked system prompts, exfiltration links, sensitive data |
| `tool_arguments` | What the model wants to pass to a tool | SQL and command injection, path traversal, outbound URLs, schema violations |
| `tool_result` | What a tool, document or web page returned | indirect injection, hidden characters, sensitive data |
| `final_output` | The answer about to leave the run | leaked canaries, sensitive data, exfiltration |

Three more channels exist only in stored rule sets; the Content Rules node never offers them:

| Channel | What it carries | See |
|---|---|---|
| `egress` | What a step sends out (a URL, headers, a body) | [Data labels and destinations](./data-labels-and-destinations.md) |
| `response` | What an external webhook, chat or MCP invoke caller receives | [Responses to external callers](./content-rules.md#responses-to-external-callers) |
| `trigger_input` | A webhook payload, at the route, before the run starts | [Responses to external callers](./content-rules.md#responses-to-external-callers) |

### Detector input

A detector receives the content (text, or a JSON value inspected through its canonical serialisation), the channel, provenance labels (`trusted`, `user`, `untrusted_external`, `sensitive`), the run subject (role, user id, project) and, for tool traffic, the tool context: server, tool name, input schema and annotations.

### Findings

A finding names the detector, a category, a score from 0 to 1, the character spans it refers to, masked evidence and, for data rules, a data class such as `card_number` or `credential`. Evidence is always masked: a card number appears as `•••• •••• •••• 1111`, an email as `a••@e••••••.org`. Raw values never appear in a finding, a trace or a log line.

### Detectors and tiers

Each detector belongs to a latency tier. Evaluation runs tiers in order, cheapest first, so a rule can stop a request before a classifier or judge is ever consulted.

| Tier | Cost | Built in |
|---|---|---|
| `rule` | microseconds | injection rule packs, hidden characters, exfiltration URLs, canaries, data rule patterns, command and path checks, egress check, schema validation |
| `parser` | milliseconds | SQL check (parses to an AST per dialect) |
| `classifier` | local model | interfaces only (injection and content safety); rule-based stand-ins run when no model is registered. Topic checks sit here too. |
| `judge` | an LLM call | interface only; nothing is registered by default. [Output checks](./content-rules-output-checks.md) can call a chat model of their own. |

`createDefaultGuardRegistry()` returns every built-in detector. Deployments add their own with `registry.register(detector)` or swap a built-in one with `replace`.

### Rule sets

A rule set is a named, versioned JSON document. Per channel it lists the detectors that run, their thresholds and the action for each finding category or data class. A data-class entry wins over its category; findings with neither fall back to the channel's `defaultAction`, which defaults to `block`.

Rule sets are validated with zod and serialised with a stable key order and a SHA-256 hash, so they can be stored as policy-as-code and compared across environments. Every verdict carries the rule set id, version and hash it was produced with.

### Actions

| Action | Effect |
|---|---|
| `allow` | Nothing. The finding is still recorded. |
| `block` | The content does not pass. Remaining detectors are skipped. |
| `redact` | The spans are replaced with `[REDACTED:<class>]`. |
| `mask` | The spans are replaced with their masked form (last four digits kept, and so on). |
| `protect` | The spans are replaced with tokens from a protection provider. |
| `transform` | The detector rewrites the content, for example stripping hidden characters. |
| `require_approval` | The content passes to the approval flow. |
| `review` | The content is routed to review instead of continuing. |

Injection findings (`prompt_injection`, `indirect_injection`, `canary_leak`) are never redacted, masked, protected or transformed. A rule set that asks for one of those gets `block` instead, and the verdict says why.

### Shadow mode

Any action can run in shadow mode, per action for the whole rule set (`shadow: { block: true }`) or per rule (`actions: { prompt_injection: { action: "block", shadow: true } }`). A shadow action is recorded in the verdict as if it had applied, but the content passes unchanged and evaluation continues. Use it to observe a new rule set on real traffic before enforcing it.

### Latency budget: fail open or fail closed

A rule set sets a latency budget in milliseconds and what happens when it runs out. The budget is checked before each detector, and each detector is raced against the time left.

Checks that wait on a model or a service are the exception: the output checks that call a chat model, and the names and addresses check when it uses a [names and addresses service](#names-locations-and-street-addresses) or its judge. Each of these has its own `timeoutMs` (default 30 s) instead of the budget, and the time it takes does not use up the budget of the other checks. When one of them runs out of its own time, the same fail-open or fail-closed setting below decides.

- `fail_closed` (the default): over budget, the content is blocked.
- `fail_open`: over budget, the content passes with whatever was found so far.

A detector that throws, or a detector named by the rule set that is not registered, is treated the same way as an exceeded budget.

### Protection providers

A protection provider turns a sensitive value into a token (`protect`) and, when the provider is reversible, back again (`reveal`). Providers declare whether they are deterministic (equal values give equal tokens, so joins keep working) and which data classes they cover. `createDefaultProtectionRegistry()` returns the built-in ones:

| Provider | Reversible | Deterministic | Notes |
|---|---|---|---|
| `mask` | no | yes | the masked form of the value |
| `keyed_hash` | no | yes | HMAC-SHA-256 pseudonym under an injected key |
| `aes_gcm` | yes | no | AES-256-GCM, random nonce, key id in the token, data class bound as authenticated data |
| `surrogate` | no | yes | keyed, format-preserving stand-in: an email, card, IBAN, US SSN, UK National Insurance or phone number keeps its shape (cards stay Luhn-valid); credentials, private keys and JWTs are fully redacted. Pseudonymisation: whoever holds the key can test a guessed value |
| `placeholder` | yes (with its map) | yes | readable placeholders numbered per data class (`[EMAIL_1]`, with a run tag in runs: `[EMAIL_1.K3F9QX]`); the map is kept by the caller (a run's sealed map, or a redaction map of the [gateway tools](./content-rules-tools.md)) |
| `token_vault` | yes | optional | tokens kept in an injected store; random, deterministic, or format-preserving (card tokens stay Luhn-valid) |

Key material arrives through an injected key resolver. The library never reads environment variables or files; in L2M the resolver reads stored secrets through `SecretService`. The vault's storage is an interface too, with an in-memory implementation for tests and single-process use; L2M stores it encrypted in the database.

### Fallback

The rule set's `protection.dataClasses` maps each data class to a provider. When a finding should be protected but no provider is mapped for its class, the provider does not cover the class, or the provider fails, the rule set's `protection.fallback` applies. It defaults to `block` and may be `redact` or `mask`; it may not be `protect`.

## Detectors

| Id | Tier | Channels | Finds |
|---|---|---|---|
| `injection.direct` | rule | prompt, model output, final output | instruction override, refusal of prior rules, role markers, system-prompt extraction, unrestricted personas, known jailbreak personas, safety overrides, exfiltration instructions. Also matched after leetspeak and base64 decoding and with zero-width characters removed. |
| `injection.indirect` | rule | tool result, tool arguments, untrusted prompts | everything above plus text addressing the model, embedded tasks, instructions in hidden markup, planted tool calls, secrecy demands |
| `injection.hidden_unicode` | rule | all | tag characters (decoded as evidence), bidi overrides, zero-width runs, soft-hyphen runs; `transform` strips them |
| `exfiltration.urls` | rule | model output, final output, tool arguments, tool result | markdown and HTML images and links whose URLs carry data (long or high-entropy query values, data-like parameter names, data-like path segments or hostnames); URLs outside an allowlist in tool arguments |
| `leak.canary` | rule | model output, final output, tool arguments | canary tokens from the system prompt |
| `injection.classifier` | classifier | prompt, tool result, model output, final output | the registered classifier's score; the rule packs stand in |
| `dlp.patterns` | rule | all | email, phone, card numbers (Luhn), IBAN (mod-97), US SSN and a pluggable national-id list (UK NI number built in), credentials with known key prefixes, JWTs, private-key blocks, high-entropy values next to credential-like names, custom dictionaries and patterns; IPv4 and IPv6 addresses (`ip_address`) only when the `include` option names them (see [IP addresses](./content-rules-tools.md#ip-addresses)) |
| `data.entities` | classifier | all | person names (`person_name`), locations (`location`) and street addresses (`street_address`), each only when the `classes` option names it; built-in rules, or the deployment's own recognizer (see [Names, locations and street addresses](#names-locations-and-street-addresses)) |
| `tool.sql` | parser | tool arguments | per dialect (postgres, mysql, mariadb, sqlite, mssql): read, write and DDL classification; stacked queries, tautologies, comment tricks and union probes; table and column allowlists; WHERE required on mutations; row cap rewrite (LIMIT or TOP) or check; unparseable SQL fails closed |
| `tool.command` | rule | tool arguments | shell metacharacters, command substitution, redirection, destructive commands; option-shaped arguments from untrusted input |
| `tool.code` | rule | tool arguments | dangerous imports and calls in Python and JavaScript code-node source |
| `tool.path` | rule | tool arguments | paths outside the allowed roots, traversal, encoded traversal, null bytes and symlink escapes through an injectable `realpath` |
| `tool.egress` | rule | tool arguments | URLs whose host is not allowlisted, local or metadata hostnames, credentials in URLs, disallowed schemes and ports, and any address that is loopback, private, link-local, carrier NAT, cloud metadata, multicast or reserved, for IPv4 and IPv6 including IPv4-mapped IPv6 and decimal, octal and hex IPv4 spellings; each hop of a redirect chain |
| `tool.arguments` | rule | tool arguments | strict JSON Schema validation (undeclared properties rejected) with size, depth, string, array and property limits |
| `output.schema` | parser | model output, final output, response | an answer that is not JSON or does not match a JSON Schema (`schema_violation`) |
| `output.topic` | classifier | model output, final output, response | an answer about a denied topic, or about none of the allowed ones (`off_topic`); phrases, or meaning with an embedding model |
| `output.safety` | classifier | prompt, model output, final output, response | self-harm, violence, sexual content, sexual content involving minors, hate (`unsafe_content`); built-in rules or a chat model |
| `output.grounding` | parser | model output, final output, response | claims the retrieved documents do not support, and citations that name no document (`ungrounded`); an optional chat model judges borderline claims |

The four `output.*` detectors are the [output checks](./content-rules-output-checks.md). They need options to mean anything, so the built-in rule set has none of them.

### Limits

- The rule packs are pattern based. They catch the phrasings in the corpus and their encoded variants; a paraphrase the patterns do not cover needs the classifier tier, which this release leaves as an interface.
- The egress check judges addresses, not traffic. A host that resolves to a public address at check time and to a private one a moment later (DNS rebinding) is only caught when the caller resolves once and connects to the resolved address.
- The SQL check parses whole statements. A fragment pasted into a template is reported as unparseable, which blocks, but the check cannot tell what the surrounding template does.
- The data rule detectors are patterns with checksums. Names and addresses by rules need a cue or a known format (see below); free-text health information is not detected.
- Spans refer to the canonical text. For JSON content that is the serialisation with sorted keys; the transformed content is parsed back to JSON when it still parses.

## Names, locations and street addresses

`data.entities` finds person names, locations and street addresses. It is off unless a rule set lists it, and it reports only the classes its `classes` option names:

```json
{ "id": "data.entities", "threshold": 0.5, "options": { "classes": ["person_name", "street_address"] } }
```

| Option | Default | Meaning |
|---|---|---|
| `classes` | required | any of `person_name`, `location`, `street_address` |
| `engine` | `auto` | `auto` uses the deployment's names and addresses service when one is set up, otherwise the built-in rules; `rules` always uses the rules; `endpoint` always uses the service; `union` uses the rules and the service together (overlapping spans keep the higher score). `endpoint` and `union` fail the check when no service is set up |
| `minScore` | person 0.75, address 0.7, location 0.8 | lowest score reported per class; lower findings are kept as suppressed and never act |
| `minLength` | 3 | shorter spans are dropped |
| `singleTokenNames` | `false` | report a one-word name without a cue (a title, a field label or a greeting) |
| `contextWords` | none | `boost` and `suppress` lists (up to 50 words each): a word within 40 characters raises a score by 0.1 or lowers it by 0.3 |
| `languages` | `["en"]` | English only for now |
| `maxChars` | 20000 | longer text fails the check instead of being cut, so the rule set's fail-open or fail-closed setting decides; the content rules tools and document scans use their own input limits instead |
| `timeoutMs` | 30000 | the check's own time limit when it waits on the service or the judge (1,000 to 300,000) |
| `judge` | off | `{ "enabled": true, "model": { … }, "band": [0.35, 0.7], "maxSpans": 20 }`: ask a chat model about uncertain spans (see below) |

The options refuse any other key, so a rule set cannot name an endpoint; the judge's model follows the rules of the output checks' models (no keys in a rule set, a stored secret named by `secretRef.secretId`, a custom `baseUrl` only by an admin). Saving a rule set checks them; if a stored rule set still holds options that do not pass (a row edited by hand), the content rules tools and document scans use the default options for the classes it lists (or that a call names), and the server logs a warning once per rule set version. The **Names and addresses** card in the rule set editor sets them and says which engine this deployment has: **basic** (the built-in rules only, with the command that adds the local service) or the service's health and model.

**What the built-in rules find (basic).** Street addresses in six countries: a house number, street name and street type (US, UK, Canada, Australia), the German order (`Hauptstraße 5`) and the French order (`12 rue de la Paix`), with a unit if one follows. A following town with a postcode in that country's format (US state and ZIP code, Canadian province and postcode, Australian state and four digits, UK postcode, German or French five-digit code) raises the score to 0.95; a street line alone scores 0.75, or 0.85 after an `Address:` label. A postcode alone is never reported. Person names are found after a title (`Dr.`, `Ms`), a field label (`Name:`, `Patient:`, `Customer:`), a greeting (`Dear Ana`), on the line after a sign-off (`Kind regards,`) or after phrases such as `my name is`; a listed given name followed by a listed surname scores 0.8 without a cue. Locations are listed countries, US states and well-known cities after a place cue (`in`, `from`, `based in`) or a `City:` or `Country:` label; place names that are also common names or words (`Jordan`, `Nice`, `Reading`) need a strong cue. Names without a cue are mostly missed: recall for names is low by design, so that `May`, `Will` or `Jordan` in ordinary text is not reported.

**False positives.** Spans inside an email address, a URL, a code block, a placeholder such as `[EMAIL_1]`, a vault token or a surrogate the run issued are dropped, a span that overlaps another data finding (an email, a phone number) yields to it, and the rule set's allow-list and dictionaries apply as for every data check. Evidence keeps the first letter of each word only (`J••• S••••`). Findings of these classes count as `medium` risk in the content rules tools.

**The names and addresses service.** For better recall than the basic rules, a deployment runs a names and addresses service and points the API at it with `CONTENT_RULES_NER_ENDPOINT` (an http(s) base URL such as `http://ner:8000`; `CONTENT_RULES_NER_ENDPOINT_TOKEN` if the service wants a bearer token). The l2m-ner container is the reference service; any service that speaks the same contract works:

- `POST {base}/v1/entities` with `{ "texts": [...], "labels": ["person_name", "location", "street_address"], "language": "en", "threshold": 0.7 }` (1 to 64 texts) answers `{ "results": [{ "entities": [{ "start", "end", "label", "score" }] }], "model": { "id", "version", "sha256" } }`, one result per text in order. Offsets are UTF-16 code units into each text (JavaScript string indices), end exclusive.
- `GET {base}/health` answers `{ "ok", "ready", "model": { … } | null, "message"? }`; `ready` is false while no model is loaded.
- Errors are `{ "error": { "code", "message" } }` with 400, 401, 413, 429 or 503, and never quote the input.

How the API uses it:

- Requests go through the [outbound URL checks](../security/outbound-url-checks.md) with the connection pinned to the checked addresses. The configured host is reached even with `OUTBOUND_DENY_PRIVATE=true`, because an admin named it and it usually runs on the internal network; metadata and link-local addresses stay refused, and a redirect is never followed (it fails the request), so texts cannot be sent anywhere else.
- Many texts are sent together: the cells of a CSV file and the strings of a JSON value go in requests of up to 64 texts and `CONTENT_RULES_NER_ENDPOINT_MAX_REQUEST_CHARS` characters (default 50,000; lower it if the service answers 413). A longer text is sent as overlapping pieces, and each span is taken from the piece with the most text around it.
- Two time limits apply, and neither is the rule set's latency budget. Each request to the service has its own limit, `CONTENT_RULES_NER_ENDPOINT_TIMEOUT_MS` (default 10 s). The whole names and addresses check, which may send several requests and wait for retries, has the option `timeoutMs` (default 30 s). The latency budget does not cut either short, and a slow service does not use up the budget of the other checks. Document scans and the content rules tools have an overall limit as well, `CONTENT_SCAN_TIME_LIMIT_MS` (default 120 s).
- The `threshold` sent is the lowest score that can matter (the lowest `minScore` of the asked classes, or the judge's band); the class `minScore` values still decide what is reported.
- The answer is checked against the contract: one result per text, offsets inside the text, only the labels asked for, scores from 0 to 1. Anything else, an error answer, a timeout or an unreachable service fails the check, and the rule set's fail-open or fail-closed setting decides. Error messages name the HTTP status and the service's error code only.
- The service's model (id, version and checksum) is part of the engine's version, so a clean result kept from an older model is never reused.
- The detector list and the editor card show the service's health (asked at most every 30 s), its model, or why it is not ready.
- A rule set that picks `endpoint` or `union` on a deployment without a service fails every check (the editor warns; saving over the API does not refuse it, so rule sets can move between deployments).
- Each API process sends at most `CONTENT_RULES_NER_ENDPOINT_MAX_CONCURRENT` requests at once (default 4, 1 to 64). Up to four more per slot wait in a queue, each for at most the request time limit.
- A 429, or a 503 (busy or not ready), is retried up to twice. Each retry waits for the answer's `Retry-After`, at most 5 s (1 s when there is none), and never past the check's own time limit.
- The service counts as **overloaded** when the queue is full, a request waits too long for a slot, or the service is still busy after the retries. The check then fails, and the rule set's fail-open or fail-closed setting decides. This is never silent:
  - the check's timings in the trace show it as an error that says the service is overloaded and names and addresses went unchecked;
  - the API logs a warning;
  - the detector list and the editor card say how often it happened since the API started, and when it last did.

  With fail-open, those names and addresses go unchecked, so size the service for the load (or raise the limit) or keep such rule sets fail-closed.
- The token travels as sent: use https, or keep the service on an internal network.
- Where overlapping spans compete (`union`, or a service's own overlaps), a span that would be reported always wins over one that would be suppressed.

**The judge.** With `judge.enabled`, spans the recognizer scored inside `judge.band` (default 0.35 to 0.7) and below their class's `minScore` go to the chat model `judge.model` names, which answers for each whether it really is a name, a place or an address. A confirmed span is raised to its class's `minScore` and reported; any other answer leaves it suppressed. The judge can only add findings: a span the recognizer reports is never sent to it, so text around a span that sways the model cannot clear anything. At most `judge.maxSpans` spans (default 20) are judged per check. Each span goes with up to 120 characters of text on either side and nothing else, fenced as data with a random boundary, and the answer must be exactly one JSON object (`{"verdicts":[{"i":0,"sensitive":true}]}`). When the judge fails (no model calls at that point, an error, an answer without verdicts, or no answer within half of `timeoutMs`), the recognizer's findings stand and the uncertain spans are marked `judge: failed` in the trace. The judge is off by default and needs a model; when that model is an external service, the spans and their surroundings leave the deployment, and the editor says so. Its calls count in the run's cost like the output checks' and run where a workflow offers model calls (not on AI gateway routes, so a rule set with the judge on cannot be bound there). The content rules tools and document scans do not use the judge.

**Your own recognizer.** A deployment can also plug in its own engine in code through the `GuardEntityRecognizer` interface: `id`, `version`, the classes and languages it handles, and `recognize(texts, { classes, language, signal, minScore })`, which returns spans (`start`, `end`, `dataClass`, `score`, `source`) per text. Pass it as `createDefaultGuardRegistry({ entityRecognizer })`. Its spans go through the same checks as the rules' (malformed spans are ignored), and its id and version are part of the key that lets a clean result be reused within a run, so a changed engine is never answered from an older result. The API builds one detector registry for the whole deployment, so runs, gateway calls, simulations, the benchmark and the content rules tools all use the same engine; the detector list (`GET /api/guard/detectors`) shows it as `engine` on `data.entities`.

## Spotlighting helpers

`wrapWithDelimiters(content)` wraps untrusted content between random boundary lines and returns the matching system-prompt text; `datamark(content)` replaces whitespace with a marker character and does the same. `PROMPT_HARDENING_TEXT` is a system-prompt paragraph that tells the model what counts as data. `generateCanaryToken()` and `canaryInstruction(token)` plant a canary that `leak.canary` detects in output.

## Sample rule set

```json
{
  "id": "customer-support",
  "name": "Customer support agent",
  "version": "3",
  "latencyBudget": { "ms": 1500, "onExceeded": "fail_closed" },
  "shadow": { "review": true },
  "protection": {
    "dataClasses": {
      "card_number": { "providerId": "token_vault", "options": { "formatPreserving": true } },
      "email": { "providerId": "keyed_hash", "options": { "keyId": "guard-pseudonym-key" } }
    },
    "fallback": "block"
  },
  "dictionaries": [
    { "dataClass": "project_codename", "terms": ["bluebird", "osprey"], "patterns": [], "score": 0.9 }
  ],
  "channels": {
    "prompt": {
      "detectors": [
        { "id": "injection.direct", "threshold": 0.6 },
        { "id": "injection.hidden_unicode", "threshold": 0.5 },
        { "id": "dlp.patterns", "threshold": 0.6 }
      ],
      "actions": {
        "prompt_injection": { "action": "block" },
        "hidden_payload": { "action": "transform" },
        "credential": { "action": "redact" },
        "card_number": { "action": "protect" },
        "sensitive_data": { "action": "allow" }
      },
      "defaultAction": { "action": "block" }
    },
    "tool_result": {
      "detectors": [
        { "id": "injection.indirect", "threshold": 0.6 },
        { "id": "injection.hidden_unicode", "threshold": 0.5 },
        { "id": "exfiltration.urls", "threshold": 0.7 },
        { "id": "dlp.patterns", "threshold": 0.6 }
      ],
      "actions": {
        "indirect_injection": { "action": "block" },
        "hidden_payload": { "action": "transform" },
        "exfiltration": { "action": "review" },
        "card_number": { "action": "protect" },
        "email": { "action": "protect" },
        "project_codename": { "action": "redact" },
        "sensitive_data": { "action": "allow" }
      },
      "defaultAction": { "action": "block" }
    },
    "tool_arguments": {
      "detectors": [
        { "id": "tool.arguments", "threshold": 0.5 },
        { "id": "tool.sql", "threshold": 0.5, "options": { "dialect": "postgres", "allowedTables": ["tickets", "customers"], "maxRows": 200, "allowWrites": false } },
        { "id": "tool.egress", "threshold": 0.5, "options": { "allowedHosts": ["api.example.com", "*.cdn.example.com"] } },
        { "id": "tool.path", "threshold": 0.5, "options": { "roots": ["/srv/attachments"] } },
        { "id": "tool.command", "threshold": 0.6 }
      ],
      "actions": {
        "schema_violation": { "action": "block" },
        "sql_injection": { "action": "block" },
        "sql_policy": { "action": "require_approval" },
        "egress": { "action": "block" },
        "path_traversal": { "action": "block" },
        "command_injection": { "action": "block" }
      },
      "defaultAction": { "action": "block" }
    },
    "final_output": {
      "detectors": [
        { "id": "leak.canary", "threshold": 0.5 },
        { "id": "exfiltration.urls", "threshold": 0.6 },
        { "id": "dlp.patterns", "threshold": 0.6 }
      ],
      "actions": {
        "canary_leak": { "action": "block" },
        "exfiltration": { "action": "block" },
        "credential": { "action": "redact" },
        "card_number": { "action": "mask" },
        "sensitive_data": { "action": "allow" }
      },
      "defaultAction": { "action": "block" }
    }
  }
}
```

`createDefaultGuardProfile()` returns the built-in rule set, which blocks injection and tool-argument attacks, strips hidden characters, redacts credentials and masks card numbers in output, and leaves ordinary personal data alone.

## Using the library

```ts
import {
  createDefaultGuardProfile,
  createDefaultGuardRegistry,
  createDefaultProtectionRegistry,
  evaluateGuard
} from "@ai-orchestrator/guard-sdk";

const registry = createDefaultGuardRegistry({ resolver: lookupAddresses });
const protection = createDefaultProtectionRegistry({ keys: resolveKey, defaultKeyId: "guard" });
const profile = createDefaultGuardProfile();

const verdict = await evaluateGuard(
  profile,
  { channel: "tool_result", content: toolOutput, labels: ["untrusted_external"] },
  { registry, protection }
);

if (verdict.blocked) throw new Error(verdict.findings[0]?.message);
useContent(verdict.content);
```

A verdict carries the overall action, the findings at or above threshold, the suppressed ones, the action applied per finding (requested, effective, shadow, reason), the transformed content, the tokens issued by providers, per-detector timings and statuses, the budget outcome and a decision trace.

## Benchmark

`packages/guard-sdk/corpus/` holds a labelled red-team corpus of content-rule attacks and benign look-alikes in eleven categories, with a main split and a held-out split. `runGuardBenchmark(ruleSet)` runs it through any rule set. `pnpm --filter @ai-orchestrator/guard-sdk test` and the repository's CI fail when the default rule set drops below its measured results in any category. See [Content rules benchmark](./content-rules-benchmark.md) for the categories, the OWASP mapping, the measured rates, the Security page, the API and `l2m guard benchmark`. The item format is in `corpus/README.md`.

## OWASP Top 10 for LLM applications

What this release of the engine covers, as a library:

| Risk | Coverage |
|---|---|
| LLM01 Prompt injection | direct and indirect rule packs, hidden-character detection and stripping, spotlighting helpers, canary tokens, classifier tier interface |
| LLM02 Sensitive information disclosure | data rule detectors with checksums, credential and key detection, masking, redaction, protection providers, canary leak detection |
| LLM03 Supply chain | not covered by the engine |
| LLM04 Data and model poisoning | not covered by the engine |
| LLM05 Improper output handling | exfiltration URL detection in output, hidden-character stripping, schema validation of tool arguments and of answers |
| LLM06 Excessive agency | SQL, command, path and egress checks on tool arguments; the `require_approval` and `review` actions |
| LLM07 System prompt leakage | prompt-extraction patterns, canary tokens |
| LLM08 Vector and embedding weaknesses | not covered by the engine |
| LLM09 Misinformation | grounding of answers in the retrieved documents (lexical, with an optional model judge); topic limits |
| LLM10 Unbounded consumption | argument size and depth limits; the row cap in the SQL check |

## Not yet available

The engine is wired into the Content Rules node, the agent rules port, automatic rule sets, the model boundary, responses to external callers, the Reveal node, both gateways, the protection port and rule events; see [Content rules in workflows](./content-rules.md). Still to come:

- git sync for rule sets (export and import JSON in the meantime);
- local classifier models, and an LLM judge tier for every detector (the output checks can already call a chat model);
- the SQL check (`tool.sql`) on SQL connector nodes and the address check (`tool.egress`) on HTTP Request nodes without a Content Rules node in front of them.
