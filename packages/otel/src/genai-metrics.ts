import { ValueType, type Attributes, type Meter } from "@opentelemetry/api";
import type { ModelCallObservation, ModelCostObservation } from "@ai-orchestrator/shared";
import { ATTR_ERROR_TYPE, ATTR_SERVER_ADDRESS, ATTR_SERVER_PORT, GEN_AI, GEN_AI_METRICS, L2M, L2M_COST_METRIC, genAiProviderName } from "./semconv.js";

/** Bucket advice from the GenAI conventions (the same in v1.41.0 and on the genai repository's main branch). */
export const GEN_AI_DURATION_BUCKETS = Object.freeze([0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92]);
export const GEN_AI_TOKEN_BUCKETS = Object.freeze([1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864]);

/** What the API calls as model calls end and as spend is priced. */
export interface GenAiMetricsRecorder {
  recordModelCall(observation: ModelCallObservation): void;
  recordCost(observation: ModelCostObservation): void;
}

export interface GenAiMetricsOptions {
  /** OTEL_SEMCONV_STABILITY_OPT_IN has `gen_ai_latest_experimental`: the genai repository's main-branch names. */
  latestExperimental: boolean;
}

/** The attributes every GenAI client metric shares (ids and names only, never per-run ids). */
function baseAttributes(observation: ModelCallObservation): Attributes {
  const attributes: Attributes = {
    [GEN_AI.OPERATION_NAME]: observation.operation,
    [GEN_AI.PROVIDER_NAME]: genAiProviderName(observation.providerId),
    [GEN_AI.REQUEST_MODEL]: observation.requestModel
  };
  if (observation.responseModel) attributes[GEN_AI.RESPONSE_MODEL] = observation.responseModel;
  if (observation.serverAddress) {
    attributes[ATTR_SERVER_ADDRESS] = observation.serverAddress;
    if (observation.serverPort !== undefined) attributes[ATTR_SERVER_PORT] = observation.serverPort;
  }
  return attributes;
}

function withError(attributes: Attributes, observation: ModelCallObservation): Attributes {
  return observation.errorType ? { ...attributes, [ATTR_ERROR_TYPE]: observation.errorType } : attributes;
}

const count = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Registers the GenAI client metrics and L2M's cost counter on `meter`.
 *
 * - v1.41.0 (default): `gen_ai.client.operation.duration` (s) and `gen_ai.client.token.usage` ({token},
 *   `gen_ai.token.type` = input | output), for chat and embeddings.
 * - `gen_ai_latest_experimental`: chat reports `gen_ai.client.inference.duration`, the `...inference.usage.*` counters
 *   (`gen_ai.token.modality=unknown`: providers report totals, not a split by modality) and the per-operation token
 *   histograms; embeddings report `gen_ai.client.embeddings.duration` and `...embeddings.operation.input_tokens`.
 *
 * Token metrics are recorded only for counts the provider reported. `l2m.gen_ai.cost` (USD) is the spend L2M priced
 * for a usage row it wrote; it is never priced here.
 */
