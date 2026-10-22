import { describe, expect, it } from "vitest";
import type { RunFactToolCall, RunFacts } from "@ai-orchestrator/shared";
import { judgeReplayDiff } from "@ai-orchestrator/shared";
import { alignToolCalls, DEFAULT_REPLAY_IGNORE_PATHS, diffRunFacts, diffValues, matchesIgnorePath, tokenSimilarity } from "./run-diff.js";

function tool(tool: string, args: unknown = {}, extra: Partial<RunFactToolCall> = {}): RunFactToolCall {
  return { nodeId: "agent", iteration: 1, server: "mcp_docs", tool, args, argsHash: `${tool}:${JSON.stringify(args)}`, outcome: "ok", durationMs: 10, ...extra };
}

function facts(overrides: Partial<RunFacts> = {}): RunFacts {
  return {
    status: "success",
    error: null,
    output: { answer: "The invoice was sent.", meta: { id: "run-1" } },
    nodes: [
      { nodeId: "hook", nodeType: "webhook_input", status: "success", durationMs: 1, errorCategory: null },
      { nodeId: "agent", nodeType: "agent_orchestrator", status: "success", durationMs: 800, errorCategory: null },
      { nodeId: "slack", nodeType: "slack_send_message", status: "success", durationMs: 2, errorCategory: null }
    ],
    toolCalls: [tool("search", { q: "invoice" }), tool("send_invoice", { id: 7 })],
    modelCalls: [{ nodeId: "agent", iteration: 1, providerId: "openai", model: "gpt-4o-mini", inputTokens: 100, outputTokens: 20, costUsd: 0.0001, latencyMs: 500 }],
    guard: [{ nodeId: "agent", placement: "pre_model", channel: "prompt", detectorId: "pii", effectiveAction: "mask", shadow: false }],
    totals: { inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.0001, durationMs: 900, modelCalls: 1, toolCalls: 2 },
    ...overrides
  };
}

describe("value diff", () => {
  it("reports added, removed and changed paths with array indices", () => {
    const { changes, ignored } = diffValues({ a: 1, list: [{ id: 1 }, { id: 2 }], gone: true }, { a: 2, list: [{ id: 1 }, { id: 3 }, { id: 4 }], extra: "x" });
    expect(ignored).toBe(0);
    expect(changes).toEqual([
      { path: "a", kind: "changed", baseline: 1, candidate: 2 },
      { path: "list[1].id", kind: "changed", baseline: 2, candidate: 3 },
      { path: "list[2]", kind: "added", candidate: { id: 4 } },
      { path: "gone", kind: "removed", baseline: true },
      { path: "extra", kind: "added", candidate: "x" }
    ]);
  });

  it("ignores paths by glob and counts what it ignored", () => {
    const baseline = { answer: "same", meta: { id: "a", at: "t1" }, items: [{ id: 1, v: "x" }, { id: 2, v: "y" }] };
    const candidate = { answer: "same", meta: { id: "b", at: "t2" }, items: [{ id: 9, v: "x" }, { id: 8, v: "y" }] };
    const result = diffValues(baseline, candidate, { ignorePaths: ["meta", "items[*].id"] });
    expect(result.changes).toEqual([]);
    expect(result.ignored).toBe(3);
    expect(diffValues(baseline, candidate, { ignorePaths: ["**.id", "meta.at"] }).changes).toEqual([]);
  });

  it("applies the number tolerance and normalises whitespace", () => {
    expect(diffValues({ score: 0.81 }, { score: 0.8100004 }, { numberTolerance: 0.001 }).changes).toEqual([]);
    expect(diffValues({ score: 0.81 }, { score: 0.9 }, { numberTolerance: 0.001 }).changes).toHaveLength(1);
    expect(diffValues({ text: "Hello   world\n" }, { text: " Hello world" }).changes).toEqual([]);
  });

  it("scores changed strings by token overlap", () => {
    const [change] = diffValues({ answer: "The invoice for March was sent to the customer" }, { answer: "The March invoice was sent to the customer today" }).changes;
    expect(change!.similarity).toBeGreaterThan(0.6);
    expect(change!.similarity).toBeLessThan(1);
    expect(tokenSimilarity("abc", "xyz")).toBe(0);
    expect(tokenSimilarity("", "")).toBe(1);
  });

  it("matches glob patterns over path segments", () => {
    expect(matchesIgnorePath(["a", "b", "id"], "**.id")).toBe(true);
    expect(matchesIgnorePath(["id"], "**.id")).toBe(true);
    expect(matchesIgnorePath(["a", "idx"], "**.id")).toBe(false);
    expect(matchesIgnorePath(["items", "3", "id"], "items[*].id")).toBe(true);
    expect(matchesIgnorePath(["items", "3", "id"], "$.items.*.id")).toBe(true);
    expect(matchesIgnorePath(["items", "3", "id"], "items[3].id")).toBe(true);
    expect(matchesIgnorePath(["items", "4", "id"], "items[3].id")).toBe(false);
    expect(matchesIgnorePath(["x", "_telemetry"], DEFAULT_REPLAY_IGNORE_PATHS[0]!)).toBe(true);
  });
});

