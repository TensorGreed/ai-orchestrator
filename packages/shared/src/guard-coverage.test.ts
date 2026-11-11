import { describe, expect, it } from "vitest";
import {
  GUARD_CHANNEL_VALUES,
  GUARD_PLACEMENT_VALUES,
  GUARD_PROFILE_CHANNEL_VALUES,
  REVEAL_RULES_ADMIN_ONLY_MESSAGE,
  findRevealRule,
  guardDocumentHasRevealRules,
  guardNodeConfigSchema,
  parseGuardPlacement,
  revealRuleAllows,
  revealRuleMatchesSubject
} from "./guard";

describe("content rules coverage: shared contract", () => {
  it("adds the response and trigger_input channels to rule sets only", () => {
    expect(GUARD_PROFILE_CHANNEL_VALUES).toEqual([...GUARD_CHANNEL_VALUES, "egress", "response", "trigger_input"]);
    // The Content Rules node keeps its channel list.
    expect(GUARD_CHANNEL_VALUES).toEqual(["prompt", "model_output", "tool_arguments", "tool_result", "final_output"]);
    for (const channel of ["egress", "response", "trigger_input"]) {
      expect(guardNodeConfigSchema.safeParse({ channel }).success).toBe(false);
    }
  });

  it("keeps a Content Rules node config written before this change exactly as it was", () => {
    const stored = { profileId: "strict", channel: "tool_result", inputField: "payload.body", labels: ["untrusted_external"], approvalMessage: "Check it", timeoutMinutes: 60 };
    expect(guardNodeConfigSchema.parse(stored)).toEqual(stored);
  });

  it("lists the new placements after the existing ones", () => {
    expect(GUARD_PLACEMENT_VALUES).toEqual(["node", "agent", "gateway", "response", "retrieval", "reveal"]);
  });

  it("reads stored placements back, unknown ones as node as before", () => {
    for (const placement of GUARD_PLACEMENT_VALUES) expect(parseGuardPlacement(placement)).toBe(placement);
    expect(parseGuardPlacement("something_else")).toBe("node");
    expect(parseGuardPlacement(null)).toBe("node");
    expect(parseGuardPlacement(undefined)).toBe("node");
  });
});

describe("reveal rules: authorship and matching (decision 2026-11-10)", () => {
  const rule = { dataClasses: ["card_number"], subjects: { roles: ["admin"], users: ["u-1"], serviceAccounts: ["sa-1"] } };

  it("detects reveal rules in a submitted document", () => {
    expect(guardDocumentHasRevealRules({ reveal: { rules: [rule] } })).toBe(true);
    expect(guardDocumentHasRevealRules({ reveal: { rules: [] } })).toBe(false);
    expect(guardDocumentHasRevealRules({ reveal: {} })).toBe(false);
    expect(guardDocumentHasRevealRules({})).toBe(false);
    expect(guardDocumentHasRevealRules(null)).toBe(false);
    expect(REVEAL_RULES_ADMIN_ONLY_MESSAGE).toBe("Only an admin can save a rule set with reveal rules");
  });

  it("matches roles and users only for runs a signed-in person started", () => {
    expect(revealRuleMatchesSubject(rule, { source: "user", role: "admin" })).toBe(true);
    expect(revealRuleMatchesSubject(rule, { source: "user", role: "builder", userId: "u-1" })).toBe(true);
    expect(revealRuleMatchesSubject(rule, { source: "user", role: "builder", userId: "u-2" })).toBe(false);
    // Webhook, chat and schedule runs act as the workflow owner: never a role or user match.
    for (const source of ["owner", "fallback", "client"]) {
      expect(revealRuleMatchesSubject(rule, { source, role: "admin", userId: "u-1" }), source).toBe(false);
    }
    expect(revealRuleMatchesSubject(rule, null)).toBe(false);
  });

  it("matches service accounts explicitly, whatever started the run", () => {
    expect(revealRuleMatchesSubject(rule, { source: "owner", serviceAccountId: "sa-1" })).toBe(true);
    expect(revealRuleMatchesSubject(rule, { source: "owner", serviceAccountId: "sa-2" })).toBe(false);
  });

  it("checks the data class and the workflow list; deny when nothing matches", () => {
    const scoped = { ...rule, workflows: ["wf-1"] };
    const subject = { source: "user", role: "admin" };
    expect(revealRuleAllows(scoped, { subject, dataClass: "card_number", workflowId: "wf-1" })).toBe(true);
    expect(revealRuleAllows(scoped, { subject, dataClass: "card_number", workflowId: "wf-2" })).toBe(false);
    expect(revealRuleAllows(scoped, { subject, dataClass: "card_number" })).toBe(false);
    expect(revealRuleAllows(scoped, { subject, dataClass: "email", workflowId: "wf-1" })).toBe(false);
    expect(findRevealRule([scoped, rule], { subject, dataClass: "card_number", workflowId: "wf-9" })).toBe(rule);
    expect(findRevealRule([], { subject, dataClass: "card_number" })).toBeUndefined();
  });

  it("refuses reveal rules in a Content Rules node's inline override", () => {
    const refused = guardNodeConfigSchema.safeParse({ profileOverride: { reveal: { rules: [rule] } } });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toContain("stored rule set");
    expect(guardNodeConfigSchema.safeParse({ profileOverride: { shadow: { block: true } } }).success).toBe(true);
  });
});
