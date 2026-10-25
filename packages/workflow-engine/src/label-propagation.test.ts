import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime, type AgentSessionMemoryStore } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import {
  createDefaultGuardProfile,
  createDefaultGuardRegistry,
  hashGuardProfile,
  InMemoryTokenVaultStorage,
  parseGuardProfile,
  type GuardInput,
  type GuardProfileInput
} from "@ai-orchestrator/guard-sdk";
import { createDefaultMCPRegistry, type MCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import type { ChatMessage, DataLabels, Workflow, WorkflowEdge, WorkflowExecutionResult, WorkflowExecutionState, WorkflowNode } from "@ai-orchestrator/shared";
import { IN_PROCESS_CODE_SANDBOX } from "./code-sandbox";
import { executeWorkflow, outputLabelsOf, resumeWorkflowExecution, type WorkflowExecutionDependencies } from "./executor";
import { builtInGuardProfile, type GuardRunResolution, type GuardVerdictEvent, type ResolvedGuardProfile } from "./guard-runtime";

/**
 * Phase 16 — label propagation through the engine: templates and
 * expressions, branches, code nodes, loops, sub-workflows, approvals,
 * agents (memory, tool results, workers) and guard checks; and the
 * zero-config path, where nothing new is stored and no verdict changes.
 */

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "guard-sdk", "corpus");
const indirectCorpus = JSON.parse(readFileSync(join(corpusDir, "indirect-injection.json"), "utf8")) as { items: Array<{ id: string; content: string }> };
/** An indirect-injection corpus sample the direct-injection patterns do not catch. */
const INDIRECT_ONLY = indirectCorpus.items.find((item) => item.id === "ii-a01")!.content;
const EMAIL = "ana.lopez@example.org";
const SECRET = "sk-live-abcdefghijklmnopqrstuvwxyz123456";
const publicResolver = async () => ["93.184.215.14"];

function resolved(id: string, document: GuardProfileInput, version = 1): ResolvedGuardProfile {
  const profile = parseGuardProfile({ ...document, id });
  return { profileId: id, version, hash: hashGuardProfile(profile), name: profile.name, profile };
}

/** A detector that records the labels each check was given and finds nothing. */
function labelSpy() {
  const seen: Array<{ channel: string; labels: string[] }> = [];
  return {
    seen,
    detector: {
      id: "test.label-spy",
      tier: "rule" as const,
      description: "Records labels",
      channels: ["prompt", "tool_arguments", "tool_result", "final_output", "model_output"] as const,
      categories: [] as const,
      detect(input: GuardInput) {
        seen.push({ channel: input.channel, labels: [...(input.labels ?? [])] });
        return [];
      }
    }
  };
}

const spyChannels = (labels?: "propagated") =>
  ({
    id: "spy",
    name: "Spy",
    version: "1",
    ...(labels ? { labels } : {}),
    channels: Object.fromEntries(
      ["prompt", "tool_arguments", "tool_result", "final_output"].map((channel) => [channel, { detectors: [{ id: "test.label-spy", threshold: 0 }], defaultAction: { action: "allow" } }])
    )
  }) as GuardProfileInput;

const PROFILES: Record<string, ResolvedGuardProfile> = {
  default: builtInGuardProfile(),
  tracking: resolved("tracking", { ...createDefaultGuardProfile(), labels: "propagated" }),
  spy: resolved("spy", spyChannels()),
  "spy-propagated": resolved("spy-propagated", spyChannels("propagated"))
};

function guardDeps(stack: string[] = []) {
  const events: GuardVerdictEvent[] = [];
  const spy = labelSpy();
  const registry = createDefaultGuardRegistry({ resolver: publicResolver });
  registry.register(spy.detector as never);
  const profiles = stack.map((id) => PROFILES[id]!);
  const resolution: GuardRunResolution = {
    source: profiles.length ? "project" : "none",
    stack: profiles,
    chain: [{ level: "project", mode: profiles.length ? "override" : "inherit", profileId: profiles[0]?.profileId ?? null }]
  };
  return {
    events,
    spy,
    guard: {
      registry,
      resolveRun: () => resolution,
      loadProfile: (id: string) => PROFILES[id],
      vault: new InMemoryTokenVaultStorage(),
      onVerdict: (event: GuardVerdictEvent) => {
        events.push(event);
      }
    } satisfies WorkflowExecutionDependencies["guard"]
  };
}

