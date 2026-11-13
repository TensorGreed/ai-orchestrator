---
title: "Release gates for AI workflows: ship only what passed"
sidebarTitle: "Release gates"
description: "A release gate lets a workflow version reach production only after its tests pass on that exact version. How gates, drafts, overrides and rollback work."
level: intermediate
about: release-gate
related: [release-gate, golden-set, replay, golden-run, audit-log]
demo: wf-demo-faq-release
demoRecorded: true
---

# Release gates for AI workflows

A <Term id="release-gate">release gate</Term> is a check that sits between "saved" and "live". A workflow version reaches production only when a test run of that exact version passed, under a written policy such as "every case passes, no regressions, at least three cases". Everything else (a draft someone is still editing, a version that failed, a version that changed after it was tested) stays out of production. Two escape hatches keep it practical: an approver can let a blocked version through, and you can always roll back or take the live version down.

## Why a gate, and not just tests

Tests in CI help only if production runs the version that was tested. With agent workflows that link is easy to break. Someone edits the prompt in the editor after the pipeline passed. A scheduled job picks up the latest save. A model setting is changed "just for a minute". The tests were green, and production runs something they never saw.

A release gate closes that gap with two rules:

1. **Production runs a published version, never whatever was saved last.**
2. **A version is published only with proof that this exact version passed.** "Exact" means a hash of the version's definition, so a version edited after its test run is a different version and needs its own run.

The tests themselves are your regression suite: a <Term id="golden-set">golden set</Term> of known-good runs (<Term id="golden-run">golden runs</Term>), each replayed against the candidate. The [regression testing guide](/learn/testing/regression-testing-agents) explains how to build one. This guide is about what happens after the suite runs.

## Drafts vs published versions

A gated workflow has two things that can run:

- **The draft**: the latest save. The editor, manual runs, test webhooks and replays run it, so you can try changes freely.
- **The published version**: one saved version, picked on purpose. Production traffic (webhooks, schedules, app triggers, chat, forms, API calls from other systems, sub-workflow calls from production runs) runs it.

Separating the two changes some habits. A script that calls the workflow to "test my change" now gets production behaviour, so it has to ask for the draft explicitly. A webhook path you changed in the draft does not answer in production until you publish. And a run that pauses for approval should resume on the version it started with, even if a new one is published meanwhile.

Two details make the switch safe. First, a workflow that was never published should keep running its latest save everywhere, so adding versions breaks nothing. Second, turning a gate on should publish what production runs now as a **baseline**, so switching the gate on never takes production down. From then on, only gated publishes change what is live.

## The gate rule

