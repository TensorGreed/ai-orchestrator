/**
 * Phase 16 (p3) — the deployment's destination rules cannot be switched off
 * by a replay: every replay and gate case runs the latest rules profile,
 * whatever guard profile candidate it names; a builder cannot name the rules
 * profile as the candidate (403). Also the end-to-end runtime surrogate: a
 * `protect` destination rule sends a surrogate, capture keeps exactly that
 * surrogate, and a data-subject lookup for the original finds the capture.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { EvalCaseResult, EvalRunView, ReplayCaptureView, ReplayFindSubjectResult, ReplayRecordingSummary, Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { WorkflowVersionService } from "./services/workflow-version-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  secretService: SecretService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const closers: Array<() => Promise<void>> = [];
const MASTER_KEY = crypto.randomBytes(32).toString("base64");
const MODEL_KEY = "sk-model-DEST-key-0a1b2c3d4e5f60718293";
const CARD = "4111 1111 1111 1111";
const EMAIL = "jane.doe@example.com";

async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-dest-replay-"));
  const store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
  store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: MASTER_KEY,
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git"),
    ...overrides
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = createApp(config, store, secretService, authService);
  await app.ready();
  const context = { app, store, authService, secretService, config, tempDir };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    await context.app.close();
    try {
      context.store.close();
    } catch {
      // Closed by the app's shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

async function login(context: TestContext, role: "admin" | "builder"): Promise<{ cookie: string }> {
  const email = `${role}@example.com`;
  const password = `${role}-Pass-123!`;
  context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`))!;
  return { cookie: cookie.split(";")[0]! };
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An OpenAI-style endpoint that records every request body. */
async function startModel() {
  const calls: string[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      calls.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello" } }], usage: { prompt_tokens: 40, completion_tokens: 5 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind fake model");
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, calls };
}

