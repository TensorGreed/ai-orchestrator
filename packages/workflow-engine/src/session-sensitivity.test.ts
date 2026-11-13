/**
 * v73 — session state written by sensitive work: rows are marked when written, and a run that reads a marked row
 * exports no content from then on (the run's content check answers `sensitive_memory`) and marks what it writes.
 */
import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime, type AgentSessionMemoryStore, type AgentSessionToolDataStore, type AgentSessionToolRecord } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import {
  NOOP_RUN_INSTRUMENTATION,
  type ChatMessage,
  type ContentSensitivity,
  type DataLabels,
  type RunInstrumentation,
  type Workflow,
  type WorkflowExecutionState,
  type WorkflowNode
} from "@ai-orchestrator/shared";
import { executeWorkflow, outputLabelsOf, resumeWorkflowExecution, type AgentSessionArtifactRecord, type AgentSessionArtifactStore, type WorkflowExecutionDependencies } from "./executor";
import { SessionSensitivity, sensitivityTrackingSessionStores } from "./session-sensitivity";

const SENSITIVE: DataLabels = { provenance: ["sensitive"], dataClasses: [], source: "propagated" };
const USER: DataLabels = { provenance: ["user"], dataClasses: [], source: "propagated" };

/** In-memory session stores that keep the v73 mark the way the database stores do (once set, it stays). */
function memoryStores(seed: { memory?: Record<string, { messages: ChatMessage[]; sensitive?: boolean; labels?: DataLabels }> } = {}) {
  const memory = new Map(Object.entries(seed.memory ?? {}).map(([key, value]) => [key, { ...value }]));
  const tools: AgentSessionToolRecord[] = [];
  const artifacts = new Map<string, AgentSessionArtifactRecord>();
  const writes: Array<{ kind: string; args: unknown[] }> = [];
  const memoryStore: AgentSessionMemoryStore = {
    loadMessages: async (_namespace, sessionId) => structuredClone(memory.get(sessionId)?.messages ?? []),
    saveMessages: async (...args) => {
      writes.push({ kind: "memory", args });
      const [, sessionId, messages, options] = args;
      const previous = memory.get(sessionId);
      memory.set(sessionId, { messages, sensitive: previous?.sensitive === true || options?.sensitive === true, ...(options?.labels ? { labels: options.labels } : {}) });
    },
    loadLabels: async (_namespace, sessionId) => memory.get(sessionId)?.labels ?? null,
    loadSensitive: async (_namespace, sessionId) => memory.get(sessionId)?.sensitive === true
  };
  const toolDataStore: AgentSessionToolDataStore = {
    saveToolCall: async (input) => {
      writes.push({ kind: "tool", args: [input] });
      const record = { ...input, id: `rec-${tools.length + 1}`, createdAt: "2026-11-13T00:00:00.000Z" };
      tools.push(record);
      return record;
    },
    listToolCalls: async (input) => tools.filter((record) => record.sessionId === input.sessionId).map(({ output: _output, ...rest }) => rest),
    getToolCall: async (input) => tools.find((record) => record.id === input.id) ?? null
  };
  const sessionArtifactStore: AgentSessionArtifactStore = {
    saveArtifact: async (input) => {
      writes.push({ kind: "artifact", args: [input] });
      const previous = artifacts.get(input.artifactKey);
      const sensitive = input.sensitive === true || previous?.sensitive === true;
      const { sensitive: _sensitive, ...rest } = input;
      const record: AgentSessionArtifactRecord = { ...rest, ...(sensitive ? { sensitive: true } : {}), createdAt: "c", updatedAt: "u" };
      artifacts.set(input.artifactKey, record);
      return record;
    },
    loadArtifact: async (input) => artifacts.get(input.artifactKey) ?? null
  };
  return { memory, tools, artifacts, writes, stores: { memoryStore, toolDataStore, sessionArtifactStore } };
}

