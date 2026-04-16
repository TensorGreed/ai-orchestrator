# ai-orchestrator Helm chart

Kubernetes deployment for the Fastify API, Studio web UI, and (optionally) dedicated webhook-only replicas.

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
