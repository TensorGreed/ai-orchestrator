---
description: "How L2M queues runs for workers: roles, pools, leases and fencing, lost workers, drain, the dead-letter queue and optional queue dispatch of every run."
---

# Queue and workers

Workflow runs sent to `POST /api/workflows/:id/enqueue` wait in a queue in the database and are run by a worker.
**With one instance and no settings, nothing changes**: the API process is its own worker, on SQLite or Postgres, and
the defaults below are the behaviour of earlier releases.

Everything on this page beyond the defaults is opt-in. Leases, the reaper, pools and cross-instance cancel apply only
in **cluster mode**: `DB_TYPE=postgres` and `HA_ENABLED=true` (see [Postgres](./postgres#running-more-than-one-instance)).

Fleet layouts, sizing, the connection budget and the load-test harness are in [Scaling](./scaling.md).

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
against the token. Before the first node that is not a trigger or input node starts, the worker records on its claim
that side effects may begin; if that write fails, the run fails before the node runs, so the reaper never re-runs a
run whose side effects it could not see.

A cancel sent to any instance stops the run on the worker running it, usually at once over the cluster bus ([Cluster operations](./cluster.md)) and within one heartbeat at the latest.

## When a worker is lost

The leader checks every `QUEUE_REAPER_INTERVAL_MS` for jobs whose heartbeat is older than `QUEUE_LEASE_MS` (the
worker crashed, was killed, or lost its database). Each one counts as an attempt, and then:

- **Only trigger or input nodes had started** (the workflow's entry nodes that only pass the input through, such as a
  webhook, schedule, form, chat or manual trigger): the job goes back to the queue and another worker runs it.
  Triggers that read or consume from another system when they run (Redis, Postgres, Kafka, RabbitMQ, MQTT, IMAP,
  Google Sheets and Google Drive triggers) count as side effects, like any other node.
- **Any other node had started** (an agent may have called a tool, an email may have been sent, a record written),
  whether or not it completed: the run is marked `interrupted: worker lost` and goes to the dead-letter queue. It is
  never re-run silently; retry it from the dead-letter queue once you have checked its side effects.
- **The run had already finished**: the queue row is closed to match.
- **The job used up its attempts** (three by default): it goes to the dead-letter queue with `worker lost`.

Approval resumes follow the same rules, on the resume's own queue row (the run's record still reads as the pause).
Only re-entering an **Approval Gate** node does not count, because the gate does nothing but pass the decision on: a
lost resume that started no other node goes back to the queue and resumes from the recorded decision on another
worker. Every other node a resume re-enters counts from its start: an agent that paused for approval of a write tool
runs again to make the approved call, and a paused sub-workflow (Execute Workflow) runs the rest of its child. So a
resume lost while that agent or sub-workflow runs, or once any node after the gate had started (a call in flight), is
marked `interrupted: worker lost` and dead-lettered, never re-run, so the approved write happens at most once. Its
paused state is removed with it, so approval recovery does not drive it again.

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
4. gives back the jobs still running, by the worker-loss rules above but without counting an attempt: a job where
   only trigger or input nodes had started returns to the queue, and one where any other node had started is marked
   `interrupted: worker shut down` and dead-lettered. An approval resume that had only re-entered its Approval Gate
   returns to the queue with its paused state and decision intact, and the next worker resumes it from the decision.
   One that had re-entered an agent or a paused sub-workflow, or started any node after the gate, is marked
   `interrupted: worker shut down` and dead-lettered too; its paused state is removed with it, so nothing drives it on
   automatically (retry it once you have checked its side effects);
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

Rolling deploys: a run still in a node other than an entry node when the drain ends (a long model or tool call, a
wait node) is dead-lettered, never re-run, so a deploy that restarts busy workers dead-letters long runs. Drain
workers before a deploy: stop sending them work (or scale up new workers first), set `SHUTDOWN_DRAIN_MS` and the
grace period above your longest usual run, and replace workers one at a time. Watch `ao_queue_dlq` during the deploy.

## Retention

Finished queue jobs (completed or dead) and dead-letter entries follow `EXECUTION_HISTORY_RETENTION_DAYS`: the
execution history prune deletes those older than the cutoff, on every deployment, single instance or cluster. The
default is 30 days; `0` keeps everything, as before this change. Retry a dead-lettered run before the cutoff. Pending
and running jobs are never pruned.

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

With `EXECUTION_DISPATCH=queue`, `/metrics` also has:

| Metric | Type | Meaning |
|---|---|---|
| `ao_dispatch_runs_total` | counter | Runs this instance put on the queue for a worker |
| `ao_dispatch_inline_fallback` | gauge | 1 while runs execute inline because the capability check failed |
| `ao_dispatch_inline_fallbacks_total` | counter | Times the instance started falling back to inline |

## Queue dispatch

By default every run executes on the instance that received it (`EXECUTION_DISPATCH=inline`); only `/enqueue` uses
the queue. In cluster mode, `EXECUTION_DISPATCH=queue` sends **every** run to the queue's workers, so `api` and
`webhook` replicas take requests while `worker` replicas do the work. Set it on the instances that receive requests.
Outside cluster mode the server refuses to start with it.

| Run started by | With `queue` |
|---|---|
| `POST /api/workflows/:id/execute`, retry, replay, canvas test runs | runs on a worker; the instance answers with the same result body |
| `POST /api/workflows/:id/execute/stream`, chat, `/api/webhooks/execute/stream` | runs on a worker; its events are relayed into the stream in order |
| Webhooks, forms, Slack/GitHub/Stripe/Telegram/Discord, MCP server triggers, the MCP gateway | runs on a worker; the reply waits for it as before |
| Schedules and app triggers | enqueued once per fire (two leaders firing the same second or event within 10 minutes enqueue one job) |
| Approval resumes | enqueued from any instance, including `api` replicas |

What changes:

- **Latency.** Each run waits for a worker to claim it. An enqueue wakes idle workers of its pool over the cluster bus,
  so a free worker claims within milliseconds; the `QUEUE_POLL_INTERVAL_MS` poll stays as the backstop.
- **Streaming.** `llm_delta` events are batched per node for up to 50 ms; large `node_complete` and other events are
  sent by reference and read back from the run's progress. Event order is kept.
- **Waiting.** A synchronous request waits up to the run's timeout plus a margin and then answers `504` (the run may
  still finish; read it at `/api/executions/:id`). If the job dies on the workers the request answers `500`. A full
  pool answers `429` with `Retry-After` (`QUEUE_MAX_PENDING`); an instance already waiting on `DISPATCH_MAX_WAITING`
  runs (1000 by default) answers `503`.
