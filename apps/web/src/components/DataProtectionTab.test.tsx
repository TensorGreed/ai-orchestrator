import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetentionAdminView } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { DataProtectionTab } from "./DataProtectionTab";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchRetention: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const view: RetentionAdminView = {
  intervalMs: 3_600_000,
  maxRowsPerTick: 50_000,
  bounds: { minDays: 1, maxDays: null },
  backlogCap: 10_000,
  classes: [
    {
      class: "runs",
      label: "Runs",
      what: "Run history: inputs, outputs and traces",
      setting: "EXECUTION_HISTORY_RETENTION_DAYS",
      days: 30,
      cutoff: "2026-10-11T12:00:00.000Z",
      backlog: 10_000,
      backlogCapped: true
    },
    {
      class: "usage",
      label: "Usage",
      what: "Usage and cost events",
      setting: "USAGE_EVENTS_RETENTION_DAYS",
      days: 0,
      cutoff: null,
      backlog: null,
      backlogCapped: false
    },
    {
      class: "tool_calls",
      label: "Tool calls",
      what: "MCP tool-call telemetry",
      setting: "EXECUTION_HISTORY_RETENTION_DAYS",
      days: 30,
      cutoff: "2026-10-11T12:00:00.000Z",
      backlog: 1,
      backlogCapped: false
    }
  ],
  lastRun: {
    id: "r2",
    startedAt: "2026-11-10T11:00:00.000Z",
    finishedAt: "2026-11-10T11:00:01.000Z",
    instanceId: "i",
    reason: "write",
    outcome: "partial",
    counts: { runs: 1_200, tool_calls: 3 },
    capped: [],
    error: "usage: failed"
  },
  nextRunAt: "2026-11-10T12:00:00.000Z",
  runs: []
};

describe("DataProtectionTab", () => {
  it("shows each class read-only with its setting, the backlog and the last purge", async () => {
    vi.mocked(api.fetchRetention).mockResolvedValue({ ...view, runs: [view.lastRun!, { ...view.lastRun!, id: "r1", reason: "interval", outcome: "ok", counts: {}, error: null }] });
    render(<DataProtectionTab />);
    const runs = await screen.findByTestId("retention-class-runs");
    expect(runs.textContent).toContain("30 days");
    expect(runs.textContent).toContain("EXECUTION_HISTORY_RETENTION_DAYS");
    expect(runs.textContent).toContain("10,000+ rows");
    expect(screen.getByTestId("retention-class-usage").textContent).toContain("Kept forever");
    expect(screen.getByTestId("retention-class-tool_calls").textContent).toContain("1 row");
    expect(screen.getByTestId("retention-schedule").textContent).toContain("every hour");
    const last = screen.getByTestId("retention-last-run").textContent ?? "";
    expect(last).toContain("After a run");
    expect(last).toContain("Runs: 1,200, Tool calls: 3");
    expect(last).toContain("usage: failed");
    expect(screen.getByRole("table", { name: "Recent purges" }).textContent).toContain("Nothing due");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("before the first purge, and on an error", async () => {
    vi.mocked(api.fetchRetention).mockResolvedValueOnce({ ...view, lastRun: null, nextRunAt: null });
    render(<DataProtectionTab />);
    expect((await screen.findByTestId("retention-last-run")).textContent).toContain("None yet");
    expect(screen.getByTestId("retention-next-run").textContent).toContain("After the first scheduled purge");
    cleanup();
    vi.mocked(api.fetchRetention).mockRejectedValueOnce(new Error("Forbidden"));
    render(<DataProtectionTab />);
    expect(await screen.findByText("Forbidden")).toBeTruthy();
  });
});