function node(id: string, type: string, config: Record<string, unknown> = {}, name = id): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name, position: { x: 0, y: 0 }, config };
}

/** A Set node assigning each field from its template. */
function set(id: string, fields: Record<string, unknown>): WorkflowNode {
  const assignments = Object.entries(fields).map(([key, value]) => ({ key, valueTemplate: typeof value === "string" ? value : JSON.stringify(value) }));
  return node(id, "set_node", { assignments: assignments.length ? assignments : [{ key: "ok", valueTemplate: "1" }] });
}

function workflow(nodes: WorkflowNode[], edges: Array<Omit<WorkflowEdge, "id">>, extra: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-labels",
    name: "Labels",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes,
    edges: edges.map((edge, index) => ({ id: `e${index}`, ...edge })),
    ...extra
  };
}

function pageAdapter(page: () => unknown): MCPServerAdapter {
  return {
    definition: { id: "docs-mcp", label: "Docs", description: "Test pages", configSchema: {}, authSchema: {} },
    async discoverTools() {
      return [{ serverId: "docs-mcp", serverLabel: "Docs", name: "fetch_page", description: "Fetch a web page", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }];
    },
    async invokeTool() {
      return { ok: true, output: page() };
    }
  } as unknown as MCPServerAdapter;
}

class MemoryStore implements AgentSessionMemoryStore {
  readonly messages = new Map<string, ChatMessage[]>();
  readonly labels = new Map<string, DataLabels | null>();
  readonly saveCalls: number[] = [];
  async loadMessages(namespace: string, sessionId: string) {
    return structuredClone(this.messages.get(`${namespace}|${sessionId}`) ?? []);
  }
  async saveMessages(namespace: string, sessionId: string, messages: ChatMessage[], ...rest: Array<{ labels?: DataLabels } | undefined>) {
    this.saveCalls.push(rest.length);
    this.messages.set(`${namespace}|${sessionId}`, structuredClone(messages));
    const options = rest[0];
    if (options?.labels) this.labels.set(`${namespace}|${sessionId}`, options.labels);
  }
  async loadLabels(namespace: string, sessionId: string) {
    return this.labels.get(`${namespace}|${sessionId}`) ?? null;
  }
}

function deps(input: {
  provider?: LLMProviderAdapter;
  page?: () => unknown;
  guard?: WorkflowExecutionDependencies["guard"];
  paused?: WorkflowExecutionState[];
  memoryStore?: AgentSessionMemoryStore;
  workflows?: Workflow[];
} = {}): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  if (input.provider) providerRegistry.register(input.provider);
  const mcpRegistry = createDefaultMCPRegistry();
  mcpRegistry.register(pageAdapter(input.page ?? (() => ({ text: "A quiet page about gardening." }))));
  return {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry,
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    codeSandbox: IN_PROCESS_CODE_SANDBOX,
    ...(input.guard ? { guard: input.guard } : {}),
    ...(input.memoryStore ? { memoryStore: input.memoryStore } : {}),
    loadWorkflow: (id) => input.workflows?.find((entry) => entry.id === id),
    persistPausedExecution: async (paused) => {
      input.paused?.push(paused.state);
    }
  };
}

const resultOf = (result: WorkflowExecutionResult, id: string) => result.nodeResults.filter((entry) => entry.nodeId === id).at(-1);
const labelsOf = (result: WorkflowExecutionResult, id: string) => resultOf(result, id)?.labels;
const L = (provenance: string[], dataClasses: string[] = []) => ({ provenance, dataClasses, source: "propagated" });

