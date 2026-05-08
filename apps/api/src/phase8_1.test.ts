import { describe, it, expect } from "vitest";
import { TracingService, parseKeyValueList, parseTraceparent } from "./services/tracing-service.js";
import { OtlpMetricsExporter } from "./services/otlp-metrics-exporter.js";
import { MetricsService } from "./services/metrics-service.js";

describe("Phase 8.1 — OpenTelemetry bridge", () => {
  describe("parseTraceparent", () => {
    it("parses a valid W3C traceparent value", () => {
      const result = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
      expect(result).toEqual({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        parentSpanId: "00f067aa0ba902b7",
        sampled: true
      });
    });

    it("returns null for malformed values", () => {
      expect(parseTraceparent(undefined)).toBeNull();
      expect(parseTraceparent("")).toBeNull();
      expect(parseTraceparent("not-a-traceparent")).toBeNull();
      expect(parseTraceparent("00-short-00f067aa0ba902b7-01")).toBeNull();
      expect(parseTraceparent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull(); // wrong version
    });

    it("flags sampled=false when bit 0 is unset", () => {
      const r = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00");
      expect(r?.sampled).toBe(false);
    });
  });

  describe("parseKeyValueList", () => {
    it("parses comma-separated key=value pairs", () => {
      const out = parseKeyValueList("key1=value1, key2 = value2, deployment.env=prod");
      expect(out).toEqual({
        key1: "value1",
        key2: "value2",
        "deployment.env": "prod"
      });
    });

    it("ignores malformed pairs", () => {
      expect(parseKeyValueList(undefined)).toEqual({});
      expect(parseKeyValueList("")).toEqual({});
      expect(parseKeyValueList("=novalue,onlyvalue,key=")).toEqual({});
    });
  });

  describe("TracingService", () => {
    it("exposes resource attributes including host.name and service.version", () => {
      const t = new TracingService({
        enabled: true,
        serviceName: "test-svc",
        resourceAttributes: { "service.version": "1.2.3", "deployment.environment": "staging" }
      });
      const attrs = t.getResourceAttributes();
      expect(attrs["service.name"]).toBe("test-svc");
      expect(attrs["service.version"]).toBe("1.2.3");
      expect(attrs["deployment.environment"]).toBe("staging");
      expect(attrs["host.name"]).toBeTypeOf("string");
      expect(attrs["telemetry.sdk.name"]).toBe("ai-orchestrator");
    });

    it("continues an upstream trace when traceId/parentSpanId are passed", () => {
      const t = new TracingService({ enabled: true });
      const span = t.startSpan({
        operationName: "GET /foo",
        kind: "server",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        parentSpanId: "00f067aa0ba902b7"
      });
      expect(span.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(span.parentSpanId).toBe("00f067aa0ba902b7");
      expect(span.kind).toBe("server");
    });

    it("toTraceparent renders a valid header value", () => {
      const t = new TracingService({ enabled: true });
      const span = t.startSpan({ operationName: "x" });
      const tp = t.toTraceparent(span);
      expect(parseTraceparent(tp)).not.toBeNull();
    });

    it("retains spans in the in-memory ring buffer when enabled", () => {
      const t = new TracingService({ enabled: true });
      const span = t.startSpan({ operationName: "test-op" });
      t.endSpan(span, "ok");
      expect(t.recentSpans()).toHaveLength(1);
      expect(t.recentSpans()[0]!.operationName).toBe("test-op");
    });

    it("does not retain spans when disabled (no leak in dev)", () => {
      const t = new TracingService({ enabled: false });
      const span = t.startSpan({ operationName: "ignored" });
      t.endSpan(span);
      expect(t.recentSpans()).toHaveLength(0);
    });
  });

  describe("OtlpMetricsExporter.buildPayload", () => {
    it("emits OTel-shape resourceMetrics with sums + gauges", () => {
      const m = new MetricsService();
      m.recordHttpRequest("GET", 200, 42);
      m.recordExecution("success", 1500);

      const exporter = new OtlpMetricsExporter(m, {
        endpoint: "http://localhost:4318/v1/metrics",
        resourceAttributes: { "service.name": "ai-orchestrator", "deployment.environment": "test" },
        intervalMs: 60000,
        serviceName: "ai-orchestrator"
      });

      const payload = exporter.buildPayload() as {
        resourceMetrics: Array<{
          resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
          scopeMetrics: Array<{
            metrics: Array<{
              name: string;
              sum?: { dataPoints: Array<{ asInt: string }>; isMonotonic: boolean };
              gauge?: { dataPoints: Array<unknown> };
            }>;
          }>;
        }>;
      };

      expect(payload.resourceMetrics).toHaveLength(1);
      const rm = payload.resourceMetrics[0]!;
      const resourceKeys = rm.resource.attributes.map((a) => a.key);
      expect(resourceKeys).toContain("service.name");
      expect(resourceKeys).toContain("deployment.environment");

      const metricNames = rm.scopeMetrics[0]!.metrics.map((x) => x.name);
      expect(metricNames).toContain("ao.http.requests.total");
      expect(metricNames).toContain("ao.workflow.executions.total");
      expect(metricNames).toContain("ao.slo.healthy");

      const httpTotal = rm.scopeMetrics[0]!.metrics.find((x) => x.name === "ao.http.requests.total");
      expect(httpTotal?.sum?.isMonotonic).toBe(true);
      expect(httpTotal?.sum?.dataPoints[0]!.asInt).toBe("1");
    });
  });
});
