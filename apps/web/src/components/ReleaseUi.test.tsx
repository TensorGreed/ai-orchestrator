import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GateCaseRequestView, ReleaseApprovalRequestView, ReleaseGateCasesView, ReleaseGateView, ReleasePublishPreview, WorkflowRelease } from "@ai-orchestrator/shared";
import { defaultReleaseGate } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { ApprovalsPage } from "./ApprovalsPage";
import { ReleaseGatePanel } from "./ReleaseGatePanel";
import { ReleasePill } from "./ReleaseControls";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    listApprovals: vi.fn(),
    approveApproval: vi.fn(),
    rejectApproval: vi.fn(),
    decideReleaseRequest: vi.fn(),
    fetchReleaseState: vi.fn(),
    fetchWorkflowVersions: vi.fn(),
    fetchPublishPreview: vi.fn(),
    publishWorkflowVersion: vi.fn(),
    fetchReleaseGate: vi.fn(),
    saveReleaseGate: vi.fn(),
    fetchReleases: vi.fn(),
    rollbackWorkflowRelease: vi.fn(),
    fetchEvalDatasets: vi.fn(),
    fetchReleaseGateCases: vi.fn(),
    admitGateCases: vi.fn(),
    rejectGateCases: vi.fn(),
    setGateCaseRequired: vi.fn(),
    requestGateCases: vi.fn(),
    decideGateCaseRequest: vi.fn()
  };
});

const HASH = "a".repeat(64);

function preview(overrides: Partial<ReleasePublishPreview> = {}): ReleasePublishPreview {
  return { version: 3, workflowHash: HASH, gateEnabled: true, verdict: "passed", reasons: [], replayRunId: "run_1", stats: null, canRequestApproval: false, ...overrides };
}

function release(overrides: Partial<WorkflowRelease> = {}): WorkflowRelease {
  return {
    id: "rel_1",
    workflowId: "wf-1",
    version: 3,
    workflowHash: HASH,
    previousVersion: 2,
    replayRunId: "run_1",
    verdict: "passed",
    reason: null,
    gateReasons: [],
    approval: null,
    publishedAt: new Date().toISOString(),
    publishedBy: "builder@example.com",
    ...overrides
  };
}

function versions() {
  const at = new Date().toISOString();
  return {
    versions: [1, 2, 3].map((version) => ({ id: `v${version}`, workflowId: "wf-1", version, createdBy: null, changeNote: null, createdAt: at }))
  };
}

const NOT_ENFORCED: ReleaseGateCasesView = { workflowId: "wf-1", enforced: false, cases: [], counts: { admitted: 0, pending: 0, required: 0 }, canAdmit: false, canRequest: false };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchReleaseGateCases).mockResolvedValue({ cases: NOT_ENFORCED });
  window.history.replaceState(null, "", "/");
});

