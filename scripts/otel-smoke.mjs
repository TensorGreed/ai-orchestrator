// OpenTelemetry smoke test. Proves that a real API process exports its traces and metrics over OTLP/HTTP, with no
// collector or other outside service:
//
//   1. Starts a small OTLP/HTTP receiver on 127.0.0.1 that appends every request it gets to a JSON-lines file
//      (<work dir>/otlp-received.jsonl): path, content type, the authorization header and the body.
//   2. Starts the API (node --import tsx apps/api/src/index.ts) on a temporary SQLite database and a free port, with
//      OTEL_EXPORTER_OTLP_ENDPOINT pointing at the receiver, OTLP metrics on, and a long batch delay and metrics
//      interval, so what arrives is what the exit flush sends.
//   3. Signs in, saves the zero-key MCP agent quickstart (echo model, in-process mock MCP server) and runs it with a
//      W3C traceparent, then reads the run back to get its stored trace id.
//   4. Sends SIGTERM and waits for the process to exit, then checks the file: one trace holding the HTTP request, the
//      run, its nodes, the agent loop and the model call, in that parent order and under the caller's trace id (a
//      signed-in caller's context is continued); the run's stored trace id; the decoded OTLP auth header; the
//      resource; the metrics; and that no secret value (the master key, the OTLP token, the admin password) was sent.
//
//   node scripts/otel-smoke.mjs [--protocol http/json|http/protobuf] [--keep] [--json]
//
// http/json (the default here) is decoded and checked in full; with http/protobuf (the API's default) the check is
// that both signals arrived with the protobuf content type and carry the expected names. --keep keeps the work
// directory (database, API log and the received file); --json prints a one-line summary for scripts and tests.
// Exit codes: 0 pass, 1 a check failed, 2 bad arguments, 3 apps/api/.env sets a setting the smoke test needs.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = path.join(repoRoot, "apps", "api");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const protocol = option("--protocol") ?? "http/json";
if (protocol !== "http/json" && protocol !== "http/protobuf") {
  console.error("--protocol must be http/json or http/protobuf");
  process.exit(2);
}
const keep = args.includes("--keep");
const jsonSummary = args.includes("--json");
const say = (line) => {
  if (!jsonSummary) console.log(line);
};

// apps/api/.env is loaded over the environment (env-files.ts), so it could point the instance elsewhere. Refuse
// rather than guess. The root .env never overrides: every setting below is passed explicitly.
const apiEnvFile = path.join(apiDir, ".env");
if (fs.existsSync(apiEnvFile)) {
  const clashing = fs
    .readFileSync(apiEnvFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*export\s+/, "").split("=")[0]?.trim() ?? "")
    .filter((key) => /^(OTEL_|L2M_OTEL_|TRACING_|DB_|API_|SECRET_MASTER_KEY|BOOTSTRAP_ADMIN|SEED_|METRICS_|WORKER_MODE|SHUTDOWN_DRAIN)/.test(key));
  if (clashing.length > 0) {
    console.error(`apps/api/.env sets ${clashing.join(", ")}, which would override the smoke test's settings. Move it aside while it runs.`);
    process.exit(3);
  }
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-otel-smoke-"));
const receivedFile = path.join(workDir, "otlp-received.jsonl");
const apiLogFile = path.join(workDir, "api.log");
const MASTER_KEY = crypto.randomBytes(32).toString("base64");
const OTLP_TOKEN = `smoke-${crypto.randomBytes(12).toString("hex")}`;
const ADMIN = { email: "otel-smoke@example.com", password: `Smoke-${crypto.randomBytes(9).toString("hex")}` };
const SERVICE_NAME = "l2m-otel-smoke";
const INBOUND_TRACE_ID = crypto.randomBytes(16).toString("hex");
const INBOUND = `00-${INBOUND_TRACE_ID}-${crypto.randomBytes(8).toString("hex")}-01`;
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  return ok;
};

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// 1. The OTLP receiver: answers 200 to every export and appends it to the file.
const receiver = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks);
    const contentType = String(request.headers["content-type"] ?? "");
    const entry = {
      path: request.url,
      contentType,
      authorization: request.headers.authorization ?? null,
      body: contentType.includes("json") ? body.toString("utf8") : body.toString("base64")
    };
    fs.appendFileSync(receivedFile, `${JSON.stringify(entry)}\n`);
    response.writeHead(200, { "content-type": contentType.includes("json") ? "application/json" : "application/x-protobuf" });
    response.end(contentType.includes("json") ? "{}" : "");
  });
});
await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
const receiverUrl = `http://127.0.0.1:${receiver.address().port}`;

