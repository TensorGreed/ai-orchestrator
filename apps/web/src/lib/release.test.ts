import { describe, expect, it } from "vitest";
import { defaultReleaseGate } from "@ai-orchestrator/shared";
import { gateAdmissionBanner, gateFormFrom, gateLocks, gateSettingsFromForm, gateStatsLines, releaseActionsAdminOnly, releasePillLabel, releaseVerdictTone, repeatSelectionPhrase, workflowDeleteDenial } from "./release";

describe("release helpers", () => {
  it("labels the version pill by what production runs", () => {
    expect(releasePillLabel(null).text).toBe("Publish");
    expect(releasePillLabel({ draftVersion: null, publishedVersion: null, aheadBy: 0, gateEnabled: false, gateEnforced: false }).text).toBe("Not saved");
    expect(releasePillLabel({ draftVersion: 4, publishedVersion: null, aheadBy: 0, gateEnabled: false, gateEnforced: false })).toMatchObject({ text: "v4 · not published", tone: "draft" });
    expect(releasePillLabel({ draftVersion: 4, publishedVersion: 4, aheadBy: 0, gateEnabled: true, gateEnforced: false })).toMatchObject({ text: "v4 live", tone: "live" });
    const ahead = releasePillLabel({ draftVersion: 5, publishedVersion: 4, aheadBy: 1, gateEnabled: true, gateEnforced: false });
    expect(ahead).toMatchObject({ text: "v4 live · draft +1", tone: "ahead" });
    expect(ahead.title).toContain("1 newer saved version");
  });

  it("round-trips a gate through the form, with limits left empty meaning none", () => {
    const gate = { ...defaultReleaseGate("wf-1"), enabled: true, datasetIds: ["set-1"] };
    const form = gateFormFrom(gate);
    expect(form).toMatchObject({ minPassRatePct: "100", maxCostIncreasePct: "", mcpMode: "strict" });
    const { settings, errors } = gateSettingsFromForm({ ...form, minPassRatePct: "90", maxCostIncreasePct: "15" }, gate);
    expect(errors).toEqual([]);
    expect(settings).toMatchObject({ enabled: true, datasetIds: ["set-1"], approvers: null, policy: { minPassRate: 0.9, maxCostIncreasePct: 15 } });
    expect((settings.policy as Record<string, unknown>).maxP95LatencyIncreasePct).toBeUndefined();
  });

  it("refuses an enabled gate without sets, approval without approvers and a pass rate over 100", () => {
    const gate = defaultReleaseGate("wf-1");
    const { errors } = gateSettingsFromForm({ ...gateFormFrom(gate), enabled: true, requireApproval: true, minPassRatePct: "120" }, gate);
    expect(errors).toEqual(["Pick at least one golden set", "Minimum pass rate is a percentage up to 100", "Requiring approval needs at least one approver role or user"]);
    const users = gateSettingsFromForm({ ...gateFormFrom(gate), approverUsers: "a@example.com, b@example.com" }, gate).settings;
    expect(users.approvers).toMatchObject({ approverUsers: ["a@example.com", "b@example.com"], approverRoles: [], allowSelfApproval: false });
  });

  it("keeps approvers with no roles or users (anyone else who may publish) instead of dropping them (N10)", () => {
    const anyone = { approverRoles: [], approverUsers: [], allowSelfApproval: false, timeoutMinutes: 60 };
    const gate = { ...defaultReleaseGate("wf-1"), enabled: true, datasetIds: ["set-1"], requireApproval: true, approvers: anyone };
    const form = gateFormFrom(gate);
    expect(form.anyPublisherApproves).toBe(true);
    const { settings, errors } = gateSettingsFromForm(form, gate);
    expect(errors).toEqual([]);
    expect(settings.approvers).toEqual(anyone);
    expect(gateSettingsFromForm({ ...form, requireApproval: false, anyPublisherApproves: false }, gate).settings.approvers).toBeNull();
  });

  it("does not change the candidate options by naming the default MCP mode, and keeps a chosen one", () => {
    const gate = { ...defaultReleaseGate("wf-1"), enabled: true, datasetIds: ["set-1"], candidateOptions: { repeats: 3 } };
    expect(gateSettingsFromForm(gateFormFrom(gate), gate).settings.candidateOptions).toEqual({ repeats: 3 });
    expect(gateSettingsFromForm({ ...gateFormFrom(gate), mcpMode: "lenient" }, gate).settings.candidateOptions).toEqual({ repeats: 3, mcpMode: "lenient" });
  });

  it("locks admin-only fields on an enforced gate for non-admins, and self-approval for every non-admin", () => {
    expect(gateLocks({ enforced: true }, false)).toEqual({ adminOnly: true, selfApproval: true });
    expect(gateLocks({ enforced: false }, false)).toEqual({ adminOnly: false, selfApproval: true });
    expect(gateLocks({ enforced: true }, true)).toEqual({ adminOnly: false, selfApproval: false });
  });

  it("summarizes a judged job and tones verdicts", () => {
    expect(gateStatsLines(null)).toEqual([]);
    expect(gateStatsLines({ cases: 4, pass: 3, fail: 1, error: 0, skipped: 0, passRate: 0.75, regressions: 1, costIncreasePct: -10, p95LatencyIncreasePct: 25, newGuardBlocks: 2, oldestRecordingDays: 1 })).toEqual([
      "3 of 4 cases passed (75%)",
      "1 regression",
      "cost -10%",
      "p95 latency +25%",
      "2 new guard blocks"
    ]);
    expect(releaseVerdictTone("approved")).toBe("ok");
    expect(releaseVerdictTone("overridden")).toBe("warn");
    expect(releaseVerdictTone("ungated")).toBe("neutral");
  });
});

