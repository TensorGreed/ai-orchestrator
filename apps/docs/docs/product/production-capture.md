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

A run can be captured when a production trigger starts it: a production webhook, a schedule, chat and the embedded widget, forms, app triggers (Slack, GitHub, Stripe, Telegram, Discord), the MCP gateway, the queue, and `POST /api/workflows/:id/execute` and `/execute/stream` called with an API key. An API-key run of the execute routes stays a `manual` (`manual_stream`) run everywhere: the workflow's `trigger_type`, the run history and its `triggerType` filter see it exactly as before. The server marks it as an API-key run where it starts (a caller cannot set that marker), and only that marker makes it eligible. Its capture is named "Captured API-key run …", and the recording stores `capture.source: "api_key"` (set by the server; a golden-set import drops it). The inbox shows these runs with an **API key** chip, and the trigger filter's **API key** option lists them.

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
| `dropped_identifier_value` | A personal value from the run was found in an MCP routing identifier (a server key, registry id or adapter, or a tool name), which is kept as written so the run can be replayed. Dropped rather than stored. |
| `discarded_disabled` | Capture was turned off (or masking turned on) while the run was going. |
| `discarded_source_deleted` | The run or its workflow was deleted while the capture was being built. Nothing of it is kept. |
| `skipped_too_large` | Over `REPLAY_RECORDING_MAX_BYTES`, or larger than the workflow's whole capture byte budget. |
| `skipped_paused` | The run paused for approval. |
| `skipped_daily_limit`, `discarded_status`, `skipped_excluded_trigger`, `skipped_not_stored`, `skipped_stale`, `failed` | Over the day's limit, an unwanted outcome, not a production trigger, run history not stored, a capture that never finished, or a storage error. |

The settings panel shows the last run capture dropped, with when and why in plain words ("Last run not captured: …, because a personal value was in an MCP server or tool name"), so a workflow whose runs are always dropped does not just show an empty inbox. The `GET` settings answer carries it as `lastDrop` (`{ outcome, at }`, or null); the outcomes noted are `dropped_identifier_value`, `dropped_unscannable`, `dropped_incomplete_mask`, `skipped_too_large` and `failed`.

A run whose final history is never written gives its slot back once its own timeout (at most 24 hours) plus a minute has passed. That check runs every minute, and again before a run is refused for the daily limit.

On one API instance the daily limit is never exceeded: a sampled run holds its slot before the day's count is read, so two runs starting together cannot both take the last slot. Runs that start together near the limit can all be skipped, though, so a day can end a few captures under it. The captures stored that day are counted from the database, which every instance shares, but the runs being recorded right now are counted in each API process's memory. With several API instances, each one sees the stored captures and only its own runs in flight, so the limit is approximate: a day can end over it by at most the runs the other instances were recording when a run was admitted. The "today" figure in the settings line is counted the same way, by the instance that answers.

Failure logs carry the error's class and a scrubbed message (secrets removed, personal data masked, long digit runs hidden), never a value.

## Masking

Before a captured run is stored, it is scrubbed of secrets (as every golden run is). Then every email address, card number, IBAN, US SSN, phone number, UK National Insurance number and every term from the dictionaries of the workflow's guard profiles is replaced by a **surrogate**: a stand-in value of the same kind.

