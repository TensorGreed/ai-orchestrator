# Golden sets, replay jobs and scorers

A **golden set** is a regression suite for one workflow: a list of [golden runs](./golden-runs.md) (and, if you like, hand-written cases). A **replay job** replays every golden run in one or more sets against a candidate (the draft, a saved version or a workflow file, with optional overrides) in the background, scores each case and reports pass, fail or inconclusive per case. Use it before you ship a prompt, model, tool or workflow change: one job tells you which real runs the change breaks.

Everything stays on your deployment. Replays use the deployment's own providers and secrets.

## Golden sets

On the **Evaluations** page, **Golden sets** lists the sets of the workflows you can read. To build one:

1. Save the runs you care about as golden runs on the **Runs** page (**Save as golden**), or turn on [production capture](./production-capture.md) and promote sampled production runs from the **Captured runs** inbox.
2. Create a golden set for the workflow.
3. Add golden runs of that workflow to the set. Each becomes a case: its recorded input is the case input, and its recorded output is what the case is compared with. A golden run can be in a set once.

A golden set is an eval dataset tied to a workflow, so the API and the older eval runs see it too: `GET /api/eval/datasets?workflowId=…` lists them, with `goldenRunCount`.

A hand-written case (an input and an expected value, without a golden run) can sit in a golden set, but replay jobs skip it: a replay can only answer the workflow's connectors, HTTP calls, MCP calls and code nodes from a recording. Run hand-written cases with an eval run.

Deleting a golden run that a set uses does not remove the case: the next job reports it as inconclusive ("the golden run for this case was deleted"), so a suite never shrinks without anyone noticing.

