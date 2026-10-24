/**
 * Phase 15.1 — what a run did, read from its stored node results.
 *
 * `collectRunActivity` walks node results the way the run manifest
 * (Phase 11.1) always has: model calls per agent step or LLM node, MCP
 * tool calls from agent steps (nested workers included) and MCP Tool
 * nodes, prompts, RAG citations and approval decisions. The manifest keeps
 * digests of arguments and results; golden runs and replays keep the
 * (scrubbed) values, normalised into `RunFacts` by `buildRunFacts`.
 * Both read the same walk, so what a manifest attests and what a replay
 * compares never drift apart.
 */

import crypto from "node:crypto";
import {
  canonicalJson,
  type RunFactGuardVerdict,
  type RunFactModelCall,
  type RunFactNode,
  type RunFactToolCall,
  type RunFacts,
  type RunManifestApproval,
  type RunManifestCitation,
  type RunManifestPrompt,
  type RunManifestToolOutcome
} from "@ai-orchestrator/shared";
import { parseMcpRuntimeRejection } from "@ai-orchestrator/mcp-sdk";

type JsonRecord = Record<string, unknown>;

export const LLM_NODE_TYPES = new Set([
  "llm_call",
  "openai_chat_model",
  "anthropic_chat_model",
  "ollama_chat_model",
  "openai_compatible_chat_model",
  "ai_gateway_chat_model",
  "azure_openai_chat_model"
]);
export const AGENT_NODE_TYPES = new Set(["agent_orchestrator", "supervisor_node"]);
const MAX_WORKER_DEPTH = 4;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function classifyToolOutcome(error: unknown, ok: boolean): RunManifestToolOutcome {
  if (ok) return "ok";
  const rejection = parseMcpRuntimeRejection(error);
  if (rejection === "rate_limited") return "rate_limited";
  if (rejection === "concurrency_limited") return "concurrency_limited";
  if (rejection === "circuit_open") return "breaker_rejected";
  const text = typeof error === "string" ? error : "";
  if (/was blocked by the guard/i.test(text)) return "guard_blocked";
  if (/is blocked by policy|counts as a write tool|no-write|not allowed by (the )?(tool )?policy/i.test(text)) return "policy_blocked";
  return "error";
}

export interface ActivityModelCall {
  nodeId: string;
  iteration: number | null;
  providerId: string;
  model: string;
  /** The node's provider settings as recorded (`_provider`), unsanitised. */
  provider: JsonRecord | null;
  usage: JsonRecord | null;
  latencyMs: number | null;
}

export interface ActivityToolCall {
  /** An agent's tool call, or an MCP Tool node. */
  source: "agent" | "node";
  nodeId: string;
  iteration: number | null;
  toolCallId: string | null;
  toolName: string;
  adapterId: string | null;
  registryServerId: string | null;
  /** Arguments and result as stored in the node results (already redacted by the engine). */
  args: unknown;
  result: unknown;
  outcome: RunManifestToolOutcome;
  startedAt: string | null;
  durationMs: number | null;
}

export interface RunActivity {
  modelCalls: ActivityModelCall[];
  toolCalls: ActivityToolCall[];
  prompts: RunManifestPrompt[];
  citations: RunManifestCitation[];
  approvals: RunManifestApproval[];
}

export interface ActivityNode {
  type: string;
  config?: unknown;
}

/** Node results with a node id, in the order the run stored them. */
export function nodeResultRecords(nodeResults: unknown): JsonRecord[] {
  return (Array.isArray(nodeResults) ? nodeResults : []).map(asRecord).filter((entry): entry is JsonRecord => Boolean(entry && typeof entry.nodeId === "string"));
}

