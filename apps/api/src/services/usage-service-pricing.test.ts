import { describe, expect, it } from "vitest";
import { extractAnthropicUsage, extractGeminiUsage } from "@ai-orchestrator/provider-sdk";
import type { Store } from "../db/store.js";
import { DEFAULT_PRICING, UsageService, canonicalPricingProviderId } from "./usage-service.js";

function service(pricingOverridesJson?: string) {
  const writes: Array<Record<string, unknown>> = [];
  const store = { writeUsageEvent: async (row: Record<string, unknown>) => void writes.push(row) } as unknown as Store;
  return { usage: new UsageService(store, pricingOverridesJson === undefined ? {} : { pricingOverridesJson }), writes };
}

describe("Anthropic cached tokens", () => {
  // claude-sonnet-5-5: $2 input, $0.10 cache read, $10 output per 1M tokens.
  it("bills cache reads at the cached rate and the rest of the prompt at the input rate", () => {
    const { usage } = service();
    const tokens = extractAnthropicUsage({ input_tokens: 100_000, cache_read_input_tokens: 900_000, output_tokens: 10_000 })!;
    expect(tokens).toEqual({ inputTokens: 1_000_000, outputTokens: 10_000, totalTokens: 1_010_000, cachedInputTokens: 900_000 });
    const cost = usage.estimateCostUsd("anthropic", "claude-sonnet-5-5", tokens.inputTokens!, tokens.outputTokens!, tokens.cachedInputTokens!);
    // 0.1M × $2 + 0.9M × $0.10 + 0.01M × $10
    expect(cost).toBeCloseTo(0.2 + 0.09 + 0.1, 6);
  });

  it("bills cache writes as input", () => {
    const { usage } = service();
    const tokens = extractAnthropicUsage({ input_tokens: 10, cache_creation_input_tokens: 500_000, output_tokens: 0 })!;
    expect(usage.estimateCostUsd("anthropic", "claude-sonnet-5-5", tokens.inputTokens!, 0, tokens.cachedInputTokens ?? 0)).toBeCloseTo(1.00002, 6);
  });

  it("never bills more cached tokens than the prompt has", () => {
    const { usage } = service();
    // A count where the cache reads exceed the prompt (Anthropic's raw shape before conversion) costs the prompt only.
    expect(usage.estimateCostUsd("anthropic", "claude-sonnet-5-5", 100, 0, 900_000)).toBeCloseTo((100 / 1_000_000) * 0.1, 9);
  });
});

describe("published cache-read prices", () => {
  it("prices cache reads for every current Claude model, at the published rate", () => {
    const anthropic = DEFAULT_PRICING.anthropic!;
    for (const model of ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-5-5", "claude-haiku-4-5"]) {
      expect(anthropic[model]?.cachedInputUsdPer1M, model).toBeCloseTo(anthropic[model]!.inputUsdPer1M * 0.1, 9);
    }
    expect(anthropic["claude-sonnet-5-5"]?.cachedInputUsdPer1M).toBe(0.1);
    expect(anthropic["claude-opus-5-5"]?.cachedInputUsdPer1M).toBe(0.2);
  });

  it("prices Gemini 2.5 models out of the box, thinking at the output rate", () => {
    const { usage } = service();
    expect(usage.estimateCostUsd("gemini", "gemini-2.5-flash", 1_000_000, 1_000_000, 500_000)).toBeCloseTo(0.15 + 0.015 + 2.5, 6);
    expect(usage.estimateCostUsd("gemini", "gemini-2.5-pro", 1_000_000, 0, 0)).toBe(1.25);
    expect(usage.estimateCostUsd("gemini", "gemini-2.5-flash-lite", 0, 1_000_000, 0)).toBe(0.4);
  });
});

describe("Gemini thinking tokens", () => {
  it("bills thinking at the output rate", () => {
    const { usage } = service(JSON.stringify({ gemini: { "gemini-2.5-flash": { inputUsdPer1M: 0.3, outputUsdPer1M: 2.5, cachedInputUsdPer1M: 0.03 } } }));
    const tokens = extractGeminiUsage({ promptTokenCount: 1_000_000, cachedContentTokenCount: 500_000, candidatesTokenCount: 0, thoughtsTokenCount: 1_000_000 })!;
    const cost = usage.estimateCostUsd("gemini", "gemini-2.5-flash", tokens.inputTokens!, tokens.outputTokens!, tokens.cachedInputTokens!);
    expect(cost).toBeCloseTo(0.5 * 0.3 + 0.5 * 0.03 + 2.5, 6);
  });
});

describe("pricing provider ids", () => {
  it("files every built-in price under an adapter's id", () => {
    for (const providerId of Object.keys(DEFAULT_PRICING)) expect(providerId).toBe(canonicalPricingProviderId(providerId));
    const { usage } = service();
    // No empty entries under a spelling no run records; Azure stays out of the run table (see phase8_2.test.ts).
    expect(usage.getPricing()).not.toHaveProperty("azure_openai");
    expect(usage.getPricing()).not.toHaveProperty("azure-openai");
    expect(usage.getPricing()).not.toHaveProperty("openai-compatible");
  });

  it("prices an Azure run from an override written either way", async () => {
    for (const key of ["azure_openai", "azure-openai", "Azure-OpenAI"]) {
      const { usage, writes } = service(JSON.stringify({ [key]: { "prod-4o-mini": { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 } } }));
      expect(usage.estimateCostUsd("azure_openai", "prod-4o-mini", 1_000_000, 1_000_000, 0)).toBeCloseTo(0.75, 6);
      await usage.recordExecution({
        executionId: "e",
        workflowId: "w",
        status: "success",
        durationMs: 1,
        nodeResults: { chat: { _telemetry: { providerId: "azure_openai", model: "prod-4o-mini", usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } } } }
      });
      expect(writes[0]?.costUsd).toBeCloseTo(0.75, 6);
    }
  });

  it("prices OpenAI-compatible models from an override written with a hyphen", () => {
    const { usage } = service(JSON.stringify({ "openai-compatible": { "local-model": { inputUsdPer1M: 1, outputUsdPer1M: 1 } } }));
    expect(usage.estimateCostUsd("openai_compatible", "local-model", 1_000_000, 0, 0)).toBe(1);
  });

  it("keeps Azure workflow runs unpriced without an override, and /v1 Azure traffic priced", () => {
    const { usage } = service();
    expect(usage.estimateCostUsd("azure_openai", "gpt-4o-mini", 1_000_000, 0, 0)).toBeNull();
    expect(usage.estimateAiGatewayCostUsd("azure_openai", "gpt-4o-mini", 1_000_000, 0, 0)).toBeCloseTo(0.15, 6);
    expect(usage.estimateAiGatewayCostUsd("azure-openai", "gpt-4o-mini", 1_000_000, 0, 0)).toBeCloseTo(0.15, 6);
  });

  it("merges two spellings of one provider in an override, the later entry winning per model", () => {
    const { usage } = service(JSON.stringify({ "azure-openai": { a: { inputUsdPer1M: 1, outputUsdPer1M: 0 }, b: { inputUsdPer1M: 1, outputUsdPer1M: 0 } }, azure_openai: { b: { inputUsdPer1M: 2, outputUsdPer1M: 0 } } }));
    expect(usage.estimateCostUsd("azure_openai", "a", 1_000_000, 0, 0)).toBe(1);
    expect(usage.estimateCostUsd("azure_openai", "b", 1_000_000, 0, 0)).toBe(2);
  });
});
