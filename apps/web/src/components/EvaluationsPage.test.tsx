import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowListItem } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import type { EvalCaseDetail, EvalCaseResult, EvalDataset, EvalFixture, EvalRunEvent, EvalRunView, ReplayCaseDiff, ReplayRecordingSummary } from "../lib/api";
import { EvaluationsPage } from "./EvaluationsPage";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchEvalDatasets: vi.fn(),
    fetchEvalFixtures: vi.fn(),
    createEvalDataset: vi.fn(),
    deleteEvalDataset: vi.fn(),
    deleteEvalFixture: vi.fn(),
    addGoldenRunToSet: vi.fn(),
    fetchReplayRecordings: vi.fn(),
    fetchWorkflowVersions: vi.fn(),
    fetchSecrets: vi.fn(),
    fetchDefinitions: vi.fn(),
    startReplayJob: vi.fn(),
    fetchReplayJobs: vi.fn(),
    fetchReplayJob: vi.fn(),
    fetchReplayJobCase: vi.fn(),
    cancelReplayJob: vi.fn(),
    subscribeEvalRun: vi.fn()
  };
});

const workflows = [{ id: "wf-1", name: "Support triage", schemaVersion: "1.0.0", workflowVersion: 1, createdAt: "", updatedAt: "" }] as WorkflowListItem[];

const goldenSet: EvalDataset = {
  id: "set_1",
  name: "Refund regressions",
  description: null,
  projectId: "default",
  workflowId: "wf-1",
  createdBy: "builder@example.com",
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  fixtureCount: 1,
  goldenRunCount: 1
};

const plainDataset: EvalDataset = { ...goldenSet, id: "ds_plain", name: "Hand-written", workflowId: null, goldenRunCount: 0 };

const fixture: EvalFixture = {
  id: "fix_1",
  datasetId: "set_1",
  name: "Refund baseline",
  input: {},
  expected: null,
  scorers: [{ type: "text_similarity", threshold: 0.9 }],
  recordingId: "rec_aaa",
  createdAt: "",
  updatedAt: ""
};

function recording(id: string, name: string): ReplayRecordingSummary {
  return {
    id,
    workflowId: "wf-1",
    projectId: "default",
    name,
    notes: null,
    sourceExecutionId: "ex-1",
    sourceTriggerType: "manual",
    sourceStatus: "success",
    workflowHash: "a".repeat(64),
    workflowSavedVersion: null,
    capabilities: { mcp: "cassette", models: "live", memory: "empty", workflowSource: "captured" },
    bytes: 100,
    truncated: false,
    createdAt: "2026-10-20T09:00:00.000Z",
    createdBy: null
  } as ReplayRecordingSummary;
}

function job(overrides: Partial<EvalRunView> = {}): EvalRunView {
  return {
    id: "job_1",
    kind: "replay",
    datasetId: "set_1",
    datasetIds: ["set_1"],
    workflowId: "wf-1",
    workflowName: "Support triage",
    status: "completed",
    startedAt: "2026-10-21T10:00:00.000Z",
    completedAt: "2026-10-21T10:01:00.000Z",
    triggeredBy: "builder@example.com",
    summary: { total: 2, pass: 1, fail: 1, error: 0, skipped: 0, passRate: 0.5, totalTokenInput: 0, totalTokenOutput: 0, totalTokenTotal: 0, totalDurationMs: 40, avgDurationMs: 20, costUsd: 0.012 },
    progress: null,
    candidate: { kind: "version", version: 3, workflowHash: "deadbeefcafe0000" },
    options: { mcpMode: "strict", maxCostUsd: 5 },
    error: null,
    ...overrides
  };
}

function caseResult(overrides: Partial<EvalCaseResult> = {}): EvalCaseResult {
  return {
    id: "res_1",
    runId: "job_1",
    fixtureId: "fix_1",
    fixtureName: "Refund baseline",
    recordingId: "rec_aaa",
    status: "fail",
    executionId: "ex-r1",
    score: {
      pass: false,
      details: [
        { type: "status", pass: true, score: 1, reason: "status success matches" },
        { type: "json_equal", pass: false, score: 0, reason: "answer changed" }
      ]
    },
    error: null,
    durationMs: 20,
    tokenInput: null,
    tokenOutput: null,
    tokenTotal: null,
    costUsd: 0.006,
    verdict: "fail",
    ...overrides
  };
}

