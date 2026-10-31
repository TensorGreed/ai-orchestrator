import { describe, expect, it } from "vitest";
import {
  MCP_SAFETY_PRESETS,
  labelValueNeedsTracking,
  mcpSafetyPresetRule,
  mcpSafetyPresetRuleId,
  parseRecordedCallLabels,
  policyRulesNeedLabelTracking,
  recordedCallLabels,
  untrustedWriteSwitchRule,
  untrustedWriteSwitchRuleId
} from "./taint-policy";
import { mcpToolPolicyRuleInputSchema } from "./schemas";

describe("recorded call labels", () => {
  it("keeps label names only, and data class names only when the run tracked labels", () => {
    const labels = { provenance: ["sensitive", "untrusted_external"] as const, dataClasses: ["email", "card_number"] };
    expect(recordedCallLabels({ ...labels, provenance: [...labels.provenance] }, false)).toEqual({ provenance: ["untrusted_external", "sensitive"], tracked: false });
    expect(recordedCallLabels({ ...labels, provenance: [...labels.provenance] }, true)).toEqual({
      provenance: ["untrusted_external", "sensitive"],
      dataClasses: ["card_number", "email"],
      tracked: true
    });
    expect(recordedCallLabels(undefined, true)).toBeUndefined();
  });

  it("drops anything that is not a label name", () => {
    const recorded = recordedCallLabels(
      { provenance: ["user", "alice@example.com" as never], dataClasses: ["email", "4111 1111 1111 1111", "x".repeat(65)] },
      true
    );
    expect(recorded).toEqual({ provenance: ["user"], dataClasses: ["email"], tracked: true });
  });

  it("parses stored labels and refuses malformed ones", () => {
    expect(parseRecordedCallLabels(JSON.stringify({ provenance: ["user"], tracked: false }))).toEqual({ provenance: ["user"], tracked: false });
    expect(parseRecordedCallLabels({ provenance: ["user"], dataClasses: ["email"], tracked: true })).toEqual({ provenance: ["user"], dataClasses: ["email"], tracked: true });
    // An untracked record never carries class names, even if a row was edited to hold some.
    expect(parseRecordedCallLabels({ provenance: [], dataClasses: ["email"], tracked: false })).toEqual({ provenance: [], tracked: false });
    expect(parseRecordedCallLabels({ provenance: ["secret value"], tracked: false })).toBeNull();
    expect(parseRecordedCallLabels("not json")).toBeNull();
    expect(parseRecordedCallLabels(null)).toBeNull();
  });
});

describe("which rules need label tracking", () => {
  const rule = (value: string, enabled = true) => ({ enabled, conditions: { all: [{ op: "label_present" as const, value }] } });
  it("needs it for sensitive and data class conditions, not for provenance every run knows", () => {
    expect(labelValueNeedsTracking("sensitive")).toBe(true);
    expect(labelValueNeedsTracking("email")).toBe(true);
    expect(labelValueNeedsTracking("untrusted_external")).toBe(false);
    expect(policyRulesNeedLabelTracking([rule("untrusted_external"), rule("user")])).toBe(false);
    expect(policyRulesNeedLabelTracking([rule("untrusted_external"), rule("sensitive")])).toBe(true);
    expect(policyRulesNeedLabelTracking([rule("email", false)])).toBe(false);
    expect(policyRulesNeedLabelTracking([{ enabled: true, conditions: { any: [{ op: "label_absent", value: "card_number" }] } }])).toBe(true);
    expect(policyRulesNeedLabelTracking([{ enabled: true, conditions: null }])).toBe(false);
  });
});

describe("safety presets and the workflow switch", () => {
  it("creates every preset's rule in shadow, for everyone, with a fixed id", () => {
    for (const preset of MCP_SAFETY_PRESETS) {
      const rule = mcpSafetyPresetRule(preset.id);
      expect(rule).toMatchObject({ id: mcpSafetyPresetRuleId(preset.id), mode: "shadow", enabled: true, kind: "tool", workflowIds: [], roles: [] });
      // Each preset is a rule the API would accept.
      expect(mcpToolPolicyRuleInputSchema.safeParse(rule).success).toBe(true);
    }
    expect(mcpSafetyPresetRule("untrusted_write_approval")).toMatchObject({
      effect: "require_approval",
      annotationHint: "not_read_only",
      conditions: { all: [{ op: "label_present", value: "untrusted_external" }] }
    });
    expect(mcpSafetyPresetRule("sensitive_no_open_world")).toMatchObject({
      effect: "deny",
      annotationHint: "open_world",
      conditions: { all: [{ op: "label_present", value: "sensitive" }] }
    });
  });

  it("scopes the switch's rule to one workflow, enforced", () => {
    expect(untrustedWriteSwitchRule("wf-1")).toMatchObject({
      id: untrustedWriteSwitchRuleId("wf-1"),
      workflowIds: ["wf-1"],
      mode: "enforce",
      effect: "require_approval",
      annotationHint: "not_read_only"
    });
    expect(untrustedWriteSwitchRuleId("wf-1")).not.toBe(untrustedWriteSwitchRuleId("wf-10"));
  });
});
