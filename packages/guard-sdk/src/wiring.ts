import type { GuardDestinationSummary } from "@ai-orchestrator/shared";
import { evaluateGuard, mostSevereAction, type EvaluateGuardOptions } from "./evaluate";
import { parseGuardProfile, type GuardProfile } from "./profile";
import {
  GUARD_CHANNELS,
  stableStringify,
  type AppliedAction,
  type DetectorTiming,
  type GuardAction,
  type GuardChannel,
  type GuardDataClass,
  type GuardInput,
  type GuardSpan,
  type GuardVerdict
} from "./types";

/**
 * Phase 12.1 — helpers the wiring layer (engine, runtime hooks, API) shares:
 * a safe verdict summary for events and traces, stacked evaluation for
 * enforced profiles, inline overrides, protection bindings, profile diffs
 * and key decoding. Nothing here returns raw matched content.
 */

export interface GuardFindingSummary {
  detectorId: string;
  category: string;
  dataClass?: GuardDataClass;
  score: number;
  /** Masked evidence, exactly as the detector produced it. */
  evidence: string;
  spans: GuardSpan[];
  message: string;
}

export interface GuardVerdictSummary {
  action: GuardAction;
  blocked: boolean;
  channel: GuardChannel;
  transformed: boolean;
  findings: GuardFindingSummary[];
  actions: AppliedAction[];
  /** The most severe action among shadow-mode rules: what would have happened if they were enforced. */
  shadowAction: GuardAction;
  /** Number of tokens protection providers issued; the tokens themselves stay out of summaries. */
  protectedCount: number;
  timings: { totalMs: number; detectors: DetectorTiming[] };
  budget: { limitMs: number; exceeded: boolean; policy: "fail_open" | "fail_closed"; skippedDetectors: string[] };
  profile: { id: string; version: string; hash: string };
  /** Phase 16 — where the content was going, when the profile's destination rules were evaluated. */
  destination?: GuardDestinationSummary;
}

/** A verdict without its content, tokens or decision trace: safe to store and show. */
export function summarizeGuardVerdict(verdict: GuardVerdict): GuardVerdictSummary {
  const shadowActions = verdict.actions.filter((action) => action.shadow).map((action) => action.effective);
  const skipped = verdict.timings.detectors
    .filter((timing) => timing.status === "skipped_budget" || timing.status === "timed_out")
    .map((timing) => timing.detectorId);
  return {
    action: verdict.action,
    blocked: verdict.blocked,
    channel: verdict.channel,
    transformed: verdict.transformed,
    findings: verdict.findings.map((finding) => ({
      detectorId: finding.detectorId,
      category: finding.category,
      ...(finding.dataClass ? { dataClass: finding.dataClass } : {}),
      score: finding.score,
      evidence: finding.evidence,
      spans: finding.spans.map((span) => ({ start: span.start, end: span.end })),
      message: finding.message
    })),
    actions: verdict.actions.map((action) => ({ ...action })),
    shadowAction: mostSevereAction(shadowActions),
    protectedCount: verdict.protectedTokens.length,
    timings: { totalMs: verdict.timings.totalMs, detectors: verdict.timings.detectors.map((timing) => ({ ...timing })) },
    budget: { ...verdict.budget, skippedDetectors: skipped },
    profile: { ...verdict.profile },
    ...(verdict.destination ? { destination: { ...verdict.destination } } : {})
  };
}

export interface GuardStackResult {
  /** The most severe action across the evaluated profiles. */
  action: GuardAction;
  /** Content after every profile's rewrites. Unchanged when blocked. */
  content: unknown;
  transformed: boolean;
  verdicts: GuardVerdict[];
}

/**
 * Evaluate several profiles in order, each on the previous one's output.
 * Used when an admin enforces a project profile and a builder adds their own:
 * the enforced profile runs first and nothing a later profile does can make
 * the combined action less severe. Stops at the first block.
 */
export async function evaluateGuardStack(
  profiles: readonly GuardProfile[],
  input: GuardInput,
  options: EvaluateGuardOptions
): Promise<GuardStackResult> {
  const verdicts: GuardVerdict[] = [];
  let content = input.content;
  let transformed = false;
  for (const profile of profiles) {
    const verdict = await evaluateGuard(profile, { ...input, content }, options);
    verdicts.push(verdict);
    if (verdict.blocked) break;
    if (verdict.transformed) {
      content = verdict.content;
      transformed = true;
    }
  }
  const action = mostSevereAction(verdicts.map((verdict) => verdict.action));
  return { action, content: action === "block" ? input.content : content, transformed: action !== "block" && transformed, verdicts };
}

