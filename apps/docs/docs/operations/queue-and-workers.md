# Queue and workers

Workflow runs sent to `POST /api/workflows/:id/enqueue` wait in a queue in the database and are run by a worker.
**With one instance and no settings, nothing changes**: the API process is its own worker, on SQLite or Postgres, and
the defaults below are the behaviour of earlier releases.

Everything on this page beyond the defaults is opt-in. Leases, the reaper, pools and cross-instance cancel apply only
in **cluster mode**: `DB_TYPE=postgres` and `HA_ENABLED=true` (see [Postgres](./postgres#running-more-than-one-instance)).

## Roles

`WORKER_MODE` picks what an instance does:

| Mode | Accepts `/enqueue` | Runs queued jobs | Schedules, triggers, sweeps |
|---|---|---|---|
| `all` (default) | yes | yes | yes, on the leader |
| `api` | yes | no | no |
| `worker` | yes | yes | yes, on the leader |
| `webhook` | yes | no | no |

`api` and `webhook` replicas only produce jobs; any `worker` or `all` instance on the same database runs them.

## Settings

All optional. Defaults equal earlier behaviour.

| Variable | Default | What it does |
|---|---|---|
| `QUEUE_CONCURRENCY` | `5` | Jobs one worker runs at once (1-256) |
| `QUEUE_POLL_INTERVAL_MS` | `1000` | How often an idle worker looks for jobs |
| `QUEUE_MAX_PENDING` | `0` (off) | Pending jobs per pool above which `/enqueue` answers `429` with `Retry-After` |
| `QUEUE_MAX_RSS_MB` | off | A worker above this memory stops claiming until it drops |
| `QUEUE_MAX_EVENT_LOOP_LAG_MS` | off | A worker whose event loop lags more than this stops claiming |
| `QUEUE_HEARTBEAT_MS` | `10000` | Cluster mode: how often a worker renews the leases of its running jobs |
| `QUEUE_LEASE_MS` | `45000` (at least 3 heartbeats) | Cluster mode: a job whose lease is older is taken back; must be at least 2 heartbeats |
| `QUEUE_REAPER_INTERVAL_MS` | `15000` | Cluster mode: how often the leader looks for expired leases |
| `QUEUE_POOLS` | `default` | Cluster mode: the pools this worker claims from, comma-separated |
| `SHUTDOWN_DRAIN_MS` | `30000` | On SIGTERM, how long running jobs get to finish |

A bad value stops the API at startup with a message naming the variable. `QUEUE_POOLS` other than `default` outside
cluster mode is refused, since a lone worker that skips a pool would leave its jobs waiting forever.

## Claims, leases and fencing (cluster mode)

A worker claims jobs with `FOR UPDATE SKIP LOCKED`, so two workers never take one job. Each claim records the
worker (`claimed_by`), a fresh token (`claim_token`) and a heartbeat time, all in database time. The claim is fair
across workflows: one busy workflow cannot starve the others within a claim.

While a job runs, its worker renews the heartbeat every `QUEUE_HEARTBEAT_MS`. Every write a run makes (its progress,
its final record, completing or failing the queue row) is checked against its token. A worker that lost its job
(it paused too long and the job was taken back) has its writes refused, and it stops the run itself once it has gone
`QUEUE_LEASE_MS` minus one heartbeat without a renewal.

A cancel sent to any instance stops the run on the worker running it within one heartbeat.

## When a worker is lost

The leader checks every `QUEUE_REAPER_INTERVAL_MS` for jobs whose heartbeat is older than `QUEUE_LEASE_MS` (the
worker crashed, was killed, or lost its database). Each one counts as an attempt, and then:

- **No node had completed:** the job goes back to the queue and another worker runs it.
- **A node had completed** (an email may have been sent, a record written): the run is marked
  `interrupted: worker lost` and goes to the dead-letter queue. It is never re-run silently; retry it from the
  dead-letter queue once you have checked its side effects.
- **The run had already finished**: the queue row is closed to match.
- **The job used up its attempts** (three by default): it goes to the dead-letter queue with `worker lost`.

An approval resume cannot show partial progress, so a lost resume goes to the dead-letter queue and the leader's
approval recovery drives the run on from its recorded decision.

Without cluster mode the earlier stuck-job sweep (`QUEUE_STUCK_JOB_TIMEOUT_MS`) still applies.

## Pools

Set `settings.executionPool` on a workflow (for example `gpu`) to send its queued runs to workers that list that pool
in `QUEUE_POOLS`. A builder or admin can also name a pool in the `/enqueue` body as `{ "pool": "gpu" }`. Pool names are
letters, digits, `_` and `-`. Keep at least one worker on every pool you use: nothing else runs its jobs.

## Shutdown and readiness

`GET /ready` answers `200 {"ready":true}` when the instance can take traffic and `503` with the reasons otherwise.
Point load balancer readiness probes at it; `/health` stays the liveness probe.

On SIGTERM or SIGINT an instance:

1. turns `/ready` to `503`;
2. stops claiming jobs and hands on leadership;
3. gives running jobs up to `SHUTDOWN_DRAIN_MS` to finish;
4. gives back the jobs still running, by the worker-loss rules above but without counting an attempt (a job with no
   completed node returns to the queue, one with a completed node is marked `interrupted: worker shut down`);
5. closes the server and the database, and exits.

A second signal exits at once. Set the orchestrator's termination grace period (for example Kubernetes
`terminationGracePeriodSeconds`) above `SHUTDOWN_DRAIN_MS` plus about 15 seconds.

## Metrics

With metrics on, `/metrics` adds (with the `METRICS_PREFIX`, `ao` by default):

| Metric | Type | Meaning |
|---|---|---|
| `ao_queue_pending{pool}` | gauge | Pending jobs per pool, sampled by the leader every 15 seconds |
| `ao_queue_running{pool}` | gauge | Running jobs per pool, sampled likewise |
| `ao_queue_dlq` | gauge | Dead-lettered jobs |
| `ao_queue_wait_seconds` | histogram | Time from a job being due to being claimed |
| `ao_queue_lost_total` | counter | Jobs taken back from lost workers |
| `ao_worker_slots_free` | gauge | Free job slots on this worker |

Alert on a rising `ao_queue_pending` with `ao_worker_slots_free` at zero (add workers) and on any increase of
`ao_queue_lost_total` (workers are crashing or losing the database).
