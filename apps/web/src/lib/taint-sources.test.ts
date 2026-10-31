import { describe, expect, it } from "vitest";
import {
  canvasLabelBadge,
  describeEndorsement,
  describeTriggerTrust,
  readEndorsement,
  readTriggerTrust,
  triggerTrustResetText,
  withSensitiveOutput,
  withTriggerTrust,
  withTriggerTrustReapplied
} from "./taint-sources";

const approval = { kind: "human_approval", approvedBy: "maria@example.org", approvedAt: "2026-10-31T10:04:12.000Z", nodeIds: ["ask", "fetch"] };

describe("trigger trust", () => {
  it("reads only the two allowed values and removes the key for the default", () => {
    expect(readTriggerTrust({ inputTrust: "user" })).toBe("user");
    expect(readTriggerTrust({ inputTrust: "trusted" })).toBe("");
    expect(readTriggerTrust({})).toBe("");
    expect(withTriggerTrust({ path: "p" }, "untrusted_external")).toEqual({ path: "p", inputTrust: "untrusted_external" });
    expect(withTriggerTrust({ path: "p", inputTrust: "user" }, "")).toEqual({ path: "p" });
  });

  it("a changed setting drops its binding (the admin's save binds it again); re-applying keeps the setting", () => {
    const binding = { nodeType: "webhook_input", authMode: "none", secretId: null, path: "p" };
    expect(withTriggerTrust({ path: "p", inputTrust: "user", inputTrustFor: binding }, "untrusted_external")).toEqual({ path: "p", inputTrust: "untrusted_external" });
    expect(withTriggerTrust({ path: "p", inputTrust: "user", inputTrustFor: binding }, "")).toEqual({ path: "p" });
    expect(withTriggerTrustReapplied({ path: "p", inputTrust: "user", inputTrustFor: binding })).toEqual({ path: "p", inputTrust: "user" });
    // A reset only tightens: outside content still applies.
    expect(triggerTrustResetText("user")).toContain("Trust setting reset: trigger changed");
    expect(triggerTrustResetText("untrusted_external")).toContain("it still applies");
  });

  it("says what the input counts as for the auth mode", () => {
    expect(describeTriggerTrust("none", "")).toContain("outside content");
    expect(describeTriggerTrust("bearer_token", "")).toContain("verified caller counts as a user's");
    expect(describeTriggerTrust("hmac_sha256", "untrusted_external")).toContain("even from a verified caller");
    expect(describeTriggerTrust("none", "user")).toContain("Set by an admin");
  });
});

describe("sensitive output flag", () => {
  it("is stored only when on", () => {
    expect(withSensitiveOutput({ a: 1 }, true)).toEqual({ a: 1, sensitiveOutput: true });
    expect(withSensitiveOutput({ a: 1, sensitiveOutput: true }, false)).toEqual({ a: 1 });
  });
});

describe("canvas label badge", () => {
  it("shows outside content and sensitive data only, and nothing for runs without labels", () => {
    expect(canvasLabelBadge(undefined)).toBeNull();
    expect(canvasLabelBadge({ provenance: ["user"], dataClasses: ["email"], source: "propagated" })).toBeNull();
    expect(canvasLabelBadge({ provenance: ["user", "untrusted_external"], dataClasses: [] })).toMatchObject({ text: "outside", tone: "external", cleared: false });
    expect(canvasLabelBadge({ provenance: ["sensitive"], dataClasses: [] })).toMatchObject({ text: "sensitive", tone: "sensitive" });
    expect(canvasLabelBadge({ provenance: ["untrusted_external", "sensitive"], dataClasses: [] })?.text).toBe("outside · sensitive");
  });

  it("marks a node where an approval cleared outside content, with who and when in the tooltip", () => {
    const badge = canvasLabelBadge({ provenance: ["user"], dataClasses: [] }, approval)!;
    expect(badge).toMatchObject({ text: "cleared", cleared: true });
    expect(badge.title).toContain("maria@example.org");
     // An approval that showed nothing clears nothing: no badge.
    expect(canvasLabelBadge({ provenance: ["user"], dataClasses: [] }, { ...approval, nodeIds: [] })).toBeNull();
  });
});

describe("endorsements", () => {
  it("describe who cleared what and when; an approved tool call clears nothing", () => {
    expect(describeEndorsement(approval)).toBe("Outside content cleared by maria@example.org at 2026-10-31 10:04 UTC (Human Approval).");
    expect(describeEndorsement({ ...approval, kind: "approval_gate", approvedBy: null })).toBe("Outside content cleared by an approver at 2026-10-31 10:04 UTC (Approval Gate).");
    expect(describeEndorsement({ ...approval, kind: "tool_call", toolName: "send_email" })).toContain("its result is still outside content");
    // An approval that showed no step's data clears nothing.
    expect(describeEndorsement({ ...approval, nodeIds: [] })).toBe("Approved by maria@example.org at 2026-10-31 10:04 UTC (Human Approval); it showed no step's data, so nothing was cleared.");
  });

  it("ignore anything that is not an endorsement", () => {
    expect(readEndorsement(null)).toBeNull();
    expect(readEndorsement({ kind: "guard_scan", approvedAt: "x" })).toBeNull();
    expect(readEndorsement({ kind: "human_approval" })).toBeNull();
    expect(describeEndorsement("nope")).toBeNull();
  });
});
