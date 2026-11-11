import { createArgumentValidationDetector } from "./detectors/argument-validation";
import { createCanaryDetector } from "./detectors/canary";
import { createInjectionClassifierDetector, type GuardClassifier } from "./detectors/classifier";
import { createCodeGuardDetector, createCommandGuardDetector } from "./detectors/command-guard";
import { createDlpDetector, type NationalIdSpec } from "./detectors/dlp";
import { createEgressGuardDetector, type DnsResolver } from "./detectors/egress-guard";
import { createExfiltrationDetector } from "./detectors/exfiltration";
import { createHiddenUnicodeDetector } from "./detectors/hidden-unicode";
import { createOutputGroundingDetector } from "./detectors/output-grounding";
import { createOutputSafetyDetector, type GuardSafetyClassifier } from "./detectors/output-safety";
import { createOutputSchemaDetector } from "./detectors/output-schema";
import { createOutputTopicDetector } from "./detectors/output-topic";
import { createDirectInjectionDetector, createIndirectInjectionDetector } from "./detectors/injection";
import { createPathGuardDetector, type RealpathFn } from "./detectors/path-guard";
import { createSqlGuardDetector } from "./detectors/sql-guard";
import { GuardRegistry } from "./registry";

export * from "./types";
export * from "./masking";
export * from "./profile";
export * from "./registry";
export * from "./evaluate";
export * from "./default-profile";
export * from "./spotlighting";
export * from "./detectors/text-normalize";
export * from "./detectors/injection-patterns";
export * from "./detectors/injection";
export * from "./detectors/hidden-unicode";
export * from "./detectors/exfiltration";
export * from "./detectors/canary";
export * from "./detectors/classifier";
export * from "./detectors/dlp";
export * from "./detectors/sql-guard";
export * from "./detectors/command-guard";
export * from "./detectors/path-guard";
export * from "./detectors/egress-guard";
export * from "./detectors/argument-validation";
export * from "./detectors/output-model";
export * from "./detectors/output-schema";
export * from "./detectors/output-topic";
export * from "./detectors/output-safety";
export * from "./detectors/output-grounding";
export * from "./output-checks";
export * from "./protection/index";
export * from "./wiring";
export * from "./verdict-memo";
export * from "./stream-local";
export * from "./capture-mask";
export * from "./phone";
export * from "./destinations";
export * from "./benchmark";

export interface DefaultGuardRegistryOptions {
  /** DNS resolver for the egress guard. Default: never resolves, so only literal addresses are judged and every hostname is unresolved. */
  resolver?: DnsResolver;
  /** `realpath` for the path guard. Default: the local filesystem. */
  realpath?: RealpathFn;
  /** National-id specs for the DLP detector; the built-in list covers the US SSN and the UK NI number. */
  nationalIds?: NationalIdSpec[];
  /** Local classifier for the classifier tier; the rule pack stands in when omitted. */
  classifier?: GuardClassifier;
  /** Phase 12 coverage — local content safety classifier; the rule pack stands in when omitted. */
  safetyClassifier?: GuardSafetyClassifier;
}

/** Every built-in detector. Register more with `registry.register(...)`, or swap one with `replace`. */
export function createDefaultGuardRegistry(options: DefaultGuardRegistryOptions = {}): GuardRegistry {
  const registry = new GuardRegistry();
  registry.register(createDirectInjectionDetector());
  registry.register(createIndirectInjectionDetector());
  registry.register(createHiddenUnicodeDetector());
  registry.register(createExfiltrationDetector());
  registry.register(createCanaryDetector());
  registry.register(createInjectionClassifierDetector(options.classifier));
  registry.register(createDlpDetector({ nationalIds: options.nationalIds }));
  registry.register(createSqlGuardDetector());
  registry.register(createCommandGuardDetector());
  registry.register(createCodeGuardDetector());
  registry.register(createPathGuardDetector({ realpath: options.realpath }));
  registry.register(createEgressGuardDetector({ resolver: options.resolver }));
  registry.register(createArgumentValidationDetector());
  // Phase 12 coverage — output checks. No built-in rule set uses them; a rule set opts in by listing them.
  registry.register(createOutputSchemaDetector());
  registry.register(createOutputTopicDetector());
  registry.register(createOutputSafetyDetector(options.safetyClassifier));
  registry.register(createOutputGroundingDetector());
  return registry;
}
