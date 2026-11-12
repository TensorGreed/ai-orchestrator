/**
 * OpenTelemetry settings, resolved from the validated config. Pure: nothing here imports OpenTelemetry, so the API
 * can decide whether tracing is on before anything from the SDK is loaded.
 */
import { parseIpAllowlist, splitIpAllowlist } from "@ai-orchestrator/shared";
import type { AppConfig } from "../config.js";

export type TraceSampler = NonNullable<AppConfig["OTEL_TRACES_SAMPLER"]>;
export type TracePropagator = "tracecontext" | "baggage" | "none";
export type InboundTrust = NonNullable<AppConfig["L2M_OTEL_TRUST_INBOUND"]>;

export interface TelemetrySettings {
  /** True when traces are recorded: an OTLP traces endpoint or TRACING_ENABLED, and OTEL_SDK_DISABLED is not set. */
  enabled: boolean;
  /** Where spans are exported; null while off or with TRACING_ENABLED alone (recent spans only). */
  tracesEndpoint: string | null;
  /** Where the OTLP metrics push goes when OTEL_METRICS_ENABLED; null when it does not run. */
  metricsEndpoint: string | null;
  protocol: "http/protobuf" | "http/json";
  /** Percent-decoded OTEL_EXPORTER_OTLP_HEADERS. Never echoed: only the names are shown. */
  headers: Record<string, string>;
  timeoutMs: number;
  serviceName: string;
  /** service.name, service.version, deployment.environment.name and OTEL_RESOURCE_ATTRIBUTES (decoded). */
  resourceAttributes: Record<string, string>;
  sampler: { name: TraceSampler; ratio?: number };
  propagators: TracePropagator[];
  batch: { scheduledDelayMs: number; exportTimeoutMs: number; maxQueueSize: number; maxExportBatchSize: number };
  attributeValueLengthLimit: number;
  spanDetail: "standard" | "verbose";
  naming: "names" | "ids";
  propagateToProviders: boolean;
  propagateToMcp: boolean;
  semconvOptIn: string[];
  httpServerSpans: boolean;
  trustInbound: InboundTrust;
  /** Canonical ranges from L2M_OTEL_TRUSTED_PROXIES. */
  trustedProxies: string[];
  /** Start-up warnings (deprecated settings in use). */
  warnings: string[];
}

/**
 * Parses an OTEL_RESOURCE_ATTRIBUTES / OTEL_EXPORTER_OTLP_HEADERS value: comma-separated `key=value` pairs, both
 * sides trimmed and percent-decoded as the specification asks. Pairs without a key or a value are skipped; a value
 * whose percent-encoding is malformed is kept as written.
 */
export function parseOtelKeyValueList(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = decodePercent(pair.slice(0, index).trim());
    const entry = decodePercent(pair.slice(index + 1).trim());
    if (key && entry) out[key] = entry;
  }
  return out;
}