// 2. The API, with a minimal environment so nothing from the caller's shell changes it.
const apiPort = await freePort();
const apiUrl = `http://127.0.0.1:${apiPort}`;
const keepKeys = ["PATH", "HOME", "TMPDIR", "LANG", "SystemRoot", "PNPM_HOME", "XDG_CACHE_HOME"];
const env = Object.fromEntries(keepKeys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
Object.assign(env, {
  API_HOST: "127.0.0.1",
  API_PORT: String(apiPort),
  DB_TYPE: "sqlite",
  DB_SQLITE_PATH: path.join(workDir, "orchestrator.db"),
  SECRET_MASTER_KEY_BASE64: MASTER_KEY,
  BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
  BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
  SEED_SAMPLE_WORKFLOWS: "false",
  COOKIE_SECURE: "false",
  RATE_LIMIT_ENABLED: "false",
  MCP_PROBE_INTERVAL_MS: "0",
  WORKER_MODE: "all",
  GIT_SYNC_WORKDIR: path.join(workDir, "sync"),
  LOG_LEVEL: "info",
  // Tracing and metrics, to the receiver.
  OTEL_EXPORTER_OTLP_ENDPOINT: receiverUrl,
  OTEL_EXPORTER_OTLP_PROTOCOL: protocol,
  OTEL_EXPORTER_OTLP_HEADERS: `authorization=Bearer%20${OTLP_TOKEN}`,
  OTEL_SERVICE_NAME: SERVICE_NAME,
  OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=smoke",
  OTEL_METRICS_ENABLED: "true",
  OTEL_METRICS_PUSH_INTERVAL_MS: "600000",
  // Nothing is exported before the stop, so the spans prove the exit flush.
  OTEL_BSP_SCHEDULE_DELAY: "600000",
  // Blank values: a root .env must not change these (an empty standard variable means its default).
  OTEL_SDK_DISABLED: "",
  OTEL_TRACES_SAMPLER: "",
  OTEL_PROPAGATORS: "",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "",
  SHUTDOWN_DRAIN_MS: "",
  TRACING_ENDPOINT: ""
});
const apiLog = fs.openSync(apiLogFile, "w");
const api = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: apiDir, env, stdio: ["ignore", apiLog, apiLog] });
const exited = new Promise((resolve) => api.once("exit", (code, signal) => resolve({ code, signal })));

function apiLogTail() {
  try {
    return fs.readFileSync(apiLogFile, "utf8").trim().split("\n").slice(-30).join("\n").replaceAll(MASTER_KEY, "***").replaceAll(OTLP_TOKEN, "***");
  } catch {
    return "";
  }
}

async function waitForHealth() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) throw new Error(`the API exited during start-up:\n${apiLogTail()}`);
    try {
      const response = await fetch(`${apiUrl}/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the API did not answer /health within 90 s:\n${apiLogTail()}`);
}