describe("version pill and Publish dialog", () => {
  it("shows the live version and how far the draft is ahead", async () => {
    vi.mocked(api.fetchReleaseState).mockResolvedValue({ state: { draftVersion: 5, publishedVersion: 3, aheadBy: 2, gateEnabled: true, gateEnforced: true, productionRefused: false, canPublish: true, canEditGate: true } });
    render(<ReleasePill workflowId="wf-1" canPublish isAdmin={false} />);
    const pill = await screen.findByRole("button", { name: /Release: v3 live · draft \+2/ });
    expect(pill).toHaveTextContent("gate · enforced");
  });

  it("renders nothing on a store without releases", async () => {
    vi.mocked(api.fetchReleaseState).mockRejectedValue(new api.ApiError("Releases need the SQLite store", 501));
    const { container } = render(<ReleasePill workflowId="wf-1" canPublish isAdmin={false} />);
    await waitFor(() => expect(api.fetchReleaseState).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("publishes a passing version bound to the judged hash and job", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchReleaseState).mockResolvedValue({ state: { draftVersion: 3, publishedVersion: 2, aheadBy: 1, gateEnabled: true, gateEnforced: false, productionRefused: false, canPublish: true, canEditGate: true } });
    vi.mocked(api.fetchWorkflowVersions).mockResolvedValue(versions());
    vi.mocked(api.fetchPublishPreview).mockResolvedValue({ preview: preview({ stats: { cases: 3, pass: 3, fail: 0, error: 0, skipped: 0, passRate: 1, regressions: 0, costIncreasePct: 4, p95LatencyIncreasePct: null, newGuardBlocks: 0, oldestRecordingDays: 2 } }) });
    vi.mocked(api.publishWorkflowVersion).mockResolvedValue({ outcome: "published", release: release() });
    render(<ReleasePill workflowId="wf-1" canPublish isAdmin={false} />);
    await user.click(await screen.findByRole("button", { name: /Release:/ }));
    const dialog = await screen.findByRole("dialog", { name: "Publish to production" });
    expect(await within(dialog).findByText("Gate passed")).toBeInTheDocument();
    expect(within(dialog).getByText(/3 of 3 cases passed \(100%\) · cost \+4%/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Publish v3" }));
    expect(api.publishWorkflowVersion).toHaveBeenCalledWith("wf-1", { version: 3, workflowHash: HASH, replayRunId: "run_1" });
    expect(await within(dialog).findByText(/Published v3/)).toBeInTheDocument();
  });

  it("a blocked version: a builder asks an approver with a reason; an admin may override with a reason", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchReleaseState).mockResolvedValue({ state: { draftVersion: 3, publishedVersion: 2, aheadBy: 1, gateEnabled: true, gateEnforced: false, productionRefused: false, canPublish: true, canEditGate: true } });
    vi.mocked(api.fetchWorkflowVersions).mockResolvedValue(versions());
    vi.mocked(api.fetchPublishPreview).mockResolvedValue({ preview: preview({ verdict: "blocked", reasons: ["2 regressions; the gate allows at most 0"], canRequestApproval: true }) });
    vi.mocked(api.publishWorkflowVersion).mockResolvedValue({ outcome: "needs_approval", approvalRequestId: "rar_1", reasons: [] });
    const { unmount } = render(<ReleasePill workflowId="wf-1" canPublish isAdmin={false} />);
    await user.click(await screen.findByRole("button", { name: /Release:/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("2 regressions; the gate allows at most 0")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Publish v3/ })).toBeNull();
    expect(within(dialog).queryByText("Admin override")).toBeNull();
    const ask = within(dialog).getByRole("button", { name: "Request approval" });
    expect(ask).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Ask an approver to ship it anyway"), "Known flake");
    await user.click(ask);
    expect(api.publishWorkflowVersion).toHaveBeenCalledWith("wf-1", { version: 3, workflowHash: HASH, replayRunId: "run_1", requestApproval: { reason: "Known flake" } });
    expect(await within(dialog).findByText(/Sent to the gate's approvers/)).toBeInTheDocument();
    unmount();

    vi.mocked(api.publishWorkflowVersion).mockResolvedValue({ outcome: "published", release: release({ verdict: "overridden", reason: "Incident 42" }) });
    render(<ReleasePill workflowId="wf-1" canPublish isAdmin />);
    await user.click(await screen.findByRole("button", { name: /Release:/ }));
    const adminDialog = await screen.findByRole("dialog");
    await user.type(await within(adminDialog).findByLabelText("Admin override"), "Incident 42");
    await user.click(within(adminDialog).getByRole("button", { name: "Override and publish v3" }));
    expect(api.publishWorkflowVersion).toHaveBeenLastCalledWith("wf-1", { version: 3, workflowHash: HASH, replayRunId: "run_1", override: { reason: "Incident 42" } });
    expect(await within(adminDialog).findByText("Verdict: Admin override")).toBeInTheDocument();
  });

  it("the server's publish permission (project roles included) decides, not the global role", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchReleaseState).mockResolvedValue({ state: { draftVersion: 3, publishedVersion: 2, aheadBy: 1, gateEnabled: true, gateEnforced: false, productionRefused: false, canPublish: false, canEditGate: false } });
    vi.mocked(api.fetchWorkflowVersions).mockResolvedValue(versions());
    vi.mocked(api.fetchPublishPreview).mockResolvedValue({ preview: preview() });
    render(<ReleasePill workflowId="wf-1" canPublish isAdmin={false} />);
    await user.click(await screen.findByRole("button", { name: /Release:/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/needs the workflow:publish permission/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Publish v/ })).toBeNull();
  });

  it("says production is off when the gate is on and nothing is published", async () => {
    vi.mocked(api.fetchReleaseState).mockResolvedValue({ state: { draftVersion: 2, publishedVersion: null, aheadBy: 0, gateEnabled: true, gateEnforced: true, productionRefused: true, canPublish: true, canEditGate: false } });
    render(<ReleasePill workflowId="wf-1" canPublish isAdmin={false} />);
    const pill = await screen.findByRole("button", { name: /Release: v2 · not published/ });
    expect(pill).toHaveTextContent("production off");
  });

  it("a viewer sees the verdict but no publish actions", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchReleaseState).mockResolvedValue({ state: { draftVersion: 3, publishedVersion: null, aheadBy: 0, gateEnabled: false, gateEnforced: false, productionRefused: false, canPublish: false, canEditGate: false } });
    vi.mocked(api.fetchWorkflowVersions).mockResolvedValue(versions());
    vi.mocked(api.fetchPublishPreview).mockResolvedValue({ preview: preview({ gateEnabled: false, replayRunId: null }) });
    render(<ReleasePill workflowId="wf-1" canPublish={false} isAdmin={false} />);
    await user.click(await screen.findByRole("button", { name: "Release: v3 · not published" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("No release gate")).toBeInTheDocument();
    expect(within(dialog).getByText(/needs the workflow:publish permission/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Publish v/ })).toBeNull();
  });
});

