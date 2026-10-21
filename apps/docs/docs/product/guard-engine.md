# Guard engine

L2M Guard is a security proxy for AI traffic. It inspects what flows between users, models and tools, decides what to do with it, and records why. The engine lives in `@ai-orchestrator/guard-sdk` as a standalone library: it knows nothing about workflows, nodes or HTTP, and it never makes a network call of its own.

This page describes the engine. [Guard in workflows](./guard.md) covers the Guard node, the agent guard port, stored profiles and bindings, the protection port and guard events. What is still to come is listed under [Not yet available](#not-yet-available).

## Concepts

### Channels

Every piece of content is inspected on one of five channels. Profiles configure each channel separately because the same text means different things in different places: a phrase that is a harmless question in a prompt is an attack inside a tool result.

| Channel | What it carries | Typical concerns |
|---|---|---|
| `prompt` | What the user, or a template, sends to the model | direct injection, jailbreaks, credentials pasted by mistake |
| `model_output` | What the model produced before anything acts on it | leaked system prompts, exfiltration links, sensitive data |
| `tool_arguments` | What the model wants to pass to a tool | SQL and command injection, path traversal, outbound URLs, schema violations |
| `tool_result` | What a tool, document or web page returned | indirect injection, hidden characters, sensitive data |
| `final_output` | The answer about to leave the run | leaked canaries, sensitive data, exfiltration |

### Detector input

A detector receives the content (text, or a JSON value inspected through its canonical serialisation), the channel, provenance labels (`trusted`, `user`, `untrusted_external`, `sensitive`), the run subject (role, user id, project) and, for tool traffic, the tool context: server, tool name, input schema and annotations.

### Findings

A finding names the detector, a category, a score from 0 to 1, the character spans it refers to, masked evidence and, for data-loss prevention, a data class such as `card_number` or `credential`. Evidence is always masked: a card number appears as `•••• •••• •••• 1111`, an email as `a••@e••••••.org`. Raw values never appear in a finding, a trace or a log line.

### Detectors and tiers

Each detector belongs to a latency tier. Evaluation runs tiers in order, cheapest first, so a rule can stop a request before a classifier or judge is ever consulted.

| Tier | Cost | Built in |
|---|---|---|
| `rule` | microseconds | injection rule packs, hidden characters, exfiltration URLs, canaries, DLP patterns, command and path guards, egress guard, schema validation |
| `parser` | milliseconds | SQL guard (parses to an AST per dialect) |
| `classifier` | local model | interface only; a rule-based stand-in runs when no model is registered |
| `judge` | an LLM call | interface only; nothing is registered by default |

`createDefaultGuardRegistry()` returns every built-in detector. Deployments add their own with `registry.register(detector)` or swap a built-in one with `replace`.

### Profiles

A profile is a named, versioned JSON document. Per channel it lists the detectors that run, their thresholds and the action for each finding category or data class. A data-class entry wins over its category; findings with neither fall back to the channel's `defaultAction`, which defaults to `block`.

Profiles are validated with zod and serialised with a stable key order and a SHA-256 hash, so they can be stored as policy-as-code and compared across environments. Every verdict carries the profile id, version and hash it was produced with.

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

Injection findings (`prompt_injection`, `indirect_injection`, `canary_leak`) are never redacted, masked, protected or transformed. A profile that asks for one of those gets `block` instead, and the verdict says why.

### Shadow mode

Any action can run in shadow mode, per action for the whole profile (`shadow: { block: true }`) or per rule (`actions: { prompt_injection: { action: "block", shadow: true } }`). A shadow action is recorded in the verdict as if it had applied, but the content passes unchanged and evaluation continues. Use it to observe a new profile on real traffic before enforcing it.

### Latency budget: fail open or fail closed

A profile sets a latency budget in milliseconds and what happens when it runs out. The budget is checked before each detector, and each detector is raced against the time left.

- `fail_closed` (the default): over budget, the content is blocked.
- `fail_open`: over budget, the content passes with whatever was found so far.

A detector that throws, or a detector named by the profile that is not registered, is treated the same way as an exceeded budget.

### Protection providers

A protection provider turns a sensitive value into a token (`protect`) and, when the provider is reversible, back again (`reveal`). Providers declare whether they are deterministic (equal values give equal tokens, so joins keep working) and which data classes they cover. `createDefaultProtectionRegistry()` returns the built-in ones:

| Provider | Reversible | Deterministic | Notes |
|---|---|---|---|
| `mask` | no | yes | the masked form of the value |
| `keyed_hash` | no | yes | HMAC-SHA-256 pseudonym under an injected key |
| `aes_gcm` | yes | no | AES-256-GCM, random nonce, key id in the token, data class bound as authenticated data |
| `token_vault` | yes | optional | tokens kept in an injected store; random, deterministic, or format-preserving (card tokens stay Luhn-valid) |

Key material arrives through an injected key resolver. The library never reads environment variables or files; in L2M the resolver reads stored secrets through `SecretService`. The vault's storage is an interface too, with an in-memory implementation for tests and single-process use; L2M stores it encrypted in the database.

### Fallback

The profile's `protection.dataClasses` maps each data class to a provider. When a finding should be protected but no provider is mapped for its class, the provider does not cover the class, or the provider fails, the profile's `protection.fallback` applies. It defaults to `block` and may be `redact` or `mask`; it may not be `protect`.

## Detectors

| Id | Tier | Channels | Finds |
|---|---|---|---|
| `injection.direct` | rule | prompt, model output, final output | instruction override, refusal of prior rules, role markers, system-prompt extraction, unrestricted personas, known jailbreak personas, safety overrides, exfiltration instructions. Also matched after leetspeak and base64 decoding and with zero-width characters removed. |
| `injection.indirect` | rule | tool result, tool arguments, untrusted prompts | everything above plus text addressing the model, embedded tasks, instructions in hidden markup, planted tool calls, secrecy demands |
| `injection.hidden_unicode` | rule | all | tag characters (decoded as evidence), bidi overrides, zero-width runs, soft-hyphen runs; `transform` strips them |
| `exfiltration.urls` | rule | model output, final output, tool arguments, tool result | markdown and HTML images and links whose URLs carry data (long or high-entropy query values, data-like parameter names, data-like path segments or hostnames); URLs outside an allowlist in tool arguments |
| `leak.canary` | rule | model output, final output, tool arguments | canary tokens from the system prompt |
| `injection.classifier` | classifier | prompt, tool result, model output, final output | the registered classifier's score; the rule packs stand in |
| `dlp.patterns` | rule | all | email, phone, card numbers (Luhn), IBAN (mod-97), US SSN and a pluggable national-id list (UK NI number built in), credentials with known key prefixes, JWTs, private-key blocks, high-entropy values next to credential-like names, custom dictionaries and patterns |
| `tool.sql` | parser | tool arguments | per dialect (postgres, mysql, mariadb, sqlite, mssql): read, write and DDL classification; stacked queries, tautologies, comment tricks and union probes; table and column allowlists; WHERE required on mutations; row cap rewrite (LIMIT or TOP) or check; unparseable SQL fails closed |
| `tool.command` | rule | tool arguments | shell metacharacters, command substitution, redirection, destructive commands; option-shaped arguments from untrusted input |
| `tool.code` | rule | tool arguments | dangerous imports and calls in Python and JavaScript code-node source |
| `tool.path` | rule | tool arguments | paths outside the allowed roots, traversal, encoded traversal, null bytes and symlink escapes through an injectable `realpath` |
| `tool.egress` | rule | tool arguments | URLs whose host is not allowlisted, local or metadata hostnames, credentials in URLs, disallowed schemes and ports, and any address that is loopback, private, link-local, carrier NAT, cloud metadata, multicast or reserved, for IPv4 and IPv6 including IPv4-mapped IPv6 and decimal, octal and hex IPv4 spellings; each hop of a redirect chain |
| `tool.arguments` | rule | tool arguments | strict JSON Schema validation (undeclared properties rejected) with size, depth, string, array and property limits |

### Limits

- The rule packs are pattern based. They catch the phrasings in the corpus and their encoded variants; a paraphrase the patterns do not cover needs the classifier tier, which this release leaves as an interface.
- The egress guard judges addresses, not traffic. A host that resolves to a public address at check time and to a private one a moment later (DNS rebinding) is only caught when the caller resolves once and connects to the resolved address.
- The SQL guard parses whole statements. A fragment pasted into a template is reported as unparseable, which blocks, but the guard cannot tell what the surrounding template does.
- The DLP detectors are patterns with checksums. Names, addresses and free-text health information need the NER model planned for a later release.
- Spans refer to the canonical text. For JSON content that is the serialisation with sorted keys; the transformed content is parsed back to JSON when it still parses.

## Spotlighting helpers

`wrapWithDelimiters(content)` wraps untrusted content between random boundary lines and returns the matching system-prompt text; `datamark(content)` replaces whitespace with a marker character and does the same. `PROMPT_HARDENING_TEXT` is a system-prompt paragraph that tells the model what counts as data. `generateCanaryToken()` and `canaryInstruction(token)` plant a canary that `leak.canary` detects in output.

## Sample profile

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

`createDefaultGuardProfile()` returns the built-in profile, which blocks injection and tool-argument attacks, strips hidden characters, redacts credentials and masks card numbers in output, and leaves ordinary personal data alone.

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

`packages/guard-sdk/corpus/` holds a labelled corpus of direct injection, indirect injection, SQL injection and exfiltration attacks with benign look-alikes. `pnpm --filter @ai-orchestrator/guard-sdk test` runs it through the default profile and fails when detection drops below 90% (85% for indirect injection, 95% for SQL) or false positives exceed 5% in any category. The thresholds and the item format are in `corpus/README.md`.

## OWASP Top 10 for LLM applications

What this release of the engine covers, as a library:

| Risk | Coverage |
|---|---|
| LLM01 Prompt injection | direct and indirect rule packs, hidden-character detection and stripping, spotlighting helpers, canary tokens, classifier tier interface |
| LLM02 Sensitive information disclosure | DLP detectors with checksums, credential and key detection, masking, redaction, protection providers, canary leak detection |
| LLM03 Supply chain | not covered by the engine |
| LLM04 Data and model poisoning | not covered by the engine |
| LLM05 Improper output handling | exfiltration URL detection in output, hidden-character stripping, schema validation of tool arguments |
| LLM06 Excessive agency | SQL, command, path and egress guards on tool arguments; the `require_approval` and `review` actions |
| LLM07 System prompt leakage | prompt-extraction patterns, canary tokens |
| LLM08 Vector and embedding weaknesses | not covered by the engine |
| LLM09 Misinformation | not covered; a grounding check is planned |
| LLM10 Unbounded consumption | argument size and depth limits; the row cap in the SQL guard |

## Not yet available

The engine is wired into the Guard node, the agent guard port, automatic profiles, the protection port and guard events; see [Guard in workflows](./guard.md). Still to come:

- git sync for profiles (export and import JSON in the meantime);
- local classifier models and the LLM judge;
- the provenance tracking that carries labels through templates and the agent context;
- automatic checks on HTTP Request and SQL connector nodes, and on the MCP and AI gateways.
