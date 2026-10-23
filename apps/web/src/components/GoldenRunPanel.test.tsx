import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowListItem } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import type { ExecutionHistorySummary, ReplayRecordingDetail, ReplayRunResponse } from "../lib/api";
import { ExecutionHistoryPanel } from "./ExecutionHistoryPanel";
import { formatReplayDelta, GoldenRunViewer, replayRequestFor, ReplayResultView } from "./GoldenRunPanel";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchMcpElicitations: vi.fn(),
    createReplayRecording: vi.fn(),
    fetchReplayRecording: vi.fn(),
    deleteReplayRecording: vi.fn(),
    fetchWorkflowVersions: vi.fn(),
    runReplay: vi.fn()
  };
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchMcpElicitations).mockResolvedValue({ items: [] });
  vi.mocked(api.fetchWorkflowVersions).mockResolvedValue({ versions: [{ id: "v2", workflowId: "wf-1", version: 2, createdBy: null, changeNote: "tone", createdAt: "2026-10-01T00:00:00.000Z" }] } as never);
});

const zero = { baseline: 0, candidate: 0, delta: 0, pct: null };

function summary(overrides: Partial<ExecutionHistorySummary> = {}): ExecutionHistorySummary {
  return {
    id: "ex-1",
    workflowId: "wf-1",
    workflowName: "Support triage",
    status: "success",
    startedAt: "2026-10-01T00:00:00.000Z",
    completedAt: "2026-10-01T00:00:02.000Z",
    durationMs: 2000,
    triggerType: "manual",
    triggeredBy: "builder@example.com",
    customData: {},
    error: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}

function recording(overrides: Partial<ReplayRecordingDetail> = {}): ReplayRecordingDetail {
  return {
    id: "rec_123456789abc",
    workflowId: "wf-1",
    projectId: "default",
    name: "Refund baseline",
    notes: null,
    sourceExecutionId: "ex-1",
    sourceTriggerType: "manual",
    sourceStatus: "success",
    workflowHash: "a".repeat(64),
    workflowSavedVersion: null,
    capabilities: { mcp: "cassette", models: "live", memory: "empty", workflowSource: "captured" },
    bytes: 2048,
    truncated: false,
    createdAt: "2026-10-01T00:00:03.000Z",
    createdBy: "builder@example.com",
    input: {},
    facts: {} as ReplayRecordingDetail["facts"],
    nodes: { start: { nodeId: "start", nodeType: "manual_trigger", status: "success" } },
    mcpCallCount: 2,
    ...overrides
  };
}

function result(overrides: Partial<ReplayRunResponse> = {}): ReplayRunResponse {
  return {
    recordingId: "rec_123456789abc",
    executionId: "exe-replay-1",
    candidate: { kind: "version", version: 2, workflowHash: "b".repeat(64) },
    status: "success",
    verdict: "fail",
    reasons: ["The output differs from the golden run (1 change)"],
    facts: {} as ReplayRunResponse["facts"],
    diff: {
      status: { baseline: "success", candidate: "success", changed: false, regression: false },
      output: { equal: false, changes: [{ path: "answer", kind: "changed", baseline: "Refund approved", candidate: "Refund denied" }], ignored: 0, ignorePaths: [] },
      toolCalls: {
        baselineCount: 1,
        candidateCount: 2,
        changed: true,
        countDelta: [],
        steps: [
          {
            kind: "matched",
            baseline: { nodeId: "agent", iteration: 1, server: "crm", tool: "lookup_order", args: {}, argsHash: "x", outcome: "ok", durationMs: 4 },
            candidate: { nodeId: "agent", iteration: 1, server: "crm", tool: "lookup_order", args: {}, argsHash: "x", outcome: "ok", durationMs: 4 },
            argsChanged: false,
            argChanges: [],
            outcomeChanged: false
          },
          {
            kind: "inserted",
            baseline: null,
            candidate: { nodeId: "agent", iteration: 2, server: "crm", tool: "issue_refund", args: {}, argsHash: "y", outcome: "ok", durationMs: 4 },
            argsChanged: false,
            argChanges: [],
            outcomeChanged: false
          }
        ]
      },
      path: { added: [], removed: [], statusChanges: [] },
      models: { changes: [], callDelta: zero },
      totals: { tokens: { baseline: 100, candidate: 120, delta: 20, pct: 20 }, costUsd: zero, durationMs: zero },
      guard: { added: [], removed: [], changed: [] },
      health: [{ kind: "unrecorded_stub", nodeId: "notify", message: "Node notify (slack_send_message) has no recorded output", blocking: false }]
    } as ReplayRunResponse["diff"],
    ...overrides
  };
}

const panelProps = (overrides: Partial<Parameters<typeof ExecutionHistoryPanel>[0]> = {}): Parameters<typeof ExecutionHistoryPanel>[0] => ({
  executionHistoryTotal: 1,
  executionsLoading: false,
  executionsError: null,
  executionHistoryItems: [summary()],
  workflowList: [{ id: "wf-1", name: "Support triage", schemaVersion: "1.0.0", workflowVersion: 1, createdAt: "", updatedAt: "" } as WorkflowListItem],
  filters: { status: "", workflowId: "", startedFrom: "", startedTo: "" },
  expandedExecutionIds: [],
  executionDetailById: {},
  statusColors: {},
  onFiltersChange: vi.fn(),
  onRefresh: vi.fn(),
  onToggleRow: vi.fn(),
  onDebugExecution: vi.fn(),
  onRerunExecution: vi.fn(),
  onCancelExecution: vi.fn(),
  ...overrides
});

describe("golden run helpers", () => {
  it("builds the replay request for the draft or a version", () => {
    expect(replayRequestFor("draft", "strict")).toEqual({ draft: true, mcpMode: "strict" });
    expect(replayRequestFor(4, "lenient")).toEqual({ version: 4, mcpMode: "lenient" });
  });

  it("formats deltas", () => {
    expect(formatReplayDelta(zero)).toBe("no change");
    expect(formatReplayDelta({ baseline: null, candidate: 3, delta: null, pct: null })).toBe("—");
    expect(formatReplayDelta({ baseline: 100, candidate: 120, delta: 20, pct: 20 })).toBe("+20 (+20%)");
    expect(formatReplayDelta({ baseline: 0.01, candidate: 0.004, delta: -0.006, pct: -60 }, 4)).toBe("−0.0060 (−60%)");
  });
});

describe("Save as golden run on the Runs page", () => {
  it("is offered to builders on finished runs only, and saves with a name", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    vi.mocked(api.createReplayRecording).mockResolvedValue({ recording: recording() });
    vi.mocked(api.fetchReplayRecording).mockResolvedValue({ recording: recording() });
    const { rerender } = render(
      <ExecutionHistoryPanel
        {...panelProps({
          executionHistoryItems: [
            summary(),
            summary({ id: "ex-2", status: "running", completedAt: null }),
            summary({ id: "ex-3", triggerType: "replay" }),
            // Already saved: a run is saved once, so its golden badge opens the saved one instead.
            summary({ id: "ex-4", goldenRuns: { count: 1, latestId: "rec_saved" } })
          ],
          canManageGoldenRuns: true,
          onRefresh
        })}
      />
    );
    expect(screen.getAllByRole("button", { name: "Save as golden" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Save as golden" }));
    const dialog = screen.getByRole("dialog", { name: "Save as golden run" });
    expect(within(dialog).getByRole("status")).toHaveTextContent(/did not record its MCP calls/);
    // The promise is honest: code nodes are answered from the recording; expressions run in an isolated sandbox.
    expect(dialog).toHaveTextContent(/code nodes are answered from it/i);
    expect(dialog).toHaveTextContent(/expressions inside the nodes that do run are evaluated in an isolated sandbox/i);
    expect(dialog).not.toHaveTextContent(/never touched/i);
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Refund baseline");
    await user.click(within(dialog).getByRole("button", { name: "Save golden run" }));
    expect(api.createReplayRecording).toHaveBeenCalledWith({ executionId: "ex-1", name: "Refund baseline" });
    expect(onRefresh).toHaveBeenCalled();
    // The saved golden run opens straight away.
    expect(await screen.findByRole("dialog", { name: /Refund baseline/ })).toBeInTheDocument();

    rerender(<ExecutionHistoryPanel {...panelProps({ canManageGoldenRuns: false })} />);
    expect(screen.queryByRole("button", { name: "Save as golden" })).not.toBeInTheDocument();
  });

  it("shows a golden badge that opens the golden run read-only for viewers", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchReplayRecording).mockResolvedValue({ recording: recording() });
    render(<ExecutionHistoryPanel {...panelProps({ executionHistoryItems: [summary({ goldenRuns: { count: 2, latestId: "rec_123456789abc" } })] })} />);
    await user.click(screen.getByRole("button", { name: /golden 2/ }));
    expect(api.fetchReplayRecording).toHaveBeenCalledWith("rec_123456789abc");
    const dialog = await screen.findByRole("dialog", { name: /Refund baseline/ });
    expect(within(dialog).queryByRole("button", { name: "Replay" })).not.toBeInTheDocument();
    expect(api.fetchWorkflowVersions).not.toHaveBeenCalled();
  });
});

describe("GoldenRunViewer", () => {
  it("replays against a chosen version and shows the verdict, output diff, tool lanes and health", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchReplayRecording).mockResolvedValue({ recording: recording() });
    vi.mocked(api.runReplay).mockResolvedValue(result());
    const onChanged = vi.fn();
    render(<GoldenRunViewer recordingId="rec_123456789abc" canReplay onClose={vi.fn()} onChanged={onChanged} />);
    const viewer = await screen.findByRole("dialog", { name: /Refund baseline/ });
    expect(viewer).toHaveTextContent(/code nodes are answered from the recording/i);
    expect(viewer).toHaveTextContent(/expressions inside the nodes that do run are evaluated in an isolated sandbox/i);
    // A pass never hides an untested node: new nodes and changed code make the replay inconclusive.
    expect(viewer).toHaveTextContent(/is inconclusive if it reaches a node the golden run never saw, a code node whose code changed/i);
    await waitFor(() => expect(screen.getByRole("option", { name: /Version 2/ })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Candidate"), "2");
    await user.selectOptions(screen.getByLabelText("MCP calls"), "lenient");
    await user.click(screen.getByRole("button", { name: "Replay" }));
    expect(api.runReplay).toHaveBeenCalledWith("rec_123456789abc", { version: 2, mcpMode: "lenient" });
    const region = await screen.findByRole("region", { name: "Replay result" });
    expect(within(region).getByText("Fail")).toBeInTheDocument();
    expect(within(region).getByText("Refund denied")).toBeInTheDocument();
    expect(within(region).getByText("issue_refund")).toBeInTheDocument();
    expect(within(region).getByText("new")).toBeInTheDocument();
    expect(within(region).getByText(/has no recorded output/)).toBeInTheDocument();
    expect(within(region).getByText("+20 (+20%)")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it("keeps Delete out of the candidate panel and does not delete when confirm is declined", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchReplayRecording).mockResolvedValue({ recording: recording() });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onClose = vi.fn();
    const { container } = render(<GoldenRunViewer recordingId="rec_123456789abc" canReplay onClose={onClose} onChanged={vi.fn()} />);
    await screen.findByRole("dialog", { name: /Refund baseline/ });
    const toolbar = container.querySelector(".golden-toolbar") as HTMLElement;
    expect(within(toolbar).getByRole("button", { name: "Replay" })).toBeInTheDocument();
    const del = screen.getByRole("button", { name: "Delete" });
    expect(toolbar.contains(del)).toBe(false);
    expect(container.querySelector("header")?.contains(del)).toBe(true);
    await user.click(del);
    expect(confirmSpy).toHaveBeenCalled();
    expect(api.deleteReplayRecording).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("hides Delete for read-only viewers", async () => {
    vi.mocked(api.fetchReplayRecording).mockResolvedValue({ recording: recording() });
    render(<GoldenRunViewer recordingId="rec_123456789abc" canReplay={false} onClose={vi.fn()} />);
    await screen.findByRole("dialog", { name: /Refund baseline/ });
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("warns when the golden run has no recorded MCP calls and shows load errors", async () => {
    vi.mocked(api.fetchReplayRecording).mockResolvedValueOnce({ recording: recording({ capabilities: { mcp: "none", models: "live", memory: "empty", workflowSource: "current" } }) });
    const { unmount } = render(<GoldenRunViewer recordingId="rec_1" canReplay={false} onClose={vi.fn()} />);
    expect(await screen.findByText(/No MCP calls were recorded/)).toBeInTheDocument();
    unmount();
    vi.mocked(api.fetchReplayRecording).mockRejectedValueOnce(new Error("Golden run not found"));
    render(<GoldenRunViewer recordingId="rec_2" canReplay onClose={vi.fn()} />);
    expect(await screen.findByText("Golden run not found")).toBeInTheDocument();
  });

  it("marks a golden run imported from a golden-set file, with its source workflow", async () => {
    vi.mocked(api.fetchReplayRecording).mockResolvedValueOnce({
      recording: recording({
        sourceExecutionId: null,
        capabilities: { mcp: "cassette", models: "live", memory: "empty", workflowSource: "captured", origin: "imported", recordedAt: "2024-01-02T03:04:05.000Z", importedAt: "2026-10-24T08:00:00.000Z", sourceWorkflowId: "wf-source" }
      })
    });
    render(<GoldenRunViewer recordingId="rec_imported" canReplay={false} onClose={vi.fn()} />);
    expect(await screen.findByText("imported")).toBeInTheDocument();
    expect(screen.getByText("wf-source")).toBeInTheDocument();
    expect(screen.queryByText(/from run/)).not.toBeInTheDocument();
  });

  it("labels an inconclusive replay as inconclusive", () => {
    render(<ReplayResultView result={result({ verdict: "error", reasons: ["1 MCP call had no recorded answer"] })} />);
    expect(screen.getByText("Inconclusive")).toBeInTheDocument();
  });
});
