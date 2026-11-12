/**
 * Optional content capture on OpenTelemetry spans (OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT), with the real SDK in
 * memory and the API's real masker: content is exported only after secret removal and content-rule masking; secret
 * values seeded in the secret store, the environment and the OTLP headers never appear in any exported span; sensitive
 * runs, a failed masking and capture turned off export no content. The model is scripted or an in-process server on
 * 127.0.0.1; no model server is called.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { MCPRegistry, MockMCPServerAdapter, createInstrumentedMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import {
  createOtelRuntime,
  DEFAULT_BATCH_OPTIONS,
  InMemorySpanExporter,
  type ContentCaptureMode,
  type OtelRuntime,
  type ReadableSpan,
  type SpanProcessor
} from "@ai-orchestrator/otel";
import { createInstrumentedProviderRegistry, ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import { CONTENT_DROPPED_ATTRIBUTE, type LLMCallResponse, type MCPServerConfig, type Workflow, type WorkflowEdge, type WorkflowNode } from "@ai-orchestrator/shared";
import { executeWorkflow, type WorkflowExecutionDependencies } from "@ai-orchestrator/workflow-engine";
import { createApp } from "../app.js";
import { parseConfig } from "../config.js";
import type { Store } from "../db/store.js";
import { AuthService } from "../services/auth-service.js";
import { SecretService } from "../services/secret-service.js";
import { openTestStore } from "../test-support/test-store.js";
import { OtelContentMasker, deriveOtelContentSurrogateKey } from "./content-masker.js";

/** Personal data content rules must mask (built-in classes and a dictionary term). */
const EMAIL = "jane.roe@example.org";
const SSN = "536-22-8471";
const CODENAME = "Project Bluefinch";
/** Secret values seeded where the deployment keeps them: none may ever appear in an exported span. */
const STORED_SECRET = "stored-secret-Qz81-vT6c-77Lm";
const LIVE_SECRET = "created-after-start-Zx41-9Kd0";
const ENV_SECRET = "env-provider-key-Wq52-1Rr9";
const HEADER_SECRET = "otlp-header-token-Pe33-4Uu8";
const UPSTREAM_KEY = "sk-upstream-capture-55aa";
const SECRETS = [STORED_SECRET, LIVE_SECRET, ENV_SECRET, HEADER_SECRET, UPSTREAM_KEY];
const PERSONAL = [EMAIL, SSN, CODENAME];

const CONTENT_ATTRIBUTE_NAMES = [
  "gen_ai.system_instructions",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.tool.definitions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result"
];

function exportingAtOnce(exporter: InMemorySpanExporter): SpanProcessor {
  return {
    onStart: () => undefined,
    onEnd: (span) => exporter.export([span], () => undefined),
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve()
  };
}

const serialized = (spans: readonly ReadableSpan[]) => JSON.stringify(spans.map((span) => [span.name, span.attributes, span.events, span.status, span.links]));

/** Every exported byte is free of the seeded secrets (and, unless allowed, of the personal data). */
function expectClean(spans: readonly ReadableSpan[]) {
  const text = serialized(spans);
  for (const secret of SECRETS) expect(text, `secret ${secret} leaked`).not.toContain(secret);
  for (const value of PERSONAL) expect(text, `${value} leaked`).not.toContain(value);
}

const contentOf = (span: ReadableSpan) => CONTENT_ATTRIBUTE_NAMES.filter((name) => span.attributes[name] !== undefined);

// ---------------------------------------------------------------------------
// Engine runs with the real masker
// ---------------------------------------------------------------------------

class ScriptedProvider implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  constructor(private readonly answer: (request: ProviderCallRequest) => LLMCallResponse) {}
  async generate(request: ProviderCallRequest): Promise<LLMCallResponse> {
    return this.answer(request);
  }
}

