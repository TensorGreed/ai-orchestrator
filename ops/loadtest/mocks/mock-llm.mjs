// Mock OpenAI-compatible chat model for the scale harness. Dependency-free: `node mock-llm.mjs`.
//
// POST /v1/chat/completions answers like an OpenAI chat model, after a configurable delay:
//   - while the request offers tools and fewer than LLM_TOOL_CALLS tool results follow the last user message, it asks
//     for one tool call (the offered tools in turn, arguments filled from each tool's required properties; the agent's
//     own tools matching LLM_SKIP_TOOLS, such as agent_clarify, are never called);
//   - otherwise it gives a final answer of LLM_ANSWER_TOKENS tokens.
// With "stream": true the answer is sent as server-sent events at LLM_TOKENS_PER_SEC.
// An agent with three MCP tools therefore makes four model calls per run.
//
// GET  /echo?delay_ms=N   answers {"ok":true,...} after N ms (the HTTP node of workload W3 calls it)
// GET  /stats             request counters;  POST /stats/reset clears them
// GET  /health            liveness
//
// Settings (environment): PORT (8080), LLM_LATENCY_MS (800), LLM_JITTER_MS (200), LLM_TOKENS_PER_SEC (50),
// LLM_TOOL_CALLS (3), LLM_ANSWER_TOKENS (20), LLM_SKIP_TOOLS (a regular expression, ^(agent_clarify|session_cache_)).

import { createServer } from "node:http";

const intFromEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const PORT = intFromEnv("PORT", 8080);
const LATENCY_MS = intFromEnv("LLM_LATENCY_MS", 800);
const JITTER_MS = intFromEnv("LLM_JITTER_MS", 200);
const TOKENS_PER_SEC = Math.max(1, intFromEnv("LLM_TOKENS_PER_SEC", 50));
const TOOL_CALLS = intFromEnv("LLM_TOOL_CALLS", 3);
const ANSWER_TOKENS = Math.max(1, intFromEnv("LLM_ANSWER_TOKENS", 20));
const SKIP_TOOLS = new RegExp(process.env.LLM_SKIP_TOOLS || "^(agent_clarify|session_cache_)");
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const stats = { completions: 0, streamed: 0, toolCallAnswers: 0, finalAnswers: 0, echo: 0, errors: 0 };
let callSeq = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jittered = () => Math.max(0, LATENCY_MS + Math.round((Math.random() * 2 - 1) * JITTER_MS));

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

/** Arguments that satisfy a JSON schema's required properties well enough for the mock MCP server. */
function sampleArguments(schema) {
  const args = {};
  const properties = schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = Array.isArray(schema?.required) ? schema.required : Object.keys(properties);
  for (const key of required) {
    const type = properties[key]?.type;
    if (type === "number" || type === "integer") args[key] = 7;
    else if (type === "boolean") args[key] = true;
    else args[key] = `load-${key}`;
  }
  return args;
}

/** The tool call to make next, or null for a final answer. */
function nextToolCall(payload) {
  const tools = Array.isArray(payload.tools)
    ? payload.tools.filter((tool) => typeof tool?.function?.name === "string" && !SKIP_TOOLS.test(tool.function.name))
    : [];
  if (tools.length === 0 || TOOL_CALLS === 0) return null;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  let lastUser = -1;
  messages.forEach((message, index) => {
    if (message?.role === "user") lastUser = index;
  });
  const toolResults = messages.slice(lastUser + 1).filter((message) => message?.role === "tool").length;
  if (toolResults >= TOOL_CALLS) return null;
  const tool = tools[toolResults % tools.length].function;
  callSeq += 1;
  return {
    id: `call_${Date.now().toString(36)}_${callSeq}`,
    type: "function",
    function: { name: tool.name, arguments: JSON.stringify(sampleArguments(tool.parameters)) }
  };
}

