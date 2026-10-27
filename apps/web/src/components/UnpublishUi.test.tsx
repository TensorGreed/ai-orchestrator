import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseGateCasesView, ReleaseStateView, ReleaseUnpublishResult, WorkflowRelease } from "@ai-orchestrator/shared";
import { defaultReleaseGate, releaseUnpublishNotice } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { releasePillLabel, releaseVerdictLabel, releaseVerdictTone } from "../lib/release";
import { ReleasePill } from "./ReleaseControls";
import { ReleaseGatePanel } from "./ReleaseGatePanel";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchReleaseState: vi.fn(),
    fetchWorkflowVersions: vi.fn(),
    fetchPublishPreview: vi.fn(),
    publishWorkflowVersion: vi.fn(),
    unpublishWorkflowRelease: vi.fn(),
    fetchReleaseGate: vi.fn(),
    fetchReleases: vi.fn(),
    fetchEvalDatasets: vi.fn(),
    fetchReleaseGateCases: vi.fn(),
    rollbackWorkflowRelease: vi.fn()
  };
});

const HASH = "a".repeat(64);

function state(overrides: Partial<ReleaseStateView> = {}): ReleaseStateView {
  return {
    draftVersion: 4,
    publishedVersion: 3,
    aheadBy: 1,
    gateEnabled: false,
    gateEnforced: false,
    productionRefused: false,
    unpublishedAt: null,
    canPublish: true,
    canEditGate: true,
    ...overrides
  };
}

function release(overrides: Partial<WorkflowRelease> = {}): WorkflowRelease {
  return {
    id: "rel_1",
    workflowId: "wf-1",
    version: 3,
    workflowHash: HASH,
    previousVersion: null,
    replayRunId: null,
    verdict: "ungated",
    reason: null,
    gateReasons: [],
    approval: null,
    publishedAt: new Date().toISOString(),
    publishedBy: "builder@example.com",
    ...overrides
  };
}

function unpublished(gateEnabled: boolean, gateEnforced: boolean): ReleaseUnpublishResult {
  return {
    release: release({ id: "rel_2", verdict: "unpublished", previousVersion: 3, reason: "Incident" }),
    productionRuns: "draft",
    gateEnabled,
    gateEnforced,
    notice: releaseUnpublishNotice({ version: 3, gateEnabled, gateEnforced })
  };
}

const NOT_ENFORCED: ReleaseGateCasesView = { workflowId: "wf-1", enforced: false, cases: [], counts: { admitted: 0, pending: 0, required: 0 }, canAdmit: false, canRequest: false };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchReleaseGateCases).mockResolvedValue({ cases: NOT_ENFORCED });
  vi.mocked(api.fetchWorkflowVersions).mockResolvedValue({ versions: [] });
});

describe("release helpers", () => {
  it("labels the unpublished state and history entry", () => {
    expect(releasePillLabel(state({ publishedVersion: null, aheadBy: 0, unpublishedAt: "2026-10-27T10:00:00.000Z" }))).toMatchObject({ text: "v4 · unpublished", tone: "draft" });
    expect(releasePillLabel(state({ publishedVersion: null, aheadBy: 0, unpublishedAt: "2026-10-27T10:00:00.000Z", gateEnabled: true })).title).toMatch(/release gate does not check/);
    expect(releasePillLabel(state({ publishedVersion: null, aheadBy: 0 })).text).toBe("v4 · not published");
    expect(releaseVerdictLabel("unpublished")).toBe("Unpublished");
    expect(releaseVerdictTone("unpublished")).toBe("warn");
  });
});

