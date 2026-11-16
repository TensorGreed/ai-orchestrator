---
title: "Audit log: who changed what, hash-chained"
description: "The L2M audit log: what it records, searching and CSV export, checking its hash chain, and shipping it to an HTTP endpoint, a file or a log stream."
---

# Audit log

L2M writes an audit entry for actions people, API keys and the system take on the deployment: sign-ins, role and
membership changes, API keys, secrets, workflow changes, runs started and cancelled, approvals, releases, legal holds,
settings changes and more. Each entry records who acted, from which address, on what, and whether it worked. Entries
are linked in a hash chain, so deleting, inserting or editing a row can be detected.

Concepts: [Audit trails for AI agents](/learn/operations/audit-trails-for-agents) explains what an audit trail should
hold and how hashes make it tamper-evident. For the record of a single run (its inputs, tool calls and outputs, signed
for offline checks), see [Audit bundles and signed run manifests](./audit-bundles.md).

The audit log is on by default and needs no setup. Only admins can read it.

## What an entry holds

| Field | Meaning |
|---|---|
| `id`, `createdAt` | The entry's id and time. |
| `category` | `auth`, `mfa`, `sso`, `api_key`, `secret`, `external_secret`, `workflow`, `execution`, `project`, `rbac`, `sharing`, `approval`, `release`, `data_protection` or `system`. |
| `eventType`, `action` | What happened, for example `user.login` / `login` or `api_key.rotate` / `rotate`. |
| `outcome` | `success`, `failure` or `denied`. |
| `actorUserId`, `actorEmail`, `actorType` | Who acted: a `user`, an `api_key` or the `system`. A call made with an API key also stores the key's id as `actorApiKeyId` in the metadata, and `actorServiceAccount: true` for a service account's key. |
| `ipAddress`, `userAgent` | Where the request came from (behind a proxy, see `TRUST_PROXY`). |
| `resourceType`, `resourceId`, `projectId` | What the action was on. |
| `metadata`, `message` | Details of the event. |

Event names are listed on the pages of the features that write them, for example [Authentication and
RBAC](./auth-rbac.md), [Service accounts and API keys](./service-accounts.md) and [Approvals](../product/approvals.md).

## Reading and searching

**Settings → Audit Log** lists the entries, newest first, with filters for category, outcome, actor user id, resource
type and time, an **Export CSV** button for the filtered entries, the chain check and the export destinations.

From the API (admin):

```bash
curl -s "http://localhost:4000/api/audit?category=auth&outcome=failure&pageSize=100" \
  --cookie "ao_session=..."
```

| Parameter | Meaning |
|---|---|
| `category`, `eventType`, `outcome` | Exact matches. |
| `actorUserId`, `resourceType`, `resourceId`, `projectId` | Exact matches. |
| `from`, `to` | ISO 8601 times; entries at or after `from` and at or before `to`. |
| `page`, `pageSize` | Paging; `pageSize` is 50 by default, at most 500. |

The answer is `{ items, total, page, pageSize }`.

`GET /api/audit/export` takes the same filters and answers a CSV file (`audit-log-<date>.csv`) with one row per entry
and the metadata as JSON in the last column. It holds at most 2000 pages of `pageSize` rows (500 by default). Each
export is itself audited as `audit.export`. Open the file as data: a spreadsheet may treat a cell that starts with
`=`, `+`, `-` or `@` as a formula.

## Checking the chain

