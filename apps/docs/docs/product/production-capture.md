# Production capture

Golden sets are only as good as the runs in them. **Production capture** records a sample of a workflow's real production runs, masks the personal data in them, and puts them in a **Captured runs** inbox. From there a builder promotes the useful ones into a [golden set](./golden-sets.md) in one click, and discards the rest.

Capture is off for every workflow until a builder turns it on. A workflow that never turns it on runs exactly as before: nothing is recorded and the inbox stays empty.

## Turning it on

On **Evaluations → Golden sets**, the **Production capture** section shows one workflow at a time (the one open in the editor first). Tick **Capture production runs**. The defaults:

| Setting | Default | Meaning |
| --- | --- | --- |
| Sample rate | 10% | Share of eligible production runs recorded. Each run is sampled when it starts. |
| Most a day | 20 | Captures per workflow per UTC day, counting runs being recorded right now. |
| Keep runs that | Succeeded, Failed, Canceled | A sampled run that ends with another outcome is dropped, and does not use up the day. |
| Promote into | "Captured" | The golden set promoted runs go to. "Captured" is created on the first promote. |
| Mask personal data | On | See [Masking](#masking). Only an admin can turn it off. |

The rest sits under **Advanced**. The line under the toggle says what capture does right now, for example "Capturing 10% of production runs, up to 20 a day, personal data masked. 3 today."

## Which runs are captured

A run can be captured when a production trigger starts it: a production webhook, a schedule, chat and the embedded widget, forms, the execute API, app triggers (Slack, GitHub, Stripe, Telegram, Discord), the MCP gateway and the queue.

These are never captured:

- runs from the editor, retries and test webhooks (`/webhook-test/…`)
- replays, replay jobs, release-gate runs and eval runs, including LLM-judge calls
- approval resumes, error-workflow runs and single-node runs

When the workflow has a [published version](./release-gate.md), only runs of that version are captured. Runs of the draft are not.

A captured run is recorded like a run with **Record calls** on: MCP calls on a cassette, model calls on a model tape, and the agent memory it started with (see [Golden runs](./golden-runs.md#model-tape-and-memory-seed)). So a promoted capture replays without calling the live tools or models.

Capture never fails or slows a production run. The run answers first; the capture is built afterwards in the background. A capture that cannot be built (too large, or a storage error) is dropped and logged, and counted in the `replay_captures_total{outcome}` metric.

## Masking

Before a captured run is stored, it is scrubbed of secrets (as every golden run is). Then every email address, card number, IBAN, US SSN, phone number, UK National Insurance number and every term from the dictionaries of the workflow's guard profiles is replaced by a **surrogate**: a stand-in value of the same kind.

- **Format-preserving.** A card stays a Luhn-valid card number (on the 400000 test prefix), an IBAN keeps its country and valid check digits, an SSN stays a structurally valid SSN in an unassigned area, a phone keeps its digit count and separators, and an email becomes `u-…@surrogate.invalid`. Guard rules and DLP checks see the same kinds of data in a replay as they did in production.
- **Same value, same surrogate.** Surrogates are keyed (HMAC with a key derived from `SECRET_MASTER_KEY_BASE64`), so a value gets the same surrogate everywhere in the run and in every capture. The tool arguments, the model requests and the memory seed stay consistent with each other, and a replay still finds its answers on the masked tape and cassette.
- **What the mask action shows stays.** A surrogate keeps the characters the guard **mask** action leaves visible: the last four digits of a card, SSN or national ID, the last two of a phone number, and the country and last four characters of an IBAN. An output that a guard masked in production then reads the same in a replay.
- **Values the workflow holds stay.** A value written into the workflow itself, such as a support address in a prompt, is not replaced. Secrets are always removed.
- **Credentials, private keys and tokens** are removed outright (`[redacted:credential]`).

Each node in the stored run is labelled with the data classes found in it and where its content came from (`user`, `untrusted_external`, `trusted`, plus `sensitive` when it held personal data). The inbox shows the classes as chips: "email", "card".

::: warning Pseudonymisation, not anonymisation
Masking is pseudonymisation. A surrogate cannot be turned back into the value, but anyone with the deployment's master key can compute the surrogate of a value they already know and find it. The rest of the run (free text, timings, the shape of the conversation) is kept as it was. Treat captured runs as personal data under your data-protection rules: limit who can read the workflow, keep retention short, and use the [data-subject lookup](#data-subject-lookup) to answer access and erasure requests.
:::

### Turning masking off

An admin can turn masking off for a workflow, for example for synthetic test traffic. It needs a reason, which is stored with the settings and audited (`replay.capture.masking_disabled`). Builders see that masking is off, not the reason. Runs captured while masking is off are stored with their personal data, and the inbox marks them **not masked**.

## The inbox

**Captured runs** lists the workflow's captures, newest first, with a badge counting how many wait. Each row shows the trigger, when it was captured, the run's outcome and the data classes masked. Filter by outcome. Select several to promote or discard them together (up to 100 at a time).

- **Promote** adds the run to the target set as a case. Promoting scrubs the run again with the current secrets, and checks the golden-run limits (`REPLAY_RECORDING_MAX_BYTES`, `REPLAY_RECORDINGS_MAX_PER_WORKFLOW` and the byte budgets). Over a limit, the promote is refused (409) and the run stays in the inbox. A promoted run is an ordinary golden run: it keeps its capture time, and its `createdBy` is the builder who promoted it.
- **Discard** deletes the captured run.
- **Open run** opens the production run it came from on the Runs page, while its history is kept.

A captured run is not a golden run until it is promoted. It is not listed with golden runs, cannot be added to a golden set, replayed, used by a replay job or release gate, or exported with a golden set.

Captured runs are kept for `REPLAY_CAPTURE_RETENTION_DAYS` (14 days by default) and then deleted. A workflow holds at most `REPLAY_CAPTURES_MAX_PER_WORKFLOW` (200) captures: a new capture over that drops the oldest one. Captures do not count toward the golden-run limits until they are promoted.

## Data-subject lookup

When someone asks what you hold about them, or asks you to delete it, an admin can search every golden run and captured run for a value:

```http
POST /api/replay/recordings/find-subject
{ "value": "jane.doe@example.com" }
```

The value is looked for as itself, for runs saved by hand or captured with masking off, and as its surrogate under each data class it could be. The answer lists each match: the recording, its workflow and project, whether it is a captured run or a golden run, how it matched (`raw` or the data class), and which parts hold it. With `"delete": true`, every match is deleted, together with the golden-set cases made from it. The value itself is never stored, logged or returned; the audit events (`replay.find_subject.searched`, `replay.find_subject.deleted`) record only the counts.

The lookup covers golden runs and captured runs. Execution history, cassettes and other stores have their own retention (`EXECUTION_HISTORY_RETENTION_DAYS`).

## Access

Every route checks access to the workflow, the same way as golden runs: a user who cannot read the workflow gets 404, and one who can read but not change it gets 403. Viewers can see the settings and the inbox. Builders change the settings, promote and discard. Only admins can turn masking off or run the data-subject lookup.

## API

- `GET /api/workflows/:id/replay-capture` (viewer; `{ settings }`: the workflow's settings, `configured`, the deployment's limits, `effectiveRate`, `candidates`, `capturedToday`)
- `PUT /api/workflows/:id/replay-capture` (builder; any of `{ enabled, rate (0–1), maxPerDay (1–1000), onlyStatuses, dlp, targetDatasetId, reason }`; turning `dlp` off is admin-only and needs `reason`; a rate over `REPLAY_CAPTURE_MAX_RATE` is refused; audited as `replay.capture.settings_updated`)
- `GET /api/workflows/:id/replay-captures?runStatus=&trigger=&from=&to=&limit=&offset=` (viewer; `{ items, total }`; each item adds `dataClasses` and `masked`)
- `POST /api/replay/captures/:id/promote` (builder; `{ datasetId?, name? }`; `{ result, recording }`; audited as `replay.capture.promoted`)
- `POST /api/replay/captures/promote` (builder; `{ ids (up to 100), datasetId? }`; `{ results, promoted }`, one result per id)
- `DELETE /api/replay/captures/:id` and `POST /api/replay/captures/discard` `{ ids }` (builder; audited as `replay.capture.discarded`)
- `POST /api/replay/recordings/find-subject` (admin; `{ value, delete? }`)

These routes need the SQLite store. On Postgres they answer 501, and capture does not run.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `REPLAY_CAPTURE_ENABLED` | `true` | Deployment kill switch. `false` stops all capture; settings are kept. |
| `REPLAY_CAPTURE_MAX_RATE` | `1` | Highest sample rate a workflow may set (0–1). Lowering it caps workflows already set higher. |
| `REPLAY_CAPTURE_RETENTION_DAYS` | `14` | Days a captured run waits in the inbox before it is deleted. |
| `REPLAY_CAPTURES_MAX_PER_WORKFLOW` | `200` | Captured runs a workflow keeps; the oldest is dropped beyond it. |

The golden-run limits (`REPLAY_RECORDING_MAX_BYTES` and the rest, see [Golden runs](./golden-runs.md#size)) apply to each capture and again on promote.