const zero = { baseline: 0, candidate: 0, delta: 0, pct: null };
const replayDiff = {
  recordingId: "rec_aaa",
  executionId: "exe-replay-1",
  candidate: { kind: "version", version: 3, workflowHash: "deadbeef" },
  status: "success",
  verdict: "fail",
  reasons: ["The output differs from the golden run (1 change)"],
  diff: {
    status: { baseline: "success", candidate: "success", changed: false, regression: false },
    output: { equal: false, changes: [{ path: "answer", kind: "changed", baseline: "Refund approved", candidate: "Refund denied" }], ignored: 0, ignorePaths: [] },
    toolCalls: { baselineCount: 0, candidateCount: 0, changed: false, countDelta: [], steps: [] },
    path: { added: [], removed: [], statusChanges: [] },
    models: { changes: [], callDelta: zero },
    totals: { tokens: zero, costUsd: zero, durationMs: zero },
    guard: { added: [], removed: [], changed: [] },
    health: []
  }
} as unknown as ReplayCaseDiff;

function renderPage(role: "builder" | "viewer" = "builder") {
  const user = userEvent.setup();
  render(<EvaluationsPage workflows={workflows} activeProjectId="default" role={role} />);
  return user;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchEvalDatasets).mockResolvedValue({ datasets: [goldenSet, plainDataset] });
  vi.mocked(api.fetchEvalFixtures).mockResolvedValue({ fixtures: [fixture] });
  vi.mocked(api.fetchReplayRecordings).mockResolvedValue({ items: [recording("rec_aaa", "Refund baseline"), recording("rec_bbb", "Exchange baseline")], total: 2 });
  vi.mocked(api.fetchWorkflowVersions).mockResolvedValue({ versions: [{ id: "v3", workflowId: "wf-1", version: 3, createdBy: null, changeNote: "tone", createdAt: "" }] });
  vi.mocked(api.fetchSecrets).mockResolvedValue([{ id: "sec_judge", name: "Judge key", provider: "openai", createdAt: "" }]);
  vi.mocked(api.fetchDefinitions).mockResolvedValue({ nodes: [], providers: [{ id: "openai", label: "OpenAI" }], connectors: [], mcpServers: [] } as never);
  vi.mocked(api.fetchReplayJobs).mockResolvedValue({ runs: [job()] });
  vi.mocked(api.fetchReplayJob).mockResolvedValue({ run: { ...job(), results: [caseResult(), caseResult({ id: "res_2", fixtureName: "Exchange baseline", status: "pass", verdict: "pass" })] } });
  vi.mocked(api.subscribeEvalRun).mockReturnValue(() => undefined);
});