When an [enforced release gate](./release-gate.md#case-admission-and-required-cases) uses the set, a case you add waits for admission before the gate counts it, only an admin can remove a case the gate counts (and that removal is audited), and a case the gate requires shows a **required** chip. The chip is not shown when the gate is not enforced, since required marks are ignored then.

## Replay jobs

**Run replay** on a set opens the job dialog:

- **Candidate**: the draft (the workflow as saved now), a saved version or a workflow file, plus overrides. See [Candidates and comparison](#candidates-and-comparison). The candidate is fixed when the job starts: saving the draft while the job runs does not change what it tests. The job records the candidate's workflow hash.
- **MCP matching**: strict or lenient, as for a single replay. It also decides what happens when a model call is not on the tape (below).
- **Comparison**: live models or model calls from the tape, the recording or a baseline rerun, and repeats.
- **Ignore paths** and **number tolerance** for the output comparison.
- **Budget**: the most the job may spend on model and judge calls (default `REPLAY_JOB_DEFAULT_MAX_COST_USD`, 5 USD). See [Budgets](#budgets).
- **Scorers** (below). Without any, each case is scored with `status` (the same status as the golden run) and `json_equal` against the golden run's output, which is the single-replay verdict.

The dialog first asks the server for an **estimate** (`POST /api/replay/estimate`) and shows it: cases × runs per case, model calls, the estimated cost and any warnings. **Start** is only offered after that, and any change to the form asks for a new estimate.

`POST /api/replay/runs` answers `202` straight away; the job runs in the background. The page shows progress as cases finish (done of total, running, spent), and every case with its scorers. Click a case to see its scores and the run diff (output, tool calls, totals, replay health), the same view as a single replay.

A case's output and run diff are stored up to `EVAL_RESULT_MAX_BYTES` (default 256 KB of JSON) each. A larger one is stored as `{ truncated: true, bytes, maxBytes, preview }` (the first 2000 characters) and the case view says the diff was too large; the scorers always see the whole value. Case errors and score reasons pass through the secret scrubber before they are stored.

A case is:

| Case | When |
| --- | --- |
| pass | every scorer passed |
| fail | a scorer failed |
| inconclusive | the replay could not be trusted (an unanswered MCP call, a model call the tape cannot answer in strict mode, a golden run without a model tape under model calls from the tape, a baseline rerun that was itself inconclusive, a node the golden run never saw, a changed code node, a cut recording, and the other reasons listed for a single replay), the golden run was deleted, or the replay could not run. Scorers do not run |
| skipped | a hand-written case |

The pass rate counts passed cases out of those not skipped.

**Cancel** stops a queued or running job: no further cases start, and cases that are running are aborted. A job's status is one of `queued`, `running`, `completed`, `failed` (over budget), `canceled` or `interrupted`.

### Candidates and comparison

**Candidate.** One of:

- the draft, or a saved version;
- a **workflow file**: a workflow JSON, or an export file holding one (`{ workflow }`). It must be this workflow's (the same `id`; another workflow's file is refused with 400), it is validated like an import, it runs in the workflow's current project and folder, and it is never saved. The job records it as `candidate.kind: "inline"` with its name.

**Overrides**, applied on top of the candidate:

| Override | What it does |
| --- | --- |
| `models: [{ nodeId?, provider?, model, secretRef? }]` | Changes the model a node calls: an LLM Call node, a chat model node, or an agent or supervisor (its attached chat model). `provider` with a `nodeId` changes the provider of an LLM Call node; without a `nodeId` it changes every node of that provider. An override that matches nothing is refused (400). Switching the provider of a node that has its own secret or base URL is refused (400) unless the override names the secret to use (`secretRef: { secretId }`), so the node's key is never sent to another vendor; the new provider does not inherit the old base URL. The secret must be one you may use in the workflow's project, like any other secret reference |
| `guardProfile: { profileId, version? }` | Evaluates the run with this guard profile instead of the workflow's and project's bindings. Without a `version` the latest version is resolved **once, when the job is created**, and every case runs it; the job stores the profile id, version and hash (`candidate.guardProfile`). A project's enforced profile still runs first unless it is a version of the same profile. A version older than the one a project or workflow binding applies to the workflow now (bindings apply a profile's latest version) is refused with 400 unless you are an admin. Guard verdicts name the profile and version used |
| `mcpServers: { <server>: strict \| lenient \| live_read_only }` | MCP matching per registry server. `live_read_only` sends a tool call to the live server only when an admin marked that tool read-only in the [tool policy](./mcp-tool-policy.md); a server's own `readOnlyHint` annotation is its claim, not proof, so an unmarked or unknown tool counts as a write and is answered from the cassette. Resource reads (`resources/read`) and prompt reads (`prompts/get`) on a `live_read_only` server always go to the live server (they are reads by the MCP spec); every call that went live is counted and reported in the replay health (`mcp_live_read`) |
| `liveReadNodes: [nodeId]` | Nodes that run live instead of being answered from the recording. Only node types on the live-read allow-list may (see below); any other node, or a node that is not there, is refused with 400 naming the node. Writes never run live in a replay |

**Live-read allow-list.** A node may run live only when its type is a pure read with no side effects: Google Sheets Read, Notion Query Database, Airtable List Records, Jira Search Issues, HubSpot Get Contact, AWS S3 Get Object and List Objects, Google Calendar List Events, Google Drive Source, and HTTP Request with `method: "GET"`. Everything else is refused, including RAG Retrieve (it writes its documents into the vector store and pays for embeddings before it searches), every trigger (a polling trigger can pop a queue item or run arbitrary SQL), Web Browse and PDF Output (they launch a browser, whose pages can send any request), Connector Source (its behaviour is up to the connector), raw query nodes (SQL, SOQL), and node types this list does not know. Replay jobs may run longer than their share of the budget suggests: executions already running when the budget is crossed finish; a model with no price in the price table reserves nothing (the estimate shows `costUnknown`); and one case can occupy a worker slot for up to `repeats` x (1 + baseline) x the execution timeout. A live GET request can still carry data from upstream output to the host its URL names (the outbound guard still applies), so use live reads for data, not for checks. A job with live reads is never release proof. A non-admin may replay under another guard profile they can read; such a job is never release proof either.

The candidate's workflow hash is computed after the model overrides, so a model swap is a different candidate; `baseHash` is the hash before them. Guard, MCP and live-read overrides change how the job replays, not the workflow, and are listed on the job page next to the candidate.

**Model calls.** `models: "live"` (default) calls the models. `models: "replay"` answers every model call from the golden run's model tape, so a job that changes only the guard profile, or the output handling after a model, makes no model calls at all. A call that is not on the tape (a prompt changed, an earlier tool answer changed, a model override) follows the job's MCP matching: strict makes the case inconclusive and names the call; lenient reuses the last answer of a repeated call and sends a call the tape never saw to the live model, with a warning in the replay health. A golden run without a tape is inconclusive under `models: "replay"`.

**Compare with.** `compare: "recording"` (default) compares each case with its golden run. `compare: "baseline_rerun"` first replays the golden run's own workflow (the saved version it ran, else the workflow captured with it) under the same settings, then the candidate, and compares the two runs: drift since the golden run was recorded (a model that answers differently today, data read live) shows up in both and is not blamed on the candidate. The baseline gets the same MCP and live-read overrides and the same model mode, but not the candidate's guard profile or model overrides. A baseline rerun that is itself inconclusive makes that repeat inconclusive.

**Repeats.** `repeats` (1–5, default 1) runs each case that many times (each with its own baseline rerun when comparing with one), and `aggregate` decides the case: `all` (default; every repeat passes), `majority` or `any`. An inconclusive repeat counts against `all` and `majority`. A case that ran fewer repeats than asked for (the budget stopped it, or the job was canceled) is **inconclusive**, whatever the repeats it did run said. A case whose repeats disagree is marked **flaky**. A case stays one result: its status is the aggregate, its diff is the first repeat with that status, and the case view lists every repeat with its execution and baseline execution. The case's tokens and duration are those of that deciding repeat; its cost is every repeat's. The summary counts flaky cases (`flaky`) and executions (`executions`).

**Baseline without a saved version.** A baseline rerun replays the saved version the golden run ran. When that version was pruned, or the golden run was of an unsaved draft, the workflow captured with the golden run is rerun instead, as long as nothing was scrubbed out of it. When it holds a `[REDACTED]` marker (an inline credential was removed when it was saved), it cannot be rerun faithfully: the case is inconclusive, the reason says to re-record this golden run, and the estimate warns about it. Credentials kept as secret references do not count as scrubbed.

Starting a job with a workflow file or any override needs edit access to the workflow (`workflow:write`), not just run access: it is a change to the workflow, even if it is never saved. The access is checked again before every case: a user who loses edit access while the job runs gets the remaining cases inconclusive. A workflow file is at most 2 MiB (`REPLAY_INLINE_WORKFLOW_MAX_BYTES`); a larger one is refused with 400.

**Model calls from the tape cost nothing.** A call answered from a model tape counts $0 toward the budget, the job's spend and its summary cost, and is not recorded as a usage event. What those calls cost when they were recorded is shown apart: `summary.replayedModelCalls` and `summary.recordedCostUsd` on the job, and `modelTape: { replayedCalls, liveCalls, recordedUsage }` on each case's replay. A lenient call that went to the live model is priced and counted as usual.

### Release proof

When a job is created the server records whether it can count as proof for publishing its `workflowHash`: `candidate.releaseEligible` (boolean) and `candidate.releaseIneligibleReasons` (strings; empty when eligible). A job is eligible only when the candidate is the draft or a saved version (not a workflow file), it has no overrides of any kind (models, guard profile, MCP server modes, live reads), `models` is `live` and `mcpMode` is `strict`. `releaseEligible` does not cover the comparison settings: the release gate checks those against its own options. A release gate requires `releaseEligible === true` in addition to its own checks and never works it out from the options; jobs made before this field have none and are judged by the gate's own checks. The job page shows the result and the reasons.

### Estimate

`POST /api/replay/estimate` takes the same body as `POST /api/replay/runs`, checks it the same way (and with the same access rules), runs nothing, and answers:

```json
{ "cases": 12, "runsPerCase": 6, "modelCallsEstimate": 72, "estimatedCostUsd": 0.41, "costUnknown": false, "warnings": [], "executions": 72, "maxExecutions": 500 }
```

- `runsPerCase` is repeats × 2 with a baseline rerun. `executions` is cases × `runsPerCase`; a job over `maxExecutions` (`REPLAY_JOB_MAX_EXECUTIONS`, default 500) is refused with 400 when started, and the estimate warns about it.
- `modelCallsEstimate` counts the golden runs' recorded model calls for every run; calls a tape will answer count as none.
- `estimatedCostUsd` prices the golden runs' recorded tokens at the candidate's models (and the recorded models for baselines) with the deployment's price table, plus the most the judges can cost. `costUnknown` is true when a model has no price; the estimate then leaves it out.
- `warnings` says, for example, that some golden runs have no tape, that model overrides cannot be answered from a tape, that golden runs are over 30 days old and a baseline rerun would be fairer, that a baseline would have to rerun a captured workflow with credentials scrubbed out, that the job is over `REPLAY_JOB_MAX_EXECUTIONS`, or that the estimate is over the job's budget.

### Running in the background

Replay jobs and eval runs share one runner. `REPLAY_CONCURRENCY` (default 2) caps how many cases run at once in one API process, whatever the number of jobs; jobs take turns in the order their cases were queued. With several API processes, each has its own cap. `REPLAY_JOB_MAX_CASES` (default 200) caps the cases in one job.

A job runs in the API process that accepted it. If that process stops, the job does not resume: when the API starts again, jobs it left queued or running are marked **interrupted**. When the database is shared (`HA_ENABLED`, or Postgres), an instance only marks jobs no instance has written progress for in five minutes, so a job another live instance is running is left alone, and every instance checks again every five minutes, so a job whose instance died is noticed without waiting for a restart. Webhook-only replicas (`WORKER_MODE=webhook`) never mark other instances' jobs. A late progress write never brings a finished job back to `running`. Start an interrupted job again to rerun it.

Eval runs and replay jobs are stored in SQLite only: on Postgres the API boots and logs that eval storage is not available, and the eval routes do not work.

### Budgets

Every replay job and eval run has a budget: a replay job's `maxCostUsd` (default `REPLAY_JOB_DEFAULT_MAX_COST_USD`), and `EVAL_RUN_MAX_COST_USD` (default 5 USD) for every eval run. Spend is the model calls of the replayed or live runs, every repeat and baseline rerun included, plus the judge calls.

- Before a case starts, the most its judge calls could cost (each call priced at the longest judge prompt plus `EVAL_JUDGE_MAX_TOKENS` of reply) is reserved against the budget. A case whose reservation does not fit waits for running cases to finish; when it still does not fit, no further cases start and the run ends as **failed** with the reason. Judge calls can therefore never take a run over its budget.
- Before each execution of a replay job (each repeat and each baseline rerun), its estimated model cost (the golden run's recorded tokens at the models it will call; $0 for calls a tape answers) is reserved against what is left of the budget, next to the judge reservations and the other executions in flight. An execution that does not fit is skipped (`budget_exhausted` in the case's error and the job's), the case is inconclusive, and the job ends **failed**. After the execution its reservation is settled to what it really cost. The judges of every repeat are reserved before the case starts.
- So a job goes over its budget only by how much the executions in flight cost more than their recorded tokens (a candidate with longer prompts or answers, more agent iterations, or a model with no price). A job also runs at most `REPLAY_JOB_MAX_EXECUTIONS` executions (default 500).
- A model or judge call whose model has no price in the price table is not counted as $0: the run's spend is marked as a lower bound (shown with a `+`), and the run carries a warning that the budget cannot stop on those calls.
- One case makes at most 50 judge calls across all of its scorers; the next call fails the scorer with "judge call limit reached".
- Every judge call is recorded as a usage event (`triggerType: eval_judge`) of the workflow's project, so it shows on the usage pages and counts toward project budgets.

## Scorers

Every scorer returns pass or fail, a score from 0 to 1 and a reason you can read. Scorers on a case take precedence over the job's scorers.

| Scorer | Checks | Options |
| --- | --- | --- |
| `status` | The run finished with the expected status | `expect` (default `success`; a replay job's default scorer expects the golden run's status, so a golden run that errored and a candidate that now succeeds fails it, where a single replay would call that an improvement) |
| `json_equal` | The output (at `path`) equals the expected value or the golden run's output | `against: expected \| baseline`, `ignorePaths` (globs, as for replay), `numberTolerance`, `ignoreArrayOrder`. Timing and id fields are always ignored; guard-masked text compares as for replay ([Guard-masked text](./golden-runs.md#guard-masked-text)) |
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
- `POST /api/replay/runs` (builder; `{ datasetIds, draft? | version? | workflow?, overrides?, models?, compare?, repeats?, aggregate?, mcpMode?, ignorePaths?, numberTolerance?, scorers?, maxCostUsd? }`; `202 { run }`; 400 for a set without golden runs, a judge or model override secret you cannot use, a workflow file of another workflow, over 2 MiB or that fails validation, an override that matches nothing, a provider switch without a `secretRef`, a guard profile or version that does not exist (or older than a binding applies, for a non-admin), a node in `liveReadNodes` that is not on the allow-list, or more than `REPLAY_JOB_MAX_EXECUTIONS` executions; 403 for a workflow file or overrides without edit access; 404 for a set that is missing or another workflow's; 409 over `REPLAY_JOB_MAX_CASES`; 501 on Postgres). The run's `candidate` carries `releaseEligible`, `releaseIneligibleReasons` and, with a guard override, `guardProfile: { profileId, version, hash }`
- `POST /api/replay/estimate` (builder; the same body and checks; `{ cases, runsPerCase, modelCallsEstimate, estimatedCostUsd, costUnknown, warnings, executions, maxExecutions }`; nothing runs; 501 on Postgres)
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
| `REPLAY_JOB_MAX_EXECUTIONS` | 500 | Most executions one replay job may run (cases × repeats, × 2 with a baseline rerun) |
| `EVAL_RUN_MAX_COST_USD` | 5 | Every eval run's budget |
| `EVAL_RESULT_MAX_BYTES` | 262144 | Largest case output or run diff stored as is (JSON bytes) |
| `EVAL_RUN_RETENTION_DAYS` | 90 | Finished eval runs and replay jobs older than this are deleted, checked every `EXECUTION_HISTORY_PRUNE_INTERVAL_MS`; the newest run of every set, and its newest finished one, are always kept. 0 keeps them forever |
| `EVAL_JUDGE_ENABLED` | false | Allows judge calls at all |
| `EVAL_JUDGE_ALLOW_ENV_CREDENTIALS` | false | Lets a judge without a `secretRef` use the server's provider keys |
| `EVAL_JUDGE_BASE_URL` | unset | Endpoint for the default judge provider |

## Not covered yet

- A workflow file is uploaded in the dialog or sent in the request; the job does not read it from git.
- The estimate prices the golden runs' recorded tokens: a candidate whose prompts are much longer or shorter costs more or less than estimated. The budget reserves that estimate before each execution, so only the difference of the executions in flight can take a job over it (see [Budgets](#budgets)).
- Golden runs recorded before this release have no model tape; record new ones to replay model calls.
- Interrupted jobs are not resumed; start them again.
- Eval runs and replay jobs need the SQLite store; Postgres has no eval storage yet.
- Judge prompt framing reduces, but cannot rule out, a judge being steered by the output it grades.
- No release gate yet: a job's result does not block publishing.
- Golden sets cannot be exported to or imported from files.
- Deleting a set deletes the jobs that started from it (for a job over several sets, the first one).
