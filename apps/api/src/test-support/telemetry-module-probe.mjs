/**
 * Child-process probe for telemetry-off.test.ts. Run with `node --import tsx <this file> '<env JSON>'`: it records every
 * module the process resolves, builds the API with the given settings, serves a few requests (with a `traceparent`), runs a workflow with a model call,
 * closes it, and prints the OpenTelemetry modules that were loaded as one JSON line.
 */
import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const otelModules = new Set();
let resolved = 0;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    resolved += 1;
    if (/@opentelemetry|\/packages\/otel\//.test(result.url)) otelModules.add(result.url);
    return result;
  }
});

const env = JSON.parse(process.argv[2] ?? "{}");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-otel-probe-"));
try {
  const { parseConfig } = await import("../config.ts");
  const { createApp } = await import("../app.ts");
  const { createStore } = await import("../db/create-store.ts");
  const { SecretService } = await import("../services/secret-service.ts");
  const { AuthService } = await import("../services/auth-service.ts");
  const config = parseConfig({
    LOG_LEVEL: "error",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    ...env
  });
  const store = await createStore({ dbFilePath: path.join(tempDir, "orchestrator.db"), env: {}, log: { info() {}, warn() {} } });
  const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), new AuthService(store, config.SESSION_TTL_HOURS), undefined, undefined, undefined, {
    logStream: { write() {} }
  });
  await app.ready();
  const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  for (const url of ["/health", "/api/workflows", "/api/auth/me", "/no/such/route"]) {
    await app.inject({ method: "GET", url, headers: { traceparent } });
  }
  // A run with a model call (the echo provider: no network), so the model-call path is exercised too.
  const auth = new AuthService(store, config.SESSION_TTL_HOURS);
  await auth.register({ email: "probe@example.com", password: "Probe-Pass-123!", role: "admin" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "probe@example.com", password: "Probe-Pass-123!" } });
  const cookie = String([login.headers["set-cookie"]].flat().find((value) => String(value).startsWith(`${config.SESSION_COOKIE_NAME}=`))).split(";")[0];
  const at = { x: 0, y: 0 };
  await store.upsertWorkflow({
    id: "probe-llm",
    name: "Probe",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "text", type: "text_input", name: "text", position: at, config: { text: "hello" } },
      { id: "prompt", type: "prompt_template", name: "prompt", position: at, config: { template: "{{user_prompt}}", outputKey: "prompt" } },
      { id: "llm", type: "llm_call", name: "llm", position: at, config: { provider: { providerId: "echo", model: "demo" }, promptKey: "prompt" } },
      { id: "out", type: "output", name: "out", position: at, config: { responseTemplate: "{{answer}}", outputKey: "result" } }
    ],
    edges: [
      { id: "e1", source: "text", target: "prompt" },
      { id: "e2", source: "prompt", target: "llm" },
      { id: "e3", source: "llm", target: "out" }
    ]
  });
  const run = await app.inject({ method: "POST", url: "/api/workflows/probe-llm/execute", headers: { cookie, traceparent }, payload: {} });
  if (run.statusCode !== 200 || run.json().status !== "success") throw new Error(`probe run failed: ${run.statusCode} ${run.body}`);
  await app.close();
  await store.close();
  process.stdout.write(`${JSON.stringify({ resolved, otelModules: [...otelModules] })}\n`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
