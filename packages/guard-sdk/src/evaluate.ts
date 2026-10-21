import { maskForDataClass } from "./masking";
import type { ActionRule, GuardProfile } from "./profile";
import { hashGuardProfile } from "./profile";
import type { ProtectionRegistry } from "./protection/registry";
import type { GuardRegistry } from "./registry";
import {
  DETECTOR_TIERS,
  INJECTION_CATEGORIES,
  contentText,
  type AppliedAction,
  type DetectorContext,
  type DetectorTier,
  type DetectorTiming,
  type GuardAction,
  type GuardDetector,
  type GuardFinding,
  type GuardInput,
  type GuardSpan,
  type GuardTraceEntry,
  type GuardVerdict
} from "./types";

/**
 * Phase 12.1 — evaluation. `evaluateGuard` runs the channel's detectors by
 * tier, cheapest first, applies the profile's actions to each finding and
 * returns one verdict with the transformed content, timings and a decision
 * trace. It is deterministic for a given profile, input and detector set:
 * detectors run in profile order within a tier, and findings are applied in
 * that order.
 *
 * Semantics worth knowing:
 * - A `block` that is not in shadow mode stops the remaining detectors.
 * - The latency budget is checked before every detector and each detector is
 *   raced against the time left. Over budget: `fail_closed` blocks,
 *   `fail_open` lets the content through with what was found so far. A
 *   detector that throws, or a detector the profile names that is not
 *   registered, is treated the same way as an exceeded budget.
 * - Injection findings (`prompt_injection`, `indirect_injection`,
 *   `canary_leak`) are never redacted, masked, protected or transformed: those
 *   requests become `block`.
 * - `protect` without a provider for the finding's data class, or with a
 *   provider that fails, applies the profile's fallback (default `block`).
 */

