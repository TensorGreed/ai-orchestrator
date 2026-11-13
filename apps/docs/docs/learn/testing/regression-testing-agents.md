---
title: "Regression testing AI agents: golden runs and replay"
sidebarTitle: "Regression testing agents"
description: "Catch a prompt, model or tool change that breaks your agent before users do: save known-good runs, replay changes against recordings, gate CI."
level: intermediate
about: golden-run
related: [golden-run, replay, golden-set, release-gate, eval]
socialCard: true
---

# Regression testing AI agents

A regression test for an agent checks that a change (a new prompt, another model, an updated tool) did not break something that used to work. The practical way to build one is to save known-good runs, called golden runs, and <Term id="replay">replay</Term> a changed workflow against them, with outside calls answered from the recording so the test has no side effects. Group the runs into a set, run the set in CI, and fail the build when a run that used to pass now fails.

## What a regression is for an agent

A regression is behaviour that used to be right and is now wrong. In ordinary software, a code change causes it. An agent has more moving parts that can cause one, and most of them are not code:

- **A prompt edit.** You add a sentence to fix one case, and the agent starts declining a request it used to handle.
- **A model change.** A new model version, or another provider, answers in a different format or picks different tools.
- **A tool change.** An MCP server renames a parameter, or changes what a tool returns, and the agent's next step goes wrong.
- **A settings change.** A lower temperature, a smaller iteration limit, a different retrieval setting.

Each of these can pass a quick manual check and still break a case you did not try. A <Term id="eval">regression eval</Term> runs the cases you already know should work, every time something changes. Its pass rate should be at or near 100%; any drop is a signal. The [agent evals guide](/learn/testing/agent-evals) explains how it differs from a capability eval.

## Golden runs: what to record

The easiest source of test cases is runs that already went well. A <Term id="golden-run">golden run</Term> is one of those runs, saved as the reference. To be useful later it has to hold more than the final answer:

| Record | Why |
|---|---|
| The input | To run the same case again. |
| Each step's result | To see where a changed run first went a different way. |
| Tool calls, with their arguments and results | To answer them again without calling the real tool, and to compare the path. |
| Model calls, with their answers | Optionally, to answer them again without calling the model. |
| Status, cost, tokens and timing | To catch a run that still answers right but now costs twice as much. |

Save the common path first, then the edge cases, then every run that once went wrong and was fixed. Strip secrets before anything is stored.

## Replay without side effects

Running a test case against live systems is a problem when the agent can act. A refund agent's test would refund someone. Replay solves this by answering the outside world from the recording:

1. Take the changed workflow (the candidate) and the golden run's input.
2. Run the candidate. When a step would call a tool, an API or a database, look up the same call in the recording and return the recorded answer instead.
3. Compare the candidate's run with the golden run.

The model is the part you usually want live, because a prompt or model change is what you are testing. So a typical replay calls the model for real and answers every tool from the recording.

That has a consequence: if the changed agent makes a call the recording does not have (a new tool, or different arguments), there is no recorded answer to give it. A careful replay does not guess. It stops and reports that case as **inconclusive**, because it cannot tell whether the new call would have worked.

## Verdicts: pass, fail, inconclusive

A regression test for an agent needs three outcomes, not two:

- **Pass**: the candidate behaved like the golden run on everything you check.
- **Fail**: it behaved differently in a way you check: another status, another answer, a forbidden tool call, a higher cost than allowed.
- **Inconclusive**: the replay could not judge the case, for example because the candidate made a call the recording cannot answer, or the recording was cut short.

Treat inconclusive as "not a pass". A pipeline that lets inconclusive cases through will slowly fill with tests that prove nothing. The fix is usually to record the case again with the new behaviour, after checking that the new behaviour is right.

How strict "behaved like" is depends on the graders. Exact equality of the output is the simplest and works for structured output. For free text, compare with a similarity threshold, validate a schema, or use a model grader with a rubric; otherwise every reworded but correct answer fails.

## Grouping runs into a set

One golden run is a test case. A <Term id="golden-set">golden set</Term> is the suite: the golden runs that together describe what one workflow must keep doing. Practical rules:

- **One set per workflow**, or per behaviour of a large workflow (refunds, address changes, escalations).
- **Name cases by what they check**, not by when they were recorded: "refund outside 30-day window is declined".
- **Keep it small enough to run on every change.** Twenty well-chosen cases that run in minutes beat two hundred that run overnight.
- **Run each case more than once** when the model is live. A case that passes two times out of three is flaky; requiring every repeat to pass is the per-case form of pass^k.

