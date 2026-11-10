import {
  DLP_DETECTOR_ID,
  OUTPUT_GROUNDING_DETECTOR_ID,
  OUTPUT_SAFETY_DETECTOR_ID,
  OUTPUT_SCHEMA_DETECTOR_ID,
  OUTPUT_TOPIC_DETECTOR_ID,
  hashGuardProfile,
  parseGuardProfile,
  type GuardModelRef,
  type GuardModelServices,
  type GuardProfile,
  type GuardSource
} from "@ai-orchestrator/guard-sdk";
import type { EmbeddingProviderRegistry, ProviderExecutionContext, ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import { OUTPUT_GUARDRAIL_CHECK_VALUES, llmProviderConfigSchema, type LLMProviderConfig, type Workflow } from "@ai-orchestrator/shared";
import { isExecutionEdge } from "./graph";
import type { ResolvedGuardProfile } from "./guard-runtime";
import type { EmbeddingModelTarget } from "./rag-adapters";

/**
 * Phase 12 coverage — the engine side of the output checks (schema, topic,
 * safety, grounding): the model calls a check may make, counted in the
 * node's usage; the documents an answer drew on (grounding sources); and the
 * Output Guardrail node's checks as a rule set, so its findings are rule
 * events like any other.
 */

/** One model call a check made, in the shape the usage records read (`_childTelemetry`). */
export interface CheckModelUsage {
  providerId: string;
  model: string;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number };
  llmCallCount: number;
  latencyMs?: number;
  /** What made the call: a content rules check (with its detector), or an Output Guardrail retry. */
  purpose: "content_rules" | "guardrail_retry";
  detectorId: string;
}

export interface GuardModelServicesInput {
  providerRegistry: ProviderRegistry;
  /** Embedding adapters (with usage); semantic topic checks only. */
  embeddingRegistry?: EmbeddingProviderRegistry;
  providerContext: () => ProviderExecutionContext;
  /** Where each call's usage goes; the node adds it to its output. */
  usage: CheckModelUsage[];
  /** The chat model a check uses when its options name none (the node's model). */
  defaultModel?: LLMProviderConfig;
  /** 12.6 — the model allowlist's check for embedding calls; throws to refuse. */
  checkEmbeddingModel?: (target: EmbeddingModelTarget) => Promise<void>;
  /** Phase 16 — destination rules on what a check sends to a chat model; returns the prompts to send. */
  guardPrompt?: (provider: LLMProviderConfig, prompts: { systemPrompt: string; userPrompt: string }) => Promise<{ systemPrompt: string; userPrompt: string }>;
  /** Called before each call: a canceled run stops checking. */
  throwIfAborted?: () => void;
}

function providerConfigOf(model: GuardModelRef | undefined, fallback: LLMProviderConfig | undefined, detectorId: string): LLMProviderConfig {
  const chosen = model ?? fallback;
  if (!chosen) throw new Error(`${detectorId} needs a model: set options.model on the rule, or run the check where a chat model is attached`);
  const parsed = llmProviderConfigSchema.safeParse(chosen);
  if (!parsed.success) throw new Error(`${detectorId}: the model config is invalid`);
  return parsed.data as LLMProviderConfig;
}