export interface EvaluateGuardOptions {
  registry: GuardRegistry;
  protection?: ProtectionRegistry;
  /** Monotonic clock in milliseconds; defaults to `performance.now`. */
  now?: () => number;
  /** Wall-clock timer for detector timeouts; defaults to `setTimeout`. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const SEVERITY: Record<GuardAction, number> = {
  allow: 0,
  transform: 1,
  mask: 2,
  redact: 3,
  protect: 4,
  review: 5,
  require_approval: 6,
  block: 7
};

const ENGINE = "<engine>";

export function mostSevereAction(actions: readonly GuardAction[]): GuardAction {
  let best: GuardAction = "allow";
  for (const action of actions) if (SEVERITY[action] > SEVERITY[best]) best = action;
  return best;
}

function orderByTier(entries: Array<{ detector: GuardDetector | undefined; id: string; threshold: number; options: Record<string, unknown> }>) {
  const rank = (tier: DetectorTier | undefined) => (tier ? DETECTOR_TIERS.indexOf(tier) : DETECTOR_TIERS.length);
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry.detector?.tier) - rank(b.entry.detector?.tier) || a.index - b.index)
    .map((x) => x.entry);
}

interface Replacement {
  span: GuardSpan;
  text: string;
  priority: number;
}

export async function evaluateGuard(profile: GuardProfile, input: GuardInput, options: EvaluateGuardOptions): Promise<GuardVerdict> {
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const started = now();
  const trace: GuardTraceEntry[] = [];
  const log = (kind: GuardTraceEntry["kind"], message: string, data?: Record<string, unknown>) => {
    trace.push({ at: Math.round((now() - started) * 1000) / 1000, kind, message, ...(data ? { data } : {}) });
  };
  const text = contentText(input.content);
  const channel = profile.channels[input.channel];
  const profileRef = { id: profile.id, version: profile.version, hash: hashGuardProfile(profile) };
  const budget = { limitMs: profile.latencyBudget.ms, exceeded: false, policy: profile.latencyBudget.onExceeded };
  const timings: DetectorTiming[] = [];
  const findings: GuardFinding[] = [];
  const suppressed: GuardFinding[] = [];
  const applied: AppliedAction[] = [];
  const effectiveActions: GuardAction[] = [];
  const dictionaries = profile.dictionaries;

  log("start", `Evaluating ${input.channel} with profile ${profile.id}@${profile.version}`, {
    labels: input.labels ?? [],
    chars: text.length,
    tool: input.tool?.toolName
  });

  if (!channel || channel.detectors.length === 0) {
    log("verdict", "No detectors configured for this channel; allowed");
    return finish("allow");
  }

  const entries = orderByTier(
    channel.detectors.map((entry) => ({
      id: entry.id,
      threshold: entry.threshold,
      options: entry.options,
      detector: options.registry.get(entry.id)
    }))
  );

  const shadowFor = (rule: ActionRule, action: GuardAction): boolean => rule.shadow ?? profile.shadow[action] ?? false;

  const ruleFor = (finding: GuardFinding): ActionRule => {
    if (finding.dataClass && channel.actions[finding.dataClass]) return channel.actions[finding.dataClass]!;
    if (channel.actions[finding.category]) return channel.actions[finding.category]!;
    return channel.defaultAction;
  };

  let shortCircuited = false;
  let failed = false;
  let currentTier: DetectorTier | undefined;

  for (const entry of entries) {
    const tier = entry.detector?.tier;
    if (tier && tier !== currentTier) {
      currentTier = tier;
      log("tier", `Running ${tier} tier`);
    }
    if (shortCircuited || failed) {
      timings.push({ detectorId: entry.id, tier: tier ?? "rule", durationMs: 0, status: failed ? "skipped_budget" : "skipped_short_circuit", findings: 0 });
      continue;
    }
    const elapsed = now() - started;
    if (elapsed >= budget.limitMs) {
      budget.exceeded = true;
      log("budget", `Latency budget of ${budget.limitMs} ms exceeded before ${entry.id}; policy ${budget.policy}`, { elapsedMs: elapsed });
      timings.push({ detectorId: entry.id, tier: tier ?? "rule", durationMs: 0, status: "skipped_budget", findings: 0 });
      failed = true;
      continue;
    }
    if (!entry.detector) {
      log("detector", `Detector ${entry.id} is not registered; treated as a failure (${budget.policy})`);
      timings.push({ detectorId: entry.id, tier: "rule", durationMs: 0, status: "missing", findings: 0 });
      failed = true;
      continue;
    }
    const detector = entry.detector;
    const context: DetectorContext = {
      text,
      options: { ...(dictionaries.length ? { dictionaries } : {}), ...entry.options },
      now
    };
    const detectorStart = now();
    const remaining = Math.max(1, budget.limitMs - elapsed);
    let result: GuardFinding[] | "timeout" | Error;
    try {
      result = await raceWithTimeout(Promise.resolve(detector.detect(input, context)), remaining, setTimer, clearTimer);
    } catch (error) {
      result = error instanceof Error ? error : new Error(String(error));
    }
    const durationMs = Math.round((now() - detectorStart) * 1000) / 1000;
    if (result === "timeout") {
      budget.exceeded = true;
      timings.push({ detectorId: detector.id, tier: detector.tier, durationMs, status: "timed_out", findings: 0 });
      log("budget", `Detector ${detector.id} exceeded the remaining budget (${remaining} ms); policy ${budget.policy}`);
      failed = true;
      continue;
    }
    if (result instanceof Error) {
      timings.push({ detectorId: detector.id, tier: detector.tier, durationMs, status: "error", findings: 0, error: result.message });
      log("detector", `Detector ${detector.id} failed: ${result.message}; policy ${budget.policy}`);
      failed = true;
      continue;
    }
    const kept: GuardFinding[] = [];
    for (const finding of result) {
      if (finding.score >= entry.threshold) kept.push(finding);
      else suppressed.push(finding);
    }
    timings.push({ detectorId: detector.id, tier: detector.tier, durationMs, status: "ran", findings: kept.length });
    log("detector", `${detector.id} (${detector.tier}) ran in ${durationMs} ms: ${kept.length} finding(s), ${result.length - kept.length} below threshold ${entry.threshold}`);

    for (const finding of kept) {
      findings.push(finding);
      const rule = ruleFor(finding);
      const requested = rule.action;
      let effective = requested;
      let reason: string | undefined;
      if (INJECTION_CATEGORIES.has(finding.category) && (requested === "protect" || requested === "redact" || requested === "mask" || requested === "transform")) {
        effective = "block";
        reason = `${finding.category} findings are never ${requested}ed; they block or go to review`;
        log("coerced", reason, { detectorId: finding.detectorId });
      }
      if (effective === "transform" && !detector.transform) {
        effective = "block";
        reason = `${detector.id} has no transform; the finding blocks instead`;
        log("coerced", reason, { detectorId: finding.detectorId });
      }
      const shadow = shadowFor(rule, effective);
      log("finding", `${finding.detectorId}: ${finding.category}${finding.dataClass ? `/${finding.dataClass}` : ""} score ${finding.score} → ${effective}${shadow ? " (shadow)" : ""}`, {
        evidence: finding.evidence,
        spans: finding.spans
      });
      applied.push({
        detectorId: finding.detectorId,
        category: finding.category,
        ...(finding.dataClass ? { dataClass: finding.dataClass } : {}),
        score: finding.score,
        requested,
        effective,
        shadow,
        ...(reason ? { reason } : {}),
        ...(rule.providerId ? { providerId: rule.providerId } : {})
      });
      if (!shadow) effectiveActions.push(effective);
      if (effective === "block" && !shadow && !shortCircuited) {
        shortCircuited = true;
        log("short_circuit", `Blocked by ${finding.detectorId}; remaining detectors skipped`);
      }
    }
  }

  if (failed) {
    if (budget.policy === "fail_closed") {
      effectiveActions.push("block");
      applied.push({ detectorId: ENGINE, category: budget.exceeded ? "latency_budget" : "detector_failure", score: 1, requested: "block", effective: "block", shadow: false, reason: budget.exceeded ? "latency budget exceeded (fail closed)" : "detector failure (fail closed)" });
      log("verdict", "Fail closed: blocked");
      return finish("block");
    }
    log("budget", "Fail open: continuing with the findings so far");
  }

  const overall = mostSevereAction(effectiveActions);
  if (overall === "block") {
    log("verdict", "Blocked");
    return finish("block");
  }

  // Content transforms for non-shadow redact, mask, protect and transform actions.
  const replacements: Replacement[] = [];
  const protectedTokens: GuardVerdict["protectedTokens"] = [];
  const transformsByDetector = new Map<string, GuardFinding[]>();
  let fallbackBlock = false;

  for (let i = 0; i < findings.length; i += 1) {
    const finding = findings[i]!;
    const action = applied[i];
    if (!action || action.shadow) continue;
    switch (action.effective) {
      case "redact":
        for (const span of finding.spans) replacements.push({ span, text: `[REDACTED:${finding.dataClass ?? finding.category}]`, priority: 3 });
        break;
      case "mask":
        for (const span of finding.spans) replacements.push({ span, text: maskForDataClass(text.slice(span.start, span.end), finding.dataClass), priority: 1 });
        break;
      case "transform": {
        const list = transformsByDetector.get(finding.detectorId) ?? [];
        list.push(finding);
        transformsByDetector.set(finding.detectorId, list);
        break;
      }
      case "protect": {
        const outcome = await protectFinding(finding, action, text);
        if (outcome.kind === "fallback") {
          const fallback = profile.protection.fallback;
          action.effective = fallback;
          action.reason = outcome.reason;
          log("fallback", `${outcome.reason}; applying fallback '${fallback}'`, { detectorId: finding.detectorId, dataClass: finding.dataClass });
          if (fallback === "block") fallbackBlock = true;
          else if (fallback === "redact") for (const span of finding.spans) replacements.push({ span, text: `[REDACTED:${finding.dataClass ?? finding.category}]`, priority: 3 });
          else if (fallback === "mask") for (const span of finding.spans) replacements.push({ span, text: maskForDataClass(text.slice(span.start, span.end), finding.dataClass), priority: 1 });
        } else {
          for (const item of outcome.tokens) {
            replacements.push({ span: item.span, text: item.token, priority: 2 });
            protectedTokens.push({ dataClass: finding.dataClass ?? finding.category, providerId: outcome.providerId, token: item.token });
          }
        }
        break;
      }
      default:
        break;
    }
  }

  if (fallbackBlock) {
    log("verdict", "Blocked by the protection fallback");
    return finish("block");
  }

  let transformedText = applyReplacements(text, replacements);
  let transformed = transformedText !== text;
  for (const [detectorId, list] of transformsByDetector) {
    const detector = options.registry.get(detectorId);
    if (!detector?.transform) continue;
    const before = transformedText;
    transformedText = detector.transform(transformedText, list, { text: transformedText, options: {}, now });
    if (transformedText !== before) {
      transformed = true;
      log("transform", `${detectorId} transformed the content`, { removedChars: before.length - transformedText.length });
    }
  }
  if (replacements.length > 0) {
    log("transform", `${replacements.length} span(s) rewritten`, {
      redacted: replacements.filter((r) => r.priority === 3).length,
      protected: replacements.filter((r) => r.priority === 2).length,
      masked: replacements.filter((r) => r.priority === 1).length
    });
  }

  // Fallbacks may have changed effective actions, so rank from the applied list.
  const finalAction = mostSevereAction(applied.filter((a) => !a.shadow).map((a) => a.effective));
  log("verdict", finalAction === "allow" ? "Allowed" : `Verdict ${finalAction}`);
  return finish(finalAction, transformed ? restoreShape(input.content, transformedText) : input.content, transformed, protectedTokens);

  async function protectFinding(
    finding: GuardFinding,
    action: AppliedAction,
    source: string
  ): Promise<{ kind: "ok"; providerId: string; tokens: Array<{ span: GuardSpan; token: string }> } | { kind: "fallback"; reason: string }> {
    const dataClass = finding.dataClass;
    if (!dataClass) return { kind: "fallback", reason: `${finding.category} finding has no data class to protect` };
    const mapping = profile.protection.dataClasses[dataClass];
    const providerId = action.providerId ?? mapping?.providerId;
    if (!providerId) return { kind: "fallback", reason: `No protection provider mapped for data class '${dataClass}'` };
    if (!options.protection) return { kind: "fallback", reason: "No protection registry available" };
    try {
      const provider = options.protection.resolve(providerId, dataClass);
      const tokens: Array<{ span: GuardSpan; token: string }> = [];
      for (const span of finding.spans) {
        const token = await provider.protect(source.slice(span.start, span.end), { dataClass, options: mapping?.options ?? {} });
        tokens.push({ span, token });
      }
      return { kind: "ok", providerId, tokens };
    } catch (error) {
      return { kind: "fallback", reason: `Protection provider '${providerId}' failed: ${(error as Error).message}` };
    }
  }

  function finish(action: GuardAction, content: unknown = input.content, transformed = false, protectedTokens: GuardVerdict["protectedTokens"] = []): GuardVerdict {
    return {
      action,
      blocked: action === "block",
      findings,
      suppressed,
      actions: applied,
      content,
      transformed,
      protectedTokens,
      timings: { totalMs: Math.round((now() - started) * 1000) / 1000, detectors: timings },
      budget,
      trace,
      profile: profileRef,
      channel: input.channel
    };
  }
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  setTimer: NonNullable<EvaluateGuardOptions["setTimer"]>,
  clearTimer: NonNullable<EvaluateGuardOptions["clearTimer"]>
): Promise<T | "timeout"> {
  let handle: unknown;
  const timeout = new Promise<"timeout">((resolve) => {
    handle = setTimer(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimer(handle);
  }
}

/** Apply span replacements right to left; where spans overlap the higher priority wins and the other is dropped. */
export function applyReplacements(text: string, replacements: readonly Replacement[]): string {
  const sorted = [...replacements].filter((r) => r.span.end > r.span.start).sort((a, b) => b.priority - a.priority || a.span.start - b.span.start);
  const chosen: Replacement[] = [];
  for (const candidate of sorted) {
    if (chosen.some((c) => candidate.span.start < c.span.end && c.span.start < candidate.span.end)) continue;
    chosen.push(candidate);
  }
  chosen.sort((a, b) => b.span.start - a.span.start);
  let out = text;
  for (const r of chosen) out = out.slice(0, r.span.start) + r.text + out.slice(r.span.end);
  return out;
}

/** JSON content comes back as JSON when the transformed text still parses; otherwise the text is returned. */
function restoreShape(original: unknown, transformedText: string): unknown {
  if (typeof original === "string") return transformedText;
  try {
    return JSON.parse(transformedText);
  } catch {
    return transformedText;
  }
}