describe("Unpublish in the Publish dialog", () => {
  it("confirms naming the live version and that production runs the draft, sends the optional reason, and reloads the pill", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchReleaseState)
      .mockResolvedValueOnce({ state: state() })
      .mockResolvedValue({ state: state({ publishedVersion: null, aheadBy: 0, unpublishedAt: "2026-10-27T10:00:00.000Z" }) });
    vi.mocked(api.unpublishWorkflowRelease).mockResolvedValue(unpublished(false, false));
    render(<ReleasePill workflowId="wf-1" canPublish isAdmin={false} />);
    await user.click(await screen.findByRole("button", { name: /Release: v3 live/ }));
    const dialog = await screen.findByRole("dialog", { name: "Publish to production" });
    await user.click(within(dialog).getByRole("button", { name: "Unpublish v3" }));

    const confirm = await screen.findByRole("alertdialog", { name: "Unpublish v3?" });
    expect(within(confirm).getByText(/Production stops running v3 and runs the draft/)).toBeInTheDocument();
    expect(within(confirm).queryByText(/gate/)).toBeNull();
    // Focus moved into the dialog, on the safe choice.
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.type(within(confirm).getByLabelText("Reason (optional)"), "Incident");
    await user.click(within(confirm).getByRole("button", { name: "Unpublish v3" }));
    expect(api.unpublishWorkflowRelease).toHaveBeenCalledWith("wf-1", { expectedVersion: 3, reason: "Incident" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(within(dialog).getByRole("status")).toHaveTextContent(/Unpublished\. Production stops running v3/);
    expect(await screen.findByRole("button", { name: /Release: v4 · unpublished/ })).toBeInTheDocument();
  });

  it("publishing in the same dialog ends the unpublish notice", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchReleaseState)
      .mockResolvedValueOnce({ state: state() })
      .mockResolvedValueOnce({ state: state({ publishedVersion: null, aheadBy: 0, unpublishedAt: "2026-10-27T10:00:00.000Z" }) })
      .mockResolvedValue({ state: state({ publishedVersion: 4, aheadBy: 0 }) });
    vi.mocked(api.fetchWorkflowVersions).mockResolvedValue({
      versions: [4, 3].map((version) => ({ id: `v${version}`, workflowId: "wf-1", version, createdBy: null, changeNote: null, createdAt: "2026-10-01T00:00:00.000Z" }))
    } as never);
    vi.mocked(api.fetchPublishPreview).mockResolvedValue({
      preview: { version: 4, workflowHash: HASH, gateEnabled: false, verdict: "ungated", reasons: [], replayRunId: null, stats: null, canRequestApproval: false }
    });
    vi.mocked(api.unpublishWorkflowRelease).mockResolvedValue(unpublished(false, false));
    vi.mocked(api.publishWorkflowVersion).mockResolvedValue({ outcome: "published", release: release({ version: 4 }) });
    render(<ReleasePill workflowId="wf-1" canPublish isAdmin={false} />);
    await user.click(await screen.findByRole("button", { name: /Release: v3 live/ }));
    const dialog = await screen.findByRole("dialog", { name: "Publish to production" });
    await user.click(within(dialog).getByRole("button", { name: "Unpublish v3" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Unpublish v3" }));
    expect(await within(dialog).findByText(/Unpublished\. Production stops running v3/)).toBeInTheDocument();
    await user.click(await within(dialog).findByRole("button", { name: "Publish v4" }));
    expect(await within(dialog).findByText(/Published v4/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Unpublished\./)).toBeNull();
  });

  it("with an enforced gate the confirmation says production runs the ungated draft; cancel and Escape send nothing", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchReleaseState).mockResolvedValue({ state: state({ gateEnabled: true, gateEnforced: true }) });
    render(<ReleasePill workflowId="wf-1" canPublish isAdmin={false} />);
    await user.click(await screen.findByRole("button", { name: /Release:/ }));
    const dialog = await screen.findByRole("dialog", { name: "Publish to production" });
    await user.click(within(dialog).getByRole("button", { name: "Unpublish v3" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Unpublish v3?" });
    expect(within(confirm).getByText(/release gate is enforced, but the gate does not check the draft: production runs the ungated draft/)).toBeInTheDocument();
    // The gate sentence is a warning, not an error.
    expect(within(confirm).getByText(/release gate is enforced/)).toHaveClass("release-unpublish-warning");
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // Focus went back to the button that opened it.
    expect(within(dialog).getByRole("button", { name: "Unpublish v3" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Unpublish v3" }));
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // Escape closed the confirmation only.
    expect(screen.getByRole("dialog", { name: "Publish to production" })).toBeInTheDocument();
    expect(api.unpublishWorkflowRelease).not.toHaveBeenCalled();
  });

  it("shows the server's refusal, and is not offered without publish permission or with nothing live", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchReleaseState).mockResolvedValue({ state: state() });
    vi.mocked(api.unpublishWorkflowRelease).mockRejectedValue(new api.ApiError("Nothing is published: production already runs the draft", 409));
    const { unmount } = render(<ReleasePill workflowId="wf-1" canPublish isAdmin={false} />);
    await user.click(await screen.findByRole("button", { name: /Release:/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Unpublish v3" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Unpublish v3" }));
    expect(await within(confirm).findByRole("alert")).toHaveTextContent("Nothing is published");
    expect(api.unpublishWorkflowRelease).toHaveBeenCalledWith("wf-1", { expectedVersion: 3 });
    unmount();

    vi.mocked(api.fetchReleaseState).mockResolvedValue({ state: state({ canPublish: false }) });
    const second = render(<ReleasePill workflowId="wf-1" canPublish isAdmin={false} />);
    await user.click(await screen.findByRole("button", { name: /Release:/ }));
    expect(within(await screen.findByRole("dialog")).queryByRole("button", { name: /Unpublish/ })).toBeNull();
    second.unmount();

    vi.mocked(api.fetchReleaseState).mockResolvedValue({ state: state({ publishedVersion: null, aheadBy: 0 }) });
    render(<ReleasePill workflowId="wf-1" canPublish isAdmin={false} />);
    await user.click(await screen.findByRole("button", { name: /Release:/ }));
    expect(within(await screen.findByRole("dialog")).queryByRole("button", { name: /Unpublish/ })).toBeNull();
  });
});

describe("Unpublish in the Releases card", () => {
  const workflows = [{ id: "wf-1", name: "Support", projectId: "default" }] as never;

  it("unpublishes from the card and lists the entry; rollback is offered on releases, not on the unpublish entry", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchReleaseGate).mockResolvedValue({ gate: { ...defaultReleaseGate("wf-1"), enabled: true, enforced: true, datasetIds: ["set-1"] } });
    vi.mocked(api.fetchEvalDatasets).mockResolvedValue({ datasets: [] } as never);
    vi.mocked(api.fetchReleases)
      .mockResolvedValueOnce({ releases: [release()], publishedVersion: 3 })
      .mockResolvedValue({ releases: [release({ id: "rel_2", verdict: "unpublished", previousVersion: 3, reason: "Incident" }), release()], publishedVersion: null });
    vi.mocked(api.unpublishWorkflowRelease).mockResolvedValue(unpublished(true, true));
    render(<ReleaseGatePanel workflows={workflows} canEdit isAdmin />);
    const card = (await screen.findByRole("heading", { name: "Releases" })).closest("section")!;
    await user.click(within(card).getByRole("button", { name: "Unpublish v3" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Unpublish v3?" });
    expect(within(confirm).getByText(/production runs the ungated draft/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Unpublish v3" }));
    expect(api.unpublishWorkflowRelease).toHaveBeenCalledWith("wf-1", { expectedVersion: 3 });
    expect(await within(card).findByText("Unpublished: production runs the latest save")).toBeInTheDocument();
    expect(within(card).getByRole("status")).toHaveTextContent(/ungated draft/);
    expect(within(card).getByText("v3 taken down")).toBeInTheDocument();
    expect(within(card).getByText("Unpublished")).toBeInTheDocument();
    expect(within(card).getByText("“Incident”")).toBeInTheDocument();
    // One rollback button: on the v3 release, not on its unpublish entry.
    expect(within(card).getAllByRole("button", { name: "Roll back to v3" })).toHaveLength(1);
    expect(within(card).queryByRole("button", { name: /Unpublish/ })).toBeNull();
  });

  it("the unpublish notice ends with a later publish or rollback; only the newest entry says production runs the draft", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchReleaseGate).mockResolvedValue({ gate: defaultReleaseGate("wf-1") });
    vi.mocked(api.fetchEvalDatasets).mockResolvedValue({ datasets: [] } as never);
    const first = release({ id: "rel_1", version: 3 });
    const down = release({ id: "rel_2", verdict: "unpublished", previousVersion: 3 });
    const back = release({ id: "rel_3", version: 3, verdict: "rollback", reason: "Fixed" });
    const down2 = release({ id: "rel_4", verdict: "unpublished", previousVersion: 3 });
    vi.mocked(api.fetchReleases)
      .mockResolvedValueOnce({ releases: [first], publishedVersion: 3 })
      // After the first unpublish.
      .mockResolvedValueOnce({ releases: [down, first], publishedVersion: null })
      // After a rollback elsewhere (the card reloads): the notice no longer applies.
      .mockResolvedValueOnce({ releases: [back, down, first], publishedVersion: 3 })
      // After a second unpublish: only the newest entry says production runs the draft.
      .mockResolvedValue({ releases: [down2, back, down, first], publishedVersion: null });
    vi.mocked(api.unpublishWorkflowRelease).mockResolvedValue(unpublished(false, false));
    render(<ReleaseGatePanel workflows={workflows} canEdit isAdmin />);
    const card = (await screen.findByRole("heading", { name: "Releases" })).closest("section")!;
    await user.click(within(card).getByRole("button", { name: "Unpublish v3" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Unpublish v3" }));
    expect(await within(card).findByRole("status")).toHaveTextContent(/Unpublished\./);
    expect(within(card).getByText(/production runs the draft/)).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Roll back to v3" }));
    await user.type(within(card).getByLabelText("Why roll back to v3?"), "Fixed");
    vi.mocked(api.rollbackWorkflowRelease).mockResolvedValue({} as never);
    // The list button and the form's confirm button carry the same name; the form's comes last.
    await user.click(within(card).getAllByRole("button", { name: "Roll back to v3" }).at(-1)!);
    await waitFor(() => expect(within(card).getByText("v3 live")).toBeInTheDocument());
    expect(within(card).queryByRole("status")).toBeNull();

    await user.click(within(card).getByRole("button", { name: "Unpublish v3" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Unpublish v3" }));
    await waitFor(() => expect(within(card).getAllByText(/production ran the draft until v3/)).toHaveLength(1));
    expect(within(card).getAllByText(/production runs the draft/)).toHaveLength(1);
  });

  it("a viewer is not offered Unpublish", async () => {
    vi.mocked(api.fetchReleaseGate).mockResolvedValue({ gate: defaultReleaseGate("wf-1") });
    vi.mocked(api.fetchEvalDatasets).mockResolvedValue({ datasets: [] } as never);
    vi.mocked(api.fetchReleases).mockResolvedValue({ releases: [release()], publishedVersion: 3 });
    render(<ReleaseGatePanel workflows={workflows} canEdit={false} isAdmin={false} />);
    const card = (await screen.findByRole("heading", { name: "Releases" })).closest("section")!;
    expect(within(card).getByText("v3 live")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Unpublish/ })).toBeNull();
  });
});
