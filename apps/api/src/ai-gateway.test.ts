/**
 * 12.6b — the OpenAI-compatible /v1 AI gateway, called the way an OpenAI SDK calls it (fetch, Bearer token, JSON or
 * SSE) against an in-process OpenAI-compatible upstream on 127.0.0.1 (no outside network).
 *
 * Covers the admission order (token, grant, rate limit, budget, allowlist, content rules), streaming (chunks, usage, [DONE],
 * caller abort cancelling the upstream), tools passed through, embeddings, the OpenAI error envelope, Content rules on the
 * prompt and the answer (a mid-stream cut, and buffered mode for a rewriting profile), usage rows counted by budgets,
 * and that with no route set /v1 does nothing.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AiGatewayRoute, AiGatewayRouteSet, McpClient, Workflow } from "@ai-orchestrator/shared";
import { createApp, type CreateAppOptions } from "./app.js";
import { openApiSpec } from "./openapi.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { AuthService } from "./services/auth-service.js";
import { GuardService } from "./services/guard-service.js";
import { SecretService } from "./services/secret-service.js";

const UPSTREAM_KEY = "sk-upstream-test-key-7f3a";
const EMAIL = "jane.doe@example.com";
/** One token costs one dollar, so a budget of a few dollars runs out after one request. */
const PRICING = JSON.stringify({
  openai_compatible: { "up-model": { inputUsdPer1M: 1_000_000, outputUsdPer1M: 1_000_000 }, "up-embed": { inputUsdPer1M: 1_000_000, outputUsdPer1M: 0 } }
});

// ---------------------------------------------------------------------------
// The upstream: an OpenAI-compatible server whose answers each test scripts.
// ---------------------------------------------------------------------------

interface UpstreamRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

type UpstreamAnswer =
  | { json: unknown; status?: number }
  /** `eof`: the body just ends, with no `[DONE]`. */
  | { sse: Array<unknown>; gapMs?: number; hang?: boolean; drop?: boolean; eof?: boolean };

interface Upstream {
  baseUrl: string;
  requests: UpstreamRequest[];
  /** The next chat answers (first in, first out); the default answers "Hello from upstream." */
  chat: UpstreamAnswer[];
  /** False: embedding answers carry no usage. */
  embeddingUsage: boolean;
  /** Resolves when the upstream sees a streaming request's connection close before it finished. */
  closedEarly: Promise<void>;
  close: () => Promise<void>;
}

function completion(content: string | null, extra: Record<string, unknown> = {}, usage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }) {
  return {
    id: "up-1",
    object: "chat.completion",
    created: 1,
    model: "up-model",
    choices: [{ index: 0, message: { role: "assistant", content, ...extra }, finish_reason: extra.tool_calls ? "tool_calls" : "stop" }],
    usage
  };
}

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return { id: "up-1", object: "chat.completion.chunk", created: 1, model: "up-model", choices: [{ index: 0, delta, finish_reason: finish }] };
}

