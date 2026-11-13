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
import { DEFAULT_PROJECT_ID, type ModelCostObservation } from "@ai-orchestrator/shared";
import type { Store } from "../db/store.js";

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
    // Current Claude models (first-party API list prices). A cache-read rate is
    // set only where one is listed; without it cached input is costed at the input rate.
    "claude-fable-5-1": { inputUsdPer1M: 10, outputUsdPer1M: 50, cachedInputUsdPer1M: 0.25 },
    "claude-mythos-5-1": { inputUsdPer1M: 10, outputUsdPer1M: 50, cachedInputUsdPer1M: 0.25 },
    "claude-fable-5": { inputUsdPer1M: 10, outputUsdPer1M: 50, cachedInputUsdPer1M: 1 },
    "claude-opus-5-5": { inputUsdPer1M: 4, outputUsdPer1M: 20, cachedInputUsdPer1M: 0.2 },
    "claude-opus-5": { inputUsdPer1M: 5, outputUsdPer1M: 25 },
    "claude-opus-4-8": { inputUsdPer1M: 5, outputUsdPer1M: 25 },
    "claude-opus-4-7": { inputUsdPer1M: 5, outputUsdPer1M: 25 },
    "claude-opus-4-6": { inputUsdPer1M: 5, outputUsdPer1M: 25 },
    "claude-sonnet-5-5": { inputUsdPer1M: 2, outputUsdPer1M: 10, cachedInputUsdPer1M: 0.2 },
    "claude-sonnet-5": { inputUsdPer1M: 2, outputUsdPer1M: 10 },
    "claude-sonnet-4-6": { inputUsdPer1M: 3, outputUsdPer1M: 15 },
    // Haiku 5.5 list price is for prompts up to 100K tokens.
    "claude-haiku-5-5": { inputUsdPer1M: 0.1, outputUsdPer1M: 0.5 },
    "claude-haiku-4-5": { inputUsdPer1M: 1, outputUsdPer1M: 5 },
    "claude-haiku-4-5-20251001": { inputUsdPer1M: 1, outputUsdPer1M: 5 },
    // Older and retired models, kept so historical usage keeps its cost.
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

/**
 * 12.6b — prices that apply to /v1 AI gateway traffic only, on top of the table above: Azure OpenAI and the embedding
 * models. Workflow runs, and every other caller of `estimateCostUsd`, never read this table, so an Azure run stays
 * unpriced and adds nothing to a USD budget, as it always has. Pricing runs is a separate, announced change.
 *
 * Azure rows are keyed by the model a route names (a deployment named after its model is priced; any other name is
 * unpriced unless LLM_PRICING_OVERRIDES_JSON adds it). Global list prices.
 */
export const AI_GATEWAY_PRICING: PricingTable = {
  openai: {
    "text-embedding-3-small": { inputUsdPer1M: 0.02, outputUsdPer1M: 0 },
    "text-embedding-3-large": { inputUsdPer1M: 0.13, outputUsdPer1M: 0 },
    "text-embedding-ada-002": { inputUsdPer1M: 0.1, outputUsdPer1M: 0 }
  },
  azure_openai: {
    "gpt-4o": { inputUsdPer1M: 2.5, outputUsdPer1M: 10, cachedInputUsdPer1M: 1.25 },
    "gpt-4o-mini": { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6, cachedInputUsdPer1M: 0.075 },
    "text-embedding-3-small": { inputUsdPer1M: 0.02, outputUsdPer1M: 0 },
    "text-embedding-3-large": { inputUsdPer1M: 0.13, outputUsdPer1M: 0 },
    "text-embedding-ada-002": { inputUsdPer1M: 0.1, outputUsdPer1M: 0 }
  }
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
  /** 12.6 — the gateway client and toolset whose tool call started the run (gateway runs only). */
  clientId?: string | null;
  toolsetId?: string | null;
  status: string;
  durationMs: number;
  /** Raw nodeResults map from the executor (Record<nodeId, output>). */
  nodeResults: Record<string, unknown>;
  /**
   * Phase 15.3 — the model calls that really reached a model, in place of the
   * node telemetry: a replay that answered model calls from a golden run's
   * model tape records only its live calls (none in strict mode), so tape
   * answers never show as spend.
   */
  liveModelCalls?: Array<{ providerId: string; model: string; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null }>;
  /** The model usage of the sub-workflows the run started (Execute Workflow), counted in this run's row. */
  subWorkflowTelemetry?: ReadonlyArray<Record<string, unknown>>;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: number;
  llmCallCount: number;
}

export class UsageService {
  private readonly store: Store;
  private pricing: PricingTable;
  private costObserver: ((observation: ModelCostObservation) => void) | null = null;
  private logger?: { info: (msg: string, fields?: Record<string, unknown>) => void; warn: (msg: string, fields?: Record<string, unknown>) => void };
  private readonly seenUnpricedModels = new Set<string>();

  constructor(store: Store, options: { pricingOverridesJson?: string } = {}) {
    this.store = store;
    this.pricing = mergePricing(DEFAULT_PRICING, options.pricingOverridesJson);
  }

