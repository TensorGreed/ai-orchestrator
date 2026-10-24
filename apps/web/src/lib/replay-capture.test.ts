import { describe, expect, it } from "vitest";
import type { ReplayCaptureSettingsView } from "@ai-orchestrator/shared";
import { captureFormFrom, captureSettingsFromForm, captureSummaryLine, captureTriggerLabel, dataClassLabel, ratePercentText } from "./replay-capture";

function view(overrides: Partial<ReplayCaptureSettingsView> = {}): ReplayCaptureSettingsView {
  return {
    workflowId: "wf-1",
    configured: false,
    enabled: false,
    rate: 0.1,
    maxPerDay: 20,
    onlyStatuses: ["success", "error", "canceled"],
    dlp: true,
    targetDatasetId: null,
    updatedAt: null,
    updatedBy: null,
    dlpOffReason: null,
    deployment: { enabled: true, maxRate: 1, retentionDays: 14, maxCandidates: 200 },
    effectiveRate: 0,
    candidates: 0,
    capturedToday: 0,
    ...overrides
  };
}

describe("capture settings form", () => {
  it("turns capture on with the defaults in one save (10%, 20 a day, all outcomes, masking on)", () => {
    const current = view();
    const form = { ...captureFormFrom(current), enabled: true };
    expect(form).toMatchObject({ ratePercent: "10", maxPerDay: "20", dlp: true, targetDatasetId: "" });
    const { settings, errors } = captureSettingsFromForm(form, current, false);
    expect(errors).toEqual([]);
    expect(settings).toEqual({ enabled: true, rate: 0.1, maxPerDay: 20 });
  });

  it("sends only what changed once configured", () => {
    const current = view({ configured: true, enabled: true });
    const { settings } = captureSettingsFromForm({ ...captureFormFrom(current), ratePercent: "2.5", onlyStatuses: ["error"], targetDatasetId: "set-1" }, current, false);
    expect(settings).toEqual({ rate: 0.025, onlyStatuses: ["error"], targetDatasetId: "set-1" });
  });

  it("checks the rate, the deployment ceiling, the daily limit and the outcomes", () => {
    const current = view({ deployment: { enabled: true, maxRate: 0.05, retentionDays: 14, maxCandidates: 200 } });
    expect(captureSettingsFromForm({ ...captureFormFrom(current), ratePercent: "0" }, current, false).errors).toEqual(["Sample rate is a percentage above 0 and at most 100."]);
    expect(captureSettingsFromForm({ ...captureFormFrom(current), ratePercent: "10" }, current, false).errors).toEqual(["This deployment captures at most 5% of runs."]);
    expect(captureSettingsFromForm({ ...captureFormFrom(current), ratePercent: "5", maxPerDay: "1.5", onlyStatuses: [] }, current, false).errors).toEqual([
      "Daily limit is a whole number from 1 to 1000.",
      "Keep at least one run outcome."
    ]);
  });

  it("lets only an admin turn masking off, with a reason", () => {
    const current = view({ configured: true });
    expect(captureSettingsFromForm({ ...captureFormFrom(current), dlp: false }, current, false).errors).toEqual(["Only an admin can turn masking off."]);
    expect(captureSettingsFromForm({ ...captureFormFrom(current), dlp: false }, current, true).errors).toEqual(["Say why masking is turned off; the reason is audited."]);
    expect(captureSettingsFromForm({ ...captureFormFrom(current), dlp: false, reason: " synthetic traffic " }, current, true).settings).toEqual({ dlp: false, reason: "synthetic traffic" });
  });
});

describe("capture labels", () => {
  it("formats rates, classes, triggers and the summary line", () => {
    expect(ratePercentText(0.1)).toBe("10");
    expect(ratePercentText(0.0125)).toBe("1.25");
    expect(dataClassLabel("card_number")).toBe("card");
    expect(dataClassLabel("customer_id")).toBe("customer id");
    expect(captureTriggerLabel("webhook_api")).toBe("API");
    expect(captureTriggerLabel(null)).toBe("Production");
    expect(captureSummaryLine(view())).toBe("Off. Production runs are not recorded.");
    expect(captureSummaryLine(view({ enabled: true, effectiveRate: 0.1, capturedToday: 3 }))).toBe("Capturing 10% of production runs, up to 20 a day, personal data masked. 3 today.");
    expect(captureSummaryLine(view({ deployment: { enabled: false, maxRate: 1, retentionDays: 14, maxCandidates: 200 } }))).toContain("REPLAY_CAPTURE_ENABLED");
  });
});
