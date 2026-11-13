/**
 * v73 end to end: session memory written by a sensitive run is marked, and a later run that is not sensitive itself
 * exports no content once it reads that memory (`l2m.content.dropped` = `sensitive_memory`), whether capture was on or
 * off when the memory was written. The same workflow on a session without such memory exports masked content as before.
 * The model is an in-process echo server on 127.0.0.1; no model server is called.
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
import { CONTENT_DROPPED_ATTRIBUTE, type Workflow } from "@ai-orchestrator/shared";
import { createApp } from "../app.js";
import { parseConfig } from "../config.js";
import type { Store } from "../db/store.js";
import { AuthService } from "../services/auth-service.js";
import { SecretService } from "../services/secret-service.js";
import { projectSessionNamespace } from "../run-scope.js";
import { openTestStore } from "../test-support/test-store.js";

/** Seeded in the secret store and written into the sensitive run's memory: never in any exported span. */
const STORED_SECRET = "stored-secret-Mm71-Kq2w-55Zr";
/** A private value only the sensitive run's prompt holds (no masker knows it): never in any exported span. */
const PRIVATE_VALUE = "private-account-note-Tt48-Yy03";
const NAMESPACE = "shared-mem";
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

/** An OpenAI-compatible model that answers with everything it was sent, so memory shows up in its answers too. */
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

/** The API on `dbFile` (created when new), with tracing on and content capture as `capture` says. */
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

/** An agent with Simple Memory on the shared namespace; `sensitive` sets the agent's "Sensitive output" flag. */
function memoryWorkflow(id: string, baseUrl: string, secretId: string, prompt: string, sensitive: boolean): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      {
        id: "agent",
        type: "agent_orchestrator",
        name: "Agent",
        position: { x: 150, y: 0 },
        config: { systemPromptTemplate: "Be brief.", userPromptTemplate: prompt, maxIterations: 2, toolCallingEnabled: false, ...(sensitive ? { sensitiveOutput: true } : {}) }
      },
      {
        id: "model",
        type: "llm_call",
        name: "Model",
        position: { x: 150, y: 160 },
        config: { provider: { providerId: "openai", model: "echo-model", baseUrl, secretRef: { secretId }, extra: { maxRetries: 0 } } }
      },
      { id: "memory", type: "local_memory", name: "Memory", position: { x: 300, y: 160 }, config: { namespace: NAMESPACE, sessionIdTemplate: "{{session_id}}" } },
      { id: "output", type: "output", name: "Output", position: { x: 450, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "start", target: "agent" },
      { id: "e2", source: "agent", target: "output" },
      { id: "e3", source: "agent", sourceHandle: "chat_model", target: "model" },
      { id: "e4", source: "agent", sourceHandle: "memory", target: "memory" }
    ]
  } as Workflow;
}

async function execute(fixture: Fixture, workflowId: string, sessionId: string) {
  const response = await fixture.app.inject({ method: "POST", url: `/api/workflows/${workflowId}/execute`, headers: { cookie: fixture.cookie }, payload: { session_id: sessionId } });
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<{ status: string; executionId: string }>();
  expect(body.status, response.body).toBe("success");
  return body;
}