export function registerGenAiMetrics(meter: Meter, options: GenAiMetricsOptions): GenAiMetricsRecorder {
  const durationAdvice = { advice: { explicitBucketBoundaries: [...GEN_AI_DURATION_BUCKETS] } };
  const tokenAdvice = { advice: { explicitBucketBoundaries: [...GEN_AI_TOKEN_BUCKETS] }, valueType: ValueType.INT };
  const cost = meter.createCounter(L2M_COST_METRIC, {
    description: "Model spend priced by L2M from reported token usage (usage events and /v1 usage rows stay the record)",
    unit: "USD",
    valueType: ValueType.DOUBLE
  });
  const recordCost = (observation: ModelCostObservation): void => {
    if (!Number.isFinite(observation.costUsd) || observation.costUsd <= 0) return;
    cost.add(observation.costUsd, {
      [GEN_AI.PROVIDER_NAME]: genAiProviderName(observation.providerId),
      [GEN_AI.REQUEST_MODEL]: observation.model,
      [L2M.USAGE_SOURCE]: observation.source,
      ...(observation.projectId ? { [L2M.PROJECT_ID]: observation.projectId } : {})
    });
  };

  if (!options.latestExperimental) {
    const names = GEN_AI_METRICS.V1_41;
    const duration = meter.createHistogram(names.OPERATION_DURATION, { description: "GenAI operation duration", unit: "s", ...durationAdvice });
    const tokens = meter.createHistogram(names.TOKEN_USAGE, { description: "Number of input and output tokens used", unit: "{token}", ...tokenAdvice });
    return {
      recordModelCall(observation) {
        const attributes = baseAttributes(observation);
        duration.record(observation.durationMs / 1000, withError(attributes, observation));
        const usage = observation.usage;
        if (count(usage?.inputTokens)) tokens.record(usage.inputTokens, { ...attributes, [GEN_AI.TOKEN_TYPE]: "input" });
        if (count(usage?.outputTokens)) tokens.record(usage.outputTokens, { ...attributes, [GEN_AI.TOKEN_TYPE]: "output" });
      },
      recordCost
    };
  }

  const names = GEN_AI_METRICS.LATEST;
  const inferenceDuration = meter.createHistogram(names.INFERENCE_DURATION, { description: "GenAI client inference operation duration", unit: "s", ...durationAdvice });
  const embeddingsDuration = meter.createHistogram(names.EMBEDDINGS_DURATION, { description: "GenAI client embeddings operation duration", unit: "s", ...durationAdvice });
  const tokenCounter = (name: string, description: string) => meter.createCounter(name, { description, unit: "{token}", valueType: ValueType.INT });
  const inputUsage = tokenCounter(names.INFERENCE_USAGE_INPUT_TOKENS, "The number of input (prompt) tokens used, including cached tokens");
  const outputUsage = tokenCounter(names.INFERENCE_USAGE_OUTPUT_TOKENS, "The number of output (completion) tokens used");
  const cacheReadUsage = tokenCounter(names.INFERENCE_USAGE_CACHE_READ_INPUT_TOKENS, "The number of input tokens served from a provider-managed cache");
  const inputPerCall = meter.createHistogram(names.INFERENCE_OPERATION_INPUT_TOKENS, { description: "Input tokens per inference operation", unit: "{token}", ...tokenAdvice });
  const outputPerCall = meter.createHistogram(names.INFERENCE_OPERATION_OUTPUT_TOKENS, { description: "Output tokens per inference operation", unit: "{token}", ...tokenAdvice });
  const embeddingInputPerCall = meter.createHistogram(names.EMBEDDINGS_OPERATION_INPUT_TOKENS, { description: "Input tokens per embeddings operation", unit: "{token}", ...tokenAdvice });
  return {
    recordModelCall(observation) {
      const attributes = baseAttributes(observation);
      const usage = observation.usage;
      if (observation.operation === "embeddings") {
        embeddingsDuration.record(observation.durationMs / 1000, withError(attributes, observation));
        if (count(usage?.inputTokens)) embeddingInputPerCall.record(usage.inputTokens, withError(attributes, observation));
        return;
      }
      inferenceDuration.record(observation.durationMs / 1000, withError(attributes, observation));
      const byModality = { ...attributes, [GEN_AI.TOKEN_MODALITY]: "unknown" };
      if (count(usage?.inputTokens)) {
        if (usage.inputTokens > 0) inputUsage.add(usage.inputTokens, byModality);
        inputPerCall.record(usage.inputTokens, withError(attributes, observation));
      }
      if (count(usage?.outputTokens)) {
        if (usage.outputTokens > 0) outputUsage.add(usage.outputTokens, byModality);
        outputPerCall.record(usage.outputTokens, withError(attributes, observation));
      }
      if (count(usage?.cachedInputTokens) && usage.cachedInputTokens > 0) cacheReadUsage.add(usage.cachedInputTokens, byModality);
    },
    recordCost
  };
}
