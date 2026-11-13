---
title: "CI for agents: golden runs, replay and a release gate"
description: "How L2M tests an agent change before it ships: save known-good runs, replay changes against recordings in CI, and publish only the version that passed."
date: 2026-11-12
author: "The L2M team"
related: [golden-run, replay, golden-set, release-gate]
demo: wf-demo-faq-release
demoRecorded: true
socialCard: true
---

# CI for agents: golden runs, replay and a release gate

A prompt edit can change what an agent does as much as a code change can, and most teams ship it with a quick manual try. Between 23 and 24 October 2026 we merged the pieces that let L2M treat agent changes like code: keep known-good runs, replay every change against them with the outside world answered from a recording, fail the build on a regression, and let only a version that passed reach production. This post explains how those pieces fit together and why we made the choices we did.

## The problem: changes you cannot unit test

An agent workflow mixes three kinds of behaviour. Logic nodes are deterministic. Model calls are not. Tool calls reach real systems: they read tickets, send email, write to databases. A useful test has to run the first, judge the second, and must never do the third.

Running the workflow against live systems in CI fails on all counts. It is slow, it costs money, the answers drift, and a test that sends a real refund email is not a test. Mocking every tool by hand works for a while, until the mocks no longer look like the real servers.

So we started from what already exists in production: real runs.

## Golden runs: a run you trust, kept whole

