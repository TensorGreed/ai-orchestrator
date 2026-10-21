import { ARGUMENT_VALIDATION_DETECTOR_ID } from "./detectors/argument-validation";
import { CANARY_DETECTOR_ID } from "./detectors/canary";
import { CODE_GUARD_DETECTOR_ID, COMMAND_GUARD_DETECTOR_ID } from "./detectors/command-guard";
import { DLP_DETECTOR_ID } from "./detectors/dlp";
import { EGRESS_GUARD_DETECTOR_ID } from "./detectors/egress-guard";
import { EXFILTRATION_DETECTOR_ID } from "./detectors/exfiltration";
import { HIDDEN_UNICODE_DETECTOR_ID } from "./detectors/hidden-unicode";
import { DIRECT_INJECTION_DETECTOR_ID, INDIRECT_INJECTION_DETECTOR_ID } from "./detectors/injection";
import { PATH_GUARD_DETECTOR_ID } from "./detectors/path-guard";
import { SQL_GUARD_DETECTOR_ID } from "./detectors/sql-guard";
import { parseGuardProfile, type GuardProfile, type GuardProfileInput } from "./profile";

export const DEFAULT_GUARD_PROFILE_ID = "default";

/**
 * The built-in profile. It blocks injection, tool-argument attacks and
 * schema violations, strips hidden characters, redacts credentials and
 * masks card numbers in what the model and the user see, and leaves
 * ordinary personal data alone. Deployments copy and adjust it; the
 * benchmark test measures this profile.
 */
export const DEFAULT_GUARD_PROFILE_DOCUMENT: GuardProfileInput = {
  id: DEFAULT_GUARD_PROFILE_ID,
  name: "Default guard profile",
  version: "1",
  description: "Blocks injection and tool-argument attacks, strips hidden characters, redacts credentials and masks card numbers.",
  latencyBudget: { ms: 2000, onExceeded: "fail_closed" },
  protection: { dataClasses: {}, fallback: "block" },
  channels: {
    prompt: {
      detectors: [
        { id: DIRECT_INJECTION_DETECTOR_ID, threshold: 0.6 },
        { id: INDIRECT_INJECTION_DETECTOR_ID, threshold: 0.6 },
        { id: HIDDEN_UNICODE_DETECTOR_ID, threshold: 0.5 },
        { id: DLP_DETECTOR_ID, threshold: 0.6 }
      ],
      actions: {
        prompt_injection: { action: "block" },
        indirect_injection: { action: "block" },
        hidden_payload: { action: "transform" },
        credential: { action: "redact" },
        private_key: { action: "redact" },
        jwt: { action: "redact" },
        sensitive_data: { action: "allow" }
      },
      defaultAction: { action: "block" }
    },
    tool_result: {
      detectors: [
        { id: INDIRECT_INJECTION_DETECTOR_ID, threshold: 0.6 },
        { id: HIDDEN_UNICODE_DETECTOR_ID, threshold: 0.5 },
        { id: EXFILTRATION_DETECTOR_ID, threshold: 0.7 },
        { id: DLP_DETECTOR_ID, threshold: 0.6 }
      ],
      actions: {
        indirect_injection: { action: "block" },
        hidden_payload: { action: "transform" },
        exfiltration: { action: "review" },
        credential: { action: "redact" },
        private_key: { action: "redact" },
        jwt: { action: "redact" },
        card_number: { action: "mask" },
        sensitive_data: { action: "allow" }
      },
      defaultAction: { action: "block" }
    },
    tool_arguments: {
      detectors: [
        { id: ARGUMENT_VALIDATION_DETECTOR_ID, threshold: 0.5 },
        { id: CANARY_DETECTOR_ID, threshold: 0.5 },
        { id: HIDDEN_UNICODE_DETECTOR_ID, threshold: 0.5 },
        { id: COMMAND_GUARD_DETECTOR_ID, threshold: 0.6 },
        { id: CODE_GUARD_DETECTOR_ID, threshold: 0.7 },
        { id: PATH_GUARD_DETECTOR_ID, threshold: 0.5 },
        { id: EGRESS_GUARD_DETECTOR_ID, threshold: 0.5 },
        { id: EXFILTRATION_DETECTOR_ID, threshold: 0.7 },
        { id: DLP_DETECTOR_ID, threshold: 0.6 },
        { id: SQL_GUARD_DETECTOR_ID, threshold: 0.5 }
      ],
      actions: {
        schema_violation: { action: "block" },
        canary_leak: { action: "block" },
        hidden_payload: { action: "transform" },
        command_injection: { action: "block" },
        unsafe_code: { action: "review" },
        path_traversal: { action: "block" },
        egress: { action: "block" },
        exfiltration: { action: "review" },
        sql_injection: { action: "block" },
        sql_policy: { action: "block" },
        private_key: { action: "block" },
        sensitive_data: { action: "allow" }
      },
      defaultAction: { action: "block" }
    },
    model_output: {
      detectors: [
        { id: CANARY_DETECTOR_ID, threshold: 0.5 },
        { id: HIDDEN_UNICODE_DETECTOR_ID, threshold: 0.5 },
        { id: EXFILTRATION_DETECTOR_ID, threshold: 0.6 },
        { id: DLP_DETECTOR_ID, threshold: 0.6 }
      ],
      actions: {
        canary_leak: { action: "block" },
        hidden_payload: { action: "transform" },
        exfiltration: { action: "block" },
        credential: { action: "redact" },
        private_key: { action: "redact" },
        jwt: { action: "redact" },
        card_number: { action: "mask" },
        sensitive_data: { action: "allow" }
      },
      defaultAction: { action: "block" }
    },
    final_output: {
      detectors: [
        { id: CANARY_DETECTOR_ID, threshold: 0.5 },
        { id: HIDDEN_UNICODE_DETECTOR_ID, threshold: 0.5 },
        { id: EXFILTRATION_DETECTOR_ID, threshold: 0.6 },
        { id: DLP_DETECTOR_ID, threshold: 0.6 }
      ],
      actions: {
        canary_leak: { action: "block" },
        hidden_payload: { action: "transform" },
        exfiltration: { action: "block" },
        credential: { action: "redact" },
        private_key: { action: "redact" },
        jwt: { action: "redact" },
        card_number: { action: "mask" },
        sensitive_data: { action: "allow" }
      },
      defaultAction: { action: "block" }
    }
  }
};

export function createDefaultGuardProfile(overrides: Partial<GuardProfileInput> = {}): GuardProfile {
  return parseGuardProfile({ ...DEFAULT_GUARD_PROFILE_DOCUMENT, ...overrides });
}
