import { describe, expect, it } from "vitest";
import type { ModelCostObservation } from "@ai-orchestrator/shared";
import type { Store } from "../db/store.js";
import { UsageService } from "./usage-service.js";

const PRICING = JSON.stringify({ openai: { "m-1": { inputUsdPer1M: 1_000_000, outputUsdPer1M: 2_000_000 } } });

function service(writeUsageEvent: () => Promise<void>) {
  const store = { writeUsageEvent } as unknown as Store;
  const usage = new UsageService(store, { pricingOverridesJson: PRICING });
  const observed: ModelCostObservation[] = [];
  usage.setCostObserver((observation) => observed.push(observation));
  return { usage, observed };
}

const run = {
  executionId: "exec-1",
  workflowId: "wf-1",
  projectId: "alpha",
  status: "success",
  durationMs: 10,
  nodeResults: {},
  liveModelCalls: [
    { providerId: "openai", model: "m-1", inputTokens: 3, outputTokens: 1, cachedInputTokens: 0 },
    { providerId: "openai", model: "m-1", inputTokens: 2, outputTokens: 0, cachedInputTokens: 0 },
    { providerId: "openai", model: "unpriced", inputTokens: 9, outputTokens: 9, cachedInputTokens: 0 }
  ]
};

describe("UsageService cost observer", () => {
  it("reports each priced model's spend once, after the usage event is written", async () => {
    const { usage, observed } = service(async () => undefined);
    const totals = await usage.recordExecution(run);
    expect(observed).toEqual([{ providerId: "openai", model: "m-1", projectId: "alpha", costUsd: 7, source: "run" }]);
    expect(totals.costUsd).toBe(7);
  });

  it("reports nothing when the usage event could not be written", async () => {
    const { usage, observed } = service(async () => {
      throw new Error("disk full");
    });
    await expect(usage.recordExecution(run)).rejects.toThrow("disk full");
    expect(observed).toEqual([]);
  });

  it("never fails the write because of the observer", async () => {
    const { usage } = service(async () => undefined);
    usage.setCostObserver(() => {
      throw new Error("metrics broke");
    });
    await expect(usage.recordExecution(run)).resolves.toMatchObject({ costUsd: 7 });
  });
});
