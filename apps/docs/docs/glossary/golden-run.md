---
title: "Golden run: a known-good run kept as a reference"
term: "Golden run"
topic: testing
definition: "A recorded run of a workflow or agent that you have checked and keep as the reference: its input, every step's result and every outside call, for replaying changes against."
description: "A golden run records what went in, every step's result and every tool call, so a changed workflow can be replayed against it."
related: [replay, golden-set, cassette, eval, regression-eval, release-gate]
guide: [/learn/testing/regression-testing-agents, /learn/testing/agent-evals]
---

# Golden run

**A recorded run of a workflow or agent that you have checked and keep as the reference: its input, every step's result and every outside call, for replaying changes against.**

Agents are hard to regression test because they call the outside world. Rerun last week's test and the search results, the ticket queue and the clock have all moved, and a write tool would really write. A golden run freezes one good run so a later version can be compared with it on the same footing. The outside calls are answered from the recording (a <Term id="cassette">cassette</Term>), so the test has no side effects and does not depend on other services being up.

## What it holds

- the input that started the run;
- each step's output, in order;
- each tool call with its arguments and its result;
- the final output, with facts to compare such as status, cost and tokens.

## Example

A support workflow answered "Where is my order 1182?" well: it called `lookup_order`, then `get_shipment`, and replied with a tracking link. You save that run as golden. Next week you switch to a cheaper model and <Term id="replay">replay</Term> the golden run against the new version. The new model skips `get_shipment` and invents a date. The replay fails before any customer sees it.

## Common confusion

A golden run is not a snapshot test of the final text. Model wording changes from run to run, so useful comparisons look at the path (which tools, with what arguments), the structure of the output, and limits on cost, rather than demanding identical sentences. Several golden runs together make a <Term id="golden-set">golden set</Term>.

## In L2M

On the Runs page, **Save as golden** keeps a finished run with its node results and, when the run was recorded with **Record MCP calls**, its MCP cassette and model tape. Replay answers MCP, code and outside steps from the recording and gives pass, fail or inconclusive. See [Golden runs and replay](/product/golden-runs).

## Further reading

- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (anthropic.com)