The gate looks at evidence (a completed test run of the version's hash over the golden sets the gate names) and judges it against a policy. A sensible default policy is strict:

| Rule | Default | Why |
|---|---|---|
| Minimum pass rate | 100% | A regression suite holds cases that must keep working. |
| Maximum regressions | 0 | A case that passed on the golden run and fails now is the thing you are protecting against. |
| Inconclusive counts as failure | On | A case the replay could not judge proves nothing. |
| Minimum cases | 3 | A set of one case passes too easily. |
| Oldest golden run | 30 days | Old recordings drift from reality; rerun the baseline or re-record. |
| Cost and p95 latency increase | No limit | Optional, for workflows where a slower or pricier answer is a regression. |

Optionally, when the workflow uses content rules, the gate also blocks a version that adds new rule blocks the golden runs did not have.

A few principles matter more than the exact numbers:

- **Judge at publish time, under the policy in force then.** Loosening the policy lets an older run pass; tightening it blocks a run that passed before. Either change shows up in the audit trail.
- **Only plain runs count.** A test run with overrides (a different model, a lenient tool replay, answers taken from a recording instead of the live model) tested something other than the version. It can still be useful, but it is no proof for publishing.
- **The cases are part of the evidence.** If someone adds, removes or rescores a case after the run was queued, the run no longer proves the set as it is now.
- **Fail closed.** When the evidence is missing, stale or incomplete, the answer is "blocked", with the reasons.

That last point is what makes a gate readable. A blocked publish should say why in plain words, for example:

```text
Pass rate 0% is below the required 100%.
3 regressions; the gate allows 0.
```

### Gaming the gate

A pass rate can be raised without fixing anything: add forty cases that always pass, or delete the two that fail. For workflows where that matters, the gate's case list itself needs protecting. One way is to let only an admin decide which cases count: new cases run and show their results, but count toward nothing until an admin admits them, and removing a counted case needs approval. An admin can also mark a case as required, so it must pass whatever the overall pass rate.

## Overrides and who may grant them

Sometimes a blocked version has to ship: a known flaky case, an urgent fix, a change that is intentional but not yet re-recorded. A gate without an escape hatch gets switched off, which is worse. Two controlled hatches are better than none:

- **Request approval.** The builder sends the blocked version to the gate's approvers with a reason. The request shows the version, its hash, the test run and the gate's findings. An approver publishes exactly that version, or rejects it with a reason. Self-approval should be off unless someone senior turns it on, and a request should expire if nobody decides.
- **Override.** A small group (in most teams, admins only) can publish a blocked version directly, with a reason. The reason and the gate's findings are stored on the release, so the history shows both what was wrong and why it shipped anyway.

Approvals have one subtle rule: judge again when the approver decides, not only when the request was made. If the version's hash changed, another version was published, or the gate got stricter in a way the run now fails, the request is stale and should be refused. Otherwise an approver signs off on evidence that no longer holds.

Optionally, a gate can send every publish to an approver, even one that passed. That suits workflows where a person must sign off on any change to production, whatever the tests say.

## Rollback and unpublish

A gate controls the way in. You also need fast ways out, and they should not depend on the gate:

- **Rollback** returns production to a version that was published before, with a reason. It skips the gate, because that version already shipped. It should only accept a version whose hash still matches what was released, so "roll back to v3" means the v3 that actually ran.
- **Unpublish** takes the live version down. The workflow then behaves as if it had never been published, and production runs the draft. The gate never blocks this, since it is the way out of a bad release, but it does mean the draft runs in production ungated until a version is published again.
- **Deactivate**, on a gated workflow, works as a kill switch: every production entry point refuses the workflow until it is activated again.

When a gate is locked down for compliance, the ways out need the same care as the way in. If any builder can roll back to an old version, or unpublish and let an ungated draft serve production, the gate is only advisory. A locked-down gate should restrict these actions to admins too, and log every refused attempt.

## Audit

Every decision a gate makes is a record someone may ask for later. Keep a release history that lists, for each entry: the version, how it got there (passed, approved, overridden, ungated, rolled back, unpublished), who did it, when, the previous version, the reason and the test run it relied on. Send the same events to the <Term id="audit-log">audit log</Term>, including refusals: a builder who tried to loosen a locked gate and was stopped is worth knowing about.

Two smaller rules help. Never prune a version that was published, so a rollback always has something to return to. And store the override reason as free text the person wrote, not a checkbox; "customer escalation, case 4 is a known flaky retrieval" is useful a year later, "override" is not.

## What a gate does not do

- **It is only as strong as its cases.** A gate over three easy cases passes almost anything. The [agent evals guide](/learn/testing/agent-evals) covers building cases that matter.
- **It does not test what the recording cannot answer.** A <Term id="replay">replay</Term> answers tools from a recording, so a version that calls a new tool is inconclusive, and the gate (rightly) blocks it until someone records new golden runs.
- **It does not watch production.** A version that passed can still meet inputs nobody recorded. Monitoring and sampling real runs into the set are separate jobs.
- **Escape hatches are real.** An override or an unpublish puts untested behaviour into production. The audit trail makes that visible; it does not prevent it.

See also: [audit trails for agents](/learn/operations/audit-trails-for-agents), for what to record about each run and each decision.

## Release gates in L2M

In L2M a release gate is optional and off by default. Without one, publishing any saved version works at once and is recorded as `ungated`, and a workflow that was never published runs its latest save everywhere.

- **Drafts and versions.** Production entry points run the published version; the editor, `/webhook-test/`, manual runs and replays run the draft. The version pill in the editor shows what is live, for example **v3 live · draft +2** ([which version runs where](/product/release-gate#which-version-runs-where)).
- **The gate.** Set up under **Evaluations → Release gates**. A version publishes only with a completed replay job of its exact hash over the gate's golden sets. Defaults: 100% pass rate, no regressions, inconclusive cases count as failures, at least three cases, no new rule blocks, golden runs no older than 30 days unless the job reran the baseline ([the gate](/product/release-gate#the-gate)).
- **Approvals and overrides.** When the gate has approvers set up, a blocked publish can go to them as a release request in **Approvals**; self-approval is off by default and requests expire after 7 days. Only an admin can override, with a reason that is stored on the release and audited as `release.overridden` ([release requests](/product/release-gate#release-requests)).
- **Enforced gates.** An admin can enforce a gate. Then only an admin can loosen or switch it off, change its approvers, admit or remove cases, roll back or unpublish, and refused attempts are audited.
- **History, rollback and unpublish.** **Releases** lists every publish and unpublish. Rollback returns to an earlier released version with the same hash; unpublish makes production run the draft and is never blocked by the gate ([history and rollback](/product/release-gate#history-and-rollback)).
- **CI.** `l2m release publish <workflowId> --version <n> --run <replayRunId>` exits 0 when published, 1 when blocked, and 4 when the version needs approval ([publish the version that passed](/product/replay-and-release-gate#recipe-publish-the-version-that-passed)).

In the live demo, an FAQ workflow's new version adds a prefix to every answer. Its replay job failed all three cases, and publishing is blocked with a 0% pass rate and three regressions.

<TryInDemo workflow="wf-demo-faq-release" recorded />

## Further reading

- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (Anthropic engineering, January 2026): regression evals "should have a nearly 100% pass rate", and automated evals run "in CI/CD, running on each agent change and model upgrade"
- [CI for agents: golden runs, replay and a release gate](/blog/ci-for-agents-replay-and-release-gate): how the pieces fit together in L2M
- In L2M: [Release gate and publish](/product/release-gate), [Replay in CI and the release gate](/product/replay-and-release-gate)