const REGISTRY_ID = "mcp_mock";
const registryConfig: MCPServerConfig = { serverId: "mock-mcp", registryServerId: REGISTRY_ID, label: "Mock", connection: {} };
const node = (id: string, type: string, config: Record<string, unknown> = {}, name = id): WorkflowNode => ({
  id,
  type: type as WorkflowNode["type"],
  name,
  position: { x: 0, y: 0 },
  config
});
const edge = (source: string, target: string, sourceHandle?: string): WorkflowEdge => ({
  id: `${source}-${sourceHandle ?? "main"}-${target}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {})
});
const MODEL = { provider: { providerId: "scripted", model: "m-7" } };

/** Calls the mock MCP clock tool once (with personal data and a secret in the arguments), then answers with them. */
const agentAnswer = (request: ProviderCallRequest): LLMCallResponse =>
  request.messages.some((message) => message.role === "tool")
    ? { content: `Done for ${EMAIL} (SSN ${SSN}) using ${STORED_SECRET} on ${CODENAME}`, toolCalls: [], finishReason: "stop" }
    : { content: "", toolCalls: [{ id: "call-1", name: "mock-mcp__get_current_time", arguments: { tz: "UTC", note: `${EMAIL} ${LIVE_SECRET} ${CODENAME}` } }] };

function agentWorkflow(id: string, agentConfig: Record<string, unknown> = {}): Workflow {
  return {
    id,
    name: `Flow ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      node("hook", "webhook_input"),
      node("agent", "agent_orchestrator", { systemPromptTemplate: `Help. Key ${ENV_SECRET}.`, userPromptTemplate: "{{user_prompt}}", maxIterations: 4, ...agentConfig }, "Helper"),
      node("model", "llm_call", MODEL),
      node("tools", "mcp_tool", { registryServerId: REGISTRY_ID, toolName: "__all__" }),
      node("out", "output")
    ],
    edges: [edge("hook", "agent"), edge("agent", "out"), edge("agent", "model", "chat_model"), edge("agent", "tools", "tool")]
  };
}

const PROMPT = `Write to ${EMAIL}, SSN ${SSN}, about ${CODENAME}; header ${HEADER_SECRET}`;

