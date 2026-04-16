# Grafana dashboard — ai-orchestrator

Drop [ai-orchestrator-dashboard.json](./ai-orchestrator-dashboard.json) into Grafana via **Dashboards → Import** and point the `datasource` variable at the Prometheus instance scraping `/metrics` on the API.

Suggested Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: ai-orchestrator
    metrics_path: /metrics
    scrape_interval: 15s
    static_configs:
      - targets: ["ai-orchestrator-api:4000"]
```

The dashboard panels assume the default metric prefix `ao`. If you override `METRICS_PREFIX`, rewrite the expressions accordingly.

Panels:

- Active workflow executions (gauge)
- SLO: execution success rate (percent)
- SLO: p95 latency (ms)
- Uptime
- Execution throughput — total/success/failure rate per minute
- Execution latency — p50/p95/p99 quantiles from the histogram
- HTTP request rate by status class
- HTTP latency p95
- Process memory (heap + RSS)
- System load average (1m)
