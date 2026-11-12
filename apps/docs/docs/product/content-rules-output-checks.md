---
description: "Output checks in content rules: answer schema, topics, content safety and grounding in sources, where they run, their options and their limits."
---

# Output checks

Output checks judge a model's answer, not just the data in it. There are four:

| Check | Detector id | Category | What it finds |
|---|---|---|---|
| Answer schema | `output.schema` | `schema_violation` | An answer that is not JSON, or does not match a JSON Schema |
| Topics | `output.topic` | `off_topic` | An answer about a denied topic, or about none of the allowed topics |
| Content safety | `output.safety` | `unsafe_content` | Self-harm, violence, sexual content, sexual content involving minors, hate |
| Grounding in sources | `output.grounding` | `ungrounded` | Claims the retrieved documents do not support, and citations that name no document |

They are optional. The built-in rule set has none of them, so nothing changes until you add one.

## Turning them on

Open a rule set on the **Security** page, choose the **Model output**, **Final answer** or **Response** tab, and turn on the check. Its options appear under it. Each check reports its own category, so you can give it its own action (for example `block` for `unsafe_content` and `review` for `ungrounded`). Without one, the channel's default action applies.

In JSON, a check is a detector with options:

```json
{
  "channels": {
    "final_output": {
      "detectors": [
        { "id": "output.safety", "options": { "mode": "rules" } },
        { "id": "output.grounding", "options": { "minSupport": 0.5 } }
      ],
      "actions": {
        "unsafe_content": { "action": "block" },
        "ungrounded": { "action": "review" }
      }
    }
  }
}
```

Saving a rule set checks the options: a schema that does not compile, a topic that names a missing dictionary or an unknown safety category is refused with the path of the problem.

## Where they run

