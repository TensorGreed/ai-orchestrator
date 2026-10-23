import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import type { Project } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import type { EvalRun } from "../lib/api";
import { SettingsPage } from "./SettingsPage";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchMfaStatus: vi.fn(),
    fetchEvalDatasets: vi.fn(),
    fetchEvalFixtures: vi.fn(),
    fetchEvalRuns: vi.fn(),
    fetchEvalRun: vi.fn(),
    fetchWorkflows: vi.fn(),
    startEvalRun: vi.fn(),
    subscribeEvalRun: vi.fn()
  };
});

const projects: Project[] = [{ id: "default", name: "Default", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }];

function run(id: string, mcpCassettes: number): EvalRun {
  return {
    id,
    kind: "eval",
    datasetIds: ["ds_1"],
    progress: null,
    candidate: null,
    options: null,
    datasetId: "ds_1",
    workflowId: "wf_1",
    workflowName: "Support",
    status: "completed",
    startedAt: "2026-01-02T00:00:00.000Z",
    completedAt: "2026-01-02T00:00:01.000Z",
    triggeredBy: "builder@example.com",
    summary: { total: 2, pass: 2, fail: 0, error: 0, passRate: 1, totalTokenInput: 0, totalTokenOutput: 0, totalTokenTotal: 0, totalDurationMs: 10, avgDurationMs: 5 },
    error: null,
    mcpCassettes
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchMfaStatus).mockReturnValue(new Promise(() => undefined));
  vi.mocked(api.fetchEvalDatasets).mockResolvedValue({
    datasets: [{ id: "ds_1", name: "Tickets", description: null, projectId: "default", createdBy: null, createdAt: "", updatedAt: "" }]
  } as unknown as Awaited<ReturnType<typeof api.fetchEvalDatasets>>);
  vi.mocked(api.fetchEvalFixtures).mockResolvedValue({
    fixtures: [{ id: "fix_1", datasetId: "ds_1", name: "first", input: {}, expected: null, scorers: null, recordingId: null, createdAt: "", updatedAt: "" }]
  });
  vi.mocked(api.fetchWorkflows).mockResolvedValue([{ id: "wf_1", name: "Support" }] as unknown as Awaited<ReturnType<typeof api.fetchWorkflows>>);
  vi.mocked(api.fetchEvalRun).mockReturnValue(new Promise(() => undefined));
  // Phase 15.2 — the API queues the run and answers 202 with it.
  vi.mocked(api.startEvalRun).mockResolvedValue({ run: { ...run("run_new", 0), status: "queued", summary: null }, runId: "run_new" });
});

async function openDataset() {
  const user = userEvent.setup();
  render(<SettingsPage authUser={{ id: "u-1", email: "builder@example.com", role: "builder" }} projects={projects} activeProjectId="default" />);
  await user.click(screen.getByRole("tab", { name: "Evals" }));
  await user.click(await screen.findByRole("button", { name: "Open" }));
  await user.selectOptions(await screen.findByRole("combobox", { name: "Workflow" }), "wf_1");
  return user;
}

describe("eval runs and MCP cassettes", () => {
  it("records an eval run's MCP calls", async () => {
    vi.mocked(api.fetchEvalRuns).mockResolvedValue({ runs: [] });
    const user = await openDataset();
    expect(screen.getByRole("radio", { name: /Replay a recorded run/ })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: /Record MCP calls/ }));
    await user.click(screen.getByRole("button", { name: "Run 1 fixtures" }));
    await waitFor(() => expect(api.startEvalRun).toHaveBeenCalledWith(expect.objectContaining({ datasetId: "ds_1", workflowId: "wf_1", record: true })));
    expect(vi.mocked(api.startEvalRun).mock.calls[0][0]).not.toHaveProperty("replay");
  });

  it("replays a recorded run, strict or with live fallback", async () => {
    vi.mocked(api.fetchEvalRuns).mockResolvedValue({ runs: [run("run_plain", 0), run("run_rec", 2)] });
    const user = await openDataset();
    expect(await screen.findByText(/2 recorded/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Replay a recorded run/ }));
    const select = screen.getByRole("combobox", { name: "Recorded run to replay" });
    expect(select).toHaveValue("run_rec");
    expect(screen.getAllByRole("option", { name: /cassette/ })).toHaveLength(1);
    await user.click(screen.getByRole("checkbox", { name: /Live fallback/ }));
    await user.click(screen.getByRole("button", { name: "Run 1 fixtures" }));
    await waitFor(() =>
      expect(api.startEvalRun).toHaveBeenCalledWith(expect.objectContaining({ replay: { evalRunId: "run_rec", mode: "lenient" } }))
    );
    expect(vi.mocked(api.startEvalRun).mock.calls[0][0]).not.toHaveProperty("record");
  });

  it("follows a queued run until it finishes, then shows its results", async () => {
    vi.mocked(api.fetchEvalRuns).mockResolvedValue({ runs: [] });
    const queued = { ...run("run_new", 0), status: "queued", summary: null, results: [] };
    const finished = {
      ...run("run_new", 0),
      results: [
        {
          id: "res_1",
          runId: "run_new",
          fixtureId: "fix_1",
          fixtureName: "first",
          recordingId: null,
          status: "pass",
          executionId: null,
          score: { pass: true, details: [{ type: "exact_match", pass: true, reason: "matched" }] },
          output: {},
          error: null,
          durationMs: 5,
          tokenInput: null,
          tokenOutput: null,
          tokenTotal: null,
          costUsd: null,
          verdict: null
        }
      ]
    };
    vi.mocked(api.fetchEvalRun).mockResolvedValueOnce(queued).mockResolvedValueOnce(finished);
    let push: ((event: api.EvalRunEvent) => void) | null = null;
    vi.mocked(api.subscribeEvalRun).mockImplementation((_id, onEvent) => {
      push = onEvent;
      return () => undefined;
    });
    const user = await openDataset();
    await user.click(screen.getByRole("button", { name: "Run 1 fixtures" }));
    expect(await screen.findByText(/Queued; waiting for a free slot/)).toBeInTheDocument();
    expect(api.subscribeEvalRun).toHaveBeenCalledWith("run_new", expect.any(Function), expect.objectContaining({ poll: expect.any(Function) }));
    act(() => push!({ type: "progress", run: { ...queued, status: "running", progress: { total: 1, done: 0, running: 1, pass: 0, fail: 0, error: 0, skipped: 0, spentUsd: 0, updatedAt: "" } } }));
    expect(await screen.findByText(/0 of 1 fixtures done, 1 running/)).toBeInTheDocument();
    act(() => push!({ type: "done", run: { ...finished } }));
    expect(await screen.findByText(/Per-fixture results \(1\)/)).toBeInTheDocument();
    expect(screen.queryByText(/fixtures done/)).not.toBeInTheDocument();
  });
});