/** in (webhook) → greet (set, reads the input) → out */
function simpleWorkflow(extraNodes: WorkflowNode[] = [], extraEdges: Array<Omit<WorkflowEdge, "id">> = []) {
  return workflow(
    [node("in", "webhook_input"), set("greet", { text: "Hello {{user_prompt}}" }), node("out", "output"), ...extraNodes],
    [{ source: "in", target: "greet" }, { source: "greet", target: "out" }, ...extraEdges]
  );
}

describe("zero-config path", () => {
  it("no guard, or the built-in default profile: same outputs and verdicts, no labels stored", async () => {
    const wf = workflow(
      [node("in", "webhook_input"), node("g", "guard", { profileId: "effective", inputField: "user_prompt" }), node("out", "output")],
      [{ source: "in", target: "g" }, { source: "g", sourceHandle: "pass", target: "out" }]
    );
    const payload = { webhookPayload: { user_prompt: `Key ${SECRET} and mail ${EMAIL}` } };
    const bare = await executeWorkflow({ workflow: wf, executionId: "z1", ...payload }, deps());
    const withDefault = guardDeps(["default"]);
    const defaulted = await executeWorkflow({ workflow: wf, executionId: "z2", ...payload }, deps({ guard: withDefault.guard }));
    for (const result of [bare, defaulted]) {
      expect(result.status).toBe("success");
      expect(result.nodeResults.every((entry) => entry.labels === undefined)).toBe(true);
      expect(JSON.stringify(result)).not.toContain('"labels"');
    }
    expect(JSON.stringify(resultOf(defaulted, "out")?.output)).toBe(JSON.stringify(resultOf(bare, "out")?.output));
    // The default profile redacts the credential and leaves the email, as it always has.
    expect(withDefault.events.map((event) => event.verdict.action)).toEqual(["redact"]);
    expect((resultOf(defaulted, "g")?.output as Record<string, unknown>).user_prompt).toContain("[REDACTED:credential]");
  });

  it("a paused run under the default profile stores no labels in its state", async () => {
    const paused: WorkflowExecutionState[] = [];
    const wf = simpleWorkflow([node("ask", "human_approval", { approvalMessage: "ok?", timeoutMinutes: 30 })], [{ source: "greet", target: "ask" }]);
    const { guard } = guardDeps(["default"]);
    const result = await executeWorkflow({ workflow: wf, executionId: "z3", webhookPayload: { user_prompt: "x" } }, deps({ guard, paused }));
    expect(result.status).toBe("waiting_approval");
    expect(paused[0]!.dataLabels).toBeUndefined();
  });

  it("agents under the default profile write memory without labels and checks keep their fixed labels", async () => {
    const memory = new MemoryStore();
    const provider = new ToolThenAnswer("docs-mcp__fetch_page", { url: "https://example.com" });
    const { guard } = guardDeps(["default"]);
    const result = await executeWorkflow(
      { workflow: agentWorkflow(), executionId: "z4", webhookPayload: { user_prompt: "Summarise", session_id: "s1" } },
      deps({ provider, guard, memoryStore: memory })
    );
    expect(result.status).toBe("success");
    expect(memory.saveCalls).toEqual([0]);
    expect(memory.labels.size).toBe(0);
    expect(labelsOf(result, "agent")).toBeUndefined();
  });
});

