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
| `unverifiable` | Entries written by an older release whose stored text cannot be checked exactly, with their position in the chain and the reason. `ok` is `false` while there are any; compare those rows with a backup or an export. |

A broken link means a row was deleted, inserted, reordered or changed after it was written. Restore from a backup or
compare with an exported copy to find what changed. The portable backup (`db:export`) records the chain's verdict, and
`db:import` refuses a restore whose chain does not match it (see [Backup and recovery](../operations/backup-and-recovery.md)).

The check covers what is in the database. Someone who can write to the database could rebuild the whole chain after
an edit, so keep a copy outside it as well: an export destination or a log stream (below).

**Retention and the chain.** Entries older than `AUDIT_LOG_RETENTION_DAYS` are deleted. The first entry left after a
purge still points at the deleted entry before it, and the check reports the chain as broken at that entry. Keep the
exported copy as the long-term record, or set `AUDIT_LOG_RETENTION_DAYS=0` to keep every entry.

## Shipping the log out

Two independent ways send entries outside the database. Both are admin-only, and changing them needs a recent MFA check
when step-up is on (see [Step-up for security actions](./auth-rbac.md#step-up-for-security-actions)).

### Export destinations (batches of NDJSON)

An export destination receives the audit entries in order, in batches, as NDJSON (one JSON object per line, with each
entry's `entryHash`). It keeps a cursor, so every entry is sent once, and a failed batch is sent again on the next
try.

| Kind | Config | Delivery |
|---|---|---|
| `http` | `url`, optional `headers` (for example an ingestion token) and `method` (default `POST`) | The batch as the request body, `content-type: application/x-ndjson`. Any answer other than 2xx is a failure. |
| `file` | `path` | Appends the batch to the file, which must be under `AUDIT_EXPORT_FILE_ROOT`. Point a log shipper at it. |

Create them under **Settings → Audit Log → Export destinations**, or with the API:

```bash
curl -s -X POST http://localhost:4000/api/audit-export/destinations \
  -H "content-type: application/json" --cookie "ao_session=..." \
  -d '{ "name": "SIEM", "kind": "http", "config": { "url": "https://siem.example.com/ingest", "headers": { "Authorization": "Bearer ..." } }, "intervalSeconds": 300 }'
```

- **Scheduled runs** need `AUDIT_EXPORT_ENABLED=true`. Every `AUDIT_EXPORT_CHECK_INTERVAL_MS` (60 s) L2M runs each
  enabled destination whose `intervalSeconds` (default 3600) has passed since its last successful batch. In a cluster
  only the leader runs them, and a destination is never exported by two instances at once.
- **One batch per run.** A run sends at most `AUDIT_EXPORT_BATCH_SIZE` entries (500). If the deployment writes more
  entries per interval than that, the destination falls behind: shorten `intervalSeconds` or raise the batch size.
- **Run now** (`POST /api/audit-export/destinations/:id/run`) sends the next batch at once, with or without
  `AUDIT_EXPORT_ENABLED`; `409` while another instance is exporting it. `GET /api/audit-export/destinations/:id/runs`
  lists the latest runs with their status, row count and error.
- **Header values** are stored with the destination as you enter them, not in the secret store, and are shown to admins
  who list destinations. Use a token that can only write logs, and rotate it if the database or a backup leaks.

Destination changes are audited as `audit_export.destination.created`, `.updated` and `.deleted`.

### Log streams (each event as it happens)

A log stream sends each audit event soon after it is written, to `syslog` (RFC 5424 over UDP or TCP), a `webhook`
(JSON, optionally signed: `sha256=<hex HMAC-SHA256 of the body>` in `x-ao-signature` or a header you name) or `sentry`. A stream can be
limited to some categories and to a minimum level: failures are `error`, denials `warn`, everything else `info`.

Create them under **Settings → Log Streams** or with `POST /api/log-streams`; **Test** sends one event, and the
delivery history of the last `LOG_STREAM_EVENT_RETENTION_DAYS` (14) is listed per stream. The webhook's HMAC secret and
the Sentry DSN are stored encrypted with the master key and shown masked.

Log streams are a live feed, not a guaranteed copy: events wait in memory (at most `LOG_STREAM_BUFFER_SIZE`, the
oldest dropped first), are tried `LOG_STREAM_RETRY_MAX_ATTEMPTS` times, and are lost if the process stops before they
are sent. Use an export destination when every entry must arrive. Log streams still receive events when
`AUDIT_LOG_ENABLED=false`.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `AUDIT_LOG_ENABLED` | `true` | `false` stops writing entries (break-glass sign-ins are still written; see [Break-glass sign-in](./auth-rbac.md#break-glass-sign-in)). |
| `AUDIT_LOG_RETENTION_DAYS` | `365` | Entries older than this are deleted; `0` keeps them. Also the retention of ended sign-in sessions. |
| `AUDIT_LOG_PRUNE_INTERVAL_MS` | `3600000` | How often old entries are deleted (on the leader). |
| `AUDIT_EXPORT_ENABLED` | `false` | Run export destinations on their schedule. |
| `AUDIT_EXPORT_CHECK_INTERVAL_MS` | `60000` | How often destinations are checked. |
| `AUDIT_EXPORT_BATCH_SIZE` | `500` | Most entries one run sends. |
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
