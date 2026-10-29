# ai-orchestrator Helm chart

Kubernetes deployment for the Fastify API, Studio web UI, and (optionally) dedicated webhook-only replicas.

## Container images

The chart's default `image.repository` values point at GHCR images published by [.github/workflows/release-images.yml](../../../.github/workflows/release-images.yml) on every `v*` git tag (e.g. `v0.1.0`):

- `ghcr.io/tensorgreed/ai-orchestrator:<tag>` — the API (Fastify)
- `ghcr.io/tensorgreed/ai-orchestrator-web:<tag>` — the Studio UI (Nginx)

Both images are multi-arch (`linux/amd64` + `linux/arm64`), so M-series Macs and AWS Graviton nodes get the right architecture without emulation. Pin a specific tag in production via `--set image.tag=v0.1.0 --set web.image.tag=v0.1.0` instead of `latest`.

Each release image is signed (keyless cosign) and carries SLSA build provenance and CycloneDX SBOMs. To deploy exactly the image you verified, append its digest to the tag, e.g. `--set image.tag=v0.1.0@sha256:<api digest> --set web.image.tag=v0.1.0@sha256:<web digest>`. The verification commands are on the docs page [Verify a release](https://lsquarem.com/docs/operations/verify-a-release).

## Quick start

```bash
# Generate a master key for secret encryption at rest.
MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")

helm install ao ./ops/helm/ai-orchestrator \
  --set image.repository=ghcr.io/your-org/ai-orchestrator \
  --set image.tag=latest \
  --set secrets.secretMasterKeyBase64="$MASTER_KEY" \
  --set secrets.databaseUrl="postgresql://ao:pass@postgres:5432/ai_orchestrator" \
  --set api.replicaCount=3 \
  --set api.haEnabled=true \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=ai-orchestrator.example.com
```

## Architecture

The chart deploys three optional workload groups:

- **api** — the full Fastify application. Scale horizontally; `HA_ENABLED=true` + `WORKER_MODE=all` means only one replica at a time runs scheduler/trigger/queue cron work via the DB-backed leader lease.
- **webhook** (optional) — dedicated replicas with `WORKER_MODE=webhook`. They serve all `/webhook/*`, `/webhook-test/*`, and `/api/webhooks/*` routes without running any scheduler or background worker. Useful when you want to autoscale webhook ingestion independently from the control plane.
- **web** — static React Studio UI (Nginx).

## High availability

`api.replicaCount > 1` + `api.haEnabled=true` is the supported HA configuration. Scheduler and trigger services run on whichever replica currently holds the `primary` lease in the `leader_leases` table. If the leader pod dies, another replica picks up the lease within `HA_LEASE_TTL_MS` (default 30s).

Each pod uses its `metadata.name` as `HA_INSTANCE_ID` via the downward API, so lease ownership is visible per pod via `GET /api/ha/status`.

## Observability

Deployments carry `prometheus.io/scrape: "true"` on port 4000, path `/metrics`. Import [ops/grafana/ai-orchestrator-dashboard.json](../../grafana/ai-orchestrator-dashboard.json) for pre-built panels.

## Databases

- **Postgres (recommended for HA)**: set `secrets.databaseUrl` to point at an external Postgres instance. The included `postgresql:` block is a placeholder — plug in [bitnami/postgresql](https://artifacthub.io/packages/helm/bitnami/postgresql) or your own operator.
- **SQLite (single-replica only)**: leave `secrets.databaseUrl` blank. SQLite is single-writer — do not set `api.replicaCount > 1` with SQLite.

## Persistence (`/app/apps/api/data`)

The API container's `/app/apps/api/data` path holds, depending on configuration:

- the SQLite database file (when `DB_TYPE=sqlite`, the chart default);
- the [GitSyncService](../../../apps/api/src/services/git-sync-service.ts) working tree (`apps/api/data/git/...`) when source-control sync is enabled;
- the [FileSystemBinaryStore](../../../packages/workflow-engine/src/executor.ts) blobs.

Default behaviour (`api.persistence.enabled: true`): the chart auto-creates a `PersistentVolumeClaim` named `<release>-api-data` (5Gi, ReadWriteOnce, default StorageClass) and mounts it. SQLite, git working tree, and binary blobs all survive pod restarts and rolling updates.

Knobs (under `api.persistence:`):

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Set `false` to fall back to `emptyDir` (ephemeral; only useful for dev clusters or fully-Postgres deployments where the data path is unused). |
| `size` | `5Gi` | Bump for large workflow-version histories or chunky binary outputs. |
| `accessMode` | `ReadWriteOnce` | Switch to `ReadWriteMany` if you need shared state across replicas (NFS, EFS, Longhorn, etc.). |
| `storageClassName` | `""` | Empty uses the cluster's default StorageClass. |
| `existingClaim` | `""` | Set to a pre-created PVC name to BYO storage; the chart's auto-created PVC is then skipped. |

### SQLite vs Postgres tradeoff under HA

| Scenario | Database | Replicas | Persistence | Works? |
|---|---|---|---|---|
| Local / dev | SQLite | 1 | `emptyDir` | yes; resets on restart |
| Single-node prod | SQLite | 1 | PVC (RWO) | yes; survives restarts |
| Multi-node HA | SQLite | ≥ 2 | PVC (RWO) | **no** — replicas on different nodes deadlock on the SQLite single-writer file lock; PVC RWO can't be cross-node mounted |
| Multi-node HA | SQLite | ≥ 2 | PVC (RWX) | technically works, but SQLite's locking is unsafe over network filesystems — **avoid** |
| Multi-node HA | Postgres | ≥ 2 | PVC (RWO) | yes — Postgres handles concurrency, the PVC just carries git working tree + binary blobs per replica |
| Multi-node HA | Postgres | ≥ 2 | PVC (RWX) | yes — and shared git working tree across replicas |

The chart defaults (`api.replicaCount: 2`, `api.haEnabled: true`) assume Postgres. Switch to `api.replicaCount: 1` if you're sticking with SQLite.

## Queue workers

Optional `worker` replicas (`WORKER_MODE=worker`) claim and run queued runs and take the leader work; the API replicas then only serve HTTP. Disabled by default: without `worker.enabled` the chart renders as before. Workers need cluster mode (Postgres and `api.haEnabled=true`); the chart refuses `worker.enabled` with HA off.

```bash
helm upgrade ao ./ops/helm/ai-orchestrator \
  --set api.workerMode=api \
  --set worker.enabled=true \
  --set worker.replicaCount=4 \
  --set worker.concurrency=10
```

| Key | Default | Notes |
|---|---|---|
| `worker.enabled` | `false` | Deploys `<release>-worker` (no Service: the load balancer never routes to workers). |
| `worker.replicaCount` | `2` | |
| `worker.concurrency` | empty (server default 5) | `QUEUE_CONCURRENCY` |
| `worker.pools` | empty (`default`) | `QUEUE_POOLS` |
| `worker.dbPoolSize` | `5` | `DB_POSTGRESDB_POOL_SIZE`; keep `(api + worker replicas) x (pool + 2)` under Postgres `max_connections`. |
| `worker.terminationGracePeriodSeconds` | drain + 10 s, at least 30 | Must cover `config.SHUTDOWN_DRAIN_MS` plus 5 s; the chart refuses less. |
| `worker.env` | `{}` | Extra variables for workers only. |

Readiness probes use `/ready` (503 while an instance drains on SIGTERM); liveness stays on `/health`. With `config.SHUTDOWN_DRAIN_MS` set, the API, webhook and worker Deployments get `terminationGracePeriodSeconds` of the drain plus 10 s (or `api.terminationGracePeriodSeconds`, checked against the drain). Sizing and the load-test harness: [Scaling](../../../apps/docs/docs/operations/scaling.md).

## Webhook autoscaling

Enable dedicated webhook replicas:

```bash
helm upgrade ao ./ops/helm/ai-orchestrator \
  --set webhook.enabled=true \
  --set webhook.replicaCount=3 \
  --set autoscaling.enabled=true \
  --set autoscaling.maxReplicas=20
```

Point your load balancer at `<release>-webhook` for `/webhook/*` routes and at `<release>-api` for everything else (the ingress template does this automatically).
