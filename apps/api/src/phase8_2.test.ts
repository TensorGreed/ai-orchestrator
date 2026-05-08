import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "./db/database.js";
import { UsageService, DEFAULT_PRICING } from "./services/usage-service.js";

describe("Phase 8.2 — FinOps cost rollup", () => {
  let tempDir: string;
  let store: SqliteStore;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-phase8-2-"));
    store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
    store.ensureDefaultProject();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("UsageService pricing", () => {
    it("ships defaults for the major providers", () => {
      expect(DEFAULT_PRICING.openai!["gpt-4o"]).toBeDefined();
      expect(DEFAULT_PRICING.anthropic!["claude-sonnet-4"]).toBeDefined();
      expect(DEFAULT_PRICING.gemini!["gemini-2.0-flash"]).toBeDefined();
    });

    it("computes cost from input/output tokens at $/1M rates", () => {
      const u = new UsageService(store);
      // gpt-4o: $2.5/$10 per 1M
      // 1000 input + 500 output → 0.001 * 2.5 + 0.0005 * 10 = 0.0025 + 0.005 = 0.0075
      const cost = u.priceTelemetry("openai", "gpt-4o", 1000, 500, 0);
      expect(cost).toBeCloseTo(0.0075, 4);
    });

    it("applies cached-input rate when provider supports prompt caching", () => {
      const u = new UsageService(store);
      // claude-sonnet-4: $3 input, $15 output, $0.3 cached
      // 1000 input total, 800 cached → billable input = 200
      // cost = 0.0002 * 3 + 0.0008 * 0.3 = 0.0006 + 0.00024 = 0.00084
      const cost = u.priceTelemetry("anthropic", "claude-sonnet-4", 1000, 0, 800);
      expect(cost).toBeCloseTo(0.00084, 5);
    });

    it("returns $0 (warn) for unpriced models", () => {
      const u = new UsageService(store);
      let warned = false;
      u.setLogger({
        info: () => {},
        warn: () => { warned = true; }
      });
      const cost = u.priceTelemetry("ollama", "llama-3.3", 10000, 5000, 0);
      expect(cost).toBe(0);
      expect(warned).toBe(true);
    });

    it("merges JSON overrides over defaults", () => {
      const u = new UsageService(store, {
        pricingOverridesJson: JSON.stringify({
          openai: { "gpt-4o": { inputUsdPer1M: 1.0, outputUsdPer1M: 4.0 } },
          custom: { "my-model": { inputUsdPer1M: 0.1, outputUsdPer1M: 0.5 } }
        })
      });
      // override
      expect(u.priceTelemetry("openai", "gpt-4o", 1_000_000, 0, 0)).toBe(1.0);
      // new provider
      expect(u.priceTelemetry("custom", "my-model", 1_000_000, 0, 0)).toBe(0.1);
      // unrelated default still works
      expect(u.priceTelemetry("anthropic", "claude-sonnet-4", 1_000_000, 0, 0)).toBe(3);
    });

    it("ignores malformed override JSON instead of crashing", () => {
      const u = new UsageService(store, { pricingOverridesJson: "{not json" });
      expect(u.priceTelemetry("openai", "gpt-4o", 1_000_000, 0, 0)).toBe(2.5);
    });
  });

  describe("UsageService.recordExecution", () => {
    it("sums _telemetry across nodes and writes one usage_events row", () => {
      const u = new UsageService(store);
      const result = u.recordExecution({
        executionId: "exec_1",
        workflowId: "wf_1",
        workflowName: "Test workflow",
        userEmail: "alice@example.com",
        projectId: "proj_default",
        triggerType: "manual",
        status: "success",
        durationMs: 1500,
        nodeResults: {
          llm1: {
            content: "...",
            _telemetry: { providerId: "openai", model: "gpt-4o", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, latencyMs: 800 }
          },
          llm2: {
            content: "...",
            _telemetry: { providerId: "anthropic", model: "claude-sonnet-4", usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300, cachedInputTokens: 50 }, latencyMs: 600, llmCallCount: 2 }
          },
          plain_node: { value: "no telemetry" }
        }
      });
      expect(result.inputTokens).toBe(300);
      expect(result.outputTokens).toBe(150);
      expect(result.cachedInputTokens).toBe(50);
      expect(result.totalTokens).toBe(450);
      expect(result.llmCallCount).toBe(3); // 1 (llm1 default) + 2 (llm2 explicit)
      expect(result.costUsd).toBeGreaterThan(0);

      const events = store.listUsageEvents({ workflowId: "wf_1" });
      expect(events).toHaveLength(1);
      const ev = events[0]!;
      expect(ev.executionId).toBe("exec_1");
      expect(ev.userEmail).toBe("alice@example.com");
      expect(ev.totalTokens).toBe(450);
      expect(ev.providers).toHaveLength(2);
      expect(ev.providers.find((p) => p.providerId === "openai")!.calls).toBe(1);
      expect(ev.providers.find((p) => p.providerId === "anthropic")!.calls).toBe(2);
    });

    it("records a zero-cost row for executions with no LLM calls (still attributes spend correctly)", () => {
      const u = new UsageService(store);
      const result = u.recordExecution({
        executionId: "exec_2",
        workflowId: "wf_2",
        userEmail: null,
        projectId: null,
        triggerType: "webhook",
        status: "success",
        durationMs: 50,
        nodeResults: { http: { status: 200 } }
      });
      expect(result.totalTokens).toBe(0);
      expect(result.costUsd).toBe(0);
      const events = store.listUsageEvents({ workflowId: "wf_2" });
      expect(events).toHaveLength(1);
      expect(events[0]!.totalTokens).toBe(0);
      expect(events[0]!.providers).toHaveLength(0);
    });
  });

  describe("query API", () => {
    function seed(u: UsageService, overrides: Partial<{ workflowId: string; userId: string; tokens: number; createdAtOffset: number }> = {}): void {
      u.recordExecution({
        executionId: `exec_${Math.random()}`,
        workflowId: overrides.workflowId ?? "wf_a",
        workflowName: "A",
        userId: overrides.userId ?? "user_alice",
        projectId: "proj_default",
        triggerType: "manual",
        status: "success",
        durationMs: 1000,
        nodeResults: {
          x: {
            _telemetry: {
              providerId: "openai",
              model: "gpt-4o",
              usage: { inputTokens: overrides.tokens ?? 1000, outputTokens: 500, totalTokens: (overrides.tokens ?? 1000) + 500 }
            }
          }
        }
      });
    }

    it("totals aggregate over the window", () => {
      const u = new UsageService(store);
      seed(u, { workflowId: "wf_a", tokens: 1000 });
      seed(u, { workflowId: "wf_a", tokens: 2000 });
      seed(u, { workflowId: "wf_b", tokens: 500 });

      const window = { from: "1970-01-01T00:00:00Z", to: "9999-12-31T00:00:00Z" };
      const totals = store.queryUsageTotals(window);
      expect(totals.executions).toBe(3);
      expect(totals.inputTokens).toBe(3500);
      expect(totals.outputTokens).toBe(1500);
      expect(totals.costUsd).toBeGreaterThan(0);
    });

    it("groupBy=workflow ranks by cost desc", () => {
      const u = new UsageService(store);
      seed(u, { workflowId: "wf_cheap", tokens: 100 });
      seed(u, { workflowId: "wf_expensive", tokens: 100_000 });

      const rows = store.queryUsageRollup({
        from: "1970-01-01T00:00:00Z",
        to: "9999-12-31T00:00:00Z",
        groupBy: "workflow"
      });
      expect(rows[0]!.workflowId).toBe("wf_expensive");
      expect(rows[1]!.workflowId).toBe("wf_cheap");
    });

    it("groupBy=user splits by user_id", () => {
      const u = new UsageService(store);
      seed(u, { userId: "user_alice", tokens: 1000 });
      seed(u, { userId: "user_bob", tokens: 500 });

      const rows = store.queryUsageRollup({
        from: "1970-01-01T00:00:00Z",
        to: "9999-12-31T00:00:00Z",
        groupBy: "user"
      });
      expect(rows.map((r) => r.userId).sort()).toEqual(["user_alice", "user_bob"]);
    });

    it("groupBy=provider unfolds providers_json into per-model rows", () => {
      const u = new UsageService(store);
      // Mixed-provider execution
      u.recordExecution({
        executionId: "exec_mix",
        workflowId: "wf_x",
        userId: null,
        projectId: null,
        triggerType: "manual",
        status: "success",
        durationMs: 2000,
        nodeResults: {
          a: { _telemetry: { providerId: "openai", model: "gpt-4o", usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 } } },
          b: { _telemetry: { providerId: "anthropic", model: "claude-sonnet-4", usage: { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 } } }
        }
      });

      const rows = store.queryUsageRollup({
        from: "1970-01-01T00:00:00Z",
        to: "9999-12-31T00:00:00Z",
        groupBy: "provider"
      });
      expect(rows.length).toBe(2);
      const providerIds = rows.map((r) => r.providerId).sort();
      expect(providerIds).toEqual(["anthropic", "openai"]);
    });

    it("groupBy=day yields ISO date buckets ordered ascending", () => {
      const u = new UsageService(store);
      seed(u, { tokens: 1000 });
      seed(u, { tokens: 2000 });
      const rows = store.queryUsageRollup({
        from: "1970-01-01T00:00:00Z",
        to: "9999-12-31T00:00:00Z",
        groupBy: "day"
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
