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
| `api` | yes (Postgres) | no | no |
| `worker` | yes | yes | yes, on the leader |
| `webhook` | yes (Postgres) | no | no |

On Postgres, `api` and `webhook` replicas only produce jobs; any `worker` or `all` instance on the same database runs
them. On SQLite nothing else can run the jobs of an instance without a worker, so such an instance has no queue
routes (`/enqueue` answers 404), as in earlier releases.

## Settings

All optional. Defaults equal earlier behaviour.

| Variable | Default | What it does |
|---|---|---|
| `QUEUE_CONCURRENCY` | `5` | Jobs one worker runs at once (1-256) |
| `QUEUE_POLL_INTERVAL_MS` | `1000` | How often an idle worker looks for jobs |
| `QUEUE_MAX_PENDING` | `0` (off) | Pending jobs per pool above which `/enqueue` answers `429` with `Retry-After` |
| `QUEUE_MAX_RSS_MB` | off | A worker above this memory stops claiming until it drops below 90% of it |
| `QUEUE_MAX_EVENT_LOOP_LAG_MS` | off | A worker whose event loop lags more than this (p99 over one second) stops claiming until it drops below 80% of it |
| `QUEUE_HEARTBEAT_MS` | `10000` | Cluster mode: how often a worker renews the leases of its running jobs |
| `QUEUE_LEASE_MS` | `45000` (at least 3 heartbeats) | Cluster mode: a job whose lease is older is taken back; must be at least 2 heartbeats |
| `QUEUE_REAPER_INTERVAL_MS` | `15000` | Cluster mode: how often the leader looks for expired leases |
| `QUEUE_POOLS` | `default` | Cluster mode: the pools this worker claims from, comma-separated |
| `SHUTDOWN_DRAIN_MS` | `20000` in cluster mode, otherwise unset | Turns on the shutdown drain (below) and sets how long running jobs get to finish |

When either claim gate re-opens, the worker claims one job, then fills its free slots on the next polls.

`QUEUE_CONCURRENCY` is validated: `0`, a fraction or more than `256` stops the API at startup (earlier releases fell
back to `5` for a value they could not use). A bad value stops the API at startup with a message naming the variable. `QUEUE_POOLS` other than `default` outside
cluster mode is refused, since a lone worker that skips a pool would leave its jobs waiting forever.

## Claims, leases and fencing (cluster mode)

A worker claims jobs with `FOR UPDATE SKIP LOCKED`, so two workers never take one job. Each claim records the
worker (`claimed_by`), a fresh token (`claim_token`) and a heartbeat time, all in database time. The claim is fair
across workflows: one busy workflow cannot starve the others within a claim.

While a job runs, its worker renews the heartbeat every `QUEUE_HEARTBEAT_MS`. These writes are checked against the
job's token and refused once the job was taken back: the run's record (progress and final), its paused state and its
approval request when it reaches an approval, and completing or failing the queue row. A worker whose write is refused
stops the run at once. Before each node starts, the worker also checks that its lease was confirmed within
`QUEUE_LEASE_MS` minus one heartbeat; a worker that stalled (a long pause, or its database stopped answering) stops the
run instead of starting the node, and claims nothing new until a renewal answers again. A renewal that does not answer
within one heartbeat counts as failed.

Side effects are not fenced: a stopped worker may still finish a call already in flight (an HTTP request, a model or
tool call, or a code node, which runs to its own timeout), and session memory, the tool cache, tool-call telemetry and notifications it writes are not checked
against the token. A node whose progress write failed for another reason (a database error) is not seen as completed
by the reaper, so if that worker is lost too, the run may be re-run from the start.

A cancel sent to any instance stops the run on the worker running it, usually at once over the cluster bus ([Cluster operations](./cluster.md)) and within one heartbeat at the latest.

## When a worker is lost

The leader checks every `QUEUE_REAPER_INTERVAL_MS` for jobs whose heartbeat is older than `QUEUE_LEASE_MS` (the
worker crashed, was killed, or lost its database). Each one counts as an attempt, and then:

- **No node had completed:** the job goes back to the queue and another worker runs it.
- **A node had completed** (an email may have been sent, a record written): the run is marked
  `interrupted: worker lost` and goes to the dead-letter queue. It is never re-run silently; retry it from the
  dead-letter queue once you have checked its side effects.
- **The run had already finished**: the queue row is closed to match.
- **The job used up its attempts** (three by default): it goes to the dead-letter queue with `worker lost`.

Approval resumes follow the same rules. A resume counts the nodes it completes after the decision (on its queue
row, since the run's record still reads as the pause): a lost resume with none goes back to the queue and resumes from
the recorded decision on another worker; one with a completed node is marked `interrupted: worker lost` and
dead-lettered, and its paused state is removed with it, so approval recovery does not drive it again.

Without cluster mode the earlier stuck-job sweep (`QUEUE_STUCK_JOB_TIMEOUT_MS`) still applies. It never touches a
leased job: those are the reaper's alone.

## Pools

Set `settings.executionPool` on a workflow (for example `gpu`) to send its queued runs to workers that list that pool
in `QUEUE_POOLS`. A builder or admin can also name a pool in the `/enqueue` body as `{ "pool": "gpu" }`. Pool names are
letters, digits, `_` and `-`. Keep at least one worker on every pool you use: nothing else runs its jobs, and the only
sign of a stranded pool is a rising `ao_queue_pending{pool}`. Outside cluster mode `executionPool` is ignored: the one
worker runs every job. The pool can be set through the API or the workflow JSON; the editor has no control for it yet.

Fairness: a claim looks at the next due jobs (eight times its batch, 64 to 512) and takes one per workflow before a
second of any. A burst from one workflow larger than that window still runs ahead of others until it drains below it.

## Shutdown and readiness

`GET /ready` answers `200 {"ready":true}` when the instance can take traffic and `503` with the reasons otherwise.
Point load balancer readiness probes at it; `/health` stays the liveness probe.

The shutdown drain runs in cluster mode, or on any instance where `SHUTDOWN_DRAIN_MS` is set. Without either, SIGTERM
and SIGINT behave as in earlier releases: the process exits at once (a queued run in flight is picked up again by the
stuck-job sweep, and an approval resume by approval recovery). With the drain, on SIGTERM or SIGINT an instance:

1. turns `/ready` to `503`;
2. stops claiming jobs and hands on leadership;
3. gives running jobs up to `SHUTDOWN_DRAIN_MS` to finish;
4. gives back the jobs still running, by the worker-loss rules above but without counting an attempt: a job with no
   completed node returns to the queue, and one with a completed node is marked `interrupted: worker shut down` and
   dead-lettered. An approval resume with no node completed since the decision returns to the queue with its paused
   state and decision intact, and the next worker resumes it from the decision. One with a completed node is marked
   `interrupted: worker shut down` and dead-lettered too; its paused state is removed with it, so nothing drives it
   on automatically (retry it once you have checked its side effects);
5. closes the server and the database (up to 5 seconds more), and exits.

A second signal exits at once. Give the platform a termination grace period above `SHUTDOWN_DRAIN_MS` plus 5 seconds,
or the process is killed before it gives jobs back (the reaper then takes them back after a lease). With the 20 second
default:

```yaml
# Helm values / Kubernetes pod spec (30 s is the Kubernetes default)
terminationGracePeriodSeconds: 30
```

```yaml
# docker compose (the default is 10 s)
services:
  api:
    stop_grace_period: 30s
```

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