/** Model calls for detectors, each going through the run's registries (so allowlists, replays and retries apply) and counted. */
export function createGuardModelServices(input: GuardModelServicesInput): GuardModelServices {
  return {
    complete: async (request) => {
      input.throwIfAborted?.();
      const provider = providerConfigOf(request.model, input.defaultModel, request.detectorId);
      const prompts = input.guardPrompt
        ? await input.guardPrompt(provider, { systemPrompt: request.system, userPrompt: request.prompt })
        : { systemPrompt: request.system, userPrompt: request.prompt };
      const adapter = input.providerRegistry.get(provider.providerId);
      const response = await adapter.generate(
        {
          provider: { ...provider, temperature: provider.temperature ?? 0 },
          messages: [
            { role: "system", content: prompts.systemPrompt },
            { role: "user", content: prompts.userPrompt }
          ]
        },
        input.providerContext()
      );
      input.usage.push({
        providerId: provider.providerId,
        model: provider.model,
        usage: { ...(response.usage ?? {}) },
        llmCallCount: 1,
        ...(typeof response.latencyMs === "number" ? { latencyMs: response.latencyMs } : {}),
        purpose: "content_rules",
        detectorId: request.detectorId
      });
      return { text: response.content ?? "" };
    },
    embed: async (request) => {
      input.throwIfAborted?.();
      if (!request.model) throw new Error(`${request.detectorId} needs options.model naming an embedding model`);
      const provider = providerConfigOf(request.model, undefined, request.detectorId);
      const registry = input.embeddingRegistry;
      const adapter = registry?.tryGet(provider.providerId);
      if (!adapter) throw new Error(`${request.detectorId}: no embedding adapter for provider '${provider.providerId}'`);
      await input.checkEmbeddingModel?.({ providerId: provider.providerId, model: provider.model });
      const response = await adapter.embed({ provider, input: request.texts }, input.providerContext());
      input.usage.push({
        providerId: provider.providerId,
        model: provider.model,
        usage: {
          ...(response.usage?.inputTokens !== undefined ? { inputTokens: response.usage.inputTokens } : {}),
          ...(response.usage?.totalTokens !== undefined ? { totalTokens: response.usage.totalTokens } : {})
        },
        llmCallCount: 1,
        latencyMs: response.latencyMs,
        purpose: "content_rules",
        detectorId: request.detectorId
      });
      return response.embeddings;
    }
  };
}

/** Node types whose `documents` an answer cites: the numbered context they return is what a model saw. */
export const GROUNDING_SOURCE_NODE_TYPES: ReadonlySet<string> = new Set(["rag_retrieve", "rerank"]);

const MAX_SOURCES = 50;
const MAX_SOURCE_CHARS = 20_000;

function sourceDocuments(nodeId: string, output: unknown, numbered: boolean): GuardSource[] {
  const record = output && typeof output === "object" ? (output as Record<string, unknown>) : {};
  const documents = Array.isArray(record.documents) ? record.documents : [];
  const sources: GuardSource[] = [];
  documents.forEach((document, index) => {
    if (sources.length >= MAX_SOURCES) return;
    const entry = typeof document === "string" ? { text: document } : document && typeof document === "object" ? (document as Record<string, unknown>) : undefined;
    const text = typeof entry?.text === "string" ? entry.text : typeof entry?.content === "string" ? entry.content : undefined;
    if (!entry || text === undefined) return;
    const metadata = entry.metadata && typeof entry.metadata === "object" ? (entry.metadata as Record<string, unknown>) : {};
    const title = typeof metadata.title === "string" ? metadata.title : undefined;
    const uri = typeof metadata.url === "string" ? metadata.url : typeof metadata.source === "string" ? metadata.source : undefined;
    sources.push({
      id: typeof entry.id === "string" && entry.id ? entry.id : `${nodeId}:${index + 1}`,
      text: text.slice(0, MAX_SOURCE_CHARS),
      ...(numbered ? { citation: index + 1 } : {}),
      ...(title ? { title } : {}),
      ...(uri ? { uri } : {}),
      nodeId
    });
  });
  return sources;
}

/**
 * The documents an answer at `nodeId` drew on: those of the nearest retrieval
 * nodes upstream (Retrieve, Rerank), following DAG edges only (attachment
 * ports are not upstream data). A retrieval node ends its branch of the walk,
 * so a Rerank's documents stand in for the Retrieve before it. Citation
 * numbers are kept only when a single retrieval node feeds the answer (they
 * would collide otherwise; ids still resolve).
 */