describe("Release gates tab", () => {
  function gate(overrides: Partial<ReleaseGateView> = {}): ReleaseGateView {
    return { ...defaultReleaseGate("wf-1"), ...overrides };
  }

  it("saves the gate with the chosen golden set and approvers, and rolls back with a reason", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchReleaseGate).mockResolvedValue({ gate: gate() });
    vi.mocked(api.fetchEvalDatasets).mockResolvedValue({
      datasets: [{ id: "set-1", name: "Regression suite", description: null, projectId: "default", workflowId: "wf-1", createdBy: null, createdAt: "", updatedAt: "", fixtureCount: 3, goldenRunCount: 3 } as api.EvalDataset]
    });
    vi.mocked(api.fetchReleases).mockResolvedValue({ releases: [release({ id: "rel_2", version: 3 }), release({ id: "rel_1", version: 2, verdict: "ungated", previousVersion: null, replayRunId: null })], publishedVersion: 3 });
    vi.mocked(api.saveReleaseGate).mockImplementation(async (_id, settings) => ({ gate: gate({ ...(settings as Partial<ReleaseGateView>), updatedAt: "now" }) }));
    vi.mocked(api.rollbackWorkflowRelease).mockResolvedValue({ release: release({ id: "rel_3", version: 2, verdict: "rollback" }) });
    render(<ReleaseGatePanel workflows={[{ id: "wf-1", name: "Refunds" } as never]} canEdit isAdmin={false} />);

    // Turning the gate on without a golden set is refused before sending.
    await user.click(await screen.findByLabelText("Gate publishing on replay jobs"));
    await user.click(screen.getByRole("button", { name: "Save gate" }));
    expect(await screen.findByText("Pick at least one golden set")).toBeInTheDocument();
    expect(api.saveReleaseGate).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText(/Regression suite/));
    await user.click(screen.getByLabelText("builder"));
    await user.click(screen.getByRole("button", { name: "Save gate" }));
    await waitFor(() => expect(api.saveReleaseGate).toHaveBeenCalled());
    const [, settings] = vi.mocked(api.saveReleaseGate).mock.calls[0]!;
    expect(settings).toMatchObject({ enabled: true, datasetIds: ["set-1"], approvers: { approverRoles: ["builder"], approverUsers: [] }, policy: { minPassRate: 1, maxRegressions: 0 } });
    expect(await screen.findByText("Gate saved.")).toBeInTheDocument();
    // Only admins see the enforcement switch.
    expect(screen.queryByLabelText(/Enforce: only admins/)).toBeNull();

    expect(screen.queryByRole("button", { name: "Roll back to v3" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Roll back to v2" }));
    const confirm = screen.getAllByRole("button", { name: "Roll back to v2" }).at(-1)!;
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText("Why roll back to v2?"), "Errors in prod");
    await user.click(confirm);
    expect(api.rollbackWorkflowRelease).toHaveBeenCalledWith("wf-1", { version: 2, reason: "Errors in prod" });
  });

  it("an enforced gate is shown as such, and a builder cannot switch it off", async () => {
    vi.mocked(api.fetchReleaseGate).mockResolvedValue({ gate: gate({ enabled: true, enforced: true, datasetIds: ["set-1"] }) });
    vi.mocked(api.fetchEvalDatasets).mockResolvedValue({ datasets: [] });
    vi.mocked(api.fetchReleases).mockResolvedValue({ releases: [], publishedVersion: null });
    render(<ReleaseGatePanel workflows={[{ id: "wf-1", name: "Refunds" } as never]} canEdit isAdmin={false} />);
    expect(await screen.findByText("Enforced by an admin")).toBeInTheDocument();
    expect(screen.getByLabelText("Gate publishing on replay jobs")).toBeDisabled();
    expect(screen.getByText("No version was published yet.")).toBeInTheDocument();
  });

  it("on an enforced gate a builder can only tighten: approvers, self-approval, MCP mode and the gate's sets are locked; operators are never offered as approvers", async () => {
    vi.mocked(api.fetchReleaseGate).mockResolvedValue({ gate: gate({ enabled: true, enforced: true, datasetIds: ["set-1"], requireApproval: true, approvers: { approverRoles: ["admin"], approverUsers: [], allowSelfApproval: false } }) });
    vi.mocked(api.fetchEvalDatasets).mockResolvedValue({ datasets: [{ id: "set-1", name: "Refund cases", workflowId: "wf-1" }, { id: "set-2", name: "More cases", workflowId: "wf-1" }] as never });
    vi.mocked(api.fetchReleases).mockResolvedValue({ releases: [release({ version: 2 }), release({ id: "rel_0", version: 1 })], publishedVersion: 2 });
    render(<ReleaseGatePanel workflows={[{ id: "wf-1", name: "Refunds" } as never]} canEdit isAdmin={false} />);
    expect(await screen.findByText(/An admin enforces this gate/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Refund cases/)).toBeDisabled();
    expect(screen.getByLabelText(/More cases/)).toBeEnabled();
    expect(screen.getByLabelText("admin")).toBeDisabled();
    expect(screen.queryByLabelText("operator")).toBeNull();
    expect(screen.getByPlaceholderText("Approver emails, comma separated")).toBeDisabled();
    expect(screen.getByLabelText(/may approve their own release/)).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /MCP/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Roll back/ })).toBeNull();
  });
});

