# Replay in CI and the release gate

This page shows how a pipeline tests a workflow file from git against the golden sets on your deployment, fails the build on a regression, uploads a JUnit report and, when your deployment has a release gate, publishes the version that passed. It also describes the golden-set file you can keep in git or move between deployments.

Everything runs against your own deployment's API. Nothing here calls an outside service.

::: info Server versions
`replay run --set`, `replay status`, the JUnit report and golden-set files work with any server that has [golden sets and replay jobs](./golden-sets.md). Three parts need newer servers:

- **Overrides, `--file`, `--models`, `--compare`, `--repeats`, `--aggregate` and `--estimate`** need the replay-candidates release (Phase 15.3). An older server answers 400 for a request field it does not know and the CLI exits 2 and names the field.
- **`l2m release publish`** needs the release-gate release (Phase 15.4). On an older server the publish route does not exist and the command exits 1.
:::

## Set up the CLI

The `l2m` command lives in `packages/cli`; from a checkout run it with `pnpm l2m …`, or install the workspace in your pipeline image. It reads the deployment from two environment variables (or `--api-url` and `--api-key`):

```bash
export L2M_API_URL=https://l2m.example.com
export L2M_API_KEY=…      # a builder API key; keep it in the CI secret store
```

The key needs run access (`workflow:execute`) to the workflow whose golden sets you replay, and read access to the sets.

## Recipe: test a workflow file against the golden sets

Keep the workflow's JSON (the export of the workflow) in git. On every pull request, replay the golden sets with that file as the candidate. Nothing is saved on the server: the file is a candidate for this one job.

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

# 0 pass, 1 regression, 2 usage error, 4 inconclusive.
exit $status
```

The step waits for the job (polling every two seconds), prints the failing cases and their failing scorers, writes the JUnit file even when the job fails or times out, and exits with the job's verdict:

| Exit code | Meaning | What your pipeline should do |
| --- | --- | --- |
| 0 | Every case passed | Continue |
| 1 | At least one case failed: a regression | Fail the build |
| 2 | Usage error, including flags or a workflow file the API rejects (HTTP 400) | Fail the build; fix the step |
| 4 | Inconclusive: a case could not be judged, no case passed, the job did not complete (canceled, over budget, interrupted), it outlived `--timeout`, or the API could not be reached | Fail the build; a replay that proves nothing is not a pass |

A pipeline that only distinguishes pass from fail treats every non-zero exit as a failed build, which is the safe default.

### Upload the JUnit report

`--junit <file>` writes one test suite per job and one test case per golden case: a regression is a `failure`, an inconclusive case an `error`, a case that did not run a `skipped`. If the job produced no case results (it timed out, the request failed, the API was unreachable) the file holds one erroring `replay job` case, so a report view always shows a red result. Point your CI system's test-report upload at the file, in a step that runs whatever the exit code of the replay step. Every CI system that reads JUnit XML takes the file as is. Each case's class name is `l2m.replay.<workflowId>` and its name is the golden case's name.

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
```

Use it to fail fast when a job would exceed what the pipeline may spend. `--max-cost` still stops the job itself at its budget.

### Start now, check later

Long suites do not need a pipeline slot held open:

```bash
l2m replay run --set "$GOLDEN_SET_ID" --no-wait      # prints the job id, exits 0
l2m replay status run_… --wait --timeout 1800 --junit reports/l2m-replay.xml
```

`l2m replay status <runId>` prints the job and exits with the same codes as `replay run`. Without `--wait` a job that is still running exits 4 (no verdict yet). With `--wait` it polls until the job ends or `--timeout` passes.

## Recipe: publish the version that passed

When the workflow has a release gate (see the server note above), publish from the pipeline after the replay passed:

```bash
l2m release publish "$WORKFLOW_ID" --version 12 --run "$REPLAY_RUN_ID"
```

| Server answer | Exit code | Output |
| --- | --- | --- |
| 200, published | 0 | The version and the gate's verdict |
| 202, the policy needs approval | 4 | The approval request id; the request is decided in the approvals inbox and nothing is published yet |
| 409, blocked by the gate | 1 | The reasons |
| Anything else (403, 404, unreachable) | 1 | The API's error |

`--hash <workflowHash>` pins the exact candidate hash the replay passed on; `--run <replayRunId>` names the job to use. A blocked publish can be sent to the gate's approvers with `--request-approval "<reason>"`, and an admin can override the gate with `--override-reason "<reason>"` (the two cannot be combined). Both reasons are kept in the audit log.

## Golden-set files