- **Disconnects.** When a stream's client goes away, the instance stops relaying and the run goes on, as an inline
  run does. Cancel it with `POST /api/executions/:id/cancel` from any instance.
- **Streams and a full pool.** A stream has already answered `200` when the pool is found full, so it ends with an
  SSE `error` event instead of `429`.
- **Reattach.** `GET /api/executions/:id/events` (SSE, `workflow:read`) follows an execution from any instance: an
  `execution` event with the run as stored, its events from that point on, then `result`. Events come from the
  instance running it, or from the queue worker over the cluster bus; an inline run on another instance shows only
  its stored state and result. It works without queue dispatch too.

Database load and sizing: each request waiting on a dispatched run reads the run's state every 2 seconds as the
backstop for a lost bus message (one or two small queries), and a streamed `node_complete` reads the run's progress
once. An API replica with 1000 waiting requests (`DISPATCH_MAX_WAITING`) adds about 500 to 1000 queries a second; size
`DB_POSTGRESDB_POOL_SIZE` and Postgres for it, or lower `DISPATCH_MAX_WAITING` and add API replicas.

Duplicate fires: a schedule fire is keyed on the second it matched, and an app trigger fire on what it reports (RSS
item ids, an SSE event id, file events). A second fire with the same key within 10 minutes is dropped and logged; after
that the key is free again, so an upstream that reuses event ids (an SSE server numbering from 1 after a restart) still
runs its events.

Stored data: a dispatched run's job carries its spec (the workflow and its input, with secret-looking fields
redacted as in the history) and, once it ends, its full result. The instance that answers the request drops both from
the job as soon as it has the result, and the rest goes with the history ([Retention](#retention)), so nothing of a run
stays in the queue longer than its history.

Capability check: queue dispatch is used only while every live worker serving the pool advertises it (an older
worker would not know the job format). During a rolling upgrade, or with no live worker for the pool, the instance
runs inline, `/health` lists a `dispatch_inline_fallback` warning, and `ao_dispatch_inline_fallback` is 1. The
effective mode is `executionDispatch` in the admin `GET /api/cluster` answer.

Limits: an MCP elicitation a dispatched run asks is answered on the worker's instance, as with any cluster run; replay
gate checks and eval runs still execute where they are started (an eval run's events stream follows one running on
another instance from its stored state).
