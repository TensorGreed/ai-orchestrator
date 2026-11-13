/**
 * v74 — content of sensitive work that reaches a later run outside session state: a knowledge base chunk, an error
 * workflow's input, pinned data and node outputs copied from a run. Such a run exports no content (its content check
 * answers `sensitive_knowledge` / `sensitive_run_data`) and marks what it writes, as a read of a marked session row
 * does. Also: memory read with its mark in one query (`loadMessagesMarked`), so with capture off a read of marked memory
 * still marks what the run writes, at no extra query and with no other change.
 */
import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime, type AgentSessionMemoryStore } from "@ai-orchestrator/agent-runtime";
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
import { executeWorkflow, outputLabelsOf, resumeWorkflowExecution, runWasSensitiveWork, type AgentSessionArtifactStore, type WorkflowExecutionDependencies } from "./executor";
import { KnowledgeBaseVectorStoreAdapter, TokenEmbeddingAdapter, type KnowledgeBaseStore } from "./rag-adapters";
import { SessionSensitivity, sensitivityTrackingSessionStores } from "./session-sensitivity";

type MemoryRow = { messages: ChatMessage[]; sensitive?: boolean; labels?: DataLabels };

/** A memory store as the database stores are (rows keyed `namespace:session`): the mark sticks, and `loadMessagesMarked` reads both in one query. */
function markedMemory(seed: Record<string, MemoryRow> = {}) {
  const rows = new Map(Object.entries(seed).map(([key, value]) => [key, { ...value }]));
  const queries = { loadMessages: 0, loadSensitive: 0, loadMessagesMarked: 0 };
  const key = (namespace: string, sessionId: string) => `${namespace}:${sessionId}`;
  const store: AgentSessionMemoryStore = {
    loadMessages: async (namespace, sessionId) => (queries.loadMessages += 1, structuredClone(rows.get(key(namespace, sessionId))?.messages ?? [])),
    saveMessages: async (namespace, sessionId, messages, options) => {
      const previous = rows.get(key(namespace, sessionId));
      rows.set(key(namespace, sessionId), { messages, sensitive: previous?.sensitive === true || options?.sensitive === true, ...(options?.labels ? { labels: options.labels } : {}) });
    },
    loadLabels: async (namespace, sessionId) => rows.get(key(namespace, sessionId))?.labels ?? null,
    loadSensitive: async (namespace, sessionId) => (queries.loadSensitive += 1, rows.get(key(namespace, sessionId))?.sensitive === true),
    loadMessagesMarked: async (namespace, sessionId) => {
      queries.loadMessagesMarked += 1;
      const row = rows.get(key(namespace, sessionId));
      return { messages: structuredClone(row?.messages ?? []), sensitive: row?.sensitive === true };
    }
  };
  return { rows, queries, store };
}

/** A session artifact store that keeps the mark like the database stores: which keys were written marked. */
function artifacts() {
  const saved = new Map<string, { value: unknown; sensitive: boolean }>();
  const sessionArtifactStore: AgentSessionArtifactStore = {
    saveArtifact: async (input) => {
      const previous = saved.get(input.artifactKey);
      const sensitive = previous?.sensitive === true || input.sensitive === true;
      saved.set(input.artifactKey, { value: input.value, sensitive });
      const { sensitive: _sensitive, ...rest } = input;
      return { ...rest, ...(sensitive ? { sensitive: true } : {}), createdAt: "c", updatedAt: "u" };
    },
    loadArtifact: async () => null
  };
  return { saved, sessionArtifactStore };
}