describe("propagation through templates and the DAG", () => {
  it("tracks provenance and data classes on runs whose profile asks for it", async () => {
    const { guard } = guardDeps(["tracking"]);
    const result = await executeWorkflow({ workflow: simpleWorkflow(), executionId: "t1", webhookPayload: { user_prompt: `mail ${EMAIL}` } }, deps({ guard }));
    expect(result.status).toBe("success");
    expect(labelsOf(result, "in")).toEqual(L(["untrusted_external"], ["email"]));
    expect(labelsOf(result, "greet")).toEqual(L(["untrusted_external"], ["email"]));
    expect(labelsOf(result, "out")).toEqual(L(["untrusted_external"], ["email"]));
  });

  it("the run's input labels come from the caller (an editor run is user input)", async () => {
    const { guard } = guardDeps(["tracking"]);
    const result = await executeWorkflow(
      { workflow: simpleWorkflow(), executionId: "t2", webhookPayload: { user_prompt: "hi" }, inputLabels: L(["user"]) as DataLabels },
      deps({ guard })
    );
    expect(labelsOf(result, "out")).toEqual(L(["user"]));
  });

  it("a node not downstream picks up the labels of a node it reads through {{ results.X }}", async () => {
    const wf = workflow(
      [
        node("in", "webhook_input"),
        set("fetch", { body: "page" }),
        set("quiet", { note: "static" }),
        set("reader", { copy: "{{results.fetch.body}}" }),
        set("dyn", { copy: "{{ results[['fe', 'tch'].join('')].body }}" }),
        node("out", "output")
      ],
      [{ source: "in", target: "fetch" }, { source: "quiet", target: "reader" }, { source: "quiet", target: "dyn" }, { source: "dyn", target: "out" }, { source: "fetch", target: "out" }],
      { pinnedData: { quiet: { note: "pinned" } } }
    );
    const { guard } = guardDeps(["tracking"]);
    const result = await executeWorkflow({ workflow: wf, executionId: "t3", webhookPayload: { user_prompt: "x" } }, deps({ guard }));
    expect(labelsOf(result, "quiet")).toEqual(L(["user"]));
    expect(labelsOf(result, "reader")).toEqual(L(["user", "untrusted_external"]));
    // A computed key reads every node in context, and the run input.
    expect(labelsOf(result, "dyn")).toEqual(L(["user", "untrusted_external"]));
  });

  it("IF and Merge: only the parents that ran", async () => {
    const build = (condition: string) =>
      workflow(
        [
          node("in", "webhook_input"),
          set("pin", { v: 1 }),
          node("if", "if_node", { condition }),
          set("a", { fromInput: "{{results.in.user_prompt}}" }),
          set("b", { plain: "b" }),
          node("m", "merge_node", { mode: "append" }),
          node("out", "output")
        ],
        [
          { source: "in", target: "pin" },
          { source: "pin", target: "if" },
          { source: "if", sourceHandle: "true", target: "a" },
          { source: "if", sourceHandle: "false", target: "b" },
          { source: "a", target: "m" },
          { source: "b", target: "m" },
          { source: "m", target: "out" }
        ],
        { pinnedData: { pin: { v: 1 } } }
      );
    const { guard } = guardDeps(["tracking"]);
    const taken = await executeWorkflow({ workflow: build("true"), executionId: "t4", webhookPayload: { user_prompt: "x" } }, deps({ guard }));
    expect(resultOf(taken, "b")?.status).toBe("skipped");
    expect(labelsOf(taken, "m")).toEqual(L(["user", "untrusted_external"]));
    const other = await executeWorkflow({ workflow: build("false"), executionId: "t5", webhookPayload: { user_prompt: "x" } }, deps({ guard }));
    expect(resultOf(other, "a")?.status).toBe("skipped");
    expect(labelsOf(other, "m")).toEqual(L(["user"]));
  });

  it("a code node takes every node it could read", async () => {
    const wf = workflow(
      [node("in", "webhook_input"), set("pin", {}), node("code", "code_node", { code: "return { n: 1 };" }), node("out", "output")],
      [{ source: "in", target: "pin" }, { source: "pin", target: "code" }, { source: "code", target: "out" }],
      { pinnedData: { pin: { v: 1 } } }
    );
    const { guard } = guardDeps(["tracking"]);
    const result = await executeWorkflow({ workflow: wf, executionId: "t6", webhookPayload: { user_prompt: "x" } }, deps({ guard }));
    expect(result.status).toBe("success");
    expect(labelsOf(result, "code")).toEqual(L(["user", "untrusted_external"]));
  });

  it("loops: each pass is labelled, the loop's output is the union", async () => {
    const wf = workflow(
      [node("in", "webhook_input"), node("loop", "loop_node", { inputKey: "items", itemVariable: "item" }), set("each", { line: "{{item}}@example.org" }), node("out", "output")],
      [{ source: "in", target: "loop" }, { source: "loop", target: "each" }, { source: "loop", target: "out" }]
    );
    const { guard } = guardDeps(["tracking"]);
    const result = await executeWorkflow(
      { workflow: wf, executionId: "t7", webhookPayload: { items: ["", "ana.lopez"] }, input: { items: ["", "ana.lopez"] } },
      deps({ guard })
    );
    expect(result.status).toBe("success");
    const passes = result.nodeResults.filter((entry) => entry.nodeId === "each");
    expect(passes).toHaveLength(2);
    // Each pass is labelled on its own: only the second pass's output holds an email address.
    expect(passes[0]!.labels).toEqual(L(["untrusted_external"]));
    expect(passes[1]!.labels).toEqual(L(["untrusted_external"], ["email"]));
    expect(labelsOf(result, "loop")).toEqual(L(["untrusted_external"], ["email"]));
  });

  it("sub-workflows: the child's trigger takes the caller's input labels, the caller takes the child's output labels", async () => {
    const echo = workflow([node("start", "sub_workflow_trigger"), node("done", "output")], [{ source: "start", target: "done" }], { id: "child-echo", name: "Echo" });
    const pinned = workflow(
      [node("start", "sub_workflow_trigger"), set("fixed", {}), node("done", "output")],
      [{ source: "start", target: "fixed" }, { source: "fixed", target: "done" }],
      { id: "child-pinned", name: "Pinned", pinnedData: { fixed: { answer: 42 } } }
    );
    const parent = (childId: string) =>
      workflow([node("in", "webhook_input"), node("call", "execute_workflow", { workflowId: childId }), node("out", "output")], [{ source: "in", target: "call" }, { source: "call", target: "out" }]);
    const { guard } = guardDeps(["tracking"]);
    const forwarded = await executeWorkflow({ workflow: parent("child-echo"), executionId: "t8", inputLabels: L(["user"], ["iban"]) as DataLabels, webhookPayload: {} }, deps({ guard, workflows: [echo, pinned] }));
    expect(forwarded.status).toBe("success");
    expect(labelsOf(forwarded, "call")).toEqual(L(["user"], ["iban"]));
    const replaced = await executeWorkflow({ workflow: parent("child-pinned"), executionId: "t9", inputLabels: L(["user"], ["iban"]) as DataLabels, webhookPayload: {} }, deps({ guard, workflows: [echo, pinned] }));
    // The child's output came from pinned data only: the caller's node takes exactly those labels.
    expect(labelsOf(replaced, "call")).toEqual(L(["user"]));
    expect(outputLabelsOf(replaced)).toEqual(L(["user"]));
  });

  it("approval pause and resume carry the labels", async () => {
    const paused: WorkflowExecutionState[] = [];
    const wf = simpleWorkflow([node("ask", "human_approval", { approvalMessage: "ok?", timeoutMinutes: 30 }), set("after", { copy: "{{results.greet.text}}" })], [
      { source: "greet", target: "ask" },
      { source: "ask", target: "after" }
    ]);
    const { guard } = guardDeps(["tracking"]);
    const first = await executeWorkflow({ workflow: wf, executionId: "t10", webhookPayload: { user_prompt: `mail ${EMAIL}` } }, deps({ guard, paused }));
    expect(first.status).toBe("waiting_approval");
    expect(paused[0]!.dataLabels?.tracked).toBe(true);
    expect(paused[0]!.dataLabels?.nodes.greet).toEqual(L(["untrusted_external"], ["email"]));
    const resumed = await resumeWorkflowExecution({ executionId: "t10", state: paused[0]!, decision: "approve", actedBy: "admin" }, deps({ guard }));
    expect(resumed.status).toBe("success");
    expect(labelsOf(resumed, "ask")).toEqual(L(["user", "untrusted_external"], ["email"]));
    expect(labelsOf(resumed, "after")).toEqual(L(["user", "untrusted_external"], ["email"]));
  });
});

