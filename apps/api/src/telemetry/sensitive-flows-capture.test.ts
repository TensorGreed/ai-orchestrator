/**
 * v74 end to end: content of a sensitive run that reaches a later run outside session state stays out of exported
 * spans. An error workflow's input from a sensitive run, pinned data and node outputs copied from one, and knowledge
 * base chunks a sensitive run added: a later run that uses them exports no content (`l2m.content.dropped` =
 * `sensitive_run_data` / `sensitive_knowledge`) and marks what it writes. The same flows from a clean run export masked
 * content as before. The model is an in-process echo server on 127.0.0.1; no model server is called.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemorySpanExporter, type ReadableSpan, type SpanProcessor } from "@ai-orchestrator/otel";
import { CONTENT_DROPPED_ATTRIBUTE, type Workflow, type WorkflowNode } from "@ai-orchestrator/shared";
import { createApp } from "../app.js";
import { parseConfig } from "../config.js";
import type { Store } from "../db/store.js";
import { AuthService } from "../services/auth-service.js";
import { SecretService } from "../services/secret-service.js";
import { projectSessionNamespace } from "../run-scope.js";
import { openTestStore } from "../test-support/test-store.js";

/** Seeded in the secret store and put in the sensitive run's prompt: never in any exported span. */
const STORED_SECRET = "stored-secret-Fw19-Pp3k-72Qx";
/** A private value only the sensitive run holds (no masker knows it): never in any exported span. */
const PRIVATE_VALUE = "private-ledger-note-Jh52-Wd88";
const CONTENT_ATTRIBUTE_NAMES = [
  "gen_ai.system_instructions",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.tool.definitions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result"
];
const contentOf = (span: ReadableSpan) => CONTENT_ATTRIBUTE_NAMES.filter((name) => span.attributes[name] !== undefined);
const serialized = (spans: readonly ReadableSpan[]) => JSON.stringify(spans.map((span) => [span.name, span.attributes, span.events, span.status]));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function exportingAtOnce(exporter: InMemorySpanExporter): SpanProcessor {
  return {
    onStart: () => undefined,
    onEnd: (span) => exporter.export([span], () => undefined),
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve()
  };
}

/** An OpenAI-compatible model that answers with everything it was sent. */
async function startEchoModel() {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => (raw += String(part)));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { messages?: Array<{ content?: unknown }> };
      const prompt = (body.messages ?? []).map((message) => (typeof message.content === "string" ? message.content : "")).join(" | ");
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "echo-1",
          object: "chat.completion",
          model: "echo",
          choices: [{ index: 0, message: { role: "assistant", content: `Noted: ${prompt}` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

interface Fixture {
  app: FastifyInstance;
  store: Store;
  spans: InMemorySpanExporter;
  cookie: string;
  secretService: SecretService;
}

async function appFixture(dbFile: string, masterKey: string, capture: boolean): Promise<Fixture> {
  const store = await openTestStore(dbFile);
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "error",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: masterKey,
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(path.dirname(dbFile), "sync"),
    TRACING_ENABLED: "true",
    ...(capture ? { OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT: "span_only", L2M_OTEL_CONTENT_MAX_CHARS: "8192" } : {})
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const spans = new InMemorySpanExporter();
  const app = await createApp(config, store, secretService, authService, undefined, undefined, undefined, {
    telemetrySpanProcessors: [exportingAtOnce(spans)],
    telemetryRegisterGlobals: false,
    logStream: { write: () => undefined }
  });
  await app.ready();
  const email = `admin-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await authService.register({ email, password: "Admin-Pass-123!", role: "admin" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Admin-Pass-123!" } });
  const cookie = String([login.headers["set-cookie"]].flat().find((value) => String(value).startsWith(`${config.SESSION_COOKIE_NAME}=`))).split(";")[0]!;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
    try {
      await store.close();
    } catch {
      // Closed by the app.
    }
  };
  cleanups.push(close);
  return { app, store, spans, cookie, secretService };
}

async function newFixture(prefix: string, capture = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  const masterKey = crypto.randomBytes(32).toString("base64");
  const dbFile = path.join(dir, "orchestrator.db");
  return { fixture: await appFixture(dbFile, masterKey, capture), dbFile, masterKey };
}

const n = (id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode =>
  ({ id, type, name: id, position: { x: 0, y: 0 }, config }) as WorkflowNode;

function flow(id: string, nodes: WorkflowNode[], edges: Array<[string, string, string?]>, extra: Partial<Workflow> = {}): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes,
    edges: edges.map(([source, target, sourceHandle], index) => ({ id: `e${index}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) })),
    ...extra
  } as Workflow;
}

