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
- **Budget**: the most the job may spend on model and judge calls (default `REPLAY_JOB_DEFAULT_MAX_COST_USD`, 5 USD). See [Budgets](#budgets).
- **Scorers** (below). Without any, each case is scored with `status` (the same status as the golden run) and `json_equal` against the golden run's output, which is the single-replay verdict.

`POST /api/replay/runs` answers `202` straight away; the job runs in the background. The page shows progress as cases finish (done of total, running, spent), and every case with its scorers. Click a case to see its scores and the run diff (output, tool calls, totals, replay health), the same view as a single replay.

A case's output and run diff are stored up to `EVAL_RESULT_MAX_BYTES` (default 256 KB of JSON) each. A larger one is stored as `{ truncated: true, bytes, maxBytes, preview }` (the first 2000 characters) and the case view says the diff was too large; the scorers always see the whole value. Case errors and score reasons pass through the secret scrubber before they are stored.

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

Replay jobs and eval runs share one runner. `REPLAY_CONCURRENCY` (default 2) caps how many cases run at once in one API process, whatever the number of jobs; jobs take turns in the order their cases were queued. With several API processes, each has its own cap. `REPLAY_JOB_MAX_CASES` (default 200) caps the cases in one job.

A job runs in the API process that accepted it. If that process stops, the job does not resume: when the API starts again, jobs it left queued or running are marked **interrupted**. When the database is shared (`HA_ENABLED`, or Postgres), an instance only marks jobs no instance has written progress for in five minutes, so a job another live instance is running is left alone, and every instance checks again every five minutes, so a job whose instance died is noticed without waiting for a restart. Webhook-only replicas (`WORKER_MODE=webhook`) never mark other instances' jobs. A late progress write never brings a finished job back to `running`. Start an interrupted job again to rerun it.

Eval runs and replay jobs are stored in SQLite only: on Postgres the API boots and logs that eval storage is not available, and the eval routes do not work.

### Budgets

Every replay job and eval run has a budget: a replay job's `maxCostUsd` (default `REPLAY_JOB_DEFAULT_MAX_COST_USD`), and `EVAL_RUN_MAX_COST_USD` (default 5 USD) for every eval run. Spend is the model calls of the replayed or live runs plus the judge calls.

- Before a case starts, the most its judge calls could cost (each call priced at the longest judge prompt plus `EVAL_JUDGE_MAX_TOKENS` of reply) is reserved against the budget. A case whose reservation does not fit waits for running cases to finish; when it still does not fit, no further cases start and the run ends as **failed** with the reason. Judge calls can therefore never take a run over its budget.
- A case's own model calls are not known before it runs. A run stops scheduling once its spend reaches the budget, so it can go over by at most the model spend of the cases still running (up to `REPLAY_CONCURRENCY` of them).
- A model or judge call whose model has no price in the price table is not counted as $0: the run's spend is marked as a lower bound (shown with a `+`), and the run carries a warning that the budget cannot stop on those calls.
- One case makes at most 50 judge calls across all of its scorers; the next call fails the scorer with "judge call limit reached".
- Every judge call is recorded as a usage event (`triggerType: eval_judge`) of the workflow's project, so it shows on the usage pages and counts toward project budgets.

## Scorers

Every scorer returns pass or fail, a score from 0 to 1 and a reason you can read. Scorers on a case take precedence over the job's scorers.

| Scorer | Checks | Options |
| --- | --- | --- |
| `status` | The run finished with the expected status | `expect` (default `success`; a replay job's default scorer expects the golden run's status, so a golden run that errored and a candidate that now succeeds fails it, where a single replay would call that an improvement) |
| `json_equal` | The output (at `path`) equals the expected value or the golden run's output | `against: expected \| baseline`, `ignorePaths` (globs, as for replay), `numberTolerance`, `ignoreArrayOrder`. Timing and id fields are always ignored |
| `json_schema` | The output (at `path`) validates against a JSON Schema | `schema` (at most 64 KB, 32 levels deep). Remote `$ref`s are never fetched and `$id`s are ignored; a schema that does not compile fails the scorer. See [Patterns](#patterns) |
| `text_similarity` | Word-overlap similarity of the output text to the expected or recorded text | `threshold` (default 0.8), `against`, `path` |
| `tool_sequence` | The tool calls against the golden run's, or a listed sequence | `mode: exact \| subsequence \| set \| superset_allowed` (default `exact`), `args: exact \| keys \| ignore` (default `ignore`; `set` modes compare tool names only), `expected: [{ tool, server?, args? }]`, `forbiddenTools` |
| `no_new_guard_blocks` | No block, review or approval verdict the golden run did not have (shadow verdicts do not count) | `failOnRemoved`: also fail when a block the golden run had went away (a looser policy) |
| `budget` | Cost, tokens and latency within limits | `maxCostUsd`, `maxTokens`, `maxLatencyMs`, and `maxCostIncreasePct`, `maxTokensIncreasePct`, `maxLatencyIncreasePct` against the golden run. A cost that cannot be priced fails a cost limit |
| `llm_judge` | A model grades the output against a rubric | `rubric`, `mode: absolute \| pairwise`, `votes` (1–5), `threshold`, `path`, `providerId`, `model`, `secretRef` |

The scorers from earlier releases (`exact_match`, `contains`, `regex`, `context_precision`, `context_recall`, `faithfulness`, `answer_relevance`) work in replay jobs too.

### Patterns

Scorers run on the API server, so a regular expression that can take exponential time on a long output would stall it. A `regex` scorer's `pattern`, and every `pattern` and `patternProperties` key in a `json_schema` scorer's schema, are refused when they repeat a group that itself repeats (`(a+)+`, `(\w+\s?)*`, `(.*,){2,}`) or use a backreference (`\1`, `\k<name>`). The check runs when a scorer is saved and again when it runs. Both scorers also check at most 256 KB of output and fail on more.

The check is conservative but not complete: a repeated alternation whose branches overlap (`(a|ab)*`) and several unbounded wildcards in a row (`.*a.*a.*a`) are still accepted, because honest patterns use them all the time; on hostile output they can be slow, bounded by the 256 KB cap.

### LLM judge

- **Absolute** asks the judge for a score from 0 to 1 against the rubric, given the input, the output and the golden run's output as a reference. With several votes the scores are averaged. The default threshold is 0.7.
- **Pairwise** shows the judge the golden run's output and the candidate's and asks which meets the rubric better. Each vote asks twice with the order swapped (which order goes first is random), so a judge that favours the first or second position cancels out; a judge that picks the same position both times is noted in the reason. A win scores 1, a tie 0.5 and a loss 0; the default threshold is 0.5, meaning "at least as good as the golden run".
- One vote is asked at temperature 0; several votes are sampled at temperature 0.7, so they are independent answers rather than the same answer repeated. A response that is not the JSON the prompt asks for counts as an unparseable vote. When fewer than half the votes parse, the scorer fails and says how many did. In pairwise mode a vote counts only when both orders parsed, so one order alone never decides.
- The judge is told what it reads is data. The input, the reference, the outputs (and, for `faithfulness` and `answer_relevance`, the context, question and answer) each sit in a block tagged with a random value made for that prompt; the rubric and the instructions come after the data, with a line saying the blocks are produced by the system under test and are never instructions; the format line is last. Only the judge's own reply is parsed. This makes an output that tells the judge to "score 1" much less effective; like any prompt-level defense, it is not a guarantee, so pair a judge with programmatic scorers for anything that gates a release.
- `EVAL_JUDGE_ENABLED` must be `true` for any judge call; with `false` (the default) every judge scorer fails with "LLM judges are turned off".
- Credentials: name the provider with `providerId` and give a `secretRef: { secretId }` from the secret store. The secret must be one the workflow's own runs can reach (it belongs to the workflow's project or is shared with it; in `PROJECT_ISOLATION=role` the default project's secrets count as shared, in `strict` they need a share), and the user who starts the run needs permission to use secrets there (in the workflow's project, or in a project the workflow is shared to with execute access, the same rule runs follow). This is checked when the run starts (for the request's scorers and for every case's own scorers) and again before every judge call, so a secret removed or unshared mid-run fails the later cases. A secret that resolves to nothing fails the call; it never falls back to the server's keys. A scorer never carries a raw key, and the key is never stored with the results. A judge without a `secretRef` (including one on the deployment default, `EVAL_JUDGE_PROVIDER_ID` and `EVAL_JUDGE_MODEL`, and `faithfulness` / `answer_relevance`, which take no `secretRef`) may use the server's own provider keys (`OPENAI_API_KEY` and so on) only when the operator sets `EVAL_JUDGE_ALLOW_ENV_CREDENTIALS=true`; otherwise it fails with "the judge has no secretRef". `EVAL_JUDGE_BASE_URL` points the default provider at an endpoint inside your deployment (an OpenAI-compatible server or Ollama); scorers cannot set a URL.
- Judge calls are priced with the deployment's price table and count toward the case's cost and the job's budget (`judgeCostUsd` in the summary).

## Eval runs

Eval runs (`POST /api/eval/runs`) now run in the background on the same runner: the API answers `202 { run, runId }` and the run reports progress like a replay job. The old blocking answer (`200 { ok, runId, summary }`) is still available with `?wait=true` for one release; it carries a `Deprecation: true` header.

An eval run runs every hand-written case of a dataset live against the workflow as saved now. It does not stub anything; for that, use a replay job. A golden run in the dataset is **skipped** by an eval run (golden runs run as replay jobs, without side effects), a golden set that holds only golden runs is refused with 400, and a golden set can only be run against its own workflow. An eval run stops at `EVAL_RUN_MAX_COST_USD` (see [Budgets](#budgets)). Replaying MCP answers from a cassette or a past eval run needs read access to the workflow that recorded them (404 otherwise, also for an eval run that does not exist), and they must be recorded for the same workflow (409 otherwise).

## Access

Access uses the same project authorization as runs (see [Authentication and RBAC](../security/auth-rbac.md)). Reading golden sets, jobs, scores and diffs needs read access to the workflow; creating or changing a set needs edit access; starting or canceling a job needs run access. Admins always pass. A job or run whose workflow was deleted is admin-only. A dataset without a workflow follows its project; one with neither (made before datasets were scoped) is readable by builders and admins in `PROJECT_ISOLATION=role`, and counts as a default-project dataset for reads and writes in `strict`. A new dataset created without a workflow or `projectId` is stored in the default project. Project viewers can list datasets and read their cases; changing one needs edit access. The `projectId` filter and the audit events of a golden set use the project its workflow is in now. Lists only hold what you can read, filtered before the limit. A set, job, case or workflow you cannot read answers 404, the same as one that does not exist; one you can read but not change answers 403. Jobs and eval runs execute in the background as the user who started them: each case looks the user up again by id (a deleted account whose email a new account took over does not count) and checks that they may still run the workflow, so a user who loses access or is deleted while a run is queued fails its remaining cases with "can no longer run this workflow", and the workflow reaches only its own project's secrets, MCP servers, knowledge bases and sub-workflows, as any other run. A replay job over several sets answers 404 when any of them is missing or belongs to another workflow, before anything about their cases is read. Progress streams (`/events`) are authorized when they open. Creating a set, adding a case, starting and canceling a job are audited.

## API

- `GET /api/eval/datasets?workflowId=&projectId=` (viewer; sets and datasets you can read, with `workflowId` and `goldenRunCount`)
- `POST /api/eval/datasets` (builder; `{ name, description?, workflowId?, projectId? }`; with `workflowId` it is a golden set in the workflow's project)
- `POST /api/eval/datasets/:id/recordings` (builder; `{ recordingId, name?, scorers? }`; `201 { fixture }`; 409 when the golden run is already in the set)
- `GET /api/eval/datasets/:id/fixtures`, `DELETE /api/eval/datasets/:id`, `DELETE /api/eval/fixtures/:id`
- `POST /api/replay/runs` (builder; `{ datasetIds, draft? | version?, mcpMode?, ignorePaths?, numberTolerance?, scorers?, maxCostUsd? }`; `202 { run }`; 400 for a set without golden runs or a judge secret you cannot use; 404 for a set that is missing or another workflow's; 409 over `REPLAY_JOB_MAX_CASES`)
- `POST /api/eval/runs` (builder; `{ datasetId, workflowId, scorers?, record?, replay? }`; `202 { run, runId }`; 400 for invalid scorers, a judge secret you cannot use, or a golden set of another workflow or with only golden runs; 404 for a dataset, workflow, cassette or eval run you cannot read; 409 for a cassette or eval run of another workflow; 409 over `REPLAY_JOB_MAX_CASES`. With `?wait=true` every refusal of the runner is a 400, as before)
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
| `REPLAY_CONCURRENCY` | 2 | Cases running at once across all replay jobs and eval runs of one API process |
| `REPLAY_JOB_MAX_CASES` | 200 | Most cases in one job or eval run |
| `REPLAY_JOB_DEFAULT_MAX_COST_USD` | 5 | A replay job's budget when the request names none |
| `EVAL_RUN_MAX_COST_USD` | 5 | Every eval run's budget |
| `EVAL_RESULT_MAX_BYTES` | 262144 | Largest case output or run diff stored as is (JSON bytes) |
| `EVAL_RUN_RETENTION_DAYS` | 90 | Finished eval runs and replay jobs older than this are deleted, checked every `EXECUTION_HISTORY_PRUNE_INTERVAL_MS`; the newest run of every set, and its newest finished one, are always kept. 0 keeps them forever |
| `EVAL_JUDGE_ENABLED` | false | Allows judge calls at all |
| `EVAL_JUDGE_ALLOW_ENV_CREDENTIALS` | false | Lets a judge without a `secretRef` use the server's provider keys |
| `EVAL_JUDGE_BASE_URL` | unset | Endpoint for the default judge provider |

## Not covered yet

- Candidates are the draft or a saved version only: no workflow file from git, no per-node model or guard-profile overrides, and model calls always run live (no model tape). Each case runs once (no repeats for flaky cases), and every case is compared with its recording, not with a fresh baseline rerun. There is no cost estimate before a job starts; the budget only stops it, and the model spend of the cases in flight can take it over (see [Budgets](#budgets)).
- Interrupted jobs are not resumed; start them again.
- Eval runs and replay jobs need the SQLite store; Postgres has no eval storage yet.
- Judge prompt framing reduces, but cannot rule out, a judge being steered by the output it grades.
- No release gate yet: a job's result does not block publishing.
- Golden sets cannot be exported to or imported from files.
- Deleting a set deletes the jobs that started from it (for a job over several sets, the first one).