describe("guard checks and labels", () => {
  const injectionWorkflow = (profileId: string) =>
    workflow(
      [node("in", "webhook_input"), node("g", "guard", { profileId, inputField: "user_prompt", channel: "prompt" }), node("pass", "output"), node("blocked", "output")],
      [{ source: "in", target: "g" }, { source: "g", sourceHandle: "pass", target: "pass" }, { source: "g", sourceHandle: "blocked", target: "blocked" }]
    );

  it("a guard node keeps the channel's fixed labels unless its profile asks for propagated ones", async () => {
    // The prompt arrives from a webhook (external input).
    const fixed = guardDeps([]);
    await executeWorkflow({ workflow: injectionWorkflow("spy"), executionId: "g1", webhookPayload: { user_prompt: "hi" } }, deps({ guard: fixed.guard }));
    expect(fixed.spy.seen).toEqual([{ channel: "prompt", labels: ["user"] }]);
    const propagated = guardDeps([]);
    await executeWorkflow({ workflow: injectionWorkflow("spy-propagated"), executionId: "g2", webhookPayload: { user_prompt: "hi" } }, deps({ guard: propagated.guard }));
    expect(propagated.spy.seen).toEqual([{ channel: "prompt", labels: ["untrusted_external"] }]);
  });

  it("with propagated labels the indirect-injection check runs on a prompt that came from outside", async () => {
    const fixed = guardDeps(["default"]);
    const asUser = await executeWorkflow({ workflow: injectionWorkflow("default"), executionId: "g1b", webhookPayload: { user_prompt: INDIRECT_ONLY } }, deps({ guard: fixed.guard }));
    const tracked = guardDeps(["tracking"]);
    const asExternal = await executeWorkflow({ workflow: injectionWorkflow("tracking"), executionId: "g2b", webhookPayload: { user_prompt: INDIRECT_ONLY } }, deps({ guard: tracked.guard }));
    const categories = (result: WorkflowExecutionResult) =>
      ((resultOf(result, "g")?.output as Record<string, any>).guard.findings as Array<{ category: string }>).map((finding) => finding.category);
    expect(categories(asUser)).not.toContain("indirect_injection");
    expect(categories(asExternal)).toContain("indirect_injection");
  });

  it("explicit labels on the guard node win over propagated ones", async () => {
    const wf = workflow(
      [node("in", "webhook_input"), node("g", "guard", { profileId: "spy-propagated", inputField: "user_prompt", labels: ["trusted"] }), node("out", "output")],
      [{ source: "in", target: "g" }, { source: "g", sourceHandle: "pass", target: "out" }]
    );
    const deps1 = guardDeps([]);
    await executeWorkflow({ workflow: wf, executionId: "g3", webhookPayload: { user_prompt: "hi" } }, deps({ guard: deps1.guard }));
    expect(deps1.spy.seen).toEqual([{ channel: "prompt", labels: ["trusted"] }]);
  });

  it("redact removes the acted-on class from the labels; provenance stays", async () => {
    const wf = workflow(
      [node("in", "webhook_input"), node("g", "guard", { profileId: "tracking", inputField: "user_prompt" }), node("out", "output")],
      [{ source: "in", target: "g" }, { source: "g", sourceHandle: "pass", target: "out" }]
    );
    const { guard } = guardDeps(["tracking"]);
    const result = await executeWorkflow({ workflow: wf, executionId: "g4", webhookPayload: { user_prompt: `Key ${SECRET}` } }, deps({ guard }));
    expect(labelsOf(result, "in")).toEqual(L(["untrusted_external"], ["credential"]));
    expect(labelsOf(result, "g")).toEqual(L(["untrusted_external"]));
  });
});

