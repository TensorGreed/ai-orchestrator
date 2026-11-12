/**
 * Model-call telemetry: the provider and embedding registries wrapped so every model call gets a `chat` / `embeddings`
 * span and feeds the GenAI duration and token metrics, plus the spend counter fed from where pricing already happens.
 *
 * With tracing off and no metrics export nothing is wrapped (the registries are returned as they are) and nothing
 * from OpenTelemetry is imported: the metrics module is loaded with a dynamic import, and only when metrics export.
 */
import type { GenAiMetricsRecorder } from "@ai-orchestrator/otel";
import {
  createInstrumentedEmbeddingRegistry,
  createInstrumentedProviderRegistry,
  type EmbeddingProviderRegistry,
  type ModelCallInstrumentationOptions,
  type ProviderRegistry
} from "@ai-orchestrator/provider-sdk";
import type { ModelCostObservation, RunInstrumentation } from "@ai-orchestrator/shared";
import type { Telemetry } from "./load.js";

export interface ModelTelemetry {
  /** False while tracing is off and no metrics export: every method then hands its input back or does nothing. */
  readonly active: boolean;
  /** `registry` with each model call recorded (as it is while inactive). */
  providers(registry: ProviderRegistry): ProviderRegistry;
  /** `registry` with each embedding call recorded (as it is while inactive). */
  embeddings(registry: EmbeddingProviderRegistry): EmbeddingProviderRegistry;
  /** Adds priced spend to `l2m.gen_ai.cost`, after its usage row was written. */
  recordCost(observation: ModelCostObservation): void;
  /** What the /v1 gateway annotates its request span with (the no-op while tracing is off). */
  readonly instrumentation: RunInstrumentation;
}

function inactive(instrumentation: RunInstrumentation): ModelTelemetry {
  return Object.freeze({
    active: false,
    providers: (registry: ProviderRegistry) => registry,
    embeddings: (registry: EmbeddingProviderRegistry) => registry,
    recordCost: () => undefined,
    instrumentation
  });
}

export interface ModelTelemetryOptions {
  /** Record the GenAI metrics (a metrics export or a test reader is configured). */
  metrics: boolean;
}

export async function createModelTelemetry(telemetry: Telemetry, options: ModelTelemetryOptions): Promise<ModelTelemetry> {
  let recorder: GenAiMetricsRecorder | null = null;
  if (options.metrics && telemetry.metrics) {
    const { registerGenAiMetrics } = await import("@ai-orchestrator/otel");
    recorder = registerGenAiMetrics(telemetry.metrics.meter, { latestExperimental: telemetry.settings.semconvOptIn.includes("gen_ai_latest_experimental") });
  }
  if (!telemetry.instrumentation.enabled && !recorder) return inactive(telemetry.instrumentation);
  const metrics = recorder;
  const wrapOptions: ModelCallInstrumentationOptions = {
    instrument: telemetry.instrumentation,
    ...(metrics ? { observe: (observation) => metrics.recordModelCall(observation) } : {})
  };
  return {
    active: true,
    providers: (registry) => createInstrumentedProviderRegistry(registry, wrapOptions),
    embeddings: (registry) => createInstrumentedEmbeddingRegistry(registry, wrapOptions),
    recordCost: (observation) => {
      try {
        metrics?.recordCost(observation);
      } catch {
        // Metrics never fail the request or run they describe.
      }
    },
    instrumentation: telemetry.instrumentation
  };
}
