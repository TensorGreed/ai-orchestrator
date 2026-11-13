---
title: "Observability: logs, metrics and OTLP traces"
description: "Observability for self-hosted L2M: JSON logs with request and trace IDs, Prometheus metrics and SLO numbers, and optional OpenTelemetry export."
---

# Observability

L2M can run in production with standard tooling: JSON request logs, a Prometheus `/metrics` page with SLO numbers, and optional OpenTelemetry traces and metrics over OTLP. The logs and `/metrics` are always there; everything else is opt-in through environment variables, and a deployment that sets none of them runs exactly as before.

## What's emitted

| Signal | Source | Where it lives |
|---|---|---|
| **Logs** | Pino, through Fastify's request logger | stdout (JSON). Every line written while handling a request carries `reqId`. With tracing on, those lines also carry `trace_id` and `span_id`. |
| **Metrics** | `MetricsService` | `GET /metrics` (Prometheus exposition), on by default. Optionally pushed over OTLP. |
| **Traces** | OpenTelemetry SDK, loaded only when tracing is on | Exported over OTLP to the endpoint you set. The last 5,000 spans of each instance are also kept in memory for `GET /api/observability/traces`. |

Traces and OTLP metrics are covered on their own page: **[OpenTelemetry](./opentelemetry.md)**, with a local collector quick start, every setting, the spans and metrics L2M emits, content capture, trust rules for incoming trace context, performance and troubleshooting.

## Logs

The API writes one JSON object per line to stdout. `LOG_LEVEL` sets the level: `warn` by default, so only warnings and errors are written; set `info` to also get an `incoming request` and a `request completed` line per request and the start and end of each run. Request lines carry `reqId`, which is also returned as the `X-Request-ID` response header. Ship stdout with your usual log collector; the audit log is separate from these process logs.

### Trace ids in logs

While tracing is on, each request's log lines (from the tracing hook onwards, including Fastify's `request completed` line) carry `trace_id` and `span_id` next to `reqId`. Other lines written inside a span, such as a run's `Workflow execution started` and `Workflow execution completed`, carry `trace_id`, `span_id` and `trace_flags`. Search your logs for a trace id to find every line of that request or run. The `incoming request` line is written before the span starts and has `reqId` only.

With tracing off, log lines are unchanged. These lines are written at `info`, so set `LOG_LEVEL=info` to see them.

## Prometheus metrics

`GET /metrics` serves the Prometheus text format. It is not behind a sign-in, so keep it on an internal network or limit it with your proxy. Metric names start with `METRICS_PREFIX` (default `ao`): for example `ao_http_requests_total`, `ao_workflow_executions_total`, `ao_workflow_executions_success_total`, `ao_workflow_executions_failure_total`, `ao_workflow_executions_active`, the duration histograms, queue and worker gauges, and `ao_slo_success_rate` and `ao_slo_healthy`. With `METRICS_INCLUDE_PROCESS=true` (the default) it adds the process's memory and the host's load and memory. [`ops/grafana`](https://github.com/TensorGreed/ai-orchestrator/tree/main/ops/grafana) has a dashboard and a scrape configuration.

### SLO numbers

L2M computes two service-level numbers from the runs it has seen since start-up: the share of runs that succeeded, and the p95 run duration. `GET /api/observability/slo` (admin) returns them with their targets and the budget left, and `/metrics` exposes `ao_slo_success_rate` and `ao_slo_healthy` (1 while both targets are met).

| Variable | Default | Meaning |
|---|---|---|
| `METRICS_ENABLED` | `true` | `false` keeps every counter at zero (the page stays). |
| `METRICS_PREFIX` | `ao` | Prefix of every metric name on `/metrics`. |
| `METRICS_INCLUDE_PROCESS` | `true` | Add process and host gauges. |
| `METRICS_SLO_SUCCESS_TARGET` | `0.99` | Target share of successful runs (0 to 1). |
| `METRICS_SLO_P95_LATENCY_MS` | `30000` | Target p95 run duration, in milliseconds. |

The same counters can be pushed over OTLP: see [Metrics over OTLP](./opentelemetry.md#metrics-over-otlp).

## OpenTelemetry

The [OpenTelemetry](./opentelemetry.md) page covers:

- [a quick start with a local collector](./opentelemetry.md#quick-start-with-a-local-collector) and a [smoke test](./opentelemetry.md#smoke-test);
- what is traced: [HTTP requests](./opentelemetry.md#http-server-spans), [runs, nodes, agents and tools](./opentelemetry.md#run-spans), [model calls](./opentelemetry.md#model-spans), [MCP calls and the MCP gateway](./opentelemetry.md#mcp-spans-and-trace-context), [queues and approvals](./opentelemetry.md#queues-clusters-and-approvals);
- [OTLP metrics](./opentelemetry.md#metrics-over-otlp), including [GenAI and cost metrics](./opentelemetry.md#genai-and-cost-metrics);
- [content capture](./opentelemetry.md#content-capture) and the [trace id on runs](./opentelemetry.md#trace-id-on-runs);
- [incoming trace context and who is trusted](./opentelemetry.md#inbound-trace-context-and-who-is-trusted);
- [every setting](./opentelemetry.md#settings), [performance](./opentelemetry.md#performance) and [troubleshooting](./opentelemetry.md#troubleshooting).

## Related

- [OpenTelemetry](./opentelemetry.md)
- [MCP tool-call telemetry](../product/mcp-tool-call-telemetry.md): per-call records of MCP tool use, kept in L2M
- [Scaling](./scaling.md#metrics-to-watch) and [Cluster operations](./cluster.md#metrics): metrics to watch on a fleet
