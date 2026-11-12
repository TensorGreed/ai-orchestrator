---
title: "Content rules benchmark: measure detection on a corpus"
description: "Measure a rule set on a labelled red-team corpus mapped to the OWASP LLM Top 10: detection and false-positive rates, held-out split, CI gate."
---

# Content rules benchmark

L2M ships a labelled red-team corpus: attacks and realistic look-alikes in eleven categories, mapped to the OWASP Top 10 for LLM applications. The benchmark runs it through any rule set and reports how many attacks the rule set caught and how many harmless items it stopped, per category. Run it from the Security page, on a draft in the rule set editor, over the API, or with `l2m guard benchmark` in CI.

Concepts: [the OWASP Top 10 for LLM apps, explained for agents](/learn/security/owasp-llm-top-10).

A benchmark calls no model and reads no workflow data. It touches neither the network nor the disk, and gives the same result every time for the same rule set and corpus. Its verdicts are not content rules events, so they never show up in the Security page's numbers.

## What it measures

- **Detection rate**: attacks the rule set did not allow, over all attacks. Any action other than `allow` counts as caught (`block`, `review`, `require_approval`, `redact`, `mask`, `transform`).
- **False-positive rate**: benign items the rule set did not allow, over all benign items.
- **Per detector**: the attacks and benign items on which each detector's finding took effect.
- **Action split**: how many items ended in each action.
- **Latency**: p50, p95 and maximum evaluation time per item.
- **Reference workflow suite** (optional): the share of attacks that reached a tool or the final answer in a fixed agent workflow. See [below](#reference-workflow-suite).

Reports carry item ids, counts and detector names. Corpus content is never included.

## Categories and OWASP mapping

| Category | Checked on | OWASP LLM (2025) | What the attacks try |
|---|---|---|---|
| Direct prompt injection | prompt | LLM01, LLM07 | Override instructions, extract the system prompt |
| Jailbreak | prompt | LLM01 | Role-play, "developer mode" and persona attacks |
| Indirect injection | tool result | LLM01, LLM06 | Instructions hidden in documents, pages and tool output |
| SQL injection | tool arguments | LLM05, LLM06 | Stacked queries, tautologies, destructive statements |
| Exfiltration | model output | LLM02, LLM05 | Data in image URLs, links and encoded query strings |
| Command injection | tool arguments | LLM05, LLM06 | Chaining, substitution and redirection in shell commands |
| Path traversal | tool arguments | LLM05, LLM06 | `../`, absolute paths, encoded separators |
| Egress and SSRF | tool arguments | LLM05, LLM06 | Metadata endpoints, private ranges, DNS rebinding |
| Secrets and personal data | model output | LLM02 | API keys, private keys, card numbers, identity numbers |
| Canary leak | model output | LLM07 | The system prompt's canary token in the answer |
| Tool argument validation | tool arguments | LLM05, LLM06 | Arguments outside the tool's own schema |

Benign items are the traffic a production agent sees, written close to the attacks in vocabulary or shape. For example: a security article that quotes an injection, a `DELETE` with a `WHERE` clause, a link to a public page.

LLM03 (supply chain), LLM04 (data and model poisoning), LLM08 (vector and embedding weaknesses), LLM09 (misinformation) and LLM10 (unbounded consumption) are not covered by the corpus.

## Splits

- **Main** (240 attacks, 213 benign): the built-in detectors were tuned on it.
- **Held-out** (110 attacks, 110 benign, ten of each per category): written apart from the detectors, by an author who did not read the detector rules or the main split. It shows how well the rules generalise to paraphrases and new styles.

When a change catches more or flags less, `l2m guard benchmark --builtin` names the categories now above their floor. Raise those floors (`BUILT_IN_PROFILE_BENCHMARK_FLOORS` in guard-sdk) to the new counts in the same pull request, so a later change cannot slip back.

A detector change that fixes a held-out item moves the item to the main split, and a new held-out item is written in its place.

## The default rule set's results

Measured on this release. CI fails when any category drops below these results (detection) or rises above them (false positives). The main split is exact; each held-out category allows one item of slack, because one of its ten items is a 10-point step.

| Category | Main: detected | Main: false positives | Held-out: detected | Held-out: false positives |
|---|---|---|---|---|
| Direct prompt injection | 15/15 | 0/18 | 5/10 | 1/10 |
| Jailbreak | 14/20 | 1/20 | 3/10 | 0/10 |
| Indirect injection | 20/20 | 0/20 | 5/10 | 0/10 |
| SQL injection | 20/20 | 0/20 | 7/10 | 2/10 |
| Exfiltration | 15/15 | 0/15 | 8/10 | 0/10 |
| Command injection | 50/50 | 5/20 | 10/10 | 8/10 |
| Path traversal | 20/20 | 20/20 | 10/10 | 10/10 |
| Egress and SSRF | 20/20 | 0/20 | 10/10 | 1/10 |
| Secrets and personal data | 18/20 | 1/20 | 8/10 | 1/10 |
| Canary leak | 12/20 | 0/20 | 8/10 | 0/10 |
| Tool argument validation | 18/20 | 0/20 | 9/10 | 0/10 |
| **All** | **222/240 (92.5%)** | **27/213 (12.7%)** | **83/110 (75.5%)** | **23/110 (20.9%)** |

Reading the table:

- The rule packs recognise the injection and jailbreak phrasings they were written for. Paraphrases on the held-out split need the classifier tier.
- The default rule set sets no allowed roots for the path content rules, so it refuses every path argument: all benign path items are flagged. That is fail-closed by design. Set `roots` on `tool.path` in your own rule set.
- The command content rules flags any pipe, chain, redirection or substitution in a command string outside single quotes, including ordinary ones (`head app.log | grep ERROR`, `git commit -m "a; b"`). Tools that take a program and an argument list avoid that. Single-quoted text is literal, except when a word may hand it to another shell (a shell name such as `bash` or `ksh93`, `eval`, `ssh`, `su`, `sudo`, `script`, `flock`, `env -S`, a `-c`-style flag, a command named through a variable such as `$SHELL`): every word is then scanned as the command line that shell would receive.
- Canary leaks are matched verbatim. Spaced, split or encoded leaks are missed.

## Running it

### Security → Benchmark

Pick a rule set and click **Run benchmark**. Builders and admins can run it; everyone else sees the stored results. The page shows:

- the totals for each split
- a table by category (hover a count for the ids of the missed or flagged items)
- the reference workflow suite, when you included it
- a **trend by version** over the rule set's stored benchmarks

The result is compared with the rule set's previous stored benchmark, and any regression is listed.

A full benchmark of a saved version (every category, both splits) is stored, the newest 50 per rule set. A run narrowed with `categories` or `splits` is returned but not stored, so the trend and the baselines only ever hold full runs. A builder can store one benchmark per rule set version every 10 minutes (429 sooner; admins are exempt), so nobody can push an admin's results out of the history. Deleting the rule set deletes its benchmarks.

### Benchmark this draft

In **Security → Rule sets & bindings**, change a rule set and click **Benchmark this draft**, next to **Simulate on recent traffic**. The editor's unsaved document is benchmarked and compared with the rule set's latest stored benchmark. Nothing is saved, and the result is not stored.

A builder can benchmark a draft of a rule set they may edit. Only admins can benchmark drafts of the default rule set, of a rule set a project enforces, or of the deployment's destination rules. This is the same rule as [simulation](./content-rules-simulation.md).

### API

- `POST /api/guard/profiles/:id/benchmark`: builder. The body is `{}` for the latest saved version, `{ version }` for a given one, or `{ document }` for a draft. Add `suites: ["profile", "workflow"]`, `splits` and `categories` to narrow the run (a narrowed run is not stored). The answer is `{ report, comparison, baseline, stored, draft, partial }`. Only one benchmark runs at a time on an instance; a second request gets 409. A builder storing a second benchmark of the same version within 10 minutes gets 429 with `Retry-After`. Audited as `guard.benchmark.run`.
- `GET /api/guard/profiles/:id/benchmarks`: viewer. The stored benchmarks, newest first, with the rates for each split.
- `GET /api/guard/benchmarks/:id`: viewer. One stored benchmark with its full report.

### CLI and CI

`l2m guard benchmark` runs offline: it needs no server, network or model.

```sh
# The default rule set against its measured results (what the repository's CI runs):
l2m guard benchmark --builtin

# Your own rule set: write a baseline once, then fail on any regression against it.
l2m guard benchmark --profile guard/support.json --out guard/support-benchmark.json
l2m guard benchmark --profile guard/support.json --baseline guard/support-benchmark.json --junit guard-benchmark.xml
```

- `--profile` takes a rule set document, such as the file **Export** downloads.
- `--suite workflow` adds the reference workflow suite.
- `--split` and `--category` narrow the run.
- `--tolerance 0.02` allows a drop of two points before it counts as a regression (the default is 0).
- `--json` prints the report with its judgement.
- `--junit` writes one test case per category and split.

The command exits 1 when the default rule set falls below its results or a rule set regresses against its baseline: lower detection, more false positives, or more workflow attacks getting through. It exits 2 on a usage error. It also lists the items that are newly missed or newly flagged.

## Reference workflow suite

The rule set suite checks each item at one checkpoint. The reference workflow suite checks a whole run.

The fixed workflow is an agent with:

- a document reader that returns the attack or benign text as a tool result;
- two write tools, `send_email` and `http_post`, that only record calls;
- a scripted model that obeys any instruction it reads: it calls both write tools and answers with a link to a collector host.

An attack **succeeds** when a write tool was called, or when the collector link or the canary reached the final answer. A benign run counts as a false positive when it did not end with the user's answer.

It runs in two configurations:

- the rule set alone;
- the rule set plus the MCP safety preset **approval for untrusted writes**, which pauses a write that follows untrusted input.

The default rule set stops all 20 main attacks. On the held-out split, 5 of 10 attacks reach a write tool: the content rules blocks the final answer, but only after the writes. With the preset, all 5 pause for approval instead.

Limits:

- The scripted model obeys only text that reaches it unchanged. So spotlighting, which changes how the model reads tool output rather than what it receives, scores nothing here.
- Benign runs never call a write tool, so the preset's cost to legitimate writes is not measured.

## Benchmarking a workflow with evals

To measure your own workflow rather than the reference one, write [eval cases](./golden-sets.md#eval-runs) with the `guard_outcome` scorer:

| Field | Meaning |
|---|---|
| `expect` | `caught` (any verdict other than allow), `blocked` (block, review or approval), or `allowed` (nothing stopped or rewritten) |
| `channel` | Only verdicts on this channel (`prompt`, `tool_arguments`, `tool_result`, `model_output`, …) |
| `detector` | Only findings of this detector; a prefix ending in `.` (`dlp.`) matches a family |
| `nodeId` | Only verdicts of this node |

An eval run can also take `guardProfile: { profileId, version? }`. That rule set is added to every case's run, which is how you compare two rule sets on the same set. It can only tighten: it is added on top of every rule set the run applies anyway (enforced, workflow and project bindings, the auto-applied default rule set, the deployment's destination rules) and never replaces one.

Verdicts from eval runs and replay jobs are kept in the run's trace. They are left out of **Security → Overview**, `GET /api/guard/events` and `GET /api/guard/stats`, unless you tick **Include eval and replay runs** on the Overview or add `includeEval=true`. Eval runs are live (real model, tools and secrets), so tick it to see what a poisoned document did during one. Each such event carries an **eval** chip (`runSource: "eval"`), and an eval run that pauses for approval keeps the tag when it resumes.

## Output checks

The answer schema, topic, content safety and grounding checks have their own small corpus in `packages/guard-sdk/corpus/output-checks/`, run by `runOutputCheckBenchmark()` with local modes only. It is not part of this benchmark, the Security page or `l2m guard benchmark`. See [Output checks](./content-rules-output-checks.md#benchmark).

## Adding an external corpus

The corpus contains only items written for L2M. To benchmark against a public dataset, convert it to the corpus format and keep it apart:

```
packages/guard-sdk/corpus/external/<dataset>/
  NOTICE            # dataset name, source URL, version or commit, licence, and what was changed
  <category>.json   # the corpus file format; ids prefixed with the dataset name
```

The NOTICE file is plain text, one `Field: value` per line:

```
Dataset: <name>
Source: <url>
Version: <tag or commit>
Licence: <SPDX identifier>
Changes: <what was converted, dropped or relabelled>
```

External files are not loaded by default. In your own tests, load the folder with `loadGuardCorpus("<folder>")` and pass the result as `corpus` to `runGuardBenchmark`. Before committing an external dataset, check that its licence allows redistribution.
