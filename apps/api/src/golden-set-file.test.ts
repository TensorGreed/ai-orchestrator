/**
 * Phase 15.5 - golden-set files over the API: export, import round trip, the
 * import re-scrubbing a file it does not trust, size caps, schema rejection,
 * signatures and project authorization.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { goldenSetFileSchema, goldenSetSignedBytes, type EvalRunView, type GoldenSetFile, type ReplayRecordingSummary, type Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  secretService: SecretService;
  config: AppConfig;
  tempDir: string;
  dbPath: string;
}

const contexts: TestContext[] = [];
const closers: Array<() => Promise<void>> = [];
const MASTER_KEY = crypto.randomBytes(32).toString("base64");
const PLANTED_SECRET = "sk-planted-GOLDEN-FILE-secret-7c1e9a40b2d8f635";

async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-golden-file-"));
  const dbPath = path.join(tempDir, "orchestrator.db");
  const store = await SqliteStore.create(dbPath);
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
  const context = { app, store, authService, secretService, config, tempDir, dbPath };
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
      // Already closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${name}: ${response.body}`);
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return { cookie: cookie.split(";")[0]!, id: user.id };
}

const call = (context: TestContext, method: "GET" | "POST" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startCounter() {
  const hits = new Map<string, number>();
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const key = (request.url ?? "/").split("?")[0]!;
      hits.set(key, (hits.get(key) ?? 0) + 1);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind counter");
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${address.port}`, count: (route: string) => hits.get(route) ?? 0 };
}

function setWorkflow(base: string, id = "wf-set", projectId = "default", secretId?: string): Workflow {
  return {
    id,
    name: `Workflow ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "label", type: "set_node", name: "Label", position: { x: 150, y: 0 }, config: { assignments: [{ key: "answer", valueTemplate: "v1" }] } },
      {
        id: "notify",
        type: "slack_send_message",
        name: "Notify",
        position: { x: 300, y: 0 },
        config: { authType: "webhook", webhookUrl: `${base}/slack`, text: "done", ...(secretId ? { secretRef: { secretId } } : {}) }
      },
      { id: "output", type: "output", name: "Output", position: { x: 450, y: 0 }, config: { responseTemplate: "answer {{results.label.answer}}" } }
    ],
    edges: [
      { id: "e1", source: "start", target: "label" },
      { id: "e2", source: "label", target: "notify" },
      { id: "e3", source: "notify", target: "output" }
    ]
  } as Workflow;
}

/** A workflow with `count` golden runs saved and a golden set holding them. */
async function suite(context: TestContext, cookie: string, workflowId: string, count: number): Promise<string> {
  const recordings: ReplayRecordingSummary[] = [];
  for (let index = 0; index < count; index += 1) {
    const run = await call(context, "POST", `/api/workflows/${workflowId}/execute`, cookie, {});
    expect(run.statusCode, run.body).toBe(200);
    const saved = await call(context, "POST", "/api/replay/recordings", cookie, { executionId: run.json<{ executionId: string }>().executionId, name: `Golden ${index + 1}` });
    expect(saved.statusCode, saved.body).toBe(201);
    recordings.push(saved.json<{ recording: ReplayRecordingSummary }>().recording);
  }
  const created = await call(context, "POST", "/api/eval/datasets", cookie, { name: "Regression suite", workflowId, description: "Checked in" });
  expect(created.statusCode, created.body).toBe(200);
  const setId = created.json<{ dataset: { id: string } }>().dataset.id;
  for (const recording of recordings) {
    expect((await call(context, "POST", `/api/eval/datasets/${setId}/recordings`, cookie, { recordingId: recording.id, scorers: [{ type: "status" }] })).statusCode).toBe(201);
  }
  return setId;
}

