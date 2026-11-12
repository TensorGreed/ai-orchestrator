import { describe, expect, it } from "vitest";
import { OTLP_PROTOCOLS, PROPAGATOR_NAMES, SAMPLER_NAMES } from "@ai-orchestrator/otel";
import { OTEL_TRACES_SAMPLERS, parseConfig } from "../config.js";
import { parseOtelKeyValueList, resolveTelemetrySettings } from "./settings.js";

const BASE = { SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" };

function settings(env: Record<string, string> = {}) {
  return resolveTelemetrySettings(parseConfig({ ...BASE, ...env }));
}

describe("resolveTelemetrySettings", () => {
  it("is off with nothing set, with the documented defaults", () => {
    const resolved = settings();
    expect(resolved).toMatchObject({
      enabled: false,
      tracesEndpoint: null,
      metricsEndpoint: null,
      protocol: "http/protobuf",
      headers: {},
      timeoutMs: 10_000,
      serviceName: "ai-orchestrator",
      resourceAttributes: { "service.name": "ai-orchestrator" },
      sampler: { name: "parentbased_always_on" },
      propagators: ["tracecontext"],
      batch: { scheduledDelayMs: 5000, exportTimeoutMs: 30_000, maxQueueSize: 2048, maxExportBatchSize: 512 },
      attributeValueLengthLimit: 8192,
      spanDetail: "standard",
      naming: "names",
      propagateToProviders: false,
      propagateToMcp: true,
      semconvOptIn: [],
      httpServerSpans: true,
      trustInbound: "authenticated",
      trustedProxies: [],
      warnings: []
    });
  });

  it("treats blank values as unset", () => {
    const resolved = settings({
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_PROTOCOL: " ",
      OTEL_TRACES_SAMPLER: "",
      OTEL_BSP_MAX_QUEUE_SIZE: "",
      L2M_OTEL_TRUST_INBOUND: "",
      L2M_OTEL_PROPAGATE_TO_MCP: ""
    });
    expect(resolved).toMatchObject({ enabled: false, protocol: "http/protobuf", sampler: { name: "parentbased_always_on" }, trustInbound: "authenticated", propagateToMcp: true });
  });

  it("resolves the traces endpoint: per-signal, else combined plus /v1/traces, else the legacy TRACING_ENDPOINT", () => {
    expect(settings({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/" }).tracesEndpoint).toBe("http://collector:4318/v1/traces");
    expect(
      settings({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.example/otlp" }).tracesEndpoint
    ).toBe("https://traces.example/otlp");
    const legacy = settings({ TRACING_ENDPOINT: "http://old:4318/v1/traces" });
    expect(legacy).toMatchObject({ enabled: true, tracesEndpoint: "http://old:4318/v1/traces" });
    expect(legacy.warnings.join(" ")).toContain("TRACING_ENABLED and TRACING_ENDPOINT are deprecated");
  });

  it("turns on with TRACING_ENABLED alone (recent spans only, no export)", () => {
    expect(settings({ TRACING_ENABLED: "true" })).toMatchObject({ enabled: true, tracesEndpoint: null });
  });

  it("is off with OTEL_SDK_DISABLED=true whatever else is set, the metrics push included", () => {
    const resolved = settings({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", OTEL_METRICS_ENABLED: "true", OTEL_SDK_DISABLED: "true" });
    expect(resolved).toMatchObject({ enabled: false, tracesEndpoint: null, metricsEndpoint: null });
  });

  it("pushes metrics only with OTEL_METRICS_ENABLED", () => {
    expect(settings({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }).metricsEndpoint).toBeNull();
    expect(settings({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", OTEL_METRICS_ENABLED: "true" }).metricsEndpoint).toBe("http://collector:4318/v1/metrics");
  });

  it("percent-decodes headers and resource attributes, and lets OTEL_SERVICE_NAME win", () => {
    const resolved = settings({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Basic%20abc%3D%3D,x-tenant=t1",
      OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attrs,team=platform%2Fai",
      OTEL_SERVICE_NAME: "l2m-prod",
      OTEL_SERVICE_VERSION: "1.2.3"
    });
    expect(resolved.headers).toEqual({ authorization: "Basic abc==", "x-tenant": "t1" });
    expect(resolved.resourceAttributes).toEqual({ "service.name": "l2m-prod", "service.version": "1.2.3", team: "platform/ai" });
    expect(resolved.serviceName).toBe("l2m-prod");
  });

  it("maps the deprecated OTEL_DEPLOYMENT_ENVIRONMENT to deployment.environment.name, with a warning", () => {
    const resolved = settings({ OTEL_DEPLOYMENT_ENVIRONMENT: "production" });
    expect(resolved.resourceAttributes["deployment.environment.name"]).toBe("production");
    expect(resolved.resourceAttributes["deployment.environment"]).toBeUndefined();
    expect(resolved.warnings.join(" ")).toContain("OTEL_DEPLOYMENT_ENVIRONMENT is deprecated");
  });

  it("reads the sampler, propagators, batch and L2M settings", () => {
    const resolved = settings({
      OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
      OTEL_TRACES_SAMPLER_ARG: "0.25",
      OTEL_PROPAGATORS: "tracecontext, baggage,tracecontext",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_TIMEOUT: "2500",
      OTEL_BSP_MAX_QUEUE_SIZE: "100",
      OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "512",
      OTEL_SEMCONV_STABILITY_OPT_IN: "http, gen_ai_latest_experimental",
      L2M_OTEL_SPAN_DETAIL: "verbose",
      L2M_OTEL_NAMES: "ids",
      L2M_OTEL_PROPAGATE_TO_PROVIDERS: "true",
      L2M_OTEL_PROPAGATE_TO_MCP: "false",
      L2M_OTEL_TRUST_INBOUND: "none",
      L2M_OTEL_TRUSTED_PROXIES: "10.0.0.0/8, 192.168.1.5",
      OTEL_HTTP_SERVER_SPANS: "false"
    });
    expect(resolved).toMatchObject({
      sampler: { name: "parentbased_traceidratio", ratio: 0.25 },
      propagators: ["tracecontext", "baggage"],
      protocol: "http/json",
      timeoutMs: 2500,
      batch: { maxQueueSize: 100, maxExportBatchSize: 100 },
      semconvOptIn: ["http", "gen_ai_latest_experimental"],
      spanDetail: "verbose",
      naming: "ids",
      propagateToProviders: true,
      propagateToMcp: false,
      trustInbound: "none",
      trustedProxies: ["10.0.0.0/8", "192.168.1.5/32"],
      httpServerSpans: false
    });
    expect(settings({ OTEL_PROPAGATORS: "baggage,none" }).propagators).toEqual(["none"]);
  });

  it("refuses to start on a bad value, naming the setting", () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ OTEL_EXPORTER_OTLP_ENDPOINT: "collector:4318" }, /OTEL_EXPORTER_OTLP_ENDPOINT must be an absolute/],
      [{ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "ftp://collector/v1/traces" }, /OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be an absolute/],
      [{ TRACING_ENDPOINT: "not a url" }, /TRACING_ENDPOINT must be an absolute/],
      [{ OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }, /OTEL_EXPORTER_OTLP_PROTOCOL must be http\/protobuf or http\/json/],
      [{ OTEL_TRACES_SAMPLER: "sometimes" }, /OTEL_TRACES_SAMPLER must be one of/],
      [{ OTEL_TRACES_SAMPLER: "traceidratio" }, /needs OTEL_TRACES_SAMPLER_ARG/],
      [{ OTEL_TRACES_SAMPLER_ARG: "1.5" }, /OTEL_TRACES_SAMPLER_ARG/],
      [{ OTEL_PROPAGATORS: "tracecontext,b3" }, /OTEL_PROPAGATORS entry "b3"/],
      [{ L2M_OTEL_TRUST_INBOUND: "everyone" }, /L2M_OTEL_TRUST_INBOUND/],
      [{ L2M_OTEL_SPAN_DETAIL: "debug" }, /L2M_OTEL_SPAN_DETAIL/],
      [{ L2M_OTEL_TRUSTED_PROXIES: "10.0.0.0/8,proxy.internal" }, /L2M_OTEL_TRUSTED_PROXIES entry "proxy.internal"/],
      [{ OTEL_BSP_MAX_QUEUE_SIZE: "0" }, /OTEL_BSP_MAX_QUEUE_SIZE/]
    ];
    for (const [env, message] of cases) {
      expect(() => parseConfig({ ...BASE, ...env }), JSON.stringify(env)).toThrow(message);
    }
  });

  it("works on a hand-built config that predates these settings", () => {
    const config = parseConfig(BASE);
    const legacy = { ...config } as Record<string, unknown>;
    for (const key of Object.keys(legacy)) if (key.startsWith("L2M_OTEL_") || key.startsWith("OTEL_BSP_")) delete legacy[key];
    for (const key of ["OTEL_SDK_DISABLED", "OTEL_EXPORTER_OTLP_PROTOCOL", "OTEL_EXPORTER_OTLP_TIMEOUT", "OTEL_TRACES_SAMPLER", "OTEL_PROPAGATORS", "OTEL_SEMCONV_STABILITY_OPT_IN", "OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT"]) delete legacy[key];
    expect(resolveTelemetrySettings(legacy as typeof config)).toMatchObject({ enabled: false, propagators: ["tracecontext"], trustInbound: "authenticated" });
  });

  it("accepts exactly the samplers, propagators and protocols the otel package builds", () => {
    expect([...OTEL_TRACES_SAMPLERS]).toEqual([...SAMPLER_NAMES]);
    expect([...PROPAGATOR_NAMES].sort()).toEqual(["baggage", "none", "tracecontext"]);
    expect([...OTLP_PROTOCOLS]).toEqual(["http/protobuf", "http/json"]);
  });
});

describe("parseOtelKeyValueList", () => {
  it("keeps a malformed percent-encoding as written and skips pairs without a key or value", () => {
    expect(parseOtelKeyValueList("a=%zz,=b,c=,d")).toEqual({ a: "%zz" });
    expect(parseOtelKeyValueList(undefined)).toEqual({});
  });
});
