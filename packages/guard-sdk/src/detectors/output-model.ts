import { llmProviderConfigSchema } from "@ai-orchestrator/shared";
import type { DetectorContext, GuardModelRef, GuardModelServices } from "../types";

/**
 * Phase 12 coverage — shared helpers of the model-backed output checks. The
 * checks never call a provider themselves: the host offers model calls
 * through `DetectorContext.models` and counts their usage. A check that asks
 * for a model the host does not offer throws, so the rule set's failure
 * policy (fail closed by default) decides what happens.
 */

/** Option keys that would put a raw key into a rule set. */
const RAW_KEY_FIELDS = /^(api[-_]?key|key|token|secret|password|authorization)$/i;

/** Why a model option is unusable, or undefined when it is fine. Absent is fine (the host's default applies). */
export function guardModelRefIssue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const parsed = llmProviderConfigSchema.safeParse(value);
  if (!parsed.success) return `Not a model config: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ")}`;
  for (const key of Object.keys(parsed.data.extra ?? {})) {
    if (RAW_KEY_FIELDS.test(key)) return "Keys cannot be written into a rule set; store the key as a secret and name it with secretRef.secretId";
  }
  return undefined;
}

/** The model an option names, or undefined (the host's default). Throws on a malformed one. */
export function guardModelRefOption(value: unknown, detectorId: string): GuardModelRef | undefined {
  if (value === undefined || value === null) return undefined;
  const issue = guardModelRefIssue(value);
  if (issue) throw new Error(`${detectorId}: model option is invalid (${issue})`);
  return llmProviderConfigSchema.parse(value) as GuardModelRef;
}

export function requireCompletion(context: DetectorContext, detectorId: string): NonNullable<GuardModelServices["complete"]> {
  const complete = context.models?.complete;
  if (!complete) throw new Error(`${detectorId} asks a model, but this checkpoint offers no model calls`);
  return complete;
}

export function requireEmbedding(context: DetectorContext, detectorId: string): NonNullable<GuardModelServices["embed"]> {
  const embed = context.models?.embed;
  if (!embed) throw new Error(`${detectorId} needs an embedding model, but this checkpoint offers none`);
  return embed;
}

/** The first JSON object in a model's answer (bare, or inside a fenced block). Undefined when there is none. */
export function firstJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const value = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/** Text a model is shown: cut to `max` characters so one long answer cannot run up the cost. */
export function clipForModel(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[... ${text.length - max} more characters not shown]` : text;
}

export function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function unitNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}
