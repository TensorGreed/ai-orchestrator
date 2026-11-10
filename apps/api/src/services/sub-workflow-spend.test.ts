/**
 * SubWorkflowSpendTracker: children's usage joins the run's row while the run is going; what arrives after the row
 * (a late async child) or what a paused run held is recorded at once as a row of its own, for the run's execution and
 * attribution, with its budget alerts.
 */
import { describe, expect, it } from "vitest";
import type { SubWorkflowUsage } from "@ai-orchestrator/workflow-engine";
import { BudgetCheckTimeoutError, RESERVATION_FLOOR, SubWorkflowSpendTracker, usageUserOf, type RunUsageAttribution } from "./sub-workflow-spend.js";
import type { RecordExecutionInput } from "./usage-service.js";

const blob = (tokens: number) => ({ providerId: "p", model: "m", usage: { inputTokens: tokens, outputTokens: 0, totalTokens: tokens } });
const usage = (workflowId: string, tokens: number, status: SubWorkflowUsage["status"] = "success"): SubWorkflowUsage => ({
  workflowId,
  status,
  mode: "async",
  durationMs: 5,
  telemetry: [blob(tokens)]
});

function fixture(maxOpenRuns?: number, budgetCheckTimeoutMs?: number) {
  const rows: RecordExecutionInput[] = [];
  const alerts: Array<Record<string, unknown>> = [];
  const tokensOf = (blobs: ReadonlyArray<Record<string, unknown>>) => blobs.reduce((sum, entry) => sum + ((entry.usage as { totalTokens: number }).totalTokens ?? 0), 0);
  const tracker = new SubWorkflowSpendTracker({
    usageService: {
      recordExecution: async (input) => {
        rows.push(input);
        const totalTokens = tokensOf(input.subWorkflowTelemetry ?? []);
        return { inputTokens: totalTokens, outputTokens: 0, cachedInputTokens: 0, totalTokens, costUsd: totalTokens / 1000, llmCallCount: 1 };
      },
      totalTelemetry: (blobs) => {
        const totalTokens = tokensOf(blobs);
        return { inputTokens: totalTokens, outputTokens: 0, cachedInputTokens: 0, totalTokens, costUsd: totalTokens / 1000, llmCallCount: blobs.length };
      }
    },
    budgetService: { recordExecution: async (ctx) => void alerts.push(ctx as unknown as Record<string, unknown>) },
    logger: { warn: () => undefined },
    ...(maxOpenRuns ? { maxOpenRuns } : {}),
    ...(budgetCheckTimeoutMs ? { budgetCheckTimeoutMs } : {})
  });
  return { tracker, rows, alerts };
}

const attribution: RunUsageAttribution = {
  executionId: "exec-1",
  workflowId: "wf-parent",
  workflowName: "Parent",
  projectId: "proj-a",
  triggeredBy: "ana@example.com"
};

