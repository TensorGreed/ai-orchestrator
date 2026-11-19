import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import { nodeDefinitions, type Workflow, type WorkflowEdge, type WorkflowExecutionState, type WorkflowNode, type WorkflowExecutionResult } from "@ai-orchestrator/shared";
import { executeWorkflow, resumeWorkflowExecution, type WorkflowExecutionDependencies } from "./executor";
import { IN_PROCESS_CODE_SANDBOX } from "./code-sandbox";
import { validateWorkflowGraph } from "./validation";

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
function node(id: string, type: string, config: Record<string, unknown>): WorkflowNode {
  position += 100;
  return { id, type, name: id, position: { x: position, y: 0 }, config } as WorkflowNode;
}

function chain(nodes: WorkflowNode[], extraEdges: WorkflowEdge[] = []): Workflow {
  const edges: WorkflowEdge[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    edges.push({ id: `e${index}`, source: nodes[index - 1].id, target: nodes[index].id });
  }
  return { id: "wf-items", name: "Items", schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges: [...edges, ...extraEdges] };
}

function outputOf(result: WorkflowExecutionResult, nodeId: string): Record<string, unknown> {
  const entries = result.nodeResults.filter((entry) => entry.nodeId === nodeId);
  const last = entries[entries.length - 1];
  if (!last) throw new Error(`no result for ${nodeId}`);
  return last.output as Record<string, unknown>;
}

function errorOf(result: WorkflowExecutionResult, nodeId: string): string {
  return result.nodeResults.find((entry) => entry.nodeId === nodeId && entry.status === "error")?.error ?? "";
}

const PRODUCTS = [
  { name: "pen", price: 10 },
  { name: "lamp", price: 30 },
  { name: "desk", price: 50 }
];

/** A Set node that outputs fixed values (each a JSON-typed field). */
function source(values: Record<string, unknown>, id = "src"): WorkflowNode {
  return node(id, "set_node", {
    assignments: Object.entries(values).map(([key, value]) => ({ key, valueTemplate: JSON.stringify(value), type: "json" }))
  });
}