async function exportFile(context: TestContext, cookie: string, setId: string, sign = false): Promise<GoldenSetFile & Record<string, unknown>> {
  const response = await call(context, "GET", `/api/eval/datasets/${setId}/export${sign ? "?sign=true" : ""}`, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

const importFile = (context: TestContext, cookie: string, file: unknown, extra: Record<string, unknown> = {}) =>
  call(context, "POST", "/api/eval/datasets/import", cookie, { file, workflowId: "wf-set", ...extra });

async function waitForJob(context: TestContext, cookie: string, runId: string): Promise<EvalRunView> {
  const until = Date.now() + 30_000;
  for (;;) {
    const run = (await call(context, "GET", `/api/replay/runs/${runId}`, cookie)).json<{ run: EvalRunView }>().run;
    if (!["queued", "running"].includes(run.status)) return run;
    if (Date.now() > until) throw new Error(`Job ${runId} still ${run.status}`);
    await sleep(50);
  }
}

const countRows = (context: TestContext, table: string): number => {
  const db = new Database(context.dbPath, { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
};

describe("golden-set files", () => {
  it("exports a golden set, imports it as a new set and replays the imported cases", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    context.store.upsertWorkflow(setWorkflow(counter.base));
    const setId = await suite(context, builder.cookie, "wf-set", 2);

    const file = await exportFile(context, builder.cookie, setId);
    expect(goldenSetFileSchema.safeParse(file).success).toBe(true);
    expect(file).toMatchObject({ format: "l2m.golden-set", version: 1, name: "Regression suite", description: "Checked in", workflow: { id: "wf-set", name: "Workflow wf-set" }, exportedBy: "builder@example.com" });
    expect(file.cases).toHaveLength(2);
    expect(file.cases[0]).toMatchObject({ name: "Golden 1", scorers: [{ type: "status" }], recording: { sourceStatus: "success", input: expect.anything() } });
    expect(file.cases[0]!.recording.nodes.label).toMatchObject({ status: "success" });
    expect(file.signature).toBeUndefined();

    const imported = await importFile(context, builder.cookie, file, { name: "From git" });
    expect(imported.statusCode, imported.body).toBe(201);
    const body = imported.json<{ dataset: { id: string; name: string; workflowId: string; goldenRunCount: number }; imported: number; skipped: number; warnings: string[] }>();
    expect(body).toMatchObject({ imported: 2, skipped: 0, warnings: [], dataset: { name: "From git", workflowId: "wf-set", goldenRunCount: 2 } });
    expect(body.dataset.id).not.toBe(setId);

    // The imported set replays like any other: Slack is answered from the imported recordings.
    const slackBefore = counter.count("/slack");
    const started = await call(context, "POST", "/api/replay/runs", builder.cookie, { datasetIds: [body.dataset.id] });
    expect(started.statusCode, started.body).toBe(202);
    const job = await waitForJob(context, builder.cookie, started.json<{ run: EvalRunView }>().run.id);
    expect(job.status, job.error ?? "").toBe("completed");
    expect(job.summary).toMatchObject({ total: 2, pass: 2, fail: 0, error: 0 });
    expect(counter.count("/slack")).toBe(slackBefore);

    // Exporting the imported set gives the same cases back.
    const again = await exportFile(context, builder.cookie, body.dataset.id);
    expect(again.cases.map((entry) => entry.recording.facts.output)).toEqual(file.cases.map((entry) => entry.recording.facts.output));
    expect(again.name).toBe("From git");
  }, 60_000);

  it("scrubs a file it does not trust: planted secret values are replaced and secret references are dropped", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    const secret = context.secretService.createSecret({ name: "Slack", provider: "slack", value: PLANTED_SECRET, projectId: "default" });
    context.store.upsertWorkflow(setWorkflow(counter.base, "wf-set", "default", secret.secretId));
    const setId = await suite(context, builder.cookie, "wf-set", 1);

    const file = await exportFile(context, builder.cookie, setId);
    // The exporter already left the reference out.
    expect(JSON.stringify(file)).not.toContain(secret.secretId);

    // A hand-edited file: the secret value in an output, the input and the facts; references in the workflow and a judge scorer.
    const raw = JSON.parse(JSON.stringify(file)) as GoldenSetFile;
    const recording = raw.cases[0]!.recording;
    (recording.nodes.label as { output: unknown }).output = { answer: `leaked ${PLANTED_SECRET}` };
    recording.input = { note: `use ${PLANTED_SECRET}` };
    recording.facts.output = { text: PLANTED_SECRET };
    (recording.workflow.nodes as Array<{ id: string; config: Record<string, unknown> }>).find((node) => node.id === "notify")!.config.secretRef = { secretId: secret.secretId };
    (recording.workflow.nodes as Array<{ id: string; config: Record<string, unknown> }>).find((node) => node.id === "notify")!.config.apiSecretId = secret.secretId;
    raw.cases[0]!.scorers = [{ type: "status" }, { type: "llm_judge", rubric: "Is it right?", secretRef: { secretId: secret.secretId } }];

    const imported = await importFile(context, builder.cookie, raw);
    expect(imported.statusCode, imported.body).toBe(201);
    const body = imported.json<{ dataset: { id: string }; warnings: string[] }>();
    expect(body.warnings.join(" ")).toContain("lost the credential reference");

    const db = new Database(context.dbPath, { readonly: true });
    try {
      const rows = db.prepare("SELECT * FROM replay_recordings WHERE source_execution_id IS NULL").all();
      expect(rows).toHaveLength(1);
      const stored = JSON.stringify([rows, db.prepare("SELECT * FROM eval_fixtures WHERE dataset_id = ?").all(body.dataset.id)]);
      expect(stored).not.toContain(PLANTED_SECRET);
      expect(stored).not.toContain(secret.secretId);
      expect(stored).toContain("[REDACTED]");
    } finally {
      db.close();
    }
    // And the response of the API never echoes it either.
    expect(imported.body).not.toContain(PLANTED_SECRET);
    const reexport = await call(context, "GET", `/api/eval/datasets/${body.dataset.id}/export`, builder.cookie);
    expect(reexport.body).not.toContain(PLANTED_SECRET);
    expect(reexport.body).not.toContain(secret.secretId);
  });

  it("imports all or nothing, and enforces the case count and size caps", async () => {
    const context = await createTestContext({ REPLAY_RECORDING_MAX_BYTES: "16384", REPLAY_JOB_MAX_CASES: "3" });
    const builder = await login(context, "builder");
    const counter = await startCounter();
    context.store.upsertWorkflow(setWorkflow(counter.base));
    const setId = await suite(context, builder.cookie, "wf-set", 2);
    const file = await exportFile(context, builder.cookie, setId);
    const datasetsBefore = countRows(context, "eval_datasets");
    const recordingsBefore = countRows(context, "replay_recordings");

    // The second case is too big for REPLAY_RECORDING_MAX_BYTES: the first one is not kept either.
    const big = JSON.parse(JSON.stringify(file)) as GoldenSetFile;
    big.cases[1]!.recording.input = { blob: "x".repeat(40_000) };
    const tooBig = await importFile(context, builder.cookie, big);
    expect(tooBig.statusCode, tooBig.body).toBe(413);
    expect(countRows(context, "eval_datasets")).toBe(datasetsBefore);
    expect(countRows(context, "replay_recordings")).toBe(recordingsBefore);
    expect(countRows(context, "eval_fixtures")).toBe(2);

    // More cases than a replay job can run.
    const many = JSON.parse(JSON.stringify(file)) as GoldenSetFile;
    many.cases = [...many.cases, ...many.cases];
    const refused = await importFile(context, builder.cookie, many);
    expect(refused.statusCode, refused.body).toBe(413);
    expect(refused.json<{ error: string }>().error).toContain("at most 3");

    // A broken cassette is a 400, again with nothing left behind.
    const bad = JSON.parse(JSON.stringify(file)) as GoldenSetFile;
    bad.cases[1]!.recording.cassette = { format: "nope" };
    const rejected = await importFile(context, builder.cookie, bad);
    expect(rejected.statusCode, rejected.body).toBe(400);
    expect(countRows(context, "replay_recordings")).toBe(recordingsBefore);
    expect(countRows(context, "eval_datasets")).toBe(datasetsBefore);
  });

  it("rejects files that do not match the schema", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    context.store.upsertWorkflow(setWorkflow(counter.base));
    const setId = await suite(context, builder.cookie, "wf-set", 1);
    const file = await exportFile(context, builder.cookie, setId);

    for (const broken of [
      null,
      "text",
      { ...file, format: "something.else" },
      { ...file, version: 2 },
      { ...file, cases: "none" },
      { ...file, cases: [{ name: "x", recording: { name: "x" } }] },
      { ...file, name: "" },
      { ...file, workflow: undefined }
    ]) {
      const response = await importFile(context, builder.cookie, broken);
      expect(response.statusCode, JSON.stringify(broken)?.slice(0, 80)).toBe(400);
    }
    // Unknown keys on the request are refused too, and the target must exist.
    expect((await call(context, "POST", "/api/eval/datasets/import", builder.cookie, { file, workflowId: "wf-set", surprise: true })).statusCode).toBe(400);
    expect((await call(context, "POST", "/api/eval/datasets/import", builder.cookie, { file })).statusCode).toBe(400);
    expect((await importFile(context, builder.cookie, file, { workflowId: "wf-missing" })).statusCode).toBe(404);
    expect((await importFile(context, builder.cookie, file, { projectId: "elsewhere" })).statusCode).toBe(400);
    expect(countRows(context, "eval_datasets")).toBe(1);
  });

  it("signs an export with the audit key and flags a tampered file on import", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    context.store.upsertWorkflow(setWorkflow(counter.base));
    const setId = await suite(context, builder.cookie, "wf-set", 1);

    const signed = await exportFile(context, builder.cookie, setId, true);
    expect(signed.signature).toMatchObject({ algorithm: "Ed25519" });
    const { keyId, publicKey, signedAt, signature } = signed.signature!;
    const verifies = (file: Record<string, unknown>) =>
      crypto.verify(
        null,
        Buffer.from(goldenSetSignedBytes(file, keyId, signedAt)),
        crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey, "base64")]), format: "der", type: "spki" }),
        Buffer.from(signature, "base64")
      );
    expect(verifies(signed)).toBe(true);

    const clean = await importFile(context, builder.cookie, signed);
    expect(clean.statusCode, clean.body).toBe(201);
    expect(clean.json<{ warnings: string[] }>().warnings).toEqual([]);

    const tampered = JSON.parse(JSON.stringify(signed)) as GoldenSetFile;
    tampered.cases[0]!.name = "Edited by hand";
    expect(verifies(tampered)).toBe(false);
    const flagged = await importFile(context, builder.cookie, tampered);
    expect(flagged.statusCode, flagged.body).toBe(201);
    expect(flagged.json<{ warnings: string[] }>().warnings.join(" ")).toContain("cannot verify");
  });

  it("warns when the file is for another workflow and the target is given explicitly", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    context.store.upsertWorkflow(setWorkflow(counter.base));
    context.store.upsertWorkflow(setWorkflow(counter.base, "wf-other"));
    const setId = await suite(context, builder.cookie, "wf-set", 1);
    const file = await exportFile(context, builder.cookie, setId);
    const imported = await importFile(context, builder.cookie, file, { workflowId: "wf-other" });
    expect(imported.statusCode, imported.body).toBe(201);
    const body = imported.json<{ dataset: { workflowId: string }; warnings: string[] }>();
    expect(body.dataset.workflowId).toBe("wf-other");
    expect(body.warnings[0]).toContain("exported from workflow wf-set");
  });

  it("follows project access: unreadable is 404, readable but not writable is 403, and hand-written datasets are not exported", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");
    const outsider = await login(context, "builder", "outsider");
    const executor = await login(context, "builder", "executor");
    const counter = await startCounter();
    context.store.upsertWorkflow(setWorkflow(counter.base));
    const setId = await suite(context, builder.cookie, "wf-set", 1);
    const file = await exportFile(context, builder.cookie, setId);

    // A viewer reads the file but cannot import it.
    expect((await call(context, "GET", `/api/eval/datasets/${setId}/export`, viewer.cookie)).statusCode).toBe(200);
    expect((await importFile(context, viewer.cookie, file)).statusCode).toBe(403);

    // A builder with execute but not write on the project.
    context.store.upsertCustomRole({ id: "exec-only", projectId: "default", name: "Runner", permissions: ["workflow:read", "workflow:execute"] });
    context.store.upsertProjectRole({ userId: executor.id, projectId: "default", role: "custom", customRoleId: "exec-only" });
    expect((await call(context, "GET", `/api/eval/datasets/${setId}/export`, executor.cookie)).statusCode).toBe(200);
    expect((await importFile(context, executor.cookie, file)).statusCode).toBe(403);

    // A builder locked out of the project sees neither the set nor the workflow.
    context.store.upsertCustomRole({ id: "none-default", projectId: "default", name: "No access", permissions: [] });
    context.store.upsertProjectRole({ userId: outsider.id, projectId: "default", role: "custom", customRoleId: "none-default" });
    const hidden = await call(context, "GET", `/api/eval/datasets/${setId}/export`, outsider.cookie);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).toBe((await call(context, "GET", "/api/eval/datasets/ds_missing/export", outsider.cookie)).body);
    expect((await importFile(context, outsider.cookie, file)).statusCode).toBe(404);

    // Nothing was created by any of the refused imports.
    expect(countRows(context, "eval_datasets")).toBe(1);

    // A dataset without a workflow is not a golden set.
    const plain = await call(context, "POST", "/api/eval/datasets", admin.cookie, { name: "Plain", projectId: "default" });
    const plainId = plain.json<{ dataset: { id: string } }>().dataset.id;
    expect((await call(context, "GET", `/api/eval/datasets/${plainId}/export`, admin.cookie)).statusCode).toBe(400);
    expect((await call(context, "GET", `/api/eval/datasets/${setId}/export`, "")).statusCode).toBe(401);
  });

  it("records audit events for exports and imports", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    context.store.upsertWorkflow(setWorkflow(counter.base));
    const setId = await suite(context, builder.cookie, "wf-set", 1);
    const file = await exportFile(context, builder.cookie, setId, true);
    expect((await importFile(context, builder.cookie, file)).statusCode).toBe(201);
    const db = new Database(context.dbPath, { readonly: true });
    try {
      const events = db.prepare("SELECT event_type, metadata_json FROM audit_logs WHERE event_type LIKE 'replay.golden_set.%' ORDER BY created_at").all() as Array<{ event_type: string; metadata_json: string }>;
      const types = events.map((event) => event.event_type);
      expect(types).toContain("replay.golden_set.exported");
      expect(types).toContain("replay.golden_set.imported");
      expect(events.find((event) => event.event_type === "replay.golden_set.exported")!.metadata_json).toContain('"signed":true');
    } finally {
      db.close();
    }
  });
});
