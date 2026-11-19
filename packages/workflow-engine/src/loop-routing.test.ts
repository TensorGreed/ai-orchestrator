import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import { nodeDefinitions, type Workflow, type WorkflowEdge, type WorkflowExecutionResult, type WorkflowExecutionState, type WorkflowNode } from "@ai-orchestrator/shared";
import { executeWorkflow, resumeWorkflowExecution, type WorkflowExecutionDependencies } from "./executor";
import { IN_PROCESS_CODE_SANDBOX } from "./code-sandbox";
import { validateWorkflowGraph } from "./validation";
import { loopBodyOf } from "./loop-body";

function deps(): WorkflowExecutionDependencies {
  return {
    providerRegistry: new ProviderRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    codeSandbox: IN_PROCESS_CODE_SANDBOX
  };
}

let position = 0;
function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  position += 100;
  return { id, type, name: id, position: { x: position, y: 0 }, config } as WorkflowNode;
}

/** A Set node with one field of type `auto`. */
function set(id: string, key: string, template: string, extra: Record<string, unknown> = {}): WorkflowNode {
  return node(id, "set_node", { assignments: [{ key, valueTemplate: template, type: "auto" }], ...extra });
}

function edge(source: string, target: string, sourceHandle?: string): WorkflowEdge {
  return { id: `${source}-${sourceHandle ?? "out"}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) };
}

function flow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return { id: "wf-loop-routing", name: "Loop routing", schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges };
}

function results(result: WorkflowExecutionResult, nodeId: string) {
  return result.nodeResults.filter((entry) => entry.nodeId === nodeId);
}

function statuses(result: WorkflowExecutionResult, nodeId: string): string[] {
  return results(result, nodeId).map((entry) => entry.status);
}

function outputOf(result: WorkflowExecutionResult, nodeId: string): Record<string, unknown> {
  const entries = results(result, nodeId);
  const last = entries[entries.length - 1];
  if (!last) throw new Error(`no result for ${nodeId}`);
  return last.output as Record<string, unknown>;
}

/** src (xs = [1, 2, 3]) → loop → if (x > 1) → big (true) / small (false). */
function ifFlow(loopConfig: Record<string, unknown>, after: { nodes?: WorkflowNode[]; edges?: WorkflowEdge[] } = {}): Workflow {
  return flow(
    [
      node("src", "set_node", { assignments: [{ key: "xs", valueTemplate: "[1,2,3]", type: "json" }] }),
      node("loop", "loop_node", { inputKey: "xs", itemVariable: "x", ...loopConfig }),
      node("if", "if_node", { condition: "{{x}} > 1" }),
      set("big", "big", "{{x}}"),
      set("small", "small", "{{x}}"),
      ...(after.nodes ?? [])
    ],
    [edge("src", "loop"), edge("loop", "if"), edge("if", "big", "true"), edge("if", "small", "false"), ...(after.edges ?? [])]
  );
}

describe("Loop without branch routing (saved before the setting existed)", () => {
  it("runs only the IF per pass; the nodes after both of its outputs run once, after the loop", async () => {
    const result = await executeWorkflow({ workflow: ifFlow({}) }, deps());
    expect(result.status).toBe("success");
    expect(statuses(result, "if")).toEqual(["success", "success", "success"]);
    // Every branch runs, once, with the last pass.
    expect(statuses(result, "big")).toEqual(["success"]);
    expect(statuses(result, "small")).toEqual(["success"]);
    const passes = outputOf(result, "loop").items as Array<{ outputs: Record<string, unknown> }>;
    expect(passes.map((pass) => Object.keys(pass.outputs))).toEqual([["if"], ["if"], ["if"]]);
  });

  it("fails the loop on a body node's failure even when its On Error is Execute Fallback Branch", async () => {
    const workflow = flow(
      [
        node("src", "set_node", { assignments: [{ key: "xs", valueTemplate: '["1","bad"]', type: "json" }] }),
        node("loop", "loop_node", { inputKey: "xs", itemVariable: "x" }),
        node("num", "set_node", { assignments: [{ key: "n", valueTemplate: "{{x}}", type: "number" }], onError: "branch" }),
        set("fallback", "fixed", "{{x}}")
      ],
      [edge("src", "loop"), edge("loop", "num"), edge("num", "fallback", "error")]
    );
    const result = await executeWorkflow({ workflow }, deps());
    expect(result.status).toBe("error");
    expect(result.error).toContain("Loop node 'loop' failed at iteration 1 on child 'num'");
  });

  it("fails the loop on a Human Approval in the body instead of going on with nobody asked", async () => {
    const workflow = flow(
      [
        node("src", "set_node", { assignments: [{ key: "xs", valueTemplate: "[1]", type: "json" }] }),
        node("loop", "loop_node", { inputKey: "xs", itemVariable: "x" }),
        node("ask", "human_approval", { approvalMessage: "ok?", timeoutMinutes: 30 })
      ],
      [edge("src", "loop"), edge("loop", "ask")]
    );
    const result = await executeWorkflow({ workflow }, deps());
    expect(result.status).toBe("error");
    expect(result.error).toContain("Approvals cannot pause inside a Loop body: 'ask' is a Human Approval node");
    const issue = validateWorkflowGraph(workflow).issues.find((entry) => entry.code === "human_approval_in_loop");
    expect(issue?.severity).toBe("warning");
  });

  it("is what a Loop without routeBranches does; new Loop nodes route branches", () => {
    expect(nodeDefinitions.find((entry) => entry.type === "loop_node")?.sampleConfig.routeBranches).toBe(true);
  });
});

describe("Loop with branch routing", () => {
  it("runs only the taken IF output on each pass", async () => {
    const result = await executeWorkflow({ workflow: ifFlow({ routeBranches: true, collectResults: true }) }, deps());
    expect(result.status).toBe("success");
    expect(statuses(result, "if")).toEqual(["success", "success", "success"]);
    expect(statuses(result, "big")).toEqual(["success", "success"]);
    expect(statuses(result, "small")).toEqual(["success"]);
    expect(results(result, "big").map((entry) => (entry.output as Record<string, unknown>).big)).toEqual([2, 3]);
    expect(outputOf(result, "small").small).toBe(1);
    const loop = outputOf(result, "loop");
    const passes = loop.items as Array<{ outputs: Record<string, unknown> }>;
    expect(passes.map((pass) => Object.keys(pass.outputs).sort())).toEqual([["if", "small"], ["big", "if"], ["big", "if"]]);
    // collected: the body's last nodes, by id.
    expect(loop.collected).toEqual([{ small: expect.objectContaining({ small: 1 }) }, { big: expect.objectContaining({ big: 2 }) }, { big: expect.objectContaining({ big: 3 }) }]);
  });

  it("routes a Switch per pass", async () => {
    const workflow = flow(
      [
        node("src", "set_node", { assignments: [{ key: "xs", valueTemplate: '["a","b","c","a"]', type: "json" }] }),
        node("loop", "loop_node", { inputKey: "xs", itemVariable: "x", routeBranches: true }),
        node("switch", "switch_node", { switchValue: "{{x}}", cases: [{ value: "a", label: "a" }, { value: "b", label: "b" }], defaultLabel: "default" }),
        set("on_a", "v", "{{x}}"),
        set("on_b", "v", "{{x}}"),
        set("other", "v", "{{x}}")
      ],
      [edge("src", "loop"), edge("loop", "switch"), edge("switch", "on_a", "a"), edge("switch", "on_b", "b"), edge("switch", "other", "default")]
    );
    const result = await executeWorkflow({ workflow }, deps());
    expect(result.status).toBe("success");
    expect(statuses(result, "on_a")).toEqual(["success", "success"]);
    expect(statuses(result, "on_b")).toEqual(["success"]);
    expect(statuses(result, "other")).toEqual(["success"]);
    expect(outputOf(result, "other").v).toBe("c");
  });

  it("routes a Filter's Kept and Rejected outputs per pass, in both modes", async () => {
    const workflow = flow(
      [
        node("src", "set_node", { assignments: [{ key: "orders", valueTemplate: '[{"lines":[{"qty":1},{"qty":5}]},{"lines":[{"qty":9}]},{"lines":[{"qty":0}]}]', type: "json" }] }),
        node("loop", "loop_node", { inputKey: "orders", itemVariable: "order", routeBranches: true }),
        node("filter", "filter_node", { mode: "items", itemsFrom: "order.lines", conditions: [{ field: "qty", operator: "gt", value: "2" }] }),
        set("kept", "n", "{{count}}"),
        set("rejected", "n", "{{count}}"),
        node("gate", "filter_node", { mode: "gate", conditions: [{ field: "order.lines.0.qty", operator: "gt", value: "2" }] }),
        set("passed", "q", "{{order.lines.0.qty}}"),
        set("stopped", "q", "{{order.lines.0.qty}}")
      ],
      [
        edge("src", "loop"),
        edge("loop", "filter"),
        edge("filter", "kept", "pass"),
        edge("filter", "rejected", "filtered"),
        edge("loop", "gate"),
        edge("gate", "passed", "pass"),
        edge("gate", "stopped", "filtered")
      ]
    );
    const result = await executeWorkflow({ workflow }, deps());
    expect(result.status).toBe("success");
    // Order 1 has a kept and a rejected line, order 2 only kept, order 3 only rejected.
    expect(statuses(result, "kept")).toEqual(["success", "success"]);
    expect(statuses(result, "rejected")).toEqual(["success", "success"]);
    expect(results(result, "rejected").map((entry) => (entry.output as Record<string, unknown>).n)).toEqual([1, 1]);
    expect(results(result, "passed").map((entry) => (entry.output as Record<string, unknown>).q)).toEqual([9]);
    expect(results(result, "stopped").map((entry) => (entry.output as Record<string, unknown>).q)).toEqual([1, 0]);
  });

  it("does not run the branch nodes again after the loop; a node after them runs once, with their last pass", async () => {
    const workflow = ifFlow({ routeBranches: true }, { nodes: [set("after", "last", "{{big}}")], edges: [edge("big", "after")] });
    const result = await executeWorkflow({ workflow }, deps());
    expect(statuses(result, "big")).toEqual(["success", "success"]);
    expect(statuses(result, "after")).toEqual(["success"]);
    expect(outputOf(result, "after").last).toBe(3);
  });

  it("skips a branch node no pass took, and the nodes after it", async () => {
    const workflow = ifFlow({ routeBranches: true }, { nodes: [set("after", "last", "{{small}}")], edges: [edge("small", "after")] });
    workflow.nodes[0] = node("src", "set_node", { assignments: [{ key: "xs", valueTemplate: "[5,6]", type: "json" }] });
    const result = await executeWorkflow({ workflow }, deps());
    expect(result.status).toBe("success");
    expect(statuses(result, "small")).toEqual(["skipped"]);
    expect(statuses(result, "after")).toEqual(["skipped"]);
    expect(statuses(result, "big")).toEqual(["success", "success"]);
  });

  it("skips nothing after a loop with no items, as before", async () => {
    const workflow = ifFlow({ routeBranches: true }, { nodes: [set("after", "done", "yes")], edges: [edge("small", "after")] });
    workflow.nodes[0] = node("src", "set_node", { assignments: [{ key: "xs", valueTemplate: "[]", type: "json" }] });
    const result = await executeWorkflow({ workflow }, deps());
    expect(result.status).toBe("success");
    expect(statuses(result, "small")).toEqual([]);
    expect(statuses(result, "after")).toEqual(["success"]);
  });

  it("hides a node a pass skipped from the next nodes of that pass", async () => {
    // `report` runs in the body (after a second IF on the false output) and reads `results.big`: on the pass that took
    // `small` it must not see an earlier pass's `big`.
    const workflow = ifFlow(
      { routeBranches: true },
      { nodes: [node("check", "if_node", { condition: "true" }), set("report", "seen", "{{results.big.big}}")], edges: [edge("if", "check", "false"), edge("check", "report", "true")] }
    );
    workflow.nodes[0] = node("src", "set_node", { assignments: [{ key: "xs", valueTemplate: "[2,1]", type: "json" }] });
    const result = await executeWorkflow({ workflow }, deps());
    expect(result.status).toBe("success");
    expect(statuses(result, "report")).toEqual(["success"]);
    expect(outputOf(result, "report").seen).toBeNull();
    // After the loop, `results.big` is the last pass that ran it.
    expect(outputOf(result, "big").big).toBe(2);
  });

  it("gathers both branches' passes in pass order in a Merge that collects loop passes", async () => {
    const workflow = ifFlow(
      { routeBranches: true },
      { nodes: [node("merge", "merge_node", { mode: "collect_loop_passes" })], edges: [edge("big", "merge"), edge("small", "merge")] }
    );
    const result = await executeWorkflow({ workflow }, deps());
    expect(result.status).toBe("success");
    expect(statuses(result, "merge")).toEqual(["success"]);
    const merged = outputOf(result, "merge");
    expect(merged.count).toBe(3);
    expect((merged.items as Array<Record<string, unknown>>).map((entry) => entry.small ?? entry.big)).toEqual([1, 2, 3]);
    const codes = validateWorkflowGraph(workflow).issues.map((issue) => issue.code);
    expect(codes).not.toContain("merge_collect_without_loop_body");
  });

  it("routes a failing body node to its Error output for that pass and goes on", async () => {
    const workflow = flow(
      [
        node("src", "set_node", { assignments: [{ key: "xs", valueTemplate: '["1","bad","3"]', type: "json" }] }),
        node("loop", "loop_node", { inputKey: "xs", itemVariable: "x", routeBranches: true, collectResults: true }),
        node("num", "set_node", { assignments: [{ key: "n", valueTemplate: "{{x}}", type: "number" }], onError: "branch" }),
        set("fallback", "fixed", "{{x}}: {{error}}"),
        set("double", "d", "{{ n * 2 }}")
      ],
      [edge("src", "loop"), edge("loop", "num"), edge("num", "fallback", "error"), edge("num", "double")]
    );
    const result = await executeWorkflow({ workflow }, deps());
    // A handled failure makes the run partial, as at the top level.
    expect(result.status).toBe("partial");
    expect(statuses(result, "num")).toEqual(["success", "error", "success"]);
    expect(statuses(result, "fallback")).toEqual(["success"]);
    expect(String(outputOf(result, "fallback").fixed)).toMatch(/^bad: /);
    expect(results(result, "double").map((entry) => (entry.output as Record<string, unknown>).d)).toEqual([2, 6]);
    expect(outputOf(result, "loop").count).toBe(3);
  });

  it("continues a pass past a body node set to Continue Anyway", async () => {
    const workflow = flow(
      [
        node("src", "set_node", { assignments: [{ key: "xs", valueTemplate: '["bad","2"]', type: "json" }] }),
        node("loop", "loop_node", { inputKey: "xs", itemVariable: "x", routeBranches: true }),
        node("num", "set_node", { assignments: [{ key: "n", valueTemplate: "{{x}}", type: "number" }], onError: "continue" })
      ],
      [edge("src", "loop"), edge("loop", "num")]
    );
    const result = await executeWorkflow({ workflow }, deps());
    expect(result.status).toBe("partial");
    expect(statuses(result, "num")).toEqual(["error", "success"]);
    const passes = outputOf(result, "loop").items as Array<{ outputs: Record<string, Record<string, unknown>> }>;
    expect(passes[0].outputs.num.error).toBeTruthy();
    expect(passes[1].outputs.num.n).toBe(2);
  });

  it("still fails the loop on a body node set to Stop Execution", async () => {
    const workflow = flow(
      [
        node("src", "set_node", { assignments: [{ key: "xs", valueTemplate: '["1","bad"]', type: "json" }] }),
        node("loop", "loop_node", { inputKey: "xs", itemVariable: "x", routeBranches: true }),
        node("num", "set_node", { assignments: [{ key: "n", valueTemplate: "{{x}}", type: "number" }] })
      ],
      [edge("src", "loop"), edge("loop", "num")]
    );
    const result = await executeWorkflow({ workflow }, deps());
    expect(result.status).toBe("error");
    expect(result.error).toContain("Loop node 'loop' failed at iteration 1 on child 'num'");
  });

  it("runs a Loop inside a Loop body, routing its own branches", async () => {
    const workflow = flow(
      [
        node("src", "set_node", { assignments: [{ key: "rows", valueTemplate: "[[1,2],[3]]", type: "json" }] }),
        node("outer", "loop_node", { inputKey: "rows", itemVariable: "row", routeBranches: true, collectResults: true }),
        node("inner", "loop_node", { inputKey: "row", itemVariable: "cell", routeBranches: true, collectResults: true }),
        node("odd", "if_node", { condition: "{{ cell % 2 === 1 }}" }),
        set("odd_cell", "odd", "{{cell}}"),
        set("even_cell", "even", "{{cell}}")
      ],
      [edge("src", "outer"), edge("outer", "inner"), edge("inner", "odd"), edge("odd", "odd_cell", "true"), edge("odd", "even_cell", "false")]
    );
    const result = await executeWorkflow({ workflow }, deps());
    expect(result.status).toBe("success");
    expect(statuses(result, "odd")).toEqual(["success", "success", "success"]);
    expect(results(result, "odd_cell").map((entry) => (entry.output as Record<string, unknown>).odd)).toEqual([1, 3]);
    expect(results(result, "even_cell").map((entry) => (entry.output as Record<string, unknown>).even)).toEqual([2]);
    const outer = outputOf(result, "outer");
    expect(outer.count).toBe(2);
    expect((outer.collected as Array<Record<string, unknown>>).map((entry) => entry.count)).toEqual([2, 1]);
  });

  it("runs a Loop inside the body of a Loop without branch routing", async () => {
    const workflow = flow(
      [
        node("src", "set_node", { assignments: [{ key: "rows", valueTemplate: "[[1,2],[3]]", type: "json" }] }),
        node("outer", "loop_node", { inputKey: "rows", itemVariable: "row" }),
        node("inner", "loop_node", { inputKey: "row", itemVariable: "cell" }),
        set("cell_value", "v", "{{cell}}")
      ],
      [edge("src", "outer"), edge("outer", "inner"), edge("inner", "cell_value")]
    );
    const result = await executeWorkflow({ workflow }, deps());
    expect(result.status).toBe("success");
    expect(results(result, "cell_value").map((entry) => (entry.output as Record<string, unknown>).v)).toEqual([1, 2, 3]);
  });

  it("does not ask for an approval on a branch no pass takes; on a taken branch the loop fails as before", async () => {
    const withGate = (xs: string) => {
      const workflow = ifFlow({ routeBranches: true }, { nodes: [node("ask", "human_approval", { approvalMessage: "ok?", timeoutMinutes: 30 })], edges: [edge("small", "ask")] });
      workflow.nodes[0] = node("src", "set_node", { assignments: [{ key: "xs", valueTemplate: xs, type: "json" }] });
      // `ask` follows a branch node; put it in the body by routing it from the IF.
      workflow.edges = workflow.edges.filter((entry) => entry.target !== "ask");
      workflow.edges.push(edge("if", "ask", "false"));
      return workflow;
    };
    const untaken = await executeWorkflow({ workflow: withGate("[5,6]") }, deps());
    expect(untaken.status).toBe("success");
    expect(statuses(untaken, "ask")).toEqual(["skipped"]);
    const taken = await executeWorkflow({ workflow: withGate("[5,1]") }, deps());
    expect(taken.status).toBe("error");
    expect(taken.error).toContain("Approvals cannot pause inside a Loop body");
  });

  it("flags an Approval Gate on a branch inside a routed Loop body", () => {
    const workflow = ifFlow({ routeBranches: true }, { nodes: [node("gate", "approval_gate", {})], edges: [edge("if", "gate", "true")] });
    expect(validateWorkflowGraph(workflow).issues.map((issue) => issue.code)).toContain("approval_gate_in_loop");
    const legacy = ifFlow({}, { nodes: [node("gate", "approval_gate", {})], edges: [edge("if", "gate", "true")] });
    expect(validateWorkflowGraph(legacy).issues.map((issue) => issue.code)).not.toContain("approval_gate_in_loop");
  });

  it("does not run body nodes again when the run resumes after an approval", async () => {
    // `ask` sits on a path of its own from src, so the run order can put it before the IF's branch nodes.
    const workflow = ifFlow(
      { routeBranches: true },
      { nodes: [node("ask", "human_approval", { approvalMessage: "ok?", timeoutMinutes: 30 }), set("done", "ok", "yes")], edges: [edge("src", "ask"), edge("ask", "done")] }
    );
    const paused: WorkflowExecutionState[] = [];
    const pausingDeps = { ...deps(), persistPausedExecution: async (entry: { state: WorkflowExecutionState }) => void paused.push(entry.state) };
    const first = await executeWorkflow({ workflow, executionId: "loop-resume" }, pausingDeps);
    expect(first.status).toBe("waiting_approval");
    const state = JSON.parse(JSON.stringify(paused[0])) as WorkflowExecutionState;
    // The run paused before reaching the branch nodes in its order: the resumed part walks past them.
    expect(state.nextNodeIndex).toBeLessThanOrEqual(state.nodeOrder.indexOf("big"));
    const resumed = await resumeWorkflowExecution({ executionId: "loop-resume", state, decision: "approve", actedBy: "admin" }, deps());
    expect(resumed.status).toBe("success");
    expect(statuses(resumed, "big")).toEqual(["success", "success"]);
    expect(statuses(resumed, "small")).toEqual(["success"]);
    expect(statuses(resumed, "done")).toEqual(["success"]);
  });
});

describe("loopBodyOf", () => {
  it("is the Loop's direct children without branch routing", () => {
    expect(loopBodyOf(ifFlow({}), "loop").nodeIds).toEqual(["if"]);
  });

  it("adds the nodes on a body IF's outputs with branch routing, and only those whose parents are all in the body", () => {
    const workflow = ifFlow({ routeBranches: true }, { nodes: [set("outside", "o", "1"), set("joined", "j", "1")], edges: [edge("src", "outside"), edge("outside", "joined"), edge("if", "joined", "true")] });
    const body = loopBodyOf(workflow, "loop");
    expect([...body.nodeIds].sort()).toEqual(["big", "if", "small"]);
    expect([...body.leaves].sort()).toEqual(["big", "small"]);
  });
});