/**
 * Apply an inline override to a stored profile: top-level fields replace,
 * `channels`, `shadow` and `protection.dataClasses` merge per key, and
 * `latencyBudget` merges per field. The result is validated again.
 */
export function mergeGuardProfileOverride(base: GuardProfile, override: Record<string, unknown> | undefined): GuardProfile {
  if (!override || Object.keys(override).length === 0) return base;
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const protection = record(override.protection);
  const merged: Record<string, unknown> = {
    ...base,
    ...override,
    id: base.id,
    version: typeof override.version === "string" && override.version ? override.version : `${base.version}+override`,
    channels: { ...base.channels, ...record(override.channels) },
    shadow: { ...base.shadow, ...record(override.shadow) },
    latencyBudget: { ...base.latencyBudget, ...record(override.latencyBudget) },
    protection: {
      ...base.protection,
      ...protection,
      dataClasses: { ...base.protection.dataClasses, ...record(protection.dataClasses) }
    }
  };
  return parseGuardProfile(merged);
}

export interface ProtectionBinding {
  providerId: string;
  /** Data classes this provider covers; `*` covers every class the profile's DLP emits. */
  dataClasses: readonly string[] | "*";
  /** Key id handed to the provider (the wiring layer maps it to a secret). */
  keyId?: string;
  options?: Record<string, unknown>;
  /** Rewrite `allow`, `mask` and `redact` rules for these classes to `protect`. Never touches block, review or approval rules. */
  protectMatches?: boolean;
}

const PROTECTABLE: ReadonlySet<GuardAction> = new Set(["allow", "mask", "redact"]);

/**
 * Fold protection-port bindings into a profile. Mappings for the listed data
 * classes point at the bound provider; with `protectMatches` the rules that
 * would have let those classes through (or masked or redacted them) become
 * `protect`. Rules that block, review or require approval are never loosened.
 */
export function applyProtectionBindings(profile: GuardProfile, bindings: readonly ProtectionBinding[]): GuardProfile {
  if (bindings.length === 0) return profile;
  const next = JSON.parse(JSON.stringify(profile)) as GuardProfile;
  const knownClasses = new Set<string>(Object.keys(next.protection.dataClasses));
  for (const channel of GUARD_CHANNELS) {
    for (const key of Object.keys(next.channels[channel]?.actions ?? {})) knownClasses.add(key);
  }
  for (const dictionary of next.dictionaries) knownClasses.add(dictionary.dataClass);
  for (const builtIn of ["email", "phone", "card_number", "iban", "us_ssn", "national_id", "credential", "private_key", "jwt"]) knownClasses.add(builtIn);
  for (const binding of bindings) {
    const classes = binding.dataClasses === "*" ? [...knownClasses] : [...binding.dataClasses];
    for (const dataClass of classes) {
      next.protection.dataClasses[dataClass] = {
        providerId: binding.providerId,
        options: { ...(binding.options ?? {}), ...(binding.keyId ? { keyId: binding.keyId } : {}) }
      };
      if (binding.protectMatches === false) continue;
      for (const channel of GUARD_CHANNELS) {
        const channelProfile = next.channels[channel];
        if (!channelProfile) continue;
        const rule = channelProfile.actions[dataClass] ?? channelProfile.actions.sensitive_data;
        if (rule && PROTECTABLE.has(rule.action)) {
          channelProfile.actions[dataClass] = { ...rule, action: "protect", providerId: binding.providerId };
        }
      }
    }
  }
  return parseGuardProfile(next);
}

export interface GuardProfileChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

/** Leaf-level differences between two profile documents, in path order. */
export function diffGuardProfiles(before: unknown, after: unknown): GuardProfileChange[] {
  const changes: GuardProfileChange[] = [];
  const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const walk = (a: unknown, b: unknown, path: string) => {
    if (isObject(a) && isObject(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const key of keys) walk(a[key], b[key], path ? `${path}.${key}` : key);
      return;
    }
    if (a === undefined && b === undefined) return;
    if (a === undefined) changes.push({ path, kind: "added", after: b });
    else if (b === undefined) changes.push({ path, kind: "removed", before: a });
    else if (stableStringify(a) !== stableStringify(b)) changes.push({ path, kind: "changed", before: a, after: b });
  };
  walk(JSON.parse(stableStringify(before ?? {})), JSON.parse(stableStringify(after ?? {})), "");
  return changes;
}

/**
 * Key material from a secret value: base64 that decodes to at least 16 bytes
 * is used as bytes, anything else as its UTF-8 bytes.
 */
export function decodeGuardKeyMaterial(value: string | undefined): Uint8Array | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length % 4 === 0) {
    const bytes = Buffer.from(trimmed, "base64");
    if (bytes.length >= 16) return bytes;
  }
  return Buffer.from(trimmed, "utf8");
}
