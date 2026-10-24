import { describe, expect, it } from "vitest";
import type { ReplayCaptureSettingsView, ReplayFindSubjectMatch } from "@ai-orchestrator/shared";
import {
  CAPTURE_TRIGGER_FILTERS,
  captureFormFrom,
  capturePeriodFrom,
  captureSettingsFromForm,
  captureLastDropLine,
  captureSummaryLine,
  captureTriggerLabel,
  dataClassLabel,
  ratePercentText,
  splitSubjectMatches,
  subjectConfirmText,
  subjectDeleteNotice,
  subjectDeleteTargets,
  subjectQuery,
  subjectReadAsOffered,
  subjectSearchedAs
} from "./replay-capture";

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
    lastDrop: null,
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
    const now = new Date("2026-10-24T12:00:00.000Z");
    expect(capturePeriodFrom("", now)).toBeUndefined();
    expect(capturePeriodFrom("24h", now)).toBe("2026-10-23T12:00:00.000Z");
    expect(capturePeriodFrom("7d", now)).toBe("2026-10-17T12:00:00.000Z");
    expect(captureSummaryLine(view())).toBe("Off. Production runs are not recorded.");
    expect(captureSummaryLine(view({ enabled: true, effectiveRate: 0.1, capturedToday: 3 }))).toBe("Capturing 10% of production runs, up to 20 a day, personal data masked. 3 today.");
    expect(captureSummaryLine(view({ deployment: { enabled: false, maxRate: 1, retentionDays: 14, maxCandidates: 200 } }))).toContain("REPLAY_CAPTURE_ENABLED");
  });
});

describe("round 4 B2: the last dropped run", () => {
  it("says when and why in plain words, and nothing when no run was dropped", () => {
    const when = () => "24 Oct, 10:00";
    expect(captureLastDropLine(null, when)).toBeNull();
    expect(captureLastDropLine({ outcome: "dropped_identifier_value", at: "2026-10-24T10:00:00.000Z" }, when)).toBe(
      "Last run not captured: 24 Oct, 10:00, because a personal value was in an MCP server or tool name, which is kept as written."
    );
    expect(captureLastDropLine({ outcome: "skipped_too_large", at: "2026-10-24T10:00:00.000Z" }, when)).toContain("larger than the capture size limit");
  });
});

describe("round 4 B4: delete copy", () => {
  it("the confirm step counts possible matches; the notice names unconfirmed ones", () => {
    expect(subjectConfirmText([{}, { confirmPossible: true }, { confirmPossible: true }])).toBe(
      "Permanently delete 3 rows, 2 of them possible matches? A golden run takes its golden-set cases and results with it."
    );
    expect(subjectConfirmText([{}])).toBe("Permanently delete 1 row? A golden run takes its golden-set cases and results with it.");
    expect(subjectDeleteNotice({ removed: [{ kind: "recording", id: "a" }], skipped: [] })).toBe("Deleted 1 row.");
    expect(
      subjectDeleteNotice({
        removed: [],
        skipped: [
          { kind: "recording", id: "a", reason: "possible_match_unconfirmed" },
          { kind: "recording", id: "b", reason: "possible_match_unconfirmed" }
        ]
      })
    ).toBe("Deleted 0 rows; 2 skipped (2 possible matches not confirmed).");
  });
});

describe("API-key captures", () => {
  it("the trigger filter offers API key, filtering on the source", () => {
    expect(CAPTURE_TRIGGER_FILTERS).toContain("api_key");
    expect(captureTriggerLabel("api_key")).toBe("API key");
  });
});

describe("data-subject lookup helpers", () => {
  const match = (id: string, certainty: ReplayFindSubjectMatch["certainty"]): ReplayFindSubjectMatch => ({
    kind: "recording",
    id,
    workflowId: "wf",
    projectId: null,
    name: id,
    status: "golden",
    matchedAs: ["raw"],
    fields: ["input"],
    hits: [],
    certainty
  });

  it("offers Read as for 7 to 15 bare digits only, and sends the hint and country only then", () => {
    expect(subjectReadAsOffered("4155551234")).toBe(true);
    expect(subjectReadAsOffered(" 1234567 ")).toBe(true);
    expect(subjectReadAsOffered("123456")).toBe(false);
    expect(subjectReadAsOffered("1234567890123456")).toBe(false);
    expect(subjectReadAsOffered("+14155551234")).toBe(false);
    expect(subjectReadAsOffered("jane@example.com")).toBe(false);
    expect(subjectQuery("4155551234", "text", "US")).toEqual({ value: "4155551234" });
    expect(subjectQuery("4155551234", "phone", "")).toEqual({ value: "4155551234", dataClass: "phone" });
    expect(subjectQuery("4155551234", "phone", "US")).toEqual({ value: "4155551234", dataClass: "phone", country: "US" });
    expect(subjectQuery(" jane@example.com ", "phone", "US")).toEqual({ value: "jane@example.com" });
  });

  it("says how the value was searched", () => {
    expect(subjectSearchedAs({ dataClass: "phone", callingCode: "1" })).toBe("Searched as phone (+1)");
    expect(subjectSearchedAs({ dataClass: "phone", callingCode: null })).toBe("Searched as phone (no country code)");
    expect(subjectSearchedAs({ dataClass: "email", callingCode: null })).toBe("Searched as email address");
    expect(subjectSearchedAs({ dataClass: null, callingCode: null })).toBe("Searched as text");
  });

  it("splits possible matches out and confirms each one it deletes", () => {
    const matches = [match("a", "exact"), match("b", "national_only"), match("c", "national_only")];
    const { exact, possible } = splitSubjectMatches(matches);
    expect(exact.map((entry) => entry.id)).toEqual(["a"]);
    expect(possible.map((entry) => entry.id)).toEqual(["b", "c"]);
    expect(subjectDeleteTargets(matches, new Set(["recording:a", "recording:c"]))).toEqual([
      { kind: "recording", id: "a" },
      { kind: "recording", id: "c", confirmPossible: true }
    ]);
  });
});
