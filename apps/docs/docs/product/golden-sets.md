# Golden sets, replay jobs and scorers

A **golden set** is a regression suite for one workflow: a list of [golden runs](./golden-runs.md) (and, if you like, hand-written cases). A **replay job** replays every golden run in one or more sets against a candidate (the draft, or a saved version) in the background, scores each case and reports pass, fail or inconclusive per case. Use it before you ship a prompt, model, tool or workflow change: one job tells you which real runs the change breaks.

Everything stays on your deployment. Replays use the deployment's own providers and secrets.

## Golden sets

On the **Evaluations** page, **Golden sets** lists the sets of the workflows you can read. To build one:

1. Save the runs you care about as golden runs on the **Runs** page (**Save as golden**).
2. Create a golden set for the workflow.
3. Add golden runs of that workflow to the set. Each becomes a case: its recorded input is the case input, and its recorded output is what the case is compared with. A golden run can be in a set once.

A golden set is an eval dataset tied to a workflow, so the API and the older eval runs see it too: `GET /api/eval/datasets?workflowId=…` lists them, with `goldenRunCount`.

A hand-written case (an input and an expected value, without a golden run) can sit in a golden set, but replay jobs skip it: a replay can only answer the workflow's connectors, HTTP calls, MCP calls and code nodes from a recording. Run hand-written cases with an eval run.

Deleting a golden run that a set uses does not remove the case: the next job reports it as inconclusive ("the golden run for this case was deleted"), so a suite never shrinks without anyone noticing.

## Replay jobs

**Run replay** on a set opens the job dialog:

- **Candidate**: the draft (the workflow as saved now) or a saved version. The candidate is fixed when the job starts: saving the draft while the job runs does not change what it tests. The job records the candidate's workflow hash.
- **MCP matching**: strict or lenient, as for a single replay.
- **Ignore paths** and **number tolerance** for the output comparison.
- **Budget**: the most the job may spend on model and judge calls (default `REPLAY_JOB_DEFAULT_MAX_COST_USD`, 5 USD). Once the job has spent it, no further cases start and the job ends as **failed** with the reason.
- **Scorers** (below). Without any, each case is scored with `status` (the same status as the golden run) and `json_equal` against the golden run's output, which is the single-replay verdict.

`POST /api/replay/runs` answers `202` straight away; the job runs in the background. The page shows progress as cases finish (done of total, running, spent), and every case with its scorers. Click a case to see its scores and the run diff (output, tool calls, totals, replay health), the same view as a single replay.

A case is:

| Case | When |
| --- | --- |
| pass | every scorer passed |
| fail | a scorer failed |
| inconclusive | the replay could not be trusted (an unanswered MCP call, a node the golden run never saw, a changed code node, a cut recording, and the other reasons listed for a single replay), the golden run was deleted, or the replay could not run. Scorers do not run |
| skipped | a hand-written case |

The pass rate counts passed cases out of those not skipped.

**Cancel** stops a queued or running job: no further cases start, and cases that are running are aborted. A job's status is one of `queued`, `running`, `completed`, `failed` (over budget), `canceled` or `interrupted`.

### Running in the background

Replay jobs and eval runs share one runner. `REPLAY_CONCURRENCY` (default 2) caps how many cases run at once across the whole deployment, whatever the number of jobs; jobs take turns in the order their cases were queued. `REPLAY_JOB_MAX_CASES` (default 200) caps the cases in one job.

A job runs in the API process that accepted it. If that process stops, the job does not resume: when the API starts again, jobs it left queued or running are marked **interrupted**. With `HA_ENABLED`, an instance only marks jobs no instance has written progress for in five minutes, so a job another live instance is running is left alone. Start an interrupted job again to rerun it.

## Scorers

Every scorer returns pass or fail, a score from 0 to 1 and a reason you can read. Scorers on a case take precedence over the job's scorers.