A golden set can be exported as one JSON file, so it can live in git next to the workflow, move to another deployment, or be reviewed in a pull request.

```bash
# Export (the key needs read access to the set). --sign adds a signature.
l2m golden export ds_… -o golden/support-bot.json --sign

# Import into a workflow (the key needs edit access to it). A new golden set is created.
l2m golden import golden/support-bot.json --workflow wf_… --name "Support bot (from git)"

# Check a signed file offline, against the deployment's public key.
l2m golden verify golden/support-bot.json --public-key deployment-public-key.pem
```

The API routes behind the commands:

- `GET /api/eval/datasets/:id/export[?sign=true]` (viewer with read access to the set's workflow; 404 when the set is not readable, 400 for a dataset that is not a golden set). Cases without a golden run (hand-written cases, or a deleted golden run) are left out and counted in the `x-l2m-skipped-cases` header.
- `POST /api/eval/datasets/import` (builder with edit access to the target workflow; body `{ file, workflowId, projectId?, name? }`; `201 { dataset, imported, skipped, warnings }`). 400 for a file that does not match the format or has a broken MCP cassette, 413 for a file or case over the size limits, 403 when you can read the workflow but not edit it, 404 when you cannot read it, 409 when the workflow's golden-run limits would be exceeded. Both routes answer 501 on the Postgres store.

### What the file holds

`format` is `l2m.golden-set` and `version` is `1`.

| Field | Content |
| --- | --- |
| `workflow` | `id` and `name` of the workflow the set was made for |
| `name`, `description` | The golden set's |
| `exportedAt`, `exportedBy` | When and by whom |
| `cases[]` | `name`, optional `scorers`, and the `recording` |
| `cases[].recording` | `name`, `notes`, `sourceStatus`, `sourceTriggerType`, `workflowHash`, `workflowSavedVersion`, `workflow` (the workflow as it ran), `input`, `nodes` (every node's recorded result), `facts` (the run's normalised facts), `cassette` (the MCP cassette or `null`), `truncated`, `scrubbed`, and `modelTape` / `memorySeed` when the exporting deployment has them |
| `signature` | Optional: `algorithm` (`Ed25519`), `keyId`, `publicKey`, `signedAt`, `signature` |

Scorers belong to a case. A judge scorer's credential reference is not part of the file.

### What a file never carries

The exporter and the importer both treat the file as untrusted:

- **No secret values.** The exporter scrubs every value with the secrets the deployment holds now. The importer scrubs the whole file again with the importing deployment's secrets, so a hand-edited file cannot plant a secret value that is stored.
- **No secret references.** `secretRef`, `secretId` and `…SecretRef` / `…SecretId` keys are removed from the workflow inside each recording. A judge scorer imported from a file has no `secretRef`; the import says so in `warnings`, and a user attaches a credential before the judge can run.
- **Nothing partial.** The importer checks the schema, each MCP cassette, the number of cases (at most `REPLAY_JOB_MAX_CASES`, 200 by default, and never more than 500), the size of each case (at most `REPLAY_RECORDING_MAX_BYTES`) and of the file (64 MiB), and the workflow's golden-run storage limits, then creates the golden set and every golden run in one transaction. If anything fails, nothing is created.
- **A model tape or memory seed is carried but not stored** by a server that has no place for it; the import lists it in `warnings`.

When the file was exported from another workflow than the target, the import goes ahead because the target was named explicitly, and says so in `warnings`.

### Signatures

`--sign` signs the file with the deployment's audit signing key (the same Ed25519 key that signs run manifests and audit bundles). The signature covers the canonical JSON of the file without its `signature` block, bound to the key id and the signing time, so any edit to a case, a name or a score breaks it.

`l2m golden verify` checks the signature offline:

| Exit code | Meaning |
| --- | --- |
| 0 | The signature is valid and `--public-key` (the key you got from the deployment through a trusted channel) matches |
| 1 | The file is unsigned, was changed after signing, or was signed with another key |
| 3 | The signature is consistent with the key inside the file, but no `--public-key` was given, so it does not prove who signed it (`--trust-embedded-key` accepts that explicitly) |

`l2m golden import --public-key …` verifies the file the same way before sending it and refuses one that does not pass. The server also checks a signature on import: a file signed by a key it does not know, or changed after signing, imports with a warning (everything is scrubbed and validated regardless).

## Audit events

Exports and imports are written to the audit log as `replay.golden_set.exported` (case count, whether it was signed) and `replay.golden_set.imported` (source and target workflow, case count, whether the file was signed).
