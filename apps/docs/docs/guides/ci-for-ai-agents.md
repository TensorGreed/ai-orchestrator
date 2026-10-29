---
title: "CI for AI agents: golden runs, replay jobs and a release gate"
description: "Regression-test AI agents in CI: save golden runs, group them into golden sets, replay changes with l2m replay run, upload JUnit, and publish through a release gate."
---

# CI for AI agents

A prompt edit, a model upgrade or a new tool can change what an agent does as much as a code change can, but most teams ship those changes untested. **CI for AI agents** treats them like code: keep a set of known-good runs, replay every change against them, fail the build on a regression, and only let a version reach production after it passed.

L2M does this on your own deployment, with the `l2m` command line in your pipeline. The loop:

```text
good run ──Save as golden──▶ golden set ──l2m replay run --set──▶ pass / fail / inconclusive ──▶ l2m release publish
```

## 1. Save golden runs

A **golden run** is a run kept as a reference: its input, every node's result, its MCP calls and, when recorded, its model calls.

1. In the editor, open **⋯** and turn on **Record MCP calls**, then run the workflow on a realistic input. Without a cassette, a replay cannot answer MCP calls and is inconclusive.
2. On the **Runs** page, choose **Save as golden** on the finished run, and give it a name.

Repeat for the cases that matter: the common path, the edge cases, the runs that went wrong once. To build cases from real traffic instead, turn on [production capture](../product/production-capture.md): it samples production runs with personal data masked, and you promote the useful ones.

Secrets are scrubbed before anything is stored, and golden runs are kept until you delete them.

## 2. Group them into a golden set

On **Evaluations → Golden sets**, create a set for the workflow and add its golden runs. Each becomes a case: the recorded input goes in, the recorded output is what the candidate is compared with.

**Run replay** on the set to try it from the studio first. The dialog asks the server for an estimate (cases, model calls, cost) before it lets you start. Without custom scorers, each case is scored on its status and on JSON equality with the golden output. Other scorers (JSON schema, text similarity, tool sequence, budget, an LLM judge) are listed in [Scorers](../product/golden-sets.md#scorers).

## 3. Replay every change in the pipeline

The CLI reads the deployment from two variables. Use a builder API key with run access to the workflow, kept in your CI secret store:

```bash
export L2M_API_URL=https://l2m.example.com
export L2M_API_KEY=…
```

Keep the workflow JSON in git and replay the golden set with that file as the candidate on every pull request. Nothing is saved on the server:

```bash
#!/usr/bin/env sh
set -u

pnpm l2m replay run \
  --set "$GOLDEN_SET_ID" \
  --file workflows/support-bot.json \
  --max-cost 2 \
  --timeout 1200 \
  --junit reports/l2m-replay.xml
exit $?
```

The step waits for the job, prints the failing cases and their failing scorers, and exits with the verdict:

| Exit code | Meaning | Pipeline |
| --- | --- | --- |
| 0 | Every case passed | Continue |
| 1 | At least one case failed: a regression | Fail the build |
| 2 | Usage error, or flags or a workflow file the API rejects | Fail; fix the step |
| 4 | Inconclusive: a case could not be judged, the job did not complete or outlived `--timeout`, or a request failed | Fail; a replay that proves nothing is not a pass |

`--junit` writes one test case per golden case (a regression is a `failure`, an inconclusive case an `error`) even when the job fails or times out. Upload it with your CI system's test-report step in a step that runs whatever the exit code.

Useful extras:

- `--estimate` prints the size and expected cost of the job without starting it.
- Overrides try a change without editing the file: `--model <nodeId>=<model>`, `--provider-model`, `--guard-profile`, `--models replay` (answer model calls from the recorded tape) and `--repeats <1-5>` with `--aggregate`.
- `--no-wait`, then `pnpm l2m replay status <runId> --wait`, for long suites.

## 4. Publish through the release gate

A workflow has a draft and, once published, a published version that production traffic runs. Turn on a **release gate** under **Evaluations → Release gates**: a version then reaches production only after a replay job of that exact saved version passed the gate's golden sets under its policy (by default a 100% pass rate, no regressions and at least 3 cases).

A job on a workflow file or with overrides never counts as release proof, so publish from the pipeline by replaying the saved version:

```bash
pnpm l2m replay run --set "$GOLDEN_SET_ID" --version 12 --json > job.json || exit $?
pnpm l2m release publish "$WORKFLOW_ID" --version 12 --run "$(jq -r .id job.json)"
```

`release publish` exits 0 when published, 1 when the gate blocks it (with the reasons) and 4 when the gate's policy needs an approver, whose request lands in the Approvals inbox. An admin can override with `--override-reason`, which is stored and audited.

## How it works

- **What runs live.** Logic and guard nodes run. MCP calls are answered from the golden run's cassette. Code nodes and external writes (Slack, email, HTTP, database writes) are answered from the recording and never run. Model nodes call the model, or the recorded tape with `--models replay`.
- **What is compared.** Status, output (whitespace, timing and id fields aside), tool calls side by side, and token, cost and model-call totals.
- **Inconclusive is not a pass.** An unanswered MCP call, a node the golden run never saw, a changed code node or a cut recording makes the case inconclusive, and the CLI exits 4.

## What it does not do

- Hand-written cases without a golden run are skipped by replay jobs; run them with an eval run.
- Live write calls are never allowed in a replay job.
- A replay with live models can differ from run to run; use repeats or the model tape when you need stable verdicts.

## Next steps

- Reference: [Golden runs and replay](../product/golden-runs.md), [Golden sets, replay jobs and scorers](../product/golden-sets.md), [Release gate and publish](../product/release-gate.md), [Replay in CI and the release gate](../product/replay-and-release-gate.md)
- Guides: [Test MCP servers in CI](./test-mcp-servers-in-ci.md), [Human approval for agent tool calls](./human-approval-for-agent-tool-calls.md)
- Watch a release gate block a change in the [live demo](https://lsquarem.com/demo/?mode=editor&workflowId=wf-demo-faq-release){target="_self"}