async function startReceiver() {
  const bodies: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      bodies.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind receiver");
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${address.port}/hook`, bodies };
}

const node = (id: string, type: string, config: Record<string, unknown> = {}, x = 0) => ({ id, type, name: id, position: { x, y: 0 }, config });

function cardAgent(baseUrl: string, secretId: string): Workflow {
  return {
    id: "wf-cand",
    name: "Card agent",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      node("start", "manual_trigger"),
      node("agent_1", "agent_orchestrator", { systemPromptTemplate: "Be brief.", userPromptTemplate: `card ${CARD}`, maxIterations: 1, toolCallingEnabled: false }, 150),
      node("model", "llm_call", { provider: { providerId: "openai", model: "gpt-4o-mini", baseUrl, secretRef: { secretId }, extra: { maxRetries: 0 } } }, 150),
      node("output", "output", {}, 300)
    ],
    edges: [
      { id: "e1", source: "start", target: "agent_1" },
      { id: "e2", source: "agent_1", sourceHandle: "chat_model", target: "model" },
      { id: "e3", source: "agent_1", target: "output" }
    ]
  } as Workflow;
}

type JobView = EvalRunView & { results: EvalCaseResult[] };

async function startJob(context: TestContext, cookie: string, body: Record<string, unknown>) {
  return call(context, "POST", "/api/replay/runs", cookie, body);
}

async function runJob(context: TestContext, cookie: string, body: Record<string, unknown>, timeoutMs = 45_000): Promise<JobView> {
  const started = await startJob(context, cookie, body);
  expect(started.statusCode, started.body).toBe(202);
  const runId = started.json<{ run: EvalRunView }>().run.id;
  const until = Date.now() + timeoutMs;
  for (;;) {
    const response = await call(context, "GET", `/api/replay/runs/${runId}`, cookie);
    expect(response.statusCode, response.body).toBe(200);
    const run = response.json<{ run: JobView }>().run;
    if (!["queued", "running"].includes(run.status)) return run;
    if (Date.now() > until) throw new Error(`Job ${runId} still ${run.status}`);
    await sleep(50);
  }
}

/** Starter rule observing → golden run (the model gets the card) → golden set → enforcement on. */
async function enforcedSetup() {
  const model = await startModel();
  const context = await createTestContext({ REPLAY_CONCURRENCY: "1" });
  const admin = await login(context, "admin");
  const builder = await login(context, "builder");
  const secret = context.secretService.createSecret({ name: "Model key", provider: "openai", value: MODEL_KEY });
  context.store.upsertWorkflow(cardAgent(model.baseUrl, secret.secretId));
  context.store.writeWorkflowVersion({ id: "wf-cand-v1", workflowId: "wf-cand", version: 1, workflowJson: JSON.stringify(context.store.getWorkflow("wf-cand")) });
  // The fake model listens on loopback: classify it public so the starter rule (≤ private) applies to it.
  expect((await call(context, "POST", "/api/data-destinations", admin.cookie, { name: "Test model", kind: "http", host: "127.0.0.1", tier: "public" })).statusCode).toBe(201);
  expect((await call(context, "POST", "/api/guard/destination-rules/starter", admin.cookie)).statusCode).toBe(201);
  const run = await call(context, "POST", "/api/workflows/wf-cand/execute", builder.cookie, {});
  expect(run.statusCode, run.body).toBe(200);
  const saved = await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: run.json<{ executionId: string }>().executionId, name: "Golden" });
  expect(saved.statusCode, saved.body).toBe(201);
  const recording = saved.json<{ recording: ReplayRecordingSummary }>().recording;
  const created = await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "Suite", workflowId: "wf-cand" });
  const setId = created.json<{ dataset: { id: string } }>().dataset.id;
  expect((await call(context, "POST", `/api/eval/datasets/${setId}/recordings`, builder.cookie, { recordingId: recording.id })).statusCode).toBe(201);
  expect(model.calls.length).toBe(1);
  expect((await call(context, "POST", "/api/guard/destination-rules/enforcement", admin.cookie, { enforce: true })).statusCode).toBe(200);
  return { model, context, admin, builder, setId };
}

describe("deployment destination rules in replays", () => {
  it("a builder cannot name the rules profile as the candidate, and an admin's older-version candidate still runs the latest rules", async () => {
    const { model, context, admin, builder, setId } = await enforcedSetup();
    const live = await call(context, "POST", "/api/workflows/wf-cand/execute", builder.cookie, {});
    expect(live.json<{ status: string }>().status).toBe("error");
    expect(model.calls.length).toBe(1);

    // Without an override the replay fails the case, without calling the model.
    const plain = await runJob(context, builder.cookie, { datasetIds: [setId], models: "live" });
    expect(plain.results.every((result) => result.status !== "passed")).toBe(true);
    expect(model.calls.length).toBe(1);

    // A builder naming the rules profile (any version) is refused with a plain 403.
    for (const guardProfile of [{ profileId: "destination-rules", version: 1 }, { profileId: "destination-rules" }]) {
      const refused = await startJob(context, builder.cookie, { datasetIds: [setId], models: "live", overrides: { guardProfile } });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json<{ error: string }>().error).toMatch(/destination rules always apply/);
    }

    // An admin may replay under the observing version, but the latest (enforced) rules still run after it.
    const adminJob = await runJob(context, admin.cookie, { datasetIds: [setId], models: "live", overrides: { guardProfile: { profileId: "destination-rules", version: 1 } } });
    expect(adminJob.results.every((result) => result.status !== "passed")).toBe(true);
    expect(model.calls.length).toBe(1);
    expect(model.calls.some((body) => body.includes("4111"))).toBe(true);
    expect(model.calls.slice(1).some((body) => body.includes("4111"))).toBe(false);

    // Another profile as the candidate (admin-made, observing nothing) does not remove the rules either.
    expect((await call(context, "POST", "/api/guard/profiles", admin.cookie, { document: { id: "lenient", name: "Lenient", version: "1" } })).statusCode).toBe(201);
    const other = await runJob(context, builder.cookie, { datasetIds: [setId], models: "live", overrides: { guardProfile: { profileId: "lenient" } } });
    expect(other.results.every((result) => result.status !== "passed")).toBe(true);
    expect(model.calls.length).toBe(1);
  }, 120_000);
});

describe("runtime surrogates end to end", () => {
  it("a surrogate sent out is kept by capture and the original's data-subject lookup finds the capture", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const receiver = await startReceiver();
    const id = "wf-surr";
    const saved = context.store.upsertWorkflow({
      id,
      name: "Surrogate sender",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        node("hook", "webhook_input", { path: `hook-${id}`, method: "POST" }),
        node("send", "http_request", { method: "POST", urlTemplate: receiver.url, bodyTemplate: '{"note":"{{user_prompt}}"}' }, 150),
        node("out", "output", {}, 300)
      ],
      edges: [
        { id: "e1", source: "hook", target: "send" },
        { id: "e2", source: "send", target: "out" }
      ]
    } as Workflow);
    new WorkflowVersionService(context.store).snapshot({ workflow: saved, changeNote: "test" });
    expect((await call(context, "POST", "/api/data-destinations", admin.cookie, { name: "Receiver", kind: "http", host: "127.0.0.1", tier: "public" })).statusCode).toBe(201);
    const created = await call(context, "POST", "/api/guard/profiles", admin.cookie, {
      document: {
        id: "surr",
        name: "Surrogates out",
        version: "1",
        destinations: { rules: [{ name: "Emails stay", when: { dataClasses: ["email"] }, allow: { maxTier: "private" }, action: "protect" }] },
        protection: { dataClasses: { email: { providerId: "surrogate" } }, fallback: "block" }
      }
    });
    expect(created.statusCode, created.body).toBe(201);
    expect((await call(context, "PUT", `/api/guard/bindings/workflows/${id}`, admin.cookie, { mode: "override", profileId: "surr" })).statusCode).toBe(200);
    expect((await call(context, "PUT", `/api/workflows/${id}/replay-capture`, builder.cookie, { enabled: true, rate: 1, maxPerDay: 10 })).statusCode).toBe(200);

    const run = await context.app.inject({ method: "POST", url: `/webhook/hook-${id}`, payload: { user_prompt: `contact ${EMAIL}` } });
    expect(run.statusCode, run.body).toBe(200);
    const sent = receiver.bodies.at(-1) ?? "";
    expect(sent).not.toContain(EMAIL);
    const surrogate = /[A-Za-z0-9._%+-]+@surrogate\.invalid/.exec(sent)?.[0];
    expect(surrogate).toBeTruthy();

    let captures: ReplayCaptureView[] = [];
    const until = Date.now() + 20_000;
    while (captures.length === 0) {
      const page = await call(context, "GET", `/api/workflows/${id}/replay-captures`, builder.cookie);
      captures = page.json<{ items: ReplayCaptureView[] }>().items;
      if (captures.length === 0) {
        if (Date.now() > until) throw new Error("No capture arrived");
        await sleep(25);
      }
    }
    const detail = await call(context, "GET", `/api/replay/recordings/${captures[0]!.id}`, admin.cookie);
    expect(detail.body).not.toContain(EMAIL);
    // Capture kept the issued surrogate as it is (no double masking), and only that one.
    expect([...new Set(detail.body.match(/[A-Za-z0-9._%+-]+@surrogate\.invalid/g) ?? [])]).toEqual([surrogate]);

    const found = await call(context, "POST", "/api/replay/recordings/find-subject", admin.cookie, { value: EMAIL });
    expect(found.statusCode, found.body).toBe(200);
    const match = found.json<ReplayFindSubjectResult>().matches.find((entry) => entry.id === captures[0]!.id);
    expect(match).toBeTruthy();
    expect(match!.matchedAs).toContain("email");
  }, 90_000);
});
