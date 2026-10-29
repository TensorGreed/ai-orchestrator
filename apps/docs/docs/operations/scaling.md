---
description: "Scale L2M out: API replicas and queue workers, a compose example, the Postgres connection budget, sizing, and the load and chaos test harness."
---

# Scaling

One instance (SQLite or Postgres) needs nothing from this page. When one process is no longer enough, L2M scales out on
one Postgres database: several **API replicas** behind a load balancer take the HTTP traffic, and **queue workers**
run the queued runs. Everything below is optional and builds on [Queue and workers](./queue-and-workers.md) and
[Cluster operations](./cluster.md).

All instances in a fleet run in **cluster mode**: `DB_TYPE=postgres` and `HA_ENABLED=true` on every one, with the same
`SECRET_MASTER_KEY_BASE64`.

## Roles

The same image runs every role; `WORKER_MODE` picks it.

| Role | `WORKER_MODE` | Takes traffic | Runs | Leads (schedules, triggers, reaper) |
|---|---|---|---|---|
| All-in-one (default) | `all` | yes | inline runs and queued runs | can |
| API replica | `api` | yes | inline runs (manual runs, webhooks); queues `/enqueue` | never |
| Webhook replica | `webhook` | webhook routes | inline webhook runs | never |
| Worker | `worker` | no (only `/health`, `/ready`, `/metrics`) | queued runs | can |

Today a run started over HTTP (a manual or streamed run, a webhook) executes on the replica that received it. Runs
sent to `POST /api/workflows/:id/enqueue`, approval resumes, and the schedules and triggers the leader fires, run where
the queue or the leader puts them. Add workers for queued work, and API replicas for request traffic.