| Scorer | Checks | Options |
| --- | --- | --- |
| `status` | The run finished with the expected status | `expect` (default `success`; a replay job's default scorer expects the golden run's status) |
| `json_equal` | The output (at `path`) equals the expected value or the golden run's output | `against: expected \| baseline`, `ignorePaths` (globs, as for replay), `numberTolerance`, `ignoreArrayOrder`. Timing and id fields are always ignored |
| `json_schema` | The output (at `path`) validates against a JSON Schema | `schema` (at most 64 KB). Remote `$ref`s are never fetched; a schema that does not compile fails the scorer |
| `text_similarity` | Word-overlap similarity of the output text to the expected or recorded text | `threshold` (default 0.8), `against`, `path` |
| `tool_sequence` | The tool calls against the golden run's, or a listed sequence | `mode: exact \| subsequence \| set \| superset_allowed` (default `exact`), `args: exact \| keys \| ignore` (default `ignore`; `set` modes compare tool names only), `expected: [{ tool, server?, args? }]`, `forbiddenTools` |
| `no_new_guard_blocks` | No block, review or approval verdict the golden run did not have (shadow verdicts do not count) | `failOnRemoved`: also fail when a block the golden run had went away (a looser policy) |
| `budget` | Cost, tokens and latency within limits | `maxCostUsd`, `maxTokens`, `maxLatencyMs`, and `maxCostIncreasePct`, `maxTokensIncreasePct`, `maxLatencyIncreasePct` against the golden run. A cost that cannot be priced fails a cost limit |
| `llm_judge` | A model grades the output against a rubric | `rubric`, `mode: absolute \| pairwise`, `votes` (1–5), `threshold`, `path`, `providerId`, `model`, `secretRef` |

The scorers from earlier releases (`exact_match`, `contains`, `regex`, `context_precision`, `context_recall`, `faithfulness`, `answer_relevance`) work in replay jobs too.

### LLM judge

- **Absolute** asks the judge for a score from 0 to 1 against the rubric, given the input, the output and the golden run's output as a reference. With several votes the scores are averaged. The default threshold is 0.7.
- **Pairwise** shows the judge the golden run's output and the candidate's and asks which meets the rubric better. Each vote asks twice with the order swapped (which order goes first is random), so a judge that favours the first or second position cancels out; a judge that picks the same position both times is noted in the reason. A win scores 1, a tie 0.5 and a loss 0; the default threshold is 0.5, meaning "at least as good as the golden run".
- The judge runs at temperature 0. A response that is not the JSON the prompt asks for counts as an unparseable vote; when every vote is unparseable the scorer fails and says so.
- Credentials: name the provider with `providerId` and, if it needs a key, a `secretRef: { secretId }` from the secret store. The secret must belong to, or be shared with, the workflow's project, and you need permission to use secrets there; a scorer never carries a raw key, and the key is never stored with the results. A judge scorer that names no provider uses the deployment default (`EVAL_JUDGE_PROVIDER_ID`, `EVAL_JUDGE_MODEL`), which needs `EVAL_JUDGE_ENABLED=true`. `EVAL_JUDGE_BASE_URL` points the default provider at an endpoint inside your deployment (an OpenAI-compatible server or Ollama); scorers cannot set a URL.
- Judge calls are priced with the deployment's price table and count toward the case's cost and the job's budget (`judgeCostUsd` in the summary).

## Eval runs

Eval runs (`POST /api/eval/runs`) now run in the background on the same runner: the API answers `202 { run, runId }` and the run reports progress like a replay job. The old blocking answer (`200 { ok, runId, summary }`) is still available with `?wait=true` for one release; it carries a `Deprecation: true` header.

An eval run runs every case of a dataset live against the workflow as saved now. It does not stub anything; for that, use a replay job. A case that is a golden run is compared with the golden run, so the `tool_sequence`, `no_new_guard_blocks` and `budget` scorers work on eval runs too.

## Access