describe("release requests in Approvals", () => {
  function request(overrides: Partial<ReleaseApprovalRequestView> = {}): ReleaseApprovalRequestView {
    return {
      kind: "release",
      requestId: "rar_1",
      id: "rar_1",
      workflowId: "wf-1",
      workflowName: "Refunds",
      projectId: "default",
      status: "pending",
      message: "Publish v3 of Refunds",
      version: 3,
      workflowHash: HASH,
      replayRunId: "run_1",
      origin: "blocked",
      gateReasons: ["2 regressions; the gate allows at most 0"],
      requestReason: "Known flake",
      approverRoles: ["builder"],
      approverUsers: [],
      allowSelfApproval: false,
      requestedBy: "requester@example.com",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      decidedBy: null,
      decidedAt: null,
      reason: null,
      releaseId: null,
      canDecide: true,
      cannotDecideReason: null,
      ...overrides
    };
  }

  it("shows the version, hash and gate findings; approving publishes; rejecting needs a reason", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listApprovals).mockResolvedValue({ items: [request()] });
    vi.mocked(api.decideReleaseRequest).mockResolvedValue({ request: request({ status: "approved" }), release: release({ verdict: "approved" }) });
    const onCount = vi.fn();
    render(<ApprovalsPage onPendingCountChange={onCount} />);
    const card = (await screen.findByRole("heading", { name: "Publish v3 of Refunds" })).closest("article")!;
    await waitFor(() => expect(onCount).toHaveBeenCalledWith(1));
    expect(within(card).getByText("Release")).toBeInTheDocument();
    expect(within(card).getByText(HASH.slice(0, 12))).toBeInTheDocument();
    expect(within(card).getByText("2 regressions; the gate allows at most 0")).toBeInTheDocument();
    expect(within(card).getByText("“Known flake”")).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Reject" }));
    expect(await within(card).findByText("A reason is required to reject a release")).toBeInTheDocument();
    expect(api.decideReleaseRequest).not.toHaveBeenCalled();

    await user.click(within(card).getByRole("button", { name: "Approve and publish v3" }));
    expect(api.decideReleaseRequest).toHaveBeenCalledWith("rar_1", "approve", undefined);
    expect(await screen.findByText("Approved. Version 3 is now in production.")).toBeInTheDocument();
  });

  it("the requester cannot approve their own release", async () => {
    vi.mocked(api.listApprovals).mockResolvedValue({
      items: [request({ canDecide: false, cannotDecideReason: "You asked for this release, and this gate does not allow approving your own release." })]
    });
    render(<ApprovalsPage />);
    const card = (await screen.findByRole("heading", { name: "Publish v3 of Refunds" })).closest("article")!;
    expect(within(card).getByRole("button", { name: "Approve and publish v3" })).toBeDisabled();
    expect(within(card).getByText(/approving your own release/)).toBeInTheDocument();
  });
});