describe("Set node value types", () => {
  const values = { count: 3, price: 30, flag: true, tags: ["a", "b"], customer: { id: "c1" }, label: "x" };

  async function runSet(assignments: Array<Record<string, unknown>>) {
    const result = await executeWorkflow({ workflow: chain([source(values), node("set", "set_node", { assignments })]) }, deps());
    return result;
  }

  it("a field without a type keeps rendering expressions to text (saved workflows are unchanged)", async () => {
    const result = await runSet([
      { key: "expensive", valueTemplate: "{{ price > 25 }}" },
      { key: "count", valueTemplate: "{{count}}" },
      { key: "meta", valueTemplate: "{\"n\": {{count}}}" }
    ]);
    expect(result.status).toBe("success");
    expect(outputOf(result, "set")).toEqual({ expensive: "true", count: "3", meta: { n: 3 } });
  });

  it("auto keeps a single expression's type: boolean, number, list, object and text", async () => {
    const result = await runSet([
      { key: "expensive", valueTemplate: "{{ price > 25 }}", type: "auto" },
      { key: "cheap", valueTemplate: "{{ price < 25 }}", type: "auto" },
      { key: "count", valueTemplate: "{{count}}", type: "auto" },
      { key: "double", valueTemplate: "{{ count * 2 }}", type: "auto" },
      { key: "tags", valueTemplate: " {{tags}} ", type: "auto" },
      { key: "customer", valueTemplate: "{{customer}}", type: "auto" },
      { key: "label", valueTemplate: "{{label}}", type: "auto" },
      { key: "flag", valueTemplate: "{{flag}}", type: "auto" }
    ]);
    expect(result.status).toBe("success");
    expect(outputOf(result, "set")).toEqual({
      expensive: true,
      cheap: false,
      count: 3,
      double: 6,
      tags: ["a", "b"],
      customer: { id: "c1" },
      label: "x",
      flag: true
    });
  });

  it("auto renders mixed text as text, parses a JSON object or list, and gives null for a missing value", async () => {
    const result = await runSet([
      { key: "greeting", valueTemplate: "Hello {{label}} ({{count}})", type: "auto" },
      { key: "meta", valueTemplate: "{\"n\": {{count}}}", type: "auto" },
      { key: "literal", valueTemplate: "42", type: "auto" },
      { key: "missing", valueTemplate: "{{nothing.here}}", type: "auto" }
    ]);
    expect(outputOf(result, "set")).toEqual({ greeting: "Hello x (3)", meta: { n: 3 }, literal: "42", missing: null });
  });

  it("converts to an explicit type", async () => {
    const result = await runSet([
      { key: "asText", valueTemplate: "{{count}}", type: "string" },
      { key: "objText", valueTemplate: "{{customer}}", type: "string" },
      { key: "asNumber", valueTemplate: " 42.5 ", type: "number" },
      { key: "fromExpr", valueTemplate: "{{count}}", type: "number" },
      { key: "yes", valueTemplate: "yes", type: "boolean" },
      { key: "off", valueTemplate: "FALSE", type: "boolean" },
      { key: "flag", valueTemplate: "{{flag}}", type: "boolean" },
      { key: "json", valueTemplate: "{\"a\": [1, 2]}", type: "json" },
      { key: "jsonExpr", valueTemplate: "{{tags}}", type: "json" },
      { key: "emptyNumber", valueTemplate: "{{nothing}}", type: "number" }
    ]);
    expect(result.status).toBe("success");
    expect(outputOf(result, "set")).toEqual({
      asText: "3",
      objText: "{\"id\":\"c1\"}",
      asNumber: 42.5,
      fromExpr: 3,
      yes: true,
      off: false,
      flag: true,
      json: { a: [1, 2] },
      jsonExpr: ["a", "b"],
      emptyNumber: null
    });
  });

  it("json parses text from one {{ }} and keeps other values as they are", async () => {
    const result = await runSet([
      { key: "fromText", valueTemplate: "{{label}}", type: "json" },
      { key: "obj", valueTemplate: "{{customer}}", type: "json" }
    ]);
    expect(result.status).toBe("error");
    expect(errorOf(result, "set")).toMatch(/'fromText'.*JSON/);
  });

  it("fails the node when a value cannot be converted, naming the field", async () => {
    const notNumber = await runSet([{ key: "total", valueTemplate: "{{label}}", type: "number" }]);
    expect(notNumber.status).toBe("error");
    expect(errorOf(notNumber, "set")).toMatch(/'total'.*number/);
    const notBoolean = await runSet([{ key: "ok", valueTemplate: "maybe", type: "boolean" }]);
    expect(errorOf(notBoolean, "set")).toMatch(/'ok'.*true or false/);
    const notJson = await runSet([{ key: "body", valueTemplate: "{not json", type: "json" }]);
    expect(errorOf(notJson, "set")).toMatch(/'body'.*JSON/);
  });

  it("new Set nodes start with typed (auto) fields", () => {
    const definition = nodeDefinitions.find((entry) => entry.type === "set_node");
    const assignments = (definition?.sampleConfig.assignments ?? []) as Array<Record<string, unknown>>;
    expect(assignments.length).toBeGreaterThan(0);
    expect(assignments.every((entry) => entry.type === "auto")).toBe(true);
  });

  it("validation reports an unknown value type as an unfinished setting", () => {
    const workflow = chain([source(values), node("set", "set_node", { assignments: [{ key: "a", valueTemplate: "1", type: "integer" }] })]);
    const issues = validateWorkflowGraph(workflow).issues.filter((issue) => issue.nodeId === "set");
    expect(issues.map((issue) => issue.code)).toContain("invalid_set_node_assignment_type");
  });
});

