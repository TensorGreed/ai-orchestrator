/**
 * Phase 8.2 — UsageService.
 *
 * Bridges the per-node `_telemetry` blobs attached by Phase 7.1 to the
 * `usage_events` rollup table introduced in migration v15. One row per
 * execution; aggregations happen at query time so we can slice by day,
 * workflow, user, project, or provider/model without paying double-write
 * costs at execution time.
 *
 * Pricing
 * -------
 *   - Defaults shipped here track the public list-prices for OpenAI,
 *     Anthropic, and Google Gemini circa 2026-Q2. They are deliberately
 *     conservative — operators with negotiated rates should override via
 *     `LLM_PRICING_OVERRIDES_JSON` (see config.ts) rather than fork.
 *   - Models not in the table emit cost=$0 with a warn log. Better to
 *     under-report than to invent a bogus number.
 *   - `cachedInputTokens` are billed at the cached-input rate when the
 *     provider exposes one (Anthropic, Gemini, OpenAI prompt-caching);
 *     otherwise they fall through to the standard input rate.
 */

import { randomUUID } from "node:crypto";
import type { SqliteStore } from "../db/database.js";

export interface ModelPricing {
  /** Dollars per 1 million input tokens. */
  inputUsdPer1M: number;
  /** Dollars per 1 million output tokens. */
  outputUsdPer1M: number;
  /** Dollars per 1M cached-input tokens. Falls back to input rate when undefined. */
  cachedInputUsdPer1M?: number;
}

/** providerId → modelId → pricing */
export type PricingTable = Record<string, Record<string, ModelPricing>>;

export const DEFAULT_PRICING: PricingTable = {
  openai: {
    "gpt-4o": { inputUsdPer1M: 2.5, outputUsdPer1M: 10, cachedInputUsdPer1M: 1.25 },
    "gpt-4o-mini": { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6, cachedInputUsdPer1M: 0.075 },
    "gpt-4-turbo": { inputUsdPer1M: 10, outputUsdPer1M: 30 },
    "gpt-4": { inputUsdPer1M: 30, outputUsdPer1M: 60 },
    "gpt-3.5-turbo": { inputUsdPer1M: 0.5, outputUsdPer1M: 1.5 },
    "o1": { inputUsdPer1M: 15, outputUsdPer1M: 60 },
    "o1-mini": { inputUsdPer1M: 3, outputUsdPer1M: 12 },
    "o3-mini": { inputUsdPer1M: 1.1, outputUsdPer1M: 4.4 }
  },
  anthropic: {
    "claude-opus-4": { inputUsdPer1M: 15, outputUsdPer1M: 75, cachedInputUsdPer1M: 1.5 },
    "claude-sonnet-4": { inputUsdPer1M: 3, outputUsdPer1M: 15, cachedInputUsdPer1M: 0.3 },
    "claude-haiku-4": { inputUsdPer1M: 0.8, outputUsdPer1M: 4, cachedInputUsdPer1M: 0.08 },
    "claude-3-5-sonnet": { inputUsdPer1M: 3, outputUsdPer1M: 15, cachedInputUsdPer1M: 0.3 },
    "claude-3-5-haiku": { inputUsdPer1M: 0.8, outputUsdPer1M: 4, cachedInputUsdPer1M: 0.08 },
    "claude-3-opus": { inputUsdPer1M: 15, outputUsdPer1M: 75 }
  },
  gemini: {
    "gemini-2.0-flash": { inputUsdPer1M: 0.1, outputUsdPer1M: 0.4 },
    "gemini-2.0-flash-lite": { inputUsdPer1M: 0.075, outputUsdPer1M: 0.3 },
    "gemini-1.5-pro": { inputUsdPer1M: 1.25, outputUsdPer1M: 5 },
    "gemini-1.5-flash": { inputUsdPer1M: 0.075, outputUsdPer1M: 0.3 }
  },
  // Local / open-weight providers: tokens are tracked but cost is $0 unless
  // operators override (e.g. self-hosted GPU costs amortized per-token).
  ollama: {},
  echo: {},
  "openai-compatible": {},
  "azure-openai": {}
};

interface NodeTelemetry {
  providerId?: string;
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
  };
  latencyMs?: number;
  llmCallCount?: number;
}

export interface RecordExecutionInput {
  executionId: string;
  workflowId: string;
  workflowName?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  projectId?: string | null;
  triggerType?: string | null;
  status: string;
  durationMs: number;
  /** Raw nodeResults map from the executor (Record<nodeId, output>). */
  nodeResults: Record<string, unknown>;
}

export class UsageService {
  private readonly store: SqliteStore;
  private pricing: PricingTable;
  private logger?: { info: (msg: string, fields?: Record<string, unknown>) => void; warn: (msg: string, fields?: Record<string, unknown>) => void };
  private readonly seenUnpricedModels = new Set<string>();

  constructor(store: SqliteStore, options: { pricingOverridesJson?: string } = {}) {
    this.store = store;
    this.pricing = mergePricing(DEFAULT_PRICING, options.pricingOverridesJson);
  }

  setLogger(logger: { info: (msg: string, fields?: Record<string, unknown>) => void; warn: (msg: string, fields?: Record<string, unknown>) => void }): void {
    this.logger = logger;
  }