/** Saves `template` as the session artifact `key`. */
function saveNode(id: string, template: string, key = "note"): WorkflowNode {
  return node(id, "session_artifact_save", { namespace: "shared", sessionIdTemplate: "s", artifactKey: key, valueTemplate: template });
}

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function workflow(id: string, nodes: WorkflowNode[], edges: Array<[string, string, string?]>, extra: Partial<Workflow> = {}): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes,
    edges: edges.map(([source, target, sourceHandle], index) => ({ id: `e${index}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) })),
    ...extra
  };
}

class Scripted implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  readonly calls: ProviderCallRequest[] = [];
  async generate(request: ProviderCallRequest) {
    this.calls.push(request);
    return { content: "ok", toolCalls: [] };
  }
}

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

function deps(extra: Partial<WorkflowExecutionDependencies> = {}): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new Scripted());
  return {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    ...extra
  };
}

const AGENT_MODEL = { provider: { providerId: "scripted", model: "m" } };

/** An agent reads (and appends to) memory `from`; a second agent then keeps its own memory `to` (same session id). */
function copyFlow(id: string): Workflow {
  return workflow(
    id,
    [
      node("start", "manual_trigger"),
      node("reader", "agent_orchestrator", { systemPromptTemplate: "Be brief.", userPromptTemplate: "hello", maxIterations: 2 }),
      node("model", "llm_call", AGENT_MODEL),
      node("mem", "local_memory", { namespace: "from" }),
      node("writer", "agent_orchestrator", { systemPromptTemplate: "Be brief.", userPromptTemplate: "keep this", maxIterations: 2 }),
      node("model2", "llm_call", AGENT_MODEL),
      node("mem2", "local_memory", { namespace: "to" }),
      node("out", "output")
    ],
    [
      ["start", "reader"],
      ["reader", "writer"],
      ["writer", "out"],
      ["reader", "model", "chat_model"],
      ["reader", "mem", "memory"],
      ["writer", "model2", "chat_model"],
      ["writer", "mem2", "memory"]
    ]
  );
}

describe("memory read with its mark in one query (train-e question 1)", () => {
  it("the tracking store reads loadMessagesMarked instead of loadMessages + loadSensitive, capture on or off", async () => {
    for (const contentCapture of [true, false]) {
      const memory = markedMemory({ "ns:s1": { messages: [{ role: "user", content: "card 4242" }], sensitive: true } });
      const sensitivity = new SessionSensitivity({ contentCapture, declared: async () => false, workSensitive: () => false });
      const stores = sensitivityTrackingSessionStores({ memoryStore: memory.store }, sensitivity);
      expect(await stores.memoryStore!.loadMessages("ns", "s1")).toEqual([{ role: "user", content: "card 4242" }]);
      expect(memory.queries).toEqual({ loadMessages: 0, loadSensitive: 0, loadMessagesMarked: 1 });
      expect(sensitivity.readSensitive).toBe(true);
      // The run-level label stays a capture-on matter (user decision).
      expect(sensitivity.readMarkedSensitive).toBe(contentCapture);
      expect(await sensitivity.writeSensitive()).toBe(true);
    }
  });

  it("with capture off, a run that reads marked memory marks the rows it derives in another session; nothing else changes", async () => {
    const outcome = async (sensitive: boolean, instrument?: RunInstrumentation) => {
      const memory = markedMemory({ "from:s": { messages: [{ role: "user", content: "card 4242" }, { role: "assistant", content: "noted" }], sensitive } });
      const result = await executeWorkflow({ workflow: copyFlow("wf-derive"), sessionId: "s" }, deps({ memoryStore: memory.store, ...(instrument ? { instrument } : {}) }));
      expect(result.status, result.error).toBe("success");
      return {
        derivedMarked: memory.rows.get("to:s")?.sensitive === true,
        view: {
          output: result.output,
          labels: result.nodeResults.map((entry) => [entry.nodeId, entry.status, entry.labels ?? null]),
          outputLabels: outputLabelsOf(result) ?? null,
          derived: memory.rows.get("to:s")?.messages
        },
        queries: memory.queries
      };
    };
    for (const instrument of [undefined, capturing(false).instrument]) {
      const marked = await outcome(true, instrument);
      const unmarked = await outcome(false, instrument);
      // The derived row carries the mark only when the source did.
      expect(marked.derivedMarked).toBe(true);
      expect(unmarked.derivedMarked).toBe(false);
      // Everything a caller sees is the same as for an unmarked source: outputs, node labels, output labels.
      expect(marked.view).toEqual(unmarked.view);
      expect(JSON.stringify(marked.view.outputLabels ?? {})).not.toContain("sensitive");
      // One query per read, as loadMessages was: no extra mark lookup.
      expect(marked.queries.loadSensitive).toBe(0);
      expect(marked.queries.loadMessages).toBe(0);
      expect(marked.queries).toEqual(unmarked.queries);
    }
  });

  it("a store without loadMessagesMarked behaves as on main: capture off makes no mark lookup and the derived row stays unmarked", async () => {
    const memory = markedMemory({ "from:s": { messages: [{ role: "user", content: "card 4242" }], sensitive: true } });
    const { loadMessagesMarked: _dropped, ...legacy } = memory.store;
    await executeWorkflow({ workflow: copyFlow("wf-legacy"), sessionId: "s" }, deps({ memoryStore: legacy, instrument: capturing(false).instrument }));
    expect(memory.queries.loadSensitive).toBe(0);
    expect(memory.rows.get("to:s")?.sensitive).toBe(false);
  });

  it("with capture on, the same read still drops content as sensitive_memory and labels the run", async () => {
    const memory = markedMemory({ "from:s": { messages: [{ role: "user", content: "card 4242" }], sensitive: true } });
    const capture = capturing();
    const result = await executeWorkflow({ workflow: copyFlow("wf-on"), sessionId: "s" }, deps({ memoryStore: memory.store, instrument: capture.instrument }));
    expect(capture.answer()).toContain("sensitive_memory");
    expect(outputLabelsOf(result)?.provenance).toContain("sensitive");
    expect(memory.queries.loadSensitive).toBe(0);
    expect(memory.rows.get("to:s")?.sensitive).toBe(true);
  });
});

describe("pinned data copied from a sensitive run", () => {
  const pinned = (marked: boolean) =>
    workflow(
      marked ? "wf-pin-marked" : "wf-pin-plain",
      [node("start", "manual_trigger"), node("fetch", "http_request", { method: "GET", urlTemplate: "https://example.com" }), saveNode("save", "{{fetch.body}}"), node("out", "output")],
      [["start", "fetch"], ["fetch", "save"], ["save", "out"]],
      { pinnedData: { fetch: { body: "card 4242" } }, ...(marked ? { pinnedDataSensitive: ["fetch"] } : {}) }
    );

  it("a run that uses a marked pin drops content as sensitive_run_data, labels the run and marks its writes", async () => {
    const store = artifacts();
    const capture = capturing();
    const result = await executeWorkflow({ workflow: pinned(true), sessionId: "s" }, deps({ sessionArtifactStore: store.sessionArtifactStore, instrument: capture.instrument }));
    expect(result.status, result.error).toBe("success");
    expect(capture.answer()).toContain("sensitive_run_data");
    expect(outputLabelsOf(result)?.provenance).toContain("sensitive");
    expect(store.saved.get("note")?.sensitive).toBe(true);
    expect(runWasSensitiveWork(result)).toBe(true);
  });

  it("an unmarked pin changes nothing; with capture off a marked pin only marks the writes", async () => {
    const plainStore = artifacts();
    const capture = capturing();
    const plain = await executeWorkflow({ workflow: pinned(false), sessionId: "s" }, deps({ sessionArtifactStore: plainStore.sessionArtifactStore, instrument: capture.instrument }));
    expect(plain.status, plain.error).toBe("success");
    expect(capture.answer().every((answer) => answer === false)).toBe(true);
    expect(plainStore.saved.get("note")?.sensitive).toBe(false);
    expect(runWasSensitiveWork(plain)).toBe(false);

    const views = [];
    for (const marked of [true, false]) {
      const store = artifacts();
      const result = await executeWorkflow({ workflow: { ...pinned(marked), id: "wf-pin-off" }, sessionId: "s" }, deps({ sessionArtifactStore: store.sessionArtifactStore, instrument: capturing(false).instrument }));
      expect(store.saved.get("note")?.sensitive).toBe(marked);
      views.push({ output: result.output, labels: result.nodeResults.map((entry) => entry.labels ?? null), outputLabels: outputLabelsOf(result) ?? null });
    }
    expect(views[0]).toEqual(views[1]);
  });

  it("a pin the run does not use (usePinnedData false) changes nothing", async () => {
    const capture = capturing();
    const wf = workflow("wf-pin-unused", [node("start", "manual_trigger"), node("out", "output")], [["start", "out"]], {
      pinnedData: { start: { x: 1 } },
      pinnedDataSensitive: ["start"]
    });
    await executeWorkflow({ workflow: wf, usePinnedData: false }, deps({ instrument: capture.instrument }));
    expect(capture.answer().every((answer) => answer === false)).toBe(true);
  });
});

describe("node outputs and input copied from a sensitive run (sensitiveInput)", () => {
  it("drops content as sensitive_run_data and marks writes; a paused run keeps the reason across its resume", async () => {
    const store = artifacts();
    const capture = capturing();
    const wf = workflow(
      "wf-carried",
      [node("start", "manual_trigger"), saveNode("save", "hi"), node("gate", "human_approval", { approvalMessage: "ok?", timeoutMinutes: 5 }), saveNode("after", "later", "after"), node("out", "output")],
      [["start", "save"], ["save", "gate"], ["gate", "after"], ["after", "out"]]
    );
    const states: WorkflowExecutionState[] = [];
    const paused = await executeWorkflow(
      { workflow: wf, executionId: "run-carried", sensitiveInput: true },
      deps({ sessionArtifactStore: store.sessionArtifactStore, instrument: capture.instrument, persistPausedExecution: async (input) => void states.push(input.state) })
    );
    expect(paused.status, paused.error).toBe("waiting_approval");
    expect(capture.answer()).toContain("sensitive_run_data");
    expect(store.saved.get("note")?.sensitive).toBe(true);
    expect(states[0]?.sensitiveSessionRead).toBe(true);
    expect(states[0]?.sensitiveSessionReadReason).toBe("sensitive_run_data");

    const resumedCapture = capturing();
    const resumed = await resumeWorkflowExecution(
      { executionId: "run-carried", state: states[0]!, decision: "approve", actedBy: "lead@example.com" },
      deps({ sessionArtifactStore: store.sessionArtifactStore, instrument: resumedCapture.instrument })
    );
    expect(resumed.status, resumed.error).toBe("success");
    expect(store.saved.get("after")?.sensitive).toBe(true);
    expect(resumedCapture.answer()).toContain("sensitive_run_data");
    expect(runWasSensitiveWork(resumed)).toBe(true);
  });

  it("without it the same run is clean", async () => {
    const capture = capturing();
    const result = await executeWorkflow({ workflow: workflow("wf-clean", [node("start", "manual_trigger"), node("out", "output")], [["start", "out"]]) }, deps({ instrument: capture.instrument }));
    expect(capture.answer().every((answer) => answer === false)).toBe(true);
    expect(runWasSensitiveWork(result)).toBe(false);
  });
});

describe("error workflow input from a sensitive run", () => {
  const failing = (id: string, sensitiveOutput: boolean) =>
    workflow(
      id,
      [
        node("start", "manual_trigger"),
        node("agent", "agent_orchestrator", { systemPromptTemplate: "x", userPromptTemplate: "hello", maxIterations: 2, ...(sensitiveOutput ? { sensitiveOutput: true } : {}) }),
        node("model", "llm_call", AGENT_MODEL),
        node("boom", "stop_and_error", { message: "card 4242 refused" }),
        node("out", "output")
      ],
      [["start", "agent"], ["agent", "boom"], ["boom", "out"], ["agent", "model", "chat_model"]],
      { settings: { errorWorkflowId: "wf-handler" } }
    );

  it("tells the error workflow the failed run was sensitive work (a declared source, or a read of marked memory), with capture on or off", async () => {
    for (const captures of [true, false]) {
      const calls: Array<Record<string, unknown>> = [];
      const triggerErrorWorkflow = async (input: Record<string, unknown>) => void calls.push(input);
      const declared = await executeWorkflow({ workflow: failing("wf-fail-declared", true) }, deps({ triggerErrorWorkflow, instrument: capturing(captures).instrument }));
      expect(declared.error).toContain("card 4242");
      expect(calls[0]?.sensitive).toBe(true);

      const memory = markedMemory({ "shared:s": { messages: [{ role: "user", content: "card 4242" }], sensitive: true } });
      const withMemory = failing("wf-fail-memory", false);
      withMemory.nodes.push(node("mem", "local_memory", { namespace: "shared", sessionIdTemplate: "{{session_id}}" }));
      withMemory.edges.push({ id: "em", source: "agent", target: "mem", sourceHandle: "memory" });
      await executeWorkflow({ workflow: withMemory, sessionId: "s" }, deps({ triggerErrorWorkflow, memoryStore: memory.store, instrument: capturing(captures).instrument }));
      expect(calls[1]?.sensitive).toBe(true);

      await executeWorkflow({ workflow: failing("wf-fail-plain", false) }, deps({ triggerErrorWorkflow, instrument: capturing(captures).instrument }));
      expect(calls[2]).toBeDefined();
      expect(calls[2]).not.toHaveProperty("sensitive");
    }
  });
});

/** An in-memory knowledge base store that keeps the v74 mark like the database stores. */
function knowledgeBase() {
  const chunks: Array<{ id: string; sourceId: string | null; chunkIndex: number; content: string; metadata: Record<string, unknown> | null; vector: number[]; sensitive?: boolean }> = [];
  const adds: Array<{ sensitive?: boolean }> = [];
  const store: KnowledgeBaseStore = {
    addKnowledgeBaseChunks: (input) => {
      adds.push({ ...(input.sensitive === true ? { sensitive: true } : {}) });
      for (const chunk of input.chunks) {
        chunks.push({
          id: `kbc-${chunks.length + 1}`,
          sourceId: chunk.sourceId ?? null,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          metadata: chunk.metadata ?? null,
          vector: chunk.vector,
          ...(input.sensitive === true ? { sensitive: true } : {})
        });
      }
      return { inserted: input.chunks.length, dimensions: chunks[0]?.vector.length ?? 0 };
    },
    listKnowledgeBaseChunks: () => structuredClone(chunks),
    getKnowledgeBase: (id) => (id === "kb1" ? { id, embedderId: "token-embedder", dimensions: 0 } : null)
  };
  return { chunks, adds, store };
}

describe("knowledge base chunks from sensitive work", () => {
  const embedder = new TokenEmbeddingAdapter();

  it("the adapter reports a search that returns a marked chunk, and not one whose returned chunks are all unmarked", async () => {
    const kb = knowledgeBase();
    await new KnowledgeBaseVectorStoreAdapter(kb.store, "kb1").upsert([{ id: "a", text: "card number 4242 on file" }], embedder);
    await kb.store.addKnowledgeBaseChunks({ knowledgeBaseId: "kb1", chunks: [{ chunkIndex: 0, content: "card number 4242 secret", vector: await embedder.embed("card number 4242 secret") }], sensitive: true });
    const seen: boolean[] = [];
    const adapter = new KnowledgeBaseVectorStoreAdapter(kb.store, "kb1", { onRetrieved: (sensitive) => void seen.push(sensitive) });
    const top = await adapter.similaritySearch("card number 4242 secret", 1, embedder);
    expect(top[0]?.text).toBe("card number 4242 secret");
    // The document carries no mark of its own: node output is unchanged.
    expect(JSON.stringify(top)).not.toContain("sensitive");
    const other = await adapter.similaritySearch("card number 4242 on file", 1, embedder);
    expect(other[0]?.text).toBe("card number 4242 on file");
    expect(seen).toEqual([true, false]);
  });

  const retrieve = (id: string, extra: Record<string, unknown> = {}) =>
    workflow(
      id,
      [
        node("start", "manual_trigger"),
        node("rag", "rag_retrieve", { queryTemplate: "card number 4242 secret", topK: 1, vectorStoreId: "knowledge-base", vectorStoreConfig: { knowledgeBaseId: "kb1" }, ...extra }),
        saveNode("save", "{{rag.context}}"),
        node("out", "output")
      ],
      [["start", "rag"], ["rag", "save"], ["save", "out"]]
    );

  it("a run that retrieves a marked chunk drops content as sensitive_knowledge and marks what it writes", async () => {
    const kb = knowledgeBase();
    await kb.store.addKnowledgeBaseChunks({ knowledgeBaseId: "kb1", chunks: [{ chunkIndex: 0, content: "card number 4242 secret", vector: await embedder.embed("card number 4242 secret") }], sensitive: true });
    for (const captures of [true, false]) {
      const store = artifacts();
      const capture = capturing(captures);
      const result = await executeWorkflow({ workflow: retrieve(`wf-kb-${captures}`) }, deps({ knowledgeBaseStore: kb.store, sessionArtifactStore: store.sessionArtifactStore, instrument: capture.instrument }));
      expect(result.status, result.error).toBe("success");
      expect(store.saved.get("note")?.sensitive).toBe(true);
      expect(runWasSensitiveWork(result)).toBe(true);
      if (captures) {
        expect(capture.answer()).toContain("sensitive_knowledge");
        expect(outputLabelsOf(result)?.provenance).toContain("sensitive");
      }
    }
  });

  it("chunks a sensitive run adds are marked; a clean run's are not", async () => {
    const kb = knowledgeBase();
    const docs = [{ id: "d1", text: "card number 4242 secret" }];
    const store = artifacts();
    const sensitive = await executeWorkflow({ workflow: retrieve("wf-kb-add-sensitive", { documents: docs, sensitiveOutput: true }) }, deps({ knowledgeBaseStore: kb.store, sessionArtifactStore: store.sessionArtifactStore, instrument: capturing(false).instrument }));
    expect(sensitive.status, sensitive.error).toBe("success");
    await executeWorkflow({ workflow: retrieve("wf-kb-add-clean", { documents: docs }) }, deps({ knowledgeBaseStore: kb.store, sessionArtifactStore: store.sessionArtifactStore, instrument: capturing(false).instrument }));
    expect(kb.adds).toEqual([{ sensitive: true }, {}]);
  });
});