describe("Filter node items mode", () => {
  const priceAbove = (value: string) => [{ field: "price", operator: "gt", value }];

  it("keeps the matching items of the first list in its input", async () => {
    const result = await executeWorkflow(
      { workflow: chain([source({ products: PRODUCTS }), node("filter", "filter_node", { mode: "items", itemsFrom: "", conditions: priceAbove("25") })]) },
      deps()
    );
    expect(result.status).toBe("success");
    const output = outputOf(result, "filter");
    expect(output.items).toEqual([PRODUCTS[1], PRODUCTS[2]]);
    expect(output.count).toBe(2);
    expect(output.total).toBe(3);
    expect(output.rejected).toEqual([PRODUCTS[0]]);
    expect(output.items_from).toBe("products");
    expect(output._branchHandle).toBe("pass");
  });

  it("finds a list nested in a response body, or uses Items from", async () => {
    const nested = await executeWorkflow(
      {
        workflow: chain([
          source({ status: 200, body: { page: 1, items: PRODUCTS } }),
          node("filter", "filter_node", { mode: "items", conditions: priceAbove("40") })
        ])
      },
      deps()
    );
    expect(outputOf(nested, "filter")).toMatchObject({ items: [PRODUCTS[2]], items_from: "body.items" });

    const explicit = await executeWorkflow(
      {
        workflow: chain([
          source({ first: [{ price: 99 }], second: PRODUCTS }),
          node("filter", "filter_node", { mode: "items", itemsFrom: "{{ second }}", conditions: priceAbove("20") })
        ])
      },
      deps()
    );
    expect(outputOf(explicit, "filter")).toMatchObject({ items: [PRODUCTS[1], PRODUCTS[2]], items_from: "second" });
  });

  it("reads fields of each item, with {{item}} in condition values, OR and reject", async () => {
    const items = [
      { name: "a", price: 10, limit: 5 },
      { name: "b", price: 10, limit: 50 },
      { name: "c", status: "done", price: 0, limit: 0 }
    ];
    const result = await executeWorkflow(
      {
        workflow: chain([
          source({ items }),
          node("filter", "filter_node", {
            mode: "items",
            combineWith: "OR",
            passMode: "reject",
            conditions: [
              { field: "item.price", operator: "gt", value: "{{ item.limit }}" },
              { field: "status", operator: "eq", value: "done" }
            ]
          })
        ])
      },
      deps()
    );
    expect(outputOf(result, "filter").items).toEqual([items[1]]);
  });

  it("does not read a field the item lacks from the node's input", async () => {
    // The input's own `status` (like an HTTP response's) is not the item's.
    const result = await executeWorkflow(
      {
        workflow: chain([
          source({ status: 200, body: { items: [{ status: "active" }, { name: "b" }] } }),
          node("filter", "filter_node", { mode: "items", conditions: [{ field: "status", operator: "eq", value: "200" }] })
        ])
      },
      deps()
    );
    expect(outputOf(result, "filter")).toMatchObject({ items: [], rejected_count: 2 });
  });

  it("an item's fields never replace results or vars in a condition value", async () => {
    const items = [{ id: 1, results: "shadow", vars: "shadow" }, { id: 2, results: "shadow" }];
    const result = await executeWorkflow(
      {
        workflow: chain([
          source({ want: 2 }, "cfg"),
          source({ items }),
          node("filter", "filter_node", { mode: "items", conditions: [{ field: "id", operator: "eq", value: "{{results.cfg.want}}" }] })
        ])
      },
      deps()
    );
    expect(outputOf(result, "filter").items).toEqual([items[1]]);
  });

  it("inside a loop body, reads the loop's item variable outside the Filter's item", async () => {
    const workflow = loopWorkflow({ collectResults: true }, [
      node("bodyFilter", "filter_node", { mode: "items", itemsFrom: "product.tags", conditions: [{ field: "item", operator: "eq", value: "{{product.name}}" }] })
    ]);
    workflow.nodes[0] = source({ products: [{ name: "a", tags: ["a", "b"] }, { name: "c", tags: ["x"] }] });
    const result = await executeWorkflow({ workflow }, deps());
    expect(result.status).toBe("success");
    expect((outputOf(result, "loop").collected as Array<Record<string, unknown>>).map((pass) => pass.items)).toEqual([["a"], []]);
  });

  /** filter → Kept (pass) → kept, Rejected (filtered) → rejected, and an edge without a handle → plain. */
  function routedItems(threshold: string, values: Record<string, unknown> = { products: PRODUCTS }): Workflow {
    const workflow = chain([source(values), node("filter", "filter_node", { mode: "items", conditions: priceAbove(threshold) })]);
    workflow.nodes.push(node("kept", "noop_node", {}), node("rejected", "noop_node", {}), node("plain", "noop_node", {}));
    workflow.edges.push(
      { id: "p", source: "filter", sourceHandle: "pass", target: "kept" },
      { id: "f", source: "filter", sourceHandle: "filtered", target: "rejected" },
      { id: "n", source: "filter", target: "plain" }
    );
    return workflow;
  }
  const statusOf = (result: WorkflowExecutionResult, id: string) => result.nodeResults.find((entry) => entry.nodeId === id)?.status;

  it("runs Kept with the kept items and Rejected with the rejected items", async () => {
    const result = await executeWorkflow({ workflow: routedItems("25") }, deps());
    expect(result.status).toBe("success");
    expect(outputOf(result, "kept")).toMatchObject({ items: [PRODUCTS[1], PRODUCTS[2]], count: 2 });
    expect(outputOf(result, "rejected")).toMatchObject({ items: [PRODUCTS[0]], count: 1, total: 3 });
    expect(outputOf(result, "plain")).toMatchObject({ items: [PRODUCTS[1], PRODUCTS[2]], rejected: [PRODUCTS[0]] });
  });

  it("runs only Rejected when no item matches, only Kept when all match, and neither for an empty list", async () => {
    const none = await executeWorkflow({ workflow: routedItems("500") }, deps());
    expect(outputOf(none, "filter")).toMatchObject({ items: [], count: 0, total: 3 });
    expect([statusOf(none, "kept"), statusOf(none, "rejected"), statusOf(none, "plain")]).toEqual(["skipped", "success", "success"]);
    const all = await executeWorkflow({ workflow: routedItems("1") }, deps());
    expect([statusOf(all, "kept"), statusOf(all, "rejected")]).toEqual(["success", "skipped"]);
    const empty = await executeWorkflow({ workflow: routedItems("1", { products: [] }) }, deps());
    expect([statusOf(empty, "kept"), statusOf(empty, "rejected"), statusOf(empty, "plain")]).toEqual(["skipped", "skipped", "success"]);
  });

  it("gate mode: Pass and Stopped route the whole input, and an edge without a handle always runs (as before)", async () => {
    const gate = (status: string) => {
      const workflow = chain([source({ status }), node("filter", "filter_node", { conditions: [{ field: "status", operator: "eq", value: "active" }] })]);
      workflow.nodes.push(node("pass", "noop_node", {}), node("stopped", "noop_node", {}), node("plain", "noop_node", {}));
      workflow.edges.push(
        { id: "p", source: "filter", sourceHandle: "pass", target: "pass" },
        { id: "f", source: "filter", sourceHandle: "filtered", target: "stopped" },
        { id: "n", source: "filter", target: "plain" }
      );
      return workflow;
    };
    const passed = await executeWorkflow({ workflow: gate("active") }, deps());
    expect([statusOf(passed, "pass"), statusOf(passed, "stopped"), statusOf(passed, "plain")]).toEqual(["success", "skipped", "success"]);
    const stopped = await executeWorkflow({ workflow: gate("closed") }, deps());
    expect([statusOf(stopped, "pass"), statusOf(stopped, "stopped"), statusOf(stopped, "plain")]).toEqual(["skipped", "success", "success"]);
    expect(outputOf(stopped, "stopped")).toMatchObject({ status: "closed", passed: false });
  });

  it("a gate Filter after an items Filter passes on its whole input from Stopped", async () => {
    const workflow = chain([
      source({ products: PRODUCTS }),
      node("filter", "filter_node", { mode: "items", conditions: priceAbove("25") }),
      node("gate", "filter_node", { conditions: [{ field: "count", operator: "gt", value: "5" }] })
    ]);
    workflow.nodes.push(node("stopped", "noop_node", {}));
    workflow.edges.push({ id: "f", source: "gate", sourceHandle: "filtered", target: "stopped" });
    const result = await executeWorkflow({ workflow }, deps());
    expect(result.status).toBe("success");
    expect(outputOf(result, "stopped")).toMatchObject({ items: [PRODUCTS[1], PRODUCTS[2]], rejected: [PRODUCTS[0]], passed: false });
  });

  it("a node reached by an edge without a handle runs even when Rejected also reaches it", async () => {
    // filter -(no handle)-> a -> joined, filter -Rejected-> b -> joined; every item matches, so Rejected does not run.
    const workflow = routedItems("1");
    workflow.nodes.push(node("joined", "noop_node", {}));
    workflow.edges.push({ id: "j1", source: "plain", target: "joined" }, { id: "j2", source: "rejected", target: "joined" });
    const result = await executeWorkflow({ workflow }, deps());
    expect([statusOf(result, "rejected"), statusOf(result, "plain"), statusOf(result, "joined")]).toEqual(["skipped", "success", "success"]);
  });

  it("inside a Loop body a Filter's outputs do not route: the nodes after both run", async () => {
    const workflow = loopWorkflow({ collectResults: true }, [
      node("bodyFilter", "filter_node", { conditions: [{ field: "product.price", operator: "gt", value: "25" }] })
    ]);
    workflow.nodes.push(node("pass", "noop_node", {}), node("stopped", "noop_node", {}));
    workflow.edges.push(
      { id: "p", source: "bodyFilter", sourceHandle: "pass", target: "pass" },
      { id: "f", source: "bodyFilter", sourceHandle: "filtered", target: "stopped" }
    );
    const result = await executeWorkflow({ workflow }, deps());
    expect(result.status).toBe("success");
    expect([statusOf(result, "pass"), statusOf(result, "stopped")]).toEqual(["success", "success"]);
  });

  it("filters an input without a list as one item, and fails when Items from is not a list", async () => {
    const one = await executeWorkflow(
      { workflow: chain([source({ name: "solo", price: 5 }), node("filter", "filter_node", { mode: "items", conditions: priceAbove("1") })]) },
      deps()
    );
    expect(outputOf(one, "filter")).toMatchObject({ items: [{ name: "solo", price: 5 }], count: 1, total: 1, items_from: "" });
    const none = await executeWorkflow(
      { workflow: chain([source({ name: "solo", price: 5 }), node("filter", "filter_node", { mode: "items", conditions: priceAbove("10") })]) },
      deps()
    );
    expect(outputOf(none, "filter")).toMatchObject({ items: [], count: 0, rejected_count: 1 });

    const notList = await executeWorkflow(
      { workflow: chain([source({ name: "solo" }), node("filter", "filter_node", { mode: "items", itemsFrom: "name", conditions: priceAbove("1") })]) },
      deps()
    );
    expect(errorOf(notList, "filter")).toMatch(/'name' is not a list/);
  });

  it("a Filter without a mode stays a gate over the whole input", async () => {
    const result = await executeWorkflow(
      { workflow: chain([source({ products: PRODUCTS, status: "active" }), node("filter", "filter_node", { conditions: [{ field: "status", operator: "eq", value: "active" }] })]) },
      deps()
    );
    const output = outputOf(result, "filter");
    expect(output.passed).toBe(true);
    expect(output._branchHandle).toBe("pass");
    expect(output.products).toEqual(PRODUCTS);
    expect(output.items).toBeUndefined();
  });

  it("new Filter nodes start in items mode", () => {
    const definition = nodeDefinitions.find((entry) => entry.type === "filter_node");
    expect(definition?.sampleConfig.mode).toBe("items");
  });
});