describe("EvaluationsPage — golden sets", () => {
  it("lists golden sets only, with their workflow and golden-run count", async () => {
    renderPage();
    const list = await screen.findByRole("list", { name: "Golden sets" });
    expect(within(list).getByText("Refund regressions")).toBeInTheDocument();
    expect(within(list).getByText("Support triage")).toBeInTheDocument();
    expect(within(list).queryByText("Hand-written")).not.toBeInTheDocument();
  });

  it("shows guidance when there are no sets", async () => {
    vi.mocked(api.fetchEvalDatasets).mockResolvedValue({ datasets: [] });
    renderPage();
    expect(await screen.findByText(/Save a run as a golden run from the Runs page/)).toBeInTheDocument();
  });

  it("creates a golden set for a workflow", async () => {
    vi.mocked(api.createEvalDataset).mockResolvedValue({ dataset: goldenSet });
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: "+ New golden set" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Refund regressions");
    await user.click(screen.getByRole("button", { name: "Create set" }));
    await waitFor(() => expect(api.createEvalDataset).toHaveBeenCalledWith({ name: "Refund regressions", workflowId: "wf-1" }));
  });

  it("opens a set: cases, own scorers, and adds only golden runs not in it", async () => {
    vi.mocked(api.addGoldenRunToSet).mockResolvedValue({ fixture: { ...fixture, id: "fix_2", recordingId: "rec_bbb" } });
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: /Refund regressions/ }));
    const cases = await screen.findByRole("region", { name: "Cases" });
    expect(await within(cases).findByText("rec_aaa")).toBeInTheDocument();
    expect(within(cases).getByText("text_similarity ≥ 0.9")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Refund baseline is in the set" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Add Exchange baseline" }));
    await waitFor(() => expect(api.addGoldenRunToSet).toHaveBeenCalledWith("set_1", { recordingId: "rec_bbb", name: "Exchange baseline" }));
  });

  it("removes a case and deletes a set after confirming", async () => {
    vi.mocked(api.deleteEvalFixture).mockResolvedValue({ ok: true });
    vi.mocked(api.deleteEvalDataset).mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: /Refund regressions/ }));
    await user.click(await screen.findByRole("button", { name: "Remove Refund baseline" }));
    await waitFor(() => expect(api.deleteEvalFixture).toHaveBeenCalledWith("fix_1"));
    await user.click(screen.getByRole("button", { name: "Delete set" }));
    await waitFor(() => expect(api.deleteEvalDataset).toHaveBeenCalledWith("set_1"));
    expect(confirm).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it("viewers read a set without edit actions", async () => {
    const user = renderPage("viewer");
    expect(screen.queryByRole("button", { name: "+ New golden set" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /Refund regressions/ }));
    expect(await screen.findByText("rec_aaa")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run replay" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete set" })).not.toBeInTheDocument();
    expect(api.fetchReplayRecordings).toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Add golden runs" })).not.toBeInTheDocument();
  });

  it("starts a replay job with a version, options and a judge that names a secret, then opens the job", async () => {
    vi.mocked(api.startReplayJob).mockResolvedValue({ run: job({ id: "job_new", status: "queued", summary: null }) });
    vi.mocked(api.fetchReplayJob).mockResolvedValue({ run: { ...job({ id: "job_new", status: "queued", summary: null }), results: [] } });
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: /Refund regressions/ }));
    await user.click(await screen.findByRole("button", { name: "Run replay" }));
    const dialog = await screen.findByRole("dialog", { name: "Run replay" });
    expect(within(dialog).getByText(/server default/)).toBeInTheDocument();
    await within(dialog).findByRole("option", { name: "Version 3 · tone" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Candidate" }), "3");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: /MCP calls/ }), "lenient");
    await user.type(within(dialog).getByRole("textbox", { name: "Ignore paths (one per line)" }), "answer.at");
    await user.type(within(dialog).getByRole("textbox", { name: "Max cost (USD)" }), "2");
    await user.click(within(dialog).getByRole("checkbox", { name: /^status/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: /^llm_judge/ }));
    await user.type(within(dialog).getByRole("textbox", { name: "Rubric" }), "Polite and correct");
    await within(dialog).findByRole("option", { name: "Judge key · openai" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Credentials (secret)" }), "sec_judge");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Provider" }), "openai");
    await user.click(within(dialog).getByRole("button", { name: "Replay 1 case" }));
    await waitFor(() =>
      expect(api.startReplayJob).toHaveBeenCalledWith({
        datasetIds: ["set_1"],
        version: 3,
        mcpMode: "lenient",
        ignorePaths: ["answer.at"],
        maxCostUsd: 2,
        scorers: [
          { type: "status" },
          { type: "llm_judge", rubric: "Polite and correct", mode: "absolute", votes: 1, providerId: "openai", secretRef: { secretId: "sec_judge" } }
        ]
      })
    );
    expect(await screen.findByRole("progressbar", { name: "Cases done" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Replay jobs" })).toHaveAttribute("aria-selected", "true");
  });

  it("closes the dialog with Escape", async () => {
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: /Refund regressions/ }));
    await user.click(await screen.findByRole("button", { name: "Run replay" }));
    await screen.findByRole("dialog", { name: "Run replay" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Run replay" })).not.toBeInTheDocument();
  });
});

