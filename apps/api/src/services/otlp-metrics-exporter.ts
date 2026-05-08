/**
 * Phase 8.1 — OTLP/HTTP-JSON metrics exporter.
 *
 * Periodically snapshots MetricsService and POSTs the OTel data model to an
 * OTLP collector. Counters become `Sum` metrics with `aggregation_temporality=2`
 * (cumulative) and `is_monotonic=true`; gauges become `Gauge` metrics. We
 * deliberately keep the surface tiny — a full SDK with views/instrument
 * factories is far more than this codebase needs and would force MetricsService
 * to become OTel-aware. Instead we export the existing snapshot fields once
 * per push interval; downstream collectors compute rates etc.
 */

import type { MetricsService } from "./metrics-service.js";

interface OtlpMetricsExporterOptions {
  endpoint: string;
  resourceAttributes: Record<string, string>;
  headers?: Record<string, string>;
  intervalMs: number;
  serviceName: string;
}

export class OtlpMetricsExporter {
  private timer: NodeJS.Timeout | null = null;
  private readonly options: OtlpMetricsExporterOptions;
  private readonly metrics: MetricsService;
  private readonly startTimeUnixNano: string;
  private logger?: { warn: (msg: string, fields?: Record<string, unknown>) => void };

  constructor(metrics: MetricsService, options: OtlpMetricsExporterOptions) {
    this.metrics = metrics;
    this.options = options;
    this.startTimeUnixNano = String(Date.now() * 1_000_000);
  }

  setLogger(logger: { warn: (msg: string, fields?: Record<string, unknown>) => void }): void {
    this.logger = logger;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pushOnce();
    }, this.options.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Build the OTLP/HTTP payload from the current snapshot. Public for tests. */
  buildPayload(): unknown {
    const snap = this.metrics.getSnapshot();
    const nowNano = String(Date.now() * 1_000_000);
    const startNano = this.startTimeUnixNano;

    const sum = (name: string, description: string, value: number) => ({
      name,
      description,
      sum: {
        dataPoints: [
          {
            startTimeUnixNano: startNano,
            timeUnixNano: nowNano,
            asInt: String(Math.trunc(value)),
            attributes: []
          }
        ],
        aggregationTemporality: 2,
        isMonotonic: true
      }
    });
    const gauge = (name: string, description: string, value: number, asDouble = false) => ({
      name,
      description,
      gauge: {
        dataPoints: [
          {
            timeUnixNano: nowNano,
            ...(asDouble ? { asDouble: value } : { asInt: String(Math.trunc(value)) }),
            attributes: []
          }
        ]
      }
    });

    const metrics = [
      sum("ao.http.requests.total", "Total HTTP requests processed", snap.httpRequestsTotal),
      sum("ao.workflow.executions.total", "Total workflow executions", snap.executionsTotal),
      sum("ao.workflow.executions.success.total", "Successful executions", snap.executionsSuccess),
      sum("ao.workflow.executions.failure.total", "Failed/canceled executions", snap.executionsFailure),
      gauge("ao.workflow.executions.active", "Currently active workflow executions", snap.activeExecutions),
      gauge("ao.workflow.execution.duration.p50.ms", "Execution latency p50", snap.executionP50Ms),
      gauge("ao.workflow.execution.duration.p95.ms", "Execution latency p95", snap.executionP95Ms),
      gauge("ao.workflow.execution.duration.p99.ms", "Execution latency p99", snap.executionP99Ms),
      gauge("ao.http.request.duration.p50.ms", "HTTP latency p50", snap.httpP50Ms),
      gauge("ao.http.request.duration.p95.ms", "HTTP latency p95", snap.httpP95Ms),
      gauge("ao.slo.success.rate", "Current execution success rate", snap.slo.currentSuccessRate, true),
      gauge("ao.slo.healthy", "1 if SLOs are met, 0 otherwise", snap.slo.healthy ? 1 : 0),
      gauge("ao.uptime.seconds", "Process uptime in seconds", snap.uptimeSeconds)
    ];

    return {
      resourceMetrics: [
        {
          resource: {
            attributes: Object.entries(this.options.resourceAttributes).map(([key, value]) => ({
              key,
              value: { stringValue: value }
            }))
          },
          scopeMetrics: [
            {
              scope: { name: "ai-orchestrator" },
              metrics
            }
          ]
        }
      ]
    };
  }

  async pushOnce(): Promise<void> {
    try {
      const body = JSON.stringify(this.buildPayload());
      const res = await fetch(this.options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.options.headers ?? {}) },
        body
      });
      if (!res.ok) {
        this.logger?.warn("OTLP metrics push rejected", {
          status: res.status,
          endpoint: this.options.endpoint
        });
      }
    } catch (err) {
      this.logger?.warn("OTLP metrics push failed", {
        error: err instanceof Error ? err.message : String(err),
        endpoint: this.options.endpoint
      });
    }
  }
}
