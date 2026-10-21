# Guard benchmark corpus

A small labelled corpus for the default guard profile. Each file holds one
category with attack items and benign look-alikes:

| File | Channel | Attacks | Benign |
|---|---|---|---|
| `direct-injection.json` | `prompt` | instruction override, persona jailbreaks, prompt extraction, encoded and hidden payloads | ordinary requests that reuse the same words |
| `indirect-injection.json` | `tool_result` | text addressing the model, embedded tasks, hidden markup, planted tool calls, secrecy demands | documents, emails and snippets with similar vocabulary |
| `sql-injection.json` | `tool_arguments` | tautologies, stacked queries, comments, union probes, unbounded mutations, DDL | queries with `OR`, `AND 1=1`, comments inside strings, legitimate unions |
| `exfiltration.json` | `model_output` | markdown and HTML images and links whose URLs carry data | plain links and images on ordinary hosts |

Item format: `{ "id", "label": "attack" | "benign", "content": string | object }`.
Content objects are tool arguments. Objects never contain real personal data;
addresses and hosts use documentation ranges and `.example` names.

## Thresholds

`src/benchmark.test.ts` runs every item through `evaluateGuard` with the
default profile and fails when a rate regresses:

| Category | Detection rate (attacks not allowed) | False-positive rate (benign not allowed) |
|---|---|---|
| direct injection | ≥ 0.90 | ≤ 0.05 |
| indirect injection | ≥ 0.85 | ≤ 0.05 |
| SQL injection | ≥ 0.95 | ≤ 0.05 |
| exfiltration | ≥ 0.90 | ≤ 0.05 |

"Not allowed" means the verdict's action is anything but `allow`, so a
`transform` (hidden characters stripped) or `review` counts as detection and,
on a benign item, as a false positive. Adding items is encouraged; when a new
benign item trips a detector, fix the detector or lower the pattern's weight
rather than deleting the item.