export function groundingSourcesFor(workflow: Pick<Workflow, "nodes" | "edges">, nodeId: string, outputs: ReadonlyMap<string, unknown> | undefined): GuardSource[] {
  if (!outputs) return [];
  const types = new Map(workflow.nodes.map((node) => [node.id, node.type]));
  const parents = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    if (!isExecutionEdge(edge)) continue;
    const list = parents.get(edge.target) ?? [];
    list.push(edge.source);
    parents.set(edge.target, list);
  }
  const found: string[] = [];
  const seen = new Set<string>([nodeId]);
  const queue = [...(parents.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (GROUNDING_SOURCE_NODE_TYPES.has(types.get(id) ?? "") && outputs.has(id)) {
      found.push(id);
      continue;
    }
    queue.push(...(parents.get(id) ?? []));
  }
  const numbered = found.length === 1;
  return found.flatMap((id) => sourceDocuments(id, outputs.get(id), numbered)).slice(0, MAX_SOURCES);
}

/** Output Guardrail checks that run as content rules (and record rule events). */
export const OUTPUT_GUARDRAIL_RULE_CHECKS = ["no_pii", "matches_schema", "topic", "safety", "grounding"] as const;
/** Every check the Output Guardrail node offers. `no_profanity` and `must_contain_json` keep their original local behaviour. */
export const OUTPUT_GUARDRAIL_CHECKS = OUTPUT_GUARDRAIL_CHECK_VALUES;

/** Personal data classes `no_pii` covers (credentials and keys are not personal data). */
export const NO_PII_DATA_CLASSES = ["email", "phone", "card_number", "iban", "us_ssn", "national_id"] as const;
const NOT_PII = ["credential", "private_key", "jwt"];

export interface OutputGuardrailConfig {
  checks: string[];
  schema?: Record<string, unknown>;
  topics?: { allow?: unknown[]; deny?: unknown[] };
  safety?: { categories?: string[]; mode?: "rules" | "model" };
  grounding?: { minSupport?: number; requireCitations?: boolean; judge?: boolean };
  /** Chat model for model-backed checks; the upstream model otherwise. */
  checkModel?: LLMProviderConfig;
}

/** The Output Guardrail's check config, read leniently (stored workflows predate the new fields). */
export function readOutputGuardrailConfig(config: Record<string, unknown>): OutputGuardrailConfig {
  const checks = Array.isArray(config.checks) ? config.checks.map((value) => String(value)).filter(Boolean) : [];
  const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
  let schema = record(config.schema);
  if (typeof config.schema === "string" && config.schema.trim()) {
    try {
      schema = record(JSON.parse(config.schema));
    } catch {
      throw new Error("Output Guardrail: the schema is not valid JSON");
    }
  }
  const topics = record(config.topics);
  const safety = record(config.safety);
  const grounding = record(config.grounding);
  const checkModel = config.checkModel !== undefined ? llmProviderConfigSchema.safeParse(config.checkModel) : undefined;
  if (checkModel && !checkModel.success) throw new Error("Output Guardrail: the check model config is invalid");
  return {
    checks,
    ...(schema ? { schema } : {}),
    ...(topics ? { topics: { ...(Array.isArray(topics.allow) ? { allow: topics.allow } : {}), ...(Array.isArray(topics.deny) ? { deny: topics.deny } : {}) } } : {}),
    ...(safety
      ? {
          safety: {
            ...(Array.isArray(safety.categories) ? { categories: safety.categories.map(String) } : {}),
            ...(safety.mode === "model" || safety.mode === "rules" ? { mode: safety.mode } : {})
          }
        }
      : {}),
    ...(grounding
      ? {
          grounding: {
            ...(typeof grounding.minSupport === "number" ? { minSupport: grounding.minSupport } : {}),
            ...(typeof grounding.requireCitations === "boolean" ? { requireCitations: grounding.requireCitations } : {}),
            ...(grounding.judge === true ? { judge: true } : {})
          }
        }
      : {}),
    ...(checkModel?.success ? { checkModel: checkModel.data as LLMProviderConfig } : {})
  };
}