describe("tool-call alignment", () => {
  it("matches calls by server and tool, marking inserted and deleted calls and argument changes", () => {
    const steps = alignToolCalls(
      [tool("search", { q: "invoice" }), tool("lookup", { id: 1 }), tool("send_invoice", { id: 7 })],
      [tool("search", { q: "invoices" }), tool("send_invoice", { id: 7 }), tool("notify", {})]
    );
    expect(steps.map((step) => [step.kind, step.baseline?.tool ?? null, step.candidate?.tool ?? null, step.argsChanged])).toEqual([
      ["matched", "search", "search", true],
      ["deleted", "lookup", null, false],
      ["matched", "send_invoice", "send_invoice", false],
      ["inserted", null, "notify", false]
    ]);
    expect(steps[0]!.argChanges).toEqual([expect.objectContaining({ path: "q", kind: "changed", baseline: "invoice", candidate: "invoices" })]);
  });

  it("flags an outcome change on a matched call", () => {
    const [step] = alignToolCalls([tool("search")], [tool("search", {}, { outcome: "guard_blocked" })]);
    expect(step).toMatchObject({ kind: "matched", outcomeChanged: true });
  });

  it("stays linear on very long tapes", () => {
    const long = Array.from({ length: 1500 }, (_, index) => tool(index % 2 ? "a" : "b", { index }));
    const steps = alignToolCalls(long, long);
    expect(steps).toHaveLength(1500);
    expect(steps.every((step) => step.kind === "matched" && !step.argsChanged)).toBe(true);
  });
});

