import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayCaptureSettingsView, ReplayCaptureView, WorkflowListItem } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { CaptureInbox } from "./CaptureInbox";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchEvalDatasets: vi.fn(),
    fetchReplayCaptureSettings: vi.fn(),
    saveReplayCaptureSettings: vi.fn(),
    fetchReplayCaptures: vi.fn(),
    promoteReplayCaptures: vi.fn(),
    discardReplayCaptures: vi.fn()
  };
});

const workflows = [{ id: "wf-1", name: "Support triage" }] as WorkflowListItem[];

function settings(overrides: Partial<ReplayCaptureSettingsView> = {}): ReplayCaptureSettingsView {
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

function capture(id: string, overrides: Partial<ReplayCaptureView> = {}): ReplayCaptureView {
  return {
    id,
    workflowId: "wf-1",
    projectId: "default",
    name: `Captured webhook ${id}`,
    notes: null,
    sourceExecutionId: `exec-${id}`,
    sourceTriggerType: "webhook",
    sourceStatus: "success",
    workflowHash: "h",
    workflowSavedVersion: 1,
    capabilities: { mcp: "cassette", models: "tape" } as ReplayCaptureView["capabilities"],
    bytes: 100,
    truncated: false,
    createdAt: "2026-10-24T10:00:00.000Z",
    createdBy: null,
    status: "candidate",
    capturedAt: "2026-10-24T10:00:00.000Z",
    dataClasses: ["email", "card_number"],
    masked: true,
    source: null,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fetchEvalDatasets).mockResolvedValue({ datasets: [] });
  vi.mocked(api.fetchReplayCaptureSettings).mockResolvedValue({ settings: settings() });
  vi.mocked(api.fetchReplayCaptures).mockResolvedValue({ items: [], total: 0 });
});

