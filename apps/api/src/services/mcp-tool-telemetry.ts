/**
 * Phase 10.1 — per-tool MCP telemetry.
 *
 * When an execution finishes, its node results are scanned for MCP tool
 * calls and one `mcp_tool_calls` row is written per call:
 *
 *   - Agent / Supervisor nodes: every `steps[].toolResults[]` entry whose
 *     exposed name appears in the node's `_mcpTools` map. The tokens of the
 *     turn that requested the calls are split evenly across those calls, and
 *     priced with the UsageService table (null when the model is unpriced).
 *     Worker agents' outputs, returned to the parent as tool results, are
 *     scanned the same way.
 *   - Direct MCP Tool nodes that ran (success or error), timed by the node.
 *
 * Rollups are computed from those rows: call count, error rate, nearest-rank
 * p50/p95 latency over successful calls, tokens and cost.
 *
 * Phase 10.7 — calls the runtime guard refused before they reached the server
 * (rate limit, concurrency cap, open breaker) are recorded with a `rejection`
 * and counted apart: they are not errors of the tool, so they stay out of the
 * error rate.
 */

import { randomUUID } from "node:crypto";
import { parseMcpRuntimeRejection } from "@ai-orchestrator/mcp-sdk";
import type { McpToolCallRecord, McpToolCallWrite } from "../db/database.js";
import { percentile } from "./mcp-probe-service.js";

export const MCP_TELEMETRY_WINDOWS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000
} as const;

export type McpTelemetryWindow = keyof typeof MCP_TELEMETRY_WINDOWS;

export const DEFAULT_MCP_TELEMETRY_WINDOW: McpTelemetryWindow = "7d";

export function parseMcpTelemetryWindow(value: unknown): McpTelemetryWindow | null {
  if (value === undefined || value === null || value === "") return DEFAULT_MCP_TELEMETRY_WINDOW;
  return typeof value === "string" && value in MCP_TELEMETRY_WINDOWS ? (value as McpTelemetryWindow) : null;
}

const MAX_ERROR_CHARS = 500;
const MAX_WORKER_DEPTH = 4;

export type McpToolCallInput = McpToolCallWrite;

export interface ExtractMcpToolCallsInput {
  executionId: string;
  workflow: { id: string; nodes: Array<{ id: string; type: string; config?: Record<string, unknown> }> };
  nodeResults: unknown;
  /** Price one share of a turn; null when the model's price is unknown. */
  priceTurn: (providerId: string, model: string, inputTokens: number, outputTokens: number, cachedInputTokens: number) => number | null;
  /** Adapter of a registry entry, used when a direct MCP Tool node failed before reporting it. */
  registryAdapterId?: (registryServerId: string) => string | undefined;
  redact?: (value: string) => string;
  idFactory?: () => string;
}

