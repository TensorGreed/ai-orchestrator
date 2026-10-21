import { excerptEvidence, mergeSpans } from "../masking";
import type { DetectorContext, GuardChannel, GuardDetector, GuardFinding, GuardInput, GuardSpan } from "../types";
import { clampScore, combineScores } from "../types";
import { DIRECT_INJECTION_PATTERNS, INDIRECT_INJECTION_PATTERNS, type InjectionPattern } from "./injection-patterns";
import { allViews, type NormalizedView } from "./text-normalize";

export const DIRECT_INJECTION_DETECTOR_ID = "injection.direct";
export const INDIRECT_INJECTION_DETECTOR_ID = "injection.indirect";

export interface InjectionHit {
  pattern: InjectionPattern;
  span: GuardSpan;
  view: NormalizedView["kind"];
  score: number;
}

function cleanupHits(hits: InjectionHit[]): InjectionHit[] {
  // One hit per pattern per overlapping region: the strongest view wins.
  const out: InjectionHit[] = [];
  for (const hit of hits.sort((a, b) => a.span.start - b.span.start || b.score - a.score)) {
    const dup = out.find((o) => o.pattern.id === hit.pattern.id && o.span.start < hit.span.end && hit.span.start < o.span.end);
    if (!dup) out.push(hit);
  }
  return out;
}

/** Run a rule pack over every normalised view of `text`. */
export function scanInjectionPatterns(text: string, patterns: readonly InjectionPattern[], maxHits = 32): InjectionHit[] {
  const hits: InjectionHit[] = [];
  const views = allViews(text);
  for (const view of views) {
    for (const pattern of patterns) {
      pattern.pattern.lastIndex = 0;
      for (const match of view.text.matchAll(pattern.pattern)) {
        const start = view.toOriginal(match.index ?? 0);
        const end = view.toOriginal((match.index ?? 0) + match[0].length);
        hits.push({ pattern, span: { start, end: Math.max(end, start + 1) }, view: view.kind, score: clampScore(pattern.weight * view.weight) });
        if (hits.length >= maxHits * 4) break;
      }
    }
  }
  return cleanupHits(hits).slice(0, maxHits);
}

/** Aggregate 0..1 score for a text: noisy-or over the distinct patterns that fired. */
export function injectionScore(text: string, patterns: readonly InjectionPattern[] = DIRECT_INJECTION_PATTERNS): number {
  const hits = scanInjectionPatterns(text, patterns);
  const best = new Map<string, number>();
  for (const hit of hits) best.set(hit.pattern.id, Math.max(best.get(hit.pattern.id) ?? 0, hit.score));
  return combineScores([...best.values()]);
}

function toFindings(detectorId: string, category: "prompt_injection" | "indirect_injection", text: string, hits: InjectionHit[]): GuardFinding[] {
  const findings = hits.map<GuardFinding>((hit) => ({
    detectorId,
    category,
    score: hit.score,
    spans: [hit.span],
    evidence: excerptEvidence(text, hit.span),
    message: `${hit.pattern.label}${hit.view !== "plain" ? ` (found after ${hit.view} decoding)` : ""}`,
    metadata: { patternId: hit.pattern.id, view: hit.view }
  }));
  // Several weak signals together are a strong one: add a combined finding
  // when at least two distinct patterns fired and none alone is conclusive.
  const distinct = new Map<string, number>();
  for (const hit of hits) distinct.set(hit.pattern.id, Math.max(distinct.get(hit.pattern.id) ?? 0, hit.score));
  if (distinct.size >= 2) {
    const combined = combineScores([...distinct.values()]);
    const max = Math.max(...distinct.values());
    if (combined > max) {
      findings.push({
        detectorId,
        category,
        score: combined,
        spans: mergeSpans(hits.map((h) => h.span)),
        evidence: `${distinct.size} patterns combined`,
        message: `${distinct.size} injection patterns in one text`,
        metadata: { patternIds: [...distinct.keys()], combined: true }
      });
    }
  }
  return findings;
}

function patternsFromOptions(base: readonly InjectionPattern[], options: Record<string, unknown>): InjectionPattern[] {
  const disabled = new Set(Array.isArray(options.disablePatterns) ? (options.disablePatterns as string[]) : []);
  const extra = Array.isArray(options.extraPatterns) ? (options.extraPatterns as Array<{ id: string; pattern: string; weight?: number; label?: string }>) : [];
  const list = base.filter((pattern) => !disabled.has(pattern.id));
  for (const item of extra) {
    if (!item?.id || !item.pattern) continue;
    try {
      list.push({ id: item.id, label: item.label ?? item.id, weight: clampScore(item.weight ?? 0.7), pattern: new RegExp(item.pattern, "giu") });
    } catch {
      // An invalid custom pattern is skipped; the profile validator reports it separately.
    }
  }
  return list;
}

export function createDirectInjectionDetector(): GuardDetector {
  return {
    id: DIRECT_INJECTION_DETECTOR_ID,
    tier: "rule",
    description: "Instruction override, jailbreak personas, system-prompt extraction and encoded payloads in user input and model output.",
    channels: ["prompt", "model_output", "final_output"],
    categories: ["prompt_injection"],
    detect(_input: GuardInput, context: DetectorContext) {
      const hits = scanInjectionPatterns(context.text, patternsFromOptions(DIRECT_INJECTION_PATTERNS, context.options));
      return toFindings(DIRECT_INJECTION_DETECTOR_ID, "prompt_injection", context.text, hits);
    }
  };
}

const UNTRUSTED_CHANNELS: readonly GuardChannel[] = ["tool_result", "tool_arguments", "prompt"];

export function createIndirectInjectionDetector(): GuardDetector {
  return {
    id: INDIRECT_INJECTION_DETECTOR_ID,
    tier: "rule",
    description: "Instructions planted in tool results, retrieved documents and other untrusted content: text that addresses the model, embedded tasks, hidden markup, planted tool calls.",
    channels: UNTRUSTED_CHANNELS,
    categories: ["indirect_injection"],
    detect(input: GuardInput, context: DetectorContext) {
      // On the prompt channel the detector only looks at content marked untrusted;
      // the direct pack covers what the user typed.
      if (input.channel === "prompt" && !input.labels?.includes("untrusted_external")) return [];
      const hits = scanInjectionPatterns(context.text, patternsFromOptions(INDIRECT_INJECTION_PATTERNS, context.options));
      return toFindings(INDIRECT_INJECTION_DETECTOR_ID, "indirect_injection", context.text, hits);
    }
  };
}
