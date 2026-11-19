import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import {
  resolvePendingApproval,
  type ApprovalDecisionValue,
  type ReplayRecordedNode,
  type ReplayRecordedRun,
  type Workflow,
  type WorkflowEdge,
  type WorkflowExecutionResult,
  type WorkflowExecutionState,
  type WorkflowNode
} from "@ai-orchestrator/shared";
import { executeWorkflow, resumeWorkflowExecution, type WorkflowExecutionDependencies } from "./executor";
import { IN_PROCESS_CODE_SANDBOX } from "./code-sandbox";
import { validateWorkflowGraph } from "./validation";
import { buildReplayPlan } from "./replay-plan";

/**
 * A Human Approval in a Loop body pauses the pass that reaches it; the run resumes in that pass, at that node, once
 * someone decides, then runs the rest of the pass and the later passes.
 */

function deps(paused: WorkflowExecutionState[]): WorkflowExecutionDependencies {
  return {
    providerRegistry: new ProviderRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    codeSandbox: IN_PROCESS_CODE_SANDBOX,
    // Stored as JSON, as the API does.
    persistPausedExecution: async (input) => {
      paused.push(JSON.parse(JSON.stringify(input.state)) as WorkflowExecutionState);
    }
  };
}

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, name: id, position: { x: 0, y: 0 }, config } as WorkflowNode;
}

function set(id: string, key: string, template: string): WorkflowNode {
  return node(id, "set_node", { assignments: [{ key, valueTemplate: template, type: "auto" }] });
}

function ask(id = "ask", extra: Record<string, unknown> = {}): WorkflowNode {
  return node(id, "human_approval", { approvalMessage: "Pay {{x}}?", timeoutMinutes: 30, ...extra });
}