function answerTokens(payload) {
  const toolResults = (Array.isArray(payload.messages) ? payload.messages : []).filter((message) => message?.role === "tool").length;
  const words = [`done`, `after`, `${toolResults}`, `tool`, `calls.`];
  const tokens = [];
  for (let i = 0; i < ANSWER_TOKENS; i += 1) tokens.push(words[i % words.length]);
  return tokens;
}

function usage(payload, completionTokens) {
  const promptTokens = Math.max(1, Math.round(JSON.stringify(payload.messages ?? []).length / 4));
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
}

async function chatCompletion(request, response) {
  let payload;
  try {
    payload = JSON.parse((await readBody(request)) || "{}");
  } catch {
    stats.errors += 1;
    sendJson(response, 400, { error: { message: "invalid JSON body", type: "invalid_request_error" } });
    return;
  }
  stats.completions += 1;
  const model = typeof payload.model === "string" ? payload.model : "mock";
  const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  const toolCall = nextToolCall(payload);
  if (toolCall) stats.toolCallAnswers += 1;
  else stats.finalAnswers += 1;

  await sleep(jittered());

  if (payload.stream !== true) {
    const tokens = toolCall ? [] : answerTokens(payload);
    sendJson(response, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{
        index: 0,
        message: toolCall
          ? { role: "assistant", content: null, tool_calls: [toolCall] }
          : { role: "assistant", content: tokens.join(" ") },
        finish_reason: toolCall ? "tool_calls" : "stop"
      }],
      usage: usage(payload, toolCall ? 12 : tokens.length)
    });
    return;
  }

  stats.streamed += 1;
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (delta, finishReason = null, extra = {}) => {
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra })}\n\n`);
  };
  send({ role: "assistant", content: "" });
  if (toolCall) {
    send({ tool_calls: [{ index: 0, ...toolCall }] });
    send({}, "tool_calls", { usage: usage(payload, 12) });
  } else {
    const tokens = answerTokens(payload);
    const gapMs = Math.round(1000 / TOKENS_PER_SEC);
    for (let i = 0; i < tokens.length; i += 1) {
      if (response.destroyed) return;
      send({ content: i === 0 ? tokens[i] : ` ${tokens[i]}` });
      await sleep(gapMs);
    }
    send({}, "stop", { usage: usage(payload, tokens.length) });
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://mock-llm");
  try {
    if (request.method === "POST" && /\/chat\/completions$/.test(url.pathname)) {
      await chatCompletion(request, response);
      return;
    }
    if (request.method === "GET" && /\/models$/.test(url.pathname)) {
      sendJson(response, 200, { object: "list", data: [{ id: "mock", object: "model", owned_by: "l2m-loadtest" }] });
      return;
    }
    if (url.pathname === "/echo") {
      stats.echo += 1;
      const delay = Math.min(60_000, Math.max(0, Number.parseInt(url.searchParams.get("delay_ms") ?? "0", 10) || 0));
      if (request.method !== "GET" && request.method !== "HEAD") await readBody(request);
      await sleep(delay);
      sendJson(response, 200, { ok: true, delayMs: delay, at: new Date().toISOString(), tag: url.searchParams.get("tag") ?? null });
      return;
    }
    if (url.pathname === "/stats" && request.method === "GET") {
      sendJson(response, 200, { ...stats, settings: { LATENCY_MS, JITTER_MS, TOKENS_PER_SEC, TOOL_CALLS, ANSWER_TOKENS } });
      return;
    }
    if (url.pathname === "/stats/reset" && request.method === "POST") {
      for (const key of Object.keys(stats)) stats[key] = 0;
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: { message: `no route for ${request.method} ${url.pathname}` } });
  } catch (error) {
    stats.errors += 1;
    if (!response.headersSent) sendJson(response, 500, { error: { message: String(error?.message ?? error) } });
    else response.end();
  }
});

server.keepAliveTimeout = 65_000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`mock-llm listening on :${PORT} (latency ${LATENCY_MS}±${JITTER_MS} ms, ${TOKENS_PER_SEC} tok/s, ${TOOL_CALLS} tool calls)`);
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