## Running it in CI

A regression suite is worth most when it runs without anyone remembering to run it. The pattern is the same as for code tests:

1. Keep the workflow definition in version control, next to the code that uses it.
2. On every pull request, replay the golden set against the changed definition.
3. Map the result to an exit code: 0 when every case passed, non-zero when any failed or was inconclusive.
4. Write a JUnit XML report, so your CI system shows each case as a test.
5. Only let a version reach production after its tests passed on that exact version: a <Term id="release-gate">release gate</Term> (see [release gates for AI workflows](/learn/testing/release-gates)).

Replays with a live model cost money and time, so set a cost cap and a timeout on the step.

## Keeping the set fresh

A golden set built once goes stale. Real users ask things you never thought of, and the set never sees them. Two habits keep it current:

- **Promote real runs.** Sample a share of production runs, mask personal data before they are stored, review them, and promote the useful ones into the set. A bug report becomes a case the same way.
- **Re-record on purpose.** When a change is intended (a new answer format, a new tool), review the diff, then record new golden runs for the cases it affects. Never re-record just to make a failing test pass.

## Limits

Replay tests catch a lot, not everything. Know what yours cannot see:

- **Side effects are not tested.** A recorded answer from a payment API says nothing about whether today's payment API still accepts the call.
- **Live data is not tested.** A tool that reads the current state of the world gets last month's answer from the recording.
- **New behaviour cannot be judged** until it is recorded. A replay can tell you something changed; it cannot tell you a new tool call is correct.
- **A live model varies.** Even with repeats, a rare failure can slip through a small set.
- **The set only covers what is in it.** A clean pass means "no regression on these cases", not "no regression".

## Regression testing in L2M

L2M, a self-hosted workflow builder and agent runtime, implements this loop on your own deployment:

- **Golden runs.** On the Runs page, **Save as golden** keeps a finished run as a reference: its input, every node's result, its MCP tool calls and, if you turned on **Record MCP calls** before the run, a cassette of its MCP traffic plus a tape of its model calls ([golden runs](/product/golden-runs); [testing agents that call MCP tools](/learn/testing/testing-mcp-tools) covers cassettes and mocks). Secrets are scrubbed before anything is stored.
- **Replay.** Logic steps run, models run live by default, and by default MCP calls are answered only from the cassette. HTTP requests, database writes, messages and code nodes are answered from the recording ([what a replay does](/product/golden-runs#what-a-replay-does)). A replay job can opt a server into live read-only calls, or a node into a live read such as an HTTP GET; writes never run live. A call the recording cannot answer makes the result inconclusive.
- **Golden sets and replay jobs.** A golden set groups golden runs for one workflow. A replay job runs them against a draft, a saved version or a workflow file, grades each case with scorers, and can repeat each case up to five times ([golden sets](/product/golden-sets)).
- **CI.** `l2m replay run --set <id> --file <workflow.json> --junit <report.xml>` replays a workflow file from your repository and exits 0 when every case passed, 1 on a regression, and 4 when a case was inconclusive or the job did not complete ([CI for AI agents](/guides/ci-for-ai-agents)).
- **Release gate.** Optionally, a workflow's new version reaches production only after a replay job of that exact saved version passed; by default that means a 100% pass rate with inconclusive cases counted as failures, no regressions, no new content-rule blocks, at least three cases, and golden runs no older than 30 days unless the job reruns the baseline. Only an admin can override a blocked gate, with a reason that is audited ([release gate](/product/release-gate#the-gate)).
- **Fresh cases.** Optionally, production capture samples real runs into an inbox, masks personal data first (on by default), and lets a builder promote them into a golden set ([production capture](/product/production-capture)).

In the live demo, an FAQ workflow's new version adds a prefix to every answer. Its recorded replay job failed all three cases, and the release gate refuses to publish it, with the reasons: a 0% pass rate where 100% is required, and three regressions where none are allowed.

<TryInDemo workflow="wf-demo-faq-release" recorded />

## Further reading

- [CI for AI agents](/guides/ci-for-ai-agents): the step-by-step setup in L2M
- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (Anthropic engineering, January 2026): capability versus regression evals, pass@k and pass^k