  /**
   * Called with the priced spend of each model of a usage event, after the event was written (the OpenTelemetry cost
   * counter mirrors the usage table; the table stays the record). Absent: nothing is reported.
   */
  setCostObserver(observer: ((observation: ModelCostObservation) => void) | null): void {
    this.costObserver = observer;
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
  async recordExecution(input: RecordExecutionInput): Promise<UsageTotals> {
    const telemetries: NodeTelemetry[] = input.liveModelCalls
      ? input.liveModelCalls.map((call) => ({
          providerId: call.providerId,
          model: call.model,
          usage: { inputTokens: call.inputTokens ?? 0, outputTokens: call.outputTokens ?? 0, cachedInputTokens: call.cachedInputTokens ?? 0 },
          llmCallCount: 1
        }))
      : collectTelemetry(input.nodeResults);
    for (const blob of input.subWorkflowTelemetry ?? []) telemetries.push(blob as NodeTelemetry);
    const { totals, providers, costs } = this.summarize(telemetries);

    await this.store.writeUsageEvent({
      id: `usage_${randomUUID()}`,
      executionId: input.executionId,
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      userId: input.userId,
      userEmail: input.userEmail,
      projectId: input.projectId,
      triggerType: input.triggerType,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.toolsetId ? { toolsetId: input.toolsetId } : {}),
      status: input.status,
      ...totals,
      durationMs: input.durationMs,
      providers
    });
    this.reportCosts(costs, input.projectId);

    return totals;
  }

  /** What model-usage blobs (`_telemetry`) add up to, priced like a run's; nothing is written. */
  totalTelemetry(blobs: ReadonlyArray<Record<string, unknown>>): UsageTotals {
    return this.summarize(blobs as ReadonlyArray<NodeTelemetry>).totals;
  }

  private reportCosts(costs: ReadonlyMap<string, { providerId: string; model: string; costUsd: number }>, projectId: string | null | undefined): void {
    const observer = this.costObserver;
    if (!observer) return;
    for (const entry of costs.values()) {
      if (entry.costUsd <= 0) continue;
      try {
        // A workflow with no project counts as the default project, as it does for the model allowlists.
        observer({ providerId: entry.providerId, model: entry.model, projectId: projectId ?? DEFAULT_PROJECT_ID, costUsd: entry.costUsd, source: "run" });
      } catch {
        // Metrics never fail the usage write they mirror.
      }
    }
  }

  private summarize(telemetries: ReadonlyArray<NodeTelemetry>): {
    totals: UsageTotals;
    providers: Array<{ providerId: string; model: string; calls: number }>;
    costs: Map<string, { providerId: string; model: string; costUsd: number }>;
  } {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let totalTokens = 0;
    let llmCallCount = 0;
    let costUsd = 0;
    const providerCounts = new Map<string, { providerId: string; model: string; calls: number }>();
    const costs = new Map<string, { providerId: string; model: string; costUsd: number }>();

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
      const callCost = this.priceTelemetry(t.providerId, t.model, it, ot, ct);
      costUsd += callCost;

      const key = `${t.providerId}::${t.model}`;
      const priced = costs.get(key);
      if (priced) priced.costUsd += callCost;
      else costs.set(key, { providerId: t.providerId, model: t.model, costUsd: callCost });
      const existing = providerCounts.get(key);
      if (existing) existing.calls += calls;
      else providerCounts.set(key, { providerId: t.providerId, model: t.model, calls });
    }

    return {
      totals: { inputTokens, outputTokens, cachedInputTokens, totalTokens, costUsd, llmCallCount },
      providers: Array.from(providerCounts.values()),
      costs
    };
  }

  /** Public so /api/usage/pricing can show the table to admins. */
  priceTelemetry(providerId: string, model: string, inputTokens: number, outputTokens: number, cachedInputTokens: number): number {
    const cost = this.estimateCostUsd(providerId, model, inputTokens, outputTokens, cachedInputTokens);
    if (cost === null) {
      const key = `${providerId}/${model}`;
      if (!this.seenUnpricedModels.has(key)) {
        this.seenUnpricedModels.add(key);
        this.logger?.warn("Unpriced model — usage events will record $0 cost", { providerId, model });
      }
      return 0;
    }
    return cost;
  }

  /**
   * Same pricing as priceTelemetry, but null when the model has no price,
   * so callers can tell "free" apart from "unknown" (Phase 10.1 tool telemetry).
   */
  estimateCostUsd(providerId: string, model: string, inputTokens: number, outputTokens: number, cachedInputTokens: number): number | null {
    const p = this.pricing[providerId]?.[model];
    return p ? costOf(p, inputTokens, outputTokens, cachedInputTokens) : null;
  }

  /**
   * A /v1 AI gateway request's cost: the table runs use (so LLM_PRICING_OVERRIDES_JSON wins), else `AI_GATEWAY_PRICING`.
   * Null when neither prices the model.
   */
  estimateAiGatewayCostUsd(providerId: string, model: string, inputTokens: number, outputTokens: number, cachedInputTokens: number): number | null {
    const p = this.pricing[providerId]?.[model] ?? AI_GATEWAY_PRICING[providerId]?.[model];
    return p ? costOf(p, inputTokens, outputTokens, cachedInputTokens) : null;
  }
}

function costOf(p: ModelPricing, inputTokens: number, outputTokens: number, cachedInputTokens: number): number {
  const billableInput = Math.max(0, inputTokens - cachedInputTokens);
  const cachedRate = p.cachedInputUsdPer1M ?? p.inputUsdPer1M;
  const inputCost = (billableInput / 1_000_000) * p.inputUsdPer1M;
  const cachedCost = (cachedInputTokens / 1_000_000) * cachedRate;
  const outputCost = (outputTokens / 1_000_000) * p.outputUsdPer1M;
  return round6(inputCost + cachedCost + outputCost);
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
    // Phase 6.4 — model usage of the workflows an agent called as tools (each blob priced by its own model).
    const children = (value as Record<string, unknown>)._childTelemetry;
    if (Array.isArray(children)) {
      for (const child of children) if (child && typeof child === "object") out.push(child as NodeTelemetry);
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
