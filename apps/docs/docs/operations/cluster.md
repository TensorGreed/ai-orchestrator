# Cluster operations

Several API instances can share one Postgres database ([Running more than one instance](./postgres.md#running-more-than-one-instance)). This page covers how they signal each other, how to see the cluster, and what to check when something looks wrong. Nothing here needs configuring: one instance (SQLite, or Postgres with `HA_ENABLED=false`) behaves exactly as before.

**Cluster mode** means `DB_TYPE=postgres` and `HA_ENABLED=true` on every instance. The signalling below is active only in cluster mode; the instance registry runs on every Postgres instance.

## What cluster mode adds

| When | What happens | Backstop if a message is lost |
|---|---|---|
| A run is canceled on one instance while another executes it | The canceled record is written, then a `cancel` message stops the run on the instance executing it, usually within milliseconds. The cancel answers `abortSignalled: true`. | Every instance re-reads its running runs every `CLUSTER_CANCEL_CHECK_MS` (10 s) and stops any that are canceled. |
| An eval run or replay job is canceled on another instance | The run is marked canceled, then an `eval_cancel` message stops its cases on the instance running it. | The owner re-reads its runs on each eval heartbeat (30 s). |
| A workflow is saved, published, restored or deleted, on any instance (`WORKER_MODE=all`, `worker`, `api` or `webhook`) | A `workflow_changed` message makes the leader reload its schedules and triggers at once. | The leader's periodic sync (15 s). |
| An instance stops beating (crash, lost host) | The leader marks that instance's inline runs `error: interrupted: the instance running this run stopped responding` once its heartbeat is older than `CLUSTER_INSTANCE_TIMEOUT_MS` (45 s), checked at every leader heartbeat. Runs the queue owns (any run a pending or running queue job carries, approval resumes included) are left to the queue. An instance that restarts under the same `HA_INSTANCE_ID` fails its previous process's runs as it starts. | A run whose owner row was never written falls back to the restart reconcile (runs older than the longest run timeout plus a minute). |
| The audit export runs | Only the leader runs the export timer, and every export of a destination (timer or **Export now**) holds a per-destination advisory lock, so no batch is shipped twice. **Export now** waits up to 10 s for an export in progress elsewhere, then answers `409`. The destination's cursor only moves from the value read under the lock: if the lock's connection was lost mid-delivery and another instance shipped meanwhile, the late run is refused and logged instead of moving the cursor back. | |
| Git pull or push | One at a time across instances (an advisory lock); a sync that cannot get it within 10 s answers `409` "Another instance is running a git sync". | |

### An instance that is alive but cannot heartbeat

The leader cannot tell a crashed instance from one that is alive but cut off from the database (a network partition, a saturated pool, a long pause). Both sides therefore act:

- **The instance fences itself.** Once its last recorded heartbeat is older than `CLUSTER_INSTANCE_TIMEOUT_MS` minus one heartbeat (35 s by default), it stops its own inline runs, and any it starts meanwhile, with the same `interrupted` error the leader writes, and logs "fenced itself". The fence lifts at its next recorded heartbeat.
- **The late result is refused.** A run's final write never replaces a record the leader already failed this way, so a run reported as interrupted never turns into a success later. A reconcile and a final write that race are settled by the row lock: whichever commits first wins.

Messages travel on Postgres `LISTEN/NOTIFY`. Delivery is best effort: the state a message announces is always written to the database first, and each consumer has the backstop above, so a lost message only makes the effect slower. After the listener reconnects, every instance re-reads at once (runs to stop, eval runs to stop, and on the leader all schedules and triggers).

## The bus connection

Each instance in cluster mode holds **one extra connection** for listening (`application_name = 'l2m-bus'`), next to its pool and the leader-lock connection (`l2m-leader`). Budget `DB_POSTGRESDB_POOL_SIZE + 2` connections per instance.

- **Direct or session-mode pooling only.** PgBouncer in transaction mode breaks `LISTEN` (notifications go to whichever client holds the server connection), as it breaks the leader lock. Point the API at Postgres directly, or at a session-mode pooler.
- **Reconnects.** The listener is checked by TCP keepalives and a `SELECT 1` every 10 seconds; a connection that errors, ends or does not answer is replaced with backoff (250 ms up to 10 s). Killing it (`pg_terminate_backend`) is safe.
- **Notifications are sent outside transactions** (`SELECT pg_notify(...)` in autocommit), so they never take Postgres's commit-time notify lock.
- **Payloads** stay under 7,000 bytes; larger run events are sent as references and read from the database.
- **Statement logging.** With `log_statement = 'all'` Postgres logs `pg_notify` payloads. Messages carry run and workflow ids and cancel reasons, never secrets.
- Channels are scoped by schema (`l2m_ctl` in `public`), so deployments that share a database but not a schema never see each other's messages.
- **Self-test.** After each connect the bus sends itself a notification through the pool; `bus.verified` in `GET /api/cluster` is `false` (with a warning in the log) when it never arrives, which usually means a transaction-mode pooler.

### Who can send on the bus

Postgres has no privilege on `NOTIFY` channels: any role that can connect to the database can send a message. **The database role is the trust boundary**: every cluster member shares it, so do not grant the application's database to untrusted roles (for a reporting user, use a replica or a separate database). Within that boundary a message never decides anything alone: every message is validated (known type, field types and lengths; anything else is ignored), a `cancel` or `eval_cancel` stops a run only when the database shows it canceled, and `workflow_changed` only makes the leader re-read the saved workflow. Cancel reasons on the bus are cut to 200 characters with control characters removed.

## The instance registry

Every instance on Postgres, HA on or off, writes a heartbeat row to `cluster_instances` every `CLUSTER_HEARTBEAT_MS` (10 s): its id (`HA_INSTANCE_ID`), worker mode, whether it leads, runs in progress, bus state, version and host. Give every instance its own `HA_INSTANCE_ID` (or leave it unset for a generated one): two live instances sharing an id would fail each other's runs at start. An instance is live while its heartbeat is younger than `CLUSTER_INSTANCE_TIMEOUT_MS` (45 s, judged on the database clock, so host clocks do not matter). A clean stop removes its row; the leader deletes rows that stopped beating an hour ago.

`GET /api/cluster` (admin) shows this instance's view: cluster mode, its id, the election, the bus (`connected`, `reconnects`, `disconnectedSince`, `verified`), every registry row with `live` and `self`, and warnings.

### Several leaders at once

With `HA_ENABLED=false` every instance that runs schedules (`WORKER_MODE=all` or `worker`) leads on its own, so two of them fire every cron and trigger twice. The registry notices this and **only reports it** (nothing changes on its own):

- an error line in the log when it starts (and once when it clears);
- `warnings` in `GET /health`: `[{ "code": "multiple_leaders", "message": "..." }]` (the field is absent when there is nothing to report; `/health` is public, so the message names no instances: see `GET /api/cluster`);
- the metric `ao_cluster_multiple_leaders` (1 or 0), next to `ao_cluster_live_instances`.

Another instance counts only once it has sent a heartbeat after this one started, so restarting a single instance without a clean stop (its old row stays live for up to the timeout) reports nothing. Fix it by setting `HA_ENABLED=true` on every instance.

## Settings

All optional.

| Setting | Default | Meaning |
|---|---|---|
| `CLUSTER_HEARTBEAT_MS` | 10000 | Registry heartbeat period (Postgres, every instance). |
| `CLUSTER_INSTANCE_TIMEOUT_MS` | 45000 | An instance without a heartbeat this long counts as stopped. With HA on, it must be at least four heartbeats (startup refuses less). |
| `CLUSTER_CANCEL_CHECK_MS` | 10000 | Cluster mode: how often an instance re-reads its running runs for a cancel it missed. `0` turns the backstop off. |

## Metrics

| Metric | Meaning |
|---|---|
| `ao_cluster_live_instances` | Live instances in the registry (Postgres). |
| `ao_cluster_multiple_leaders` | 1 when several instances lead at once. |
| `ao_cluster_bus_connected` | Cluster mode: 1 while the bus listener is connected. |

## Troubleshooting

- **A cancel answers `abortSignalled: true` but the run keeps going for a few seconds.** The instance running it missed the message (its listener was reconnecting); it stops the run at its next cancel check. Check `bus.connected` and `bus.reconnects` in `GET /api/cluster` on that instance.
- **`bus.connected` stays false.** The listener cannot reach Postgres directly: check the pooler mode and `max_connections`, and the log for "Cluster bus could not connect".
- **An instance shows `live: false`** while it is running: its heartbeats fail (see "Cluster registry heartbeat failed" in its log) or `CLUSTER_INSTANCE_TIMEOUT_MS` is too short for the load. It fences itself and the leader fails its inline runs once it is not live, so keep the timeout well above the heartbeat.
- **The API refuses to start with "never applied vN".** The database recorded a later migration before the build that adds vN ran on it, so the forward-only chain would skip vN. Apply vN's `up` SQL from `apps/api/src/db/migrations.ts` by hand (each migration is idempotent), insert vN into `schema_migrations`, and start again.
