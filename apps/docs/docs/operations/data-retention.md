---
description: "How long L2M keeps run history, tool calls, rule events, agent memory, usage and gateway data, which settings control it, and how purges run on one instance or a cluster."
---

# Data retention

L2M deletes old data by age on a schedule. Each kind of data has its own setting. Every setting is optional: with none
set, an instance deletes exactly what it deleted before 13.3, and nothing more. One setting that did nothing before is
applied now, and older `.env` files set it: see [Upgrading: usage retention](#upgrading-usage-retention) first.

Admins see the values in effect, what is due now and the latest purges under **Settings > Access control > Data
protection** (read-only), or from `GET /api/admin/retention`.

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
  memory, usage or gateway requests does not hold them up. Eval runs, captured runs and rule simulations are still
  purged without a row cap, as before 13.3, so on SQLite a very large first purge of those can still pause requests
  while it runs. On Postgres a batch never waits for a row lock: rows another transaction holds (a workflow delete
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

## Other settings

| Setting | Default | Meaning |
|---|---|---|
| `RETENTION_MAX_ROWS_PER_TICK` | 50 000 | Rows one purge deletes at most per table (1000 to 10 000 000). |
| `RETENTION_MIN_DAYS` | 1 | The shortest retention a project may set, once per-project retention is available. |
| `RETENTION_MAX_DAYS` | unset | The longest retention a project may set; unset means no limit. Startup fails if it is below `RETENTION_MIN_DAYS`. |

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
at: a background sweep deletes references whose run or memory session is gone. Data-subject exports expire after
`SUBJECT_EXPORT_TTL_HOURS`.

## Backups

Retention does not reach backups already taken. Rotate backups within the retention you promise; see
[Backup and recovery](./backup-and-recovery.md). The purge log is not exported in backups.