function edge(source: string, target: string, sourceHandle?: string): WorkflowEdge {
  return { id: `${source}-${sourceHandle ?? "out"}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) };
}

function flow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return { id: "wf-loop-approval", name: "Loop approval", schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges };
}

function results(result: WorkflowExecutionResult, nodeId: string) {
  return result.nodeResults.filter((entry) => entry.nodeId === nodeId);
}

function statuses(result: WorkflowExecutionResult, nodeId: string): string[] {
  return results(result, nodeId).map((entry) => entry.status);
}

function lastOutput(result: WorkflowExecutionResult, nodeId: string): Record<string, unknown> {
  const entries = results(result, nodeId);
  return (entries[entries.length - 1]?.output ?? {}) as Record<string, unknown>;
}

/** Runs the workflow and answers each pause with the next decision; returns the final result and every pause. */
async function runWithDecisions(workflow: Workflow, decisions: ApprovalDecisionValue[], input?: Record<string, unknown>) {
  const paused: WorkflowExecutionState[] = [];
  const pauses: WorkflowExecutionResult[] = [];
  let result = await executeWorkflow({ workflow, executionId: "exec-loop-approval", ...(input ? { input } : {}) }, deps(paused));
  for (const decision of decisions) {
    if (result.status !== "waiting_approval") break;
    pauses.push(result);
    result = await resumeWorkflowExecution(
      { executionId: "exec-loop-approval", state: paused[paused.length - 1]!, decision, actedBy: "lead@example.com", ...(decision === "reject" ? { reason: "Not this one" } : {}) },
      deps(paused)
    );
  }
  return { result, pauses, paused };
}

/**
 * src (xs) → loop → prep and ask; ask → pay; ask's Error output → refused; pay → after. With routing and the
 * approval's On Error on its Error output, pay and refused are in the body; after runs once, after the loop.
 */
function payFlow(loopConfig: Record<string, unknown>, xs = "[1,2,3]", askConfig: Record<string, unknown> = { onError: "branch" }): Workflow {
  return flow(
    [
      node("src", "set_node", { assignments: [{ key: "xs", valueTemplate: xs, type: "json" }] }),
      node("loop", "loop_node", { inputKey: "xs", itemVariable: "x", collectResults: true, ...loopConfig }),
      set("prep", "amount", "{{x}}"),
      ask("ask", askConfig),
      set("pay", "paid", "{{results.prep.amount}}"),
      set("refused", "refused", "{{x}}"),
      set("after", "done", "{{results.loop.count}}")
    ],
    [
      edge("src", "loop"),
      edge("loop", "prep"),
      edge("loop", "ask"),
      edge("ask", "pay"),
      edge("ask", "refused", "error"),
      edge("pay", "after")
    ]
  );
}

describe("Human Approval in a Loop body that routes branches", () => {
  it("pauses once per pass and resumes at that pass: approve, reject, approve", async () => {
    const { result, pauses, paused } = await runWithDecisions(payFlow({ routeBranches: true }), ["approve", "reject", "approve"]);
    expect(pauses).toHaveLength(3);
    // Each pause is for the same node, with the item's message and the pass it is on.
    for (const [index, state] of paused.entries()) {
      const info = resolvePendingApproval(state);
      expect(info.nodeId).toBe("ask");
      expect(info.details?.message).toBe(`Pay ${index + 1}?`);
      expect(info.details?.loopPass).toEqual({ loopNodeId: "loop", pass: index + 1, of: 3 });
    }
    for (const [index, pause] of pauses.entries()) {
      const waiting = pause.nodeResults.filter((entry) => entry.status === "waiting_approval");
      expect(waiting.map((entry) => entry.nodeId)).toEqual(["ask"]);
      expect(waiting[0]!.loopPass).toEqual({ loopNodeId: "loop", pass: index + 1, of: 3 });
    }

    expect(result.status).toBe("partial");
    // Nothing ran twice: one prep per item, pay for the approved ones, the Error output for the rejected one.
    expect(results(result, "prep").map((entry) => (entry.output as Record<string, unknown>).amount)).toEqual([1, 2, 3]);
    expect(results(result, "pay").filter((entry) => entry.status === "success").map((entry) => (entry.output as Record<string, unknown>).paid)).toEqual([1, 3]);
    expect(results(result, "refused").filter((entry) => entry.status === "success").map((entry) => (entry.output as Record<string, unknown>).refused)).toEqual([2]);
    expect(statuses(result, "ask")).toEqual(["success", "error", "success"]);
    expect(results(result, "ask").map((entry) => entry.loopPass?.pass)).toEqual([1, 2, 3]);
    expect(results(result, "ask")[1]!.error).toBe("Not this one");
    // Every pass's result says which pass it is, as other body nodes' do (the canvas counts passes by it).
    expect(results(result, "ask").map((entry) => (entry.input as Record<string, unknown>)._loop_index)).toEqual([0, 1, 2]);
    expect((results(result, "ask")[1]!.input as Record<string, unknown>).decision).toBe("reject");
    expect(statuses(result, "after")).toEqual(["success"]);
    expect(lastOutput(result, "after").done).toBe(3);

    const loop = lastOutput(result, "loop");
    expect(loop.count).toBe(3);
    const collected = loop.collected as Array<Record<string, unknown> | null>;
    expect(collected.map((entry) => entry && ("pay" in entry ? (entry.pay as Record<string, unknown>).paid : (entry.refused as Record<string, unknown>).refused))).toEqual([1, 2, 3]);
    expect(statuses(result, "loop")).toEqual(["success"]);
  });

  it("stops the run on a rejection when the approval has no Error output, and no later pass runs", async () => {
    const { result, pauses } = await runWithDecisions(payFlow({ routeBranches: true }, "[1,2,3]", {}), ["approve", "reject"]);
    expect(pauses).toHaveLength(2);
    expect(result.status).toBe("error");
    expect(result.error).toContain("Not this one");
    expect(statuses(result, "prep").filter((status) => status === "success")).toHaveLength(2);
    // Without the Error output, pay is after the loop, so it never runs.
    expect(results(result, "pay").filter((entry) => entry.status === "success")).toHaveLength(0);
    expect(statuses(result, "after").filter((status) => status === "success")).toEqual([]);
  });

  it("treats a timeout as a rejection, as at the top level", async () => {
    const { result } = await runWithDecisions(payFlow({ routeBranches: true }, "[1]"), ["timeout"]);
    expect(result.status).toBe("partial");
    expect(statuses(result, "ask")).toEqual(["error"]);
    expect((results(result, "ask")[0]!.output as Record<string, unknown>).timedOut).toBe(true);
    expect(results(result, "refused").filter((entry) => entry.status === "success")).toHaveLength(1);
    // No pass ran pay, so what follows it after the loop is skipped.
    expect(statuses(result, "pay")).toEqual(["skipped"]);
    expect(statuses(result, "after")).toEqual(["skipped"]);
  });

  it("never continues past a rejection, even with Continue On Fail", async () => {
    const workflow = payFlow({ routeBranches: true }, "[1,2]", {});
    workflow.nodes = workflow.nodes.map((entry) => (entry.id === "ask" ? ({ ...entry, errorConfig: { continueOnFail: true } } as WorkflowNode) : entry));
    const { result, pauses } = await runWithDecisions(workflow, ["reject"]);
    expect(pauses).toHaveLength(1);
    expect(result.status).toBe("error");
    expect(results(result, "pay").filter((entry) => entry.status === "success")).toEqual([]);
  });

  it("asks only on the passes whose branch reaches the approval", async () => {
    const workflow = flow(
      [
        node("src", "set_node", { assignments: [{ key: "xs", valueTemplate: "[5,1,7,2]", type: "json" }] }),
        node("loop", "loop_node", { inputKey: "xs", itemVariable: "x", routeBranches: true }),
        node("if", "if_node", { condition: "{{x}} > 4" }),
        ask("ask", { onError: "branch" }),
        set("big", "big", "{{x}}"),
        set("no", "no", "{{x}}"),
        set("small", "small", "{{x}}")
      ],
      [edge("src", "loop"), edge("loop", "if"), edge("if", "ask", "true"), edge("ask", "big"), edge("ask", "no", "error"), edge("if", "small", "false")]
    );
    const { result, paused } = await runWithDecisions(workflow, ["approve", "approve"]);
    expect(paused.map((state) => resolvePendingApproval(state).details?.loopPass)).toEqual([
      { loopNodeId: "loop", pass: 1, of: 4 },
      { loopNodeId: "loop", pass: 3, of: 4 }
    ]);
    expect(result.status).toBe("success");
    expect(results(result, "big").map((entry) => (entry.output as Record<string, unknown>).big)).toEqual([5, 7]);
    expect(results(result, "small").map((entry) => (entry.output as Record<string, unknown>).small)).toEqual([1, 2]);
    expect(statuses(result, "if")).toEqual(["success", "success", "success", "success"]);
  });

  it("pauses in a Loop inside a Loop body and resumes both at their passes", async () => {
    const workflow = flow(
      [
        node("src", "set_node", { assignments: [{ key: "rows", valueTemplate: "[[1,2],[3]]", type: "json" }] }),
        node("outer", "loop_node", { inputKey: "rows", itemVariable: "row", routeBranches: true, collectResults: true }),
        node("inner", "loop_node", { inputKey: "row", itemVariable: "x", routeBranches: true, collectResults: true }),
        ask("ask", { onError: "branch" }),
        set("cell", "cell", "{{x}}"),
        set("no", "no", "{{x}}")
      ],
      [edge("src", "outer"), edge("outer", "inner"), edge("inner", "ask"), edge("ask", "cell"), edge("ask", "no", "error")]
    );
    const { result, paused } = await runWithDecisions(workflow, ["approve", "reject", "approve"]);
    expect(paused.map((state) => resolvePendingApproval(state).details?.message)).toEqual(["Pay 1?", "Pay 2?", "Pay 3?"]);
    expect(result.status).toBe("partial");
    expect(results(result, "cell").filter((entry) => entry.status === "success").map((entry) => (entry.output as Record<string, unknown>).cell)).toEqual([1, 3]);
    expect(results(result, "no").filter((entry) => entry.status === "success").map((entry) => (entry.output as Record<string, unknown>).no)).toEqual([2]);

    const all = await runWithDecisions(workflow, ["approve", "approve", "approve"]);
    expect(all.result.status).toBe("success");
    expect(results(all.result, "cell").map((entry) => (entry.output as Record<string, unknown>).cell)).toEqual([1, 2, 3]);
    expect(statuses(all.result, "inner")).toEqual(["success", "success"]);
    expect(statuses(all.result, "outer")).toEqual(["success"]);
    const outer = lastOutput(all.result, "outer");
    expect((outer.collected as Array<Record<string, unknown>>).map((entry) => entry.count)).toEqual([2, 1]);
  });

  it("settles the branches no pass took after a resumed Loop", async () => {
    const workflow = flow(
      [
        node("src", "set_node", { assignments: [{ key: "xs", valueTemplate: "[5,7]", type: "json" }] }),
        node("loop", "loop_node", { inputKey: "xs", itemVariable: "x", routeBranches: true }),
        node("if", "if_node", { condition: "{{x}} > 4" }),
        ask(),
        set("small", "small", "{{x}}"),
        set("later", "later", "{{results.small.small}}")
      ],
      [edge("src", "loop"), edge("loop", "if"), edge("if", "ask", "true"), edge("if", "small", "false"), edge("small", "later")]
    );
    const { result } = await runWithDecisions(workflow, ["approve", "approve"]);
    expect(result.status).toBe("success");
    expect(statuses(result, "small")).toEqual(["skipped"]);
    expect(statuses(result, "later")).toEqual(["skipped"]);
  });
});

describe("Human Approval in a Loop body without branch routing", () => {
  it("pauses once per pass; approvals let every pass run", async () => {
    const workflow = flow(
      [
        node("src", "set_node", { assignments: [{ key: "xs", valueTemplate: "[1,2,3]", type: "json" }] }),
        node("loop", "loop_node", { inputKey: "xs", itemVariable: "x", collectResults: true }),
        ask(),
        set("after", "done", "{{results.loop.count}}")
      ],
      [edge("src", "loop"), edge("loop", "ask"), edge("ask", "after")]
    );
    const { result, pauses } = await runWithDecisions(workflow, ["approve", "approve", "approve"]);
    expect(pauses).toHaveLength(3);
    expect(result.status).toBe("success");
    expect(statuses(result, "ask")).toEqual(["success", "success", "success"]);
    const collected = lastOutput(result, "loop").collected as Array<Record<string, unknown>>;
    expect(collected.map((entry) => entry.approved)).toEqual([true, true, true]);
    expect(lastOutput(result, "after").done).toBe(3);
  });

  it("fails the Loop on a rejection (a body node's On Error does not apply without routing)", async () => {
    const workflow = payFlow({}, "[1,2]");
    const { result } = await runWithDecisions(workflow, ["reject"]);
    expect(result.status).toBe("error");
    expect(result.error).toContain("Loop node 'loop' failed at iteration 0 on child 'ask': Not this one");
  });
});

describe("replay of a run that asked inside a Loop", () => {
  it("answers each pass's approval from the recording, without pausing", async () => {
    const workflow = payFlow({ routeBranches: true });
    const { result: live } = await runWithDecisions(workflow, ["approve", "reject", "approve"]);
    // As the API records a run: each node's finished results in order.
    const recorded: Record<string, ReplayRecordedNode> = {};
    const runs = new Map<string, ReplayRecordedRun[]>();
    for (const entry of live.nodeResults) {
      const run: ReplayRecordedRun = { status: entry.status, ...(entry.output !== undefined ? { output: entry.output } : {}), ...(entry.error ? { error: entry.error } : {}) };
      recorded[entry.nodeId] = { nodeId: entry.nodeId, nodeType: workflow.nodes.find((candidate) => candidate.id === entry.nodeId)!.type, ...run };
      if (run.status === "success" || run.status === "error") runs.set(entry.nodeId, [...(runs.get(entry.nodeId) ?? []), run]);
    }
    for (const [nodeId, list] of runs) if (list.length > 1) recorded[nodeId]!.runs = list;

    const paused: WorkflowExecutionState[] = [];
    const replayed = await executeWorkflow({ workflow, executionId: "exec-replay" }, { ...deps(paused), replayNodeHook: buildReplayPlan(workflow, recorded).hook });
    expect(paused).toHaveLength(0);
    expect(replayed.status).toBe("partial");
    expect(statuses(replayed, "ask")).toEqual(["success", "error", "success"]);
    expect(results(replayed, "pay").filter((entry) => entry.status === "success").map((entry) => (entry.output as Record<string, unknown>).paid)).toEqual([1, 3]);
    expect(results(replayed, "refused").filter((entry) => entry.status === "success").map((entry) => (entry.output as Record<string, unknown>).refused)).toEqual([2]);
  });
});

describe("validation", () => {
  it("no longer warns about a Human Approval in a Loop body", () => {
    const codes = validateWorkflowGraph(payFlow({ routeBranches: true })).issues.map((issue) => issue.code);
    expect(codes).not.toContain("human_approval_in_loop");
  });
});
