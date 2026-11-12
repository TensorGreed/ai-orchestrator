---
title: "Retention, legal holds and data-subject requests"
description: "What L2M keeps and for how long, how purges and per-project retention work, how holds block deletes, and how to export or delete one person's data."
date: 2026-11-12
author: "The L2M team"
related: [data-retention, legal-hold, data-subject-request, right-to-erasure, subject-reference]
socialCard: true
---

# Retention, legal holds and data-subject requests

An agent platform stores more personal data than it seems to. Every run keeps the user's message, the arguments of each tool call, the tool results and the answer; agent memory keeps whole conversations. Between 10 and 12 November 2026 we merged five pieces of work that make that data manageable on a self-hosted L2M: a retention service, retention per project, legal holds, data-subject requests with a one-time export, and deletion of one person's data on request. Per-project retention, holds, requests and deletion are optional. The retention service deletes what was deleted before, with one exception: read the note on usage retention below before you upgrade.

## Start with a data map

You cannot set retention for data you have not found. In L2M, personal data can end up in:

- **run history**: inputs, outputs and every node's result;
- **MCP tool-call telemetry**: summaries of each call's arguments and its errors;
- **content rules events**, with masked evidence;
- **approvals, cassettes and queue jobs** recorded with runs;
- **agent memory**: conversation sessions, agent artifacts and the session tool cache;
- **usage rows** and **/v1 gateway request metadata** (never prompts or answers);
- **evaluation data**: eval runs, golden runs, golden-set cases and captured production runs;
- **the audit log**, and the backups of all of the above.

The [data retention](/operations/data-retention) page lists each one with the setting that controls it.

## Retention: one setting per kind of data

