import type { DetectorContext, GuardChannel, GuardDetector, GuardFinding, GuardInput } from "../types";
import { clampScore } from "../types";
import { injectionScore } from "./injection";
import { DIRECT_INJECTION_PATTERNS, INDIRECT_INJECTION_PATTERNS } from "./injection-patterns";

export const INJECTION_CLASSIFIER_DETECTOR_ID = "injection.classifier";

/**
 * Phase 12.2 — classifier tier, interface only. A deployment registers a
 * local model (ONNX runtime or a small model served next to the API) by
 * implementing `GuardClassifier`; nothing in this package downloads or runs
 * models. Without one, `RuleBasedInjectionClassifier` scores text from the
 * rule packs so the tier is never empty.
 */
export interface GuardClassification {
  /** 0..1 probability that the text is an attack. */
  score: number;
  label: string;
  /** Text spans the classifier attributes the score to, when it can. */
  spans?: Array<{ start: number; end: number }>;
}

export interface GuardClassifier {
  id: string;
  /** Model name or version, for the trace. */
  version: string;
  classify(text: string, channel: GuardChannel): Promise<GuardClassification> | GuardClassification;
}

export class RuleBasedInjectionClassifier implements GuardClassifier {
  readonly id = "rule-based";
  readonly version = "rule-pack";

  classify(text: string, channel: GuardChannel): GuardClassification {
    const patterns = channel === "tool_result" || channel === "tool_arguments" ? INDIRECT_INJECTION_PATTERNS : DIRECT_INJECTION_PATTERNS;
    const score = injectionScore(text, patterns);
    return { score, label: score >= 0.5 ? "injection" : "benign" };
  }
}

export function createInjectionClassifierDetector(classifier: GuardClassifier = new RuleBasedInjectionClassifier()): GuardDetector {
  return {
    id: INJECTION_CLASSIFIER_DETECTOR_ID,
    tier: "classifier",
    description: `Injection classifier (${classifier.id} ${classifier.version}); the rule pack stands in when no model is registered.`,
    channels: ["prompt", "tool_result", "model_output", "final_output"],
    categories: ["prompt_injection", "indirect_injection"],
    async detect(input: GuardInput, context: DetectorContext) {
      const result = await classifier.classify(context.text, input.channel);
      const score = clampScore(result.score);
      if (score <= 0) return [];
      const untrusted = input.channel === "tool_result" || input.labels?.includes("untrusted_external");
      const finding: GuardFinding = {
        detectorId: INJECTION_CLASSIFIER_DETECTOR_ID,
        category: untrusted ? "indirect_injection" : "prompt_injection",
        score,
        spans: result.spans ?? [{ start: 0, end: context.text.length }],
        evidence: `${classifier.id}: ${result.label}`,
        message: `Classifier ${classifier.id} labels the text '${result.label}'`,
        metadata: { classifier: classifier.id, version: classifier.version, label: result.label }
      };
      return [finding];
    }
  };
}