describe("CaptureInbox", () => {
  it("shows an empty inbox and turns capture on with the defaults in one click", async () => {
    vi.mocked(api.saveReplayCaptureSettings).mockResolvedValue({ settings: settings({ configured: true, enabled: true, effectiveRate: 0.1 }) });
    render(<CaptureInbox workflows={workflows} canEdit isAdmin={false} />);
    expect(await screen.findByText(/Turn on capture and a sample/)).toBeInTheDocument();
    expect(screen.getByText("Off. Production runs are not recorded.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Capture production runs" }));
    await waitFor(() => expect(api.saveReplayCaptureSettings).toHaveBeenCalledWith("wf-1", { enabled: true, rate: 0.1, maxPerDay: 20 }));
    expect(await screen.findByText(/Capturing 10% of production runs, up to 20 a day, personal data masked/)).toBeInTheDocument();
  });

  it("round 4 B2: shows the last dropped run under the settings so a workflow that never captures is visible", async () => {
    vi.mocked(api.fetchReplayCaptureSettings).mockResolvedValue({
      settings: settings({ configured: true, enabled: true, effectiveRate: 0.1, lastDrop: { outcome: "dropped_identifier_value", at: "2026-10-24T10:00:00.000Z" } })
    });
    render(<CaptureInbox workflows={workflows} canEdit isAdmin={false} />);
    expect(await screen.findByText(/Last run not captured: .*because a personal value was in an MCP server or tool name/)).toBeInTheDocument();
  });

  it("lists captured runs with a badge and data-class chips; promotes, discards and opens runs", async () => {
    vi.mocked(api.fetchReplayCaptureSettings).mockResolvedValue({ settings: settings({ configured: true, enabled: true, effectiveRate: 0.1, candidates: 2 }) });
    vi.mocked(api.fetchReplayCaptures).mockResolvedValueOnce({ items: [capture("a"), capture("b", { dataClasses: [], sourceStatus: "error" })], total: 2 });
    vi.mocked(api.promoteReplayCaptures).mockResolvedValue({ results: [{ id: "a", ok: true, datasetId: "set-captured", fixtureId: "fx" }], promoted: 1 });
    vi.mocked(api.discardReplayCaptures).mockResolvedValue({ results: [{ id: "b", ok: true }], discarded: 1 });
    const onOpenRun = vi.fn();
    const onPromoted = vi.fn();
    render(<CaptureInbox workflows={workflows} canEdit isAdmin={false} onOpenRun={onOpenRun} onPromoted={onPromoted} />);
    const list = await screen.findByRole("list", { name: "Captured runs" });
    expect(screen.getByLabelText("2 captured runs waiting")).toHaveTextContent("2");
    const rows = within(list).getAllByRole("listitem");
    expect(within(rows[0]!).getByText("email")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("card")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("no personal data found")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Failed")).toBeInTheDocument();

    await userEvent.click(within(rows[0]!).getByRole("button", { name: "Open run" }));
    expect(onOpenRun).toHaveBeenCalledWith("exec-a");

    vi.mocked(api.fetchReplayCaptures).mockResolvedValueOnce({ items: [capture("b", { dataClasses: [] })], total: 1 });
    await userEvent.click(within(rows[0]!).getByRole("button", { name: "Promote" }));
    await waitFor(() => expect(api.promoteReplayCaptures).toHaveBeenCalledWith(["a"], undefined));
    expect(await screen.findByText("1 promoted to “Captured”.")).toBeInTheDocument();
    expect(onPromoted).toHaveBeenCalled();

    vi.mocked(api.fetchReplayCaptures).mockResolvedValueOnce({ items: [], total: 0 });
    await userEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    await userEvent.click(screen.getByRole("button", { name: "Discard 1" }));
    await waitFor(() => expect(api.discardReplayCaptures).toHaveBeenCalledWith(["b"]));
    expect(await screen.findByText(/No captured runs yet/)).toBeInTheDocument();
  });

  it("keeps masking on for builders and asks an admin for a reason to turn it off", async () => {
    vi.mocked(api.fetchReplayCaptureSettings).mockResolvedValue({ settings: settings({ configured: true, enabled: true }) });
    const { unmount } = render(<CaptureInbox workflows={workflows} canEdit isAdmin={false} />);
    await userEvent.click(await screen.findByText("Advanced"));
    expect(screen.getByRole("checkbox", { name: "Mask personal data with surrogates" })).toBeDisabled();
    unmount();

    vi.mocked(api.saveReplayCaptureSettings).mockResolvedValue({ settings: settings({ configured: true, enabled: true, dlp: false, dlpOffReason: "synthetic" }) });
    render(<CaptureInbox workflows={workflows} canEdit isAdmin />);
    await userEvent.click(await screen.findByText("Advanced"));
    await userEvent.click(screen.getByRole("checkbox", { name: "Mask personal data with surrogates" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Say why masking is turned off; the reason is audited.")).toBeInTheDocument();
    expect(api.saveReplayCaptureSettings).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("Why store unmasked runs?"), "synthetic");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveReplayCaptureSettings).toHaveBeenCalledWith("wf-1", { dlp: false, reason: "synthetic" }));
  });

  it("filters the inbox by outcome, trigger and date", async () => {
    vi.mocked(api.fetchReplayCaptures).mockResolvedValue({ items: [capture("a")], total: 1 });
    render(<CaptureInbox workflows={workflows} canEdit isAdmin={false} />);
    await screen.findByRole("list", { name: "Captured runs" });
    await userEvent.selectOptions(screen.getByLabelText("Filter by trigger"), "webhook");
    await waitFor(() => expect(api.fetchReplayCaptures).toHaveBeenLastCalledWith("wf-1", { limit: 100, trigger: "webhook" }));
    await userEvent.selectOptions(screen.getByLabelText("Filter by outcome"), "error");
    await userEvent.selectOptions(screen.getByLabelText("Filter by date"), "7d");
    await waitFor(() =>
      expect(api.fetchReplayCaptures).toHaveBeenLastCalledWith("wf-1", { limit: 100, runStatus: "error", trigger: "webhook", from: expect.any(String) })
    );
    const from = vi.mocked(api.fetchReplayCaptures).mock.lastCall![1]!.from!;
    expect(Math.abs(Date.now() - 7 * 86_400_000 - Date.parse(from))).toBeLessThan(60_000);
  });

  it("marks runs an API key started with a chip and filters them by source", async () => {
    vi.mocked(api.fetchReplayCaptures).mockResolvedValue({ items: [capture("a", { name: "Captured API-key run", sourceTriggerType: "manual", source: "api_key" }), capture("b")], total: 2 });
    render(<CaptureInbox workflows={workflows} canEdit isAdmin={false} />);
    const rows = within(await screen.findByRole("list", { name: "Captured runs" })).getAllByRole("listitem");
    expect(within(rows[0]!).getByText("API key")).toBeInTheDocument();
    expect(within(rows[1]!).queryByText("API key")).toBeNull();
    expect(within(screen.getByLabelText("Filter by trigger")).getByRole("option", { name: "API key" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Filter by trigger"), "api_key");
    await waitFor(() => expect(api.fetchReplayCaptures).toHaveBeenLastCalledWith("wf-1", { limit: 100, trigger: "api_key" }));
  });

  it("is read-only for viewers", async () => {
    vi.mocked(api.fetchReplayCaptures).mockResolvedValue({ items: [capture("a")], total: 1 });
    render(<CaptureInbox workflows={workflows} canEdit={false} isAdmin={false} />);
    await screen.findByRole("list", { name: "Captured runs" });
    expect(screen.getByRole("checkbox", { name: "Capture production runs" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Promote" })).not.toBeInTheDocument();
  });
});
