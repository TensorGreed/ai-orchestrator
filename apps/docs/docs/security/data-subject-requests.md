---
title: "Data-subject requests: find and export a person's data"
description: "Answer a data-subject request: find what L2M stores about one person by identifier and export it as a zip downloaded once. Optional; off until used."
---

# Data-subject requests

When someone asks what you hold about them, an admin (or a user with the `data_subject:manage` permission) makes a
**data-subject request**: L2M looks for the person's identifier in what it stores and builds a zip export that is
downloaded once. Nothing here is on by default and a
deployment that never uses it behaves exactly as before.

Two parts work together:

- **Subject references** (optional, per workflow): the values that identify the person a run is about, stored as keyed
  hashes when the run finishes. A request finds those runs, and their agent memory, without searching.
- **Requests**: an admin enters the person's value; L2M follows the references and, unless turned off, also searches
  stored data for the value.

Deleting a person's data is a separate step, covered in [Production capture](../product/production-capture.md#data-subject-lookup)
for golden and captured runs.

## Subject references

In the studio, open the workflow's **⋯** menu → **Subject references…** and add up to three paths, such as
<span v-pre>`{{input.customerId}}`</span> or <span v-pre>`{{input.headers.x-user-email}}`</span>. Only plain paths are accepted, under:

| Root | What it is |
|---|---|
| `input.…` | The run's input (the webhook or chat payload, or the manual run's input). |
| `output.…` | The run's final output. |
| `customData.…` | Custom data the run recorded. |
| `session_id` | The run's session id. It also links the agent memory and artifacts kept for that session. |
| `triggeredBy` | Who started the run (a user's email, an API key or a trigger name). |

Expressions, other roots and node results are refused when the workflow is saved. **Check on recent runs** shows how
each path resolves on the workflow's latest ten runs, with the values masked (first and last character).

When a run finishes, each path that resolves to a text or number is normalised (trimmed, lower case, Unicode width
folded, a phone number reduced to its digits) and stored as an HMAC-SHA-256 hash with a key that only this deployment
holds. The key is generated on first use and stored sealed with `SECRET_MASTER_KEY_BASE64`. Writing the references
never fails a run: an error is logged (without the value) and the run goes on.

Two things to know when choosing paths:

- **Normalising merges values that differ only by case or by phone punctuation.** `CUST-7` and `cust-7` are one
  person to a reference, and so are `415.555.0123` and `(415) 555-0123`. Pick an identifier for which that holds,
  such as an email or a long random customer id, not a short case-sensitive code.
- **A `session_id` reference names the memory session.** The run's own reference is a hash, but the reference to its
  agent memory stores the memory session's namespace and session id, as the memory table itself does. When the
  session id is the person's email or phone number, that value is stored next to the hash. Deleting the session's
  memory removes the reference on the next sweep.

References are part of the workflow's settings (`settings.dataProtection.subjectRefs`), exported and imported with it.
A reference whose run is deleted (by retention or by hand) is removed by a background sweep.

## Making a request

Open **Settings → Data protection → Data-subject requests**, enter the value, choose who the person is, and start the
export. Admins can do this, and so can users given a deployment-wide custom role (one with no project) that grants
`data_subject:manage`, for example a "Privacy" role. The permission does nothing in a project role, and only an admin
can assign a role that grants it.

- **Someone whose data flows through runs** (end user): an email, customer id, phone number or other identifier.
- **A staff member**: an L2M user's email, in any case. The export adds their account, SSO identities, project roles, API key
  metadata (never the key), the runs they started, the workflows they created, the approvals they asked for or decided,
  their eval runs and releases, and their own audit log entries. Password hashes and secrets are never included.

Options:

- **Also search stored data** (on by default): besides following references, read every stored row of the kinds below
  for the value. Slower, but it finds runs of workflows that have no references.
- **Replace reversible tokens with their original values**: the person's own values that content rules replaced with
  reversible tokens are shown as they were. Tokens of anyone else's values stay as tokens and are counted in the
  manifest (`tokensKeptForOthers`). Needs a recent MFA check when step-up is on.

The search uses the same strict matching as the [data-subject lookup](../product/production-capture.md#data-subject-lookup):
whole values only, and a phone number without a country code on either side is only a **possible match**. Possible
matches are left out of the export and counted in its manifest (`possibleMatchesLeftOut`).

### What is searched

| Kind | Found by reference | Found by search |
|---|---|---|
| Runs (input, output, node results, custom data, error) | yes | yes |
| Paused runs | | yes |
| Approval requests | | yes |
| Agent memory sessions and artifacts | yes (`session_id`) | yes |
| MCP cassettes | | yes |
| Golden and captured runs, golden-set cases, eval and replay results | | yes |

**Not covered** (the manifest lists these too): logs, metrics, traces and log-streaming destinations; the audit log (a
staff export lists the person's own entries); tool-call telemetry and rule events (they hold summaries and masked
evidence only); usage and cost events; knowledge bases; backups already written; model providers and MCP servers.

### How it runs

The lookup runs in the background on the leader, 50 rows at a time, and survives restarts: it resumes where it
stopped. While it runs the value is kept sealed with the master key; it is erased as soon as the export is ready or
the request fails. The page shows the progress and refreshes itself.

- **Limits.** A request collects at most 5 000 rows, and an export holds at most `SUBJECT_EXPORT_MAX_BYTES` of rows
  (200 MB by default, before compression). One that finds more says so (`truncated`, with `truncatedBy: "rows"` or
  `"bytes"`) and holds the first ones.
- **Errors.** A passing error (a lost database connection) is retried on the next pass; a request fails after three
  errors in a row, or when its export could not be built in three attempts (for example when building it stopped the
  server), so a request can never keep a server restarting.
- **Several instances.** Only the instance holding the request lease works on requests, and it renews the lease as it
  goes. An instance that lost the lease cannot finish a request another one already finished: the export is stored
  in the same step as the switch to ready, and only while the request is still searching.

## The export

A zip with:

- `manifest.json`: the request id, when it was made and generated, what was searched, the counts per kind, how many
  rows were found by reference, possible matches left out, whether tokens were revealed, and the not-covered list;
- one JSON Lines file per kind found (`run.jsonl`, `approval.jsonl`, `memory_session.jsonl`, …), one row per line
  with its id, how it was found (`reference` or `search`) and its fields;
- `staff.json` for a staff request.

The export is stored sealed and **downloads once**: the first download removes it, a second one is refused (409). An
export that is not downloaded expires after `SUBJECT_EXPORT_TTL_HOURS` (72 hours by default) and the request shows as
**Expired**. Downloading needs a recent MFA check when step-up is on (see [Auth and RBAC](./auth-rbac.md)); a service
account's API key is not asked, as with every other step-up action.

The download is spent when it starts: if the file cannot be opened (the master key changed without `db:import
--source-master-key`) or the connection drops while it is sent, make a new request. The SHA-256 of the zip is in the
`data_subject.export_ready` audit row, so you can check the file you received.

**Review the export before you pass it on.** A matched run, approval or memory session is exported whole, and it may
name other people too (a support conversation about a second customer, a batch run).

## Due dates and notices

Each request is due `SUBJECT_REQUEST_DUE_DAYS` after it was made (30 days by default). Once a request is past its due
date and not downloaded, L2M sends one `data.subject_request_due` notification (Settings → Notifications → **Data-subject
request overdue**; channels set in the environment receive it by default) and writes `data_subject.request_overdue` to
the audit log. The notice names the request, never the person.

## Audit

| Event | When |
|---|---|
| `data_subject.request_created` | A request was made (kind and options). |
| `data_subject.export_ready` | The export is ready (counts, size, its SHA-256, tokens revealed and kept). |
| `data_subject.request_failed` | The lookup failed. |
| `data_subject.export_downloaded` | A download, or a refused one (`failure`, with the reason). |
| `data_subject.request_overdue` | The request passed its due date. |

All are in the `data_protection` audit category. The person's value never appears in the audit log, in logs, in API
answers or in error messages.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `SUBJECT_REQUEST_DUE_DAYS` | 30 | Days until a request is due (1 to 365). |
| `SUBJECT_EXPORT_TTL_HOURS` | 72 | Hours an export can be downloaded (1 to 720). |
| `SUBJECT_EXPORT_MAX_BYTES` | 209715200 | Most bytes of rows in one export, before compression (1 MB to 512 MB). |

## API

Admins and `data_subject:manage` only, except the preview (builders with write access to the workflow).

```http
POST /api/data-protection/requests
{ "type": "export", "subjectKind": "end_user", "value": "jane.doe@example.com", "scan": true, "revealTokens": false }

GET  /api/data-protection/requests
GET  /api/data-protection/requests/:id
GET  /api/data-protection/requests/:id/export        # application/zip, once

POST /api/data-protection/subject-refs/preview
{ "workflowId": "wf_…", "subjectRefs": ["{{input.customerId}}"] }
```

## Backups

The reference key and a running request's sealed value are in backups and are re-sealed by `db:import
--source-master-key`, so references keep matching after a restore with a new master key. Exports are never in
backups: a request that was ready when the backup was taken shows as **Expired** after a restore.

Background: [Retention, legal holds and data-subject requests](../blog/retention-legal-holds-and-subject-requests) (blog).
