import { describe, expect, it } from "vitest";
import { defaultReleaseGate } from "@ai-orchestrator/shared";
import { gateFormFrom, gateSettingsFromForm, gateStatsLines, releasePillLabel, releaseVerdictTone } from "./release";

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
