import { describe, it, expect } from "vitest";
import { TracingService, parseKeyValueList, parseTraceparent } from "./services/tracing-service.js";
import { OtlpMetricsExporter } from "./services/otlp-metrics-exporter.js";
import { MetricsService } from "./services/metrics-service.js";
import { loadTestTelemetry } from "./test-support/telemetry.js";

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

    it("percent-decodes keys and values, as the OpenTelemetry specification asks", () => {
      expect(parseKeyValueList("authorization=Basic%20dXNlcjpwYXNz,team%2Fname=a%2Cb,bad=%E0%A4%A")).toEqual({
        authorization: "Basic dXNlcjpwYXNz",
        "team/name": "a,b",
        bad: "%E0%A4%A"
      });
    });

    it("ignores malformed pairs", () => {
      expect(parseKeyValueList(undefined)).toEqual({});
      expect(parseKeyValueList("")).toEqual({});
      expect(parseKeyValueList("=novalue,onlyvalue,key=")).toEqual({});
    });
  });

  describe("TracingService (over the OpenTelemetry SDK)", () => {
    it("exposes resource attributes including the SDK's and service.version", async () => {
      const telemetry = await loadTestTelemetry({
        resourceAttributes: { "service.name": "test-svc", "service.version": "1.2.3", "deployment.environment.name": "staging" }
      });
      const t = new TracingService({ runtime: telemetry.runtime });
      const attrs = t.getResourceAttributes();
      expect(attrs["service.name"]).toBe("test-svc");
      expect(attrs["service.version"]).toBe("1.2.3");
      expect(attrs["deployment.environment.name"]).toBe("staging");
      expect(attrs["telemetry.sdk.name"]).toBe("opentelemetry");
      expect(attrs["telemetry.sdk.language"]).toBe("nodejs");
      await telemetry.runtime?.shutdown();
    });

    it("continues an upstream trace when traceId/parentSpanId are passed", async () => {
      const telemetry = await loadTestTelemetry();
      const t = new TracingService({ runtime: telemetry.runtime });
      const span = t.startSpan({
        operationName: "GET /foo",
        kind: "server",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        parentSpanId: "00f067aa0ba902b7"
      });
      expect(span.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(span.parentSpanId).toBe("00f067aa0ba902b7");
      expect(span.kind).toBe("server");
      t.endSpan(span);
      expect(t.recentSpans()[0]).toMatchObject({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", parentSpanId: "00f067aa0ba902b7", kind: "server", status: "ok" });
      await telemetry.runtime?.shutdown();
    });

    it("toTraceparent renders a valid header value", async () => {
      const telemetry = await loadTestTelemetry();
      const t = new TracingService({ runtime: telemetry.runtime });
      const span = t.startSpan({ operationName: "x" });
      const tp = t.toTraceparent(span);
      expect(parseTraceparent(tp)).not.toBeNull();
      await telemetry.runtime?.shutdown();
    });

    it("retains spans in the in-memory ring buffer when enabled, with error status", async () => {
      const telemetry = await loadTestTelemetry();
      const t = new TracingService({ runtime: telemetry.runtime });
      const span = t.startSpan({ operationName: "test-op" });
      t.setAttribute(span, "k", "v");
      t.endSpan(span, "error");
      expect(t.recentSpans()).toHaveLength(1);
      expect(t.recentSpans()[0]).toMatchObject({ operationName: "test-op", status: "error", attributes: { k: "v" } });
      await telemetry.runtime?.shutdown();
    });

    it("does not retain spans when disabled (no leak in dev)", () => {
      const t = new TracingService({ resourceAttributes: { "service.name": "off" } });
      const span = t.startSpan({ operationName: "ignored" });
      t.endSpan(span);
      expect(t.recentSpans()).toHaveLength(0);
      expect(t.isEnabled()).toBe(false);
      expect(t.getResourceAttributes()).toEqual({ "service.name": "off" });
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
