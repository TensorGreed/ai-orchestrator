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
    estimateReplayJob: vi.fn(),
    fetchWorkflow: vi.fn(),
    fetchGuardProfiles: vi.fn(),
    fetchMcpServers: vi.fn(),
    fetchReplayJobs: vi.fn(),
    fetchReplayJob: vi.fn(),
    fetchReplayJobCase: vi.fn(),
    cancelReplayJob: vi.fn(),
    subscribeEvalRun: vi.fn(),
    fetchReleaseGateCases: vi.fn()
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
  vi.mocked(api.fetchWorkflow).mockResolvedValue(candidateWorkflow() as never);
  vi.mocked(api.fetchGuardProfiles).mockResolvedValue({ profiles: [{ id: "strict", name: "Strict support", builtIn: false, latestVersion: 2, hash: "h", createdAt: "", updatedAt: "" }], autoApply: false, builtInId: "default" });
  vi.mocked(api.fetchMcpServers).mockResolvedValue({ servers: [{ id: "srv_docs", name: "Docs" }], adapters: [], defaultProbeIntervalMs: 0 } as never);
  vi.mocked(api.estimateReplayJob).mockResolvedValue({ cases: 1, runsPerCase: 1, modelCallsEstimate: 1, estimatedCostUsd: 0.002, costUnknown: false, warnings: [] });
  vi.mocked(api.fetchReleaseGateCases).mockResolvedValue({ cases: { workflowId: "wf-1", enforced: false, cases: [], counts: { admitted: 0, pending: 0, required: 0 }, canAdmit: false, canRequest: false } });
});

