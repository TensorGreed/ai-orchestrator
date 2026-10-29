---
description: "Run several L2M instances on one Postgres database: cross-instance cancel, shared sign-in and rate limits, the registry, leader jobs and troubleshooting."
---

# Cluster operations

Several API instances can share one Postgres database ([Running more than one instance](./postgres.md#running-more-than-one-instance)). This page covers how they signal each other, how to see the cluster, and what to check when something looks wrong. Nothing here needs configuring: one instance (SQLite, or Postgres with `HA_ENABLED=false`) behaves exactly as before.

**Cluster mode** means `DB_TYPE=postgres` and `HA_ENABLED=true` on every instance. The signalling below is active only in cluster mode; the instance registry runs on every Postgres instance.

To plan a fleet (API replicas and workers, sizing, the connection budget) and to load-test it, see [Scaling](./scaling.md).

## What cluster mode adds

| When | What happens | Backstop if a message is lost |
|---|---|---|
| A run is canceled on one instance while another executes it | The canceled record is written, then a `cancel` message stops the run on the instance executing it, usually within milliseconds; queued runs included. The cancel answers `abortSignalled: true`. | Every instance re-reads its running runs every `CLUSTER_CANCEL_CHECK_MS` (10 s) and stops any that are canceled; a queue worker also checks its jobs at every queue heartbeat ([Queue and workers](./queue-and-workers.md)). Whichever comes first stops the run; the others find it stopped and do nothing. |
| An eval run or replay job is canceled on another instance | The run is marked canceled, then an `eval_cancel` message stops its cases on the instance running it. | The owner re-reads its runs on each eval heartbeat (30 s). |
| A workflow is saved, published, restored or deleted, on any instance (`WORKER_MODE=all`, `worker`, `api` or `webhook`) | A `workflow_changed` message makes the leader reload its schedules and triggers at once. | The leader's periodic sync (15 s). |
| An instance stops beating (crash, lost host) | The leader marks that instance's inline runs `error: interrupted: the instance running this run stopped responding` once its heartbeat is older than `CLUSTER_INSTANCE_TIMEOUT_MS` (45 s), checked at every leader heartbeat. Runs the queue owns (any run a pending or running queue job drives, approval resumes included) are left to the queue's leases and reaper; an instance that fences itself never stops them either. An instance that restarts under the same `HA_INSTANCE_ID` fails its previous process's runs as it starts. | A run whose owner row was never written falls back to the restart reconcile (runs older than the longest run timeout plus a minute). |
| The audit export runs | Only the leader runs the export timer, and every export of a destination (timer or **Export now**) holds a per-destination advisory lock, so no batch is shipped twice. **Export now** waits up to 10 s for an export in progress elsewhere, then answers `409`. The destination's cursor only moves from the value read under the lock: if the lock's connection was lost mid-delivery and another instance shipped meanwhile, the late run is refused and logged instead of moving the cursor back. | |
| Git pull or push | One at a time across instances (an advisory lock); a sync that cannot get it within 10 s answers `409` "Another instance is running a git sync". | |

### An instance that is alive but cannot heartbeat

The leader cannot tell a crashed instance from one that is alive but cut off from the database (a network partition, a saturated pool, a long pause). Both sides therefore act:

- **The instance fences itself.** Once its last recorded heartbeat is older than `CLUSTER_INSTANCE_TIMEOUT_MS` minus one heartbeat (35 s by default), it stops its own inline runs, and any it starts meanwhile, with the same `interrupted` error the leader writes, and logs "fenced itself". The fence lifts at its next recorded heartbeat.
- **The late result is refused.** A run's final write never replaces a record the leader already failed this way, so a run reported as interrupted never turns into a success later. A reconcile and a final write that race are settled by the row lock: whichever commits first wins.

Messages travel on Postgres `LISTEN/NOTIFY`. Delivery is best effort: the state a message announces is always written to the database first, and each consumer has the backstop above, so a lost message only makes the effect slower. After the listener reconnects, every instance re-reads at once (runs to stop, eval runs to stop, and on the leader all schedules and triggers).

**While the bus is down** (a Postgres restart, a pooler in the way) the instance stays ready: `/ready` ignores the bus, because the outage is usually cluster-wide and failing it would take every replica out of the load balancer at once. `GET /health` carries a `bus_disconnected` warning and `ao_cluster_bus_connected` reads 0 until the listener is back; cancels, queue wake-ups and schedule reloads use the database fallbacks above in the meantime.

A self-fenced instance (see above) may keep claiming queue jobs. That is safe: a queued run is held by its queue lease and claim token, not by the registry, and the queue stops claiming on its own when the database is unreachable.

## The bus connection

Each instance in cluster mode holds **one extra connection** for listening (`application_name = 'l2m-bus'`), next to its pool and the leader-lock connection (`l2m-leader`). Budget `DB_POSTGRESDB_POOL_SIZE + 2` connections per instance, and keep `DB_POSTGRESDB_POOL_SIZE` at 4 or more in cluster mode: up to two MCP OAuth refreshes per instance each hold one pooled connection for their cluster lock while they use another, so a pool of 1 or 2 leaves nothing for other requests while they run.

- **Direct or session-mode pooling only.** PgBouncer in transaction mode breaks `LISTEN` (notifications go to whichever client holds the server connection), as it breaks the leader lock. Point the API at Postgres directly, or at a session-mode pooler.
- **Reconnects.** The listener is checked by TCP keepalives and a `SELECT 1` every 10 seconds; a connection that errors, ends or does not answer is replaced with backoff (250 ms up to 10 s). Killing it (`pg_terminate_backend`) is safe.
- **Notifications are sent outside transactions** (`SELECT pg_notify(...)` in autocommit), so they never take Postgres's commit-time notify lock.
- **Payloads** stay under 7,000 bytes; larger run events are sent as references and read from the database.
- **Statement logging.** With `log_statement = 'all'` Postgres logs `pg_notify` payloads. Messages carry run and workflow ids and cancel reasons, never secrets. An elicitation answer (what a person typed into a tool's question) travels sealed with the master key, so the log shows ciphertext only.
- Channels are scoped by schema (`l2m_ctl` in `public`), so deployments that share a database but not a schema never see each other's messages.
- **Self-test.** After each connect the bus sends itself a notification through the pool; `bus.verified` in `GET /api/cluster` is `false` (with a warning in the log) when it never arrives, which usually means a transaction-mode pooler.

### Who can send on the bus

Postgres has no privilege on `NOTIFY` channels: any role that can connect to the database can send a message. **The database role is the trust boundary**: every cluster member shares it, so do not grant the application's database to untrusted roles (for a reporting user, use a replica or a separate database). Within that boundary a message never decides anything alone: every message is validated (known type, field types and lengths; anything else is ignored), a `cancel` or `eval_cancel` stops a run only when the database shows it canceled, and `workflow_changed` only makes the leader re-read the saved workflow. Cancel reasons on the bus are cut to 200 characters with control characters removed.

## Sign-in, OAuth and other per-user flows

Some flows span two requests that a load balancer may send to different instances. In cluster mode their state is kept in the database, so no sticky sessions are needed. One instance (SQLite, or Postgres with `HA_ENABLED=false`) keeps it in memory exactly as before, and none of this needs configuring.

| Flow | Cluster mode |
|---|---|
| Password sign-in with TOTP: `POST /api/auth/login`, then `POST /api/auth/login/mfa` | The challenge is stored in `pending_challenges`, so the second step may land on any instance. It is used once across all instances (one atomic delete) and lasts 5 minutes. |
| SSO sign-in with a local TOTP step (the `l2m_sso_mfa` cookie) | The same. |
| MCP OAuth connect: **Connect**, then the authorization server's redirect to `/api/mcp/oauth/callback` | The state, PKCE verifier and client registration are stored the same way, so the callback may land on any instance. They are still bound to the session that started the flow, used once and short-lived (`MCP_OAUTH_STATE_TTL_MS`). |
| MCP OAuth token refresh | One refresh per connection across the instances: a refresh holds an advisory lock, re-reads the stored token, and uses one another instance stored meanwhile. A rotating refresh token is therefore never spent twice. A refresh that waits more than 30 s for another instance's refresh fails with "try again shortly". |
| An MCP server asks the person running a workflow for input (elicitation) | The request records the instance whose run waits on it. An answer that lands on another instance is checked there (who may answer, what the server asked for), then sent to that instance over the bus, sealed with the master key, and settled there. The API answers `200` once the run has the answer, or `202` with `delivered: "signalled"` if it takes longer than about 5 s. If the instance holding the request has stopped, the request expires at once and the answer gets `409`. A sweep expires such requests within one `CLUSTER_INSTANCE_TIMEOUT_MS`. An instance that starts expires only requests nobody holds, its own from before a restart, and those of stopped instances, never a live replica's. |
| Replay capture daily limit (`maxPerDay`) | A sampled run reserves its slot in the database, one workflow at a time across all instances, so the limit holds. The slot is given back when the capture is stored or dropped. A reservation whose instance stopped lapses after the run's time limit plus 10 minutes. |

Only a hash of each challenge id is stored, never the id itself, and the payload is sealed with `SECRET_MASTER_KEY_BASE64` (every instance needs the same key, as it already does for secrets). The session cleanup tick removes expired challenges.

During a rolling upgrade to this version, a TOTP step or MCP OAuth connect in progress may need restarting, and pending elicitations may expire.

## Rate limits in a cluster

| Bucket | Cluster mode |
|---|---|
| Auth (`RATE_LIMIT_AUTH_MAX`) and webhook (`RATE_LIMIT_WEBHOOK_MAX`) | **Shared.** Each hit counts in an unlogged Postgres table with one statement, so the limit holds across all instances: 10 sign-in attempts a minute means 10 in total, not 10 per instance. Each webhook request is one database write in cluster mode. If the database does not answer, an instance counts in its own memory until it does, and logs that once a minute. |
| Global (`RATE_LIMIT_GLOBAL_MAX`) | **Per instance.** Every request would otherwise write to the database. With N instances behind a round-robin balancer, a client gets up to N times the limit. |

Behind a load balancer or proxy, set `TRUST_PROXY` ([Environment](../getting-started/environment.md)). Without it every client is keyed by the proxy's address, so all of them share one auth bucket. In cluster mode, when requests arrive with `X-Forwarded-For` while `TRUST_PROXY` is off, `GET /health` carries a `forwarded_for_untrusted` warning for 15 minutes. Any client can send that header, so the warning is a hint to check the proxy setup, not proof that a proxy is in front.

## Community nodes in a cluster

In cluster mode **Install** and **Uninstall** under Community nodes (`POST /api/community-nodes/install`, `DELETE /api/community-nodes/:name`) answer `409`: the change would reach one instance only, and runs on the others would fail. `GET /api/community-nodes` reports `installAllowed: false`. Give every instance the same packages instead, either way:

- **Bake them into the image.** Install the packages into `COMMUNITY_NODES_DIR` at build time, for example `RUN cd /app/community-nodes && npm install --ignore-scripts l2m-nodes-cohere@1.2.3`, and roll the new image out.
- **Mount a shared volume.** Mount one volume at `COMMUNITY_NODES_DIR` on every instance, install into it from a one-off job, then restart the instances or call `POST /api/community-nodes/reload` on each.

## MCP gateway sessions

Gateway sessions (`Mcp-Session-Id`) stay in the memory of the instance that opened them. A request that lands on another instance gets `404`, and a client following the MCP spec opens a new session, which works but restarts any stdio servers the session started. To avoid that churn, send a session's requests to the instance that opened it.

The session id is random and the instance that answers `initialize` chooses it, so hashing the request header does not help: the hash points at an unrelated instance. The balancer has to learn the id from the response of `initialize` and route later requests that carry it to the same server. HAProxy does this with a stick table:

```text
backend l2m_mcp
    mode http
    balance roundrobin
    stick-table type string len 64 size 100k expire 30m
    stick store-response res.hdr(mcp-session-id)
    stick match req.hdr(mcp-session-id)
    server api-1 api-1:4000 check
    server api-2 api-2:4000 check
```

Keep `expire` at or above `MCP_GATEWAY_SESSION_IDLE_MS` (30 minutes by default). Open-source nginx cannot learn a value from a response header, so it cannot route by session id. The alternatives are:

- **nginx Plus:** `sticky learn create=$upstream_http_mcp_session_id lookup=$http_mcp_session_id zone=mcp:1m timeout=30m;` in the upstream. Its default timeout is 10 minutes, shorter than a session, so set `timeout` to at least `MCP_GATEWAY_SESSION_IDLE_MS`.
- **Open-source nginx, by client address:** `hash $remote_addr consistent;` in the upstream. This is coarser: every session from one address goes to one instance, and clients that all reach the balancer through one NAT or proxy share a single instance.

## The instance registry

Every instance on Postgres, HA on or off, writes a heartbeat row to `cluster_instances` every `CLUSTER_HEARTBEAT_MS` (10 s): its id (`HA_INSTANCE_ID`), worker mode, whether it leads, runs in progress, the queue pools it claims from and its job slots, bus state, version and host. Give every instance its own `HA_INSTANCE_ID` (or leave it unset for a generated one): two live instances sharing an id would fail each other's runs at start. An instance is live while its heartbeat is younger than `CLUSTER_INSTANCE_TIMEOUT_MS` (45 s, judged on the database clock, so host clocks do not matter). A clean stop removes its row; the leader deletes rows that stopped beating an hour ago.

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
- **An elicitation answer returns `202 delivered: "signalled"`.** The instance running the request had not settled it within about 5 s: its bus listener may be reconnecting. The request still shows as pending; answer it again, or check `bus.connected` on the instance named in the log.
- **Sign-in after the TOTP step fails with "MFA challenge expired or invalid" on some instances only.** The instances disagree on cluster mode: every instance needs `HA_ENABLED=true` and the same `SECRET_MASTER_KEY_BASE64`.
- **The API refuses to start with "never applied vN".** The database recorded a later migration before the build that adds vN ran on it, so the forward-only chain would skip vN. Apply vN's `up` SQL from `apps/api/src/db/migrations.ts` by hand (each migration is idempotent), insert vN into `schema_migrations`, and start again.
