import { afterEach, describe, expect, it } from "vitest";
import type { ModelCallObservation } from "@ai-orchestrator/shared";
import {
  AggregationTemporality,
  createMetricsPipeline,
  GEN_AI_DURATION_BUCKETS,
  GEN_AI_TOKEN_BUCKETS,
  genAiProviderName,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  registerGenAiMetrics,
  type ResourceMetrics
} from "./index.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function collect(latestExperimental: boolean, record: (recorder: ReturnType<typeof registerGenAiMetrics>) => void) {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  const pipeline = createMetricsPipeline({ resourceAttributes: { "service.name": "t" }, export: null, readers: [reader] });
  cleanup.push(() => pipeline.shutdown());
  record(registerGenAiMetrics(pipeline.meter, { latestExperimental }));
  await pipeline.forceFlush();
  const metrics = exporter.getMetrics().flatMap((resourceMetrics: ResourceMetrics) => resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics));
  return new Map(metrics.filter((metric) => metric.dataPoints.length > 0).map((metric) => [metric.descriptor.name, metric] as const));
}

const chat: ModelCallObservation = {
  operation: "chat",
  providerId: "openai_compatible",
  requestModel: "up-model",
  responseModel: "up-model-2026",
  serverAddress: "models.internal",
  serverPort: 443,
  stream: false,
  durationMs: 1500,
  usage: { inputTokens: 30, outputTokens: 12, cachedInputTokens: 10 }
};

const common = {
  "gen_ai.operation.name": "chat",
  "gen_ai.provider.name": "openai",
  "gen_ai.request.model": "up-model",
  "gen_ai.response.model": "up-model-2026",
  "server.address": "models.internal",
  "server.port": 443
};

describe("GenAI client metrics (v1.41.0, the default)", () => {
  it("records duration and token usage by token type, with the spec's buckets", async () => {
    const byName = await collect(false, (recorder) => {
      recorder.recordModelCall(chat);
      recorder.recordModelCall({ ...chat, usage: undefined, durationMs: 200, errorType: "timeout" });
    });
    expect([...byName.keys()].sort()).toEqual(["gen_ai.client.operation.duration", "gen_ai.client.token.usage"]);
    const duration = byName.get("gen_ai.client.operation.duration")!;
    expect(duration.descriptor.unit).toBe("s");
    const points = duration.dataPoints as Array<{ attributes: Record<string, unknown>; value: { sum: number; buckets: { boundaries: number[] } } }>;
    expect(points.find((point) => !point.attributes["error.type"])).toMatchObject({ attributes: common, value: { sum: 1.5 } });
    expect(points.find((point) => point.attributes["error.type"] === "timeout")?.value.sum).toBe(0.2);
    expect(points[0]!.value.buckets.boundaries).toEqual([...GEN_AI_DURATION_BUCKETS]);

    const tokens = byName.get("gen_ai.client.token.usage")!;
    expect(tokens.descriptor.unit).toBe("{token}");
    const tokenPoints = tokens.dataPoints as Array<{ attributes: Record<string, unknown>; value: { sum: number; count: number; buckets: { boundaries: number[] } } }>;
    expect(tokenPoints).toHaveLength(2);
    expect(tokenPoints.find((point) => point.attributes["gen_ai.token.type"] === "input")).toMatchObject({ attributes: { ...common, "gen_ai.token.type": "input" }, value: { sum: 30, count: 1 } });
    expect(tokenPoints.find((point) => point.attributes["gen_ai.token.type"] === "output")?.value.sum).toBe(12);
    expect(tokenPoints[0]!.value.buckets.boundaries).toEqual([...GEN_AI_TOKEN_BUCKETS]);
  });

  it("records embeddings under the same names, with operation embeddings", async () => {
    const byName = await collect(false, (recorder) =>
      recorder.recordModelCall({ operation: "embeddings", providerId: "azure_openai", requestModel: "embed", stream: false, durationMs: 50, usage: { inputTokens: 8 } })
    );
    const tokens = byName.get("gen_ai.client.token.usage")!.dataPoints as Array<{ attributes: Record<string, unknown> }>;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.attributes).toEqual({ "gen_ai.operation.name": "embeddings", "gen_ai.provider.name": "azure.ai.openai", "gen_ai.request.model": "embed", "gen_ai.token.type": "input" });
  });
});

describe("GenAI client metrics with gen_ai_latest_experimental", () => {
  it("uses the genai repository's main-branch names: inference duration, usage counters and per-operation histograms", async () => {
    const byName = await collect(true, (recorder) => {
      recorder.recordModelCall(chat);
      recorder.recordModelCall({ operation: "embeddings", providerId: "openai", requestModel: "e", stream: false, durationMs: 10, usage: { inputTokens: 4 } });
    });
    expect([...byName.keys()].sort()).toEqual([
      "gen_ai.client.embeddings.duration",
      "gen_ai.client.embeddings.operation.input_tokens",
      "gen_ai.client.inference.duration",
      "gen_ai.client.inference.operation.input_tokens",
      "gen_ai.client.inference.operation.output_tokens",
      "gen_ai.client.inference.usage.cache_read.input_tokens",
      "gen_ai.client.inference.usage.input_tokens",
      "gen_ai.client.inference.usage.output_tokens"
    ]);
    const input = byName.get("gen_ai.client.inference.usage.input_tokens")!.dataPoints[0] as { attributes: Record<string, unknown>; value: number };
    expect(input).toMatchObject({ attributes: { ...common, "gen_ai.token.modality": "unknown" }, value: 30 });
    expect((byName.get("gen_ai.client.inference.usage.cache_read.input_tokens")!.dataPoints[0] as { value: number }).value).toBe(10);
    expect((byName.get("gen_ai.client.inference.operation.output_tokens")!.dataPoints[0] as { attributes: Record<string, unknown> }).attributes).toEqual(common);
    expect(byName.has("gen_ai.client.token.usage")).toBe(false);
    expect(byName.has("gen_ai.client.operation.duration")).toBe(false);
  });
});

describe("l2m.gen_ai.cost", () => {
  it("adds priced spend by provider, model, project and source, and ignores zero", async () => {
    const byName = await collect(false, (recorder) => {
      recorder.recordCost({ providerId: "openai_compatible", model: "up-model", projectId: "default", costUsd: 0.25, source: "run" });
      recorder.recordCost({ providerId: "openai_compatible", model: "up-model", projectId: "default", costUsd: 0.5, source: "run" });
      recorder.recordCost({ providerId: "openai", model: "x", projectId: null, costUsd: 0, source: "ai_gateway" });
    });
    const cost = byName.get("l2m.gen_ai.cost")!;
    expect(cost.descriptor.unit).toBe("USD");
    expect(cost.dataPoints).toHaveLength(1);
    expect(cost.dataPoints[0]).toMatchObject({
      attributes: { "gen_ai.provider.name": "openai", "gen_ai.request.model": "up-model", "l2m.project.id": "default", "l2m.usage.source": "run" },
      value: 0.75
    });
  });
});

describe("provider names", () => {
  it("maps the registry's ids (underscored) and the older dashed spellings", () => {
    expect(genAiProviderName("openai_compatible")).toBe("openai");
    expect(genAiProviderName("azure_openai")).toBe("azure.ai.openai");
    expect(genAiProviderName("azure-openai")).toBe("azure.ai.openai");
    expect(genAiProviderName("gemini")).toBe("gcp.gemini");
    expect(genAiProviderName("echo")).toBe("echo");
  });
});