describe("SubWorkflowSpendTracker", () => {
  it("holds children's usage for the run's row and counts it as pending until then", async () => {
    const { tracker, rows } = fixture();
    const spend = tracker.start(attribution);
    await spend.report(usage("wf-a", 10));
    await spend.report(usage("wf-b", 5));
    expect(spend.pending()).toEqual({ costUsd: 0.015, totalTokens: 15 });
    expect(tracker.take("exec-1")).toBe(spend);
    expect(tracker.take("exec-1")).toBeUndefined();
    expect(spend.closeIntoRun()).toEqual([blob(10), blob(5)]);
    // Still pending while the run's row is being written.
    expect(spend.pending()).toEqual({ costUsd: 0.015, totalTokens: 15 });
    spend.recorded();
    expect(spend.pending()).toEqual({ costUsd: 0, totalTokens: 0 });
    expect(rows).toEqual([]);
  });

  it("records a child that ends after the run's row as a row of its own, for the run's attribution", async () => {
    const { tracker, rows, alerts } = fixture();
    const spend = tracker.start(attribution);
    spend.closeIntoRun();
    await spend.report(usage("wf-late", 7, "error"));
    expect(rows).toEqual([
      expect.objectContaining({
        executionId: "exec-1",
        workflowId: "wf-parent",
        workflowName: "Parent",
        projectId: "proj-a",
        userEmail: "ana@example.com",
        userId: null,
        triggerType: "sub_workflow",
        status: "error",
        subWorkflowTelemetry: [blob(7)]
      })
    ]);
    expect(alerts).toEqual([expect.objectContaining({ executionId: "exec-1", workflowId: "wf-parent", projectId: "proj-a", spentTokens: 7 })]);
  });

  it("records what a paused run held at once, one row per child", async () => {
    const { tracker, rows } = fixture();
    const spend = tracker.start({ ...attribution, gatewayUsage: { clientId: "cli-1", clientName: "IDE", toolsetId: "ts-1", toolsetProjectId: "proj-b" } });
    await spend.report(usage("wf-a", 3));
    await spend.report(usage("wf-b", 4));
    await spend.closeDetached();
    expect(rows.map((row) => [row.subWorkflowTelemetry, row.clientId, row.toolsetId, row.userId])).toEqual([
      [[blob(3)], "cli-1", "ts-1", "mcp-client:IDE"],
      [[blob(4)], "cli-1", "ts-1", "mcp-client:IDE"]
    ]);
  });

  it("reserves each async child still running, at the floor until one finishes, then at the largest finished child", async () => {
    const { tracker } = fixture();
    const spend = tracker.start(attribution);
    const first = spend.admit({ mode: "async" });
    spend.admit({ mode: "async" });
    // Sync and tool children run one at a time: not reserved.
    spend.admit({ mode: "sync" });
    spend.admit({ mode: "tool" });
    expect(spend.concurrentRunning({ mode: "async" })).toBe(2);
    expect(spend.pending({ mode: "async" })).toEqual({ costUsd: 2 * RESERVATION_FLOOR.costUsd, totalTokens: 2 * RESERVATION_FLOOR.totalTokens });
    await spend.report(usage("wf-a", 5_000));
    first.settle();
    // One left running, reserved at the largest finished child (5,000 tokens, $5), plus the 5,000 held.
    expect(spend.pending({ mode: "async" })).toEqual({ costUsd: 10, totalTokens: 10_000 });
  });

  it("does not reserve a child's own ancestors against it, and counts a timed-out tool child once it is detached", () => {
    const { tracker } = fixture();
    const spend = tracker.start(attribution);
    const outer = spend.admit({ mode: "async" });
    const inner = spend.admit({ mode: "async", parent: outer });
    expect(spend.concurrentRunning({ mode: "sync", parent: inner })).toBe(0);
    expect(spend.concurrentRunning({ mode: "sync" })).toBe(2);
    const tool = spend.admit({ mode: "tool" });
    expect(spend.concurrentRunning({ mode: "tool" })).toBe(2);
    tool.detach?.();
    expect(spend.concurrentRunning({ mode: "tool" })).toBe(3);
    tool.settle();
    inner.settle();
    outer.settle();
    expect(spend.concurrentRunning({ mode: "async" })).toBe(0);
  });

  it("records held spend, with a warning, when a run is replaced, dropped or abandoned", async () => {
    const warnings: string[] = [];
    const rows: RecordExecutionInput[] = [];
    const tracker = new SubWorkflowSpendTracker({
      usageService: {
        recordExecution: async (input) => {
          rows.push(input);
          return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, costUsd: 0, llmCallCount: 0 };
        },
        totalTelemetry: () => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 1, costUsd: 0, llmCallCount: 1 })
      },
      budgetService: { recordExecution: async () => undefined },
      logger: { warn: (_fields, message) => void warnings.push(message) },
      maxOpenRuns: 2
    });
    await tracker.start({ ...attribution, executionId: "a" }).report(usage("wf-a", 1));
    tracker.start({ ...attribution, executionId: "a" }); // a re-run of the same execution
    await tracker.start({ ...attribution, executionId: "b" }).report(usage("wf-b", 1));
    tracker.start({ ...attribution, executionId: "c" }); // drops the oldest ("a", which holds nothing now)
    tracker.start({ ...attribution, executionId: "d" }); // drops "b"
    await tracker.start({ ...attribution, executionId: "e" }).report(usage("wf-e", 1));
    await tracker.abandon("e", "stopped by the queue");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rows.map((row) => row.executionId).sort()).toEqual(["a", "b", "e"]);
    expect(warnings.filter((message) => message.includes("recorded on its own"))).toHaveLength(3);
  });

  it("checks and reserves admissions made at the same time one after another, so together they stay within a cap", async () => {
    const { tracker } = fixture();
    const spend = tracker.start(attribution);
    // A cap of 3,500 tokens and a slow budget read: each admission reserves 1,000 tokens (the floor).
    const fits = async (pending: () => { totalTokens: number }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return pending().totalTokens + 1_000 <= 3_500;
    };
    const admitted = await Promise.all(Array.from({ length: 10 }, () => spend.admitIf({ mode: "async" }, fits)));
    expect(admitted.filter(Boolean)).toHaveLength(3);
    expect(spend.concurrentRunning({ mode: "async" })).toBe(3);
    // A check that throws does not admit, and does not stop the next check.
    await expect(spend.admitIf({ mode: "async" }, async () => { throw new Error("budgets unreadable"); })).rejects.toThrow("budgets unreadable");
    expect(await spend.admitIf({ mode: "async" }, async () => true)).toBeDefined();
    expect(spend.concurrentRunning({ mode: "async" })).toBe(4);
  });

  it("keeps reserving an earlier segment's running children for the resumed or retried segment of the execution", async () => {
    const { tracker } = fixture();
    const before = tracker.start(attribution);
    const running = before.admit({ mode: "async" });
    await before.report(usage("wf-a", 2_000));
    // The run pauses (or its queue attempt is stopped): held spend is recorded, the async child runs on.
    await tracker.abandon(attribution.executionId, "paused");
    const after = tracker.start(attribution);
    expect(after.concurrentRunning({ mode: "async" })).toBe(1);
    // Reserved at the largest finished child of the execution (2,000 tokens), from before the pause.
    expect(after.pending({ mode: "async" })).toEqual({ costUsd: 2, totalTokens: 2_000 });
    running.settle();
    expect(after.pending({ mode: "async" })).toEqual({ costUsd: 0, totalTokens: 0 });
    // Once the last segment is recorded and nothing runs, the execution is forgotten.
    tracker.take(attribution.executionId)?.closeIntoRun();
    expect(tracker.trackedExecutions).toBe(0);
  });

  it("keeps a bounded number of open runs", () => {
    const { tracker } = fixture(2);
    tracker.start({ ...attribution, executionId: "a" });
    tracker.start({ ...attribution, executionId: "b" });
    tracker.start({ ...attribution, executionId: "c" });
    expect(tracker.take("a")).toBeUndefined();
    expect(tracker.take("b")).toBeDefined();
    expect(tracker.take("c")).toBeDefined();
  });

  it("keeps counting a run still going after it was dropped from the open runs (more than the bound open at once)", async () => {
    const { tracker } = fixture(1);
    const live = tracker.start({ ...attribution, executionId: "live" });
    // Another run opens: "live" is dropped from the open runs while it still runs, with no child running.
    tracker.start({ ...attribution, executionId: "other" });
    expect(tracker.take("live")).toBeUndefined();
    const cap = async (pending: () => { totalTokens: number }) => pending().totalTokens + RESERVATION_FLOOR.totalTokens <= 2_500;
    // Its own async children are still reserved against its next ones: two fit under the cap, the third does not.
    expect(await live.admitIf({ mode: "async" }, cap)).toBeDefined();
    expect(await live.admitIf({ mode: "async" }, cap)).toBeDefined();
    expect(await live.admitIf({ mode: "async" }, cap)).toBeUndefined();
    expect(live.concurrentRunning({ mode: "async" })).toBe(2);
    // A retried segment of the same execution sees them too.
    const retry = tracker.start({ ...attribution, executionId: "live" });
    expect(retry.concurrentRunning({ mode: "async" })).toBe(2);
  });

  it("refuses a child whose budget check hangs, and lets the next check go on", async () => {
    const { tracker } = fixture(undefined, 30);
    const spend = tracker.start(attribution);
    const hung = spend.admitIf({ mode: "async" }, () => new Promise<boolean>(() => undefined));
    const next = spend.admitIf({ mode: "async" }, async () => true);
    await expect(hung).rejects.toBeInstanceOf(BudgetCheckTimeoutError);
    await expect(hung).rejects.toThrow("The budgets could not be read within");
    expect(await next).toBeDefined();
    expect(spend.concurrentRunning({ mode: "async" })).toBe(1);
  });

  it("closes only the stopped attempt's record: a retry of the execution keeps its own for its row", async () => {
    const { tracker, rows } = fixture();
    const first = {};
    const second = {};
    const stopped = tracker.start(attribution, first);
    await stopped.report(usage("wf-a", 3));
    // The retry starts in the same process before the stopped attempt is cleaned up.
    const retry = tracker.start(attribution, second);
    await retry.report(usage("wf-b", 4));
    await tracker.abandon(attribution.executionId, "stopped by the queue", first);
    // The retry's child joins its run's row.
    expect(tracker.take(attribution.executionId)).toBe(retry);
    expect(retry.closeIntoRun()).toEqual([blob(4)]);
    // The stopped attempt's child got a row of its own (when the retry replaced it).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rows.map((row) => row.subWorkflowTelemetry)).toEqual([[blob(3)]]);
  });

  it("holds a failed model call's usage for the run's row without raising a child's reservation", async () => {
    const { tracker, rows } = fixture();
    const spend = tracker.start(attribution);
    await spend.reportModelUsage({ ...blob(800), latencyMs: 12 });
    spend.admit({ mode: "async" });
    // 800 held, and the running child reserved at the floor (no child has finished).
    expect(spend.pending({ mode: "async" })).toEqual({ costUsd: 0.8 + RESERVATION_FLOOR.costUsd, totalTokens: 800 + RESERVATION_FLOOR.totalTokens });
    expect(tracker.take(attribution.executionId)?.closeIntoRun()).toEqual([{ ...blob(800), latencyMs: 12 }]);
    // After the row: a row of its own.
    await spend.reportModelUsage(blob(9));
    expect(rows).toEqual([expect.objectContaining({ executionId: "exec-1", workflowId: "wf-parent", status: "error", triggerType: "sub_workflow", subWorkflowTelemetry: [blob(9)] })]);
  });

  it("attributes usage like a run's row", () => {
    expect(usageUserOf("ana@example.com", undefined)).toEqual({ email: "ana@example.com", id: null });
    expect(usageUserOf("schedule", undefined)).toEqual({ email: null, id: "schedule" });
    expect(usageUserOf(undefined, undefined)).toEqual({ email: null, id: null });
    expect(usageUserOf("ana@example.com", { clientId: "c", clientName: "IDE", toolsetId: "t", toolsetProjectId: null })).toEqual({ email: null, id: "mcp-client:IDE" });
  });
});
