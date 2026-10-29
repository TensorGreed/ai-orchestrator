---
description: "Test an L2M workflow file from git against golden sets in CI with the l2m CLI, fail the build on regressions, upload JUnit results and publish through the release gate."
---

# Replay in CI and the release gate

This page shows how a pipeline tests a workflow file from git against the golden sets on your deployment, fails the build on a regression, uploads a JUnit report and, when the workflow has a release gate, publishes the version that passed. It also describes the golden-set file you can keep in git or move between deployments.

Everything runs against your own deployment's API. Nothing here calls an outside service.

::: info What the server must have
`replay run --set` with overrides, `--file`, `--models`, `--compare`, `--repeats`, `--aggregate` and `--estimate` needs a server with replay candidates, and `l2m release publish` needs a server with release gates. A server without them answers 400 for a request field it does not know (the CLI exits 2 and names the field) or has no publish route (exit 1).
:::

## Set up the CLI

The `l2m` command lives in `packages/cli`; from a checkout run it with `pnpm l2m …`, or install the workspace in your pipeline image. It reads the deployment from two environment variables:

```bash
export L2M_API_URL=https://l2m.example.com
export L2M_API_KEY=…      # a builder API key; keep it in the CI secret store
```

Pass the key through `L2M_API_KEY` only. `--api-key` still works, but a key on the command line shows in the process list and in CI logs, so the CLI prints a warning on stderr when it is used. The CLI never prints the key.

The key needs run access (`workflow:execute`) to the workflow whose golden sets you replay, and read access to the sets.

Each command accepts only its own flags: a typo such as `--override-reson`, or a flag of another command, is a usage error (exit 2) and nothing is sent. Switches never take a value: `--sign=false` is refused rather than read as `--sign`.

Every request gives up after 60 seconds (`golden export` and `golden import`, and `mcp check` against the API: 300 seconds; `replay run --recording`, which waits for the whole replay: 900 seconds), and a replay job's requests also stop at what is left of `--timeout`. Status polls of a replay job are tried again twice, after 1 and 3 seconds, when the server cannot be reached, does not answer in time or answers 5xx.

## Recipe: test a workflow file against the golden sets

Keep the workflow's JSON (the export of the workflow, or the workflow itself) in git. On every pull request, replay the golden sets with that file as the candidate. Nothing is saved on the server: the file is a candidate for this one job. The file must be for the same workflow id as the golden sets and at most 2 MiB; the key needs edit access (`workflow:write`) to the workflow, because an uploaded candidate is a change to it.

A job on a workflow file, or with any override, shows whether it can count as release proof. The report ends with `not release proof: a release gate will not accept this job` and the reasons the server gives, or `release eligible` when it can; `--json` and the JUnit file carry the same (`releaseEligible`, `releaseIneligibleReasons`). A release gate publishes only what a job on a saved version proved, so to publish, save the version and replay `--version <n>` (see the publish recipe).

```bash
#!/usr/bin/env sh
set -u

l2m replay run \
  --set "$GOLDEN_SET_ID" \
  --file workflows/support-bot.json \
  --max-cost 2 \
  --timeout 1200 \
  --junit reports/l2m-replay.xml
status=$?

# 0 pass, 1 regression, 2 usage error, 4 inconclusive or a failed request.
exit $status
```

The step waits for the job (polling every two seconds), prints the failing cases and their failing scorers, writes the JUnit file even when the job fails or times out, and exits with the job's verdict:

| Exit code | Meaning | What your pipeline should do |
| --- | --- | --- |
| 0 | Every case passed | Continue |
| 1 | At least one case failed: a regression | Fail the build |
| 1 | Also: a status poll of the job was refused with HTTP 400 | Fail the build |
| 2 | Usage error, including unknown flags, or flags or a workflow file the API rejects (HTTP 400) when the job is started | Fail the build; fix the step |
| 4 | Inconclusive: a case could not be judged, no case passed, the job did not complete (canceled, over budget, interrupted), it outlived `--timeout`; or a request failed: the API could not be reached or did not answer in time (after the retries for polls), or answered 401, 403, 404 or 5xx | Fail the build; a replay that proves nothing is not a pass |

