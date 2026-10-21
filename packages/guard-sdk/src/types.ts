import type { McpPolicyRole, McpToolAnnotations } from "@ai-orchestrator/shared";

/**
 * Phase 12.1 — core types of the guard engine. The engine is a library: it
 * knows nothing about workflows, nodes or HTTP. A later wiring step feeds it
 * content from each trust boundary and acts on the verdict.
 */

/** Where in the AI traffic the content sits. */
export type GuardChannel = "prompt" | "model_output" | "tool_arguments" | "tool_result" | "final_output";

export const GUARD_CHANNELS: readonly GuardChannel[] = [
  "prompt",
  "model_output",
  "tool_arguments",
  "tool_result",
  "final_output"
];

/** Where the content came from. Policies key on these labels, not only on patterns. */
export type ProvenanceLabel = "trusted" | "user" | "untrusted_external" | "sensitive";

export const PROVENANCE_LABELS: readonly ProvenanceLabel[] = ["trusted", "user", "untrusted_external", "sensitive"];

/** Latency tiers, cheapest first. Evaluation runs them in this order. */
export type DetectorTier = "rule" | "parser" | "classifier" | "judge";

export const DETECTOR_TIERS: readonly DetectorTier[] = ["rule", "parser", "classifier", "judge"];

export type GuardAction =
  | "allow"
  | "block"
  | "redact"
  | "mask"
  | "protect"
  | "transform"
  | "require_approval"
  | "review";

export const GUARD_ACTIONS: readonly GuardAction[] = [
  "allow",
  "block",
  "redact",
  "mask",
  "protect",
  "transform",
  "require_approval",
  "review"
];

/** Finding categories produced by the built-in detectors. Custom detectors may add their own. */
export type GuardCategory =
  | "prompt_injection"
  | "indirect_injection"
  | "hidden_payload"
  | "exfiltration"
  | "canary_leak"
  | "sensitive_data"
  | "sql_injection"
  | "sql_policy"
  | "command_injection"
  | "unsafe_code"
  | "path_traversal"
  | "egress"
  | "schema_violation"
  | (string & {});

/** Categories whose findings may never be tokenised, redacted or masked away: they block or go to review. */
export const INJECTION_CATEGORIES: ReadonlySet<string> = new Set([
  "prompt_injection",
  "indirect_injection",
  "canary_leak"
]);

/** Data classes the DLP detectors emit. Profiles may define more through dictionaries. */
export type GuardDataClass =
  | "email"
  | "phone"
  | "card_number"
  | "iban"
  | "us_ssn"
  | "national_id"
  | "credential"
  | "private_key"
  | "jwt"
  | (string & {});

export interface GuardSubject {
  role: McpPolicyRole;
  userId?: string | null;
  projectId?: string | null;
}

export interface GuardToolContext {
  /** Registry server id or adapter id. */
  serverId?: string;
  toolName: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations | null;
  /** Argument paths (dot notation) whose values came from untrusted content, when the caller knows. */
  untrustedArguments?: string[];
}

export interface GuardInput {
  /** Text, or a JSON value. JSON is inspected through its canonical serialisation. */
  content: unknown;
  channel: GuardChannel;
  labels?: ProvenanceLabel[];
  subject?: GuardSubject;
  tool?: GuardToolContext;
  /** Canary tokens planted in the system prompt; their appearance in output is a leak. */
  canaries?: string[];
  /** Redirect chain observed for an outbound request, final destination last. */
  redirectChain?: string[];
}

/** Half-open character range in the inspected text (`contentText`). */
export interface GuardSpan {
  start: number;
  end: number;
}

export interface GuardFinding {
  detectorId: string;
  category: GuardCategory;
  /** 0..1 confidence. */
  score: number;
  spans: GuardSpan[];
  /** Masked excerpt. Never the raw matched value. */
  evidence: string;
  /** Human-readable reason; never includes raw matched values. */
  message: string;
  dataClass?: GuardDataClass;
  metadata?: Record<string, unknown>;
}

