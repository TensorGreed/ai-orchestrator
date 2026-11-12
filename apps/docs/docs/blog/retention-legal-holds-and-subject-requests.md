---
title: "Retention, legal holds and data-subject requests"
description: "What L2M now keeps and for how long, how per-project retention purges run, how holds block deletes, and how an admin answers a data-subject request."
date: 2026-11-12
author: "The L2M team"
socialCard: true
---

# Retention, legal holds and data-subject requests

An agent platform stores more personal data than it seems to. Every run keeps the user's message, the arguments of each tool call, the tool results and the answer; agent memory keeps whole conversations. Between 10 and 11 November 2026 we merged four pieces of work that make that data manageable on a self-hosted L2M: a retention service, retention per project, legal holds, and data-subject requests with a one-time export. All four are optional. A deployment that sets none of them keeps what it kept before.

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

The retention service ([PR #174](https://github.com/TensorGreed/ai-orchestrator/pull/174), merged 10 November) reworked how L2M deletes old data by age: one scheduled purge, a setting per kind of data, and a record of what each purge removed. Run history, tool calls, rule events, cassettes, decided approvals and finished queue jobs follow `EXECUTION_HISTORY_RETENTION_DAYS` (30 days by default). Agent memory has its own setting, `AGENT_MEMORY_RETENTION_DAYS`, and is kept until you set it. Captured production runs go after 14 days unless someone promoted them, eval runs after 90, the audit log after 365.

Some things are never deleted by age: golden runs and golden-set cases (they are deliberate copies), paused runs with their pending approvals, and the eval runs that prove a workflow's current or previous release.

How purges run matters as much as what they delete:

- **One purger.** Only the leader purges, and it holds a `retention` lease, so two instances in a cluster never purge at once.
- **Batches.** A purge deletes at most 50,000 rows per table by default, in batches of 1,000. A large backlog goes over several purges instead of locking the database. On Postgres, rows another transaction holds are skipped and picked up later.
- **A record.** Each scheduled purge is recorded with its counts per kind, never row contents, and writes a `retention.purged` audit entry when it deleted something.

One upgrade note: `USAGE_EVENTS_RETENTION_DAYS` used to be documented but never applied. It is applied now, and an `.env` copied from an older example file may set it to 365. Check yours before upgrading if you want to keep usage history.

## Per-project retention

Teams have different obligations. With per-project retention ([PR #176](https://github.com/TensorGreed/ai-orchestrator/pull/176), 10 November), a project can keep runs, tool calls, rule events and agent memory for a different number of days than the deployment. A kind with no value of its own follows the deployment.

Tool calls and rule events are the security evidence of what a project's tools were called with and what the content rules caught, so only an admin can shorten them below the deployment's value. A project admin who tries gets `403 retention_admin_required`, and the attempt is audited. Deployment bounds (`RETENTION_MIN_DAYS`, `RETENTION_MAX_DAYS`) keep every project's values within limits you set.

## Legal holds

Retention deletes; sometimes you must not. A legal hold ([PR #177](https://github.com/TensorGreed/ai-orchestrator/pull/177), 11 November) keeps a project, a workflow, a list of runs, or the rows found for one person's identifier from deletion until the hold is released:

- retention purges leave held rows out, and the first purge after the release deletes them;
- deleting a held workflow, project, golden set or golden run is refused with `409 legal_hold`, and a held workflow cannot be moved to another project;
- an agent's stored memory under a hold only grows; nothing is trimmed.

A hold never changes who may read the data. Placing and releasing a hold are audited, need a fresh MFA check when step-up is on, and a release needs a signed-in person and a reason. A released hold stays listed, so the record is complete.

GDPR Article 17 gives people a right to erasure, and Article 17(3)(e) says it does not apply where processing is necessary "for the establishment, exercise or defence of legal claims". That is the tension a hold resolves: a held row is skipped by a data-subject delete with the reason `held`, and the rest goes ahead.

## Subject references and data-subject requests

When someone asks what you hold about them, GDPR Article 15 gives them a right to a copy, and Article 12(3) asks for an answer "within one month of receipt of the request". [PR #178](https://github.com/TensorGreed/ai-orchestrator/pull/178) (11 November) adds the two parts that make that answer practical.

**Subject references** are optional, per workflow. A builder names up to three paths that identify the person a run is about, such as `input.customerId` or the run's `session_id`. When a run finishes, each value is normalised and stored as an HMAC-SHA-256 hash under a key only the deployment holds, so a request later finds those runs, and the agent memory of their session, without searching every row.

**Data-subject requests** are made by an admin, or by someone given a deployment-wide role with `data_subject:manage`. L2M follows the references and, unless turned off, also searches stored runs, approvals, agent memory, cassettes and evaluation data for the value. It runs in the background on the leader and survives restarts. The result is a zip with a manifest and one JSON Lines file per kind of data found. The export is stored sealed, **downloads once**, and expires after 72 hours by default. Each request is due after 30 days by default, and an overdue request sends one notice and an audit entry.

Some details we cared about:

- **Strict matching.** Whole values only. A phone number without a country code is only a *possible match*, left out of the export and counted in the manifest.
- **The value never lands in a log.** Not in the audit log, logs, API answers or error messages. While the lookup runs, it is kept sealed with the master key and erased when the export is ready.
- **Honest coverage.** The manifest lists what was not searched: logs and metrics, the audit log, tool-call telemetry and rule events (they hold summaries and masked evidence only), usage rows, knowledge bases, backups, and anything sent to model providers or MCP servers.
- **Staff requests.** For an L2M user, the export also includes their account, SSO identities, roles, API key metadata (never the key), and their own audit entries.

## Deleting a person's data today

A data-subject request exports; it does not delete. What L2M can delete for one person today is narrower: the [data-subject lookup](/product/production-capture#data-subject-lookup) finds a value in golden runs, captured runs, golden-set cases and the evaluation results and replay runs made from them, and an admin deletes the matches they choose, each checked again before it goes. Production run history and agent memory are not deleted per person; they leave with retention.

## Backups

Retention, holds and deletes do not reach backups already taken. Rotate backups within the retention you promise, and take a backup when you place a hold: a hold cannot protect data from someone with database access. See [Backup and recovery](/operations/backup-and-recovery).

## What it does not do

- There is no erasure request: a data-subject request exports, and per-person deletion covers only golden and captured runs and the evaluation data made from them.
- It does not search logs, metrics, the audit log, tool-call telemetry, rule events, usage rows, knowledge bases or backups.
- Holds stop deletion inside L2M only. They do not stop a database administrator, and they do not stop retention in the systems your logs and backups go to.
- It does not decide your policy. How long to keep data, and when a request may be refused, are questions for your legal team. This post is not legal advice.

## Read more

- [Data retention](/operations/data-retention), [Legal holds](/operations/legal-hold), [Data-subject requests](/security/data-subject-requests), [Production capture: data-subject lookup](/product/production-capture#data-subject-lookup)
- [GDPR Article 17: right to erasure](https://gdpr-info.eu/art-17-gdpr/) and [Article 15: right of access](https://gdpr-info.eu/art-15-gdpr/) (gdpr-info.eu, reproducing Regulation (EU) 2016/679)
- [CHANGELOG](https://github.com/TensorGreed/ai-orchestrator/blob/main/CHANGELOG.md) (GitHub)