/** The walk the run manifest is built from (see the module comment). */
export function collectRunActivity(results: JsonRecord[], nodeById: Map<string, ActivityNode>): RunActivity {
  const modelCalls: ActivityModelCall[] = [];
  const toolCalls: ActivityToolCall[] = [];
  const prompts: RunManifestPrompt[] = [];
  const citations: RunManifestCitation[] = [];
  const approvals: RunManifestApproval[] = [];

  const pushModelCall = (nodeId: string, iteration: number | null, providerId: string, model: string, provider: JsonRecord | null, usage: JsonRecord | null, latencyMs: number | null) => {
    modelCalls.push({ nodeId, iteration, providerId, model, provider, usage, latencyMs });
  };

  const scanAgentTools = (output: JsonRecord, nodeId: string, depth: number) => {
    const steps = Array.isArray(output.steps) ? output.steps : [];
    const attribution = asRecord(output._mcpTools) ?? {};
    for (const rawStep of steps) {
      const step = asRecord(rawStep);
      if (!step) continue;
      const iteration = num(step.iteration);
      const requested = new Map<string, unknown>();
      for (const call of Array.isArray(step.requestedTools) ? step.requestedTools : []) {
        const entry = asRecord(call);
        if (entry && typeof entry.id === "string") requested.set(entry.id, entry.arguments ?? entry.args);
      }
      for (const rawResult of Array.isArray(step.toolResults) ? step.toolResults : []) {
        const result = asRecord(rawResult);
        if (!result) continue;
        const exposed = str(result.toolName);
        const target = exposed ? asRecord(attribution[exposed]) : null;
        if (target) {
          const toolCallId = str(result.toolCallId);
          const error = result.error;
          toolCalls.push({
            source: "agent",
            nodeId,
            iteration,
            toolCallId,
            toolName: str(target.toolName) ?? exposed!,
            adapterId: str(target.adapterId),
            registryServerId: str(target.registryServerId),
            args: toolCallId ? requested.get(toolCallId) : undefined,
            result: result.output,
            outcome: classifyToolOutcome(error, error === undefined || error === null || error === ""),
            startedAt: str(result.startedAt),
            durationMs: num(result.durationMs)
          });
        }
        const nested = asRecord(result.output);
        if (nested && depth < MAX_WORKER_DEPTH && Array.isArray(nested.steps)) scanAgentTools(nested, nodeId, depth + 1);
      }
    }
  };

  for (const result of results) {
    const nodeId = result.nodeId as string;
    const node = nodeById.get(nodeId);
    const type = node?.type ?? "";
    const config = asRecord(node?.config) ?? {};
    const output = asRecord(result.output);
    const input = asRecord(result.input);
    const status = str(result.status);
    const consumed = output?.reason === "attachment_consumed_by_agent";

    // Approval decisions recorded when a paused run was resumed.
    if (input && (input.decision === "approve" || input.decision === "reject")) {
      approvals.push({ nodeId, decision: input.decision, actedBy: str(input.actedBy), reason: str(input.reason), decidedAt: str(result.startedAt) });
    }
    if (!output || consumed) continue;
    // Phase 11.2 — an Approval Gate records its decision in its output.
    const gateApproval = type === "approval_gate" ? asRecord(output.approval) : null;
    if (gateApproval && (gateApproval.decision === "approve" || gateApproval.decision === "reject")) {
      approvals.push({ nodeId, decision: gateApproval.decision, actedBy: str(gateApproval.actedBy), reason: str(gateApproval.reason), decidedAt: str(gateApproval.decidedAt) ?? str(result.startedAt) });
    }

    const telemetry = asRecord(output._telemetry);
    const provider = asRecord(output._provider);
    if (AGENT_NODE_TYPES.has(type) || Array.isArray(output.steps)) {
      const providerId = str(telemetry?.providerId) ?? str(provider?.providerId);
      const model = str(telemetry?.model) ?? str(provider?.model);
      const steps = (Array.isArray(output.steps) ? output.steps : []).map(asRecord).filter((step): step is JsonRecord => Boolean(step));
      if (providerId && model) {
        if (steps.length > 0) {
          for (const step of steps) pushModelCall(nodeId, num(step.iteration), providerId, model, provider, asRecord(step.usage), num(step.latencyMs));
        } else if (telemetry) {
          pushModelCall(nodeId, null, providerId, model, provider, asRecord(telemetry.usage), num(telemetry.latencyMs));
        }
      }
      scanAgentTools(output, nodeId, 0);
      const messages = Array.isArray(output.messages) ? output.messages.map(asRecord) : [];
      const systemMessage = messages.find((message) => message?.role === "system");
      const userMessage = messages.find((message) => message?.role === "user");
      const systemTemplate = str(config.systemPromptTemplate) ?? str(config.systemPrompt);
      const userTemplate = str(config.userPromptTemplate) ?? str(config.userPrompt) ?? str(config.promptTemplate);
      const renderedSystem = typeof systemMessage?.content === "string" ? systemMessage.content : null;
      const renderedUser = typeof userMessage?.content === "string" ? userMessage.content : null;
      if (systemTemplate || renderedSystem) prompts.push({ nodeId, role: "system", template: systemTemplate, rendered: renderedSystem });
      if (userTemplate || renderedUser) prompts.push({ nodeId, role: "user", template: userTemplate, rendered: renderedUser });
    } else if (LLM_NODE_TYPES.has(type) || telemetry) {
      const providerId = str(telemetry?.providerId) ?? str(provider?.providerId);
      const model = str(telemetry?.model) ?? str(provider?.model);
      if (providerId && model) pushModelCall(nodeId, null, providerId, model, provider, asRecord(telemetry?.usage), num(telemetry?.latencyMs));
      if (LLM_NODE_TYPES.has(type)) {
        const promptKey = str(config.promptKey) ?? "prompt";
        const systemKey = str(config.systemPromptKey) ?? "system_prompt";
        const renderedUser = str(input?.[promptKey]) ?? str(input?.user_prompt);
        const renderedSystem = str(input?.[systemKey]);
        const userTemplate = str(config.userPromptTemplate) ?? str(config.promptTemplate) ?? str(config.userPrompt);
        const systemTemplate = str(config.systemPromptTemplate) ?? str(config.systemPrompt);
        if (systemTemplate || renderedSystem) prompts.push({ nodeId, role: "system", template: systemTemplate, rendered: renderedSystem });
        if (userTemplate || renderedUser) prompts.push({ nodeId, role: "user", template: userTemplate, rendered: renderedUser });
      }
    }

    // Direct MCP Tool nodes that ran.
    const request = asRecord(output.invocation_request);
    if (type === "mcp_tool" && (request || status === "error")) {
      toolCalls.push({
        source: "node",
        nodeId,
        iteration: null,
        toolCallId: null,
        toolName: str(request?.tool_name) ?? str(output.tool_name) ?? str(config.toolName) ?? "unknown",
        adapterId: str(request?.server_id) ?? str(config.serverId),
        registryServerId: str(request?.registry_server_id) ?? str(config.registryServerId),
        args: request?.tool_args,
        result: output.tool_output,
        outcome: classifyToolOutcome(result.error, status === "success"),
        startedAt: str(result.startedAt),
        durationMs: num(result.durationMs)
      });
    }

    // RAG: cited chunks, and the documents a retrieval node returned.
    const cited = Array.isArray(output.citations) ? output.citations : [];
    for (const raw of cited) {
      const citation = asRecord(raw);
      if (!citation) continue;
      citations.push({
        nodeId,
        marker: str(citation.marker),
        index: num(citation.index),
        chunkId: str(citation.chunkId),
        sourceId: str(citation.sourceId),
        knowledgeBaseId: str(citation.knowledgeBaseId),
        score: num(citation.rerankerScore) ?? num(citation.similarityScore),
        retrievalMode: str(citation.retrievalMode),
        textDigest: typeof citation.text === "string" ? sha256Hex(citation.text) : null
      });
    }
    if (cited.length === 0 && (type === "rag_retrieve" || typeof output.citationInstructions === "string") && Array.isArray(output.documents)) {
      output.documents.forEach((raw, index) => {
        const document = asRecord(raw);
        if (!document) return;
        const metadata = asRecord(document.metadata) ?? {};
        citations.push({
          nodeId,
          marker: null,
          index: index + 1,
          chunkId: str(metadata.chunkId) ?? str(document.id),
          sourceId: str(metadata.sourceId),
          knowledgeBaseId: str(metadata.knowledgeBaseId),
          score: num(metadata.rerankerScore) ?? num(metadata.similarityScore),
          retrievalMode: str(asRecord(metadata.retrieval)?.mode),
          textDigest: typeof document.text === "string" ? sha256Hex(document.text) : null
        });
      });
    }
  }

  return { modelCalls, toolCalls, prompts, citations, approvals };
}

