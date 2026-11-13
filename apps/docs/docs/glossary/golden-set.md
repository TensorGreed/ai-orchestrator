---
title: "Golden set (golden dataset) for AI testing"
term: "Golden set"
topic: testing
definition: "A curated collection of reference cases, each an input with a known-good result, that a new version of an AI workflow or agent must pass before it ships."
description: "A golden set is a curated group of reference cases a candidate must pass before release. How to choose the cases, size the set and keep it fresh."
related: [golden-run, regression-eval, release-gate, replay, eval]
guide: [/learn/testing/regression-testing-agents]
---

# Golden set

**A curated collection of reference cases, each an input with a known-good result, that a new version of an AI workflow or agent must pass before it ships.**

It is also called a golden dataset. In eval terms it is the task list of a <Term id="regression-eval">regression eval</Term>: the cases that define "still works". Each case may be a recorded <Term id="golden-run">golden run</Term> or a hand-written input with an expected answer. The set as a whole is a contract, so changing it changes what "passed" means, and it deserves the same review as code.

What makes a good set:

- **Real cases.** Anthropic's evals guide says "20-50 simple tasks drawn from real failures is a great start", and recommends turning user-reported failures into test cases.
- **Unambiguous cases.** Its test for a good task: "two domain experts would independently reach the same pass/fail verdict". A case that people would argue about makes a noisy test.
- **A known-good result for each case**, so a failure means the candidate changed, not that the case was never solvable.
- **Small enough to run on every change**, which keeps it in the release path instead of in a nightly job nobody reads.
- **An owner.** The same guide calls an eval suite "a living artifact that needs ongoing attention and clear ownership to remain useful". New failures get added, and cases that test retired behaviour get removed on purpose.

## Example

A refunds workflow has a set of 15 cases: six common requests, five edge cases (partial refund, wrong currency, order older than 30 days) and four bugs from last quarter, each named for what it checks, such as "refund after 30 days is declined".

## Common confusion

A golden set is not training data and not a public benchmark. It is private to your system and describes your behaviour, not general skill. Nor is it a pile of golden runs: the point is the selection.

## In L2M

A [golden set](/product/golden-sets) belongs to one workflow and holds its chosen golden runs. To test a change, a <Term id="replay">replay</Term> job plays every golden run in the set against the version you pick (a draft, a saved version or a workflow file) and scores it. Hand-written cases can sit in a set, but replay jobs skip them. An enforced <Term id="release-gate">release gate</Term> counts only cases an admin admitted, so the set cannot be padded with easy cases.

## Further reading

- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (Anthropic engineering, January 2026)