describe("gate admission helpers", () => {
  it("words the banner for one, many and no waiting cases", () => {
    expect(gateAdmissionBanner(0)).toBeNull();
    expect(gateAdmissionBanner(1)).toBe("1 new case waiting for admin admission. It runs but doesn't count yet.");
    expect(gateAdmissionBanner(3)).toBe("3 new cases waiting for admin admission. They run but don't count yet.");
  });

  it("lists pending and required cases in the publish dialog's facts", () => {
    const base = { cases: 20, pass: 18, fail: 2, error: 0, skipped: 0, passRate: 0.9, regressions: 0, costIncreasePct: null, p95LatencyIncreasePct: null, newGuardBlocks: 0, oldestRecordingDays: null };
    expect(gateStatsLines(base)).toEqual(["18 of 20 cases passed (90%)"]);
    const lines = gateStatsLines({ ...base, admission: { admitted: 20, pending: 40, pendingNotPassing: 0, required: 2, requiredFailures: [{ id: "a", name: "A", problem: "failed" }] } });
    expect(lines).toEqual(["18 of 20 cases passed (90%)", "40 cases pending admission (run, not counted)", "2 required cases, 1 not passing"]);
  });
});

describe("repeat selection in the gate summary", () => {
  const base = { cases: 2, pass: 2, fail: 0, error: 0, skipped: 0, passRate: 1, regressions: 0, costIncreasePct: 12, p95LatencyIncreasePct: 30, newGuardBlocks: 0, oldestRecordingDays: null };

  it("says which repeat cost and latency were taken at, in plain words", () => {
    expect(gateStatsLines({ ...base, repeatSelection: { cost: { by: "repeat", repeat: 2 }, latency: { by: "largest_increase" } } })).toEqual([
      "2 of 2 cases passed (100%)",
      "cost +12% at repeat 2",
      "p95 latency +30% at each case's repeat that added the most"
    ]);
    expect(repeatSelectionPhrase({ by: "repeat", repeat: 3, partial: true })).toBe(" at repeat 3 (some cases at their deciding repeat)");
    expect(repeatSelectionPhrase({ by: "largest_relative_increase" })).toBe(" at each case's repeat that rose the most");
  });

  it("says nothing when the judgement does not name a selection, or names the deciding repeat", () => {
    expect(gateStatsLines(base)).toEqual(["2 of 2 cases passed (100%)", "cost +12%", "p95 latency +30%"]);
    expect(gateStatsLines({ ...base, repeatSelection: { cost: { by: "deciding" } } })).toEqual(["2 of 2 cases passed (100%)", "cost +12%", "p95 latency +30%"]);
    expect(repeatSelectionPhrase(undefined)).toBe("");
  });
});

describe("rollback, unpublish and delete: one rule", () => {
  it("is the admin's only while the gate is on and enforced", () => {
    expect(releaseActionsAdminOnly({ enabled: true, enforced: true }, false)).toBe(true);
    expect(releaseActionsAdminOnly({ enabled: true, enforced: true }, true)).toBe(false);
    expect(releaseActionsAdminOnly({ enabled: true, enforced: false }, false)).toBe(false);
    // Switched off but still flagged enforced: restricts nothing.
    expect(releaseActionsAdminOnly({ enabled: false, enforced: true }, false)).toBe(false);
  });

  it("explains a refused delete before the confirm, and leaves an unknown state to the server", () => {
    expect(workflowDeleteDenial({ gateEnabled: true, gateEnforced: true }, false)).toBe("This workflow has an enforced release gate: only an admin can delete it.");
    expect(workflowDeleteDenial({ gateEnabled: false, gateEnforced: true }, false)).toBeNull();
    expect(workflowDeleteDenial({ gateEnabled: true, gateEnforced: false }, false)).toBeNull();
    expect(workflowDeleteDenial({ gateEnabled: true, gateEnforced: true }, true)).toBeNull();
    expect(workflowDeleteDenial(null, false)).toBeNull();
  });
});