describe("run diff", () => {
  it("finds nothing between a run and itself", () => {
    const diff = diffRunFacts(facts(), facts());
    expect(diff.status).toEqual({ baseline: "success", candidate: "success", changed: false, regression: false });
    expect(diff.output.equal).toBe(true);
    expect(diff.toolCalls.changed).toBe(false);
    expect(diff.path).toEqual({ added: [], removed: [], statusChanges: [] });
    expect(diff.models.changes).toEqual([]);
    expect(diff.guard).toEqual({ added: [], removed: [], changed: [] });
    expect(diff.totals.tokens).toEqual({ baseline: 120, candidate: 120, delta: 0, pct: 0 });
    expect(judgeReplayDiff(diff).verdict).toBe("pass");
  });

  it("reports status regressions, output and tool changes, path, model, cost and guard deltas", () => {
    const candidate = facts({
      status: "error",
      error: "boom",
      output: { answer: "The invoice could not be sent.", meta: { id: "run-2" } },
      nodes: [
        { nodeId: "hook", nodeType: "webhook_input", status: "success", durationMs: 1, errorCategory: null },
        { nodeId: "agent", nodeType: "agent_orchestrator", status: "error", durationMs: 1200, errorCategory: "provider" },
        { nodeId: "fallback", nodeType: "set_node", status: "success", durationMs: 0, errorCategory: null }
      ],
      toolCalls: [tool("search", { q: "invoice" }), tool("search", { q: "invoice 2" })],
      modelCalls: [{ nodeId: "agent", iteration: 1, providerId: "anthropic", model: "claude-x", inputTokens: 150, outputTokens: 30, costUsd: 0.0003, latencyMs: 700 }],
      guard: [{ nodeId: "agent", placement: "pre_model", channel: "prompt", detectorId: "pii", effectiveAction: "block", shadow: false }, { nodeId: "agent", placement: "tool_args", channel: "tool", detectorId: "secrets", effectiveAction: "block", shadow: false }],
      totals: { inputTokens: 150, outputTokens: 30, totalTokens: 180, costUsd: 0.0003, durationMs: 1300, modelCalls: 1, toolCalls: 2 }
    });
    const diff = diffRunFacts(facts(), candidate, { ignorePaths: ["meta.id"] });
    expect(diff.status).toEqual({ baseline: "success", candidate: "error", changed: true, regression: true });
    expect(diff.output.equal).toBe(false);
    expect(diff.output.ignored).toBe(1);
    expect(diff.output.changes.map((change) => change.path)).toEqual(["answer"]);
    expect(diff.toolCalls.steps.map((step) => step.kind)).toEqual(["matched", "deleted", "inserted"]);
    expect(diff.toolCalls.countDelta).toEqual([
      { server: "mcp_docs", tool: "search", baseline: 1, candidate: 2 },
      { server: "mcp_docs", tool: "send_invoice", baseline: 1, candidate: 0 }
    ]);
    expect(diff.path).toEqual({ added: ["fallback"], removed: ["slack"], statusChanges: [{ nodeId: "agent", baseline: "success", candidate: "error" }] });
    expect(diff.models.changes).toEqual([{ nodeId: "agent", baseline: "openai:gpt-4o-mini", candidate: "anthropic:claude-x" }]);
    expect(diff.totals.tokens).toEqual({ baseline: 120, candidate: 180, delta: 60, pct: 50 });
    expect(diff.totals.costUsd.delta).toBeCloseTo(0.0002, 8);
    expect(diff.totals.latencyMs).toMatchObject({ baseline: 900, candidate: 1300, delta: 400 });
    expect(diff.guard.added).toEqual([expect.objectContaining({ detectorId: "secrets", effectiveAction: "block" })]);
    expect(diff.guard.changed).toEqual([{ baseline: expect.objectContaining({ effectiveAction: "mask" }), candidate: expect.objectContaining({ effectiveAction: "block" }) }]);
    expect(diff.guard.removed).toEqual([]);
    const judged = judgeReplayDiff(diff);
    expect(judged.verdict).toBe("fail");
    expect(judged.reasons).toHaveLength(2);
  });

  it("ignores volatile fields by default and passes health warnings through", () => {
    const baseline = facts({ output: { answer: "ok", _telemetry: { latencyMs: 10 } } });
    const candidate = facts({ output: { answer: "ok", _telemetry: { latencyMs: 99 } } });
    const diff = diffRunFacts(baseline, candidate, { health: [{ kind: "unrecorded_stub", nodeId: "slack", message: "stubbed", blocking: false }] });
    expect(diff.output.equal).toBe(true);
    expect(diff.output.ignorePaths).toEqual(DEFAULT_REPLAY_IGNORE_PATHS);
    expect(diff.health).toHaveLength(1);
  });

  it("does not call a newly successful run a regression", () => {
    expect(diffRunFacts(facts({ status: "error" }), facts()).status.regression).toBe(false);
    expect(diffRunFacts(facts(), facts({ status: "partial" })).status.regression).toBe(true);
  });
});