/** An agent node `id` and its echo model node `${id}-model` (chat spans are named after `model`). */
function agent(id: string, prompt: string, model: string, baseUrl: string, secretId: string, sensitive = false): { nodes: WorkflowNode[]; edges: Array<[string, string, string?]> } {
  return {
    nodes: [
      n(id, "agent_orchestrator", { systemPromptTemplate: "Be brief.", userPromptTemplate: prompt, maxIterations: 2, toolCallingEnabled: false, ...(sensitive ? { sensitiveOutput: true } : {}) }),
      n(`${id}-model`, "llm_call", { provider: { providerId: "openai", model, baseUrl, secretRef: { secretId }, extra: { maxRetries: 0 } } })
    ],
    edges: [[id, `${id}-model`, "chat_model"]]
  };
}

async function api(fixture: Fixture, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  return await fixture.app.inject({ method, url, headers: { cookie: fixture.cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
}

async function execute(fixture: Fixture, workflowId: string, payload: Record<string, unknown> = {}, status = "success") {
  const response = await api(fixture, "POST", `/api/workflows/${workflowId}/execute`, payload);
  const body = response.json<{ status: string; executionId: string; error?: string; nodeResults: Array<{ nodeId: string; output?: unknown }> }>();
  expect(body.status, response.body).toBe(status);
  return body;
}

/** Chat spans named `chat ${model}`, waiting until `count` of them have ended (span ends are exported at once). */
async function chatSpans(fixture: Fixture, model: string, count = 1): Promise<ReadableSpan[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const chats = fixture.spans.getFinishedSpans().filter((span) => span.name === `chat ${model}`);
    if (chats.length >= count) return chats;
    if (Date.now() > deadline) throw new Error(`no chat spans for ${model}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function expectDropped(chats: readonly ReadableSpan[], reason: string) {
  expect(chats.length).toBeGreaterThan(0);
  for (const chat of chats) {
    expect(contentOf(chat)).toEqual([]);
    expect(chat.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe(reason);
  }
  const text = serialized(chats);
  expect(text).not.toContain(PRIVATE_VALUE);
  expect(text).not.toContain(STORED_SECRET);
}

function expectExported(chats: readonly ReadableSpan[], value: string) {
  expect(chats.length).toBeGreaterThan(0);
  expect(chats[0]!.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBeUndefined();
  expect(String(chats[0]!.attributes["gen_ai.input.messages"])).toContain(value);
}

async function seedSecret(fixture: Fixture) {
  return (await fixture.secretService.createSecret({ name: "model key", provider: "openai", value: STORED_SECRET, projectId: "default" })).secretId;
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("error workflow input from a sensitive run (v74)", () => {
  it("the error workflow of a sensitive run exports no content (sensitive_run_data) and marks what it writes; a clean run's exports it", { timeout: 30_000 }, async () => {
    const { fixture } = await newFixture("l2m-sensflow-error-");
    const baseUrl = await startEchoModel();
    const secretId = await seedSecret(fixture);
    for (const kind of ["sensitive", "clean"]) {
      // One handler per failing workflow: the error trigger's input names the failed run (its error text, run id).
      const handlerAgent = agent("handle", "Handle: {{error}}", `echo-handler-${kind}`, baseUrl, secretId);
      await fixture.store.upsertWorkflow(
        flow(
          `wf-handler-${kind}`,
          [
            n("onerror", "error_trigger"),
            ...handlerAgent.nodes,
            n("log", "session_artifact_save", { namespace: "errors", sessionIdTemplate: kind, artifactKey: "last", valueTemplate: "{{error}}" }),
            n("out", "output")
          ],
          [["onerror", "handle"], ["handle", "log"], ["log", "out"], ...handlerAgent.edges]
        )
      );
    }
    for (const sensitive of [true, false]) {
      const failing = agent("work", `Remember ${PRIVATE_VALUE} and key ${STORED_SECRET}`, "echo-model", baseUrl, secretId, sensitive);
      await fixture.store.upsertWorkflow(
        flow(
          sensitive ? "wf-fails-sensitive" : "wf-fails-clean",
          [n("start", "manual_trigger"), ...failing.nodes, n("stop", "stop_and_error", { message: `refused ${PRIVATE_VALUE}` }), n("out", "output")],
          [["start", "work"], ["work", "stop"], ["stop", "out"], ...failing.edges],
          { settings: { errorWorkflowId: sensitive ? "wf-handler-sensitive" : "wf-handler-clean" } }
        )
      );
    }

    await execute(fixture, "wf-fails-sensitive", {}, "error");
    const namespace = projectSessionNamespace("default", "errors");
    const logged = await waitFor(
      async () => await fixture.store.loadSessionArtifact({ namespace, sessionId: "sensitive", artifactKey: "last" }),
      (row) => row !== null
    );
    expect(JSON.stringify(logged?.value)).toContain(PRIVATE_VALUE);
    expect(logged?.sensitive).toBe(true);
    expectDropped(await chatSpans(fixture, "echo-handler-sensitive"), "sensitive_run_data");

    await execute(fixture, "wf-fails-clean", {}, "error");
    const cleanLog = await waitFor(
      async () => await fixture.store.loadSessionArtifact({ namespace, sessionId: "clean", artifactKey: "last" }),
      (row) => row !== null
    );
    expect(cleanLog?.sensitive).toBeUndefined();
    expectExported(await chatSpans(fixture, "echo-handler-clean"), PRIVATE_VALUE);

    // The sensitive run's own spans never held the seeded secret or the private value.
    const sensitiveChats = (await chatSpans(fixture, "echo-model", 2)).slice(0, 1);
    expect(serialized(sensitiveChats)).not.toContain(PRIVATE_VALUE);
    expect(serialized(fixture.spans.getFinishedSpans())).not.toContain(STORED_SECRET);
  });
});

/** The sensitive run: an agent flagged sensitive output whose answer holds the private value and the seeded secret. */
function sourceFlow(id: string, baseUrl: string, secretId: string): Workflow {
  const source = agent("source", `Remember ${PRIVATE_VALUE} and key ${STORED_SECRET}`, "echo-model", baseUrl, secretId, true);
  return flow(id, [n("start", "manual_trigger"), ...source.nodes, n("out", "output")], [["start", "source"], ["source", "out"], ...source.edges]);
}

/** A normal workflow whose reader agent sends the `source` node's answer to the model. */
function readerFlow(id: string, baseUrl: string, secretId: string): Workflow {
  const source = agent("source", "unused", "echo-unused", baseUrl, secretId);
  const reader = agent("reader", "Summarize {{source.answer}}", "echo-reader", baseUrl, secretId);
  return flow(
    id,
    [n("start", "manual_trigger"), ...source.nodes, ...reader.nodes, n("out", "output")],
    [["start", "source"], ["source", "reader"], ["reader", "out"], ...source.edges, ...reader.edges]
  );
}

describe("pinned data copied from a sensitive run (v74)", () => {
  it("a pin taken from a sensitive run is marked, keeps its mark through a save, and a run using it exports no content", async () => {
    const { fixture } = await newFixture("l2m-sensflow-pin-");
    const baseUrl = await startEchoModel();
    const secretId = await seedSecret(fixture);
    await fixture.store.upsertWorkflow(sourceFlow("wf-source", baseUrl, secretId));
    await fixture.store.upsertWorkflow(readerFlow("wf-reader", baseUrl, secretId));
    const source = await execute(fixture, "wf-source");
    const sourceOutput = source.nodeResults.find((entry) => entry.nodeId === "source")!.output;
    expect(JSON.stringify(sourceOutput)).toContain(PRIVATE_VALUE);
    expect(await fixture.store.getExecutionSensitive(source.executionId)).toBe(true);
    // The run's API answer carries no new field.
    expect(Object.keys((await api(fixture, "GET", `/api/executions/${source.executionId}`)).json<Record<string, unknown>>())).not.toContain("sensitive");

    const pinned = await api(fixture, "PUT", "/api/workflows/wf-reader/pins/source", { data: sourceOutput, executionId: source.executionId });
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect((await fixture.store.getWorkflow("wf-reader"))?.pinnedDataSensitive).toEqual(["source"]);
    // A save from a client that does not know the field keeps the mark while the pinned data is unchanged.
    const stored = (await fixture.store.getWorkflow("wf-reader"))!;
    const { pinnedDataSensitive: _dropped, ...withoutMarks } = stored;
    expect((await api(fixture, "PUT", "/api/workflows/wf-reader", withoutMarks)).statusCode).toBe(200);
    expect((await fixture.store.getWorkflow("wf-reader"))?.pinnedDataSensitive).toEqual(["source"]);

    await execute(fixture, "wf-reader", { usePinnedData: true });
    // The pinned node's output carries the `sensitive` label, so the agent's own check drops its content first.
    expectDropped(await chatSpans(fixture, "echo-reader"), "sensitive");
    expect((await fixture.spans.getFinishedSpans()).some((span) => span.name === "chat echo-unused")).toBe(false);

    // The same data pinned by hand (no run named) is not marked, and is exported as before.
    const byHand = await api(fixture, "PUT", "/api/workflows/wf-reader/pins/source", { data: { answer: "hand-written note Qz11" } });
    expect(byHand.statusCode).toBe(200);
    expect((await fixture.store.getWorkflow("wf-reader"))?.pinnedDataSensitive).toBeUndefined();
    await execute(fixture, "wf-reader", { usePinnedData: true });
    expectExported([(await chatSpans(fixture, "echo-reader", 2))[1]!], "hand-written note Qz11");
    expect(serialized(fixture.spans.getFinishedSpans())).not.toContain(STORED_SECRET);
  });

  it("a run made while capture was off is marked, so a pin taken from it later is marked too", async () => {
    const off = await newFixture("l2m-sensflow-pin-off-", false);
    const baseUrl = await startEchoModel();
    const secretId = await seedSecret(off.fixture);
    await off.fixture.store.upsertWorkflow(sourceFlow("wf-source", baseUrl, secretId));
    await off.fixture.store.upsertWorkflow(readerFlow("wf-reader", baseUrl, secretId));
    const source = await execute(off.fixture, "wf-source");
    const sourceOutput = source.nodeResults.find((entry) => entry.nodeId === "source")!.output;
    // Capture off: the run's record is marked all the same (its output labels say sensitive).
    expect(await off.fixture.store.getExecutionSensitive(source.executionId)).toBe(true);
    await off.fixture.app.close();

    const on = await appFixture(off.dbFile, off.masterKey, true);
    const pinned = await api(on, "PUT", "/api/workflows/wf-reader/pins/source", { data: sourceOutput, executionId: source.executionId });
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect((await on.store.getWorkflow("wf-reader"))?.pinnedDataSensitive).toEqual(["source"]);
    await execute(on, "wf-reader", { usePinnedData: true });
    expectDropped(await chatSpans(on, "echo-reader"), "sensitive");
  });
});

describe("node outputs copied from a sensitive run (v74)", () => {
  it("a single-node run with outputs from a sensitive run, and a run from that source execution, export no content", async () => {
    const { fixture } = await newFixture("l2m-sensflow-copy-");
    const baseUrl = await startEchoModel();
    const secretId = await seedSecret(fixture);
    await fixture.store.upsertWorkflow(sourceFlow("wf-source", baseUrl, secretId));
    await fixture.store.upsertWorkflow(readerFlow("wf-reader", baseUrl, secretId));
    const source = await execute(fixture, "wf-source");
    const sourceOutput = source.nodeResults.find((entry) => entry.nodeId === "source")!.output;

    // The editor's single-node run names the run its outputs came from.
    await execute(fixture, "wf-reader", { runMode: "single_node", startNodeId: "reader", nodeOutputs: { source: sourceOutput }, nodeOutputsExecutionId: source.executionId });
    expectDropped(await chatSpans(fixture, "echo-reader"), "sensitive_run_data");

    // A run from the source execution (its input and outputs copied by the server).
    await execute(fixture, "wf-reader", { runMode: "single_node", startNodeId: "reader", sourceExecutionId: source.executionId });
    expectDropped(await chatSpans(fixture, "echo-reader", 2), "sensitive_run_data");

    // The same outputs given without naming a run are the caller's own input: exported as before.
    await execute(fixture, "wf-reader", { runMode: "single_node", startNodeId: "reader", nodeOutputs: { source: { answer: "typed by hand Vb27" } } });
    expectExported([(await chatSpans(fixture, "echo-reader", 3))[2]!], "typed by hand Vb27");
    expect(serialized(fixture.spans.getFinishedSpans())).not.toContain(STORED_SECRET);
  });
});

describe("knowledge base chunks from a sensitive run (v74)", () => {
  /** Adds `text` to the knowledge base `kb` through a run; `sensitive` flags the retrieve node's output sensitive. */
  const writer = (id: string, kb: string, text: string, sensitive: boolean) =>
    flow(
      id,
      [
        n("start", "manual_trigger"),
        n("ingest", "rag_retrieve", {
          queryTemplate: "ledger",
          topK: 1,
          vectorStoreId: "knowledge-base",
          vectorStoreConfig: { knowledgeBaseId: kb },
          documents: [{ id: `${kb}-doc`, text }],
          ...(sensitive ? { sensitiveOutput: true } : {})
        }),
        n("out", "output")
      ],
      [["start", "ingest"], ["ingest", "out"]]
    );
  const reader = (id: string, kb: string, baseUrl: string, secretId: string) => {
    const ask = agent("ask", "Answer from {{retrieve.context}}", `echo-${kb}`, baseUrl, secretId);
    return flow(
      id,
      [
        n("start", "manual_trigger"),
        n("retrieve", "rag_retrieve", { queryTemplate: "ledger note", topK: 1, vectorStoreId: "knowledge-base", vectorStoreConfig: { knowledgeBaseId: kb } }),
        ...ask.nodes,
        n("keep", "session_artifact_save", { namespace: "kb-notes", sessionIdTemplate: kb, artifactKey: "answer", valueTemplate: "{{ask.answer}}" }),
        n("out", "output")
      ],
      [["start", "retrieve"], ["retrieve", "ask"], ["ask", "keep"], ["keep", "out"], ...ask.edges]
    );
  };

  it("chunks a sensitive run added (even with capture off) keep a later run's content out; a clean run's do not", async () => {
    const off = await newFixture("l2m-sensflow-kb-", false);
    const baseUrl = await startEchoModel();
    const secretId = await seedSecret(off.fixture);
    for (const kb of ["kb-sensitive", "kb-clean"]) {
      await off.fixture.store.createKnowledgeBase({ id: kb, name: kb, projectId: "default", embedderId: "token-embedder" });
    }
    await off.fixture.store.upsertWorkflow(writer("wf-kb-write-sensitive", "kb-sensitive", `ledger note ${PRIVATE_VALUE}`, true));
    await off.fixture.store.upsertWorkflow(writer("wf-kb-write-clean", "kb-clean", "ledger note public-Cc40", false));
    await off.fixture.store.upsertWorkflow(reader("wf-kb-read-sensitive", "kb-sensitive", baseUrl, secretId));
    await off.fixture.store.upsertWorkflow(reader("wf-kb-read-clean", "kb-clean", baseUrl, secretId));
    await execute(off.fixture, "wf-kb-write-sensitive");
    await execute(off.fixture, "wf-kb-write-clean");
    expect((await off.fixture.store.listKnowledgeBaseChunks("kb-sensitive")).map((chunk) => chunk.sensitive)).toEqual([true]);
    expect((await off.fixture.store.listKnowledgeBaseChunks("kb-clean")).map((chunk) => chunk.sensitive)).toEqual([undefined]);
    await off.fixture.app.close();

    const on = await appFixture(off.dbFile, off.masterKey, true);
    await execute(on, "wf-kb-read-sensitive");
    // The retrieve node's output carries the `sensitive` label, so the agent's own check drops its content first.
    expectDropped(await chatSpans(on, "echo-kb-sensitive"), "sensitive");
    const namespace = projectSessionNamespace("default", "kb-notes");
    const kept = await on.store.loadSessionArtifact({ namespace, sessionId: "kb-sensitive", artifactKey: "answer" });
    expect(JSON.stringify(kept?.value)).toContain(PRIVATE_VALUE);
    expect(kept?.sensitive).toBe(true);

    await execute(on, "wf-kb-read-clean");
    expectExported(await chatSpans(on, "echo-kb-clean"), "public-Cc40");
    expect((await on.store.loadSessionArtifact({ namespace, sessionId: "kb-clean", artifactKey: "answer" }))?.sensitive).toBeUndefined();
    expect(serialized(on.spans.getFinishedSpans())).not.toContain(STORED_SECRET);
  });
});
