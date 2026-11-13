---
title: "Data retention: how long L2M keeps run data"
description: "How long L2M keeps run history, tool calls, rule events, agent memory, usage and gateway data, which settings control it, and how purges run on a cluster."
---

# Data retention

L2M deletes old data by age on a schedule. Each kind of data has its own setting. Every setting is optional: with none
set, an instance deletes exactly what it deleted before 13.3, and nothing more. One setting that did nothing before is
applied now, and older `.env` files set it: see [Upgrading: usage retention](#upgrading-usage-retention) first.

Concepts: [AI data retention, erasure requests and legal holds](/learn/operations/ai-data-retention-and-erasure).

Admins see the values in effect, what is due now and the latest purges under **Settings > Access control > Data
protection** (read-only), or from `GET /api/admin/retention`. A project can keep some kinds of data for a different
time than the deployment: see [Per-project retention](#per-project-retention).

Nothing under a [legal hold](./legal-hold.md) is purged, whatever its age. Held rows wait for the first purge after
the hold is released.

## What each setting deletes

`0` means "keep forever" wherever a setting accepts it.

| Data | Setting | Default | What is deleted |
|---|---|---|---|
| Runs | `EXECUTION_HISTORY_RETENTION_DAYS` | 30 | Run history (inputs, outputs, traces) by start time. |
| Tool calls | `EXECUTION_HISTORY_RETENTION_DAYS` | 30 | MCP tool-call telemetry (argument summaries, errors) by start time. |
| Rule events | `EXECUTION_HISTORY_RETENTION_DAYS` | 30 | Content rules events with their masked evidence. |
| Cassettes and approvals | `EXECUTION_HISTORY_RETENTION_DAYS` | 30 | Recorded MCP cassettes, decided approval requests and gateway approval requests. Pending approvals stay with their paused run. |
| Queue | `EXECUTION_HISTORY_RETENTION_DAYS` | 30 | Finished (completed or dead) queue jobs and dead-letter entries. Pending and running jobs stay. |
| Agent memory | `AGENT_MEMORY_RETENTION_DAYS` | keep | Simple Memory sessions and agent artifacts by last update, and session tool-cache entries by creation. |
| Usage | `USAGE_EVENTS_RETENTION_DAYS` | keep (`0`) | Usage and cost events. Budgets and FinOps totals count only the rows that are left. At least 31 when set. |
| AI gateway requests | `AI_GATEWAY_REQUEST_RETENTION_DAYS` | keep | Metadata of `/v1` requests (never prompts or answers). |
| Eval runs | `EVAL_RUN_RETENTION_DAYS` | 90 | Finished eval runs and replay jobs with their results. The newest run of every set stays. |
| Captured runs | `REPLAY_CAPTURE_RETENTION_DAYS` | 14 | Captured production runs nobody promoted. |
| Rule simulations | fixed | 30 | Content rules simulations and their replay jobs. |
| Audit log | `AUDIT_LOG_RETENTION_DAYS` | 365 | Audit entries, cached run manifests whose run is gone, and ended sign-in sessions. |
| Log stream deliveries | `LOG_STREAM_EVENT_RETENTION_DAYS` | 14 | The delivery history of log streams (not what the destinations keep). |
| Workflow versions | `WORKFLOW_VERSION_RETENTION` | 100 | A count, not an age: saved versions kept per workflow. |

Never deleted by age:

- golden runs and golden-set cases (they are deliberate copies; delete them yourself or with a data-subject delete);
- paused runs and pending approvals;
- the eval runs that back a workflow's current or previous published version (the replay runs named by its two latest
  releases and by the release it publishes now), whatever `EVAL_RUN_RETENTION_DAYS` says. Older releases keep their
  record; only their evidence run can go;
- the content rules token vault, knowledge-base content, releases and budgets.

### Upgrading: usage retention

Before 13.3, `USAGE_EVENTS_RETENTION_DAYS` was documented with a default of 365 but never applied: usage rows were
kept forever. It is applied now. Its default is `0` (keep), but **an explicit value is honoured as set**.

**Check your `.env` before upgrading.** Until 13.3, `.env.example` had the line `USAGE_EVENTS_RETENTION_DAYS=365`
uncommented, so an `.env` copied from it, as the quickstart and the production compose file suggest, sets it. After
the upgrade, the first purge then deletes usage events older than 365 days, and FinOps totals, chargeback reports and
budget history for those days go with them. To keep usage history, remove the line or set it to `0`. To keep a year,
leave it; export what you need first.

When the setting is above 0, the API logs a warning at start-up naming it and the date before which usage rows are
deleted. Values from 1 to 30 refuse to start: budgets sum up to a month of usage, so shorter retention would
under-count monthly budgets. There is no upper limit.

## How purges run

- **When.** At start-up, every `EXECUTION_HISTORY_PRUNE_INTERVAL_MS` (1 hour by default), and after finished runs, at
  most once a minute per instance.
- **Who.** Only the leader. With `HA_ENABLED=false` every instance is its own leader, as before. A purge also holds
  the `retention` lease (in `leader_leases`), so two instances never purge at the same time, whatever their HA
  settings.
- **How much.** Each purge deletes at most `RETENTION_MAX_ROWS_PER_TICK` rows per table (default 50 000), in batches
  of 1000. Whatever is left goes on the next purge. On SQLite the purge yields to other requests between batches and
  between classes, so a large first purge of runs, tool calls, rule events, cassettes, approvals, queue rows, agent
  memory, usage or gateway requests does not hold them up. Eval runs, captured runs and rule simulations are deleted in
  batches too, yielding between them on SQLite, but still without a row cap per purge. On Postgres a batch never waits for a row lock: rows another transaction holds (a workflow delete
  under way, an approval being decided) are skipped and go on a later purge.
- **Records.** Each start-up and scheduled purge is recorded with its counts per class (never row contents) for 90
  days, and, when it deleted rows, writes one `retention.purged` audit entry with the counts. Purges after finished
  runs are not recorded on their own: what they deleted is added to the next scheduled purge's record and audit entry.
  Every purge adds what it deleted to the `ao_retention_deleted_total{class}` metric at once. A failing class is
  logged and recorded; the other classes still run.

Shortening a retention on a large install deletes the backlog over several purges. The admin page shows how many rows
are due per class (counted up to 10 000).

The audit log and log-stream delivery prunes keep their own timers (`AUDIT_LOG_PRUNE_INTERVAL_MS`,
`LOG_STREAM_EVENT_PRUNE_INTERVAL_MS`) and also run on the leader only.

## Per-project retention

A project can set its own number of days for four kinds of data, shorter or longer than the deployment. A kind without
a value of its own uses the deployment's setting, so a project that sets nothing behaves exactly as before.

| Kind | Covers | Deployment setting it replaces |
|---|---|---|
| Runs | Run history, with its cassettes, decided approvals and finished queue jobs | `EXECUTION_HISTORY_RETENTION_DAYS` |
| Tool calls | MCP tool-call telemetry | `EXECUTION_HISTORY_RETENTION_DAYS` |
| Rule events | Content rules events | `EXECUTION_HISTORY_RETENTION_DAYS` |
| Agent memory | Simple Memory sessions, agent artifacts, the session tool cache | `AGENT_MEMORY_RETENTION_DAYS` |

Set the values under **Settings > Workspace > Data retention**, or with `PUT /api/projects/:id/retention`. Admins and
the project's admins (`project:manage`) can change them; every member can read them. With step-up on
(`STEP_UP_MAX_AGE_MINUTES`), a change needs a fresh MFA check. Each change writes a `project.retention.update` audit
entry with the values before and after.

**Tool calls and rule events need an admin to shorten.** They are the security evidence about what a project's tools
were called with and what content rules caught. Only an admin can keep them for less time than the deployment's value
(when the deployment keeps them forever, any number of days is shorter). A project admin can raise them, set them back
to the deployment default, and set runs and agent memory shorter or longer within the bounds. A project admin's attempt
to shorten tool calls or rule events answers `403 retention_admin_required` and writes a
`project.retention.update_denied` audit entry.

- **Bounds.** A value must lie between `RETENTION_MIN_DAYS` and `RETENTION_MAX_DAYS`. `0` keeps that kind forever and
  is allowed only when `RETENTION_MAX_DAYS` is unset. If the bounds change later, a stored value outside them is
  treated as the nearest bound (keep forever becomes the maximum), and the project page says so.
- **Kinds can differ.** Rule events or tool calls may be kept longer than runs, for example a year of rule events for
  an audit while runs go after 30 days. They then outlive the run they came from: the Security page shows "Run no
  longer stored" in place of the run link.
- **Which project a row belongs to.**
  - Runs, queue jobs, cassettes and decided approvals follow their workflow's project now, so a workflow moved to
    another project takes all of them to the new project's values. A cassette or approval whose workflow is gone
    keeps the project it was recorded in.
  - Tool calls, rule events and gateway approvals keep the project they were recorded in.
  - Agent memory belongs to the project in its session key. Memory written before sessions were scoped per project
    belongs to a project only when its key is exactly one of that project's workflows' default namespaces
    (`<workflowId>:<nodeId>`) and no other project's workflow claims the same key.
  - Rows of no project follow the deployment. These include gateway calls outside any toolset project, older memory
    under any other key, and tool calls recorded before they carried a project.
- **How a purge applies it.** For each kind, a purge takes each project with its own value at that project's cutoff,
  then every other row at the deployment's. The row cap is per table: each of those passes first gets an equal share,
  and what one leaves unused goes to the others, so one project's backlog never stops the rest. Shortening a project
  from a year to a week deletes its backlog over several purges; the admin page's "Due now" counts it.
- **Timing.** A purge reads the values when it starts. A value raised while a purge runs applies from the next purge.

The exemptions are the same as for the deployment: golden runs and cases, paused runs, pending approvals and release
evidence are never deleted by age. Admins see the projects with values of their own on the Data protection page.

## Other settings

| Setting | Default | Meaning |
|---|---|---|
| `RETENTION_MAX_ROWS_PER_TICK` | 50 000 | Rows one purge deletes at most per table (1000 to 10 000 000). |
| `RETENTION_MIN_DAYS` | 1 | The shortest retention a project may set ([per-project retention](#per-project-retention)). |
| `RETENTION_MAX_DAYS` | unset | The longest retention a project may set; unset means no limit, and a project may then also keep data forever. Startup fails if it is below `RETENTION_MIN_DAYS`. |

## Disk space after a large purge

Deleting rows does not shrink the database file at once. On SQLite the freed pages are reused for new rows; to give
the space back to the file system, stop the API and run `VACUUM` on the database file (it needs free space about the
size of the database while it runs). On Postgres, autovacuum makes the space reusable; after a very large first purge,
run `VACUUM (ANALYZE)` on the purged tables so the planner sees the new sizes. Only `VACUUM FULL` returns space to the
operating system, and it locks the table while it runs.

## Upgrading a large Postgres install

The 13.3 migration adds indexes for purging by age, among them one on `execution_history(workflow_id, started_at)`.
On a large table `CREATE INDEX` can take minutes and blocks writes to the table meanwhile. To avoid that, build the
indexes before upgrading; the migration then skips them:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_execution_history_workflow_started ON execution_history(workflow_id, started_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mcp_tool_calls_project_started ON mcp_tool_calls(project_id, started_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_guard_events_project_created ON guard_events(project_id, created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_session_memory_updated ON session_memory(updated_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_session_artifacts_updated ON session_artifacts(updated_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_session_tool_cache_created ON session_tool_cache(created_at);
```

## Subject references

Subject references ([data-subject requests](../security/data-subject-requests.md)) are removed with the runs they point
at: a background sweep deletes references whose run or memory session is gone (up to 5 000 every ten minutes). Data-subject exports expire after
`SUBJECT_EXPORT_TTL_HOURS`.

## Backups

Retention does not reach backups already taken. Rotate backups within the retention you promise; see
[Backup and recovery](./backup-and-recovery.md). The purge log is not exported in backups.

Background: [Retention, legal holds and data-subject requests](../blog/retention-legal-holds-and-subject-requests) (blog).