Each entry stores the hash of the entry before it (`prev_hash`) and its own hash (`entry_hash`, SHA-256 of the
previous hash and the entry's fields), starting from 64 zeros. Both databases (SQLite and Postgres) write and check
the chain the same way.

**Settings → Audit Log → Verify chain integrity**, or `GET /api/audit-log/verify-chain` (admin), walks every entry in
the order it was written and answers:

| Field | Meaning |
|---|---|
| `ok` | `true` when every entry checked out. |
| `rowsChecked` | Entries verified. |
| `firstBrokenAt` | The first entry whose link or hash does not match: `{ id, createdAt, expected, stored }`. The walk stops there. |
| `anchor` | Present when retention deleted the oldest entries: `{ firstId, prevHash, checkpointId }`, the first entry left, the hash it points back to and the retention checkpoint that records it (below). |
| `unverifiable` | Entries written by an older release whose stored text cannot be checked exactly, with their position in the chain and the reason. `ok` is `false` while there are any; compare those rows with a backup or an export. |

A broken link means a row was deleted, inserted, reordered or changed after it was written. Restore from a backup or
compare with an exported copy to find what changed. The portable backup (`db:export`) records the chain's verdict, and
`db:import` refuses a restore whose chain does not match it (see [Backup and recovery](../operations/backup-and-recovery.md)).

The check covers what is in the database. Someone who can write to the database could rebuild the whole chain after
an edit, so keep a copy outside it as well, through an export destination (below).

**Retention and the chain.** Entries older than `AUDIT_LOG_RETENTION_DAYS` are deleted, oldest first in the order
they were written, up to the first entry inside the retention, so no gap opens in the middle of the chain. Each purge
that deletes entries appends a retention checkpoint (`audit.retention_checkpoint`, category `system`, actor `system`)
whose metadata records the hash of the last deleted entry (`anchorHash`), the first entry left (`firstRetainedId`),
the cut-off and the count. The check starts from the first entry left and passes only if the latest checkpoint names
exactly that entry and that hash and is plausible: the first entry left is not older than the cut-off, the cut-off is at
least a day before the checkpoint, and the checkpoint is not dated in the future. Editing any entry kept (the checkpoint
included) still fails. The chain is an unkeyed hash, so it shows order and content, not who wrote an entry: someone
with write access to the database could delete recent entries from the start and append a checkpoint of their own.
Compare with the exported copy or a signed audit bundle to rule that out. A chain purged by an older release, before checkpoints, reports as broken at its first entry
until the next purge that deletes entries writes one. Keep the exported copy as the long-term record, or set
`AUDIT_LOG_RETENTION_DAYS=0` to keep every entry.

## Shipping the log out

Two independent ways send entries outside the database. Both are admin-only, and changing them needs a recent MFA check
when step-up is on (see [Step-up for security actions](./auth-rbac.md#step-up-for-security-actions)).

### Export destinations (batches of NDJSON)

An export destination receives the audit entries in order, in batches, as NDJSON (one JSON object per line, with each
entry's `entryHash`). It keeps a cursor, so each entry is normally sent once, and a failed batch is sent again on the next
try. Delivery is at least once (for example, an entry can be sent again after its cursor entry was purged), so
de-duplicate on `id`.

| Kind | Config | Delivery |
|---|---|---|
| `http` | `url`, optional `headers` (for example an ingestion token) and `method` (default `POST`) | The batch as the request body, `content-type: application/x-ndjson`. Any answer other than 2xx is a failure. |
| `file` | `path` | Appends the batch to the file, which must be inside `AUDIT_EXPORT_FILE_ROOT` (checked when the destination is saved and at each delivery; a symlink that leads outside the root, or a file that is a symlink, is refused). Point a log shipper at it. |

**How a `file` destination stays inside the root.** At each delivery L2M resolves every directory on the path and
refuses one that leads outside `AUDIT_EXPORT_FILE_ROOT` through a symlink. It opens the file without following a
symlink, and refuses anything other than a regular file with a single link (a hard link could name a file outside the
root). Node.js cannot open a file relative to an already checked directory, so a process that can write inside the
root could swap a directory for a symlink between that check and the open. The opened file is therefore checked
again before anything is written:

- On Linux, the path the kernel reports for the open file (`/proc/self/fd/<fd>`) must be the checked directory plus
  the file name, so a swap is always caught.
- On other systems, or where `/proc` is not mounted, L2M resolves the directory again and checks that it has not
  changed and that the file name still names the file it opened. A swap that is undone in the short time between the
  open and this check is not caught. Keep the root writable by the API's user only.

In both cases the batch is not written and the run fails with "changed while it was opened".

L2M opens an existing file without creating anything, and creates a missing one only with an exclusive create, which
never opens a file, FIFO or device that already exists. If the check then refuses a file this delivery created, L2M
removes it again, but only when it is still an empty regular file with the same device and inode, and only when it
sits in a directory nobody else can change: every directory from it up to `/` belongs to the API's user or root and
no one else may write to it (a sticky directory such as `/tmp` is allowed). Elsewhere someone could re-point a
directory between the check and the removal and have a different file removed, so L2M leaves the empty file. What
remains:

- A swap can still lead L2M to open an existing file outside the root (never as a controlling terminal). Nothing is
  written to it, but opening a FIFO or device can have effects of its own.
- An empty file can be left where the symlink pointed: in a directory others can write to (including a group-writable
  one, as a umask of `002` creates), on Windows, or when the file was changed before it could be removed.

Create them under **Settings → Audit Log → Export destinations**, or with the API:

```bash
curl -s -X POST http://localhost:4000/api/audit-export/destinations \
  -H "content-type: application/json" --cookie "ao_session=..." \
  -d '{ "name": "SIEM", "kind": "http", "config": { "url": "https://siem.example.com/ingest", "headers": { "Authorization": "Bearer ..." } }, "intervalSeconds": 300 }'
```

- **Scheduled runs** need `AUDIT_EXPORT_ENABLED=true`. Every `AUDIT_EXPORT_CHECK_INTERVAL_MS` (60 s) L2M runs each
  enabled destination whose `intervalSeconds` (default 3600) has passed since its last successful run (a run with
  nothing to send counts, so an idle destination is checked once per interval). In a cluster only the leader runs
  them, and a destination is never exported by two instances at once.
- **A run drains the backlog.** It sends batches of at most `AUDIT_EXPORT_BATCH_SIZE` entries (500) one after another,
  in order, moving the cursor after each delivered batch, until a batch comes back short (caught up), a batch fails
  (sent again, from the same entry, at the next scheduled run), 20 batches were sent, or the run has taken
  `AUDIT_EXPORT_CHECK_INTERVAL_MS`. A destination stopped by those bounds with more to send runs again at the next
  check instead of waiting for its interval, so it catches up at up to 20 batches a minute.
- **Run now** (`POST /api/audit-export/destinations/:id/run`) runs the destination at once, with the same bounds,
  with or without `AUDIT_EXPORT_ENABLED` (its `status` is `partial` when a later batch failed after earlier ones were
  delivered); `409` while another instance is exporting it. `GET /api/audit-export/destinations/:id/runs`
  lists the latest runs with their status, row count and error.
- **Header values** are sealed with the master key (`SECRET_MASTER_KEY_BASE64`) when they are saved, and every answer
  shows them as `__secret__` (the header names stay visible). To change a destination's config with `PUT`, send the
  headers to keep as `"__secret__"` and the ones to change with their new values. Values that an older release stored
  in plain text are sealed when the API starts. `db:import --source-master-key` re-seals them like other secrets.

Destination changes are audited as `audit_export.destination.created`, `.updated` and `.deleted`. The entry records
which fields changed, the config's keys, the URL's host and the header names, never a header value or the full URL.
Releases before this one wrote the whole `PUT` body into the `.updated` entry, header values included, and an audit
entry cannot be edited without breaking the chain: if a token was ever changed with `PUT`, rotate it.

### Log streams (each event as it happens)

A log stream sends audit events soon after they are written, to `syslog` (RFC 5424 over UDP or TCP), a `webhook`
(JSON, optionally signed: `sha256=<hex HMAC-SHA256 of the body>` in `x-ao-signature` or a header you name) or `sentry`. A stream can be
limited to some categories and to a minimum level: failures are `error`, denials `warn`, everything else `info`. A
stream with no categories gets every audit event; `*` also stands for every audit category, so it can be combined with
`rule_events` (below).

Create them under **Settings → Log Streams** or with `POST /api/log-streams`; **Test** sends one event, and the
delivery history of the last `LOG_STREAM_EVENT_RETENTION_DAYS` (14) is listed per stream. A stream's config is stored
encrypted with the master key. The webhook's HMAC secret, its header values and the Sentry DSN are shown as
`__secret__`; an update that sends `__secret__` back keeps the stored value.

Log streams are a live feed, not a guaranteed copy: events wait in memory (at most `LOG_STREAM_BUFFER_SIZE`, the
oldest dropped first), are tried `LOG_STREAM_RETRY_MAX_ATTEMPTS` times, and are lost if the process stops before they
are sent. Every audit event goes to the log streams, once, whichever feature records it (MCP servers, knowledge bases,
budgets and export destinations included), and so do the retention checkpoint and run outcomes (`execution.success`,
`execution.error`, with the error redacted and cut to 2,000 characters). Use an export destination when every
entry must arrive. Log streams still receive events when `AUDIT_LOG_ENABLED=false`.

#### Rule events on log streams

A stream can also receive [content rule](../product/content-rules.md#what-gets-recorded) events: one event per stored
rule event, from workflow runs, MCP gateway calls and /v1 AI gateway requests. It is off for every stream until you
add the `rule_events` category: under **Settings → Log Streams** pick **Audit and content rule events** or **Content
rule events only** for a new stream, or use **Send content rule events** on an existing one. With the API, send
`categories: ["*", "rule_events"]` for both, or `["rule_events"]` for rule events only. Rule events of eval runs and
replay jobs are not streamed.

Events are queued like audit events and sent by the same background flush, so a slow or unreachable stream never
slows down or fails a run or a gateway call; a full buffer drops waiting rule events before audit events. Which
streams asked for rule events is read at most every 5 seconds, so a change made on another API instance can take that
long to apply there. A failed send is tried again on the next flush (each send to a webhook or Sentry gives up after
10 seconds). Delivery is at least once: use `metadata.eventId` to drop duplicates. A send that finally fails is kept
in the stream's delivery history without its evidence.

Levels: `warn` when the effective action is `block`, `require_approval` or `review` (a refused reveal counts as
`block`); `info` for any other finding (rewrites, shadow findings, reveals); `debug` for a check that found nothing, so
a stream at the default `info` level leaves clean checks out.

Every stream type carries the same event body: syslog puts it as JSON after the RFC 5424 header (`MSGID`
`content_rules.event`; `createdAt` is in the JSON as well as the header), a webhook posts it, Sentry puts `metadata`
under `extra`.

```json
{
  "category": "rule_events",
  "eventType": "content_rules.event",
  "level": "warn",
  "outcome": "denied",
  "message": "Content rule block: dlp.patterns (email) on prompt at guard",
  "actor": { "type": "system" },
  "resourceType": "execution",
  "resourceId": "exec_123",
  "projectId": "default",
  "createdAt": "2026-11-16T10:00:00.000Z",
  "metadata": {
    "schema": "l2m.rule_event",
    "schemaVersion": 1,
    "eventId": "…",
    "verdictId": "…",
    "source": "workflow",
    "ruleSet": { "id": "default", "version": 3, "hash": "…" },
    "detector": { "id": "dlp.patterns", "category": "pii", "dataClass": "email", "score": 0.9 },
    "action": { "requested": "block", "effective": "block", "verdict": "block", "shadow": false },
    "channel": "prompt",
    "placement": "node",
    "nodeId": "guard",
    "toolName": null,
    "iteration": null,
    "executionId": "exec_123",
    "workflowId": "wf_support",
    "projectId": "default",
    "latencyMs": 3,
    "budgetExceeded": false,
    "skippedDetectors": [],
    "evidence": [{ "masked": "m***@e******.org", "digest": "sha256:5d41402abc4b2a76", "spanCount": 1, "message": "Email address" }],
    "evidenceWithheld": false
  }
}
```

- `source` is `workflow`, `mcp_gateway` (`executionId` is the call's `mcpgw_*` id) or `ai_gateway` (the request's
  `aigw_*` id). `detector` is `null` for a check that found nothing.
- `evidence` is the stored evidence ([what gets recorded](../product/content-rules.md#what-gets-recorded)), at most 5
  pieces of at most 160 characters each, with a digest of each stored piece for correlation with the Security page.
  The content that was checked is never sent. Sensitive data detectors store the matched value masked; injection and
  hidden-text detectors keep a short excerpt of the matched or decoded text, so before it is sent every piece and its
  message are masked again with the built-in data patterns: emails, phone numbers, payment cards, IBANs, keys, tokens
  and credentials, built-in national ids, and URL query values. A word cut off at the end of an excerpt is dropped,
  since the patterns could not recognise it. Custom terms and patterns from a rule set are not applied here, and text
  the patterns do not recognise, such as the words of an injection attempt, is sent as it is.
- For a run started from a sensitive run's content (copied node outputs, marked pinned data, or an error workflow of a
  sensitive run), and for the part of a run after an approval when the part before it read sensitive content,
  `evidenceWithheld` is `true` and each piece carries only its `digest` and `spanCount`. A run that becomes sensitive
  work while it runs (reading marked session rows or a declared sensitive source, a Reveal node) sends masked evidence
  for its checks up to then; leave `rule_events` off a stream if that evidence must not leave the deployment.
- Fields may be added within `schemaVersion` 1; a field renamed or removed raises the version.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `AUDIT_LOG_ENABLED` | `true` | `false` stops writing entries (break-glass sign-ins are still written; see [Break-glass sign-in](./auth-rbac.md#break-glass-sign-in)). |
| `AUDIT_LOG_RETENTION_DAYS` | `365` | Entries older than this are deleted; `0` keeps them. Also the retention of ended sign-in sessions. |
| `AUDIT_LOG_PRUNE_INTERVAL_MS` | `3600000` | How often old entries are deleted (on the leader). |
| `AUDIT_EXPORT_ENABLED` | `false` | Run export destinations on their schedule. |
| `AUDIT_EXPORT_CHECK_INTERVAL_MS` | `60000` | How often destinations are checked. |
| `AUDIT_EXPORT_BATCH_SIZE` | `500` | Most entries one batch sends (a run sends up to 20 batches). |
| `AUDIT_EXPORT_FILE_ROOT` | `apps/api/data` | Directory `file` destinations must write under (relative to the API's working directory). |
| `LOG_STREAM_ENABLED` | `true` | Send events to log streams. |
| `LOG_STREAM_FLUSH_INTERVAL_MS` | `2000` | How often waiting events are sent. |
| `LOG_STREAM_BUFFER_SIZE` | `1000` | Most events waiting in memory. |
| `LOG_STREAM_RETRY_MAX_ATTEMPTS` | `3` | Tries per event and stream. |
| `LOG_STREAM_EVENT_RETENTION_DAYS` | `14` | How long the delivery history is kept; `0` keeps it. |
| `LOG_STREAM_EVENT_PRUNE_INTERVAL_MS` | `3600000` | How often old delivery history is deleted. |

## Endpoints

All admin-only.

- `GET /api/audit` (filters and paging above)
- `GET /api/audit/export` (CSV; audited as `audit.export`)
- `GET /api/audit-log/verify-chain`
- `GET /api/audit-export/destinations`, `POST /api/audit-export/destinations`, `PUT /api/audit-export/destinations/:id`,
  `DELETE /api/audit-export/destinations/:id` (changes need step-up)
- `POST /api/audit-export/destinations/:id/run`, `GET /api/audit-export/destinations/:id/runs?limit=`
- `GET /api/log-streams`, `POST /api/log-streams`, `PUT /api/log-streams/:id`, `DELETE /api/log-streams/:id` (changes
  need step-up), `POST /api/log-streams/:id/test`, `GET /api/log-streams/:id/events`

## Related

- [Audit bundles and signed run manifests](./audit-bundles.md)
- [Data retention](../operations/data-retention.md)
- [Backup and recovery](../operations/backup-and-recovery.md)
- [Authentication and RBAC](./auth-rbac.md)