- **Format-preserving.** A card stays a Luhn-valid card number starting with 4, an IBAN keeps its country and valid check digits, an SSN keeps the structure of a valid SSN (area 001–899 except 666, group and serial not zero), a phone keeps its digit count and separators, and an email becomes `u-…@surrogate.invalid`. Guard rules and DLP checks see the same kinds of data in a replay as they did in production. A card or SSN surrogate is not drawn from a reserved test range: it can coincide with a number that was really issued to someone else.
- **Detection, then every form of what was detected.** Values are found by the guard's DLP patterns (the same shapes a guard profile detects) plus a capture-only detector for international phone numbers, on a view of each string with URL-encoding (`%40`) and JSON escapes (`\u0040`) decoded. On their own, they find: an email in any letter case, also plus-addressed or URL-encoded; a card with spaces, dashes or no separators; an IBAN in capitals, with or without spaces; an SSN written `123-45-6789`; a UK NI number; a national phone layout the DLP pattern reads (`(415) 555-0123`, `415-555-0123`, `020 7946 0958`); **every phone number written with `+` or `00` and an assigned country calling code**, in E.164 without separators (`+14155550123`) or any layout with spaces, dots, dashes, brackets or `(0)` (`+33 1 23 45 67 89`, `+44 (0) 20 7946 0958`, `+61 2 9876 5432`, `+91 98765 43210`, `+81 3-1234-5678`, `+353 1 234 5678`, `+7 495 123-45-67`); and the same values in object keys, error messages and JSON numbers. Once a value is found anywhere in the run, every other form of it is replaced too, in the same encoding. The international phone detector is used by capture and the lookup only; the runtime guard's DLP scan is unchanged.
- **Forms masked only when the same value is found in another form somewhere in the run.** A card with dots (`4111.1111.1111.1111`); an SSN with spaces, dots or no separators (`123 45 6789`, `123456789`); a phone with no separators and no `+` (`4155550123`), stored as a JSON number, or in a national layout the DLP pattern does not read (`2212 3456` or `22123456` for `+47 2212 3456`; `06 1 234 5678` for `+36 1 234 5678`; `8 (495) 123-45-67` for `+7 495 123 4567`); an IBAN in lower case. If such a form is the only one in the run, it is stored as written.
- **Never recognised, stored as written.** Digits of other scripts (fullwidth, Arabic-Indic and others) or `＠`, HTML entities (`&#64;`), base64 or other encodings of a value, and a value split across two strings or array elements. Do not rely on masking for these.
- After masking the run is scanned again; if a collected value is still found, the capture is dropped.
- **Same value, same surrogate.** Surrogates are keyed (HMAC with a key derived from `SECRET_MASTER_KEY_BASE64`), so a value gets the same surrogate everywhere in the run and in every capture. A phone is keyed on its national number (without the country code and the country's trunk prefix: `0` in most countries, `06` in Hungary, `8` in Russia, Kazakhstan and Belarus; Italy's leading `0` is part of the number), so `+1 415-555-0123`, `415-555-0123` and `14155550123` get the same surrogate digits, and so do `+36 30 123 4567` and `06 30 123 4567`; the country code (`+1`, `+47`) and the trunk prefix are kept as written and never rewritten. Two people whose numbers end in the same digits get different surrogates. The tool arguments, the model requests and the memory seed stay consistent with each other, and a replay still finds its answers on the masked tape and cassette.
- **Surrogates are full.** No real character of a value is kept (no last four digits of a card, SSN or national ID, no last digits of a phone number or IBAN); only the structure stays (separators, an IBAN's country, a phone's country code). A replay of a masked capture compares guard-masked spans as equal whatever they hide: `j•••@e••••••.com` and `u•••••••••••••@s••••••••.invalid` match, as do `•••• •••• •••• 1111` and `•••• •••• •••• 9876`, while any difference in the text around them still counts (see [Guard-masked text](./golden-runs.md#guard-masked-text) for the exact rules).
- **Values the workflow holds stay.** A value written into the workflow itself, such as a support address in a prompt, is not replaced, but only where the run holds exactly that whole value: `a@b.co` in the workflow does not keep `a@b.com` in the run, and a phone number inside a longer workflow string is not kept. Ids, positions and other structural fields of the workflow do not count. Secrets are always removed.
- **Credentials, private keys and tokens** are removed outright (`[redacted:credential]`).
- **MCP routing identifiers stay as written.** A replay finds a recorded MCP call by the server key it rebuilds from the live configuration and by the tool name the workflow gives, so a cassette's server key, registry id and adapter, each entry's server, and a `tools/call` tool name are not masked (they are operator configuration, already stored in plain text in the registry and the workflow). If one of them holds a value masked elsewhere in the run, the capture is dropped (`dropped_identifier_value`). Such a value counts only as a whole token: a number not glued to other letters or digits, a word not glued to letters, digits or `_` (a dictionary term `atlas` is not in the tool name `atlas_search`); an email or a secret counts anywhere. Ids the server made (server keys such as `registry:mcp_<uuid>`, registry ids, adapter ids) and tool names the server's own catalog lists (its recorded `tools/list` answer, or the registry's current tool snapshot) are not scanned on their own, since a digit run in a random id can read as a card number. Any other tool name, or an entry server that is not one of the cassette's servers, is also scanned on its own, so a value found only there drops the capture too. A resource URI, a prompt name and a server's label are masked like any content.

::: warning Rotating the master key changes every surrogate
Surrogates come from `SECRET_MASTER_KEY_BASE64`. After the key is rotated, the same value gets a different surrogate: captures stored before the rotation no longer match a data-subject lookup made after it, and no longer line up with new captures. Before rotating, run the lookups you owe and delete or promote what waits in the inbox; purge older captures you cannot account for.
:::

Each node in the stored run is labelled with the data classes found in it (`dataClasses`) and where its content came from (`provenance`). Provenance comes from the trigger and the node type only, never from the scan: input nodes get `trusted` only for the server's own scheduled runs, `user` for runs a signed-in user or an API key started and for chat, forms and app messages, and `untrusted_external` otherwise (a `triggerType` a caller names on the queue earns nothing); nodes that fetch from outside (HTTP, connectors, RAG, MCP) are `untrusted_external`. The inbox shows the classes as chips: "email", "card". A golden-set file carries the labels and the masked flag, but an import never trusts them: the imported run is shown as **imported (masking not verified)**, its labels are marked `source: "file"` with `trusted` provenance dropped, and exporting it again does not claim it was masked.

::: warning Pseudonymisation, not anonymisation
Masking is pseudonymisation. A surrogate cannot be turned back into the value, but anyone with the deployment's master key can compute the surrogate of a value they already know and find it. The rest of the run (free text, timings, the shape of the conversation) is kept as it was. Treat captured runs as personal data under your data-protection rules: limit who can read the workflow, keep retention short, and use the [data-subject lookup](#data-subject-lookup) to answer access and erasure requests.
:::

### Turning masking off

An admin can turn masking off for a workflow, for example for synthetic test traffic. It needs a reason, which is stored with the settings and audited (`replay.capture.masking_disabled`). Builders see that masking is off, not the reason. Runs captured while masking is off are stored with their personal data, and the inbox marks them **not masked**.

## The inbox

**Captured runs** lists the workflow's captures, newest first, with a badge counting how many wait. Each row shows the trigger, when it was captured, the run's outcome and the data classes masked; a run an API key started has an **API key** chip (its trigger stays `manual`). Filter by outcome, trigger (including **API key**) and date. Select several to promote or discard them together (up to 100 at a time).

- **Promote** adds the run to the target set as a case. It is one step: if it is refused, nothing is left behind (no empty "Captured" set). Promoting scrubs the run again with the current secrets, and checks the golden-run limits (`REPLAY_RECORDING_MAX_BYTES`, `REPLAY_RECORDINGS_MAX_PER_WORKFLOW` and the byte budgets). Over a limit, the promote is refused (409) and the run stays in the inbox. A promoted run is an ordinary golden run: it keeps its capture time, and its `createdBy` is the builder who promoted it.
- **Discard** deletes the captured run.
- **Open run** opens the production run it came from on the Runs page, while its history is kept.

A captured run is not a golden run until it is promoted. It is not listed with golden runs, cannot be added to a golden set, replayed, used by a replay job or release gate, or exported with a golden set.

Captured runs are kept for `REPLAY_CAPTURE_RETENTION_DAYS` (14 days by default) and then deleted. A workflow holds at most `REPLAY_CAPTURES_MAX_PER_WORKFLOW` (200) captures and `REPLAY_CAPTURES_MAX_BYTES_PER_WORKFLOW` (200 MB) of them: a new capture over either drops the oldest ones. Captures do not count toward the golden-run limits until they are promoted.

## Data-subject lookup

When someone asks what you hold about them, or asks you to delete it, an admin first searches for a value, then deletes what the search found. Searching never deletes. In the app, admins find this as **Find a person's data** under Evaluations → Golden sets.

```http
POST /api/replay/recordings/find-subject
{ "value": "jane.doe@example.com" }
```

What a search finds is what a delete removes, so matching is strict: masking may over-mask, the lookup never over-matches.

- **The value's class** comes from the scan of the value itself (`dataClass` in the answer): an email, card, IBAN, SSN or NI number as typed, and a phone written with separators or with `+` and an assigned country calling code (`+14155550123` included). Only stored values of that class match: raw (runs saved by hand or captured with masking off) and as its surrogate. Captures stored by earlier releases kept the last digits of a card, SSN, NI number, IBAN or phone in their surrogates; the lookup also builds that older form, so those captures stay findable and deletable.
- **Telling it the class.** `dataClass` (`email`, `phone`, `card_number`, `us_ssn`, `iban`, `national_id`) reads the value as that class. A value that does not parse as it is refused with 400 (a phone needs 7 to 15 digits), never searched as text instead. For a phone typed without its country code, `country` (an ISO code such as `"US"`, or a calling code such as `"+44"`) says which country it is: `{ "value": "4155550123", "dataClass": "phone", "country": "US" }` is searched as `+1 415 555 0123`. A country that is not in the list, or that disagrees with a number's own `+` code, is refused. In the app, typing 7 to 15 bare digits offers **Read as: Text / Phone number**, and choosing phone offers the country.
- **Whole values only.** A card, SSN or other number matches only a whole run of digits with exactly its digits, never a suffix or a part of a longer number, and never next to a letter: `123-45-6788` does not match `+1 912-345-6788` or `order 99123456788`. An email matches only the whole address: `ann@x.co` does not match `joann@x.com`. An IBAN matches with or without spaces, in any case.
- **Phones: exact and possible matches.** Each match has a `certainty`:
  - `exact`: the stored number and the searched one both carry the same country code and national number (`+1 415-555-0123` and `+14155550123`, `0014155550123`, `+1 (415) 555-0123`).
  - `national_only`: the national digits agree, but the stored copy or the search has no country code (`(415) 555-0123`, `14155550123`, `020 7946 0958`, `06 1 234 5678` for `+36 1 234 5678`, `8 (495) 123-45-67` for `+7 495 123 4567`). That cannot prove it is the same person: a US `(207) 946-0958` and a UK `+44 20 7946 0958` read alike. These are **possible matches**. A stored copy's own country code is shown when it has one (`storedCallingCode`), since it is not personal data.

  A different country code, a shared suffix (`invoice 2024155550123`, a card ending in those digits) or a country code guessed in front of a number written without one (`44 207 946 0958`, `7 415 555 0123`) never matches. A phone searched without a country code (and without `country`) can only give possible matches.
- **Anything else** (no recognised class, including digits typed without separators and no `dataClass`) is matched as exact text, as a whole token (at least 6 characters), and as the surrogate of each dictionary class. Text of 7 to 15 digits found inside a longer phone number (right after a `+cc`, `00cc` or `(0)`, as in `+33 4155550123`, or inside a number the international detector reads) is only a possible match, never exact: it may be another country's number.

The answer says how the value was searched (`dataClass`, and `callingCode` for a phone searched with its country code: the app shows "Searched as phone (+1)"), then lists each match, certain ones first (`kind`, `id`, its workflow and project, its name or status, how it matched: `raw` or the data class, which fields hold it, its `certainty`) with up to five `hits`: the field, the class, the hit's certainty and a masked excerpt (the match as the guard mask shows it, brackets kept, digits around it hidden), so you can check why a row matched before deleting it. It also gives the counts per kind, and the lists of what was searched (`covered`) and what was not (`notCovered`).

Then delete the matches you choose, by id, with the same `value`, `dataClass` and `country` as the search:

```http
POST /api/replay/recordings/find-subject/delete
{ "value": "jane.doe@example.com", "targets": [{ "kind": "recording", "id": "rec_…" }] }
```

Each target is checked again, with the same strict matching, before anything is deleted; one that is gone or no longer holds the value is skipped (`skipped`, with `not_found` or `no_match`). **A possible match is never deleted unless its target says `"confirmPossible": true`**: the admin checked that row and confirms it holds this person's number. Without it the row is skipped with `possible_match_unconfirmed`. A request that names the same row both with and without `confirmPossible` is refused with 400 and nothing is deleted. The app lists possible matches under **Possible matches (no country code in the data, or in your search)**, not selected, with a plain explanation; selecting one sends its confirmation. The confirm step says how many of the rows are possible matches, and the result says how many were skipped as unconfirmed possible matches. A golden run takes the golden-set cases made from it, and their results, with it. When one of those cases is admitted on an enforced [release gate](./release-gate.md#case-admission-and-required-cases), the delete still goes ahead; it is audited as loosening the gate, and every replay job that held a removed result can no longer prove a release. A run (execution history) takes its tool-call, guard-event and usage rows with it. The value itself is never stored, logged or returned.

The audit trail never holds the value. A search records the counts (`replay.find_subject.searched`). A delete first writes `replay.find_subject.delete_started` naming every row about to be deleted and counting the confirmed possible matches (`confirmedPossible`), before the first one is (if the server stops midway, that row is there), then `replay.find_subject.deleted` naming every row deleted, cases and results included. Ids are written as `kind:id`, 200 to an audit row.

**Searched and deleted:**

- golden runs and captured runs: input, node outputs, run facts, MCP cassette, model tape, memory seed, workflow snapshot, notes
- golden-set cases: input and expected output, including hand-written cases
- replay, replay-job, release-gate and eval results: output, error and diff
- runs made from golden runs and cases (execution history of replays, replay jobs, evals and LLM-judge calls): input, output, node results, custom data, error; deleting one also deletes its tool-call, guard-event and usage rows
- MCP cassettes recorded by those runs

**Not searched (these follow their own retention):**

- production execution history, tool-call telemetry and paused runs (`EXECUTION_HISTORY_RETENTION_DAYS`)
- MCP cassettes from **Record calls** on ordinary runs, and imported cassettes (`EXECUTION_HISTORY_RETENTION_DAYS`)
- session memory, tool data and session artifacts
- logs, metrics and log-streaming destinations
- the audit log (`AUDIT_LOG_RETENTION_DAYS`; it holds ids and counts, not values)
- guard events of production runs (masked evidence only) and the guard token vault
- usage events of production runs, and eval run summaries

A lookup only finds surrogates made with the current master key; see [Rotating the master key](#masking).

## Access

Every route checks access to the workflow, the same way as golden runs: a user who cannot read the workflow gets 404, and one who can read but not change it gets 403. Viewers can see the settings and the inbox. Builders change the settings, promote and discard. Only admins can turn masking off or run the data-subject lookup.

## API

- `GET /api/workflows/:id/replay-capture` (viewer; `{ settings }`: the workflow's settings, `configured`, the deployment's limits, `effectiveRate`, `candidates`, `capturedToday`)
- `PUT /api/workflows/:id/replay-capture` (builder; any of `{ enabled, rate (0–1), maxPerDay (1–1000), onlyStatuses, dlp, targetDatasetId, reason }`; turning `dlp` off is admin-only and needs `reason`; a rate over `REPLAY_CAPTURE_MAX_RATE` is refused; audited as `replay.capture.settings_updated`)
- `GET /api/workflows/:id/replay-captures?runStatus=&trigger=&from=&to=&limit=&offset=` (viewer; `{ items, total }`; each item adds `dataClasses`, `masked` and `source` (`api_key` or null); `trigger=api_key` lists runs an API key started)
- `POST /api/replay/captures/:id/promote` (builder; `{ datasetId?, name? }`; `{ result, recording }`; audited as `replay.capture.promoted`)
- `POST /api/replay/captures/promote` (builder; `{ ids (up to 100), datasetId? }`; `{ results, promoted }`, one result per id)
- `DELETE /api/replay/captures/:id` and `POST /api/replay/captures/discard` `{ ids }` (builder; audited as `replay.capture.discarded`)
- `POST /api/replay/recordings/find-subject` (admin; `{ value, dataClass?, country? }`; `{ dataClass, callingCode, classesTried, matches (each with certainty and hits), counts, searched, covered, notCovered }`; searches only)
- `POST /api/replay/recordings/find-subject/delete` (admin; `{ value, dataClass?, country?, targets: [{ kind, id, confirmPossible? }] }` from a search, up to 2000; `{ deleted, removed, skipped }`; a possible match needs `confirmPossible: true`)

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `REPLAY_CAPTURE_ENABLED` | `true` | Deployment kill switch. `false` stops all capture; settings are kept. |
| `REPLAY_CAPTURE_MAX_RATE` | `1` | Highest sample rate a workflow may set (0–1). The default, 1, means no ceiling. Lowering it caps workflows already set higher. |
| `REPLAY_CAPTURE_RETENTION_DAYS` | `14` | Days a captured run waits in the inbox before it is deleted. |
| `REPLAY_CAPTURES_MAX_PER_WORKFLOW` | `200` | Captured runs a workflow keeps; the oldest is dropped beyond it. |
| `REPLAY_CAPTURES_MAX_BYTES_PER_WORKFLOW` | `209715200` (200 MB) | Bytes of captured runs a workflow keeps; the oldest are dropped to make room. A capture larger than the whole budget is not stored. |

The golden-run limits (`REPLAY_RECORDING_MAX_BYTES` and the rest, see [Golden runs](./golden-runs.md#size)) apply to each capture and again on promote.