Access follows the workflow. Reading golden sets, jobs, scores and diffs needs read access to the workflow; creating or changing a set needs edit access; starting or canceling a job needs run access. Admins always pass. A dataset without a workflow follows its project; one with neither (made before datasets were scoped) is visible to builders and admins only. Creating a set, adding a case, starting and canceling a job are audited.

## API

- `GET /api/eval/datasets?workflowId=&projectId=` (viewer; sets and datasets you can read, with `workflowId` and `goldenRunCount`)
- `POST /api/eval/datasets` (builder; `{ name, description?, workflowId?, projectId? }`; with `workflowId` it is a golden set in the workflow's project)
- `POST /api/eval/datasets/:id/recordings` (builder; `{ recordingId, name?, scorers? }`; `201 { fixture }`; 409 when the golden run is already in the set)
- `GET /api/eval/datasets/:id/fixtures`, `DELETE /api/eval/datasets/:id`, `DELETE /api/eval/fixtures/:id`
- `POST /api/replay/runs` (builder; `{ datasetIds, draft? | version?, mcpMode?, ignorePaths?, numberTolerance?, scorers?, maxCostUsd? }`; `202 { run }`; 400 for a set without golden runs or a judge secret you cannot use; 409 over `REPLAY_JOB_MAX_CASES`)
- `GET /api/replay/runs?workflowId=&datasetId=` (viewer)
- `GET /api/replay/runs/:id` (viewer; `{ run }` with candidate, options, progress, summary and case results without diffs)
- `GET /api/replay/runs/:id/results/:resultId` (viewer; `{ result }` with scores and `replay`, the run diff)
- `POST /api/replay/runs/:id/cancel` and `POST /api/eval/runs/:id/cancel` (builder; 409 once finished)
- `GET /api/eval/runs/:id/events` (viewer; server-sent `progress` events after each case and `done` at the end, each `{ type, run }`)

## In CI: `l2m replay run --set`

```bash
export L2M_API_URL=https://l2m.example.com
export L2M_API_KEY=…            # a builder API key
l2m replay run --set ds_… --version 12 --max-cost 2 --timeout 900
```

`--set` (repeatable) starts a replay job over those golden sets and waits for it, polling every two seconds. `--draft` (the default) or `--version <n>`, `--mcp`, `--ignore-path` and `--number-tolerance` work as for a single replay; `--max-cost` sets the job's budget; `--timeout` (seconds, default 1800) stops waiting, and the job keeps running on the server. `--json` prints the whole job with `exitCode`. The exit codes are those of a single replay:

| Exit code | Meaning |
| --- | --- |
| 0 | Every case passed (skipped cases aside) |
| 1 | At least one case failed |
| 2 | Usage error, including requests the API rejects (HTTP 400) |
| 4 | Inconclusive: a case was inconclusive, no case passed, the job did not complete (canceled, over budget, interrupted), it outlived `--timeout`, or the API could not be reached |

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `REPLAY_CONCURRENCY` | 2 | Cases running at once across all replay jobs and eval runs |
| `REPLAY_JOB_MAX_CASES` | 200 | Most cases in one job or eval run |
| `REPLAY_JOB_DEFAULT_MAX_COST_USD` | 5 | A replay job's budget when the request names none |
| `EVAL_JUDGE_BASE_URL` | unset | Endpoint for the default judge provider |

## Not covered yet

- Candidates are the draft or a saved version only: no workflow file from git, no per-node model or guard-profile overrides, and model calls always run live (no model tape). Each case runs once (no repeats for flaky cases), and every case is compared with its recording, not with a fresh baseline rerun. There is no cost estimate before a job starts; the budget only stops it.
- Interrupted jobs are not resumed; start them again.
- No release gate yet: a job's result does not block publishing.
- Golden sets cannot be exported to or imported from files.
- Old replay jobs are not pruned automatically. Deleting a set deletes the jobs that started from it (for a job over several sets, the first one).