describe("SessionSensitivity and the tracking stores", () => {
  it("leaves unmarked reads and writes alone: arguments pass through exactly, the declared check runs once, on the first write", async () => {
    const backing = memoryStores({ memory: { s1: { messages: [{ role: "user", content: "hi" }] } } });
    let declaredCalls = 0;
    const sensitivity = new SessionSensitivity({ declared: async () => (declaredCalls += 1, false), workSensitive: () => false });
    const stores = sensitivityTrackingSessionStores(backing.stores, sensitivity);
    expect(await stores.memoryStore!.loadMessages("ns", "s1")).toEqual([{ role: "user", content: "hi" }]);
    expect(declaredCalls).toBe(0);
    await stores.memoryStore!.saveMessages("ns", "s1", [{ role: "user", content: "next" }]);
    await stores.toolDataStore!.saveToolCall({ namespace: "ns", sessionId: "s1", toolName: "t", args: {}, output: 1 });
    await stores.sessionArtifactStore!.saveArtifact({ namespace: "ns", sessionId: "s1", artifactKey: "a", value: 1 });
    expect(declaredCalls).toBe(1);
    expect(backing.writes[0]!.args).toHaveLength(3);
    expect(backing.writes[1]!.args[0]).not.toHaveProperty("sensitive");
    expect(backing.writes[2]!.args[0]).not.toHaveProperty("sensitive");
    expect(sensitivity.readSensitive).toBe(false);
    expect(sensitivity.exclusion()).toBe(false);
  });

  it("a read of marked memory makes the run sensitive_memory and marks everything it writes after", async () => {
    const backing = memoryStores({ memory: { s1: { messages: [{ role: "user", content: "card 4242" }], sensitive: true } } });
    const sensitivity = new SessionSensitivity({ declared: async () => false, workSensitive: () => false });
    const stores = sensitivityTrackingSessionStores(backing.stores, sensitivity);
    await stores.memoryStore!.loadMessages("ns", "s1");
    expect(sensitivity.exclusion()).toBe("sensitive_memory");
    await stores.memoryStore!.saveMessages("ns", "s2", [{ role: "user", content: "x" }], { labels: USER });
    await stores.toolDataStore!.saveToolCall({ namespace: "ns", sessionId: "s2", toolName: "t", args: {}, output: 1 });
    await stores.sessionArtifactStore!.saveArtifact({ namespace: "ns", sessionId: "s2", artifactKey: "a", value: 1 });
    expect(backing.writes.map((write) => write.kind === "memory" ? write.args[3] : write.args[0])).toEqual([
      { labels: USER, sensitive: true },
      expect.objectContaining({ sensitive: true }),
      expect.objectContaining({ sensitive: true })
    ]);
  });

  it("notes marked or sensitive-labelled tool cache rows (list and get) and artifacts", async () => {
    for (const read of ["list", "get", "labels", "artifact"] as const) {
      const backing = memoryStores();
      const sensitivity = new SessionSensitivity({ declared: async () => false, workSensitive: () => false });
      const stores = sensitivityTrackingSessionStores(backing.stores, sensitivity);
      if (read === "artifact") {
        await backing.stores.sessionArtifactStore.saveArtifact({ namespace: "ns", sessionId: "s", artifactKey: "a", value: 1, sensitive: true });
        await stores.sessionArtifactStore!.loadArtifact({ namespace: "ns", sessionId: "s", artifactKey: "a" });
      } else {
        const saved = await backing.stores.toolDataStore.saveToolCall({
          namespace: "ns",
          sessionId: "s",
          toolName: "t",
          args: {},
          output: 1,
          ...(read === "labels" ? { labels: SENSITIVE } : { sensitive: true })
        });
        if (read === "list") await stores.toolDataStore!.listToolCalls({ namespace: "ns", sessionId: "s" });
        else await stores.toolDataStore!.getToolCall({ namespace: "ns", sessionId: "s", id: saved.id });
      }
      expect(sensitivity.exclusion(), read).toBe("sensitive_memory");
    }
    // An unmarked row with plain labels notes nothing.
    const backing = memoryStores();
    const sensitivity = new SessionSensitivity({ declared: async () => false, workSensitive: () => false });
    const stores = sensitivityTrackingSessionStores(backing.stores, sensitivity);
    await backing.stores.toolDataStore.saveToolCall({ namespace: "ns", sessionId: "s", toolName: "t", args: {}, output: 1, labels: USER });
    await stores.toolDataStore!.listToolCalls({ namespace: "ns", sessionId: "s" });
    expect(sensitivity.exclusion()).toBe(false);
  });

  it("a memory store without the v73 mark reads no labels here (label tracking reads them, once); a labelled row is sensitive but adds no label", async () => {
    const backing = memoryStores({ memory: { s1: { messages: [{ role: "user", content: "x" }], labels: SENSITIVE } } });
    let labelReads = 0;
    const { loadSensitive: _dropped, ...withoutMark } = backing.stores.memoryStore;
    const legacy = {
      ...backing.stores,
      memoryStore: {
        ...withoutMark,
        loadLabels: async (namespace: string, sessionId: string) => {
          labelReads += 1;
          return await withoutMark.loadLabels!(namespace, sessionId);
        }
      }
    };
    const plain = new SessionSensitivity({ declared: async () => false, workSensitive: () => false });
    await sensitivityTrackingSessionStores(legacy, plain).memoryStore!.loadMessages("ns", "s1");
    expect(labelReads).toBe(0);

    let labelled = 0;
    const byLabels = new SessionSensitivity({ declared: async () => false, workSensitive: () => false, onSensitiveRead: () => (labelled += 1) });
    byLabels.noteRead(true, false);
    expect(byLabels.readSensitive).toBe(true);
    expect(byLabels.exclusion()).toBe("sensitive_memory");
    expect(byLabels.readMarkedSensitive).toBe(false);
    expect(labelled).toBe(0);
    byLabels.noteRead(true);
    expect(byLabels.readMarkedSensitive).toBe(true);
    expect(labelled).toBe(1);
  });

  it("fails closed: a mark that cannot be read counts as marked, a declared check that fails marks writes", async () => {
    const backing = memoryStores({ memory: { s1: { messages: [{ role: "user", content: "x" }] } } });
    const broken = { ...backing.stores, memoryStore: { ...backing.stores.memoryStore, loadSensitive: async () => Promise.reject(new Error("db down")) } };
    const read = new SessionSensitivity({ declared: async () => false, workSensitive: () => false });
    await sensitivityTrackingSessionStores(broken, read).memoryStore!.loadMessages("ns", "s1");
    expect(read.readSensitive).toBe(true);

    expect(await new SessionSensitivity({ declared: async () => Promise.reject(new Error("registry down")), workSensitive: () => false }).writeSensitive()).toBe(true);
    expect(await new SessionSensitivity({ declared: async () => false, workSensitive: () => { throw new Error("labels unreadable"); } }).writeSensitive()).toBe(true);
    expect(await new SessionSensitivity({ declared: async () => false, workSensitive: () => true }).writeSensitive()).toBe(true);
    expect(await new SessionSensitivity({ declared: async () => false, workSensitive: () => false }).writeSensitive(SENSITIVE)).toBe(true);
    expect(await new SessionSensitivity({ declared: async () => false, workSensitive: () => false }).writeSensitive(USER)).toBe(false);
    expect(new SessionSensitivity({ declared: async () => false, workSensitive: () => false, readBefore: true }).exclusion()).toBe("sensitive_memory");
  });
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function workflow(id: string, nodes: WorkflowNode[], edges: Array<[string, string, string?]>): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes,
    edges: edges.map(([source, target, sourceHandle], index) => ({ id: `e${index}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) }))
  };
}

class Scripted implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  readonly calls: ProviderCallRequest[] = [];
  constructor(private readonly script: (request: ProviderCallRequest, call: number) => { content: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }) {}
  async generate(request: ProviderCallRequest) {
    this.calls.push(request);
    return this.script(request, this.calls.length);
  }
}

/** A capturing instrumentation whose content checks the test can evaluate (as packages/otel does when content arrives). */
function capturing(captures = true) {
  const checks: Array<() => ContentSensitivity> = [];
  const instrument: RunInstrumentation = {
    ...NOOP_RUN_INSTRUMENTATION,
    enabled: true,
    capturesContent: captures,
    withContentExclusion: <T>(check: () => ContentSensitivity, fn: () => T): T => {
      checks.push(check);
      return fn();
    }
  };
  return { instrument, answer: () => checks.map((check) => check()) };
}

function deps(stores: ReturnType<typeof memoryStores>["stores"], extra: Partial<WorkflowExecutionDependencies> = {}, provider?: LLMProviderAdapter): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(provider ?? new Scripted(() => ({ content: "ok", toolCalls: [] })));
  return {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    ...stores,
    ...extra
  };
}

const AGENT_MODEL = { provider: { providerId: "scripted", model: "m" } };

function agentFlow(id: string, agentConfig: Record<string, unknown> = {}): Workflow {
  return workflow(
    id,
    [
      node("start", "manual_trigger"),
      node("agent", "agent_orchestrator", { systemPromptTemplate: "Be brief.", userPromptTemplate: "hello", maxIterations: 3, ...agentConfig }),
      node("model", "llm_call", AGENT_MODEL),
      node("mem", "local_memory", { namespace: "shared", sessionIdTemplate: "{{session_id}}" }),
      node("out", "output")
    ],
    [["start", "agent"], ["agent", "out"], ["agent", "model", "chat_model"], ["agent", "mem", "memory"]]
  );
}

describe("runs that write and read session state", () => {
  it("a run with a declared sensitive source marks its memory and tool cache writes even with capture off", async () => {
    const backing = memoryStores();
    const { instrument } = capturing(false);
    const result = await executeWorkflow({ workflow: agentFlow("wf-a", { sensitiveOutput: true }), sessionId: "s1" }, deps(backing.stores, { instrument }));
    expect(result.status).toBe("success");
    expect(backing.memory.get("s1")?.sensitive).toBe(true);
    const plain = memoryStores();
    await executeWorkflow({ workflow: agentFlow("wf-b"), sessionId: "s1" }, deps(plain.stores, { instrument }));
    expect(plain.memory.get("s1")?.sensitive).toBe(false);
  });

  it("an agent that reads marked memory runs sensitive_memory and keeps the memory marked; unmarked memory does not", async () => {
    const backing = memoryStores({ memory: { s1: { messages: [{ role: "user", content: "card 4242" }, { role: "assistant", content: "noted" }], sensitive: true } } });
    const capture = capturing();
    const provider = new Scripted(() => ({ content: "ok", toolCalls: [] }));
    expect((await executeWorkflow({ workflow: agentFlow("wf-b"), sessionId: "s1" }, deps(backing.stores, { instrument: capture.instrument }, provider))).status).toBe("success");
    // The model was sent the memory (memory keeps working)...
    expect(JSON.stringify(provider.calls[0]!.messages)).toContain("card 4242");
    // ...and the run's content check says sensitive_memory from then on.
    expect(capture.answer()).toContain("sensitive_memory");
    expect(backing.memory.get("s1")?.sensitive).toBe(true);

    const clean = memoryStores({ memory: { s1: { messages: [{ role: "user", content: "hello" }] } } });
    const quiet = capturing();
    await executeWorkflow({ workflow: agentFlow("wf-b"), sessionId: "s1" }, deps(clean.stores, { instrument: quiet.instrument }));
    expect(quiet.answer().every((answer) => answer === false)).toBe(true);
    expect(clean.memory.get("s1")?.sensitive).toBe(false);
  });

  it("an agent that fetches a marked tool cache record runs sensitive_memory", async () => {
    const backing = memoryStores();
    const record = await backing.stores.toolDataStore.saveToolCall({ namespace: "shared", sessionId: "s1", toolName: "lookup", args: {}, output: { card: "4242" }, sensitive: true });
    const capture = capturing();
    const provider = new Scripted((_request, call) =>
      call === 1 ? { content: "", toolCalls: [{ id: "c1", name: "session_cache_get", arguments: { record_id: record.id } }] } : { content: "done", toolCalls: [] }
    );
    const answersBefore: ContentSensitivity[][] = [];
    const result = await executeWorkflow(
      { workflow: agentFlow("wf-c", { toolCallingEnabled: true }), sessionId: "s1" },
      deps(backing.stores, { instrument: capture.instrument }, {
        definition: provider.definition,
        generate: async (request: ProviderCallRequest) => {
          answersBefore.push(capture.answer());
          return provider.generate(request);
        }
      } as LLMProviderAdapter)
    );
    expect(result.status).toBe("success");
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain("4242");
    // Not sensitive before the fetch, sensitive_memory for the call that sent the record to the model.
    expect(answersBefore[0]!.every((answer) => answer === false)).toBe(true);
    expect(answersBefore[1]).toContain("sensitive_memory");
  });

  it("a Simple Memory or Session Artifact Load node that reads a marked row makes the rest of the run sensitive_memory", async () => {
    for (const reader of ["memory", "artifact"] as const) {
      const backing = memoryStores({ memory: { s1: { messages: [{ role: "user", content: "card 4242" }], sensitive: true } } });
      await backing.stores.sessionArtifactStore.saveArtifact({ namespace: "shared", sessionId: "s1", artifactKey: "note", value: { card: "4242" }, sensitive: true });
      const capture = capturing();
      const read =
        reader === "memory"
          ? node("read", "local_memory", { namespace: "shared", sessionIdTemplate: "{{session_id}}" })
          : node("read", "session_artifact_load", { namespace: "shared", sessionIdTemplate: "{{session_id}}", artifactKey: "note" });
      const wf = workflow("wf-d", [node("start", "manual_trigger"), read, node("out", "output")], [["start", "read"], ["read", "out"]]);
      const result = await executeWorkflow({ workflow: wf, sessionId: "s1" }, deps(backing.stores, { instrument: capture.instrument }));
      expect(result.status, reader).toBe("success");
      expect(capture.answer(), reader).toContain("sensitive_memory");
    }
  });

  it("a paused run that read marked memory resumes sensitive_memory without reading it again", async () => {
    const backing = memoryStores({ memory: { s1: { messages: [{ role: "user", content: "card 4242" }], sensitive: true } } });
    const paused: WorkflowExecutionState[] = [];
    const wf = workflow(
      "wf-e",
      [
        node("start", "manual_trigger"),
        node("read", "local_memory", { namespace: "shared", sessionIdTemplate: "{{session_id}}" }),
        node("ask", "human_approval", { approvalMessage: "Go?", timeoutMinutes: 30 }),
        node("out", "output")
      ],
      [["start", "read"], ["read", "ask"], ["ask", "out"]]
    );
    const first = await executeWorkflow(
      { workflow: wf, executionId: "run-e", sessionId: "s1" },
      deps(backing.stores, { instrument: capturing().instrument, persistPausedExecution: async (input) => void paused.push(input.state) })
    );
    expect(first.status).toBe("waiting_approval");
    expect(paused[0]!.sensitiveSessionRead).toBe(true);

    const capture = capturing();
    const resumed = await resumeWorkflowExecution({ executionId: "run-e", state: paused[0]!, decision: "approve", actedBy: "lead@example.com" }, deps(memoryStores().stores, { instrument: capture.instrument }));
    expect(resumed.status).toBe("success");
    expect(capture.answer()).toContain("sensitive_memory");

    // A run that read nothing marked stores no flag.
    const clean: WorkflowExecutionState[] = [];
    await executeWorkflow(
      { workflow: wf, executionId: "run-f", sessionId: "s1" },
      deps(memoryStores({ memory: { s1: { messages: [{ role: "user", content: "hi" }] } } }).stores, { persistPausedExecution: async (input) => void clean.push(input.state) })
    );
    expect(clean[0]).not.toHaveProperty("sensitiveSessionRead");
  });

  it("a run that read a marked row hands its callers sensitive output labels; a clean run does not", async () => {
    const wf = workflow(
      "wf-g",
      [node("start", "manual_trigger"), node("read", "local_memory", { namespace: "shared", sessionIdTemplate: "{{session_id}}" }), node("out", "output")],
      [["start", "read"], ["read", "out"]]
    );
    const marked = await executeWorkflow({ workflow: wf, sessionId: "s1" }, deps(memoryStores({ memory: { s1: { messages: [{ role: "user", content: "card" }], sensitive: true } } }).stores));
    expect(outputLabelsOf(marked)?.provenance).toContain("sensitive");
    const clean = await executeWorkflow({ workflow: wf, sessionId: "s1" }, deps(memoryStores({ memory: { s1: { messages: [{ role: "user", content: "hi" }] } } }).stores));
    expect(outputLabelsOf(clean)?.provenance ?? []).not.toContain("sensitive");

    // An agent that read marked memory: its own result labels say sensitive too.
    const agentRun = await executeWorkflow(
      { workflow: agentFlow("wf-h"), sessionId: "s1" },
      deps(memoryStores({ memory: { s1: { messages: [{ role: "user", content: "card" }, { role: "assistant", content: "ok" }], sensitive: true } } }).stores)
    );
    expect(agentRun.nodeResults.find((entry) => entry.nodeId === "agent")?.labels?.provenance ?? outputLabelsOf(agentRun)?.provenance).toContain("sensitive");
  });

  it("a sub-workflow with its own scoped stores notes and marks like its parent", async () => {
    const parentStores = memoryStores();
    const childStores = memoryStores({ memory: { s1: { messages: [{ role: "user", content: "card 4242" }], sensitive: true } } });
    const child = workflow(
      "wf-child",
      [node("cstart", "manual_trigger"), node("read", "local_memory", { namespace: "shared", sessionIdTemplate: "s1" }), node("cout", "output")],
      [["cstart", "read"], ["read", "cout"]]
    );
    const parent = workflow(
      "wf-parent",
      [node("start", "manual_trigger"), node("call", "execute_workflow", { workflowId: "wf-child", mode: "sync" }), node("save", "session_artifact_save", { namespace: "shared", sessionIdTemplate: "{{session_id}}", artifactKey: "copy" }), node("out", "output")],
      [["start", "call"], ["call", "save"], ["save", "out"]]
    );
    const capture = capturing();
    const result = await executeWorkflow(
      { workflow: parent, sessionId: "s1" },
      deps(parentStores.stores, {
        instrument: capture.instrument,
        loadWorkflow: (id) => (id === "wf-child" ? child : undefined),
        scopeSubWorkflow: () => ({ ...childStores.stores })
      })
    );
    expect(result.status).toBe("success");
    // The child's read (through its own stores) makes the parent run sensitive_memory and marks the parent's write.
    expect(capture.answer()).toContain("sensitive_memory");
    expect(parentStores.artifacts.get("copy")?.sensitive).toBe(true);
  });
});
