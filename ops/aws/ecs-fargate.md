# AWS ECS Fargate deployment guide

This guide walks through a production deployment of ai-orchestrator on AWS ECS Fargate with two task definitions (API + webhook), an RDS Postgres database, and an Application Load Balancer in front.

## Topology

```
          ┌──────────────────────┐
          │ Application Load Bal │
          │   (ALB, ACM cert)    │
          └──────┬────────┬──────┘
                 │        │
   /webhook/*    │        │  everything else
                 ▼        ▼
     ┌──────────────┐  ┌──────────────┐
     │ ao-webhook   │  │ ao-api       │
     │ (ECS Svc)    │  │ (ECS Svc)    │
     │ Fargate x N  │  │ Fargate x 2+ │
     │ mode=webhook │  │ mode=all +   │
     │              │  │ HA_ENABLED   │
     └──────┬───────┘  └──────┬───────┘
            └────────┬────────┘
                     ▼
         ┌─────────────────────┐
         │ RDS Postgres (HA)   │
         └─────────────────────┘
```

Two Fargate services:

- **ao-api** — serves authenticated API traffic. 2+ tasks. `WORKER_MODE=all` + `HA_ENABLED=true` means only one task at a time runs scheduler/trigger cron work via the DB-backed leader lease. Failover happens within `HA_LEASE_TTL_MS` (30s default).
- **ao-webhook** — serves `/webhook/*`, `/webhook-test/*`, `/api/webhooks/*`. `WORKER_MODE=webhook`. Autoscales on CPU or ALB request count, independent of the control plane.

## Prerequisites

- AWS account with ECS, ECR, RDS, ALB permissions
- VPC with at least two private subnets across different AZs
- A security group allowing port 4000 from the ALB to the tasks
- RDS Postgres 15+ instance with a database named `ai_orchestrator`
- An ACM certificate for your domain
- An ECR repository with the built ai-orchestrator API image (`docker build -f apps/api/Dockerfile .`)

## Step 1 — Store secrets in AWS Secrets Manager

```bash
MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
aws secretsmanager create-secret \
  --name ai-orchestrator/master-key \
  --secret-string "$MASTER_KEY"

aws secretsmanager create-secret \
  --name ai-orchestrator/db-url \
  --secret-string "postgresql://ao:$DB_PASSWORD@$RDS_HOST:5432/ai_orchestrator"
```

Grant your ECS task execution role `secretsmanager:GetSecretValue` on both secrets.

## Step 2 — Create the task definitions

Use [task-definition-api.example.json](./task-definition-api.example.json) and [task-definition-webhook.example.json](./task-definition-webhook.example.json) as starting points. Replace the placeholder values:

- `ACCOUNT_ID` — your AWS account
- `REGION` — e.g. `us-east-1`
- `IMAGE_URI` — `<account>.dkr.ecr.<region>.amazonaws.com/ai-orchestrator:latest`

Register the tasks:

```bash
aws ecs register-task-definition \
  --cli-input-json file://ops/aws/task-definition-api.example.json

aws ecs register-task-definition \
  --cli-input-json file://ops/aws/task-definition-webhook.example.json
```

## Step 3 — Create the services

```bash
aws ecs create-service \
  --cluster ai-orchestrator \
  --service-name ao-api \
  --task-definition ai-orchestrator-api \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-...,subnet-...],securityGroups=[sg-...],assignPublicIp=DISABLED}' \
  --load-balancers 'targetGroupArn=arn:aws:elasticloadbalancing:...,containerName=api,containerPort=4000' \
  --health-check-grace-period-seconds 30

aws ecs create-service \
  --cluster ai-orchestrator \
  --service-name ao-webhook \
  --task-definition ai-orchestrator-webhook \
  --desired-count 3 \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-...,subnet-...],securityGroups=[sg-...],assignPublicIp=DISABLED}' \
  --load-balancers 'targetGroupArn=arn:aws:elasticloadbalancing:...,containerName=webhook,containerPort=4000' \
  --health-check-grace-period-seconds 30
```

## Step 4 — ALB routing rules

Create two target groups — one per service — and route by path:

| Listener rule                                    | Target group     |
| ------------------------------------------------ | ---------------- |
| Path `/webhook/*` or `/webhook-test/*` or `/api/webhooks/*` | `ao-webhook-tg` |
| Everything else                                  | `ao-api-tg`      |

Both target groups should use `/health` as the health check path with a 200-response requirement.

## Step 5 — Autoscaling

The webhook service is well-suited to scale-on-request-rate:

```bash
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id service/ai-orchestrator/ao-webhook \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 2 --max-capacity 30

aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --resource-id service/ai-orchestrator/ao-webhook \
  --scalable-dimension ecs:service:DesiredCount \
  --policy-name webhook-cpu \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{
    "TargetValue": 60.0,
    "PredefinedMetricSpecification": { "PredefinedMetricType": "ECSServiceAverageCPUUtilization" }
  }'
```

The API service is typically fine at 2–4 tasks; scheduler work is single-leader so no fanout benefit beyond HA.

## Step 6 — CloudWatch log insights

Both task definitions ship logs to `/ecs/ai-orchestrator`. Useful queries:

```
# Leader lease transitions
fields @timestamp, msg, instanceId
| filter msg like /Acquired leader lease|Resigned leader lease/
| sort @timestamp desc

# Webhook ingress rate
fields @timestamp, req.url, res.statusCode
| filter req.url like /^\/webhook/
| stats count() by bin(1m)
```

## Operational notes

- **Single leader**: even with many API replicas, only one runs scheduler/cron at a time. `/api/ha/status` shows the current holder. The DB row in `leader_leases` is the source of truth.
- **SQLite is not supported in Fargate** — multi-task deployments require RDS Postgres (SQLite is single-writer, single-host). The chart refuses to start in worker-mode `all` with multiple replicas pointed at the same SQLite file.
- **Rolling deploys**: the task definitions set `minimumHealthyPercent: 50` and `maximumPercent: 200` so ECS can drain one old task at a time. Leader handover happens automatically when the old leader task stops.
- **Metrics scraping**: if using Managed Prometheus or ADOT, add an ADOT sidecar to the API task and scrape `http://localhost:4000/metrics`.

## Tear down

```bash
aws ecs update-service --cluster ai-orchestrator --service ao-api --desired-count 0
aws ecs update-service --cluster ai-orchestrator --service ao-webhook --desired-count 0
aws ecs delete-service --cluster ai-orchestrator --service ao-api
aws ecs delete-service --cluster ai-orchestrator --service ao-webhook
```