interface Attribution {
  adapterId: string;
  toolName: string;
  registryServerId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Split `total` into `parts` integers that add back up to `total`. */
export function splitEvenly(total: number, parts: number, index: number): number {
  if (parts <= 0) return 0;
  const base = Math.floor(total / parts);
  return base + (index < total % parts ? 1 : 0);
}

interface SamplingShare {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Phase 10.5 — sampling requests a node's tool calls triggered, keyed by
 * tool name and the 1-based number of that tool's call within the node, as
 * the engine records them under `_mcpSampling`.
 */
function readSamplingShares(output: Record<string, unknown>): Map<string, SamplingShare> {
  const shares = new Map<string, SamplingShare>();
  const raw = Array.isArray(output._mcpSampling) ? output._mcpSampling : [];
  for (const value of raw) {
    const entry = asRecord(value);
    const toolName = asString(entry?.toolName);
    if (!toolName) continue;
    const call = asNumber(entry?.call) ?? 1;
    const key = `${toolName}\u0000${call}`;
    const share = shares.get(key) ?? { requests: 0, inputTokens: 0, outputTokens: 0 };
    share.requests += 1;
    share.inputTokens += asNumber(entry?.inputTokens) ?? 0;
    share.outputTokens += asNumber(entry?.outputTokens) ?? 0;
    shares.set(key, share);
  }
  return shares;
}

function samplingColumns(share: SamplingShare | undefined): Pick<McpToolCallInput, "samplingRequests" | "samplingInputTokens" | "samplingOutputTokens"> {
  if (!share) return { samplingRequests: null, samplingInputTokens: null, samplingOutputTokens: null };
  return { samplingRequests: share.requests, samplingInputTokens: share.inputTokens, samplingOutputTokens: share.outputTokens };
}

function readAttributionMap(output: Record<string, unknown>): Map<string, Attribution> {
  const map = new Map<string, Attribution>();
  const raw = asRecord(output._mcpTools);
  if (!raw) return map;
  for (const [exposedName, value] of Object.entries(raw)) {
    const entry = asRecord(value);
    const adapterId = asString(entry?.adapterId);
    const toolName = asString(entry?.toolName);
    if (!adapterId || !toolName) continue;
    const registryServerId = asString(entry?.registryServerId);
    map.set(exposedName, { adapterId, toolName, ...(registryServerId ? { registryServerId } : {}) });
  }
  return map;
}

export function extractMcpToolCalls(input: ExtractMcpToolCallsInput): McpToolCallInput[] {
  const nextId = input.idFactory ?? (() => `mtc_${randomUUID()}`);
  const redact = input.redact ?? ((value: string) => value);
  const truncateError = (value: unknown): string | null => {
    if (value === undefined || value === null || value === "") return null;
    const text = redact(typeof value === "string" ? value : JSON.stringify(value));
    return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
  };
  const nodeById = new Map(input.workflow.nodes.map((node) => [node.id, node]));
  const rows: McpToolCallInput[] = [];

  const scanAgentOutput = (output: Record<string, unknown>, nodeId: string, fallbackStartedAt: string, depth: number) => {
    const steps = Array.isArray(output.steps) ? output.steps : [];
    if (steps.length === 0) return;
    const attribution = readAttributionMap(output);
    const samplingShares = readSamplingShares(output);
    const callsByTool = new Map<string, number>();
    const telemetry = asRecord(output._telemetry);
    const providerId = asString(telemetry?.providerId);
    const model = asString(telemetry?.model);

    for (const rawStep of steps) {
      const step = asRecord(rawStep);
      if (!step) continue;
      const toolResults = Array.isArray(step.toolResults) ? step.toolResults : [];
      if (toolResults.length === 0) continue;
      const requested = Array.isArray(step.requestedTools) ? step.requestedTools.length : 0;
      const parts = Math.max(requested, toolResults.length);
      const usage = asRecord(step.usage);
      const turnInput = asNumber(usage?.inputTokens);
      const turnOutput = asNumber(usage?.outputTokens);
      const turnCached = asNumber(usage?.cachedInputTokens) ?? 0;
      const hasUsage = turnInput !== undefined || turnOutput !== undefined;

      toolResults.forEach((rawResult, index) => {
        const result = asRecord(rawResult);
        if (!result) return;
        const toolName = asString(result.toolName);
        const target = toolName ? attribution.get(toolName) : undefined;
        if (target) {
          const inputShare = hasUsage ? splitEvenly(turnInput ?? 0, parts, index) : null;
          const outputShare = hasUsage ? splitEvenly(turnOutput ?? 0, parts, index) : null;
          const cachedShare = hasUsage ? splitEvenly(turnCached, parts, index) : 0;
          const cost =
            inputShare !== null && outputShare !== null && providerId && model
              ? input.priceTurn(providerId, model, inputShare, outputShare, cachedShare)
              : null;
          const error = truncateError(result.error);
          const rejection = parseMcpRuntimeRejection(result.error);
          const callNumber = (callsByTool.get(target.toolName) ?? 0) + 1;
          callsByTool.set(target.toolName, callNumber);
          rows.push({
            id: nextId(),
            executionId: input.executionId,
            workflowId: input.workflow.id,
            nodeId,
            registryServerId: target.registryServerId ?? null,
            adapterId: target.adapterId,
            toolName: target.toolName,
            startedAt: asString(result.startedAt) ?? fallbackStartedAt,
            durationMs: asNumber(result.durationMs) ?? null,
            ok: error === null,
            error,
            turnInputTokens: inputShare,
            turnOutputTokens: outputShare,
            estimatedCostUsd: cost,
            ...samplingColumns(samplingShares.get(`${target.toolName}\u0000${callNumber}`)),
            ...(rejection ? { rejection } : {})
          });
        }
        // A delegated worker agent returns its own output as the tool result.
        const nested = asRecord(result.output);
        if (nested && depth < MAX_WORKER_DEPTH && Array.isArray(nested.steps)) {
          scanAgentOutput(nested, nodeId, asString(result.startedAt) ?? fallbackStartedAt, depth + 1);
        }
      });
    }
  };

  const results = Array.isArray(input.nodeResults) ? input.nodeResults : [];
  for (const raw of results) {
    const result = asRecord(raw);
    const nodeId = asString(result?.nodeId);
    if (!result || !nodeId) continue;
    const status = result.status;
    if (status !== "success" && status !== "error") continue;
    const node = nodeById.get(nodeId);
    const startedAt = asString(result.startedAt) ?? new Date().toISOString();
    const output = asRecord(result.output);

    if (node?.type === "mcp_tool") {
      const config = node.config ?? {};
      const request = asRecord(output?.invocation_request);
      // Attached tool nodes are reported as consumed by their agent, not run.
      if (status === "success" && !request) continue;
      const registryServerId = asString(request?.registry_server_id) ?? asString(config.registryServerId);
      const adapterId =
        asString(request?.server_id) ??
        (registryServerId ? input.registryAdapterId?.(registryServerId) : undefined) ??
        asString(config.serverId);
      const toolName = asString(request?.tool_name) ?? asString(output?.tool_name) ?? asString(config.toolName);
      if (!adapterId || !toolName) continue;
      const error = status === "error" ? truncateError(result.error ?? "MCP tool invocation failed") : null;
      const rejection = status === "error" ? parseMcpRuntimeRejection(result.error) : null;
      // A direct node makes one call, so every sampling request it saw belongs to it.
      const sampling = output ? [...readSamplingShares(output).values()] : [];
      const samplingTotal = sampling.length
        ? sampling.reduce(
            (sum, share) => ({
              requests: sum.requests + share.requests,
              inputTokens: sum.inputTokens + share.inputTokens,
              outputTokens: sum.outputTokens + share.outputTokens
            }),
            { requests: 0, inputTokens: 0, outputTokens: 0 }
          )
        : undefined;
      rows.push({
        id: nextId(),
        executionId: input.executionId,
        workflowId: input.workflow.id,
        nodeId,
        registryServerId: registryServerId ?? null,
        adapterId,
        toolName,
        startedAt,
        durationMs: asNumber(result.durationMs) ?? null,
        ok: status === "success",
        error,
        turnInputTokens: null,
        turnOutputTokens: null,
        estimatedCostUsd: null,
        ...samplingColumns(samplingTotal),
        ...(rejection ? { rejection } : {})
      });
      continue;
    }

    if (output) {
      scanAgentOutput(output, nodeId, startedAt, 0);
    }
  }

  return rows;
}

export interface McpToolTelemetry {
  toolName: string;
  adapterId?: string;
  calls: number;
  /** Failed calls that reached the server (refused calls are counted below instead). */
  errors: number;
  /** Failed calls / calls that reached the server, 0..1. */
  errorRate: number;
  /** Phase 10.7 — calls refused before reaching the server, by reason. */
  rateLimited: number;
  concurrencyLimited: number;
  breakerRejected: number;
  /** Nearest-rank percentiles over successful calls; null when none. */
  p50Ms: number | null;
  p95Ms: number | null;
  inputTokens: number;
  outputTokens: number;
  /** Sum of priced calls; null when no call in the group could be priced. */
  costUsd: number | null;
  /** Phase 10.5 — `sampling/createMessage` requests the calls triggered, and the tokens those used. */
  samplingRequests: number;
  samplingInputTokens: number;
  samplingOutputTokens: number;
  lastCalledAt: string | null;
}

export type McpTelemetryTotals = Omit<McpToolTelemetry, "toolName" | "adapterId">;

function summarize(calls: McpToolCallRecord[]): McpTelemetryTotals {
  const durations = calls
    .filter((call) => call.ok && call.durationMs !== null)
    .map((call) => call.durationMs as number)
    .sort((a, b) => a - b);
  let errors = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let priced = false;
  let samplingRequests = 0;
  let samplingInputTokens = 0;
  let samplingOutputTokens = 0;
  let lastCalledAt: string | null = null;
  let rateLimited = 0;
  let concurrencyLimited = 0;
  let breakerRejected = 0;
  for (const call of calls) {
    if (call.rejection === "rate_limited") rateLimited += 1;
    else if (call.rejection === "concurrency_limited") concurrencyLimited += 1;
    else if (call.rejection === "circuit_open") breakerRejected += 1;
    else if (!call.ok) errors += 1;
    inputTokens += call.turnInputTokens ?? 0;
    outputTokens += call.turnOutputTokens ?? 0;
    samplingRequests += call.samplingRequests ?? 0;
    samplingInputTokens += call.samplingInputTokens ?? 0;
    samplingOutputTokens += call.samplingOutputTokens ?? 0;
    if (call.estimatedCostUsd !== null) {
      cost += call.estimatedCostUsd;
      priced = true;
    }
    if (!lastCalledAt || call.startedAt > lastCalledAt) lastCalledAt = call.startedAt;
  }
  const reached = calls.length - rateLimited - concurrencyLimited - breakerRejected;
  return {
    calls: calls.length,
    errors,
    errorRate: reached > 0 ? errors / reached : 0,
    rateLimited,
    concurrencyLimited,
    breakerRejected,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    inputTokens,
    outputTokens,
    costUsd: priced ? Math.round(cost * 1_000_000) / 1_000_000 : null,
    samplingRequests,
    samplingInputTokens,
    samplingOutputTokens,
    lastCalledAt
  };
}

/** Group by tool (and adapter, for inline servers), busiest first. */
export function rollupMcpToolCalls(
  calls: McpToolCallRecord[],
  options: { byAdapter?: boolean } = {}
): { totals: McpTelemetryTotals; tools: McpToolTelemetry[] } {
  const groups = new Map<string, { adapterId: string; toolName: string; calls: McpToolCallRecord[] }>();
  for (const call of calls) {
    const key = options.byAdapter ? `${call.adapterId}\u0000${call.toolName}` : call.toolName;
    const group = groups.get(key);
    if (group) group.calls.push(call);
    else groups.set(key, { adapterId: call.adapterId, toolName: call.toolName, calls: [call] });
  }
  const tools = [...groups.values()]
    .map((group) => ({
      toolName: group.toolName,
      ...(options.byAdapter ? { adapterId: group.adapterId } : {}),
      ...summarize(group.calls)
    }))
    .sort((a, b) => b.calls - a.calls || a.toolName.localeCompare(b.toolName));
  return { totals: summarize(calls), tools };
}