/** The spans of one run (by its execution id on the run span's trace), after the masking queue drained. */
async function runSpans(fixture: Fixture, executionId: string): Promise<ReadableSpan[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const all = fixture.spans.getFinishedSpans();
    const root = all.find((span) => span.attributes["l2m.execution.id"] === executionId && span.name.startsWith("invoke_workflow"));
    const traceId = root?.spanContext().traceId;
    const chats = traceId ? all.filter((span) => span.spanContext().traceId === traceId && span.name === "chat echo-model") : [];
    if (traceId && chats.length > 0) return all.filter((span) => span.spanContext().traceId === traceId);
    if (Date.now() > deadline) throw new Error(`no spans for ${executionId}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function expectNoPrivateValues(spans: readonly ReadableSpan[]) {
  const text = serialized(spans);
  expect(text).not.toContain(PRIVATE_VALUE);
  expect(text).not.toContain(STORED_SECRET);
}

async function setup(fixture: Fixture) {
  const baseUrl = await startEchoModel();
  const { secretId } = await fixture.secretService.createSecret({ name: "model key", provider: "openai", value: STORED_SECRET, projectId: "default" });
  const sensitivePrompt = `Remember ${PRIVATE_VALUE} and key ${STORED_SECRET}`;
  await fixture.store.upsertWorkflow(memoryWorkflow("wf-sensitive", baseUrl, secretId, sensitivePrompt, true));
  await fixture.store.upsertWorkflow(memoryWorkflow("wf-normal", baseUrl, secretId, "What did I ask you to remember?", false));
}

describe("content capture and memory written by a sensitive run (v73)", () => {
  it("a later normal run that reads it exports no content (sensitive_memory); a fresh session still exports masked content", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-sensmem-"));
    cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const masterKey = crypto.randomBytes(32).toString("base64");
    const fixture = await appFixture(path.join(dir, "orchestrator.db"), masterKey, true);
    await setup(fixture);

    const sensitive = await execute(fixture, "wf-sensitive", "chat-1");
    const sensitiveSpans = await runSpans(fixture, sensitive.executionId);
    for (const chat of sensitiveSpans.filter((span) => span.name === "chat echo-model")) {
      expect(chat.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("sensitive");
    }
    const namespace = projectSessionNamespace("default", NAMESPACE);
    expect(JSON.stringify(await fixture.store.loadSessionMemory(namespace, "chat-1"))).toContain(PRIVATE_VALUE);
    expect(await fixture.store.loadSessionMemorySensitive(namespace, "chat-1")).toBe(true);

    const later = await execute(fixture, "wf-normal", "chat-1");
    const laterSpans = await runSpans(fixture, later.executionId);
    const chats = laterSpans.filter((span) => span.name === "chat echo-model");
    expect(chats.length).toBeGreaterThan(0);
    for (const chat of chats) {
      expect(contentOf(chat)).toEqual([]);
      expect(chat.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("sensitive_memory");
    }
    expect(laterSpans.filter((span) => contentOf(span).length > 0)).toEqual([]);
    // Memory itself kept working: the later run read it (the echo shows it) and saved its turn, still marked.
    const memory = JSON.stringify(await fixture.store.loadSessionMemory(namespace, "chat-1"));
    expect(memory).toContain("What did I ask you to remember?");
    expect(memory).toContain(PRIVATE_VALUE);
    expect(await fixture.store.loadSessionMemorySensitive(namespace, "chat-1")).toBe(true);

    // The same workflow on a session without that memory exports its (masked) content.
    const fresh = await execute(fixture, "wf-normal", "chat-2");
    const freshChat = (await runSpans(fixture, fresh.executionId)).find((span) => span.name === "chat echo-model")!;
    expect(freshChat.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBeUndefined();
    expect(String(freshChat.attributes["gen_ai.input.messages"])).toContain("What did I ask you to remember?");
    expect(await fixture.store.loadSessionMemorySensitive(namespace, "chat-2")).toBe(false);

    await fixture.app.close();
    expectNoPrivateValues(fixture.spans.getFinishedSpans());
  });

  it("memory written by a sensitive run while capture was off stays out once capture is turned on", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-sensmem-off-"));
    cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const masterKey = crypto.randomBytes(32).toString("base64");
    const dbFile = path.join(dir, "orchestrator.db");
    const off = await appFixture(dbFile, masterKey, false);
    await setup(off);
    const sensitive = await execute(off, "wf-sensitive", "chat-1");
    const offSpans = await runSpans(off, sensitive.executionId);
    // Capture off: no content and no drop marker, as before.
    for (const span of offSpans) {
      expect(contentOf(span)).toEqual([]);
      expect(span.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBeUndefined();
    }
    const namespace = projectSessionNamespace("default", NAMESPACE);
    expect(await off.store.loadSessionMemorySensitive(namespace, "chat-1")).toBe(true);
    await off.app.close();
    try {
      await off.store.close();
    } catch {
      // Closed by the app.
    }

    const on = await appFixture(dbFile, masterKey, true);
    const later = await execute(on, "wf-normal", "chat-1");
    const chats = (await runSpans(on, later.executionId)).filter((span) => span.name === "chat echo-model");
    expect(chats.length).toBeGreaterThan(0);
    for (const chat of chats) {
      expect(contentOf(chat)).toEqual([]);
      expect(chat.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("sensitive_memory");
    }
    await on.app.close();
    expectNoPrivateValues(on.spans.getFinishedSpans());
  });
});
