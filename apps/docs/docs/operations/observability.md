# Observability

L2M ships first-class observability so you can run it in production with confidence: structured request logs with trace correlation, Prometheus metrics, OTLP traces, OTLP metrics, and SLO budgets — all opt-in via env vars.

## What's emitted

Three signals are always available, even with no external collector:

| Signal | Source | Where it lives |
|---|---|---|
| **Logs** | Pino, via Fastify's request logger | stdout (JSON), with `reqId` keyed on every line |
| **Metrics** | `MetricsService` | `GET /metrics` (Prometheus exposition) |
| **Traces** | `TracingService` | `GET /api/observability/traces` (in-memory ring buffer, 5,000 spans) |

Phase 8.1 added an OpenTelemetry export path so these can be shipped to any OTLP/HTTP collector — Grafana Tempo, Honeycomb, Datadog, New Relic, OTel Collector, etc.

## Quickstart: ship traces + metrics to an OTel collector

Set one variable. The others have sensible defaults.

```bash
# Combined endpoint — traces go to /v1/traces, metrics to /v1/metrics
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318

# Optional: enrich every span/metric with deployment context
OTEL_SERVICE_NAME=ai-orchestrator
OTEL_SERVICE_VERSION=0.1.0
OTEL_DEPLOYMENT_ENVIRONMENT=production
OTEL_RESOURCE_ATTRIBUTES=team=platform,region=us-east-1

# Opt in to metrics push (traces are auto-on whenever endpoint is set)
OTEL_METRICS_ENABLED=true
OTEL_METRICS_PUSH_INTERVAL_MS=60000
```

For per-signal endpoints (e.g. traces to Tempo, metrics to Prometheus remote-write via the collector) use `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` to override the combined one.

## Auth headers (Honeycomb / Grafana Cloud)

`OTEL_EXPORTER_OTLP_HEADERS` is a comma-separated `key=value` list added to every OTLP request:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=YOUR_API_KEY,x-honeycomb-dataset=l2m-prod
```

## W3C trace-context propagation

When `OTEL_HTTP_SERVER_SPANS=true` (default) every HTTP request opens an OTel `SERVER` span. If the upstream sends a `traceparent` header, L2M adopts the trace ID — so your trace flows continuously across nginx/ALB/Cloudflare → L2M → downstream LLM/MCP calls without breaking.

Skipped paths: `/health`, `/metrics` — these would otherwise dominate any "top spans by count" view.

## Resource attributes

Every span and metric is tagged with the following resource attributes by default:

- `service.name` — `OTEL_SERVICE_NAME` or `TRACING_SERVICE_NAME`
- `service.version` — `OTEL_SERVICE_VERSION` if set
- `deployment.environment` — `OTEL_DEPLOYMENT_ENVIRONMENT` if set
- `host.name` — auto-detected
- `process.pid` — current PID
- `telemetry.sdk.name` — `ai-orchestrator`
- `telemetry.sdk.language` — `nodejs`

Plus any `key=value` pairs you supply via `OTEL_RESOURCE_ATTRIBUTES`.

## Backward compatibility

The legacy `TRACING_ENABLED` / `TRACING_ENDPOINT` / `TRACING_SERVICE_NAME` vars still work. If both are set, `OTEL_EXPORTER_OTLP_*` takes precedence for endpoint resolution; resource attributes are merged.

## Verifying it works

`GET /api/observability` returns:

```json
{
  "metrics": { "executionsTotal": 12, "slo": { "healthy": true, ... } },
  "tracing": {
    "enabled": true,
    "tracesEndpoint": "http://otel-collector:4318/v1/traces",
    "resourceAttributes": { "service.name": "ai-orchestrator", ... }
  },
  "otlpMetrics": {
    "enabled": true,
    "endpoint": "http://otel-collector:4318/v1/metrics",
    "intervalMs": 60000
  }
}
```

If the collector is unreachable, exports are dropped silently — observability never blocks the hot path.