Put the balancer's readiness check on `GET /ready` (it answers `503` while an instance drains on shutdown) and keep
liveness on `GET /health`. Ordinary traffic needs no stickiness: sessions, runs, progress and secrets are in the
database, the second step of an MFA sign-in, MCP OAuth callbacks and elicitation answers are shared through it in
cluster mode, and cancels reach the instance running a run over the cluster bus. Only MCP gateway sessions are kept
per replica; if clients use the gateway, make the balancer learn the `Mcp-Session-Id` and route by it, with the
snippets in [Cluster operations](./cluster.md#mcp-gateway-sessions).

## A worked compose example

Two API replicas and three workers on one Postgres:

```yaml
x-l2m-env: &l2m-env
  DB_TYPE: postgres
  DB_POSTGRESDB_URL: postgres://l2m:change-me@postgres:5432/l2m
  SECRET_MASTER_KEY_BASE64: ${SECRET_MASTER_KEY_BASE64:?set one key for every replica}
  HA_ENABLED: "true"
  API_HOST: 0.0.0.0
  API_PORT: "4000"

services:
  api:
    image: ghcr.io/tensorgreed/ai-orchestrator:latest
    environment:
      <<: *l2m-env
      WORKER_MODE: api
    deploy:
      replicas: 2
    stop_grace_period: 30s

  worker:
    image: ghcr.io/tensorgreed/ai-orchestrator:latest
    environment:
      <<: *l2m-env
      WORKER_MODE: worker
      QUEUE_CONCURRENCY: "10"
      DB_POSTGRESDB_POOL_SIZE: "5"
    deploy:
      replicas: 3
    stop_grace_period: 30s
```

Put a balancer in front of `api` only (round robin is fine); workers take no traffic. `stop_grace_period` covers the
default 20 second drain plus 5 seconds to hand jobs back ([Shutdown and readiness](./queue-and-workers.md#shutdown-and-readiness)).
The repository's `docker-compose.scale.yml` is a complete version of this layout with nginx, used by the load-test
harness below.

On Kubernetes, the Helm chart has the same layout behind `worker.enabled=true` and `api.workerMode=api`
(`ops/helm/ai-orchestrator`, see its README). The chart uses `/ready` for readiness and sizes
`terminationGracePeriodSeconds` from `SHUTDOWN_DRAIN_MS`.

## Connection budget

Each instance in cluster mode holds its pool (`DB_POSTGRESDB_POOL_SIZE`, default 10), one leader-lock connection and
one bus connection:

```
(API replicas + workers) x (pool size + 2) <= Postgres max_connections - connections you keep for others
```

Postgres allows 100 connections by default. Ten instances at the default pool need 120, so give workers a pool of 5
(their queries are short: claims, heartbeats and progress writes) and keep API replicas at 10:
2 API replicas and 8 workers then need `2 x 12 + 8 x 7 = 80`. Raise `max_connections` or put a **session-mode**
pooler in front for more; transaction-mode pooling breaks the leader lock and the bus.

## Sizing

- **Worker slots.** `QUEUE_CONCURRENCY` (default 5) is the number of runs one worker runs at once. Agent runs mostly
  wait on the model, so 10 or more per worker is common; code-heavy runs want fewer. Total slots =
  workers x `QUEUE_CONCURRENCY`. A queue keeps up while arrivals per second x average run seconds stays below the
  total slots.
- **Memory.** Plan for the runs in flight: agents keep their conversation and tool results in memory. Use
  `QUEUE_MAX_RSS_MB` to stop a worker claiming while it is above a limit.
- **API replicas.** Size them for request traffic and for the runs they execute inline (webhooks, manual runs). Two
  replicas give availability; add more when CPU rises.
- **Postgres.** Every run writes its progress and history; watch CPU and lock waits on the database before adding
  workers past what it can absorb.
- **Sandboxes.** Code nodes in container mode and stdio MCP servers start on the instance that runs the run. Give
  those workers the container runtime and put them in a pool ([Pools](./queue-and-workers.md#pools)).

## Metrics to watch

| Signal | Where | What it tells you |
|---|---|---|
| `ao_queue_pending{pool}` rising, `ao_worker_slots_free` at 0 | `/metrics` | Workers are saturated: add workers or slots. This is the signal for an autoscaler (for example KEDA's Prometheus scaler on `ao_queue_pending`). |
| `ao_queue_wait_seconds` p95 | `/metrics` | Time from due to claimed. Mostly the poll interval while workers have free slots; it grows when they do not. |
| `ao_queue_lost_total` increasing | `/metrics` | Workers crash, are killed or lose the database. |
| `ao_queue_dlq` | `/metrics` | Runs waiting for a person (interrupted after side effects, or out of attempts). |
| `ao_cluster_live_instances`, `ao_cluster_bus_connected` | `/metrics` | Instances missing from the registry; a bus listener that cannot connect. |
| Connections, lock waits | `pg_stat_activity` | Close to the budget above, or runs contending on rows. |

## The load and chaos harness

`docker-compose.scale.yml` and `ops/loadtest/` run a small fleet on one machine: Postgres (fsync off), two
`WORKER_MODE=api` replicas, N workers, an nginx round robin without stickiness on `127.0.0.1:4229`, a mock
OpenAI-compatible model (800 ms ± 200 ms, 50 tokens/s when streamed) and a mock MCP server (three tools, 50 ms).
Load comes from [k6](https://k6.io) in its container; nothing is added to the repository's dependencies. It needs
Docker with Compose, `curl` and `jq`.

```bash
ops/loadtest/run.sh up                      # build the image, start 2 API replicas + $WORKERS workers (2), seed
ops/loadtest/run.sh load w1 10 60s          # W1 at 10 runs/s for 60 s
ops/loadtest/run.sh load w2 4 60s           # W2 at 4 runs/s
ops/loadtest/chaos.sh                       # faults under load, then 0 lost, 0 unfinished, 0 duplicate
ops/loadtest/run.sh down                    # REMOVE_IMAGE=1 also removes the built image
```

Workloads:

| | Workflow | Path |
|---|---|---|
| W1 | webhook, Set, Webhook Response | `/webhook/load-w1`, inline on the API replicas |
| W2 | an agent with three MCP tool calls (four model calls) | `/enqueue`, on the workers |
| W3 | a JavaScript code node and an HTTP request (50 ms) | `/enqueue`, on the workers |
| W4 | 80% W3 through `/enqueue`, 20% streamed W2 runs | the streamed part needs queue dispatch (below) |

Each load run writes a folder under `ops/loadtest/results/` (or `RESULTS_DIR`): the k6 output and summary, Postgres
connections and lock waits sampled every 2 seconds, container CPU and memory, every replica's queue and cluster
metrics, queue wait (due to claimed) and end-to-end times from `execution_queue`, and a reconcile of k6's accepted
runs against `execution_history`. Every request carries a run number and k6 prints the numbers it got accepted, so the
reconcile compares sets of run numbers. It reports runs **lost** (accepted but not recorded), **unfinished** (still
queued or running after the settle timeout), **failed** (recorded with an error), **duplicated** (recorded twice) and
executions **over budget**: the mock model and tool servers count every call that really happened, and more calls than
the accepted runs may make (four model calls and three tool calls per W2 run, one echo per W3 run) means a run executed
twice, which one history row would hide. `run.sh load` and `chaos.sh` fail when a run is lost, unfinished, duplicated
or over budget; `run.sh load` also fails on failed runs (`MAX_FAILED`, 0 by default).

`chaos.sh` runs W2 and W1 together and, during the load, kills a worker with SIGKILL (and starts it again), restarts
an API replica, and pauses the leading worker for 60 seconds. A run the worker-loss rules dead-lettered as
`interrupted` is recorded, so it counts as neither lost nor duplicated, but it still needs a retry: the report states
how many runs were dead-lettered, lists them separately, and shows how long after each fault the reclaimed jobs were
taken back. Whether a lost job is re-run or dead-lettered is the worker-loss policy's decision, not the harness's.

The `Scale smoke` GitHub workflow runs the smoke loads and the chaos run on demand or when a pull request gets the
`scale` label.

### What is measured after queue dispatch

Queue dispatch (an optional `EXECUTION_DISPATCH=queue`) is planned and not in this release. With it, manual and
streamed runs, webhooks and schedules all go through the queue, and the API replicas no longer execute runs. The
harness is ready for it:

- W4 sends its streamed part only when `GET /api/cluster` reports `"executionDispatch": "queue"`; until then it runs
  the enqueue part alone and says so.
- The planned measurements are runs per second against the number of workers (2, 4 and 8, aiming at 80% scaling
  efficiency), queue wait p95 under 250 ms with the bus waking workers, stream relay lag from worker to browser, cancel
  propagation, recovery after a worker is killed, and the end-to-end overhead compared with one all-in-one instance.