When the job ran over a golden set of an [enforced release gate](./release-gate.md#case-admission-and-required-cases), the report also says how the gate counts its cases, with the same numbers the gate judges with: `enforced release gate: 20 admitted, 40 pending admission (they run but do not count yet), 2 required`, then one line for each required case that would block a publish. Failing cases are marked `(required)` or `(pending admission, not counted)`.

For such a job the server also judges its case results as the gate does, under the gate's policy and admission when you look at the job (pass rate, minimum cases, regressions, required cases, required scorers and limits), and the exit code of a completed job follows that verdict: `1` when the gate blocks (with `the release gate blocks these results:` and the reasons). When it does not, cases outside the gate's golden sets (a job may cover more sets) decide as they would without a gate: `1` if one of them failed, `4` if one was inconclusive, otherwise `0`. So a failing case still pending admission does not fail the step, and a required case that is inconclusive or did not run does. Whether the job may prove a release (its version, eligibility, overrides and set snapshot) is not part of this verdict: the report says it on its own line, and `l2m release publish` makes the final call. When the gate's golden sets changed after the job was queued, the report adds that publishing may still refuse the job.

`replay run --set` and `replay status` exit 4, not 1, when a request fails. That is how these commands have always behaved, and it is kept so a pipeline that already reads the codes keeps its meaning. `release publish` and the `golden` commands exit 1 for a failed request.

A pipeline that only distinguishes pass from fail treats every non-zero exit as a failed build, which is the safe default.

### Upload the JUnit report

`--junit <file>` writes one test suite per job and one test case per golden case: a regression is a `failure`, an inconclusive case an `error`, a case that did not run a `skipped`. When the job ran over a golden set of an enforced release gate, a required case that would block a publish is a `failure` of type `required_case`, a case pending admission says it is not counted by the gate, and the suite's properties carry `gateAdmittedCases`, `gatePendingCases`, `gateRequiredCases`, `gateRequiredFailing` and `gateVerdict`. A required case the job has no result for at all appears as its own failing test case. If the job produced no case results (it timed out, the request failed, the API was unreachable) the file holds one erroring `replay job` case, so a report view always shows a red result. Point your CI system's test-report upload at the file, in a step that runs whatever the exit code of the replay step. The file is written with mode 0600 (case names and failure reasons can quote production data), and the CLI refuses to write it through a symbolic link. Every CI system that reads JUnit XML takes the file as is. Each case's class name is `l2m.replay.<workflowId>` and its name is the golden case's name.

### Try a change before you commit to it

Overrides replay the same golden runs with something changed, without editing the workflow file:

```bash
l2m replay run --set "$GOLDEN_SET_ID" --file workflows/support-bot.json \
  --model agent=gpt-4.1-mini \
  --guard-profile strict@3 \
  --models replay \
  --compare baseline_rerun \
  --repeats 3 --aggregate majority
```

| Flag | Effect |
| --- | --- |
| `--model <nodeId>=<model>` | Use another model for one node (repeatable) |
| `--provider-model <provider>=<model>` | Use another model for every node of a provider (repeatable) |
| `--model-secret <nodeId or provider>=<secretId>` | The secret a model override uses (repeatable); the server requires one when an override changes the provider of a node that has a secret. You need permission to use it in the workflow's project |
| `--guard-profile <id>[@<version>]` | Run with a guard profile, optionally a specific version |
| `--mcp-server <id>=strict\|lenient\|live_read_only` | How one MCP server is answered (repeatable) |
| `--live-read <nodeId>` | Let a read-class node call its system live (repeatable) |
| `--models live\|replay` | Call models live (default) or serve them from the recording's model tape |
| `--compare recording\|baseline_rerun` | Compare with the golden run (default) or with a fresh rerun of the baseline |
| `--repeats <1-5>`, `--aggregate all\|majority\|any` | Run each case several times and combine the results |

Live write calls are never allowed in a replay job; the server refuses an override that would allow one (HTTP 400, exit 2).

### Look before you spend

`--estimate` asks the server for the size of the job and does not start it:

```bash
l2m replay run --set "$GOLDEN_SET_ID" --file workflows/support-bot.json --repeats 3 --estimate
# Estimate: 12 cases, 3 runs each, about 48 model calls, about $0.8400
#   36 executions (a job may run at most 2000)
```

Use it to fail fast when a job would exceed what the pipeline may spend. `--max-cost` still stops the job itself at its budget.

### Start now, check later

Long suites do not need a pipeline slot held open:

```bash
l2m replay run --set "$GOLDEN_SET_ID" --no-wait      # prints the job id, exits 0
l2m replay status run_… --wait --timeout 1800 --junit reports/l2m-replay.xml
```

`l2m replay status <runId>` prints the job and exits with the same codes as `replay run` (a request failure is exit 4 here too). Without `--wait` a job that is still running exits 4 (no verdict yet). With `--wait` it polls until the job ends or `--timeout` passes.

## Recipe: publish the version that passed

When the workflow has a release gate, publish from the pipeline after a replay of the saved version passed. The gate binds to the exact hash of a saved version and to a passing job on it, so replay the version rather than a file:

```bash
l2m replay run --set "$GOLDEN_SET_ID" --version 12 --json > job.json || exit $?
l2m release publish "$WORKFLOW_ID" --version 12 --run "$(jq -r .id job.json)"
```

A job on a workflow file or with overrides, models served from the tape or lenient MCP is never accepted by a release gate; the job's `releaseEligible` says so. The gate also checks the job's comparison settings (ignored paths, scorers, repeats and the rest) against its own candidate options. A job with repeats records cost, latency and new guard blocks for every repeat, and the gate judges guard blocks at the repeat that added the most, and cost and p95 latency at the worst of each case's deciding repeat, each repeat of the suite, and each case's largest increase over its own baseline (absolute and relative), so it is never more lenient than the deciding repeats alone.

Outputs are compared as described in [Reading the result](./golden-runs.md#reading-the-result): whitespace and timing and id fields aside, a changed string is a change. Guard-masked text is compared as a mask only when masking is expected (a masked production capture, or a run whose guard masked, redacted or protected content), and only in the exact shapes the guard writes; see [Guard-masked text](./golden-runs.md#guard-masked-text). A workflow without a guard, replayed against hand-saved golden runs, is compared exactly as before.

| Server answer | Exit code | Output |
| --- | --- | --- |
| 200, published | 0 | The version and the gate's verdict |
| 202, the policy needs approval | 4 | The approval request id and the reasons; the request is decided in the approvals inbox and nothing is published yet |
| 409, blocked by the gate | 1 | The reasons, the job that was judged, and a hint to use `--request-approval` when the gate allows it |
| Anything else (403, 404, unreachable) | 1 | The API's error |

`--hash <workflowHash>` pins the exact candidate hash the replay passed on (64 hex characters, the job's `candidate.workflowHash`); `--run <replayRunId>` names the job to use. A blocked publish can be sent to the gate's approvers with `--request-approval "<reason>"`, and an admin can override the gate with `--override-reason "<reason>"` (the two cannot be combined). Both reasons are kept in the audit log.

## Golden-set files

A golden set can be exported as one JSON file, so it can live in git next to the workflow, move to another deployment, or be reviewed in a pull request.

```bash
# Export (the key needs read access to the set). --sign adds a signature (admin keys only).
l2m golden export ds_… -o golden/support-bot.json --sign

# Import into the workflow it was exported from (the key needs edit access to it). A new golden set is created.
l2m golden import golden/support-bot.json --workflow wf_… --name "Support bot (from git)"

# A file exported from another workflow (a fork, a copy on another deployment) needs the explicit flag.
l2m golden import golden/support-bot.json --workflow wf_fork --allow-other-workflow

# Check a signed file offline, against the deployment's public key.
l2m golden verify golden/support-bot.json --public-key deployment-public-key.pem
```

`golden export` and `golden import` exit 0 on success, 1 when the request fails (including a 409 for another workflow's file without `--allow-other-workflow`, and a file that fails `--public-key`), and 2 for usage errors and a file or flags the API rejects with 400.

The API routes behind the commands:

- `GET /api/eval/datasets/:id/export[?sign=true]` (viewer with read access to the set's workflow; 404 when the set is not readable, 400 for a dataset that is not a golden set, 409 when the set holds a golden run of another workflow). `?sign=true` needs an admin: the signing key is the deployment's audit key, which only admins manage; anyone else gets 403 and can export unsigned. Cases without a golden run (hand-written cases, or a deleted golden run) are left out and counted in the `x-l2m-skipped-cases` header. The file is written by `l2m golden export -o` with mode 0600, never through a symbolic link.
- `POST /api/eval/datasets/import` (builder with edit access to the target workflow; body `{ file, workflowId, projectId?, name?, allowWorkflowMismatch? }`; `201 { dataset, imported, skipped, warnings }`). The caller is authenticated before the body is read, so an anonymous upload is refused (401) without being parsed. 400 for a file that does not match the format, is nested deeper than 64 levels, carries a workflow hash that does not match its workflow, or has a broken MCP cassette; 413 for a file or case over the size limits; 403 when you can read the workflow but not edit it; 404 when you cannot read it; 409 for a file exported from another workflow without `allowWorkflowMismatch`, and when the workflow's golden-run limits would be exceeded.

`GOLDEN_SET_IMPORT_MAX_BYTES` (default 33554432, 32 MiB) sets the largest file the import accepts and the import route's request body limit.

### What the file holds

`format` is `l2m.golden-set` and `version` is `1`.

| Field | Content |
| --- | --- |
| `workflow` | `id` and `name` of the workflow the set was made for |
| `name`, `description` | The golden set's |
| `exportedAt`, `exportedBy` | When and by whom |
| `cases[]` | `name`, optional `scorers`, and the `recording` |
| `cases[].recording` | `name`, `notes`, `sourceStatus`, `sourceTriggerType`, `recordedAt` (when the run was recorded), `origin` (`recorded`, or `imported` for a golden run that itself came from a file) and `sourceWorkflowId` for imported ones, `workflowHash` (sha256 of the canonical JSON of `workflow` exactly as the file carries it), `workflowSavedVersion`, `workflow` (the workflow as it ran, scrubbed), `input`, `nodes` (every node's recorded result), `facts` (the run's normalised facts), `cassette` (the MCP cassette or `null`), `truncated`, `scrubbed`, and `modelTape` / `memorySeed` when the golden run has them |
| `signature` | Optional: `algorithm` (`Ed25519`), `keyId`, `publicKey`, `signedAt`, `signature` |

Scorers belong to a case. A judge scorer's credential reference is not part of the file.

### What a file never carries

The exporter and the importer both treat the file as untrusted, and run the same scrub a golden run gets when it is recorded:

- **One deep scrub over the whole file.** Before anything else uses it, every string anywhere in the file (golden-set, case, recording and workflow names, notes and descriptions, `sourceTriggerType`, scorer values, and the strings under `data` and `blob` keys) loses token shapes and every secret value the deployment holds, and an object key that is token-shaped or a secret value is replaced by a stable `[REDACTED_KEY_<n>]`. It runs on export too, and the import response only echoes scrubbed values. It runs in chunks that yield to other requests.
- **No secret values or credentials.** Every field of every case (the input, every node's output and error, the run facts, the MCP cassette, the workflow, and anything else the case carries) goes through the recording-time scrub: values under credential key names (`authorization`, `apiKey`, `token`, `password` and the like) are replaced, token shapes (`Bearer …`, `ghp_…`, `sk-…`, JWTs and others) are replaced, and so is every secret value the deployment holds. The exporter does it on the way out, again, with the secrets the deployment holds at export time; the importer does it with the importing deployment's secrets, so a hand-edited file cannot plant a credential that is stored. Identifiers a replay matches on (node ids and types, edge ends, the cassette's server keys and methods) only lose secret values.
- **No secret references.** `secretRef`, `secretId`, `…SecretRef` / `…SecretId` (such as `authSecretId`) and `credentialId` / `credentialRef` keys are removed from every field, not only the workflow. A judge scorer imported from a file has no `secretRef`; the import says so in `warnings`, and a user attaches a credential before the judge can run.
- **No forged hash.** The importer recomputes each case's workflow hash from the workflow it carries and refuses a file whose claimed hash does not match. The golden run stores the hash of the workflow as stored after the import scrub.
- **Nothing partial.** The importer checks the nesting depth (at most 64 levels), the schema, each MCP cassette, the number of cases (at most `REPLAY_JOB_MAX_CASES`, 200 by default, and never more than 500), the size of each case (at most `REPLAY_RECORDING_MAX_BYTES`) and of the file (`GOLDEN_SET_IMPORT_MAX_BYTES`); an export that would be over `GOLDEN_SET_IMPORT_MAX_BYTES` is refused with 413 (split the golden set), so it never builds a file the import would refuse. Each case's `recordedAt` must be a valid ISO timestamp not before 2000-01-01 (otherwise 400 naming the case), and the workflow's golden-run storage limits. The checks and the scrub run case by case, letting other requests through between cases; then one transaction creates the golden set and every golden run. If anything fails, nothing is created.
- **The model tape and memory seed are checked and scrubbed like the rest.** They must match the model tape and memory seed formats (otherwise 400), planted secret values in them are replaced, and the tape's request hashes are kept so a replay can still find its entries. A golden run imported with a tape can be replayed with `--models replay`. When the target workflow has no node with the same id as a tape entry, that entry is dropped, the tape is marked truncated and the import says so in `warnings`.

A file exported from another workflow is refused (409) unless the request sets `allowWorkflowMismatch` (`--allow-other-workflow`). Then recorded outputs are kept only for nodes whose id and type both match a node of the target; the others are dropped and named in `warnings`, and a replay stubs those nodes without a recording.

### Imported golden runs

A golden run created from a file is marked `origin: "imported"` (in `capabilities` of the golden-run API views, and as an "imported" badge in the golden-run viewer and the golden-set page), with the source workflow id and the import time. Its `createdAt` is the `recordedAt` the file claims, never later than the import, so a rule that looks at the age of golden runs, such as the release gate's use of `baseline_rerun` for golden runs older than 30 days, treats an old file as old. Exporting an imported golden run again keeps `origin: "imported"`.

An imported golden run carries no secret references and a replay never reports a credential change for it (a known behaviour of imported recordings). When a replay compares the candidate's node configurations with it, secret references are left out on both sides. For a golden run recorded on the deployment they are compared: a candidate that points a write node at another credential is reported as a changed configuration.

### Signatures

`--sign` signs the file with the deployment's audit signing key (the same Ed25519 key that signs run manifests and audit bundles); only admins can ask for it. The signature covers the canonical JSON of `{ purpose: "l2m.golden-set/1", file, keyId, signedAt }`, where `file` is the file without its `signature` block, so any edit to a case, a name or a score breaks it, and the purpose tag keeps a golden-set signature from ever being valid for another signed format.

A signature proves that the deployment held this data when it signed it, not where the data was first recorded. An imported golden run keeps `origin: "imported"`, and that field is inside the signed bytes, so re-signing a file on another deployment cannot hide that its cases came from a file.

`l2m golden verify` checks the signature offline:

| Exit code | Meaning |
| --- | --- |
| 0 | The signature is valid and `--public-key` (the key you got from the deployment through a trusted channel) matches |
| 1 | The file is unsigned, was changed after signing, or was signed with another key |
| 3 | The signature is consistent with the key inside the file, but no `--public-key` was given, so it does not prove who signed it (`--trust-embedded-key` accepts that explicitly) |

`l2m golden import --public-key …` verifies the file the same way before sending it and refuses one that does not pass. The server also checks a signature on import: a file signed by a key it does not know, or changed after signing, imports with a warning (everything is scrubbed and validated regardless).

## Audit events

Exports and imports are written to the audit log as `replay.golden_set.exported` (case count, how many cases were imported ones, skipped cases, whether it was signed and with which key) and `replay.golden_set.imported` (source and target workflow, whether they differ, case count, `signature`: `verified`, `unverified` or `absent`, the key id, how many recorded nodes were dropped).