describe("EvaluationsPage — replay jobs", () => {
  it("lists jobs with candidate, counts and spend", async () => {
    const user = renderPage();
    await user.click(screen.getByRole("tab", { name: "Replay jobs" }));
    const row = await screen.findByRole("button", { name: "Replay job job_1" });
    expect(within(row).getByText("v3")).toBeInTheDocument();
    expect(within(row).getByText("deadbeef")).toBeInTheDocument();
    expect(within(row).getByText("1 pass")).toBeInTheDocument();
    expect(within(row).getByText("1 fail")).toBeInTheDocument();
    expect(within(row).getByText("$0.012")).toBeInTheDocument();
  });

  it("shows a job's cases and opens the case drawer with the replay diff", async () => {
    const detail: EvalCaseDetail = { ...caseResult(), output: {}, replay: replayDiff };
    vi.mocked(api.fetchReplayJobCase).mockResolvedValue({ result: detail });
    const user = renderPage();
    await user.click(screen.getByRole("tab", { name: "Replay jobs" }));
    await user.click(await screen.findByRole("button", { name: "Replay job job_1" }));
    const row = await screen.findByRole("button", { name: /Open case Refund baseline/ });
    expect(within(row).getByText("json_equal")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel job" })).not.toBeInTheDocument();
    await user.click(row);
    const drawer = await screen.findByRole("dialog", { name: "Refund baseline" });
    expect(api.fetchReplayJobCase).toHaveBeenCalledWith("job_1", "res_1");
    expect(await within(drawer).findByRole("region", { name: "Replay result" })).toBeInTheDocument();
    expect(within(drawer).getByText("Refund denied")).toBeInTheDocument();
    expect(within(drawer).getByText("answer changed")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Refund baseline" })).not.toBeInTheDocument();
  });

  it("explains a case without a replay diff", async () => {
    vi.mocked(api.fetchReplayJobCase).mockResolvedValue({
      result: { ...caseResult({ status: "skipped", score: null, error: "The golden run was deleted." }), output: null, replay: null }
    });
    const user = renderPage();
    await user.click(screen.getByRole("tab", { name: "Replay jobs" }));
    await user.click(await screen.findByRole("button", { name: "Replay job job_1" }));
    await user.click(await screen.findByRole("button", { name: /Open case Refund baseline/ }));
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByRole("status")).toHaveTextContent("The golden run was deleted.");
  });

  it("follows a running job's progress and cancels it", async () => {
    const running = job({ status: "running", summary: null, progress: { total: 4, done: 1, running: 1, pass: 1, fail: 0, error: 0, skipped: 0, spentUsd: 0.01, updatedAt: "" } });
    vi.mocked(api.fetchReplayJobs).mockResolvedValue({ runs: [running] });
    vi.mocked(api.fetchReplayJob).mockResolvedValue({ run: { ...running, results: [] } });
    vi.mocked(api.cancelReplayJob).mockResolvedValue({ run: { ...running, status: "canceled" } });
    let push: ((event: EvalRunEvent) => void) | null = null;
    vi.mocked(api.subscribeEvalRun).mockImplementation((_id, onEvent) => {
      push = onEvent;
      return () => undefined;
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = renderPage();
    await user.click(screen.getByRole("tab", { name: "Replay jobs" }));
    await user.click(await screen.findByRole("button", { name: "Replay job job_1" }));
    const bar = await screen.findByRole("progressbar", { name: "Cases done" });
    expect(bar).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByText(/spent \$0\.010 of \$5\.00/)).toBeInTheDocument();
    await waitFor(() => expect(api.subscribeEvalRun).toHaveBeenCalledWith("job_1", expect.any(Function)));
    act(() => push!({ type: "progress", run: { ...running, progress: { ...running.progress!, done: 3, running: 1, pass: 2, fail: 1 } } }));
    expect(screen.getByRole("progressbar", { name: "Cases done" })).toHaveAttribute("aria-valuenow", "3");
    expect(screen.getByText("2 pass")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel job" }));
    await waitFor(() => expect(api.cancelReplayJob).toHaveBeenCalledWith("job_1"));
    confirm.mockRestore();
  });

  it("shows guidance when there are no jobs", async () => {
    vi.mocked(api.fetchReplayJobs).mockResolvedValue({ runs: [] });
    const user = renderPage();
    await user.click(screen.getByRole("tab", { name: "Replay jobs" }));
    expect(await screen.findByText(/choose Run replay/)).toBeInTheDocument();
  });
});
