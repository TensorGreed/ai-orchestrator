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
    const sensitivity = new SessionSensitivity({ contentCapture: true, declared: async () => (declaredCalls += 1, false), workSensitive: () => false });
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
    const sensitivity = new SessionSensitivity({ contentCapture: true, declared: async () => false, workSensitive: () => false });
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
      const sensitivity = new SessionSensitivity({ contentCapture: true, declared: async () => false, workSensitive: () => false });
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
    const sensitivity = new SessionSensitivity({ contentCapture: true, declared: async () => false, workSensitive: () => false });
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
    const plain = new SessionSensitivity({ contentCapture: true, declared: async () => false, workSensitive: () => false });
    await sensitivityTrackingSessionStores(legacy, plain).memoryStore!.loadMessages("ns", "s1");
    expect(labelReads).toBe(0);

    let labelled = 0;
    const byLabels = new SessionSensitivity({ contentCapture: true, declared: async () => false, workSensitive: () => false, onSensitiveRead: () => (labelled += 1) });
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
    const read = new SessionSensitivity({ contentCapture: true, declared: async () => false, workSensitive: () => false });
    await sensitivityTrackingSessionStores(broken, read).memoryStore!.loadMessages("ns", "s1");
    expect(read.readSensitive).toBe(true);

    expect(await new SessionSensitivity({ contentCapture: true, declared: async () => Promise.reject(new Error("registry down")), workSensitive: () => false }).writeSensitive()).toBe(true);
    expect(await new SessionSensitivity({ contentCapture: true, declared: async () => false, workSensitive: () => { throw new Error("labels unreadable"); } }).writeSensitive()).toBe(true);
    expect(await new SessionSensitivity({ contentCapture: true, declared: async () => false, workSensitive: () => true }).writeSensitive()).toBe(true);
    expect(await new SessionSensitivity({ contentCapture: true, declared: async () => false, workSensitive: () => false }).writeSensitive(SENSITIVE)).toBe(true);
    expect(await new SessionSensitivity({ contentCapture: true, declared: async () => false, workSensitive: () => false }).writeSensitive(USER)).toBe(false);
    expect(new SessionSensitivity({ contentCapture: true, declared: async () => false, workSensitive: () => false, readBefore: true }).exclusion()).toBe("sensitive_memory");
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
    const marked = await executeWorkflow(
      { workflow: wf, sessionId: "s1" },
      deps(memoryStores({ memory: { s1: { messages: [{ role: "user", content: "card" }], sensitive: true } } }).stores, { instrument: capturing().instrument })
    );
    expect(outputLabelsOf(marked)?.provenance).toContain("sensitive");
    const clean = await executeWorkflow(
      { workflow: wf, sessionId: "s1" },
      deps(memoryStores({ memory: { s1: { messages: [{ role: "user", content: "hi" }] } } }).stores, { instrument: capturing().instrument })
    );
    expect(outputLabelsOf(clean)?.provenance ?? []).not.toContain("sensitive");

    // An agent that read marked memory: its own result labels say sensitive too.
    const agentRun = await executeWorkflow(
      { workflow: agentFlow("wf-h"), sessionId: "s1" },
      deps(memoryStores({ memory: { s1: { messages: [{ role: "user", content: "card" }, { role: "assistant", content: "ok" }], sensitive: true } } }).stores, {
        instrument: capturing().instrument
      })
    );
    expect(agentRun.nodeResults.find((entry) => entry.nodeId === "agent")?.labels?.provenance ?? outputLabelsOf(agentRun)?.provenance).toContain("sensitive");
  });

  it("with capture off, reading a marked row changes no label and makes no extra memory query (as before v73); writes are still marked", async () => {
    const memoryRead = (sensitive: boolean) => memoryStores({ memory: { s1: { messages: [{ role: "user", content: "card" }, { role: "assistant", content: "ok" }], sensitive } } });
    /** The same run on a marked and an unmarked copy of the session: labels, outputs and memory queries. */
    const runBoth = async (
      wf: Workflow,
      seed: (backing: ReturnType<typeof memoryStores>, sensitive: boolean) => Promise<void> | void,
      provider?: () => LLMProviderAdapter,
      instrument?: RunInstrumentation
    ) => {
      const outcomes = [];
      for (const sensitive of [true, false]) {
        const backing = memoryRead(sensitive);
        await seed(backing, sensitive);
        let markQueries = 0;
        const loadSensitive = backing.stores.memoryStore.loadSensitive!;
        const memoryStore = { ...backing.stores.memoryStore, loadSensitive: async (namespace: string, sessionId: string) => (markQueries += 1, loadSensitive(namespace, sessionId)) };
        const result = await executeWorkflow({ workflow: wf, sessionId: "s1" }, deps({ ...backing.stores, memoryStore }, instrument ? { instrument } : {}, provider?.()));
        expect(result.status).toBe("success");
        outcomes.push({
          labels: result.nodeResults.map((entry) => [entry.nodeId, entry.labels ?? null]),
          output: result.output,
          outputLabels: outputLabelsOf(result) ?? null,
          markQueries
        });
      }
      return { marked: outcomes[0]!, unmarked: outcomes[1]! };
    };
    const noSeed = () => undefined;
    const readers: Array<[string, Workflow, (backing: ReturnType<typeof memoryStores>, sensitive: boolean) => Promise<void> | void, (() => LLMProviderAdapter)?]> = [
      [
        "simple memory",
        workflow("wf-off-a", [node("start", "manual_trigger"), node("read", "local_memory", { namespace: "shared", sessionIdTemplate: "{{session_id}}" }), node("out", "output")], [["start", "read"], ["read", "out"]]),
        noSeed
      ],
      ["agent memory", agentFlow("wf-off-b"), noSeed],
      [
        "artifact",
        workflow(
          "wf-off-c",
          [node("start", "manual_trigger"), node("read", "session_artifact_load", { namespace: "shared", sessionIdTemplate: "{{session_id}}", artifactKey: "note" }), node("out", "output")],
          [["start", "read"], ["read", "out"]]
        ),
        async (backing, sensitive) => {
          await backing.stores.sessionArtifactStore.saveArtifact({ namespace: "shared", sessionId: "s1", artifactKey: "note", value: { card: "4242" }, ...(sensitive ? { sensitive: true } : {}) });
        }
      ],
      [
        "tool cache",
        agentFlow("wf-off-d", { toolCallingEnabled: true }),
        async (backing, sensitive) => {
          await backing.stores.toolDataStore.saveToolCall({ namespace: "shared", sessionId: "s1", toolName: "lookup", args: {}, output: { card: "4242" }, ...(sensitive ? { sensitive: true } : {}) });
        },
        () => new Scripted((_request, call) => (call === 1 ? { content: "", toolCalls: [{ id: "c1", name: "session_cache_get", arguments: { record_id: "rec-1" } }] } : { content: "done", toolCalls: [] }))
      ]
    ];
    for (const [name, wf, seed, provider] of readers) {
      // No instrumentation at all, and instrumentation with capture off: the mark changes nothing a caller sees.
      for (const instrument of [undefined, capturing(false).instrument]) {
        const { marked, unmarked } = await runBoth(wf, seed, provider, instrument);
        expect(marked, name).toEqual(unmarked);
        expect(marked.markQueries, name).toBe(0);
        expect(JSON.stringify(marked.outputLabels?.provenance ?? []), name).not.toContain("sensitive");
      }
      // With capture on the same read does label the run (the user decision keeps it for capture only).
      const on = await runBoth(wf, seed, provider, capturing().instrument);
      expect(on.marked.outputLabels?.provenance, name).toContain("sensitive");
      expect(on.unmarked.outputLabels?.provenance ?? [], name).not.toContain("sensitive");
    }

    // Writes by sensitive work are still marked with capture off (the declared source here).
    const backing = memoryStores();
    await executeWorkflow({ workflow: agentFlow("wf-off-e", { sensitiveOutput: true }), sessionId: "s1" }, deps(backing.stores, { instrument: capturing(false).instrument }));
    expect(backing.memory.get("s1")?.sensitive).toBe(true);
  });

  it("with capture off, a paused and resumed run, a failed run and a scoped sub-workflow label a marked read as an unmarked one", async () => {
    const seeded = (sensitive: boolean) => memoryStores({ memory: { s1: { messages: [{ role: "user", content: "card" }, { role: "assistant", content: "ok" }], sensitive } } });
    const off = () => capturing(false).instrument;
    const view = (result: Awaited<ReturnType<typeof executeWorkflow>>) => ({
      status: result.status,
      labels: result.nodeResults.map((entry) => [entry.nodeId, entry.labels ?? null]),
      outputLabels: outputLabelsOf(result) ?? null
    });

    // Paused for an approval, then resumed.
    const paused = workflow(
      "wf-off-pause",
      [
        node("start", "manual_trigger"),
        node("read", "local_memory", { namespace: "shared", sessionIdTemplate: "{{session_id}}" }),
        node("ask", "human_approval", { approvalMessage: "Go?", timeoutMinutes: 30 }),
        node("out", "output")
      ],
      [["start", "read"], ["read", "ask"], ["ask", "out"]]
    );
    const pauseViews = [];
    for (const sensitive of [true, false]) {
      const states: WorkflowExecutionState[] = [];
      const first = await executeWorkflow(
        { workflow: paused, executionId: `run-off-${sensitive}`, sessionId: "s1" },
        deps(seeded(sensitive).stores, { instrument: off(), persistPausedExecution: async (input) => void states.push(input.state) })
      );
      expect(first.status).toBe("waiting_approval");
      expect(states[0]).not.toHaveProperty("sensitiveSessionRead");
      expect(states[0]).not.toHaveProperty("sensitiveSessionReadMarked");
      const resumed = await resumeWorkflowExecution(
        { executionId: `run-off-${sensitive}`, state: states[0]!, decision: "approve", actedBy: "lead@example.com" },
        deps(seeded(sensitive).stores, { instrument: off() })
      );
      pauseViews.push(view(resumed));
    }
    expect(pauseViews[0]).toEqual(pauseViews[1]);

    // A failed run: a step after the memory read fails (its sub-workflow does not exist).
    const failing = workflow(
      "wf-off-fail",
      [
        node("start", "manual_trigger"),
        node("read", "local_memory", { namespace: "shared", sessionIdTemplate: "{{session_id}}" }),
        node("call", "execute_workflow", { workflowId: "wf-missing", mode: "sync" }),
        node("out", "output")
      ],
      [["start", "read"], ["read", "call"], ["call", "out"]]
    );
    const failViews = [];
    for (const sensitive of [true, false]) {
      const result = await executeWorkflow({ workflow: failing, sessionId: "s1" }, deps(seeded(sensitive).stores, { instrument: off(), loadWorkflow: () => undefined }));
      expect(result.status).toBe("error");
      failViews.push(view(result));
    }
    expect(failViews[0]).toEqual(failViews[1]);

    // A sub-workflow with its own scoped stores.
    const child = workflow(
      "wf-off-child",
      [node("cstart", "manual_trigger"), node("read", "local_memory", { namespace: "shared", sessionIdTemplate: "s1" }), node("cout", "output")],
      [["cstart", "read"], ["read", "cout"]]
    );
    const parent = workflow(
      "wf-off-parent",
      [node("start", "manual_trigger"), node("call", "execute_workflow", { workflowId: "wf-off-child", mode: "sync" }), node("out", "output")],
      [["start", "call"], ["call", "out"]]
    );
    const subViews = [];
    for (const sensitive of [true, false]) {
      const childStores = seeded(sensitive);
      const result = await executeWorkflow(
        { workflow: parent, sessionId: "s1" },
        deps(memoryStores().stores, { instrument: off(), loadWorkflow: (id) => (id === "wf-off-child" ? child : undefined), scopeSubWorkflow: () => ({ ...childStores.stores }) })
      );
      expect(result.status).toBe("success");
      subViews.push(view(result));
    }
    expect(subViews[0]).toEqual(subViews[1]);
  });

  it("a resumed run labels its output sensitive only when it had read a marked row with capture on, not a labels-only one", async () => {
    const wf = workflow(
      "wf-resume-labels",
      [
        node("start", "manual_trigger"),
        node("read", "session_artifact_load", { namespace: "shared", sessionIdTemplate: "{{session_id}}", artifactKey: "note" }),
        node("ask", "human_approval", { approvalMessage: "Go?", timeoutMinutes: 30 }),
        node("out", "output")
      ],
      [["start", "read"], ["read", "ask"], ["ask", "out"]]
    );
    const outcomes: Record<string, { state: WorkflowExecutionState; labels: string[] }> = {};
    for (const kind of ["marked", "labels"] as const) {
      const backing = memoryStores();
      await backing.stores.sessionArtifactStore.saveArtifact({
        namespace: "shared",
        sessionId: "s1",
        artifactKey: "note",
        value: { note: "x" },
        ...(kind === "marked" ? { sensitive: true } : { labels: SENSITIVE })
      });
      const states: WorkflowExecutionState[] = [];
      await executeWorkflow(
        { workflow: wf, executionId: `run-${kind}`, sessionId: "s1" },
        deps(backing.stores, { instrument: capturing().instrument, persistPausedExecution: async (input) => void states.push(input.state) })
      );
      const resumed = await resumeWorkflowExecution(
        { executionId: `run-${kind}`, state: states[0]!, decision: "approve", actedBy: "lead@example.com" },
        deps(memoryStores().stores, { instrument: capturing().instrument })
      );
      outcomes[kind] = { state: states[0]!, labels: outputLabelsOf(resumed)?.provenance ?? [] };
    }
    expect(outcomes.marked!.state).toMatchObject({ sensitiveSessionRead: true, sensitiveSessionReadMarked: true });
    expect(outcomes.marked!.labels).toContain("sensitive");
    expect(outcomes.labels!.state.sensitiveSessionRead).toBe(true);
    expect(outcomes.labels!.state).not.toHaveProperty("sensitiveSessionReadMarked");
    expect(outcomes.labels!.labels).not.toContain("sensitive");
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