/** Answers with a tool call until a tool result is in the conversation, then with a final answer. */
class ToolThenAnswer implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  constructor(private readonly toolName: string, private readonly args: Record<string, unknown>, private readonly final = "All done.") {}
  async generate(request: ProviderCallRequest) {
    const sawTool = request.messages.some((message) => message.role === "tool");
    if (!sawTool && request.tools?.some((tool) => tool.name === this.toolName)) {
      return { content: "Calling a tool.", toolCalls: [{ id: "call-1", name: this.toolName, arguments: this.args }] };
    }
    return { content: this.final, toolCalls: [] };
  }
}

function agentWorkflow(options: { guardProfile?: string; withTool?: boolean } = {}) {
  const nodes = [
    node("in", "webhook_input"),
    node("agent", "agent_orchestrator", { maxIterations: 4, toolCallingEnabled: true, userPromptTemplate: "{{user_prompt}}" }),
    node("model", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
    node("memory", "local_memory", {}),
    node("out", "output")
  ];
  const edges: Array<Omit<WorkflowEdge, "id">> = [
    { source: "in", target: "agent" },
    { source: "agent", target: "out" },
    { source: "agent", sourceHandle: "chat_model", target: "model" },
    { source: "agent", sourceHandle: "memory", target: "memory" }
  ];
  if (options.withTool !== false) {
    nodes.push(node("tool", "mcp_tool", { serverId: "docs-mcp", toolName: "fetch_page" }));
    edges.push({ source: "agent", sourceHandle: "tool", target: "tool" });
  }
  if (options.guardProfile) {
    nodes.push(node("agent_guard", "guard", { profileId: options.guardProfile }));
    edges.push({ source: "agent", sourceHandle: "guard", target: "agent_guard" });
  }
  return workflow(nodes, edges);
}

describe("agents", () => {
  it("accumulate input, tool results and memory; memory keeps the labels for later runs", async () => {
    const memory = new MemoryStore();
    const { guard } = guardDeps(["tracking"]);
    const first = await executeWorkflow(
      { workflow: agentWorkflow(), executionId: "a1", inputLabels: L(["user"]) as DataLabels, webhookPayload: { user_prompt: "Summarise", session_id: "s1" } },
      deps({ provider: new ToolThenAnswer("docs-mcp__fetch_page", { url: "https://example.com" }), guard, memoryStore: memory, page: () => ({ text: `Contact ${EMAIL}` }) })
    );
    expect(first.status).toBe("success");
    // The answer carries the tool result's provenance (the scan of the output found no email: the model did not repeat it).
    expect(labelsOf(first, "agent")?.provenance).toEqual(["user", "untrusted_external"]);
    expect(memory.saveCalls).toEqual([1]);
    const stored = [...memory.labels.values()][0]!;
    expect(stored.provenance).toEqual(["user", "untrusted_external"]);

    // A later run without tools reads the memory: its answer carries what the memory came from.
    const second = await executeWorkflow(
      { workflow: agentWorkflow({ withTool: false }), executionId: "a2", inputLabels: L(["user"]) as DataLabels, webhookPayload: { user_prompt: "And then?", session_id: "s1" } },
      deps({ provider: new ToolThenAnswer("none", {}), guard, memoryStore: memory })
    );
    expect(labelsOf(second, "agent")?.provenance).toEqual(["user", "untrusted_external"]);
  });

  it("older memory without labels adds nothing", async () => {
    const memory = new MemoryStore();
    memory.messages.set("wf-labels:agent|s2", [{ role: "user", content: "earlier" }, { role: "assistant", content: "ok" }]);
    const { guard } = guardDeps(["tracking"]);
    const result = await executeWorkflow(
      { workflow: agentWorkflow({ withTool: false }), executionId: "a3", inputLabels: L(["user"]) as DataLabels, webhookPayload: { user_prompt: "Hi", session_id: "s2" } },
      deps({ provider: new ToolThenAnswer("none", {}), guard, memoryStore: memory })
    );
    expect(labelsOf(result, "agent")).toEqual(L(["user"]));
  });

  it("guard checks get fixed labels unless a profile asks for propagated ones", async () => {
    const run = async (profile: string) => {
      const harness = guardDeps([profile]);
      await executeWorkflow(
        { workflow: agentWorkflow(), executionId: `a-${profile}`, inputLabels: L(["user"]) as DataLabels, webhookPayload: { user_prompt: "Go" } },
        deps({ provider: new ToolThenAnswer("docs-mcp__fetch_page", { url: "https://example.com" }), guard: harness.guard })
      );
      return harness.spy.seen;
    };
    expect(await run("spy")).toEqual([
      { channel: "prompt", labels: ["user"] },
      { channel: "tool_arguments", labels: [] },
      { channel: "tool_result", labels: ["untrusted_external"] },
      { channel: "final_output", labels: [] }
    ]);
    expect(await run("spy-propagated")).toEqual([
      { channel: "prompt", labels: ["user"] },
      { channel: "tool_arguments", labels: ["user"] },
      { channel: "tool_result", labels: ["untrusted_external"] },
      { channel: "final_output", labels: ["user", "untrusted_external"] }
    ]);
  });

  it("a supervisor's worker starts with the supervisor's labels; its result labels join the supervisor", async () => {
    class Delegating implements LLMProviderAdapter {
      readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
      async generate(request: ProviderCallRequest) {
        const isSupervisor = request.tools?.some((tool) => tool.name.startsWith("delegate_to_"));
        const sawTool = request.messages.some((message) => message.role === "tool");
        if (isSupervisor && !sawTool) return { content: "Delegating.", toolCalls: [{ id: "d1", name: "delegate_to_Researcher", arguments: { task_prompt: "Look it up" } }] };
        if (!isSupervisor && !sawTool) return { content: "Fetching.", toolCalls: [{ id: "w1", name: "docs-mcp__fetch_page", arguments: { url: "https://example.com" } }] };
        return { content: isSupervisor ? "Supervisor done." : "Worker done.", toolCalls: [] };
      }
    }
    const wf = workflow(
      [
        node("in", "webhook_input"),
        node("sup", "supervisor_node", { maxIterations: 3, userPromptTemplate: "{{user_prompt}}" }, "Supervisor"),
        node("sup_model", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
        node("worker", "agent_orchestrator", { maxIterations: 3, toolCallingEnabled: true, userPromptTemplate: "{{user_prompt}}" }, "Researcher"),
        node("worker_model", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
        node("worker_tool", "mcp_tool", { serverId: "docs-mcp", toolName: "fetch_page" }),
        node("out", "output")
      ],
      [
        { source: "in", target: "sup" },
        { source: "sup", target: "out" },
        { source: "sup", sourceHandle: "chat_model", target: "sup_model" },
        { source: "sup", sourceHandle: "worker", target: "worker" },
        { source: "worker", sourceHandle: "chat_model", target: "worker_model" },
        { source: "worker", sourceHandle: "tool", target: "worker_tool" }
      ]
    );
    const { guard, spy } = guardDeps(["spy-propagated"]);
    const result = await executeWorkflow(
      { workflow: wf, executionId: "a5", inputLabels: L(["user"], ["iban"]) as DataLabels, webhookPayload: { user_prompt: "Research" } },
      deps({ provider: new Delegating(), guard })
    );
    expect(result.status).toBe("success");
    expect(labelsOf(result, "sup")).toEqual(L(["user", "untrusted_external"], ["iban"]));
    // The supervisor's guard saw the worker's answer with the worker's labels (it fetched a page).
    const supervisorResult = spy.seen.filter((entry) => entry.channel === "tool_result").at(-1);
    expect(supervisorResult?.labels).toEqual(["user", "untrusted_external"]);
  });
});