export type PriceTurn = (providerId: string, model: string, inputTokens: number, outputTokens: number, cachedInputTokens: number) => number | null;

/** USD for one model call from its usage, or null when it is not priced or has no usage. */
export function priceModelCall(call: Pick<ActivityModelCall, "providerId" | "model" | "usage">, priceTurn: PriceTurn): number | null {
  const inputTokens = num(call.usage?.inputTokens);
  const outputTokens = num(call.usage?.outputTokens);
  const cachedInputTokens = num(call.usage?.cachedInputTokens);
  if (inputTokens === null && outputTokens === null) return null;
  return priceTurn(call.providerId, call.model, inputTokens ?? 0, outputTokens ?? 0, cachedInputTokens ?? 0);
}

export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** A canonical copy of a JSON value (sorted keys); `undefined` becomes null. */
function canonicalCopy(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(canonicalJson(value)) as unknown;
  } catch {
    // Non-finite numbers have no canonical form; keep what JSON can carry.
    return JSON.parse(JSON.stringify(value) ?? "null") as unknown;
  }
}

export interface RunFactsInput {
  status: string;
  error: string | null;
  output: unknown;
  durationMs: number | null;
  nodeResults: unknown;
  /** The workflow's nodes, to read node types and configuration. */
  nodes: Array<{ id: string; type: string; config?: unknown }>;
  guardEvents: Array<{ verdictId: string; nodeId: string | null; placement: string; channel: string; detectorId: string | null; effectiveAction: string; shadow: boolean; dataClass?: string | null }>;
  priceTurn: PriceTurn;
}