export const OUTPUT_GUARDRAIL_PROFILE_ID = "output-guardrail";

/**
 * The node's rule checks as a rule set on `final_output`: every finding
 * blocks (fails the check), no rewrites. `matches_schema` without a schema
 * keeps its original meaning (the text must parse as JSON) and is not part
 * of it. Undefined when no rule check is configured.
 */
export function outputGuardrailProfile(config: OutputGuardrailConfig): ResolvedGuardProfile | undefined {
  const detectors: Array<{ id: string; threshold?: number; options?: Record<string, unknown> }> = [];
  const checks = new Set(config.checks);
  if (checks.has("no_pii")) detectors.push({ id: DLP_DETECTOR_ID, threshold: 0.6, options: { disable: NOT_PII } });
  if (checks.has("matches_schema") && config.schema) detectors.push({ id: OUTPUT_SCHEMA_DETECTOR_ID, options: { schema: config.schema } });
  if (checks.has("topic")) {
    if (!config.topics || ((config.topics.allow?.length ?? 0) === 0 && (config.topics.deny?.length ?? 0) === 0)) {
      throw new Error("Output Guardrail: the topic check needs topics to allow or deny");
    }
    detectors.push({ id: OUTPUT_TOPIC_DETECTOR_ID, options: { ...config.topics } });
  }
  if (checks.has("safety")) detectors.push({ id: OUTPUT_SAFETY_DETECTOR_ID, options: { ...(config.safety ?? {}) } });
  if (checks.has("grounding")) detectors.push({ id: OUTPUT_GROUNDING_DETECTOR_ID, options: { ...(config.grounding ?? {}) } });
  if (detectors.length === 0) return undefined;
  const profile: GuardProfile = parseGuardProfile({
    id: OUTPUT_GUARDRAIL_PROFILE_ID,
    name: "Output Guardrail checks",
    version: "1",
    channels: { final_output: { detectors, defaultAction: { action: "block" } } },
    // A check that cannot finish fails the check, and model checks get time to answer.
    latencyBudget: { ms: 60_000, onExceeded: "fail_closed" }
  });
  return { profileId: OUTPUT_GUARDRAIL_PROFILE_ID, version: 1, hash: hashGuardProfile(profile), name: "Output Guardrail checks", profile };
}

const LEGACY_PROFANITY = ["damn", "shit", "fuck", "bitch", "bastard"];

/**
 * The checks that stay local: `no_profanity` (the original word list, kept
 * for compatibility), `must_contain_json`, and `matches_schema` without a
 * schema (the whole text must parse as JSON, as before).
 */
export function localGuardrailFailures(text: string, config: OutputGuardrailConfig, containsJson: (text: string) => boolean): string[] {
  const failures: string[] = [];
  const checks = new Set(config.checks);
  if (checks.has("no_profanity")) {
    const lower = text.toLowerCase();
    if (LEGACY_PROFANITY.some((token) => lower.includes(token))) failures.push("no_profanity");
  }
  if (checks.has("must_contain_json") && !containsJson(text)) failures.push("must_contain_json");
  if (checks.has("matches_schema") && !config.schema) {
    try {
      JSON.parse(text);
    } catch {
      failures.push("matches_schema");
    }
  }
  return failures;
}

/** Which Output Guardrail check a rule finding belongs to. */
export function guardrailCheckOfDetector(detectorId: string): string {
  switch (detectorId) {
    case DLP_DETECTOR_ID:
      return "no_pii";
    case OUTPUT_SCHEMA_DETECTOR_ID:
      return "matches_schema";
    case OUTPUT_TOPIC_DETECTOR_ID:
      return "topic";
    case OUTPUT_SAFETY_DETECTOR_ID:
      return "safety";
    case OUTPUT_GROUNDING_DETECTOR_ID:
      return "grounding";
    default:
      return detectorId;
  }
}
