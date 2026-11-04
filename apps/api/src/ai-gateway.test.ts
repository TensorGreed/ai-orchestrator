/**
 * 12.6b — the OpenAI-compatible /v1 AI gateway, called the way an OpenAI SDK calls it (fetch, Bearer token, JSON or
 * SSE) against an in-process OpenAI-compatible upstream on 127.0.0.1 (no outside network).
 *
 * Covers the admission order (token, grant, rate limit, budget, allowlist, Guard), streaming (chunks, usage, [DONE],
 * caller abort cancelling the upstream), tools passed through, embeddings, the OpenAI error envelope, Guard on the
 * prompt and the answer (a mid-stream cut, and buffered mode for a rewriting profile), usage rows counted by budgets,
 * and that with no route set /v1 does nothing.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AiGatewayRoute, AiGatewayRouteSet, McpClient } from "@ai-orchestrator/shared";
import { createApp, type CreateAppOptions } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { AuthService } from "./services/auth-service.js";
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
  | { sse: Array<unknown>; gapMs?: number; hang?: boolean };

interface Upstream {
  baseUrl: string;
  requests: UpstreamRequest[];
  /** The next chat answers (first in, first out); the default answers "Hello from upstream." */
  chat: UpstreamAnswer[];
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
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => (raw += String(part)));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      if (req.headers.authorization !== `Bearer ${UPSTREAM_KEY}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "bad key" } }));
        return;
      }
      if (req.url === "/v1/embeddings") {
        const inputs = body.input as string[];
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            object: "list",
            data: inputs.map((text, index) => ({ object: "embedding", index, embedding: [text.length, 0.5, -1] })),
            model: "up-embed",
            usage: { prompt_tokens: inputs.length * 2, total_tokens: inputs.length * 2 }
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
        res.write("data: [DONE]\n\n");
        finished = true;
        res.end();
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    chat,
    closedEarly,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
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

async function setup(options: CreateAppOptions = {}): Promise<Fixture> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-aigw-"));
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
    expect((await requestsOf(fixture))[0]).toMatchObject({ stream: true, status: "ok", totalTokens: 7, finishReason: "stop" });
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

describe("Guard on /v1", () => {
  it("blocks a prompt with 400 content_filter and never calls the provider", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-prompt", name: "Prompt", version: "1", channels: { prompt: dlpChannel("block") } }, gw.set.id);
    const blocked = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: `Mail ${EMAIL}` }] });
    expect(blocked.status).toBe(400);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("content_filter");
    expect(fixture.upstream.requests).toHaveLength(0);
    expect((await requestsOf(fixture))[0]).toMatchObject({ status: "blocked_prompt", guardOutcome: "block" });
    expect((await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "fine" }] })).status).toBe(200);
  });

  it("cuts a stream whose answer is blocked, with finish_reason content_filter, and sends nothing unchecked", async () => {
    const fixture = await setup();
    const gw = await gateway(fixture);
    await guardProfile(fixture, { id: "aigw-out", name: "Out", version: "1", channels: { final_output: dlpChannel("block") } }, gw.set.id);
    const opening = "This first sentence is harmless and long enough to be checked. ";
    fixture.upstream.chat.push({
      sse: [chunk({ role: "assistant", content: "" }), chunk({ content: opening }), chunk({ content: `Write to ${EMAIL} ` }), chunk({ content: "for more." }), chunk({}, "stop")]
    });
    const response = await v1(fixture, gw.token, "/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain(EMAIL);
    const list = frames(raw);
    expect(streamedText(list)).toBe(opening);
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
    }, "the Guard events");
    expect(events.filter((event) => event.channel === "final_output")).toHaveLength(1);
    expect(events.every((event) => event.placement === "gateway" && event.nodeId === "gpt-test")).toBe(true);
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

    const usage = await api<{ totals: { requests: number } }>(fixture, "GET", "/api/ai-gateway/usage?window=24h", undefined, builder);
    expect(usage.status).toBe(200);
    expect(usage.body.totals.requests).toBe(0);

    expect((await api(fixture, "DELETE", `/api/ai-gateway/route-sets/${gw.set.id}`)).status).toBe(204);
    expect(await fixture.store.listAiGatewayClientGrants(gw.client.id)).toEqual([]);
    expect((await v1(fixture, gw.token, "/v1/models").then((response) => response.json())) as { data: unknown[] }).toEqual({ object: "list", data: [] });
  });
});