/** The facts a replay compares. Values are as stored; the caller scrubs them. */
export function buildRunFacts(input: RunFactsInput): RunFacts {
  const results = nodeResultRecords(input.nodeResults);
  const nodeById = new Map<string, ActivityNode>(input.nodes.map((node) => [node.id, node]));
  const activity = collectRunActivity(results, nodeById);

  const lastResult = new Map<string, JsonRecord>();
  for (const result of results) lastResult.set(result.nodeId as string, result);
  const nodes: RunFactNode[] = [...lastResult.entries()].map(([nodeId, result]) => ({
    nodeId,
    nodeType: nodeById.get(nodeId)?.type ?? "unknown",
    status: str(result.status) ?? "unknown",
    durationMs: num(result.durationMs),
    errorCategory: str(result.errorCategory)
  }));

  const toolCalls: RunFactToolCall[] = activity.toolCalls.map((call) => {
    const args = canonicalCopy(call.args);
    return {
      nodeId: call.nodeId,
      iteration: call.iteration,
      server: call.registryServerId ?? call.adapterId ?? "unknown",
      tool: call.toolName,
      args,
      argsHash: sha256Hex(canonicalJson(args)),
      outcome: call.outcome,
      durationMs: call.durationMs
    };
  });

  const modelCalls: RunFactModelCall[] = activity.modelCalls.map((call) => {
    const costUsd = priceModelCall(call, input.priceTurn);
    return {
      nodeId: call.nodeId,
      iteration: call.iteration,
      providerId: call.providerId,
      model: call.model,
      inputTokens: num(call.usage?.inputTokens),
      outputTokens: num(call.usage?.outputTokens),
      costUsd: costUsd === null ? null : roundUsd(costUsd),
      latencyMs: call.latencyMs
    };
  });

  // One entry per verdict and finding, in recorded order. Phase 15.6: rows keep their data class and which verdict they belong to.
  const verdictIndex = new Map<string, number>();
  const guard: RunFactGuardVerdict[] = input.guardEvents.map((event) => {
    if (!verdictIndex.has(event.verdictId)) verdictIndex.set(event.verdictId, verdictIndex.size);
    return {
      nodeId: event.nodeId,
      placement: event.placement,
      channel: event.channel,
      detectorId: event.detectorId,
      effectiveAction: event.effectiveAction,
      shadow: event.shadow,
      dataClass: event.dataClass ?? null,
      verdict: verdictIndex.get(event.verdictId)!
    };
  });

  const inputTokens = modelCalls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0);
  const outputTokens = modelCalls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0);
  const priced = modelCalls.filter((call) => call.costUsd !== null);
  return {
    status: input.status,
    error: input.error,
    output: canonicalCopy(input.output),
    nodes,
    toolCalls,
    modelCalls,
    guard,
    totals: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd: priced.length > 0 ? roundUsd(priced.reduce((sum, call) => sum + (call.costUsd ?? 0), 0)) : null,
      durationMs: input.durationMs,
      modelCalls: modelCalls.length,
      toolCalls: toolCalls.length
    }
  };
}