| Where | Channel | Notes |
|---|---|---|
| Content Rules node | `model_output` or `final_output` | Grounding reads the RAG Retrieve and Rerank steps upstream of the node. |
| Agent rules port and automatic rule sets | `final_output` | Grounding reads the retrieval steps upstream plus the answers of the agent's retrieval tools. |
| Responses to external callers | `response` | See [Responses to external callers](./content-rules.md#responses-to-external-callers). Model-backed modes do not run here (see [Limits](#limits)). |
| [/v1 AI gateway](./ai-gateway.md#content-rules) | `final_output` | Model-backed modes do not run here. |
| Output Guardrail node | its own checks | See [Output Guardrail](#output-guardrail-node). |

`output.safety` can also be listed on the `prompt` channel.

## Answer schema

The answer is read as JSON: the whole text, else a fenced `json` block, else the outermost object or array in the text. It is then validated against the JSON Schema in `schema`. Without a schema, the check only asks for JSON.

| Option | Default | Meaning |
|---|---|---|
| `schema` | none | The JSON Schema the answer must match |
| `strict` | `false` | Objects may not carry properties the schema does not list |
| `extract` | `true` | `false`: the whole text must be JSON |
| `maxBytes` | 1 000 000 | Larger answers fail |

Answers can be steered by an attacker, so validation is bounded. A schema is at most 64 KB and 32 levels deep. `$ref` stays inside the schema. Patterns that can backtrack badly are refused (nested or alternated quantifiers, backreferences, lookarounds, more than two unbounded repetitions, over 200 characters). Formats are checked, and an unknown format is refused.

## Topics

`deny` lists topics the answer may not touch. `allow` lists the only topics it may be about: an answer that matches none of them is off topic. A topic is a name, or `{ "name", "phrases", "dictionary", "examples" }`. Phrases match whole words, ignoring case. `dictionary` names a dictionary of the rule set.

| Option | Default | Meaning |
|---|---|---|
| `mode` | `phrases` | `phrases` makes no model calls; `semantic` compares by meaning with an embedding model |
| `minChars` | 1 | The allow list applies only to answers at least this long, so "Thanks!" is never off topic |
| `denyThreshold`, `allowThreshold` | 0.8, 0.5 | Similarity limits in `semantic` mode |

## Content safety

The built-in rules (`mode: "rules"`, the default) look for encouragement, instructions, threats and dehumanising statements, not single words. News, medical text, fiction summaries and crisis-line advice pass. `categories` limits the check to some of `self_harm`, `violence`, `sexual`, `sexual_minors` and `hate`. `mode: "model"` asks a chat model instead.

## Grounding in sources

The check splits the answer into claims (sentences with at least `minClaimWords` content words, default 4) and checks each one:

- **Citations resolve.** `[2]` must name document 2, and `[doc-id]` a document by id.
- **Claims are supported.** Enough of the claim's words (numbers count double) must appear in the documents it cites, or in any document when it cites none. A claim below `minSupport` (default 0.5) is flagged.
- **Negation matches.** A claim that says "is" where the closest source sentence says "is not" is flagged.
- **Claims are cited**, only with `requireCitations: true`.

Without documents the check finds nothing, unless `onNoSources: "flag"`.

**Where the documents come from.** In a workflow, the RAG Retrieve and Rerank steps upstream of the check. In an agent, also the answers of its retrieval tools. A tool counts as a retrieval tool when its name says it retrieves (`search_docs`, `kb_lookup`, `retrieve` and the like), and it is not marked as reaching the open web and its name does not say so (`web`, `http`, `browse` and the like). `toolSources: "all"` counts every tool's answer; a web page can say anything, so it is off by default.

**Judge.** With `judge: true` (or `{ "model": … }`), a claim whose support falls in the uncertain band (`judgeBand`, default 0.35 to 0.65) is put to a chat model, which confirms or clears it. At most `maxJudgeCalls` claims per check (default 5).

## Model-backed modes

Three modes call a model: safety with `mode: "model"`, topics with `mode: "semantic"`, and grounding with `judge`. They are opt-in.

- **Which model.** The check's `model` option, else the model of the node being checked.
- **Keys.** A model names its key as a stored secret (`secretRef.secretId`). Saving needs `secret:use` on that secret. Raw keys and credential-like fields are refused.
- **Addresses.** Only an admin can send a check's model calls to a custom address (`baseUrl` or endpoint fields).
- **Time.** Each model-backed check has its own time limit, `timeoutMs` (default 30 seconds, from 1 second to 5 minutes). It does not use up the rule set's latency budget.
- **Cost.** Calls are counted in the run's usage and budgets, as `content_rules` calls of the node that ran the check.
- **Safety of the call.** The answer is sent inside a random boundary, the rule sits in the system turn, and only a bare JSON reply counts. Destination rules apply to what the check sends.
- **Failure.** A model that fails or times out is a check that could not run: the rule set's `latencyBudget.onExceeded` decides (`fail_closed`, the default, blocks).

## Streaming

Schema and grounding judge a complete answer. While a [/v1 answer streams](./ai-gateway.md#content-rules), the checks at each boundary skip them; they run in the check of the whole answer at the end. If a schema or grounding rule would block (not in shadow, not `allow`), the answer is buffered and checked before any of it is sent. Topic and safety checks run at each boundary on the text so far, so a topic allow list can flag an answer whose first part names no allowed topic yet. For those, set `"stream": "buffer"` on the rule ("Always check the whole answer before streaming any of it" in the editor) to judge the whole answer once.

## Output Guardrail node

The Output Guardrail node offers `topic`, `safety` and `grounding` checks, and `matches_schema` with a schema. They use the same detectors. Model-backed modes use the node's **check model**, else the upstream model, and retries are counted in usage. The node records no rule events.

`no_pii` keeps its original patterns by default. `piiDetection: "data_classes"` uses the data detector instead: fewer false alarms on order numbers, more on international phone numbers.

## Limits

- **Model-backed modes do not run on responses to external callers.** The `response` check offers no model, so a safety check by model, a topic check by meaning or the grounding judge on the `response` channel cannot run. It then follows the rule set's failure policy: with `fail_closed` (the default) the response is withheld every time; with `fail_open` it passes unchecked. Use the local modes on that channel.
- **Model-backed modes do not run on the /v1 AI gateway.** A rule set with one cannot be bound to an AI route set or a client (400). A project's enforced rule set with one still applies to `/v1`, and there the check follows the failure policy, as above.
- **Grounding on responses has no documents.** The `response` check passes no sources, so grounding finds nothing there unless `onNoSources: "flag"`.
- **Grounding is lexical.** A claim made of source words in a new order passes. A claim that changes one figure or one word of an otherwise matching sentence can pass too. A paraphrase in other words reads as unsupported. The judge helps only with claims in its uncertain band.
- **Retrieval tools are recognised by name.** An MCP tool cannot yet mark itself as a retrieval tool.
- **Replays.** A topic check by meaning cannot run in a replay (the model tape records chat calls only), so it fails as unavailable and the replay shows a difference.
- **The safety rules are patterns.** They catch clear cases and are tuned for few false alarms. Register a local classifier (`createDefaultGuardRegistry({ safetyClassifier })`) or use `mode: "model"` for more.

## Benchmark

`packages/guard-sdk/corpus/output-checks/` holds a small corpus for these checks: answers that should fail and look-alikes that should pass, one file per check, each with its own options and documents. `runOutputCheckBenchmark()` runs it with the local modes only (no model, no network), and a test pins the results. It is separate from the [red-team benchmark](./content-rules-benchmark.md), so the built-in rule set's numbers are unchanged.

| Category | Detected | False positives |
|---|---|---|
| `schema_violation` | 10/10 | 0/10 |
| `off_topic` | 10/10 | 0/10 |
| `unsafe_content` | 10/10 | 0/10 |
| `ungrounded` | 6/10 | 0/10 |

The four grounding misses are answers that change one figure or flip one word of a source sentence. The items were written by someone who had read the checks, so treat these as regression numbers, not as a measure of how well the checks generalise.