describe("gate admission on an enforced gate", () => {
  const caseView = (overrides: Partial<ReleaseGateCasesView["cases"][number]>) => ({
    fixtureId: "fx_1",
    datasetId: "set-1",
    datasetName: "Refund cases",
    name: "Refund over limit",
    recordingId: "rec_1",
    admission: "admitted" as const,
    required: false,
    requestId: null,
    requestKind: null,
    createdAt: "",
    ...overrides
  });
  const enforcedCases = (overrides: Partial<ReleaseGateCasesView> = {}): ReleaseGateCasesView => ({
    workflowId: "wf-1",
    enforced: true,
    cases: [
      caseView({}),
      caseView({ fixtureId: "fx_2", name: "Easy 1", admission: "pending" }),
      caseView({ fixtureId: "fx_3", name: "Easy 2", admission: "pending" }),
      caseView({ fixtureId: "fx_4", name: "Easy 3", admission: "pending" })
    ],
    counts: { admitted: 1, pending: 3, required: 0 },
    canAdmit: false,
    canRequest: true,
    ...overrides
  });
  const mountGate = (enforced: boolean, isAdmin: boolean) => {
    vi.mocked(api.fetchReleaseGate).mockResolvedValue({ gate: { ...defaultReleaseGate("wf-1"), enabled: true, enforced, datasetIds: ["set-1"] } });
    vi.mocked(api.fetchEvalDatasets).mockResolvedValue({ datasets: [] });
    vi.mocked(api.fetchReleases).mockResolvedValue({ releases: [], publishedVersion: null });
    render(<ReleaseGatePanel workflows={[{ id: "wf-1", name: "Refunds" } as never]} canEdit isAdmin={isAdmin} />);
  };

  it("shows a plain banner, and a builder requests admission with a reason", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchReleaseGateCases).mockResolvedValue({ cases: enforcedCases() });
    vi.mocked(api.requestGateCases).mockResolvedValue({ request: { id: "gcr_1" } as GateCaseRequestView });
    mountGate(true, false);
    expect(await screen.findByText("3 new cases waiting for admin admission. They run but don't count yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Admit/ })).toBeNull();
    expect(screen.queryByLabelText(/is required/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Request admission" }));
    const send = screen.getByRole("button", { name: "Send to approvers" });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText("Why should these 3 cases count?"), "New refund scenarios");
    await user.click(send);
    expect(api.requestGateCases).toHaveBeenCalledWith("wf-1", { action: "admit", fixtureIds: ["fx_2", "fx_3", "fx_4"], reason: "New refund scenarios" });
    expect(await screen.findByText("Sent to the gate's approvers in the approvals inbox.")).toBeInTheDocument();
    // An admitted case: the builder asks for its removal.
    expect(screen.getByRole("button", { name: "Request removal of Refund over limit" })).toBeInTheDocument();
  });

  it("an admin admits or rejects inline and marks a case required; the chip shows", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchReleaseGateCases).mockResolvedValue({ cases: enforcedCases({ canAdmit: true, canRequest: false }) });
    vi.mocked(api.admitGateCases).mockResolvedValue({ cases: enforcedCases({ canAdmit: true, canRequest: false, counts: { admitted: 2, pending: 2, required: 0 } }) });
    vi.mocked(api.setGateCaseRequired).mockResolvedValue({
      cases: enforcedCases({ canAdmit: true, canRequest: false, cases: [caseView({ required: true })], counts: { admitted: 1, pending: 0, required: 1 } })
    });
    mountGate(true, true);
    await user.click(await screen.findByRole("button", { name: "Admit Easy 1" }));
    expect(api.admitGateCases).toHaveBeenCalledWith("wf-1", ["fx_2"]);
    expect(await screen.findByText("2 new cases waiting for admin admission. They run but don't count yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject Easy 2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request admission" })).toBeNull();
    await user.click(screen.getByLabelText("Refund over limit is required"));
    expect(api.setGateCaseRequired).toHaveBeenCalledWith("wf-1", "fx_1", true);
    expect(await screen.findByText("required")).toBeInTheDocument();
    expect(screen.queryByText(/waiting for admin admission/)).toBeNull();
  });

  it("nothing new appears on an unenforced gate", async () => {
    mountGate(false, true);
    expect(await screen.findByText("Release gate")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("No version was published yet.")).toBeInTheDocument());
    expect(api.fetchReleaseGateCases).not.toHaveBeenCalled();
    expect(screen.queryByText("Cases this gate counts")).toBeNull();
  });

  it("an admit_cases request in Approvals lists its cases and admits on approval", async () => {
    const user = userEvent.setup();
    const view: GateCaseRequestView = {
      kind: "admit_cases",
      requestId: "gcr_1",
      id: "gcr_1",
      workflowId: "wf-1",
      workflowName: "Refunds",
      projectId: "default",
      status: "pending",
      message: "Admit 2 cases to the enforced release gate, so they count toward publishing",
      cases: [
        { fixtureId: "fx_2", name: "Easy 1", datasetId: "set-1" },
        { fixtureId: "fx_3", name: "Easy 2", datasetId: "set-1" }
      ],
      requestReason: "New refund scenarios",
      approverRoles: ["admin"],
      approverUsers: [],
      allowSelfApproval: false,
      requestedBy: "builder@example.com",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      decidedBy: null,
      decidedAt: null,
      reason: null,
      canDecide: true,
      cannotDecideReason: null
    };
    vi.mocked(api.listApprovals).mockResolvedValue({ items: [view] });
    vi.mocked(api.decideGateCaseRequest).mockResolvedValue({ request: { ...view, status: "approved" } });
    render(<ApprovalsPage />);
    const card = (await screen.findByRole("heading", { name: view.message })).closest("article")!;
    expect(within(card).getByText("Gate cases")).toBeInTheDocument();
    expect(within(card).getByText("Easy 2")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Reject" }));
    expect(await within(card).findByText("A reason is required to reject a request")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Approve and admit 2 cases" }));
    expect(api.decideGateCaseRequest).toHaveBeenCalledWith("gcr_1", "approve", undefined);
    expect(await screen.findByText("Approved. 2 cases now count toward publishing.")).toBeInTheDocument();
  });
});