/** src (products) → loop → body (Set per item) [→ more]. */
function loopWorkflow(loopConfig: Record<string, unknown>, bodies: WorkflowNode[] = [], after: WorkflowNode[] = []): Workflow {
  const nodes = [
    source({ products: PRODUCTS }),
    node("loop", "loop_node", { inputKey: "products", itemVariable: "product", ...loopConfig }),
    ...(bodies.length
      ? bodies
      : [node("body", "set_node", { assignments: [{ key: "name", valueTemplate: "{{product.name}}", type: "auto" }, { key: "pricey", valueTemplate: "{{ product.price > 25 }}", type: "auto" }] })]),
    ...after
  ];
  const bodyIds = nodes.slice(2, 2 + (bodies.length || 1)).map((entry) => entry.id);
  const edges: WorkflowEdge[] = [{ id: "e-src", source: "src", target: "loop" }, ...bodyIds.map((id) => ({ id: `e-${id}`, source: "loop", target: id }))];
  return { id: "wf-loop", name: "Loop", schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges };
}

describe("Loop collect results", () => {
  it("adds collected, one body output per pass", async () => {
    const result = await executeWorkflow({ workflow: loopWorkflow({ collectResults: true }) }, deps());
    expect(result.status).toBe("success");
    const output = outputOf(result, "loop");
    expect(output.count).toBe(3);
    expect(output.collected).toEqual([
      { name: "pen", pricey: false },
      { name: "lamp", pricey: true },
      { name: "desk", pricey: true }
    ]);
  });

  it("keys each pass by body node when the body has several nodes", async () => {
    const bodies = [
      node("a", "set_node", { assignments: [{ key: "n", valueTemplate: "{{product.name}}", type: "auto" }] }),
      node("b", "set_node", { assignments: [{ key: "p", valueTemplate: "{{product.price}}", type: "auto" }] })
    ];
    const result = await executeWorkflow({ workflow: loopWorkflow({ collectResults: true }, bodies) }, deps());
    expect((outputOf(result, "loop").collected as unknown[])[1]).toEqual({ a: { n: "lamp" }, b: { p: 30 } });
  });

  it("a Loop without collectResults keeps its old output", async () => {
    const result = await executeWorkflow({ workflow: loopWorkflow({}) }, deps());
    const output = outputOf(result, "loop");
    expect(Object.keys(output).sort()).toEqual(["count", "items"]);
  });

  it("new Loop nodes collect results", () => {
    expect(nodeDefinitions.find((entry) => entry.type === "loop_node")?.sampleConfig.collectResults).toBe(true);
  });
});

