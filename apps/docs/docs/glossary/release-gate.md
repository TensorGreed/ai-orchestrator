---
title: "Release gate: only tested versions reach production"
term: "Release gate"
topic: testing
definition: "A check in the release path that lets a new version of a workflow or agent go live only after its tests passed on that exact version."
description: "A release gate lets a workflow version go live only after its tests passed on that exact version. The policy, overrides, rollback and audit."
related: [golden-set, replay, regression-eval, approval-gate, audit-log]
guide: [/learn/testing/release-gates]
---

# Release gate

**A check in the release path that lets a new version of a workflow or agent go live only after its tests passed on that exact version.**

Running tests in CI tells you a change passed. A release gate makes sure production only runs what passed. That matters for AI workflows, where a prompt or model edit can be published in seconds with no build step to catch it. Anthropic's evals guide notes that automated evals "are especially useful pre-launch and in CI/CD"; a gate is where their result decides the release.

A gate has a few parts:

- **Binding to a version.** The evidence must belong to the exact version being published, usually by a hash of its definition.
- **A policy.** What counts as passing: a pass rate, how many regressions are allowed, a minimum number of cases, limits on cost or latency.
- **Fresh evidence.** Old recordings or old test runs can stop counting after a while.
- **Overrides.** Someone with the authority can ship anyway, with a reason that is recorded.
- **Rollback.** Going back to a version that already shipped does not need to pass again.

## Example

Version 7 of a support workflow changes the model. Its <Term id="replay">replay</Term> job passes 19 of 20 cases. The policy needs 100%, so publishing is blocked, and the job's results show which case failed. The team fixes the prompt and saves version 8, which has a new hash, so the earlier job no longer applies. A new job passes 20 of 20, and version 8 publishes.

## Common confusion

A release gate is not an approval step, though it can include one. Approval asks a person; a gate checks evidence. It is also not a test run: the gate runs nothing at publish time, it checks results that already exist for that version.

## In L2M

Optionally, under **Evaluations → Release gates**, you can make publishing a workflow version depend on a passed [replay job](/product/golden-sets#replay-jobs) over its <Term id="golden-set">golden sets</Term>, run against that same saved version. The default bar is every case passing, no regressions and at least three cases. A blocked gate can be overridden by an admin only, who must give a reason; the override is audited. Rolling back to a version that already shipped skips the gate ([release gate](/product/release-gate#the-gate)).

## Further reading

- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (Anthropic engineering, January 2026)