export interface DetectorContext {
  /** Canonical text of the input (`contentText`). */
  text: string;
  /** Detector-specific options from the profile entry. */
  options: Record<string, unknown>;
  /** Monotonic clock for timings. */
  now(): number;
}

export interface GuardDetector {
  id: string;
  tier: DetectorTier;
  description: string;
  /** Channels the detector is meaningful on. Profiles may still list it elsewhere. */
  channels: readonly GuardChannel[];
  categories: readonly GuardCategory[];
  detect(input: GuardInput, context: DetectorContext): GuardFinding[] | Promise<GuardFinding[]>;
  /**
   * For the `transform` action: return the content with the findings'
   * payloads removed or rewritten. Detectors without a transform are blocked
   * instead when a profile asks for `transform`.
   */
  transform?(text: string, findings: GuardFinding[], context: DetectorContext): string;
}

export type DetectorStatus = "ran" | "skipped_budget" | "skipped_short_circuit" | "timed_out" | "error" | "missing";

export interface DetectorTiming {
  detectorId: string;
  tier: DetectorTier;
  durationMs: number;
  status: DetectorStatus;
  findings: number;
  error?: string;
}

export interface AppliedAction {
  detectorId: string;
  category: GuardCategory;
  dataClass?: GuardDataClass;
  score: number;
  /** The action the profile asked for. */
  requested: GuardAction;
  /** The action that took effect after coercions and fallbacks. */
  effective: GuardAction;
  shadow: boolean;
  /** Why `effective` differs from `requested`, when it does. */
  reason?: string;
  /** Provider named by the rule for `protect`. */
  providerId?: string;
}

export interface GuardTraceEntry {
  at: number;
  kind:
    | "start"
    | "tier"
    | "detector"
    | "finding"
    | "action"
    | "short_circuit"
    | "budget"
    | "transform"
    | "fallback"
    | "coerced"
    | "verdict";
  message: string;
  data?: Record<string, unknown>;
}

export interface GuardVerdict {
  /** The most severe effective action. `allow` when nothing fired or everything is in shadow mode. */
  action: GuardAction;
  /** Convenience: `action === "block"`. */
  blocked: boolean;
  /** Findings at or above their detector's threshold. */
  findings: GuardFinding[];
  /** Findings below threshold, kept for the trace. */
  suppressed: GuardFinding[];
  actions: AppliedAction[];
  /** Content after redact, mask, protect and transform; the original content otherwise. */
  content: unknown;
  transformed: boolean;
  /** Tokens issued by protection providers, keyed by data class. Tokens only, never values. */
  protectedTokens: Array<{ dataClass: GuardDataClass; providerId: string; token: string }>;
  timings: { totalMs: number; detectors: DetectorTiming[] };
  budget: { limitMs: number; exceeded: boolean; policy: "fail_open" | "fail_closed" };
  trace: GuardTraceEntry[];
  profile: { id: string; version: string; hash: string };
  channel: GuardChannel;
}

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

export class GuardProfileError extends GuardError {
  constructor(message: string) {
    super(message);
    this.name = "GuardProfileError";
  }
}

export class GuardProtectionError extends GuardError {
  readonly providerId: string;
  constructor(providerId: string, message: string) {
    super(message);
    this.name = "GuardProtectionError";
    this.providerId = providerId;
  }
}

/** Canonical text of an input. Strings pass through; other values are serialised with sorted keys. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined) return "";
  return stableStringify(content);
}

/** JSON with object keys in sorted order so the same value always produces the same text. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined) out[key] = sortKeys(inner);
    }
    return out;
  }
  return value;
}

/** Clamp a score into 0..1 and round it so traces are stable. */
export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000;
}

/** Noisy-or of independent scores: the chance that at least one of them is right. */
export function combineScores(scores: readonly number[]): number {
  let miss = 1;
  for (const score of scores) miss *= 1 - clampScore(score);
  return clampScore(1 - miss);
}