/** wf-1 with an agent (chat model attached), a read node and a write node. */
function candidateWorkflow() {
  return {
    id: "wf-1",
    name: "Support triage",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "agent_1", type: "agent_orchestrator", name: "Triage agent", position: { x: 0, y: 0 }, config: {} },
      { id: "model", type: "llm_call", name: "Model", position: { x: 0, y: 0 }, config: { provider: { providerId: "openai", model: "gpt-4o-mini" } } },
      { id: "sheet", type: "google_sheets_read", name: "Orders sheet", position: { x: 0, y: 0 }, config: {} },
      { id: "slack", type: "slack_send_message", name: "Notify", position: { x: 0, y: 0 }, config: {} }
    ],
    edges: [{ id: "e1", source: "agent_1", sourceHandle: "chat_model", target: "model" }]
  };
}

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

  it("shows the required chip only for a case an enforced gate requires, never on an unenforced gate", async () => {
    vi.mocked(api.fetchEvalFixtures).mockResolvedValue({ fixtures: [{ ...fixture, required: true }] });
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: /Refund regressions/ }));
    const cases = await screen.findByRole("region", { name: "Cases" });
    expect(await within(cases).findByText("rec_aaa")).toBeInTheDocument();
    await waitFor(() => expect(api.fetchReleaseGateCases).toHaveBeenCalledWith("wf-1"));
    expect(within(cases).queryByText("required")).toBeNull();
  });

  it("shows the required chip when the enforced gate requires the case", async () => {
    vi.mocked(api.fetchReleaseGateCases).mockResolvedValue({
      cases: {
        workflowId: "wf-1",
        enforced: true,
        cases: [{ fixtureId: "fix_1", datasetId: "set_1", datasetName: "Refund regressions", name: "Refund baseline", recordingId: "rec_aaa", admission: "admitted", required: true, requestId: null, requestKind: null, createdAt: "" }],
        counts: { admitted: 1, pending: 0, required: 1 },
        canAdmit: false,
        canRequest: true
      }
    });
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: /Refund regressions/ }));
    const cases = await screen.findByRole("region", { name: "Cases" });
    expect(await within(cases).findByText("required")).toBeInTheDocument();
  });

  it("marks golden runs imported from a golden-set file", async () => {
    const imported = recording("rec_ccc", "Imported baseline");
    imported.capabilities = { ...imported.capabilities, origin: "imported", recordedAt: "2024-01-02T03:04:05.000Z", sourceWorkflowId: "wf-0" };
    vi.mocked(api.fetchReplayRecordings).mockResolvedValue({ items: [recording("rec_aaa", "Refund baseline"), imported], total: 2 });
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: /Refund regressions/ }));
    const add = await screen.findByRole("region", { name: "Add golden runs" });
    await within(add).findByText("Imported baseline");
    expect(within(add).getAllByText("imported")).toHaveLength(1);
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

  it("a builder keeps Remove and Delete set on a set a gate flagged enforced uses: the gate restricts them only while it is on, so the server decides", async () => {
    vi.mocked(api.fetchReleaseGateCases).mockResolvedValue({
      cases: {
        workflowId: "wf-1",
        enforced: true,
        cases: [{ fixtureId: "fix_1", datasetId: "set_1", datasetName: "Refund regressions", name: "Refund baseline", recordingId: "rec_aaa", admission: "admitted", required: false, requestId: null, requestKind: null, createdAt: "" }],
        counts: { admitted: 1, pending: 0, required: 0 },
        canAdmit: false,
        canRequest: true
      }
    });
    vi.mocked(api.deleteEvalFixture).mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: /Refund regressions/ }));
    await waitFor(() => expect(api.fetchReleaseGateCases).toHaveBeenCalledWith("wf-1"));
    expect(screen.getByRole("button", { name: "Delete set" })).toBeEnabled();
    await user.click(await screen.findByRole("button", { name: "Remove Refund baseline" }));
    await waitFor(() => expect(api.deleteEvalFixture).toHaveBeenCalledWith("fix_1"));
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
    await user.click(within(dialog).getByRole("button", { name: "Estimate 1 case" }));
    // The estimate comes first; nothing starts until it is confirmed.
    expect(await within(dialog).findByRole("region", { name: "Estimate" })).toHaveTextContent("1 model call");
    expect(api.startReplayJob).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Start 1 run" }));
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

  it("replays a model swap with a guard profile, MCP and read overrides, a baseline rerun and repeats, after the estimate", async () => {
    vi.mocked(api.startReplayJob).mockResolvedValue({ run: job({ id: "job_new", status: "queued", summary: null }) });
    vi.mocked(api.fetchReplayJob).mockResolvedValue({ run: { ...job({ id: "job_new", status: "queued", summary: null }), results: [] } });
    vi.mocked(api.estimateReplayJob).mockResolvedValue({
      cases: 1,
      runsPerCase: 6,
      modelCallsEstimate: 6,
      estimatedCostUsd: 0.012,
      costUnknown: true,
      warnings: ["Some models have no price in the price table: the estimate leaves them out."],
      executions: 6,
      maxExecutions: 500
    });
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: /Refund regressions/ }));
    await user.click(await screen.findByRole("button", { name: "Run replay" }));
    const dialog = await screen.findByRole("dialog", { name: "Run replay" });
    await user.click(await within(dialog).findByRole("button", { name: "Add model override" }));
    expect(within(dialog).getByRole("combobox", { name: "Model override 1 node" })).toHaveValue("agent_1");
    await user.type(within(dialog).getByRole("textbox", { name: "Model override 1 model" }), "gpt-5-mini");
    await within(dialog).findByRole("option", { name: "Strict support" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Guard profile" }), "strict");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Guard profile version" }), "1");
    await user.selectOptions(await within(dialog).findByRole("combobox", { name: "MCP mode for Docs" }), "live_read_only");
    // Only read nodes can run live.
    expect(within(dialog).queryByRole("checkbox", { name: "Notify" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox", { name: "Orders sheet" }));
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Compare with" }), "baseline_rerun");
    await user.clear(within(dialog).getByRole("textbox", { name: "Repeats" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Repeats" }), "3");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Aggregate" }), "majority");
    await user.click(within(dialog).getByRole("button", { name: "Estimate 1 case" }));
    const estimate = await within(dialog).findByRole("region", { name: "Estimate" });
    expect(estimate).toHaveTextContent("6 model calls");
    expect(estimate).toHaveTextContent("$0.012+");
    expect(estimate).toHaveTextContent("no price in the price table");
    expect(estimate).toHaveTextContent("6 executions of 500 allowed");
    const expected = {
      datasetIds: ["set_1"],
      draft: true,
      overrides: {
        models: [{ nodeId: "agent_1", model: "gpt-5-mini" }],
        guardProfile: { profileId: "strict", version: 1 },
        mcpServers: { srv_docs: "live_read_only" },
        liveReadNodes: ["sheet"]
      },
      compare: "baseline_rerun",
      repeats: 3,
      aggregate: "majority",
      mcpMode: "strict"
    };
    expect(api.estimateReplayJob).toHaveBeenCalledWith(expected);
    // A change after the estimate asks for a new one.
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Model calls" }), "replay");
    expect(within(dialog).queryByRole("region", { name: "Estimate" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Estimate 1 case" }));
    await user.click(await within(dialog).findByRole("button", { name: "Start 6 runs" }));
    await waitFor(() => expect(api.startReplayJob).toHaveBeenCalledWith({ ...expected, models: "replay" }));
  });

  it("takes a workflow file of the same workflow as the candidate, and refuses another workflow's", async () => {
    const user = renderPage();
    await user.click(await screen.findByRole("button", { name: /Refund regressions/ }));
    await user.click(await screen.findByRole("button", { name: "Run replay" }));
    const dialog = await screen.findByRole("dialog", { name: "Run replay" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Candidate" }), "file");
    const input = within(dialog).getByLabelText("Workflow file");
    await user.upload(input, new File([JSON.stringify({ ...candidateWorkflow(), id: "wf-other" })], "other.json", { type: "application/json" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("is for workflow wf-other");
    const file = { workflow: { ...candidateWorkflow(), name: "Triage v2" } };
    await user.upload(input, new File([JSON.stringify(file)], "triage-v2.json", { type: "application/json" }));
    expect(await within(dialog).findByText("Replaying triage-v2.json.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Estimate 1 case" }));
    await waitFor(() => expect(api.estimateReplayJob).toHaveBeenCalledWith({ datasetIds: ["set_1"], workflow: file.workflow, mcpMode: "strict" }));
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

  it("shows a job's candidate overrides, comparison and each repeat of a case", async () => {
    const candidateJob = job({
      candidate: {
        kind: "inline",
        version: null,
        workflowHash: "beefbeefbeef0000",
        baseHash: "aaaa",
        name: "Triage v2",
        overrides: { models: [{ nodeId: "agent_1", model: "gpt-5-mini" }], guardProfile: { profileId: "strict", version: 2 } },
        guardProfile: { profileId: "strict", version: 2, hash: "cafecafecafe0000" },
        releaseEligible: false,
        releaseIneligibleReasons: ["The candidate is a workflow file, not the draft or a saved version."]
      },
      options: { mcpMode: "strict", maxCostUsd: 5, models: "replay", compare: "baseline_rerun", repeats: 3, aggregate: "majority" },
      summary: { ...job().summary!, replayedModelCalls: 6, recordedCostUsd: 0.0123 }
    });
    const repeated = caseResult({ status: "pass", verdict: "pass", repeats: { total: 3, pass: 2, fail: 1, error: 0, aggregate: "majority", flaky: true } });
    vi.mocked(api.fetchReplayJobs).mockResolvedValue({ runs: [candidateJob] });
    vi.mocked(api.fetchReplayJob).mockResolvedValue({ run: { ...candidateJob, results: [repeated] } });
    const attempts = [0, 1, 2].map((repeatIndex) => ({
      repeatIndex,
      status: repeatIndex === 1 ? ("fail" as const) : ("pass" as const),
      executionId: `ex-c${repeatIndex}`,
      baselineExecutionId: `ex-b${repeatIndex}`,
      verdict: repeatIndex === 1 ? ("fail" as const) : ("pass" as const),
      reasons: repeatIndex === 1 ? ["Output changed at 1 path (answer)"] : [],
      costUsd: 0.002,
      latencyMs: [120, 2400, 95][repeatIndex],
      baselineLatencyMs: [110, 2300, 90][repeatIndex],
      newGuardBlocks: repeatIndex === 1 ? 2 : 0
    }));
    vi.mocked(api.fetchReplayJobCase).mockResolvedValue({ result: { ...repeated, output: {}, replay: { ...replayDiff, compare: "baseline_rerun", baselineExecutionId: "ex-b0", attempts } } });
    const user = renderPage();
    await user.click(screen.getByRole("tab", { name: "Replay jobs" }));
    await user.click(await screen.findByRole("button", { name: "Replay job job_1" }));
    expect(await screen.findByText("file: Triage v2")).toBeInTheDocument();
    expect(screen.getByText("models from tape · vs baseline rerun · 3× (majority)")).toBeInTheDocument();
    const overrides = screen.getByRole("region", { name: "Candidate overrides" });
    expect(within(overrides).getByText("Model on agent_1: gpt-5-mini")).toBeInTheDocument();
    expect(within(overrides).getByText("Guard profile strict v2")).toBeInTheDocument();
    const proof = screen.getByRole("region", { name: "Release proof" });
    expect(proof).toHaveTextContent("Not release proof.");
    expect(proof).toHaveTextContent("workflow file");
    expect(proof).toHaveTextContent("Guard profile strict v2");
    expect(screen.getByRole("region", { name: "Progress" })).toHaveTextContent("6 model calls from the tape (recorded cost $0.012, not spent)");
    const row = await screen.findByRole("button", { name: /Open case Refund baseline/ });
    expect(within(row).getByText("2 of 3 repeats passed · flaky")).toBeInTheDocument();
    await user.click(row);
    const drawer = await screen.findByRole("dialog", { name: "Refund baseline" });
    expect(await within(drawer).findByText(/each against its own baseline rerun/)).toBeInTheDocument();
    expect(within(drawer).getByText("baseline ex-b1")).toBeInTheDocument();
    expect(within(drawer).getByText("Output changed at 1 path (answer)")).toBeInTheDocument();
    // Every repeat shows its own latency (against its own baseline rerun) and new guard blocks beside its cost.
    expect(within(drawer).getByText("latency 120 ms (baseline 110 ms)")).toBeInTheDocument();
    expect(within(drawer).getByText("latency 2.4 s (baseline 2.3 s)")).toBeInTheDocument();
    // A repeat that added guard blocks stands out; the others do not.
    expect(within(drawer).getByText("2 new guard blocks")).toHaveClass("is-danger");
    const clean = within(drawer).getAllByText("no new guard blocks");
    expect(clean).toHaveLength(2);
    for (const label of clean) expect(label).not.toHaveClass("is-danger");
  });

  it("lists a repeat stored before per-repeat latency and guard data with its cost only", async () => {
    const repeated = caseResult({ status: "pass", verdict: "pass", repeats: { total: 2, pass: 2, fail: 0, error: 0, aggregate: "all", flaky: false } });
    vi.mocked(api.fetchReplayJob).mockResolvedValue({ run: { ...job(), results: [repeated] } });
    const attempts = [0, 1].map((repeatIndex) => ({ repeatIndex, status: "pass" as const, executionId: `ex-old${repeatIndex}`, baselineExecutionId: null, verdict: "pass" as const, reasons: [], costUsd: 0.003 }));
    vi.mocked(api.fetchReplayJobCase).mockResolvedValue({ result: { ...repeated, output: {}, replay: { ...replayDiff, attempts } } });
    const user = renderPage();
    await user.click(screen.getByRole("tab", { name: "Replay jobs" }));
    await user.click(await screen.findByRole("button", { name: "Replay job job_1" }));
    await user.click(await screen.findByRole("button", { name: /Open case Refund baseline/ }));
    const drawer = await screen.findByRole("dialog", { name: "Refund baseline" });
    expect(await within(drawer).findByText("ex-old1")).toBeInTheDocument();
    expect(within(drawer).queryByText(/guard block/)).not.toBeInTheDocument();
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