describe("Merge collect loop passes", () => {
  function collectWorkflow(): Workflow {
    const workflow = loopWorkflow({}, [], [node("merge", "merge_node", { mode: "collect_loop_passes" })]);
    workflow.edges.push({ id: "e-merge", source: "body", target: "merge" });
    return workflow;
  }

  it("gathers every pass of the body node connected into it", async () => {
    const result = await executeWorkflow({ workflow: collectWorkflow() }, deps());
    expect(result.status).toBe("success");
    const output = outputOf(result, "merge");
    expect(output.items).toEqual([
      { name: "pen", pricey: false },
      { name: "lamp", pricey: true },
      { name: "desk", pricey: true }
    ]);
    expect(output.count).toBe(3);
  });

  it("adds a parent outside a loop body as one entry", async () => {
    const workflow = collectWorkflow();
    workflow.nodes.push(node("extra", "set_node", { assignments: [{ key: "note", valueTemplate: "after", type: "auto" }] }));
    workflow.edges.push({ id: "e-extra", source: "src", target: "extra" }, { id: "e-extra-merge", source: "extra", target: "merge" });
    const result = await executeWorkflow({ workflow }, deps());
    const items = outputOf(result, "merge").items as unknown[];
    expect(items).toHaveLength(4);
    expect(items).toContainEqual({ note: "after" });
  });

  it("collects every pass when the run resumes after an approval between the loop and the Merge", async () => {
    const workflow = collectWorkflow();
    workflow.nodes.push(node("ask", "human_approval", { approvalMessage: "ok?", timeoutMinutes: 30 }));
    workflow.edges.push({ id: "e-ask", source: "body", target: "ask" }, { id: "e-ask-merge", source: "ask", target: "merge" });
    const paused: WorkflowExecutionState[] = [];
    const pausingDeps = { ...deps(), persistPausedExecution: async (entry: { state: WorkflowExecutionState }) => void paused.push(entry.state) };
    const first = await executeWorkflow({ workflow, executionId: "items-resume" }, pausingDeps);
    expect(first.status).toBe("waiting_approval");
    // The state round-trips through storage as JSON.
    const state = JSON.parse(JSON.stringify(paused[0])) as WorkflowExecutionState;
    const resumed = await resumeWorkflowExecution({ executionId: "items-resume", state, decision: "approve", actedBy: "admin" }, deps());
    expect(resumed.status).toBe("success");
    const items = outputOf(resumed, "merge").items as unknown[];
    expect(items.slice(0, 3)).toEqual([
      { name: "pen", pricey: false },
      { name: "lamp", pricey: true },
      { name: "desk", pricey: true }
    ]);
    expect(items).toHaveLength(4);
  });

  it("is valid with one incoming edge", () => {
    const codes = validateWorkflowGraph(collectWorkflow()).issues.map((issue) => issue.code);
    expect(codes).not.toContain("merge_requires_multiple_parents");
    expect(codes).not.toContain("invalid_merge_mode");
    expect(codes).not.toContain("merge_collect_without_loop_body");
  });

  it("warns when no node connected into it runs inside a loop", () => {
    const workflow = chain([source({ a: 1 }), node("merge", "merge_node", { mode: "collect_loop_passes" })]);
    const issue = validateWorkflowGraph(workflow).issues.find((entry) => entry.code === "merge_collect_without_loop_body");
    expect(issue?.severity).toBe("warning");
  });
});