async function startUpstream(): Promise<Upstream> {
  const requests: UpstreamRequest[] = [];
  const chat: UpstreamAnswer[] = [];
  let markClosed: () => void = () => undefined;
  const closedEarly = new Promise<void>((resolve) => (markClosed = resolve));
  const upstream: Upstream = { baseUrl: "", requests, chat, embeddingUsage: true, closedEarly, close: async () => undefined };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => (raw += String(part)));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      if (req.headers.authorization !== `Bearer ${UPSTREAM_KEY}` && req.headers["api-key"] !== UPSTREAM_KEY) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "bad key" } }));
        return;
      }
      if ((req.url ?? "").split("?")[0]!.endsWith("/embeddings")) {
        const inputs = body.input as string[];
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            object: "list",
            data: inputs.map((text, index) => ({ object: "embedding", index, embedding: [text.length, 0.5, -1] })),
            model: "up-embed",
            ...(upstream.embeddingUsage ? { usage: { prompt_tokens: inputs.length * 2, total_tokens: inputs.length * 2 } } : {})
          })
        );
        return;
      }
      const answer = chat.shift() ?? { json: completion("Hello from upstream.") };
      if ("json" in answer) {
        res.writeHead(answer.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(answer.json));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      let finished = false;
      res.on("close", () => {
        if (!finished) markClosed();
      });
      void (async () => {
        for (const frame of answer.sse) {
          if (res.destroyed) return;
          res.write(`data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`);
          if (answer.gapMs) await new Promise((resolve) => setTimeout(resolve, answer.gapMs));
        }
        if (answer.hang) return;
        if (answer.drop) {
          res.destroy();
          return;
        }
        if (!answer.eof) res.write("data: [DONE]\n\n");
        finished = true;
        res.end();
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  upstream.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  upstream.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return upstream;
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

interface Fixture {
  app: FastifyInstance;
  store: Store;
  config: AppConfig;
  base: string;
  admin: string;
  upstream: Upstream;
  secretId: string;
  tempDir: string;
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop()!;
    await fixture.app.close();
    await fixture.upstream.close();
    try {
      await fixture.store.close();
    } catch {
      // Closed by the app's shutdown hooks.
    }
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

async function setup(options: CreateAppOptions = {}, prepare?: (store: Store) => void): Promise<Fixture> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-aigw-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  prepare?.(store);
  const config = parseConfig({
    LOG_LEVEL: "error",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    LLM_PRICING_OVERRIDES_JSON: PRICING
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService, undefined, undefined, undefined, options);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  await authService.register({ email: "admin@example.com", password: "Admin-Pass-123!", role: "admin" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "Admin-Pass-123!" } });
  const admin = String([login.headers["set-cookie"]].flat().find((value) => String(value).startsWith(`${config.SESSION_COOKIE_NAME}=`))).split(";")[0]!;
  const upstream = await startUpstream();
  const { secretId } = await secretService.createSecret({ name: "upstream", provider: "openai_compatible", value: UPSTREAM_KEY, projectId: "default" });
  const fixture: Fixture = { app, store, config, base, admin, upstream, secretId, tempDir };
  fixtures.push(fixture);
  return fixture;
}

async function api<T = Record<string, unknown>>(fixture: Fixture, method: string, url: string, payload?: unknown, cookie = fixture.admin) {
  const response = await fixture.app.inject({ method: method as "GET", url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: response.statusCode, body: (response.body ? response.json() : null) as T, raw: response.body };
}

/** A route set with a chat route `gpt-test` and an embedding route `embed-test`, and a client granted it. */
async function gateway(fixture: Fixture, setInput: Record<string, unknown> = {}) {
  const set = await api<AiGatewayRouteSet>(fixture, "POST", "/api/ai-gateway/route-sets", { name: "Apps", projectId: "default", ...setInput });
  expect(set.status, set.raw).toBe(201);
  const chat = await api<AiGatewayRoute>(fixture, "POST", `/api/ai-gateway/route-sets/${set.body.id}/routes`, {
    alias: "gpt-test",
    providerId: "openai_compatible",
    model: "up-model",
    baseUrl: fixture.upstream.baseUrl,
    secretRef: { secretId: fixture.secretId }
  });
  expect(chat.status, chat.raw).toBe(201);
  const embed = await api<AiGatewayRoute>(fixture, "POST", `/api/ai-gateway/route-sets/${set.body.id}/routes`, {
    alias: "embed-test",
    kind: "embedding",
    providerId: "openai_compatible",
    model: "up-embed",
    baseUrl: fixture.upstream.baseUrl,
    secretRef: { secretId: fixture.secretId }
  });
  expect(embed.status, embed.raw).toBe(201);
  const client = await newClient(fixture, "App", [set.body.id]);
  return { set: set.body, chat: chat.body, embed: embed.body, ...client };
}

async function newClient(fixture: Fixture, name: string, routeSetIds: string[]) {
  const created = await api<{ client: McpClient; token: string }>(fixture, "POST", "/api/mcp/clients", { name, toolsetIds: [], role: "builder" });
  expect(created.status, created.raw).toBe(201);
  const grants = await api(fixture, "PUT", `/api/ai-gateway/clients/${created.body.client.id}/grants`, { routeSetIds });
  expect(grants.status, grants.raw).toBe(200);
  return { client: created.body.client, token: created.body.token };
}

async function setClientRateLimit(fixture: Fixture, clientId: string, rateLimit: Record<string, unknown>) {
  const updated = await api(fixture, "PATCH", `/api/mcp/clients/${clientId}`, { rateLimit });
  expect(updated.status, updated.raw).toBe(200);
}

function v1(fixture: Fixture, token: string | null, pathName: string, body?: unknown, init: RequestInit = {}) {
  return fetch(`${fixture.base}${pathName}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    ...init
  });
}

/** The `data:` payloads of an SSE body (`[DONE]` kept as the string). */
function frames(text: string): unknown[] {
  return text
    .split("\n\n")
    .map((block) => block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n"))
    .filter(Boolean)
    .map((data) => (data === "[DONE]" ? data : JSON.parse(data)));
}

type Frame = { choices?: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>; usage?: Record<string, number>; error?: { code: string } };

function streamedText(list: unknown[]): string {
  return (list.filter((frame) => typeof frame === "object") as Frame[]).map((frame) => String(frame.choices?.[0]?.delta?.content ?? "")).join("");
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

const requestsOf = (fixture: Fixture) => fixture.store.listAiGatewayRequests({ from: "1970-01-01T00:00:00.000Z", limit: 100 });

async function guardProfile(fixture: Fixture, document: Record<string, unknown>, setId: string) {
  const created = await api(fixture, "POST", "/api/guard/profiles", { document });
  expect(created.status, created.raw).toBe(201);
  const bound = await api(fixture, "PUT", `/api/ai-gateway/route-sets/${setId}/guard`, { mode: "override", profileId: document.id });
  expect(bound.status, bound.raw).toBe(200);
}

const dlpChannel = (action: string) => ({ detectors: [{ id: "dlp.patterns", threshold: 0.5 }], actions: { email: { action } }, defaultAction: { action: "allow" } });

// ---------------------------------------------------------------------------

describe("/v1 with no route set (optional)", () => {
  it("is inert: a valid client token sees no models and every model is unknown", async () => {
    const fixture = await setup();
    const created = await api<{ client: McpClient; token: string }>(fixture, "POST", "/api/mcp/clients", { name: "Plain", toolsetIds: [], role: "builder" });
    const models = await v1(fixture, created.body.token, "/v1/models");
    expect(models.status).toBe(200);
    expect(await models.json()).toEqual({ object: "list", data: [] });
    const chat = await v1(fixture, created.body.token, "/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(chat.status).toBe(404);
    expect(((await chat.json()) as { error: { code: string } }).error.code).toBe("model_not_found");
    expect((await v1(fixture, null, "/v1/models")).status).toBe(401);
    expect(fixture.upstream.requests).toHaveLength(0);
    expect(await requestsOf(fixture)).toHaveLength(0);
  });

  it("answers unknown /v1 paths in the OpenAI format and leaves the 404 of every other path as it was", async () => {
    const fixture = await setup();
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const unknown = await fixture.app.inject({ method, url: "/v1/nope" });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ error: { code: "unknown_url" } });
    }
    for (const url of ["/no-such-path", "/api/no-such-route"]) {
      const response = await fixture.app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ message: `Route GET:${url} not found`, error: "Not Found", statusCode: 404 });
    }
  });
});

describe("/v1/chat/completions", () => {
  it("answers a non-streaming request with the route's upstream, by alias, and records usage", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    const response = await v1(fixture, gw.token, "/v1/chat/completions", {
      model: "gpt-test",
      messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Say hello" }],
      temperature: 0.7,
      top_p: 0.9,
      stop: ["END"],
      seed: 7,
      user: "end-user-1"
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("gpt-test");
    expect(body.choices[0].message).toMatchObject({ role: "assistant", content: "Hello from upstream." });
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
    const sent = fixture.upstream.requests[0]!;
    expect(sent.body).toMatchObject({ model: "up-model", temperature: 0.7, top_p: 0.9, stop: ["END"], seed: 7, user: "end-user-1" });
    expect(sent.body.messages).toEqual([{ role: "system", content: "Be brief." }, { role: "user", content: "Say hello" }]);
    const [row] = await requestsOf(fixture);
    expect(row).toMatchObject({ clientId: gw.client.id, routeSetId: gw.set.id, alias: "gpt-test", status: "ok", httpStatus: 200, inputTokens: 3, outputTokens: 4, totalTokens: 7, costUsd: 7, stream: false, guardOutcome: "none" });
  });

  it("streams chunks, the usage chunk and [DONE]", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.chat.push({
      sse: [
        chunk({ role: "assistant", content: "" }),
        chunk({ content: "Hel" }),
        chunk({ content: "lo" }),
        chunk({}, "stop"),
        { id: "up-1", object: "chat.completion.chunk", created: 1, model: "up-model", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
      ]
    });
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true, stream_options: { include_usage: true } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const list = frames(await response.text());
    expect(list.at(-1)).toBe("[DONE]");
    expect(streamedText(list)).toBe("Hello");
    const objects = list.filter((frame) => typeof frame === "object") as Frame[];
    expect(objects.every((frame) => (frame as Record<string, unknown>).model === "gpt-test")).toBe(true);
    expect(objects.find((frame) => frame.choices?.[0]?.finish_reason)?.choices?.[0]?.finish_reason).toBe("stop");
    const usage = objects.at(-1)!;
    expect(usage.choices).toEqual([]);
    expect(usage.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    expect(fixture.upstream.requests[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect((await requestsOf(fixture))[0]).toMatchObject({ stream: true, status: "ok", totalTokens: 7, finishReason: "stop", usageEstimated: false });
  });

  it("stops the upstream call when the caller goes away mid-stream", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.chat.push({ sse: [chunk({ role: "assistant", content: "" }), chunk({ content: "first " })], hang: true });
    const abort = new AbortController();
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true }, { signal: abort.signal });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("first");
    abort.abort();
    await fixture.upstream.closedEarly;
    const row = await until(async () => (await requestsOf(fixture))[0], "the usage row");
    expect(row.status).toBe("client_closed");
  });

  it("ends a stream whose upstream fails midway with an error event and [DONE]", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.chat.push({ sse: [chunk({ role: "assistant", content: "" }), chunk({ content: "partial " })], gapMs: 20, drop: true });
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(response.status).toBe(200);
    const list = frames(await response.text());
    expect(streamedText(list)).toBe("partial ");
    expect((list.at(-2) as Frame).error?.code).toBe("upstream_error");
    expect(list.at(-1)).toBe("[DONE]");
    expect((await requestsOf(fixture))[0]).toMatchObject({ status: "upstream_error", stream: true });
  });

  it("reports an error frame inside the stream as an upstream failure, without its text", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.chat.push({ sse: [chunk({ role: "assistant", content: "" }), chunk({ content: "partial " }), { error: { message: "overloaded at node-7.internal", type: "server_error" } }] });
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true });
    const raw = await response.text();
    expect(raw).not.toContain("node-7");
    const list = frames(raw);
    expect(streamedText(list)).toBe("partial ");
    const objects = list.filter((frame) => typeof frame === "object") as Frame[];
    expect(objects.some((frame) => frame.choices?.[0]?.finish_reason)).toBe(false);
    expect(objects.at(-1)!.error?.code).toBe("upstream_error");
    expect(list.at(-1)).toBe("[DONE]");
    expect((await requestsOf(fixture))[0]).toMatchObject({ status: "upstream_error", errorCode: "upstream_error", finishReason: null });
  });

  it("reports a stream that just ends, with no finish and no [DONE], as an upstream failure", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.chat.push({ sse: [chunk({ role: "assistant", content: "" }), chunk({ content: "partial " })], eof: true });
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true });
    const objects = frames(await response.text()).filter((frame) => typeof frame === "object") as Frame[];
    expect(objects.some((frame) => frame.choices?.[0]?.finish_reason)).toBe(false);
    expect(objects.at(-1)!.error?.code).toBe("upstream_error");
    expect((await requestsOf(fixture))[0]).toMatchObject({ status: "upstream_error", finishReason: null });
  });

  it("answers 502, not an empty 200 stream, when a stream fails before any text", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.chat.push({ sse: [{ error: { message: "overloaded" } }] });
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("upstream_error");
    expect((await requestsOf(fixture))[0]).toMatchObject({ status: "upstream_error", httpStatus: 502 });
  });

  it("keeps a normal end normal: [DONE] with no finish reason, a finish with no [DONE], and a finish reason outside OpenAI's list", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.chat.push(
      { sse: [chunk({ content: "one" })] },
      { sse: [chunk({ content: "two" }), chunk({}, "stop")], eof: true },
      { sse: [chunk({ content: "three" }), chunk({}, "eos")], eof: true }
    );
    for (const text of ["one", "two", "three"]) {
      const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true });
      const list = frames(await response.text());
      expect(streamedText(list)).toBe(text);
      const objects = list.filter((frame) => typeof frame === "object") as Frame[];
      expect(objects.some((frame) => frame.error)).toBe(false);
      expect(objects.find((frame) => frame.choices?.[0]?.finish_reason)?.choices?.[0]?.finish_reason).toBe("stop");
    }
    expect((await requestsOf(fixture)).map((row) => row.status)).toEqual(["ok", "ok", "ok"]);
  });

  it("passes tools through and returns the tool calls", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.chat.push({
      json: completion(null, { tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"city":"Oslo"}' } }] })
    });
    const tools = [{ type: "function", function: { name: "lookup", description: "Look up weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
    const response = await v1(fixture, gw.token, "/v1/chat/completions", {
      model: "gpt-test",
      messages: [
        { role: "user", content: "Weather?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "lookup", arguments: '{"city":"Bergen"}' } }] },
        { role: "tool", tool_call_id: "call_0", content: "rain" }
      ],
      tools,
      tool_choice: "required"
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.content).toBeNull();
    expect(body.choices[0].message.tool_calls).toEqual([{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"city":"Oslo"}' } }]);
    const sent = fixture.upstream.requests[0]!.body as Record<string, any>;
    expect(sent.tool_choice).toBe("required");
    expect(sent.tools[0].function.name).toBe("lookup");
    expect(sent.messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_0", content: "rain" });
  });
});

describe("/v1/embeddings", () => {
  it("embeds a batch, as floats or base64, and records the tokens", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    const response = await v1(fixture, gw.token, "/v1/embeddings", { model: "embed-test", input: ["one", "three"] });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.object).toBe("list");
    expect(body.model).toBe("embed-test");
    expect(body.data.map((entry: { index: number; embedding: number[] }) => [entry.index, entry.embedding[0]])).toEqual([
      [0, 3],
      [1, 5]
    ]);
    expect(body.usage).toEqual({ prompt_tokens: 4, total_tokens: 4 });
    const encoded = (await (await v1(fixture, gw.token, "/v1/embeddings", { model: "embed-test", input: "ab", encoding_format: "base64" })).json()) as Record<string, any>;
    const vector = Buffer.from(encoded.data[0].embedding as string, "base64");
    expect([vector.readFloatLE(0), vector.readFloatLE(4), vector.readFloatLE(8)]).toEqual([2, 0.5, -1]);
    const rows = await requestsOf(fixture);
    expect(rows.map((row) => [row.kind, row.totalTokens])).toEqual([
      ["embedding", 2],
      ["embedding", 4]
    ]);
    // A chat alias is not an embedding model, and the other way round.
    expect((await v1(fixture, gw.token, "/v1/embeddings", { model: "gpt-test", input: "x" })).status).toBe(400);
    expect((await v1(fixture, gw.token, "/v1/chat/completions", { model: "embed-test", messages: [{ role: "user", content: "x" }] })).status).toBe(400);
  });
});

describe("errors (OpenAI envelope)", () => {
  const code = async (response: Response) => ((await response.json()) as { error: { code: string | null; type: string } }).error;

  it("answers each refusal with its status and code", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    const chat = { model: "gpt-test", messages: [{ role: "user", content: "hi" }] };

    const noKey = await v1(fixture, null, "/v1/chat/completions", chat);
    expect(noKey.status).toBe(401);
    expect((await code(noKey)).code).toBe("invalid_api_key");
    const badKey = await v1(fixture, "mcp_not-a-real-token", "/v1/chat/completions", chat);
    expect(badKey.status).toBe(401);
    expect((await code(badKey)).code).toBe("invalid_api_key");

    const unknown = await v1(fixture, gw.token, "/v1/chat/completions", { ...chat, model: "gpt-4o" });
    expect(unknown.status).toBe(404);
    expect((await code(unknown)).code).toBe("model_not_found");

    const malformed = await v1(fixture, gw.token, "/v1/chat/completions", "{not json");
    expect(malformed.status).toBe(400);
    expect((await code(malformed)).type).toBe("invalid_request_error");
    expect((await v1(fixture, gw.token, "/v1/chat/completions", { ...chat, n: 2 })).status).toBe(400);
    expect((await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [] })).status).toBe(400);
    const remoteImage = await v1(fixture, gw.token, "/v1/chat/completions", {
      model: "gpt-test",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/cat.png" } }] }]
    });
    expect(remoteImage.status).toBe(400);

    // An upstream failure: 502, and the upstream's text (which can carry hosts or keys) never reaches the caller.
    fixture.upstream.chat.push({ json: { error: { message: `boom at internal-host.local with ${UPSTREAM_KEY}` } }, status: 400 });
    const upstreamFail = await v1(fixture, gw.token, "/v1/chat/completions", chat);
    expect(upstreamFail.status).toBe(502);
    const text = await upstreamFail.text();
    expect(text).not.toContain("internal-host");
    expect(text).not.toContain(UPSTREAM_KEY);
    expect(JSON.parse(text).error.code).toBe("upstream_error");
    expect((await requestsOf(fixture))[0]).toMatchObject({ status: "upstream_error", httpStatus: 502 });

    expect((await v1(fixture, gw.token, "/v1/nope")).status).toBe(404);
  });

  it("answers 403 model_not_allowed when the model allowlist refuses the route's model", async () => {
    const seen: Array<{ providerId: string; model: string; operation: string }> = [];
    const fixture = await setup({
      aiGatewayCheckModel: async (_scope, call) => {
        seen.push(call);
        if (call.model === "up-model") {
          const error = new Error("not on the list");
          error.name = "ModelNotAllowedError";
          throw error;
        }
      }
    });
    const gw = await gateway(fixture);
    const refused = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
    expect(refused.status).toBe(403);
    expect((await code(refused)).code).toBe("model_not_allowed");
    expect(fixture.upstream.requests).toHaveLength(0);
    expect((await v1(fixture, gw.token, "/v1/embeddings", { model: "embed-test", input: "x" })).status).toBe(200);
    expect(seen).toEqual([
      { providerId: "openai_compatible", model: "up-model", operation: "generate" },
      { providerId: "openai_compatible", model: "up-embed", operation: "embed" }
    ]);
  });
});

describe("grants, rate limits and budgets", () => {
  it("lists and answers only the route sets granted to the client", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    const other = await api<AiGatewayRouteSet>(fixture, "POST", "/api/ai-gateway/route-sets", { name: "Other" });
    await api(fixture, "POST", `/api/ai-gateway/route-sets/${other.body.id}/routes`, { alias: "other-model", providerId: "openai_compatible", model: "up-model", baseUrl: fixture.upstream.baseUrl, secretRef: { secretId: fixture.secretId } });
    const models = (await (await v1(fixture, gw.token, "/v1/models")).json()) as { data: Array<{ id: string }> };
    expect(models.data.map((model) => model.id)).toEqual(["embed-test", "gpt-test"]);
    expect((await v1(fixture, gw.token, "/v1/chat/completions", { model: "other-model", messages: [{ role: "user", content: "hi" }] })).status).toBe(404);
    expect((await v1(fixture, gw.token, "/v1/models/other-model")).status).toBe(404);
    expect((await v1(fixture, gw.token, "/v1/models/gpt-test")).status).toBe(200);
    // A disabled route answers like an unknown one.
    await api(fixture, "PUT", `/api/ai-gateway/routes/${gw.chat.id}`, { enabled: false });
    expect((await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }] })).status).toBe(404);
  });

  it("refuses over the route set's rate limit with 429 rate_limit_exceeded and Retry-After", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture, { rateLimit: { requestsPerMinute: 1 } });
    const chat = { model: "gpt-test", messages: [{ role: "user", content: "hi" }] };
    expect((await v1(fixture, gw.token, "/v1/chat/completions", chat)).status).toBe(200);
    const limited = await v1(fixture, gw.token, "/v1/chat/completions", chat);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("rate_limit_exceeded");
    expect(fixture.upstream.requests).toHaveLength(1);
  });

  it("applies the route set's limit as well as the client's own, whichever is tighter", async () => {
    const chat = { model: "gpt-test", messages: [{ role: "user", content: "hi" }] };

    const tightSet = await setup();
    const generousClient = await gateway(tightSet, { rateLimit: { requestsPerMinute: 1 } });
    await setClientRateLimit(tightSet, generousClient.client.id, { requestsPerMinute: 100 });
    expect((await v1(tightSet, generousClient.token, "/v1/chat/completions", chat)).status).toBe(200);
    expect((await v1(tightSet, generousClient.token, "/v1/chat/completions", chat)).status).toBe(429);

    const tightClient = await setup();
    const generousSet = await gateway(tightClient, { rateLimit: { requestsPerMinute: 100 } });
    await setClientRateLimit(tightClient, generousSet.client.id, { requestsPerMinute: 1 });
    expect((await v1(tightClient, generousSet.token, "/v1/chat/completions", chat)).status).toBe(200);
    expect((await v1(tightClient, generousSet.token, "/v1/chat/completions", chat)).status).toBe(429);
  });

  it("gives back the client's concurrency slot when the route set's limit refuses", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture, { rateLimit: { requestsPerMinute: 1 } });
    await setClientRateLimit(fixture, gw.client.id, { maxConcurrent: 1 });
    const chat = { model: "gpt-test", messages: [{ role: "user", content: "hi" }] };
    expect((await v1(fixture, gw.token, "/v1/chat/completions", chat)).status).toBe(200);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refused = await v1(fixture, gw.token, "/v1/chat/completions", chat);
      expect(refused.status).toBe(429);
    }
    const cleared = await api(fixture, "PUT", `/api/ai-gateway/route-sets/${gw.set.id}`, { rateLimit: null });
    expect(cleared.status, cleared.raw).toBe(200);
    expect((await v1(fixture, gw.token, "/v1/chat/completions", chat)).status).toBe(200);
  });

  it("counts usage toward the client's budget and refuses with 429 insufficient_quota once it is used up", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    const budget = await api(fixture, "POST", "/api/budgets", { name: "Client", scopeType: "mcp_client", scopeId: gw.client.id, period: "day", limitType: "usd", limitValue: 5, action: "block" });
    expect(budget.status, budget.raw).toBe(200);
    const chat = { model: "gpt-test", messages: [{ role: "user", content: "hi" }] };
    expect((await v1(fixture, gw.token, "/v1/chat/completions", chat)).status).toBe(200);
    const refused = await v1(fixture, gw.token, "/v1/chat/completions", chat);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("insufficient_quota");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    // The client's Governance shows the spend.
    const usage = await api<{ budgets: Array<{ budgetId: string; current: number }> }>(fixture, "GET", `/api/mcp/clients/${gw.client.id}/budgets`);
    expect(usage.body.budgets.find((entry) => entry.budgetId === (budget.body as { budget: { id: string } }).budget.id)?.current).toBe(7);
  });

  it("counts usage toward the route set's project budget", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    expect((await api(fixture, "POST", "/api/budgets", { name: "Project", scopeType: "project", scopeId: "default", period: "day", limitType: "tokens", limitValue: 7, action: "block" })).status).toBe(200);
    expect((await v1(fixture, gw.token, "/v1/embeddings", { model: "embed-test", input: ["abc", "def", "ghi"] })).status).toBe(200);
    expect((await v1(fixture, gw.token, "/v1/embeddings", { model: "embed-test", input: "abc" })).status).toBe(200);
    expect((await v1(fixture, gw.token, "/v1/embeddings", { model: "embed-test", input: "abc" })).status).toBe(429);
  });
});

describe("OpenAPI", () => {
  it("documents /v1 and the admin API, each as a route the app serves", async () => {
    const fixture = await setup();
    const documented = Object.entries(openApiSpec.paths).flatMap(([route, methods]) =>
      route.startsWith("/v1/") || route.startsWith("/api/ai-gateway/") ? Object.keys(methods as object).map((method) => ({ route, method: method.toUpperCase() })) : []
    );
    expect(documented.map((entry) => `${entry.method} ${entry.route}`).sort()).toEqual(
      [
        "GET /v1/models",
        "POST /v1/chat/completions",
        "POST /v1/embeddings",
        "GET /api/ai-gateway/route-sets",
        "POST /api/ai-gateway/route-sets",
        "GET /api/ai-gateway/route-sets/{id}",
        "PUT /api/ai-gateway/route-sets/{id}",
        "DELETE /api/ai-gateway/route-sets/{id}",
        "POST /api/ai-gateway/route-sets/{id}/routes",
        "PUT /api/ai-gateway/routes/{id}",
        "DELETE /api/ai-gateway/routes/{id}",
        "GET /api/ai-gateway/clients/{clientId}/grants",
        "PUT /api/ai-gateway/clients/{clientId}/grants",
        "GET /api/ai-gateway/route-sets/{id}/guard",
        "PUT /api/ai-gateway/route-sets/{id}/guard",
        "GET /api/ai-gateway/usage",
        "GET /api/ai-gateway/requests"
      ].sort()
    );
    for (const { route, method } of documented) {
      expect(fixture.app.hasRoute({ method: method as "GET", url: route.replace(/\{(\w+)\}/g, ":$1") }), `${method} ${route}`).toBe(true);
    }
  });
});

describe("browser calls (CORS) on /v1", () => {
  const origin = "http://localhost:5173";
  const preflight = (fixture: Fixture, headers: Record<string, string>, url = "/v1/chat/completions") =>
    fixture.app.inject({ method: "OPTIONS", url, headers: { origin, "access-control-request-method": "POST", ...headers } });

  it("allows the headers an OpenAI browser SDK sends, exposes Retry-After, and still refuses an origin that is not allowed", async () => {
    const fixture = await setup();
    const asked = "authorization,content-type,x-stainless-os,x-stainless-lang,openai-organization";
    const allowed = await preflight(fixture, { "access-control-request-headers": asked });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe(origin);
    expect(String(allowed.headers["access-control-allow-headers"]).toLowerCase()).toContain("x-stainless-os");
    expect(allowed.headers["access-control-allow-credentials"]).toBeUndefined();
    const gw = await gateway(fixture, { rateLimit: { requestsPerMinute: 1 } });
    const chat = { model: "gpt-test", messages: [{ role: "user", content: "hi" }] };
    const call = () => fixture.app.inject({ method: "POST", url: "/v1/chat/completions", headers: { origin, authorization: `Bearer ${gw.token}` }, payload: chat });
    await call();
    expect((await call()).headers["access-control-expose-headers"]).toContain("Retry-After");
    const refused = await preflight(fixture, { origin: "https://evil.example", "access-control-request-headers": asked });
    expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("leaves the MCP endpoint's header list as it was", async () => {
    const fixture = await setup();
    const answer = await preflight(fixture, { "access-control-request-headers": "x-stainless-os" }, "/mcp/anything");
    expect(String(answer.headers["access-control-allow-headers"] ?? "").toLowerCase()).not.toContain("x-stainless-os");
  });
});

describe("everything that reaches the provider is counted", () => {
  const ANSWER = "word ".repeat(200);
  const BYTES = ANSWER.length;
  /** 3 bytes a token: what the answer alone must at least be charged. */
  const ANSWER_TOKENS = Math.ceil(BYTES / 3);
  const chat = { model: "gpt-test", messages: [{ role: "user", content: "hi" }] };
  const streamed = { ...chat, stream: true };
  const budgetOf = (fixture: Fixture, limitValue: number) => api(fixture, "POST", "/api/budgets", { name: "All", scopeType: "global", period: "day", limitType: "tokens", limitValue, action: "block" });
  const onlyRow = async (fixture: Fixture) => until(async () => (await requestsOf(fixture))[0], "the usage row");

  /** Reads until the whole answer has arrived, then hangs up before the upstream says anything more. */
  async function readThenClose(fixture: Fixture, token: string, text: string, body: Record<string, unknown> = streamed) {
    const abort = new AbortController();
    const response = await v1(fixture, token, "/v1/chat/completions", body, { signal: abort.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let seen = "";
    while (!seen.includes(text.slice(-20))) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    abort.abort();
  }

  it("stops a caller who hangs up before the usage frame from walking past a block budget", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    expect((await budgetOf(fixture, 100)).status).toBe(200);
    fixture.upstream.chat.push({ sse: [chunk({ content: ANSWER })], hang: true });
    await readThenClose(fixture, gw.token, ANSWER);
    const row = await onlyRow(fixture);
    expect(row).toMatchObject({ status: "client_closed", usageEstimated: true });
    expect(row.outputTokens).toBeGreaterThanOrEqual(ANSWER_TOKENS);
    expect(row.inputTokens).toBeGreaterThan(0);
    expect(row.totalTokens).toBe(row.inputTokens + row.outputTokens);
    expect(row.costUsd).toBe(row.totalTokens);
    const refused = await v1(fixture, gw.token, "/v1/chat/completions", streamed);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("insufficient_quota");
    expect(fixture.upstream.requests).toHaveLength(1);
  });

  it("allows for output still on its way when the caller hangs up mid-answer", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.chat.push({ sse: [chunk({ content: ANSWER })], hang: true });
    await readThenClose(fixture, gw.token, ANSWER);
    expect((await onlyRow(fixture)).outputTokens).toBeGreaterThanOrEqual(ANSWER_TOKENS + 256);
  });

  it("adds nothing for output in flight once the upstream has said it finished", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.chat.push({ sse: [chunk({ content: ANSWER }), chunk({}, "stop")], gapMs: 5, hang: true });
    const abort = new AbortController();
    const response = await v1(fixture, gw.token, "/v1/chat/completions", streamed, { signal: abort.signal });
    const reader = response.body!.getReader();
    await reader.read();
    await until(() => fixture.upstream.requests.length > 0, "the upstream call");
    await new Promise((resolve) => setTimeout(resolve, 100));
    abort.abort();
    const row = await onlyRow(fixture);
    expect(row.status).toBe("client_closed");
    expect(row.outputTokens).toBe(ANSWER_TOKENS);
  });

  it("uses the upstream's own numbers when its usage frame came before the caller hung up", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.chat.push({
      sse: [chunk({ content: ANSWER }), chunk({}, "stop"), { id: "up-1", object: "chat.completion.chunk", created: 1, model: "up-model", choices: [], usage: { prompt_tokens: 9, completion_tokens: 900, total_tokens: 909 } }],
      gapMs: 5,
      hang: true
    });
    const abort = new AbortController();
    const response = await v1(fixture, gw.token, "/v1/chat/completions", streamed, { signal: abort.signal });
    await response.body!.getReader().read();
    await new Promise((resolve) => setTimeout(resolve, 100));
    abort.abort();
    expect(await onlyRow(fixture)).toMatchObject({ status: "client_closed", totalTokens: 909, usageEstimated: false });
  });

  it("estimates a stream on a route that asks for no usage, and counts it toward the budget", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    const route = await api<AiGatewayRoute>(fixture, "POST", `/api/ai-gateway/route-sets/${gw.set.id}/routes`, {
      alias: "no-usage",
      providerId: "openai_compatible",
      model: "up-model",
      baseUrl: fixture.upstream.baseUrl,
      secretRef: { secretId: fixture.secretId },
      extra: { streamUsage: false }
    });
    expect(route.status, route.raw).toBe(201);
    expect((await budgetOf(fixture, 100)).status).toBe(200);
    fixture.upstream.chat.push({ sse: [chunk({ content: ANSWER }), chunk({}, "stop")] });
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { ...streamed, model: "no-usage" });
    expect(streamedText(frames(await response.text()))).toBe(ANSWER);
    expect(fixture.upstream.requests[0]!.body.stream_options).toBeUndefined();
    const row = await onlyRow(fixture);
    expect(row).toMatchObject({ status: "ok", usageEstimated: true, outputTokens: ANSWER_TOKENS });
    expect(row.costUsd).toBeGreaterThan(0);
    expect((await v1(fixture, gw.token, "/v1/chat/completions", { ...streamed, model: "no-usage" })).status).toBe(429);
  });

  it("estimates a stream whose server ignored stream_options, or sent zeros", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    const zeros = { id: "up-1", object: "chat.completion.chunk", created: 1, model: "up-model", choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    fixture.upstream.chat.push({ sse: [chunk({ content: ANSWER }), chunk({}, "stop")] }, { sse: [chunk({ content: ANSWER }), chunk({}, "stop"), zeros] });
    await (await v1(fixture, gw.token, "/v1/chat/completions", streamed)).text();
    await (await v1(fixture, gw.token, "/v1/chat/completions", streamed)).text();
    const rows = await requestsOf(fixture);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ status: "ok", usageEstimated: true, outputTokens: ANSWER_TOKENS });
  });

  it("sends no usage chunk when the upstream reported none, and the upstream's numbers when it did", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    const withUsage = { ...streamed, stream_options: { include_usage: true } };
    const zeros = { id: "up-1", object: "chat.completion.chunk", created: 1, model: "up-model", choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    const real = { ...zeros, usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } };
    fixture.upstream.chat.push(
      { sse: [chunk({ content: "a" }), chunk({}, "stop")] },
      { sse: [chunk({ content: "a" }), chunk({}, "stop"), zeros] },
      { sse: [chunk({ content: "a" }), chunk({}, "stop"), real] }
    );
    const usages: Array<Record<string, number> | undefined> = [];
    for (let index = 0; index < 3; index += 1) {
      const list = frames(await (await v1(fixture, gw.token, "/v1/chat/completions", withUsage)).text()) as Frame[];
      usages.push(list.find((frame) => typeof frame === "object" && frame.usage)?.usage);
    }
    expect(usages).toEqual([undefined, undefined, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }]);
  });

  it("counts tool call arguments streamed with no usage", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    const args = JSON.stringify({ q: "x".repeat(600) });
    fixture.upstream.chat.push({ sse: [chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "lookup", arguments: args } }] }), chunk({}, "tool_calls")] });
    await (await v1(fixture, gw.token, "/v1/chat/completions", streamed)).text();
    expect((await onlyRow(fixture)).outputTokens).toBeGreaterThanOrEqual(200);
  });

  it("charges a stream a content rule cut, including what the upstream was still producing", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-cut", name: "Cut", version: "1", channels: { final_output: dlpChannel("block") } }, gw.set.id);
    const opening = `${ANSWER}mail ${EMAIL} now. `;
    fixture.upstream.chat.push({ sse: [chunk({ content: opening }), chunk({ content: "more" }), chunk({}, "stop")], gapMs: 5 });
    await (await v1(fixture, gw.token, "/v1/chat/completions", streamed)).text();
    const row = await onlyRow(fixture);
    expect(row).toMatchObject({ status: "blocked_output", usageEstimated: true });
    expect(row.outputTokens).toBeGreaterThanOrEqual(Math.ceil(opening.length / 3) + 256);
  });

  it("charges what arrived when the upstream fails midway", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.chat.push({ sse: [chunk({ content: ANSWER })], gapMs: 20, drop: true });
    await (await v1(fixture, gw.token, "/v1/chat/completions", streamed)).text();
    expect(await onlyRow(fixture)).toMatchObject({ status: "upstream_error", usageEstimated: true, outputTokens: ANSWER_TOKENS });
  });

  it("charges the input of a request the provider failed", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.chat.push({ json: { error: { message: "bad" } }, status: 400 });
    expect((await v1(fixture, gw.token, "/v1/chat/completions", chat)).status).toBe(502);
    const row = await onlyRow(fixture);
    expect(row).toMatchObject({ status: "upstream_error", usageEstimated: true, outputTokens: 0 });
    expect(row.inputTokens).toBeGreaterThan(0);
  });

  it("charges a non-streaming request whose caller hung up, with an allowance for the unseen answer", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.chat.push({ sse: [], hang: true });
    const abort = new AbortController();
    const call = v1(fixture, gw.token, "/v1/chat/completions", chat, { signal: abort.signal }).catch(() => null);
    await until(() => fixture.upstream.requests.length > 0, "the upstream call");
    abort.abort();
    await call;
    const row = await onlyRow(fixture);
    expect(row).toMatchObject({ status: "client_closed", usageEstimated: true });
    expect(row.inputTokens).toBeGreaterThan(0);
    expect(row.outputTokens).toBeGreaterThanOrEqual(256);
  });

  it("caps that allowance at the request's max_tokens", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.chat.push({ sse: [], hang: true });
    const abort = new AbortController();
    const call = v1(fixture, gw.token, "/v1/chat/completions", { ...chat, max_tokens: 10 }, { signal: abort.signal }).catch(() => null);
    await until(() => fixture.upstream.requests.length > 0, "the upstream call");
    abort.abort();
    await call;
    expect((await onlyRow(fixture)).outputTokens).toBe(10);
  });

  it("estimates a non-streaming answer with no usage", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    const { usage: _usage, ...bare } = completion(ANSWER);
    fixture.upstream.chat.push({ json: bare });
    expect((await v1(fixture, gw.token, "/v1/chat/completions", chat)).status).toBe(200);
    expect(await onlyRow(fixture)).toMatchObject({ status: "ok", usageEstimated: true, outputTokens: ANSWER_TOKENS });
  });

  it("estimates embeddings with no usage", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.embeddingUsage = false;
    expect((await v1(fixture, gw.token, "/v1/embeddings", { model: "embed-test", input: ANSWER })).status).toBe(200);
    const row = await onlyRow(fixture);
    expect(row).toMatchObject({ status: "ok", usageEstimated: true, outputTokens: 0 });
    expect(row.inputTokens).toBeGreaterThanOrEqual(ANSWER_TOKENS);
  });

  it("charges nothing for a prompt that never left, and marks reported usage as exact", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await v1(fixture, gw.token, "/v1/chat/completions", chat);
    expect(await onlyRow(fixture)).toMatchObject({ status: "ok", totalTokens: 7, usageEstimated: false });
    await guardProfile(fixture, { id: "aigw-none", name: "None", version: "1", channels: { prompt: dlpChannel("block") } }, gw.set.id);
    await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: EMAIL }] });
    expect((await requestsOf(fixture))[0]).toMatchObject({ status: "blocked_prompt", totalTokens: 0, usageEstimated: false });
  });

  it("charges large tool arguments in full whatever key they sit under, so `images` is no way to shrink the estimate", async () => {
    const big = "q ".repeat(30_000);
    const withArguments = (key: string) => ({
      ...streamed,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: JSON.stringify({ [key]: [big] }) } }] },
        { role: "tool", tool_call_id: "c1", content: "done" }
      ]
    });
    const charged: Record<string, number> = {};
    for (const key of ["notes", "images"]) {
      const fixture = await setup();
      const gw = await gateway(fixture);
      expect((await budgetOf(fixture, 10_000)).status).toBe(200);
      fixture.upstream.chat.push({ sse: [chunk({ content: ANSWER })], hang: true });
      await readThenClose(fixture, gw.token, ANSWER, withArguments(key));
      const row = await onlyRow(fixture);
      expect(row).toMatchObject({ status: "client_closed", usageEstimated: true });
      charged[key] = row.inputTokens;
      // The walk past the budget is closed: the next request is refused, as with any other key.
      const refused = await v1(fixture, gw.token, "/v1/chat/completions", streamed);
      expect(refused.status).toBe(429);
      expect(fixture.upstream.requests).toHaveLength(1);
    }
    expect(charged.images).toBeGreaterThanOrEqual(Math.floor(big.length / 3));
    expect(Math.abs(charged.images! - charged.notes!)).toBeLessThan(20);
  });

  it("never records a request as free when the provider reports a split and a zero total", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    fixture.upstream.chat.push({ json: { ...completion("Hello"), usage: { prompt_tokens: 500, completion_tokens: 500, total_tokens: 0 } } });
    expect((await v1(fixture, gw.token, "/v1/chat/completions", chat)).status).toBe(200);
    const row = await onlyRow(fixture);
    expect(row).toMatchObject({ status: "ok", totalTokens: 1000, usageEstimated: false });
    expect(row.costUsd).toBeGreaterThan(0);
  });

  it("reports a boundary check that could not run as an error, not as a provider failure", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-bthrow", name: "BThrow", version: "1", channels: { final_output: dlpChannel("block") } }, gw.set.id);
    const real = GuardService.prototype.gatewayRuntime;
    let calls = 0;
    const spy = vi.spyOn(GuardService.prototype, "gatewayRuntime").mockImplementation(function (this: GuardService, ...args: Parameters<GuardService["gatewayRuntime"]>) {
      calls += 1;
      if (calls >= 2) throw new Error("the rule store went away");
      return real.apply(this, args);
    });
    try {
      const sentence = "This sentence is harmless and long enough to be checked. ";
      fixture.upstream.chat.push({ sse: [chunk({ content: sentence.repeat(10) }), chunk({ content: "tail" }), chunk({}, "stop")] });
      const response = await v1(fixture, gw.token, "/v1/chat/completions", streamed);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("harmless");
      const row = await onlyRow(fixture);
      expect(row).toMatchObject({ status: "error", httpStatus: 500, errorCode: "internal_error" });
      expect(row.totalTokens).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ["a non-streaming answer", chat, { json: completion("Hello") }],
    ["a stream", streamed, { sse: [chunk({ content: "Hello" }), chunk({}, "stop")] }]
  ])("writes the usage row when the output check itself fails on %s", async (_case, body, answer) => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-throw", name: "Throw", version: "1", channels: { final_output: dlpChannel("block") } }, gw.set.id);
    const real = GuardService.prototype.gatewayRuntime;
    let calls = 0;
    const spy = vi.spyOn(GuardService.prototype, "gatewayRuntime").mockImplementation(function (this: GuardService, ...args: Parameters<GuardService["gatewayRuntime"]>) {
      calls += 1;
      if (calls >= 2) throw new Error("the rule store went away");
      return real.apply(this, args);
    });
    try {
      fixture.upstream.chat.push(answer as UpstreamAnswer);
      const response = await v1(fixture, gw.token, "/v1/chat/completions", body);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("Hello");
      const row = await onlyRow(fixture);
      expect(row).toMatchObject({ status: "error", httpStatus: 500 });
      expect(row.totalTokens).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Content rules on /v1", () => {
  it("blocks a prompt with 400 content_filter and never calls the provider", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-prompt", name: "Prompt", version: "1", channels: { prompt: dlpChannel("block") } }, gw.set.id);
    const blocked = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: `Mail ${EMAIL}` }] });
    expect(blocked.status).toBe(400);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("content_filter");
    expect(fixture.upstream.requests).toHaveLength(0);
    expect((await requestsOf(fixture))[0]).toMatchObject({ status: "blocked_prompt", guardOutcome: "block", stream: false });
    const blockedStream = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", stream: true, messages: [{ role: "user", content: `Mail ${EMAIL}` }] });
    expect(blockedStream.status).toBe(400);
    expect((await requestsOf(fixture)).find((row) => row.status === "blocked_prompt" && row.stream)).toBeDefined();
    expect((await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "fine" }] })).status).toBe(200);
  });

  it("cuts a stream whose answer is blocked, with finish_reason content_filter, and sends nothing unchecked", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-out", name: "Out", version: "1", channels: { final_output: dlpChannel("block") } }, gw.set.id);
    const sentence = "This sentence is harmless and long enough to be checked. ";
    const opening = sentence.repeat(10);
    fixture.upstream.chat.push({
      sse: [chunk({ role: "assistant", content: "" }), chunk({ content: opening }), chunk({ content: `Write to ${EMAIL} ` }), chunk({ content: "for more." }), chunk({}, "stop")]
    });
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain(EMAIL);
    const list = frames(raw);
    // Only checked text, and not its last stretch: that is held back until no match can still be forming in it.
    const released = streamedText(list);
    expect(released.length).toBeGreaterThan(0);
    expect(opening.startsWith(released)).toBe(true);
    expect(released.length).toBeLessThanOrEqual(opening.length - 200);
    const objects = list.filter((frame) => typeof frame === "object") as Frame[];
    expect(objects.find((frame) => frame.choices?.[0]?.finish_reason)?.choices?.[0]?.finish_reason).toBe("content_filter");
    expect(objects.at(-1)!.error?.code).toBe("content_filter");
    expect(list.at(-1)).toBe("[DONE]");
    expect((await requestsOf(fixture))[0]).toMatchObject({ status: "blocked_output", finishReason: "content_filter", guardOutcome: "block" });
    // The full answer's check is recorded once under the request's id.
    const row = (await requestsOf(fixture))[0]!;
    const events = await until(async () => {
      const list = await fixture.store.listGuardEventsForExecution(row.id);
      return list.length > 0 ? list : null;
    }, "the rule events");
    expect(events.filter((event) => event.channel === "final_output")).toHaveLength(1);
    expect(events.every((event) => event.placement === "gateway" && event.nodeId === "gpt-test")).toBe(true);
  });

  it.each<[string, string[], string]>([
    ["an address split after a dot", ["Here is the contact you asked me about earlier, write to jane.doe@example.", "com"], "jane.doe"],
    ["an address split inside its name", ["Here is the contact you asked me about earlier, and you can write to jane.", "doe@example.com today"], "jane"],
    ["an address split after a sentence end", ["Here is the contact you asked me about earlier. It is the one below. jane.doe@", "example.com"], "jane"]
  ])("releases none of %s when the rest of the match comes later", async (_case, parts, leaked) => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-split", name: "Split", version: "1", channels: { final_output: dlpChannel("block") } }, gw.set.id);
    fixture.upstream.chat.push({ sse: [chunk({ role: "assistant", content: "" }), ...parts.map((content) => chunk({ content })), chunk({}, "stop")], gapMs: 5 });
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true });
    const raw = await response.text();
    expect(raw).not.toContain(leaked);
    expect((await requestsOf(fixture))[0]).toMatchObject({ status: "blocked_output", finishReason: "content_filter" });
  });

  it("holds a match back however long the clean text before it runs", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-long", name: "Long", version: "1", channels: { final_output: dlpChannel("block") } }, gw.set.id);
    const opening = "Plain words go here and they are harmless to read. ".repeat(20);
    fixture.upstream.chat.push({ sse: [chunk({ content: opening }), chunk({ content: "mail jane.doe@example." }), chunk({ content: "com" }), chunk({}, "stop")], gapMs: 5 });
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true });
    const raw = await response.text();
    expect(raw).not.toContain("jane");
    expect(streamedText(frames(raw)).length).toBeGreaterThan(0);
  });

  it("releases clean text while the answer is still arriving, and the held-back tail after the last check", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-tail", name: "Tail", version: "1", channels: { final_output: dlpChannel("block") } }, gw.set.id);
    const text = "Plain words go here and they are harmless to read. ".repeat(20);
    fixture.upstream.chat.push({ sse: [chunk({ content: text }), chunk({ content: "The end." }), chunk({}, "stop")], gapMs: 5 });
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true });
    const list = frames(await response.text());
    expect(streamedText(list)).toBe(`${text}The end.`);
    const contentFrames = (list.filter((frame) => typeof frame === "object") as Frame[]).filter((frame) => frame.choices?.[0]?.delta?.content);
    expect(contentFrames.length).toBeGreaterThanOrEqual(2);
    expect((await requestsOf(fixture))[0]).toMatchObject({ status: "ok", guardOutcome: "allow" });
  });

  it("sends an answer shorter than the tail once, after the last check", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-short", name: "Short", version: "1", channels: { final_output: dlpChannel("block") } }, gw.set.id);
    fixture.upstream.chat.push({ sse: [chunk({ content: "All " }), chunk({ content: "good." }), chunk({}, "stop")] });
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(streamedText(frames(await response.text()))).toBe("All good.");
  });

  it("generates the whole answer first when a profile may rewrite it (buffered mode)", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-redact", name: "Redact", version: "1", channels: { final_output: dlpChannel("redact") } }, gw.set.id);
    fixture.upstream.chat.push({ json: completion(`Contact ${EMAIL} please.`) });
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true });
    const raw = await response.text();
    expect(raw).not.toContain(EMAIL);
    const text = streamedText(frames(raw));
    expect(text).toContain("Contact");
    expect(text).toContain("please.");
    // The upstream was asked for one answer, not a stream.
    expect(fixture.upstream.requests[0]!.body.stream).not.toBe(true);
    expect((await requestsOf(fixture))[0]).toMatchObject({ status: "ok", stream: true, guardOutcome: "rewrite" });
  });
});

describe("Content rules read everything the request sends", () => {
  const CARD = 4111111111111111;
  const user = [{ role: "user", content: "fine" }];
  const tool = (fn: Record<string, unknown>) => [{ type: "function", function: { name: "lookup", ...fn } }];
  const assistantCall = (args: string, extra: Record<string, unknown> = {}) => [
    ...user,
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: args }, ...extra }] },
    { role: "tool", tool_call_id: "call_1", content: "done" }
  ];
  const schemaFormat = (json_schema: Record<string, unknown>) => ({ type: "json_schema", json_schema: { name: "answer", ...json_schema } });

  it.each<[string, Record<string, unknown>]>([
    ["message content", { messages: [{ role: "user", content: `Mail ${EMAIL}` }] }],
    ["a system message", { messages: [{ role: "system", content: EMAIL }, ...user] }],
    ["a text part of a message", { messages: [{ role: "user", content: [{ type: "text", text: EMAIL }] }] }],
    ["a tool result", { messages: assistantCall("{}").map((message) => (message.role === "tool" ? { ...message, content: EMAIL } : message)) }],
    ["a user message's name", { messages: [{ role: "user", content: "fine", name: EMAIL }] }],
    ["assistant tool call arguments", { messages: assistantCall(JSON.stringify({ to: EMAIL })) }],
    ["a key of assistant tool call arguments", { messages: assistantCall(JSON.stringify({ [EMAIL]: true })) }],
    ["an assistant tool call's name", { messages: assistantCall("{}").map((message) => (message.role === "assistant" ? { ...message, tool_calls: [{ id: "call_1", type: "function", function: { name: EMAIL, arguments: "{}" } }] } : message)) }],
    ["a tool description", { messages: user, tools: tool({ description: `Ask ${EMAIL}` }) }],
    ["a tool name", { messages: user, tools: [{ type: "function", function: { name: EMAIL } }] }],
    ["a tool schema's property description", { messages: user, tools: tool({ parameters: { type: "object", properties: { to: { type: "string", description: EMAIL } } } }) }],
    ["a tool schema's property name", { messages: user, tools: tool({ parameters: { type: "object", properties: { [EMAIL]: { type: "string" } } } }) }],
    ["a tool schema's enum", { messages: user, tools: tool({ parameters: { type: "object", properties: { to: { enum: [EMAIL] } } } }) }],
    ["response_format's description", { messages: user, response_format: schemaFormat({ description: EMAIL }) }],
    ["response_format's name", { messages: user, response_format: schemaFormat({ name: EMAIL }) }],
    ["response_format's schema", { messages: user, response_format: schemaFormat({ schema: { type: "object", description: EMAIL } }) }],
    ["stop (a string)", { messages: user, stop: EMAIL }],
    ["stop (a list)", { messages: user, stop: ["END", EMAIL] }],
    ["user", { messages: user, user: EMAIL }]
  ])("blocks restricted text in %s, and nothing reaches the provider", async (_where, body) => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-all", name: "All", version: "1", channels: { prompt: dlpChannel("block") } }, gw.set.id);
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", ...body });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("content_filter");
    expect(fixture.upstream.requests).toHaveLength(0);
    expect((await requestsOf(fixture))[0]).toMatchObject({ status: "blocked_prompt", totalTokens: 0 });
  });

  it("blocks a card number sent as a JSON number in tool call arguments", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-card", name: "Card", version: "1", channels: { prompt: { detectors: [{ id: "dlp.patterns", threshold: 0.5 }], actions: { card_number: { action: "block" } }, defaultAction: { action: "allow" } } } }, gw.set.id);
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: assistantCall(`{"card":${CARD}}`) });
    expect(response.status).toBe(400);
    expect(fixture.upstream.requests).toHaveLength(0);
  });

  it("does not pass on tool call arguments that are not JSON, so the check has nothing to miss", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-args", name: "Args", version: "1", channels: { prompt: dlpChannel("block") } }, gw.set.id);
    await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: assistantCall(`to ${EMAIL}`) });
    expect(JSON.stringify(fixture.upstream.requests)).not.toContain(EMAIL);
  });

  it("checks an embeddings request's user as well as its input", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-embed", name: "Embed", version: "1", channels: { prompt: dlpChannel("block") } }, gw.set.id);
    expect((await v1(fixture, gw.token, "/v1/embeddings", { model: "embed-test", input: ["fine", EMAIL] })).status).toBe(400);
    expect((await v1(fixture, gw.token, "/v1/embeddings", { model: "embed-test", input: "fine", user: EMAIL })).status).toBe(400);
    expect(fixture.upstream.requests).toHaveLength(0);
    expect((await v1(fixture, gw.token, "/v1/embeddings", { model: "embed-test", input: "fine", user: "u1" })).status).toBe(200);
  });

  it("maps a rewrite back into each field, keeping the request's shape", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-rw", name: "Rewrite", version: "1", channels: { prompt: dlpChannel("redact") } }, gw.set.id);
    const response = await v1(fixture, gw.token, "/v1/chat/completions", {
      model: "gpt-test",
      messages: [
        { role: "user", content: `Mail ${EMAIL}` },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: JSON.stringify({ to: EMAIL, n: 2 }) } }] },
        { role: "tool", tool_call_id: "call_1", content: `Sent to ${EMAIL}` }
      ],
      tools: tool({ description: `Ask ${EMAIL}`, parameters: { type: "object", properties: { to: { type: "string", description: `Like ${EMAIL}` } } } }),
      response_format: schemaFormat({ description: `For ${EMAIL}` }),
      stop: [`END ${EMAIL}`],
      user: EMAIL
    });
    expect(response.status).toBe(200);
    const sent = fixture.upstream.requests[0]!;
    expect(JSON.stringify(sent.body)).not.toContain(EMAIL);
    const messages = sent.body.messages as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(messages[0]!.content).toContain("Mail ");
    const call = (messages[1]!.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>)[0]!;
    expect(call).toMatchObject({ id: "call_1", function: { name: "lookup" } });
    expect(JSON.parse(call.function.arguments)).toMatchObject({ n: 2 });
    expect(messages[2]).toMatchObject({ tool_call_id: "call_1" });
    expect((sent.body.tools as Array<{ function: { name: string; description: string } }>)[0]!.function).toMatchObject({ name: "lookup" });
    expect((await requestsOf(fixture))[0]).toMatchObject({ status: "ok", guardOutcome: "rewrite" });
  });

  it.each<[string, Record<string, unknown>]>([
    ["a tool's name", { messages: user, tools: [{ type: "function", function: { name: EMAIL } }] }],
    ["a schema's property name", { messages: user, tools: tool({ parameters: { type: "object", properties: { [EMAIL]: { type: "string" } } } }) }]
  ])("blocks when a rewrite would change %s: the request would stop making sense", async (_where, body) => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-rw2", name: "Rewrite", version: "1", channels: { prompt: dlpChannel("redact") } }, gw.set.id);
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", ...body });
    expect(response.status).toBe(400);
    expect(fixture.upstream.requests).toHaveLength(0);
  });

  it("leaves a request with no rule set exactly as the caller sent it", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: EMAIL }], user: EMAIL, stop: EMAIL });
    expect(response.status).toBe(200);
    expect(fixture.upstream.requests[0]!.body).toMatchObject({ user: EMAIL, stop: [EMAIL], messages: [{ role: "user", content: EMAIL }] });
    expect((await requestsOf(fixture))[0]).toMatchObject({ guardOutcome: "none" });
  });
});

describe("admin API", () => {
  it("lets builders read and only admins change; validates providers, secrets and aliases", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    const authService = new AuthService(fixture.store, 24);
    await authService.register({ email: "builder@example.com", password: "Builder-Pass-123!", role: "builder" });
    const login = await fixture.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "builder@example.com", password: "Builder-Pass-123!" } });
    const builder = String([login.headers["set-cookie"]].flat()[0]).split(";")[0]!;
    const list = await api<{ routeSets: Array<{ id: string; routes: AiGatewayRoute[]; clientIds: string[] }> }>(fixture, "GET", "/api/ai-gateway/route-sets", undefined, builder);
    expect(list.status).toBe(200);
    expect(list.body.routeSets[0]!.clientIds).toEqual([gw.client.id]);
    expect(JSON.stringify(list.body)).not.toContain(UPSTREAM_KEY);
    expect((await api(fixture, "POST", "/api/ai-gateway/route-sets", { name: "x" }, builder)).status).toBe(403);
    expect((await api(fixture, "PUT", `/api/ai-gateway/clients/${gw.client.id}/grants`, { routeSetIds: [] }, builder)).status).toBe(403);

    const route = (body: Record<string, unknown>) => api(fixture, "POST", `/api/ai-gateway/route-sets/${gw.set.id}/routes`, { alias: "new-one", providerId: "openai_compatible", model: "m", ...body });
    expect((await route({ alias: "gpt-test" })).status).toBe(409);
    expect((await route({ providerId: "nope" })).status).toBe(400);
    expect((await route({ kind: "embedding", providerId: "anthropic" })).status).toBe(400);
    expect((await route({ secretRef: { secretId: "sec_missing" } })).status).toBe(400);
    expect((await route({ extra: { apiKey: "inline" } })).status).toBe(400);
    expect((await api(fixture, "POST", "/api/ai-gateway/route-sets", { name: "x", projectId: "no-such-project" })).status).toBe(400);

    // Spend is admin-only, like /api/usage/*: a builder reads the routes, not what any project spent.
    expect((await api(fixture, "GET", "/api/ai-gateway/usage?window=24h", undefined, builder)).status).toBe(403);
    expect((await api(fixture, "GET", "/api/ai-gateway/requests?window=24h", undefined, builder)).status).toBe(403);
    const usage = await api<{ totals: { requests: number } }>(fixture, "GET", "/api/ai-gateway/usage?window=24h");
    expect(usage.status).toBe(200);
    expect(usage.body.totals.requests).toBe(0);
    expect((await api(fixture, "GET", "/api/ai-gateway/requests?window=24h")).status).toBe(200);

    expect((await api(fixture, "DELETE", `/api/ai-gateway/route-sets/${gw.set.id}`)).status).toBe(204);
    expect(await fixture.store.listAiGatewayClientGrants(gw.client.id)).toEqual([]);
    expect((await v1(fixture, gw.token, "/v1/models").then((response) => response.json())) as { data: unknown[] }).toEqual({ object: "list", data: [] });
  });
});

describe("model allowlists on /v1", () => {
  const CHAT = { model: "gpt-test", messages: [{ role: "user", content: "hi" }] };
  const STREAM = { ...CHAT, stream: true };
  const EMBED = { model: "embed-test", input: "x" };

  async function allow(fixture: Fixture, entry: Record<string, unknown>) {
    const created = await api(fixture, "POST", "/api/model-allowlist", entry);
    expect(created.status, created.raw).toBe(201);
  }
  const deniedEvents = async (fixture: Fixture) => (await fixture.store.listAuditLogs({ eventType: "model_allowlist.call_denied", pageSize: 50 })).items;
  const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; message: string } }).error;

  it("refuses chat, stream and embeddings outside the deployment list: 403, nothing sent, no usage row, one audit per model", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await allow(fixture, { scope: "deployment", providerId: "openai", modelGlob: "gpt-4o" });
    for (const [url, body] of [["/v1/chat/completions", CHAT], ["/v1/chat/completions", STREAM], ["/v1/embeddings", EMBED]] as const) {
      const refused = await v1(fixture, gw.token, url, body);
      expect(refused.status, url).toBe(403);
      expect(refused.headers.get("content-type")).toContain("application/json");
      expect((await errorOf(refused)).code).toBe("model_not_allowed");
    }
    expect(fixture.upstream.requests).toHaveLength(0);
    expect(await requestsOf(fixture)).toHaveLength(0);
    const events = await deniedEvents(fixture);
    expect(events.map((event) => event.metadata as Record<string, unknown>).sort((a, b) => String(a.model).localeCompare(String(b.model)))).toEqual([
      expect.objectContaining({ source: "ai_gateway", operation: "embed", model: "up-embed", refusedBy: "deployment", clientId: gw.client.id }),
      expect.objectContaining({ source: "ai_gateway", operation: "generate", model: "up-model", refusedBy: "deployment", clientId: gw.client.id })
    ]);
  });

  it("answers chat, stream and embeddings on the list", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await allow(fixture, { scope: "deployment", providerId: "openai_compatible", modelGlob: "up-*" });
    expect((await v1(fixture, gw.token, "/v1/chat/completions", CHAT)).status).toBe(200);
    fixture.upstream.chat.push({ sse: [chunk({ content: "Hi" }, "stop")] });
    const streamed = await v1(fixture, gw.token, "/v1/chat/completions", STREAM);
    expect(streamed.status).toBe(200);
    expect(streamedText(frames(await streamed.text()))).toBe("Hi");
    expect((await v1(fixture, gw.token, "/v1/embeddings", EMBED)).status).toBe(200);
    expect(await deniedEvents(fixture)).toHaveLength(0);
  });

  it("with no list checks nothing: the same calls answer and nothing is audited", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    expect((await v1(fixture, gw.token, "/v1/chat/completions", CHAT)).status).toBe(200);
    fixture.upstream.chat.push({ sse: [chunk({ content: "Hi" }, "stop")] });
    expect((await v1(fixture, gw.token, "/v1/chat/completions", STREAM)).status).toBe(200);
    expect((await v1(fixture, gw.token, "/v1/embeddings", EMBED)).status).toBe(200);
    expect(await deniedEvents(fixture)).toHaveLength(0);
  });

  it("follows the route set's project, and a route set with no project uses the default project's list", async () => {
    const fixture = await setup();
    const narrow = await api<{ id?: string; project?: { id: string } }>(fixture, "POST", "/api/projects", { name: "Narrow" });
    expect(narrow.status, narrow.raw).toBeLessThan(300);
    const projectId = narrow.body.project?.id ?? narrow.body.id!;
    const gw = await gateway(fixture);
    await allow(fixture, { scope: "project", projectId, providerId: "openai", modelGlob: "gpt-4o" });
    // In the default project, the other project's list does not apply.
    expect((await v1(fixture, gw.token, "/v1/chat/completions", CHAT)).status).toBe(200);
    const moved = await api(fixture, "PUT", `/api/ai-gateway/route-sets/${gw.set.id}`, { projectId });
    expect(moved.status, moved.raw).toBe(200);
    const refused = await v1(fixture, gw.token, "/v1/chat/completions", CHAT);
    expect(refused.status).toBe(403);
    expect((await deniedEvents(fixture))[0]).toMatchObject({ projectId, metadata: { source: "ai_gateway", refusedBy: "project" } });
    // Back to no project: the default project's list.
    const cleared = await api(fixture, "PUT", `/api/ai-gateway/route-sets/${gw.set.id}`, { projectId: null });
    expect(cleared.status, cleared.raw).toBe(200);
    expect((await v1(fixture, gw.token, "/v1/chat/completions", CHAT)).status).toBe(200);
    await allow(fixture, { scope: "project", projectId: "default", providerId: "openai", modelGlob: "gpt-4o" });
    expect((await v1(fixture, gw.token, "/v1/chat/completions", CHAT)).status).toBe(403);
  });

  it("checks the Azure deployment a route sends, not the route's model field", async () => {
    const fixture = await setup();
    const set = await api<AiGatewayRouteSet>(fixture, "POST", "/api/ai-gateway/route-sets", { name: "Azure", projectId: "default" });
    const route = await api(fixture, "POST", `/api/ai-gateway/route-sets/${set.body.id}/routes`, {
      alias: "azure-chat",
      providerId: "azure_openai",
      model: "gpt-4o",
      baseUrl: fixture.upstream.baseUrl,
      secretRef: { secretId: fixture.secretId },
      extra: { deployment: "not-on-the-list" }
    });
    expect(route.status, route.raw).toBe(201);
    const { token } = await newClient(fixture, "Azure app", [set.body.id]);
    await allow(fixture, { scope: "deployment", providerId: "azure_openai", modelGlob: "gpt-4o" });
    const refused = await v1(fixture, token, "/v1/chat/completions", { model: "azure-chat", messages: [{ role: "user", content: "hi" }] });
    expect(refused.status).toBe(403);
    expect(fixture.upstream.requests).toHaveLength(0);
  });

  it("answers 503 with Retry-After and sends nothing when the list cannot be read", async () => {
    const fixture = await setup({}, (store) => {
      vi.spyOn(store, "listModelAllowlistEntries").mockRejectedValue(new Error("database is down at db.internal"));
    });
    const gw = await gateway(fixture);
    for (const [url, body] of [["/v1/chat/completions", CHAT], ["/v1/chat/completions", STREAM], ["/v1/embeddings", EMBED]] as const) {
      const refused = await v1(fixture, gw.token, url, body);
      expect(refused.status, url).toBe(503);
      expect(refused.headers.get("retry-after")).toBe("5");
      const text = await refused.text();
      expect(JSON.parse(text).error.code).toBe("service_unavailable");
      expect(text).not.toContain("db.internal");
    }
    expect(fixture.upstream.requests).toHaveLength(0);
  });

  it("answers 403, not an upstream error, when the list changes after admission and the provider registry refuses the call", async () => {
    // Admission passes (the seam allows), so the deployment-wide registry check is what refuses.
    const fixture = await setup({ aiGatewayCheckModel: async () => undefined });
    const gw = await gateway(fixture);
    await allow(fixture, { scope: "deployment", providerId: "openai", modelGlob: "gpt-4o" });
    for (const body of [CHAT, STREAM]) {
      const refused = await v1(fixture, gw.token, "/v1/chat/completions", body);
      expect(refused.status).toBe(403);
      expect((await errorOf(refused)).code).toBe("model_not_allowed");
    }
    expect(fixture.upstream.requests).toHaveLength(0);
  });
});

describe("Azure OpenAI prices apply to /v1 only", () => {
  const LARGE_USAGE = { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 };
  /** gpt-4o at $2.50 in and $10 out per 1M tokens. */
  const V1_COST = 0.0125;

  function azureWorkflow(fixture: Fixture): Workflow {
    return {
      id: "wf-azure",
      name: "Azure run",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "trigger", type: "webhook_input", name: "Trigger", position: { x: 0, y: 0 }, config: { path: "azure-run", method: "POST" } },
        { id: "agent", type: "agent_orchestrator", name: "Agent", position: { x: 200, y: 0 }, config: { userPromptTemplate: "hello", maxIterations: 2, toolCallingEnabled: false } },
        {
          id: "agent_chat",
          type: "llm_call",
          name: "Agent model",
          position: { x: 200, y: 200 },
          config: {
            provider: { providerId: "azure_openai", model: "gpt-4o", baseUrl: fixture.upstream.baseUrl, secretRef: { secretId: fixture.secretId } },
            promptKey: "prompt",
            systemPromptKey: "system_prompt"
          }
        },
        { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: { responseTemplate: "{{answer}}", outputKey: "result" } }
      ],
      edges: [
        { id: "e1", source: "trigger", target: "agent" },
        { id: "e2", source: "agent", target: "out" },
        { id: "e3", source: "agent", sourceHandle: "chat_model", target: "agent_chat" }
      ]
    } as Workflow;
  }

  const window = () => ({ from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() });

  it("keeps an Azure run unpriced and out of USD budgets, while the same model through /v1 is priced and counted", async () => {
    const fixture = await setup();
    await fixture.store.upsertWorkflow(azureWorkflow(fixture), {});
    const budget = await api(fixture, "POST", "/api/budgets", { name: "All", scopeType: "global", period: "day", limitType: "usd", limitValue: 0.01, action: "block" });
    expect(budget.status, budget.raw).toBe(200);

    // Two runs: tokens are recorded as before, the cost stays zero and the budget never fills.
    for (let run = 0; run < 2; run += 1) {
      fixture.upstream.chat.push({ json: completion("Hi", {}, LARGE_USAGE) });
      const executed = await api<{ status: string }>(fixture, "POST", "/api/workflows/wf-azure/execute", { input: {} });
      expect(executed.status, executed.raw).toBe(200);
      expect(executed.body.status).toBe("success");
    }
    expect(fixture.upstream.requests).toHaveLength(2);
    await until(async () => (await fixture.store.queryBudgetUsage({ ...window(), workflowId: "wf-azure" })).totalTokens === 4000, "the runs' usage");
    expect(await fixture.store.queryBudgetUsage({ ...window(), workflowId: "wf-azure" })).toEqual({ costUsd: 0, totalTokens: 4000 });
    expect((await fixture.store.queryBudgetUsage(window())).costUsd).toBe(0);

    // The same model on /v1 has a price, and it fills the same budget.
    const set = await api<AiGatewayRouteSet>(fixture, "POST", "/api/ai-gateway/route-sets", { name: "Azure", projectId: "default" });
    await api(fixture, "POST", `/api/ai-gateway/route-sets/${set.body.id}/routes`, { alias: "azure-chat", providerId: "azure_openai", model: "gpt-4o", baseUrl: fixture.upstream.baseUrl, secretRef: { secretId: fixture.secretId } });
    const { token } = await newClient(fixture, "Azure app", [set.body.id]);
    const chat = { model: "azure-chat", messages: [{ role: "user", content: "hi" }] };
    fixture.upstream.chat.push({ json: completion("Hi", {}, LARGE_USAGE) });
    expect((await v1(fixture, token, "/v1/chat/completions", chat)).status).toBe(200);
    expect((await requestsOf(fixture))[0]).toMatchObject({ providerId: "azure_openai", costUsd: V1_COST, totalTokens: 2000 });
    expect((await fixture.store.queryBudgetUsage(window())).costUsd).toBeCloseTo(V1_COST, 6);
    expect((await v1(fixture, token, "/v1/chat/completions", chat)).status).toBe(429);
  });

  it("sends an image on an Azure /v1 route, which a workflow run on the same provider does not", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    const azure = await api<AiGatewayRoute>(fixture, "POST", `/api/ai-gateway/route-sets/${gw.set.id}/routes`, {
      alias: "azure-vision",
      providerId: "azure_openai",
      model: "gpt-4o",
      baseUrl: fixture.upstream.baseUrl,
      secretRef: { secretId: fixture.secretId }
    });
    expect(azure.status, azure.raw).toBe(201);
    const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "azure-vision", messages: [{ role: "user", content: [{ type: "text", text: "look" }, image] }] });
    expect(response.status).toBe(200);
    expect(fixture.upstream.requests[0]!.body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }]);
  });

  it("shows the same pricing table to admins as before", async () => {
    const fixture = await setup();
    const { pricing } = (await api<{ pricing: Record<string, Record<string, unknown>> }>(fixture, "GET", "/api/usage/pricing")).body;
    expect(pricing.azure_openai).toBeUndefined();
    expect(pricing.openai?.["text-embedding-3-small"]).toBeUndefined();
  });
});