async function call(method, url, { cookie, body, headers = {} } = {}) {
  const response = await fetch(`${apiUrl}${url}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text, headers: response.headers };
}

// OTLP/JSON helpers.
const attributeValue = (value) => {
  if (!value) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("boolValue" in value) return value.boolValue;
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(attributeValue);
  return undefined;
};
const attributesOf = (list) => Object.fromEntries((list ?? []).map((entry) => [entry.key, attributeValue(entry.value)]));

let executionId;
let storedTraceId;
let summary = {};
try {
  await waitForHealth();
  say(`API up on ${apiUrl}, OTLP receiver on ${receiverUrl} (${protocol})`);

  // 3. Sign in, save the quickstart agent, run it with a traceparent.
  const login = await call("POST", "/api/auth/login", { body: ADMIN });
  if (login.status !== 200) throw new Error(`sign-in failed: ${login.status} ${login.text}`);
  const cookie = String(login.headers.get("set-cookie") ?? "")
    .split(/,(?=\s*\w+=)/)
    .map((part) => part.split(";")[0].trim())
    .find((part) => part.startsWith("ao_session="));
  if (!cookie) throw new Error("sign-in set no session cookie");
  const sample = JSON.parse(fs.readFileSync(path.join(repoRoot, "samples", "workflows", "mcp-agent-quickstart-flow.json"), "utf8"));
  const workflow = { ...sample.workflow, id: "otel-smoke-agent", name: "OTel smoke agent" };
  const saved = await call("POST", "/api/workflows", { cookie, body: workflow });
  if (saved.status !== 200) throw new Error(`saving the workflow failed: ${saved.status} ${saved.text}`);
  const run = await call("POST", `/api/workflows/${workflow.id}/execute`, {
    cookie,
    headers: { traceparent: INBOUND },
    body: { user_prompt: "What time is it?" }
  });
  if (run.status !== 200 || run.json?.status !== "success") {
    const nodeErrors = (run.json?.nodeResults ?? []).filter((node) => node.status === "error").map((node) => `${node.nodeId}: ${node.error}`);
    throw new Error(`the run failed (${run.status}): ${nodeErrors.join("; ") || run.text.slice(0, 500)}`);
  }
  executionId = run.json.executionId;
  const history = await call("GET", `/api/executions/${encodeURIComponent(executionId)}`, { cookie });
  storedTraceId = history.json?.traceId ?? history.json?.execution?.traceId;
  say(`ran ${workflow.id} as ${executionId}; stored trace id ${storedTraceId}`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

// 4. Stop the API with SIGTERM: it flushes the queued spans and the last metrics before it exits.
const before = fs.existsSync(receivedFile) ? fs.readFileSync(receivedFile, "utf8").trim().split("\n").filter(Boolean).length : 0;
if (api.exitCode === null) api.kill("SIGTERM");
const stopTimer = setTimeout(() => api.kill("SIGKILL"), 20_000);
const exit = await exited;
clearTimeout(stopTimer);
fs.closeSync(apiLog);
await new Promise((resolve) => receiver.close(resolve));

const received = fs.existsSync(receivedFile)
  ? fs
      .readFileSync(receivedFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  : [];
const traceExports = received.filter((entry) => entry.path === "/v1/traces");
const metricExports = received.filter((entry) => entry.path === "/v1/metrics");
check(exit.signal === "SIGTERM" || exit.code === 143, `the API should exit by SIGTERM after flushing, got code ${exit.code} signal ${exit.signal}`);
check(before === 0, `nothing should be exported before the stop (batch delay and metrics interval are 10 minutes), got ${before} request(s)`);
check(traceExports.length > 0, "no trace export arrived at /v1/traces");
check(metricExports.length > 0, "no metrics export arrived at /v1/metrics");
for (const entry of received) {
  check(entry.authorization === `Bearer ${OTLP_TOKEN}`, `an export to ${entry.path} did not carry the decoded OTLP header`);
}
const everything = received.map((entry) => (entry.contentType.includes("json") ? entry.body : Buffer.from(entry.body, "base64").toString("latin1"))).join("\n");
for (const [label, secret] of [
  ["the master key", MASTER_KEY],
  ["the OTLP token", OTLP_TOKEN],
  ["the admin password", ADMIN.password]
]) {
  check(!everything.includes(secret), `${label} appears in what was exported`);
}

const expectedNames = ["POST /api/workflows/:id/execute", "invoke_workflow OTel smoke agent", "l2m.node agent_orchestrator", "invoke_agent Agent", "chat demo"];
if (protocol === "http/json") {
  const spans = [];
  let resource = {};
  for (const entry of traceExports) {
    const payload = JSON.parse(entry.body);
    for (const resourceSpans of payload.resourceSpans ?? []) {
      resource = { ...resource, ...attributesOf(resourceSpans.resource?.attributes) };
      for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
        for (const span of scopeSpans.spans ?? []) spans.push({ ...span, attributes: attributesOf(span.attributes) });
      }
    }
  }
  check(resource["service.name"] === SERVICE_NAME, `resource service.name should be ${SERVICE_NAME}, got ${resource["service.name"]}`);
  check(resource["deployment.environment.name"] === "smoke", "resource should carry deployment.environment.name from OTEL_RESOURCE_ATTRIBUTES");
  const byName = (name) => spans.filter((span) => span.name === name);
  const [server, runSpan, nodeSpan, agentSpan, chatSpan] = expectedNames.map((name) => {
    const found = byName(name);
    check(found.length >= 1, `no span named "${name}" (got: ${[...new Set(spans.map((span) => span.name))].join(", ")})`);
    return found[0];
  });
  if (server && runSpan && nodeSpan && agentSpan && chatSpan) {
    check(server.traceId === INBOUND_TRACE_ID, "the HTTP span should continue the signed-in caller's trace id");
    check(server.kind === 2, "the HTTP span should be a SERVER span");
    check(chatSpan.kind === 3, "the model call should be a CLIENT span");
    check(runSpan.parentSpanId === server.spanId, "invoke_workflow should be a child of the HTTP span");
    check(nodeSpan.parentSpanId === runSpan.spanId, "the agent node span should be a child of invoke_workflow");
    check(agentSpan.parentSpanId === nodeSpan.spanId, "invoke_agent should be a child of the agent node span");
    check(chatSpan.parentSpanId === agentSpan.spanId, "the model call should be a child of invoke_agent");
    check(runSpan.attributes["l2m.execution.id"] === executionId, "invoke_workflow should carry l2m.execution.id");
    check(chatSpan.attributes["gen_ai.provider.name"] === "echo", "the chat span should name its provider");
    // The agent lists the mock MCP server's tools: an MCP CLIENT span in the same run.
    const listing = byName("tools/list").find((span) => span.attributes["l2m.mcp.server.id"] === "mock-mcp");
    check(listing !== undefined && listing.kind === 3 && listing.traceId === INBOUND_TRACE_ID, "no tools/list CLIENT span for the mock MCP server in the run's trace");
    check(storedTraceId === INBOUND_TRACE_ID, `the run's stored trace id should be ${INBOUND_TRACE_ID}, got ${storedTraceId}`);
    for (const span of [server, runSpan, nodeSpan, agentSpan, chatSpan]) {
      check(span.traceId === INBOUND_TRACE_ID, `span "${span.name}" is not in the run's trace`);
    }
  }
  const metricNames = new Set();
  for (const entry of metricExports) {
    const payload = JSON.parse(entry.body);
    for (const resourceMetrics of payload.resourceMetrics ?? []) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
        for (const metric of scopeMetrics.metrics ?? []) metricNames.add(metric.name);
      }
    }
  }
  for (const name of ["ao.http.requests.total", "ao.workflow.executions.total", "gen_ai.client.operation.duration"]) {
    check(metricNames.has(name), `metric ${name} was not exported (got: ${[...metricNames].sort().join(", ")})`);
  }
  summary = { spans: spans.length, spanNames: [...new Set(spans.map((span) => span.name))].sort(), metrics: [...metricNames].sort() };
} else {
  for (const entry of received) {
    check(entry.contentType === "application/x-protobuf", `an export to ${entry.path} had content type ${entry.contentType}`);
  }
  const traceBytes = traceExports.map((entry) => Buffer.from(entry.body, "base64").toString("latin1")).join("\n");
  for (const name of expectedNames) check(traceBytes.includes(name), `no span named "${name}" in the protobuf export`);
  check(traceBytes.includes(Buffer.from(INBOUND_TRACE_ID, "hex").toString("latin1")), "the protobuf export does not carry the caller's trace id");
  const metricBytes = metricExports.map((entry) => Buffer.from(entry.body, "base64").toString("latin1")).join("\n");
  check(metricBytes.includes("gen_ai.client.operation.duration"), "the protobuf metrics export has no gen_ai.client.operation.duration");
  check(storedTraceId === INBOUND_TRACE_ID, `the run's stored trace id should be ${INBOUND_TRACE_ID}, got ${storedTraceId}`);
}

const result = {
  ok: failures.length === 0,
  protocol,
  traceExports: traceExports.length,
  metricExports: metricExports.length,
  ...summary,
  failures,
  ...(keep ? { workDir } : {})
};
if (jsonSummary) {
  console.log(JSON.stringify(result));
} else if (failures.length === 0) {
  say(`PASS: ${traceExports.length} trace and ${metricExports.length} metrics export(s) after SIGTERM${summary.spans ? `, ${summary.spans} spans` : ""}`);
} else {
  console.error(`FAIL:\n- ${failures.join("\n- ")}\n\nAPI log (last lines):\n${apiLogTail()}`);
}
if (keep) say(`work directory kept: ${workDir}`);
else fs.rmSync(workDir, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