  /**
   * Replace or extend the pricing table at runtime. Pure merge — operator
   * overrides win, defaults stay for everything else.
   */
  updatePricing(overrides: PricingTable): void {
    this.pricing = mergePricingTables(this.pricing, overrides);
  }

  getPricing(): PricingTable {
    return this.pricing;
  }

  /**
   * Walk nodeResults, sum every `_telemetry` blob attached by the runtime
   * (llm_call + agent_orchestrator + supervisor_node), price it against the
   * current table, and persist a single usage_events row. Cheap to call
   * unconditionally — emits a no-op row when no LLM calls happened (still
   * useful as a spend-attribution artifact for the workflow execution).
   */
  recordExecution(input: RecordExecutionInput): {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    costUsd: number;
    llmCallCount: number;
  } {
    const telemetries = collectTelemetry(input.nodeResults);
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let totalTokens = 0;
    let llmCallCount = 0;
    let costUsd = 0;
    const providerCounts = new Map<string, { providerId: string; model: string; calls: number }>();

    for (const t of telemetries) {
      if (!t.providerId || !t.model) continue;
      const u = t.usage ?? {};
      const it = Math.max(0, u.inputTokens ?? 0);
      const ot = Math.max(0, u.outputTokens ?? 0);
      const ct = Math.max(0, u.cachedInputTokens ?? 0);
      const tt = u.totalTokens ?? it + ot;
      const calls = t.llmCallCount && t.llmCallCount > 0 ? t.llmCallCount : 1;

      inputTokens += it;
      outputTokens += ot;
      cachedInputTokens += ct;
      totalTokens += tt;
      llmCallCount += calls;
      costUsd += this.priceTelemetry(t.providerId, t.model, it, ot, ct);

      const key = `${t.providerId}::${t.model}`;
      const existing = providerCounts.get(key);
      if (existing) existing.calls += calls;
      else providerCounts.set(key, { providerId: t.providerId, model: t.model, calls });
    }

    this.store.writeUsageEvent({
      id: `usage_${randomUUID()}`,
      executionId: input.executionId,
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      userId: input.userId,
      userEmail: input.userEmail,
      projectId: input.projectId,
      triggerType: input.triggerType,
      status: input.status,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      totalTokens,
      costUsd,
      llmCallCount,
      durationMs: input.durationMs,
      providers: Array.from(providerCounts.values())
    });

    return { inputTokens, outputTokens, cachedInputTokens, totalTokens, costUsd, llmCallCount };
  }

  /** Public so /api/usage/pricing can show the table to admins. */
  priceTelemetry(providerId: string, model: string, inputTokens: number, outputTokens: number, cachedInputTokens: number): number {
    const p = this.pricing[providerId]?.[model];
    if (!p) {
      const key = `${providerId}/${model}`;
      if (!this.seenUnpricedModels.has(key)) {
        this.seenUnpricedModels.add(key);
        this.logger?.warn("Unpriced model — usage events will record $0 cost", { providerId, model });
      }
      return 0;
    }
    const billableInput = Math.max(0, inputTokens - cachedInputTokens);
    const cachedRate = p.cachedInputUsdPer1M ?? p.inputUsdPer1M;
    const inputCost = (billableInput / 1_000_000) * p.inputUsdPer1M;
    const cachedCost = (cachedInputTokens / 1_000_000) * cachedRate;
    const outputCost = (outputTokens / 1_000_000) * p.outputUsdPer1M;
    return round6(inputCost + cachedCost + outputCost);
  }
}

function collectTelemetry(nodeResults: Record<string, unknown>): NodeTelemetry[] {
  const out: NodeTelemetry[] = [];
  if (!nodeResults || typeof nodeResults !== "object") return out;
  for (const value of Object.values(nodeResults)) {
    if (!value || typeof value !== "object") continue;
    const t = (value as Record<string, unknown>)._telemetry;
    if (t && typeof t === "object") {
      out.push(t as NodeTelemetry);
    }
  }
  return out;
}

function mergePricing(base: PricingTable, overridesJson?: string): PricingTable {
  if (!overridesJson || !overridesJson.trim()) return cloneTable(base);
  let overrides: PricingTable;
  try {
    overrides = JSON.parse(overridesJson) as PricingTable;
  } catch {
    return cloneTable(base);
  }
  return mergePricingTables(base, overrides);
}

function mergePricingTables(base: PricingTable, overrides: PricingTable): PricingTable {
  const out = cloneTable(base);
  for (const [providerId, models] of Object.entries(overrides)) {
    if (!out[providerId]) out[providerId] = {};
    for (const [model, pricing] of Object.entries(models)) {
      out[providerId]![model] = pricing;
    }
  }
  return out;
}

function cloneTable(t: PricingTable): PricingTable {
  const out: PricingTable = {};
  for (const [k, v] of Object.entries(t)) out[k] = { ...v };
  return out;
}

function round6(n: number): number {
  // 6 decimal places = sub-microcent precision; matters when summing tens of
  // thousands of cheap executions. UI formatters can still display fewer.
  return Math.round(n * 1_000_000) / 1_000_000;
}
