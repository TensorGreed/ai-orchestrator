/**
 * OpenTelemetry settings, resolved from the validated config. Pure: nothing here imports OpenTelemetry, so the API
 * can decide whether tracing is on before anything from the SDK is loaded.
 */
import crypto from "node:crypto";
import os from "node:os";
import { parseIpAllowlist, splitIpAllowlist } from "@ai-orchestrator/shared";
import type { AppConfig } from "../config.js";

/** The OTEL_TRACES_SAMPLER values (the specification's built-in samplers). */
export const OTEL_TRACES_SAMPLERS = [
  "always_on",
  "always_off",
  "traceidratio",
  "parentbased_always_on",
  "parentbased_always_off",
  "parentbased_traceidratio"
] as const;
export type TraceSampler = (typeof OTEL_TRACES_SAMPLERS)[number];
export type TracePropagator = "tracecontext" | "baggage" | "none";
export type InboundTrust = NonNullable<AppConfig["L2M_OTEL_TRUST_INBOUND"]>;

export interface TelemetrySettings {
  /** True when traces are recorded: an OTLP traces endpoint or TRACING_ENABLED, and OTEL_SDK_DISABLED is not set. */
  enabled: boolean;
  /** Where spans are exported; null while off or with TRACING_ENABLED alone (recent spans only). */
  tracesEndpoint: string | null;
  /** Where the OTLP metrics push goes when OTEL_METRICS_ENABLED; null when it does not run. */
  metricsEndpoint: string | null;
  /** How often metrics are exported (OTEL_METRICS_PUSH_INTERVAL_MS). */
  metricsIntervalMs: number;
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

/** OTEL_PROPAGATORS: unknown entries are skipped with a warning; `none` wins; empty means tracecontext. */
export function parsePropagators(raw: string, warnings: string[] = []): TracePropagator[] {
  const names = raw
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const known: TracePropagator[] = [];
  for (const name of names) {
    if (PROPAGATOR_NAMES.has(name)) {
      if (!known.includes(name as TracePropagator)) known.push(name as TracePropagator);
    } else {
      warnings.push(`OTEL_PROPAGATORS entry "${name}" is not supported (tracecontext, baggage, none) and is ignored`);
    }
  }
  if (known.includes("none")) return ["none"];
  return known.length > 0 ? known : ["tracecontext"];
}

/** A positive whole number from a standard variable, else its default (with a warning when it was set). */
function positiveInt(name: string, raw: string | undefined, fallback: number, warnings: string[]): number {
  const text = raw?.trim();
  if (!text) return fallback;
  const value = Number(text);
  if (Number.isInteger(value) && value > 0) return value;
  warnings.push(`${name}=${text} is not a positive whole number; using ${fallback}`);
  return fallback;
}

/** An endpoint L2M is about to use: it must be an absolute http(s) URL (start-up fails otherwise). */
function requireHttpUrl(name: string, value: string): string {
  let ok = false;
  try {
    const url = new URL(value);
    ok = url.protocol === "http:" || url.protocol === "https:";
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`Invalid environment configuration: ${name} must be an absolute http:// or https:// URL`);
  return value;
}

/**
 * Resolves the OpenTelemetry settings. Throws, naming the setting, only for a bad L2M_OTEL_* value or for an endpoint
 * or protocol L2M is about to use; other unsupported values are ignored with a warning.
 */
export function resolveTelemetrySettings(config: AppConfig): TelemetrySettings {
  const warnings: string[] = [];
  const text = (value: string | undefined) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const tracesSource = text(config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)
    ? "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
    : text(config.OTEL_EXPORTER_OTLP_ENDPOINT)
      ? "OTEL_EXPORTER_OTLP_ENDPOINT"
      : "TRACING_ENDPOINT";
  const tracesEndpoint =
    signalEndpoint(text(config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT), text(config.OTEL_EXPORTER_OTLP_ENDPOINT), "traces") ?? text(config.TRACING_ENDPOINT) ?? null;
  const metricsSource = text(config.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) ? "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT" : "OTEL_EXPORTER_OTLP_ENDPOINT";
  const metricsEndpoint = signalEndpoint(text(config.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT), text(config.OTEL_EXPORTER_OTLP_ENDPOINT), "metrics") ?? null;
  const disabled = text(config.OTEL_SDK_DISABLED)?.toLowerCase() === "true";
  const enabled = !disabled && (Boolean(tracesEndpoint) || config.TRACING_ENABLED);

  if (config.TRACING_ENABLED || text(config.TRACING_ENDPOINT)) {
    warnings.push(
      "TRACING_ENABLED and TRACING_ENDPOINT are deprecated: set OTEL_EXPORTER_OTLP_ENDPOINT (or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) instead"
    );
  }
  if (config.OTEL_DEPLOYMENT_ENVIRONMENT) {
    warnings.push(
      "OTEL_DEPLOYMENT_ENVIRONMENT is deprecated and now sets deployment.environment.name: use OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=<value>"
    );
  }

  // L2M's own settings are always checked: they can only have been meant for L2M.
  const { ranges: trustedProxies, invalid } = parseIpAllowlist(splitIpAllowlist(config.L2M_OTEL_TRUSTED_PROXIES ?? ""));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid environment configuration: L2M_OTEL_TRUSTED_PROXIES entry "${invalid[0]}" is not an IP address or CIDR range ` +
        "(use a comma list such as 10.0.0.0/8, 192.168.1.5)"
    );
  }

  // The standard OTEL_* values are read only while they are used: an environment shared with other tools may hold
  // values L2M does not support, and those must not stop it. Unknown values fall back to the default with a warning,
  // as the specification asks; only an endpoint or protocol L2M is about to use fails start-up.
  const metricsOn = !disabled && config.OTEL_METRICS_ENABLED;
  // Settings shared by both signals (protocol, timeout) are checked when either one is exported.
  const exporting = enabled || (metricsOn && Boolean(metricsEndpoint));
  const used: string[] = enabled ? warnings : [];
  const usedByExport: string[] = exporting ? warnings : [];
  if (enabled && tracesEndpoint) requireHttpUrl(tracesSource, tracesEndpoint);
  if (metricsOn && metricsEndpoint) requireHttpUrl(metricsSource, metricsEndpoint);

  const protocolText = text(config.OTEL_EXPORTER_OTLP_PROTOCOL)?.toLowerCase();
  let protocol: TelemetrySettings["protocol"] = "http/protobuf";
  if (protocolText === "http/json" || protocolText === "http/protobuf") protocol = protocolText;
  else if (protocolText && ((enabled && tracesEndpoint) || (metricsOn && metricsEndpoint))) {
    if (protocolText === "grpc") {
      throw new Error("Invalid environment configuration: OTEL_EXPORTER_OTLP_PROTOCOL=grpc is not shipped; use http/protobuf (the default) or http/json");
    }
    usedByExport.push(`OTEL_EXPORTER_OTLP_PROTOCOL=${protocolText} is not supported; using http/protobuf`);
  }

  const samplerText = text(config.OTEL_TRACES_SAMPLER)?.toLowerCase();
  let sampler: TraceSampler = "parentbased_always_on";
  if (samplerText && (OTEL_TRACES_SAMPLERS as readonly string[]).includes(samplerText)) sampler = samplerText as TraceSampler;
  else if (samplerText) used.push(`OTEL_TRACES_SAMPLER=${samplerText} is not supported; using parentbased_always_on`);
  let ratio: number | undefined;
  if (sampler.endsWith("traceidratio")) {
    const argText = text(config.OTEL_TRACES_SAMPLER_ARG);
    const parsed = argText === undefined ? Number.NaN : Number(argText);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) ratio = parsed;
    else {
      ratio = 1;
      used.push(
        argText === undefined
          ? `OTEL_TRACES_SAMPLER=${sampler} without OTEL_TRACES_SAMPLER_ARG samples every trace (ratio 1)`
          : `OTEL_TRACES_SAMPLER_ARG=${argText} is not a ratio from 0 to 1; using 1`
      );
    }
  }

  const serviceName = config.OTEL_SERVICE_NAME || config.TRACING_SERVICE_NAME;
  const resourceAttributes: Record<string, string> = {
    "service.name": serviceName,
    // Tells replicas apart (OTEL_RESOURCE_ATTRIBUTES can override either).
    "host.name": os.hostname(),
    "process.pid": String(process.pid),
    "service.instance.id": crypto.randomUUID(),
    ...(config.OTEL_SERVICE_VERSION ? { "service.version": config.OTEL_SERVICE_VERSION } : {}),
    ...(config.OTEL_DEPLOYMENT_ENVIRONMENT ? { "deployment.environment.name": config.OTEL_DEPLOYMENT_ENVIRONMENT } : {}),
    ...parseOtelKeyValueList(config.OTEL_RESOURCE_ATTRIBUTES)
  };
  // OTEL_SERVICE_NAME wins over a service.name in OTEL_RESOURCE_ATTRIBUTES, as the specification says.
  if (config.OTEL_SERVICE_NAME) resourceAttributes["service.name"] = config.OTEL_SERVICE_NAME;

  const maxQueueSize = positiveInt("OTEL_BSP_MAX_QUEUE_SIZE", config.OTEL_BSP_MAX_QUEUE_SIZE, 2048, used);
  return {
    enabled,
    tracesEndpoint: enabled ? tracesEndpoint : null,
    metricsEndpoint: metricsOn ? metricsEndpoint : null,
    metricsIntervalMs: config.OTEL_METRICS_PUSH_INTERVAL_MS,
    protocol,
    headers: parseOtelKeyValueList(config.OTEL_EXPORTER_OTLP_HEADERS),
    timeoutMs: positiveInt("OTEL_EXPORTER_OTLP_TIMEOUT", config.OTEL_EXPORTER_OTLP_TIMEOUT, 10_000, usedByExport),
    serviceName: resourceAttributes["service.name"]!,
    resourceAttributes,
    sampler: ratio === undefined ? { name: sampler } : { name: sampler, ratio },
    propagators: parsePropagators(config.OTEL_PROPAGATORS ?? "", used),
    batch: {
      scheduledDelayMs: positiveInt("OTEL_BSP_SCHEDULE_DELAY", config.OTEL_BSP_SCHEDULE_DELAY, 5000, used),
      exportTimeoutMs: positiveInt("OTEL_BSP_EXPORT_TIMEOUT", config.OTEL_BSP_EXPORT_TIMEOUT, 30_000, used),
      maxQueueSize,
      maxExportBatchSize: Math.min(positiveInt("OTEL_BSP_MAX_EXPORT_BATCH_SIZE", config.OTEL_BSP_MAX_EXPORT_BATCH_SIZE, 512, used), maxQueueSize)
    },
    attributeValueLengthLimit: positiveInt("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT", config.OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT, 8192, used),
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