const runtimes: OtelRuntime[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function engineHarness(options: { mode?: ContentCaptureMode | null; maxChars?: number; failDictionaries?: boolean } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-otel-content-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  cleanups.push(async () => {
    try {
      await store.close();
    } catch {
      // Already closed.
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const secretService = new SecretService(store, crypto.randomBytes(32).toString("base64"));
  await secretService.createSecret({ name: "stored", provider: "openai", value: STORED_SECRET });
  const masker = new OtelContentMasker({
    key: deriveOtelContentSurrogateKey(crypto.randomBytes(32)),
    storedSecretValues: () => secretService.valuesForScrubbing(),
    otherSecretValues: () => [ENV_SECRET, HEADER_SECRET],
    dictionaries: async () => {
      if (options.failDictionaries) throw new Error("rule sets unreadable");
      return [{ dataClass: "codename", terms: [CODENAME], patterns: [], score: 0.9 }];
    },
    redact: (value) => value
  });
  secretService.onSecretValue((values) => masker.addSecretValues(values));
  const exporter = new InMemorySpanExporter();
  const runtime = createOtelRuntime({
    resourceAttributes: { "service.name": "l2m-test" },
    export: null,
    sampler: { name: "parentbased_always_on" },
    propagators: ["tracecontext"],
    batch: DEFAULT_BATCH_OPTIONS,
    attributeValueLengthLimit: 8192,
    spanDetail: "standard",
    naming: "names",
    propagateToProviders: false,
    propagateToMcp: true,
    semconvOptIn: [],
    recentSpanLimit: 100,
    spanProcessors: [exportingAtOnce(exporter)],
    registerGlobals: false,
    ...(options.mode === null ? {} : { content: { mode: options.mode ?? "SPAN_ONLY", maxChars: options.maxChars ?? 8192, masker: masker.mask } })
  });
  runtimes.push(runtime);
  const inst = runtime.instrumentation;
  // The secret is created after start-up: the masker learns it from the secret service at once.
  await secretService.createSecret({ name: "live", provider: "openai", value: LIVE_SECRET });
  const run = async (wf: Workflow, extra: Partial<WorkflowExecutionDependencies> = {}, request: Partial<Parameters<typeof executeWorkflow>[0]> = {}) => {
    const base = new ProviderRegistry();
    base.register(new ScriptedProvider(agentAnswer));
    const mcp = new MCPRegistry();
    mcp.register(new MockMCPServerAdapter());
    const deps: WorkflowExecutionDependencies = {
      providerRegistry: createInstrumentedProviderRegistry(base, { instrument: inst }),
      mcpRegistry: createInstrumentedMCPRegistry(mcp, inst),
      connectorRegistry: createDefaultConnectorRegistry(),
      agentRuntime: new DefaultAgentRuntime(),
      resolveSecret: async () => undefined,
      resolveRegisteredMcpServer: () => registryConfig,
      instrument: inst,
      ...extra
    };
    const result = await inst.run({ executionId: `exec-${wf.id}`, workflowId: wf.id }, async () =>
      executeWorkflow({ workflow: wf, executionId: `exec-${wf.id}`, webhookPayload: { user_prompt: PROMPT }, ...request }, deps)
    );
    await runtime.forceFlush();
    return result;
  };
  const spans = () => exporter.getFinishedSpans();
  const named = (name: string) => spans().filter((span) => span.name === name);
  return { run, spans, named, inst, registryConfig: () => registryConfig };
}

describe("content capture in workflow runs", () => {
  it("exports masked prompts, answers and tool arguments and results, and never a seeded secret", async () => {
    const h = await engineHarness();
    const result = await h.run(agentWorkflow("capture"));
    expect(result.status).toBe("success");
    const chats = h.named("chat m-7");
    expect(chats).toHaveLength(2);
    for (const chat of chats) {
      expect(chat.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBeUndefined();
      expect(contentOf(chat)).toEqual(expect.arrayContaining(["gen_ai.system_instructions", "gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.tool.definitions"]));
      expect(chat.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBeUndefined();
      for (const name of contentOf(chat)) expect(() => JSON.parse(String(chat.attributes[name]))).not.toThrow();
    }
    // Masking happened: the content is there, with surrogates and [REDACTED] where the values were.
    const firstInput = JSON.parse(String(chats[0]!.attributes["gen_ai.input.messages"]));
    expect(firstInput[0].role).toBe("user");
    const promptText = String(firstInput[0].parts[0].content);
    expect(promptText).toContain("Write to ");
    expect(promptText).toContain("[REDACTED]");
    expect(String(chats[0]!.attributes["gen_ai.system_instructions"])).toContain("[REDACTED]");
    const finalAnswer = String(chats[1]!.attributes["gen_ai.output.messages"]);
    expect(finalAnswer).toContain("Done for ");
    // Surrogates are stable: the same email gets the same surrogate in the prompt and the answer.
    const surrogate = /Write to (\S+),/.exec(promptText)![1]!;
    expect(surrogate).not.toBe(EMAIL);
    expect(finalAnswer).toContain(surrogate);

    const tool = h.named("execute_tool mock-mcp__get_current_time")[0]!;
    expect(contentOf(tool)).toEqual(["gen_ai.tool.call.arguments", "gen_ai.tool.call.result"]);
    expect(JSON.parse(String(tool.attributes["gen_ai.tool.call.arguments"])).tz).toBe("UTC");
    const mcp = h.named("tools/call get_current_time")[0]!;
    // Recorded once: the agent's tool span carries the call as the agent kept it (after its labels and content rules).
    expect(contentOf(mcp)).toEqual([]);

    expectClean(h.spans());
  });

  it("exports no content at all for a run with a sensitive-labelled node", async () => {
    const h = await engineHarness();
    expect((await h.run(agentWorkflow("sensitive-node", { sensitiveOutput: true }))).status).toBe("success");
    const withContentSpans = h.spans().filter((span) => contentOf(span).length > 0);
    expect(withContentSpans).toEqual([]);
    for (const chat of h.named("chat m-7")) expect(chat.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("sensitive");
    expect(h.named("execute_tool mock-mcp__get_current_time")[0]!.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("sensitive");
    expectClean(h.spans());
  });

  it("treats a run as sensitive when a registered server could not be checked at its start", async () => {
    const h = await engineHarness();
    let lookups = 0;
    const result = await h.run(agentWorkflow("unresolved"), {
      sensitiveSecretIds: new Set(["flagged-elsewhere"]),
      // The run-start check fails; the node's own lookup later works.
      resolveRegisteredMcpServer: () => {
        lookups += 1;
        if (lookups === 1) throw new Error("registry unavailable");
        return h.registryConfig();
      }
    });
    expect(result.status).toBe("success");
    expect(h.spans().filter((span) => contentOf(span).length > 0)).toEqual([]);
    expect(h.named("chat m-7").every((span) => span.attributes[CONTENT_DROPPED_ATTRIBUTE] === "sensitive")).toBe(true);
  });

  it("exports no content for a run that uses a secret flagged as sensitive output", async () => {
    const h = await engineHarness();
    const wf = agentWorkflow("sensitive-secret");
    wf.nodes = wf.nodes.map((entry) => (entry.id === "model" ? { ...entry, config: { ...entry.config, provider: { ...MODEL.provider, secretRef: { secretId: "sec_flagged" } } } } : entry));
    expect((await h.run(wf, { sensitiveSecretIds: new Set(["sec_flagged"]) })).status).toBe("success");
    expect(h.spans().filter((span) => contentOf(span).length > 0)).toEqual([]);
    expect(h.named("chat m-7").every((span) => span.attributes[CONTENT_DROPPED_ATTRIBUTE] === "sensitive")).toBe(true);
    expectClean(h.spans());
  });

  it("exports no model or tool content for a run whose input is labelled sensitive", async () => {
    const h = await engineHarness();
    const result = await h.run(agentWorkflow("sensitive-input"), {}, { inputLabels: { provenance: ["user", "sensitive"], dataClasses: [], source: "propagated" } });
    expect(result.status).toBe("success");
    expect(h.spans().filter((span) => contentOf(span).length > 0)).toEqual([]);
    expect(h.named("chat m-7").every((span) => span.attributes[CONTENT_DROPPED_ATTRIBUTE] === "sensitive")).toBe(true);
    expectClean(h.spans());
  });

  it("drops every span's content when masking fails, and the run is unaffected", async () => {
    const h = await engineHarness({ failDictionaries: true });
    expect((await h.run(agentWorkflow("mask-fails"))).status).toBe("success");
    expect(h.spans().filter((span) => contentOf(span).length > 0)).toEqual([]);
    const dropped = h.spans().filter((span) => span.attributes[CONTENT_DROPPED_ATTRIBUTE] === "masking_failed");
    expect(dropped.length).toBeGreaterThanOrEqual(3);
    expectClean(h.spans());
  });

  it("exports no content and no drop marker while capture is off", async () => {
    const h = await engineHarness({ mode: null });
    expect(h.inst.capturesContent).toBe(false);
    expect((await h.run(agentWorkflow("off"))).status).toBe("success");
    expect(h.spans().length).toBeGreaterThan(4);
    for (const span of h.spans()) {
      expect(contentOf(span)).toEqual([]);
      expect(span.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBeUndefined();
    }
    expectClean(h.spans());
  });

  it("truncates after masking, so a cut never exposes part of a value", async () => {
    const h = await engineHarness({ maxChars: 256 });
    expect((await h.run(agentWorkflow("short"))).status).toBe("success");
    for (const span of h.spans()) {
      for (const name of contentOf(span)) {
        const text = String(span.attributes[name]);
        expect(text.length).toBeLessThanOrEqual(256);
        expect(() => JSON.parse(text)).not.toThrow();
      }
    }
    expectClean(h.spans());
    // No prefix of a seeded value long enough to identify it survives either.
    const text = serialized(h.spans());
    for (const value of [...SECRETS, EMAIL]) expect(text).not.toContain(value.slice(0, 12));
  });
});

// ---------------------------------------------------------------------------
// The API: settings, boot, /api/observability, the audit event and /v1 with stored secrets
// ---------------------------------------------------------------------------

interface Fixture {
  app: FastifyInstance;
  store: Store;
  admin: string;
  spans: InMemorySpanExporter;
  secretService: SecretService;
  base: string;
}

async function startUpstream() {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => (raw += String(part)));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { messages?: Array<{ content?: string }> };
      // Echoes the prompt back, so the answer carries the planted values too.
      const prompt = body.messages?.map((message) => message.content ?? "").join(" ") ?? "";
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "up-1",
          object: "chat.completion",
          model: "up-model",
          choices: [{ index: 0, message: { role: "assistant", content: `You said: ${prompt}` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

async function appFixture(env: Record<string, string>): Promise<Fixture> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-otel-content-app-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "error",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    OPENAI_API_KEY: ENV_SECRET,
    OTEL_EXPORTER_OTLP_HEADERS: `authorization=Bearer%20${HEADER_SECRET}`,
    ...env
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const spans = new InMemorySpanExporter();
  const app = await createApp(config, store, secretService, authService, undefined, undefined, undefined, {
    telemetrySpanProcessors: [exportingAtOnce(spans)],
    telemetryRegisterGlobals: false,
    logStream: { write: () => undefined }
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  await authService.register({ email: "admin@example.com", password: "Admin-Pass-123!", role: "admin" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "Admin-Pass-123!" } });
  const admin = String([login.headers["set-cookie"]].flat().find((value) => String(value).startsWith(`${config.SESSION_COOKIE_NAME}=`))).split(";")[0]!;
  cleanups.push(async () => {
    await app.close();
    try {
      await store.close();
    } catch {
      // Closed by the app.
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { app, store, admin, spans, secretService, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

async function api<T = Record<string, unknown>>(fixture: Fixture, method: string, url: string, payload?: unknown) {
  const response = await fixture.app.inject({ method: method as "GET", url, headers: { cookie: fixture.admin }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: response.statusCode, body: (response.body ? response.json() : null) as T, raw: response.body };
}

async function until<T>(read: () => T | Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("content capture in the API", () => {
  it("reports NO_CONTENT and records no audit event by default", async () => {
    const fixture = await appFixture({ TRACING_ENABLED: "true" });
    const observability = await api<{ tracing: { contentCapture: string; contentMaxChars: number | null } }>(fixture, "GET", "/api/observability");
    expect(observability.body.tracing.contentCapture).toBe("NO_CONTENT");
    expect(observability.body.tracing.contentMaxChars).toBeNull();
    const audit = await api<{ items: Array<{ eventType: string }> }>(fixture, "GET", "/api/audit?eventType=telemetry.content_capture_enabled");
    expect(audit.body.items ?? []).toEqual([]);
  });

  it("reports the mode, records the audit event and masks /v1 content with the deployment's stored and environment secrets", async () => {
    const fixture = await appFixture({ TRACING_ENABLED: "true", OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT: "span_only", L2M_OTEL_CONTENT_MAX_CHARS: "4096" });
    const observability = await api<{ tracing: { contentCapture: string; contentMaxChars: number } }>(fixture, "GET", "/api/observability");
    expect(observability.body.tracing).toMatchObject({ contentCapture: "SPAN_ONLY", contentMaxChars: 4096 });
    const audit = await until(async () => {
      const listed = await api<{ items: Array<{ eventType: string; metadata: unknown }> }>(fixture, "GET", "/api/audit?eventType=telemetry.content_capture_enabled");
      return listed.body.items?.length ? listed.body.items : null;
    }, "the audit event");
    expect(audit[0]!.metadata).toMatchObject({ mode: "SPAN_ONLY", maxChars: 4096 });

    const upstream = await startUpstream();
    cleanups.push(upstream.close);
    await fixture.secretService.createSecret({ name: "plain", provider: "openai", value: STORED_SECRET, projectId: "default" });
    const { secretId } = await fixture.secretService.createSecret({ name: "upstream", provider: "openai_compatible", value: UPSTREAM_KEY, projectId: "default" });
    const set = await api<{ id: string }>(fixture, "POST", "/api/ai-gateway/route-sets", { name: "Apps", projectId: "default" });
    expect((await api(fixture, "POST", `/api/ai-gateway/route-sets/${set.body.id}/routes`, { alias: "gpt-test", providerId: "openai_compatible", model: "up-model", baseUrl: upstream.baseUrl, secretRef: { secretId } })).status).toBe(201);
    const client = await api<{ client: { id: string }; token: string }>(fixture, "POST", "/api/mcp/clients", { name: "App", toolsetIds: [], role: "builder" });
    expect((await api(fixture, "PUT", `/api/ai-gateway/clients/${client.body.client.id}/grants`, { routeSetIds: [set.body.id] })).status).toBe(200);

    const prompt = `Mail ${EMAIL} SSN ${SSN}; keys ${STORED_SECRET} ${UPSTREAM_KEY} ${ENV_SECRET} ${HEADER_SECRET}`;
    const response = await fetch(`${fixture.base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${client.body.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: prompt }] })
    });
    expect(response.status).toBe(200);
    const chat = await until(() => fixture.spans.getFinishedSpans().find((span) => span.name === "chat up-model"), "the chat span");
    expect(chat.attributes["gen_ai.system_instructions"]).toBe('[{"type":"text","content":"Be brief."}]');
    const input = String(chat.attributes["gen_ai.input.messages"]);
    expect(input).toContain("Mail ");
    expect(input).toContain("[REDACTED]");
    expect(String(chat.attributes["gen_ai.output.messages"])).toContain("You said: Be brief. Mail ");
    const all = await until(async () => {
      await fixture.app.close();
      return fixture.spans.getFinishedSpans();
    }, "all spans");
    expectClean(all);
  });

  it("captures nothing without the master key's surrogate key and says so", async () => {
    const { resolveTelemetrySettings } = await import("./settings.js");
    const settings = resolveTelemetrySettings(parseConfig({ TRACING_ENABLED: "true", OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT: "SPAN_AND_EVENT" }));
    expect(settings.contentCapture).toBe("SPAN_AND_EVENT");
    expect(() => deriveOtelContentSurrogateKey(new Uint8Array(16))).toThrow(/32-byte master key/);
  });
});
