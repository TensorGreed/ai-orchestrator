# Production capture

Golden sets are only as good as the runs in them. **Production capture** records a sample of a workflow's real production runs, masks the personal data in them, and puts them in a **Captured runs** inbox. From there a builder promotes the useful ones into a [golden set](./golden-sets.md) in one click, and discards the rest.

Capture is off for every workflow until a builder turns it on. A workflow that never turns it on runs exactly as before: nothing is recorded and the inbox stays empty.

## Turning it on

On **Evaluations → Golden sets**, the **Production capture** section shows one workflow at a time (the one open in the editor first). Tick **Capture production runs**. The defaults:

| Setting | Default | Meaning |
| --- | --- | --- |
| Sample rate | 10% | Share of eligible production runs recorded. Each run is sampled when it starts. |
| Most a day | 20 | Captures per workflow per UTC day: the captures stored that day plus the runs being recorded right now. A capture discarded from the inbox frees its slot for the rest of the day. |
| Keep runs that | Succeeded, Failed, Canceled | A sampled run that ends with another outcome is dropped, and does not use up the day. |
| Promote into | "Captured" | The golden set promoted runs go to. "Captured" is created on the first promote. |
| Mask personal data | On | See [Masking](#masking). Only an admin can turn it off. |

The rest sits under **Advanced**. The line under the toggle says what capture does right now, for example "Capturing 10% of production runs, up to 20 a day, personal data masked. 3 today."

## Which runs are captured

A run can be captured when a production trigger starts it: a production webhook, a schedule, chat and the embedded widget, forms, app triggers (Slack, GitHub, Stripe, Telegram, Discord), the MCP gateway, the queue, and `POST /api/workflows/:id/execute` and `/execute/stream` called with an API key. API-key runs of the execute routes are recorded with the trigger `api_execute` (`api_execute_stream` for the stream), so the inbox can tell them apart.

These are never captured:

- runs from the editor (the execute routes called with a session cookie stay `manual` runs), retries and test webhooks (`/webhook-test/…`)
- replays, replay jobs, release-gate runs and eval runs, including LLM-judge calls
- error-workflow runs and single-node runs
- a run that pauses for approval: it gives its sample slot back the moment it pauses, nothing of it is kept, and the run that continues after the decision (same execution id) is not captured either

When the workflow has a [published version](./release-gate.md), only runs of that version are captured. Runs of the draft are not.

A captured run is recorded like a run with **Record calls** on: MCP calls on a cassette, model calls on a model tape, and the agent memory it started with (see [Golden runs](./golden-runs.md#model-tape-and-memory-seed)). So a promoted capture replays without calling the live tools or models.

Capture never fails or slows a production run. The run answers first; the capture is built afterwards in the background, in chunks, so masking a large run does not hold up other requests. The settings are read again when the capture is built: if capture was turned off while the run was going, the capture is discarded. A capture that cannot be built is dropped and logged, and counted in the `replay_captures_total{outcome}` metric:

| Outcome | Meaning |
| --- | --- |
| `captured` | Stored in the inbox. |
| `dropped_unscannable` | Part of the run could not be scanned completely (nested deeper than the scanner reads). Dropped rather than stored unscanned. |
| `dropped_incomplete_mask` | A value was still found after masking. Dropped rather than stored. |
| `discarded_disabled` | Capture was turned off (or masking turned on) while the run was going. |
| `skipped_too_large` | Over `REPLAY_RECORDING_MAX_BYTES`, or larger than the workflow's whole capture byte budget. |
| `skipped_paused` | The run paused for approval. |
| `skipped_daily_limit`, `discarded_status`, `skipped_excluded_trigger`, `skipped_not_stored`, `skipped_stale`, `failed` | Over the day's limit, an unwanted outcome, not a production trigger, run history not stored, a capture that never finished, or a storage error. |

## Masking

Before a captured run is stored, it is scrubbed of secrets (as every golden run is). Then every email address, card number, IBAN, US SSN, phone number, UK National Insurance number and every term from the dictionaries of the workflow's guard profiles is replaced by a **surrogate**: a stand-in value of the same kind.

- **Format-preserving.** A card stays a Luhn-valid card number starting with 4, an IBAN keeps its country and valid check digits, an SSN keeps the structure of a valid SSN (area 001–899 except 666, group and serial not zero), a phone keeps its digit count and separators, and an email becomes `u-…@surrogate.invalid`. Guard rules and DLP checks see the same kinds of data in a replay as they did in production. A card or SSN surrogate is not drawn from a reserved test range: it can coincide with a number that was really issued to someone else.
- **Every form of a value.** A value is recognised however it is written: a phone or card with or without separators, a phone with or without its country code, an email in any letter case, an IBAN with or without spaces, a number stored as a JSON number, and a value URL-encoded or written with JSON `\u` escapes. Every form is replaced, in the same form (a URL-encoded value by a URL-encoded surrogate). After masking the run is scanned again; if a value is still found, the capture is dropped.
- **Same value, same surrogate.** Surrogates are keyed (HMAC with a key derived from `SECRET_MASTER_KEY_BASE64`), so a value gets the same surrogate everywhere in the run and in every capture. A phone is keyed on its last nine digits, so `+1 415-555-0123` and `415-555-0123` get the same surrogate; the leading country digits are kept as written. The tool arguments, the model requests and the memory seed stay consistent with each other, and a replay still finds its answers on the masked tape and cassette.
- **What the mask action shows stays, for classes a guard masks.** When a guard profile bound to the workflow masks a class (the `mask` action, or `protect` falling back to mask), its surrogates keep the characters the mask leaves visible: the last four digits of a card, SSN or national ID, the last two of a phone number, the last four characters of an IBAN. An output that a guard masked in production then reads the same in a replay. Classes no bound profile masks get full surrogates, with no real characters kept. Email surrogates never match the guard's email mask (`j***@example.com`); a replay that compares guard-masked emails sees a difference.
- **Values the workflow holds stay.** A value written into the workflow itself, such as a support address in a prompt, is not replaced, but only where the run holds exactly that whole value: `a@b.co` in the workflow does not keep `a@b.com` in the run, and a phone number inside a longer workflow string is not kept. Ids, positions and other structural fields of the workflow do not count. Secrets are always removed.
- **Credentials, private keys and tokens** are removed outright (`[redacted:credential]`).

::: warning Rotating the master key changes every surrogate
Surrogates come from `SECRET_MASTER_KEY_BASE64`. After the key is rotated, the same value gets a different surrogate: captures stored before the rotation no longer match a data-subject lookup made after it, and no longer line up with new captures. Before rotating, run the lookups you owe and delete or promote what waits in the inbox; purge older captures you cannot account for.
:::

Each node in the stored run is labelled with the data classes found in it (`dataClasses`) and where its content came from (`provenance`). Provenance comes from the trigger and the node type only, never from the scan: input nodes get `trusted` only for the server's own scheduled runs, `user` for runs a signed-in user or an API key started and for chat, forms and app messages, and `untrusted_external` otherwise (a `triggerType` a caller names on the queue earns nothing); nodes that fetch from outside (HTTP, connectors, RAG, MCP) are `untrusted_external`. The inbox shows the classes as chips: "email", "card". A golden-set file keeps the labels and the masked flag, so an imported capture still says its values are surrogates.

::: warning Pseudonymisation, not anonymisation
Masking is pseudonymisation. A surrogate cannot be turned back into the value, but anyone with the deployment's master key can compute the surrogate of a value they already know and find it. The rest of the run (free text, timings, the shape of the conversation) is kept as it was. Treat captured runs as personal data under your data-protection rules: limit who can read the workflow, keep retention short, and use the [data-subject lookup](#data-subject-lookup) to answer access and erasure requests.
:::

### Turning masking off

An admin can turn masking off for a workflow, for example for synthetic test traffic. It needs a reason, which is stored with the settings and audited (`replay.capture.masking_disabled`). Builders see that masking is off, not the reason. Runs captured while masking is off are stored with their personal data, and the inbox marks them **not masked**.

## The inbox

**Captured runs** lists the workflow's captures, newest first, with a badge counting how many wait. Each row shows the trigger, when it was captured, the run's outcome and the data classes masked. Filter by outcome, trigger and date. Select several to promote or discard them together (up to 100 at a time).

- **Promote** adds the run to the target set as a case. It is one step: if it is refused, nothing is left behind (no empty "Captured" set). Promoting scrubs the run again with the current secrets, and checks the golden-run limits (`REPLAY_RECORDING_MAX_BYTES`, `REPLAY_RECORDINGS_MAX_PER_WORKFLOW` and the byte budgets). Over a limit, the promote is refused (409) and the run stays in the inbox. A promoted run is an ordinary golden run: it keeps its capture time, and its `createdBy` is the builder who promoted it.
- **Discard** deletes the captured run.
- **Open run** opens the production run it came from on the Runs page, while its history is kept.

A captured run is not a golden run until it is promoted. It is not listed with golden runs, cannot be added to a golden set, replayed, used by a replay job or release gate, or exported with a golden set.

Captured runs are kept for `REPLAY_CAPTURE_RETENTION_DAYS` (14 days by default) and then deleted. A workflow holds at most `REPLAY_CAPTURES_MAX_PER_WORKFLOW` (200) captures and `REPLAY_CAPTURES_MAX_BYTES_PER_WORKFLOW` (200 MB) of them: a new capture over either drops the oldest ones. Captures do not count toward the golden-run limits until they are promoted.

## Data-subject lookup

When someone asks what you hold about them, or asks you to delete it, an admin first searches for a value, then deletes what the search found. Searching never deletes.

```http
POST /api/replay/recordings/find-subject
{ "value": "jane.doe@example.com" }
```

The value is looked for as itself, for runs saved by hand or captured with masking off, and as its surrogate under each data class it could be (with and without the visible tail). Matching is on whole values in their canonical form: digits only for phones, cards, SSNs and numeric IDs (a phone with or without its country code), email in lower case, IBAN without spaces in upper case. `ann@x.co` does not match `joann@x.com`. A value that is not recognised as one of the data classes is matched as a whole word and needs at least 6 characters.

The answer lists each match (`kind`, `id`, its workflow and project, its name or status, how it matched: `raw` or the data class, and which fields hold it), the counts per kind, and the lists of what was searched (`covered`) and what was not (`notCovered`).

Then delete the matches you choose, by id:

```http
POST /api/replay/recordings/find-subject/delete
{ "value": "jane.doe@example.com", "targets": [{ "kind": "recording", "id": "rec_…" }] }
```

Each target is checked again before it is deleted; one that is gone or no longer holds the value is skipped (`skipped`, with `not_found` or `no_match`). A golden run takes the golden-set cases made from it, and their results, with it. The value itself is never stored, logged or returned. The audit events record the counts (`replay.find_subject.searched`) and every deleted id (`replay.find_subject.deleted`, as `kind:id`, in rows of 200), never the value.

**Searched and deleted:**

- golden runs and captured runs: input, node outputs, run facts, MCP cassette, model tape, memory seed, workflow snapshot, notes
- golden-set cases: input and expected output, including hand-written cases
- replay, replay-job, release-gate and eval results: output, error and diff
- runs made from golden runs and cases (execution history of replays, replay jobs, evals and LLM-judge calls): input, output, node results, custom data, error
- MCP cassettes recorded by those runs

**Not searched (these follow their own retention):**

- production execution history, tool-call telemetry and paused runs (`EXECUTION_HISTORY_RETENTION_DAYS`)
- MCP cassettes from **Record calls** on ordinary runs, and imported cassettes (`EXECUTION_HISTORY_RETENTION_DAYS`)
- session memory, tool data and session artifacts
- logs, metrics and log-streaming destinations
- the audit log (`AUDIT_LOG_RETENTION_DAYS`; it holds ids and counts, not values)
- guard events (masked evidence only) and the guard token vault
- usage events and eval run summaries

A lookup only finds surrogates made with the current master key; see [Rotating the master key](#masking).

## Access

Every route checks access to the workflow, the same way as golden runs: a user who cannot read the workflow gets 404, and one who can read but not change it gets 403. Viewers can see the settings and the inbox. Builders change the settings, promote and discard. Only admins can turn masking off or run the data-subject lookup.

## API

- `GET /api/workflows/:id/replay-capture` (viewer; `{ settings }`: the workflow's settings, `configured`, the deployment's limits, `effectiveRate`, `candidates`, `capturedToday`)
- `PUT /api/workflows/:id/replay-capture` (builder; any of `{ enabled, rate (0–1), maxPerDay (1–1000), onlyStatuses, dlp, targetDatasetId, reason }`; turning `dlp` off is admin-only and needs `reason`; a rate over `REPLAY_CAPTURE_MAX_RATE` is refused; audited as `replay.capture.settings_updated`)
- `GET /api/workflows/:id/replay-captures?runStatus=&trigger=&from=&to=&limit=&offset=` (viewer; `{ items, total }`; each item adds `dataClasses` and `masked`)
- `POST /api/replay/captures/:id/promote` (builder; `{ datasetId?, name? }`; `{ result, recording }`; audited as `replay.capture.promoted`)
- `POST /api/replay/captures/promote` (builder; `{ ids (up to 100), datasetId? }`; `{ results, promoted }`, one result per id)
- `DELETE /api/replay/captures/:id` and `POST /api/replay/captures/discard` `{ ids }` (builder; audited as `replay.capture.discarded`)
- `POST /api/replay/recordings/find-subject` (admin; `{ value }`; `{ classesTried, matches, counts, searched, covered, notCovered }`; searches only)
- `POST /api/replay/recordings/find-subject/delete` (admin; `{ value, targets: [{ kind, id }] }` from a search, up to 2000; `{ deleted, removed, skipped }`)

These routes need the SQLite store. On Postgres they answer 501, and capture does not run.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `REPLAY_CAPTURE_ENABLED` | `true` | Deployment kill switch. `false` stops all capture; settings are kept. |
| `REPLAY_CAPTURE_MAX_RATE` | `1` | Highest sample rate a workflow may set (0–1). The default, 1, means no ceiling. Lowering it caps workflows already set higher. |
| `REPLAY_CAPTURE_RETENTION_DAYS` | `14` | Days a captured run waits in the inbox before it is deleted. |
| `REPLAY_CAPTURES_MAX_PER_WORKFLOW` | `200` | Captured runs a workflow keeps; the oldest is dropped beyond it. |
| `REPLAY_CAPTURES_MAX_BYTES_PER_WORKFLOW` | `209715200` (200 MB) | Bytes of captured runs a workflow keeps; the oldest are dropped to make room. A capture larger than the whole budget is not stored. |

The golden-run limits (`REPLAY_RECORDING_MAX_BYTES` and the rest, see [Golden runs](./golden-runs.md#size)) apply to each capture and again on promote.