function decodePercent(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The per-signal endpoint, else the combined one plus `/v1/<signal>`. */
function signalEndpoint(perSignal: string | undefined, combined: string | undefined, signal: "traces" | "metrics"): string | undefined {
  if (perSignal) return perSignal;
  if (combined) return `${combined.replace(/\/+$/, "")}/v1/${signal}`;
  return undefined;
}

const PROPAGATOR_NAMES: ReadonlySet<string> = new Set(["tracecontext", "baggage", "none"]);

export function parsePropagators(raw: string): TracePropagator[] {
  const names = raw
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  for (const name of names) {
    if (!PROPAGATOR_NAMES.has(name)) {
      throw new Error(`Invalid environment configuration: OTEL_PROPAGATORS entry "${name}" is not tracecontext, baggage or none`);
    }
  }
  if (names.length === 0) return ["tracecontext"];
  if (names.includes("none")) return ["none"];
  return [...new Set(names)] as TracePropagator[];
}

/** Resolves (and validates) the OpenTelemetry settings. Throws with the setting's name on a bad value. */
export function resolveTelemetrySettings(config: AppConfig): TelemetrySettings {
  const warnings: string[] = [];
  const tracesEndpoint =
    signalEndpoint(config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, config.OTEL_EXPORTER_OTLP_ENDPOINT, "traces") ?? config.TRACING_ENDPOINT ?? null;
  const metricsEndpoint = signalEndpoint(config.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, config.OTEL_EXPORTER_OTLP_ENDPOINT, "metrics") ?? null;
  const disabled = config.OTEL_SDK_DISABLED === true;
  const enabled = !disabled && (Boolean(tracesEndpoint) || config.TRACING_ENABLED);

  if (config.TRACING_ENABLED || config.TRACING_ENDPOINT) {
    warnings.push(
      "TRACING_ENABLED and TRACING_ENDPOINT are deprecated: set OTEL_EXPORTER_OTLP_ENDPOINT (or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) instead"
    );
  }
  if (config.OTEL_DEPLOYMENT_ENVIRONMENT) {
    warnings.push(
      "OTEL_DEPLOYMENT_ENVIRONMENT is deprecated and now sets deployment.environment.name: use OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=<value>"
    );
  }

  const sampler: TraceSampler = config.OTEL_TRACES_SAMPLER ?? "parentbased_always_on";
  const ratio = config.OTEL_TRACES_SAMPLER_ARG;
  if (sampler.endsWith("traceidratio") && ratio === undefined) {
    throw new Error(`Invalid environment configuration: OTEL_TRACES_SAMPLER=${sampler} needs OTEL_TRACES_SAMPLER_ARG, a ratio from 0 to 1`);
  }

  const { ranges: trustedProxies, invalid } = parseIpAllowlist(splitIpAllowlist(config.L2M_OTEL_TRUSTED_PROXIES ?? ""));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid environment configuration: L2M_OTEL_TRUSTED_PROXIES entry "${invalid[0]}" is not an IP address or CIDR range ` +
        "(use a comma list such as 10.0.0.0/8, 192.168.1.5)"
    );
  }

  const serviceName = config.OTEL_SERVICE_NAME || config.TRACING_SERVICE_NAME;
  const resourceAttributes: Record<string, string> = {
    "service.name": serviceName,
    ...(config.OTEL_SERVICE_VERSION ? { "service.version": config.OTEL_SERVICE_VERSION } : {}),
    ...(config.OTEL_DEPLOYMENT_ENVIRONMENT ? { "deployment.environment.name": config.OTEL_DEPLOYMENT_ENVIRONMENT } : {}),
    ...parseOtelKeyValueList(config.OTEL_RESOURCE_ATTRIBUTES)
  };
  // OTEL_SERVICE_NAME wins over a service.name in OTEL_RESOURCE_ATTRIBUTES, as the specification says.
  if (config.OTEL_SERVICE_NAME) resourceAttributes["service.name"] = config.OTEL_SERVICE_NAME;

  const maxQueueSize = config.OTEL_BSP_MAX_QUEUE_SIZE ?? 2048;
  return {
    enabled,
    tracesEndpoint: enabled ? tracesEndpoint : null,
    metricsEndpoint: !disabled && config.OTEL_METRICS_ENABLED ? metricsEndpoint : null,
    protocol: config.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf",
    headers: parseOtelKeyValueList(config.OTEL_EXPORTER_OTLP_HEADERS),
    timeoutMs: config.OTEL_EXPORTER_OTLP_TIMEOUT ?? 10_000,
    serviceName: resourceAttributes["service.name"]!,
    resourceAttributes,
    sampler: ratio === undefined ? { name: sampler } : { name: sampler, ratio },
    propagators: parsePropagators(config.OTEL_PROPAGATORS ?? ""),
    batch: {
      scheduledDelayMs: config.OTEL_BSP_SCHEDULE_DELAY ?? 5000,
      exportTimeoutMs: config.OTEL_BSP_EXPORT_TIMEOUT ?? 30_000,
      maxQueueSize,
      maxExportBatchSize: Math.min(config.OTEL_BSP_MAX_EXPORT_BATCH_SIZE ?? 512, maxQueueSize)
    },
    attributeValueLengthLimit: config.OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT ?? 8192,
    spanDetail: config.L2M_OTEL_SPAN_DETAIL ?? "standard",
    naming: config.L2M_OTEL_NAMES ?? "names",
    propagateToProviders: config.L2M_OTEL_PROPAGATE_TO_PROVIDERS === true,
    propagateToMcp: config.L2M_OTEL_PROPAGATE_TO_MCP !== false,
    semconvOptIn: (config.OTEL_SEMCONV_STABILITY_OPT_IN ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    httpServerSpans: config.OTEL_HTTP_SERVER_SPANS !== false,
    trustInbound: config.L2M_OTEL_TRUST_INBOUND ?? "authenticated",
    trustedProxies,
    warnings
  };
}