A <Term id="golden-run">golden run</Term> is a finished run saved as a reference ([PR #45](https://github.com/TensorGreed/ai-orchestrator/pull/45)). It keeps the input, every node's result and the run's MCP calls as a cassette. Secrets are scrubbed before anything is stored, and golden runs stay until someone deletes them or their workflow; they are not purged by age.

Writing good cases by hand is slow, so [production capture](/product/production-capture) ([PR #56](https://github.com/TensorGreed/ai-orchestrator/pull/56), 24 October) does it from traffic. It is off until a builder turns it on for a workflow, and then samples real runs (10% by default, at most 20 a day), masks the personal data in them, and puts them in a **Captured runs** inbox. A builder promotes the useful ones into a golden set in one click.

## Replay: run what is safe, answer the rest from the recording

<Term id="replay">Replay</Term> runs a candidate version of the workflow on a golden run's input. Each node is handled by its class:

| Node | In a replay |
| --- | --- |
| Logic, content rules | Runs |
| Model (LLM Call, Agent, Supervisor) | Calls the model live, or answers from the recorded tape |
| MCP tools | Answered from the cassette, unless a job lets an admin-marked read-only tool call its server live |
| Code, external writes (email, HTTP, database) | Answered from the recording; never runs |
| External reads (retrieval, web, connector reads) | Answered from the recording; a job can run a few pure reads live, such as an HTTP GET or a sheet read |

Two rules matter more than the table.

**Inconclusive is not a pass.** If the candidate makes an MCP call the cassette cannot answer, reaches a node the golden run never saw, or changed a code node, the case is inconclusive. We could have let those through as "probably fine". We did not, because a replay that proved nothing must not look like one that passed.

**Nothing is written.** Replays do not write <Term id="agent-memory">session memory</Term>, knowledge bases or the tool cache, and they do not fire error workflows or notifications. By default the only live traffic is the model calls, and their spend still counts toward [budgets](/product/budgets). A job can also let named read-only nodes and read-only MCP tools call live; such a job never counts as release proof.

## Golden sets, scorers and replay jobs

A <Term id="golden-set">golden set</Term> groups the cases for one workflow ([PR #47](https://github.com/TensorGreed/ai-orchestrator/pull/47)). A replay job runs every case against a candidate and scores it. By default a case is scored on its status and on JSON equality with the golden output; other scorers check a JSON schema, text similarity, the tool-call sequence, a cost budget, or ask a model to judge.

Live models vary from run to run. [PR #54](https://github.com/TensorGreed/ai-orchestrator/pull/54) added two answers. First, recorded runs now keep their model calls as a tape, and a job can answer model calls from it. That tests a change to the logic around the model with no model drift. Second, a job can repeat each case up to five times and aggregate the results.

This matches how the field describes it. Anthropic's guide to agent evals calls these regression evals, which "should have a nearly 100% pass rate" and "protect against backsliding", as distinct from capability evals that start low.

## `l2m replay run` in CI

The `l2m` command line runs a job from a pipeline against your own deployment. [PR #52](https://github.com/TensorGreed/ai-orchestrator/pull/52) made it CI-grade: it can replay the workflow JSON in your repository as the candidate, so a pull request is tested before anything is saved on the server:

```bash
pnpm l2m replay run --set "$GOLDEN_SET_ID" --file workflows/support-bot.json \
  --max-cost 2 --junit reports/l2m-replay.xml
```

The exit code is the verdict: `0` every case passed, `1` a regression, `2` a usage error, `4` inconclusive or a failed request. We gave inconclusive its own code so a pipeline can fail on it, and by default it should. `--junit` writes one test case per golden case for your CI's test report, and `--estimate` prints the expected model calls and cost before anything runs.

## The release gate

Tests in CI only help if production runs the version that was tested. The [release gate](/product/release-gate) ([PR #55](https://github.com/TensorGreed/ai-orchestrator/pull/55)) separates a workflow's draft from its published version. With a gate switched on, a version is published only when a replay job of that exact saved version passed the gate's golden sets under its policy: by default a 100% pass rate, no regressions and at least three cases. A job that replayed a file from disk, ran with overrides, or answered models from the tape never counts as proof.

Gates can also require an approver, and an admin can override a blocked publish with a reason, which is stored and audited. Every publish, override and rollback lands in the release history.

A gate is only as strong as its cases. On an enforced gate, a builder could make a failing version pass by adding easy cases or deleting the hard ones. [PR #58](https://github.com/TensorGreed/ai-orchestrator/pull/58) closed that: enforced gates count only cases an admin admitted, new cases wait for admission, and an admin can mark a case **required** so it must pass on every publish whatever the pass rate.

## What it does not do

- It does not run code nodes or external writes in a replay. A change to a code node makes the case inconclusive; save a new golden run after the change.
- It does not make live models deterministic. Use the model tape or repeats when you need stable verdicts.
- Hand-written cases without a golden run are skipped by replay jobs; run them with an eval run instead.
- It is not on by default. Without golden sets and a gate, workflows save and run as before.

## Try it in L2M

Open the FAQ answerer in the [live demo](https://lsquarem.com/demo/?mode=editor&workflowId=wf-demo-faq-release){target="_self"} to watch a <Term id="release-gate">release gate</Term> block a change, with no sign-up. To set it up on your own deployment, follow [CI for AI agents](/guides/ci-for-ai-agents). The reference pages are [Golden runs and replay](/product/golden-runs), [Golden sets, replay jobs and scorers](/product/golden-sets), [Replay in CI and the release gate](/product/replay-and-release-gate) and [Release gate and publish](/product/release-gate).

## Further reading

- Concepts: [Regression testing AI agents](/learn/testing/regression-testing-agents), [AI agent evals](/learn/testing/agent-evals)
- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (Anthropic, January 2026): tasks, graders, transcripts, regression versus capability evals
- Pull requests: [#45 golden runs](https://github.com/TensorGreed/ai-orchestrator/pull/45), [#47 golden sets and scorers](https://github.com/TensorGreed/ai-orchestrator/pull/47), [#52 CLI](https://github.com/TensorGreed/ai-orchestrator/pull/52), [#54 model tape](https://github.com/TensorGreed/ai-orchestrator/pull/54), [#55 release gate](https://github.com/TensorGreed/ai-orchestrator/pull/55), [#56 production capture](https://github.com/TensorGreed/ai-orchestrator/pull/56), [#58 case admission](https://github.com/TensorGreed/ai-orchestrator/pull/58) (GitHub)
