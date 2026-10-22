import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionResult } from "@ai-orchestrator/shared";
import { RunTape, buildTapeLanes } from "./RunTape";

const meta = new Map([["llm", { label: "Summarise", type: "llm_call" }]]);

function runResult(overrides: Partial<WorkflowExecutionResult["nodeResults"][number]>): WorkflowExecutionResult {
  return {
    workflowId: "wf",
    status: "partial",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
    nodeResults: [{ nodeId: "llm", status: "running", startedAt: "2026-01-01T00:00:00.000Z", ...overrides }]
  };
}

describe("RunTape", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks elapsed time on a running lane", () => {
    const result = runResult({ liveStartedAtMs: Date.now() } as never);
    render(<RunTape executionResult={result} nodeMetaById={meta} />);
    const row = within(screen.getByRole("table", { name: "Run tape" })).getAllByRole("row")[0]!;
    expect(row).toHaveTextContent("0ms");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(row).toHaveTextContent("3.0s");
  });

  it("ticks the head while a node runs, then shows the run total", () => {
    const { rerender } = render(<RunTape executionResult={runResult({ liveStartedAtMs: Date.now() } as never)} nodeMetaById={meta} />);
    const head = () => document.querySelector(".run-tape-head > span")!;
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(head()).toHaveTextContent("running 4.0s");
    expect(head()).toHaveTextContent("status running");

    rerender(
      <RunTape
        executionResult={{ ...runResult({ status: "success", durationMs: 4200, completedAt: "2026-01-01T00:00:04.200Z" }), status: "success" }}
        nodeMetaById={meta}
      />
    );
    expect(head()).toHaveTextContent("last run 4.2s");
    expect(head()).toHaveTextContent("status success");
  });

  it("shows the error and its fix inline under a failed lane", () => {
    const result = runResult({
      status: "error",
      durationMs: 800,
      error: "401 unauthorized",
      errorRemediation: "Check the API key."
    });
    render(<RunTape executionResult={result} nodeMetaById={meta} />);
    expect(screen.getByText("401 unauthorized")).toBeInTheDocument();
    expect(screen.getByText(/Check the API key\./)).toBeInTheDocument();
  });

  it("carries remediation and the live start into the lane model", () => {
    const failed = buildTapeLanes(runResult({ status: "error", error: "x", errorRemediation: "fix it" }), meta);
    expect(failed.lanes[0]!.errorRemediation).toBe("fix it");
    const running = buildTapeLanes(runResult({ liveStartedAtMs: 42 } as never), meta);
    expect(running.lanes[0]!.liveStartedAtMs).toBe(42);
  });
});