The retention service ([PR #174](https://github.com/TensorGreed/ai-orchestrator/pull/174), merged 10 November) reworked how L2M deletes old data by age: one scheduled purge, a setting per kind of data, and a record of what each purge removed. Run history, tool calls, rule events, cassettes, decided approvals and finished queue jobs follow `EXECUTION_HISTORY_RETENTION_DAYS` (30 days by default). Agent memory and `/v1` gateway request metadata, which were never deleted before, get settings of their own (`AGENT_MEMORY_RETENTION_DAYS`, `AI_GATEWAY_REQUEST_RETENTION_DAYS`); both keep everything until you set them. Existing settings still apply: captured production runs go after 14 days unless someone promoted them, eval runs after 90, and the audit log after 365, on its own timer.

Some things are never deleted by age: golden runs and golden-set cases (they are deliberate copies), paused runs with their pending approvals, and, since per-project retention, the eval runs that prove a workflow's current or previous release.

How purges run matters as much as what they delete:

- **One purger.** Only the leader purges, and it holds a `retention` lease, so two instances in a cluster never purge at once.
- **Batches.** A purge deletes at most 50,000 rows per table by default, in batches of 1,000 (eval runs, captures and rule simulations are batched but not capped). A large backlog goes over several purges instead of locking the database. On Postgres, rows another transaction holds are skipped and picked up later.
- **A record.** Each scheduled purge is recorded with its counts per kind, never row contents, and writes a `retention.purged` audit entry when it deleted something.

One upgrade note: `USAGE_EVENTS_RETENTION_DAYS` used to be documented but never applied. It is applied now, and an `.env` copied from an older example file may set it to 365. Check yours before upgrading if you want to keep usage history.

## Per-project retention

Teams have different obligations. With per-project retention ([PR #176](https://github.com/TensorGreed/ai-orchestrator/pull/176), 10 November), a project can keep runs, tool calls, rule events and agent memory for a different number of days than the deployment. A kind with no value of its own follows the deployment.

Tool calls and rule events are the security evidence of what a project's tools were called with and what the content rules caught, so only an admin can shorten them below the deployment's value. A project admin who tries gets `403 retention_admin_required`, and the attempt is audited. Deployment bounds (`RETENTION_MIN_DAYS`, `RETENTION_MAX_DAYS`) keep every project's values within limits you set.

## Legal holds

Retention deletes; sometimes you must not. A <Term id="legal-hold">legal hold</Term> ([PR #177](https://github.com/TensorGreed/ai-orchestrator/pull/177), 11 November) keeps a project, a workflow, a list of runs, or the rows found for one person's identifier from deletion until the hold is released:

- retention purges leave held rows out, and the first purge after the release deletes those already past their retention;
- deleting a held workflow, project, golden set or golden run is refused with `409 legal_hold`, and a held workflow cannot be moved to another project;
- an agent's stored conversation under a hold only grows (session artifacts can still be replaced under their key).

A hold never changes who may read the data. Placing and releasing a hold are audited, need a fresh MFA check when step-up is on, and a release needs a signed-in person and a reason. A released hold stays listed, so the record is complete.

GDPR Article 17 gives people a right to erasure, and Article 17(3)(e) says it does not apply where processing is necessary "for the establishment, exercise or defence of legal claims". A hold is how you record that decision in L2M: a deletion request (below) leaves held rows in place and finishes as **Partly deleted: waiting for a legal hold**, and runs again for those rows when the hold is released. Whether the exemption applies is for your legal team to decide.

## Subject references and data-subject requests

When someone asks what you hold about them, GDPR Article 15 gives them a right to a copy, and Article 12(3) asks for an answer "without undue delay and in any event within one month of receipt of the request", extendable by two further months where necessary. [PR #178](https://github.com/TensorGreed/ai-orchestrator/pull/178) (11 November) adds the two parts that make that answer practical.

**Subject references** are optional, per workflow. A builder names up to three paths that identify the person a run is about, such as `input.customerId` or the run's `session_id`. When a run finishes, each value is normalised and stored as an HMAC-SHA-256 hash under a key only the deployment holds (a `session_id` reference also keeps the memory session id itself, as the memory table does), so a request later finds those runs, and the agent memory of their session, without searching every row.

**Data-subject requests** are made by an admin, or by someone given a deployment-wide role with `data_subject:manage`. L2M follows the references and, unless turned off, also searches stored runs, approvals, agent memory, cassettes and evaluation data for the value. It runs in the background on the leader and survives restarts. The result is a zip with a manifest and one JSON Lines file per kind of data found. The export is stored sealed, **downloads once**, and expires after 72 hours by default. Each request is due after `SUBJECT_REQUEST_DUE_DAYS` (30 by default), and an overdue request sends one notice and an audit entry. Thirty days can end after one calendar month, so set it to your own deadline.

How it behaves:

- **Strict matching.** Whole values only. A phone number with no country code in the search or in the data is only a *possible match*, left out of the export and counted in the manifest.
- **The value never lands in a log.** Not in the audit log, logs, API answers or error messages. While the lookup runs, it is kept sealed with the master key and erased when the export is ready, or when a deletion finishes or its preview expires (a deletion waiting for a legal hold keeps it until then).
- **Coverage.** The search reads runs, paused runs, approval requests, agent memory sessions and artifacts, cassettes, and evaluation data. The manifest names much of what it does not read: logs and metrics, the audit log, tool-call telemetry and rule events (they hold summaries and masked evidence only), usage rows, knowledge bases, backups, and anything sent to model providers or MCP servers. Queue jobs, gateway approval requests, the session tool cache and `/v1` request metadata are not searched either, and the manifest does not list them yet.
- **Staff requests.** For an L2M user, the export also includes their account, SSO identities, project roles, API key metadata (never the key), and their own audit entries.

## Deleting a person's data

A data-subject request can also delete. Choose **Delete (erasure)** instead of **Export** when you make it ([PR #187](https://github.com/TensorGreed/ai-orchestrator/pull/187), 12 November). The lookup runs as for an export, then stops at a preview of what it found. Nothing is deleted until an admin, or someone with `data_subject:manage`, presses **Confirm deletion**, which needs a fresh MFA check when step-up is on. The deletion runs in the background on the leader, and checks each row the search found again before deleting it. A run still in progress is deleted once it has finished.

- **End users.** A found run goes with its tool-call telemetry, rule events, cassettes, approval requests, queue jobs and subject references. Agent memory sessions and artifacts, and golden or captured runs with the evaluation data made from them, are deleted too. Usage rows of a deleted run stay, with the user cleared, so cost totals and budgets do not change.
- **Staff members.** The account is deleted the way **Settings → Users → Delete** does, and the person's email becomes a pseudonym (`erased-user-` and 8 hex characters) wherever it records who started, wrote or decided something. Because it deletes the account, only an admin can confirm it. A staff request does not search runs for the email, so make an end-user request too if the person's own data flows through runs. Their audit-log rows are kept unchanged until audit retention removes them, because rewriting them would break the audit chain.
- **Erasure records.** Every erased row leaves a record: the kind, the row id and when (agent memory and staff members by a keyed hash, never the value). `db:import` and `db:copy` re-apply the records after a restore, so an older backup does not bring the data back. They are kept for `ERASURE_TOMBSTONE_RETENTION_DAYS` (400 by default); keep that longer than your oldest backup.

The older [data-subject lookup](/product/production-capture#data-subject-lookup) for golden and captured runs still works and leaves the same erasure records. Without a request, production run history leaves with retention (30 days by default), and agent memory is kept until you set `AGENT_MEMORY_RETENTION_DAYS`.

## Backups

Retention, holds and deletes do not reach backups already taken. A restore with `db:import` or `db:copy` re-applies erasure records, but a file-level restore (a copied SQLite file, `pg_restore`) brings the database back exactly as it was. Rotate backups within the retention you promise, and take a backup when you place a hold: a hold cannot protect data from someone with database access. See [Backup and recovery](/operations/backup-and-recovery).

## What it does not do

- A deletion does not reach logs, metrics, traces and log-streaming destinations, knowledge bases, backups already written (until they are restored with `db:import` or `db:copy`), the model providers and MCP servers that runs sent data to, or reversible tokens that are not in the person's rows and format-preserving tokens. A staff deletion keeps the person's audit-log rows.
- It does not search logs, metrics, the audit log (a staff export lists only the person's own entries), tool-call telemetry, rule events, usage rows, queue jobs, gateway approvals, the session tool cache, `/v1` request metadata, knowledge bases or backups.
- Holds stop deletion inside L2M only. They do not stop a database administrator, and they do not stop retention in the systems your logs and backups go to.
- It does not decide your policy. How long to keep data, and when a request may be refused, are questions for your legal team. This post is not legal advice.

## Further reading

- Concepts: [Self-hosted AI agent platform: what you run and why](/learn/operations/self-hosting-ai-agents)
- [Data retention](/operations/data-retention), [Legal holds](/operations/legal-hold), [Data-subject requests](/security/data-subject-requests), [Deleting a person's data](/security/data-subject-requests#deleting-a-persons-data), [Production capture: data-subject lookup](/product/production-capture#data-subject-lookup)
- [GDPR Article 17: right to erasure](https://gdpr-info.eu/art-17-gdpr/), [Article 15: right of access](https://gdpr-info.eu/art-15-gdpr/) and [Article 12: time limits](https://gdpr-info.eu/art-12-gdpr/) (gdpr-info.eu, reproducing Regulation (EU) 2016/679)
- Pull requests: [#174 retention service](https://github.com/TensorGreed/ai-orchestrator/pull/174), [#176 per-project retention](https://github.com/TensorGreed/ai-orchestrator/pull/176), [#177 legal holds](https://github.com/TensorGreed/ai-orchestrator/pull/177), [#178 data-subject requests](https://github.com/TensorGreed/ai-orchestrator/pull/178), [#187 deletion and erasure](https://github.com/TensorGreed/ai-orchestrator/pull/187) (GitHub)
