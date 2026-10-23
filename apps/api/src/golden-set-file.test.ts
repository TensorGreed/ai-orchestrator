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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  canonicalJson,
  goldenSetFileSchema,
  goldenSetSignedBytes,
  MCP_CASSETTE_FORMAT,
  MCP_CASSETTE_VERSION,
  type EvalRunView,
  type GoldenSetFile,
  type ReplayRecordingSummary,
  type ReplayRunResponse,
  type Workflow
} from "@ai-orchestrator/shared";
import { main as cliMain, type CliIo } from "../../../packages/cli/src/main.js";
import { SecretScrubber } from "./services/audit-scrub.js";
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

/** A hand-edited file: each case's workflow hash taken again over the workflow it now carries, as an honest editor would. */
function rehash<T extends GoldenSetFile>(file: T): T {
  for (const entry of file.cases) entry.recording.workflowHash = crypto.createHash("sha256").update(canonicalJson(entry.recording.workflow)).digest("hex");
  return file;
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

    const imported = await importFile(context, builder.cookie, rehash(raw));
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

  it("signs an export with the audit key (admins only) and flags a tampered file on import", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const counter = await startCounter();
    context.store.upsertWorkflow(setWorkflow(counter.base));
    const setId = await suite(context, builder.cookie, "wf-set", 1);

    // Signing is for admins, who manage the signing keys; a builder exports unsigned only.
    const refusedSign = await call(context, "GET", `/api/eval/datasets/${setId}/export?sign=true`, builder.cookie);
    expect(refusedSign.statusCode, refusedSign.body).toBe(403);
    const signed = await exportFile(context, admin.cookie, setId, true);
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
    // The purpose tag is part of the signed bytes: the same file signed without it does not verify.
    const { signature: _drop, ...unsigned } = signed;
    const untagged = Buffer.from(canonicalJson({ file: unsigned, keyId, signedAt }), "utf8");
    expect(
      crypto.verify(
        null,
        untagged,
        crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey, "base64")]), format: "der", type: "spki" }),
        Buffer.from(signature, "base64")
      )
    ).toBe(false);

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

  it("refuses another workflow's file unless allowWorkflowMismatch is set, and then keeps only nodes whose id and type match", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    context.store.upsertWorkflow(setWorkflow(counter.base));
    // A fork: the same ids, but `notify` is now an HTTP call instead of a Slack message.
    const fork = setWorkflow(counter.base, "wf-other");
    fork.nodes = fork.nodes.map((node) => (node.id === "notify" ? { ...node, type: "http_request", config: { method: "POST", url: `${counter.base}/elsewhere` } } : node)) as Workflow["nodes"];
    context.store.upsertWorkflow(fork);
    const setId = await suite(context, builder.cookie, "wf-set", 1);
    const file = await exportFile(context, builder.cookie, setId);
    const datasetsBefore = countRows(context, "eval_datasets");

    const refused = await importFile(context, builder.cookie, file, { workflowId: "wf-other" });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ code: string; error: string }>()).toMatchObject({ code: "workflow_mismatch" });
    expect(refused.json<{ error: string }>().error).toContain("allowWorkflowMismatch");
    expect(countRows(context, "eval_datasets")).toBe(datasetsBefore);

    const imported = await importFile(context, builder.cookie, file, { workflowId: "wf-other", allowWorkflowMismatch: true });
    expect(imported.statusCode, imported.body).toBe(201);
    const body = imported.json<{ dataset: { id: string; workflowId: string }; warnings: string[] }>();
    expect(body.dataset.workflowId).toBe("wf-other");
    expect(body.warnings.join(" ")).toContain("exported from workflow wf-set");
    expect(body.warnings.join(" ")).toMatch(/Recorded outputs of 1 node were dropped .*notify/);
    const recordingId = context.store.listEvalFixtures(body.dataset.id)[0]!.recordingId!;
    const stored = context.store.getReplayRecording(recordingId)!;
    expect(Object.keys(stored.nodes).sort()).toEqual(["label", "output", "start"]);
    expect(stored.capabilities).toMatchObject({ origin: "imported", sourceWorkflowId: "wf-set" });
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

  it("records audit events for exports and imports, with the signature verified, unverified or absent", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const counter = await startCounter();
    context.store.upsertWorkflow(setWorkflow(counter.base));
    const setId = await suite(context, builder.cookie, "wf-set", 1);
    const file = await exportFile(context, admin.cookie, setId, true);
    expect((await importFile(context, builder.cookie, file)).statusCode).toBe(201);
    const tampered = JSON.parse(JSON.stringify(file)) as GoldenSetFile;
    tampered.name = "Edited";
    expect((await importFile(context, builder.cookie, tampered)).statusCode).toBe(201);
    const { signature: _signature, ...unsigned } = file;
    expect((await importFile(context, builder.cookie, unsigned)).statusCode).toBe(201);
    const db = new Database(context.dbPath, { readonly: true });
    try {
      const events = db.prepare("SELECT event_type, metadata_json FROM audit_logs WHERE event_type LIKE 'replay.golden_set.%' ORDER BY created_at, rowid").all() as Array<{ event_type: string; metadata_json: string }>;
      const types = events.map((event) => event.event_type);
      expect(types).toContain("replay.golden_set.exported");
      expect(types).toContain("replay.golden_set.imported");
      expect(events.find((event) => event.event_type === "replay.golden_set.exported")!.metadata_json).toContain('"signed":true');
      const imports = events.filter((event) => event.event_type === "replay.golden_set.imported").map((event) => (JSON.parse(event.metadata_json) as { signature: string }).signature);
      expect(imports).toEqual(["verified", "unverified", "absent"]);
    } finally {
      db.close();
    }
  });
});

const GH_TOKEN = "ghp_PLANTEDtokenABCDEFGHIJKLMNOPQRSTUV0123";
const PLAIN_KEY = "plain-key-value-PLANTED-1";
const BASIC_AUTH = "Basic PLANTED-basic-auth-value";
const VICTIM_SECRET_ID = "sec_PLANTED_victim";
const VICTIM_CREDENTIAL_ID = "cred_PLANTED_victim";
/** Everything a planted field carries: a token shape, credential-named keys, a known secret value and secret references. */
const planted = () => ({
  header: `Bearer ${GH_TOKEN}`,
  apiKey: PLAIN_KEY,
  nested: { Authorization: BASIC_AUTH, keep: "visible" },
  known: `value ${PLANTED_SECRET} inside`,
  ref: { secretRef: { secretId: VICTIM_SECRET_ID } },
  credentialId: VICTIM_CREDENTIAL_ID,
  authSecretId: VICTIM_SECRET_ID
});
const PLANTED_NEEDLES = [GH_TOKEN, PLAIN_KEY, BASIC_AUTH, PLANTED_SECRET, VICTIM_SECRET_ID, VICTIM_CREDENTIAL_ID];

function plantedCassette() {
  return {
    format: MCP_CASSETTE_FORMAT,
    version: MCP_CASSETTE_VERSION,
    recordedAt: "2026-10-01T00:00:00.000Z",
    servers: [{ key: "registry:srv", adapterId: "http-mcp", registryServerId: "srv", label: `srv ${PLANTED_SECRET}` }],
    entries: [
      {
        seq: 1,
        server: "registry:srv",
        method: "tools/call",
        name: "lookup",
        args: { authorization: `Bearer ${GH_TOKEN}`, q: PLANTED_SECRET, credentialId: VICTIM_CREDENTIAL_ID },
        argsHash: "whatever-the-file-says",
        result: { token: GH_TOKEN, content: [{ type: "text", text: `key ${PLANTED_SECRET}` }], ...planted() },
        error: `failed with ${GH_TOKEN}`,
        at: 0,
        durationMs: 1,
        exchanges: [{ kind: "sampling", at: 0, request: planted(), response: { apiKey: PLAIN_KEY } }]
      }
    ],
    truncated: false,
    bytes: 100,
    llm: "not_recorded"
  };
}

function expectNoNeedles(text: string, where: string) {
  for (const needle of PLANTED_NEEDLES) expect(text, `${where} still holds ${needle}`).not.toContain(needle);
}

function storedRows(context: TestContext, datasetId?: string): string {
  const db = new Database(context.dbPath, { readonly: true });
  try {
    return JSON.stringify([
      db.prepare("SELECT * FROM replay_recordings").all(),
      datasetId ? db.prepare("SELECT * FROM eval_fixtures WHERE dataset_id = ?").all(datasetId) : [],
      db.prepare("SELECT * FROM eval_datasets").all()
    ]);
  } finally {
    db.close();
  }
}

const memoryIo = (env: Record<string, string | undefined>) => {
  let out = "";
  let err = "";
  const sink = (append: (text: string) => void) => ({ write: (chunk: string | Uint8Array) => (append(String(chunk)), true) }) as unknown as NodeJS.WritableStream;
  const io: CliIo = {
    stdin: process.stdin,
    stdout: sink((text) => (out += text)),
    stderr: sink((text) => (err += text)),
    env
  };
  return { io, out: () => out, err: () => err };
};

describe("golden-set files: the importer and exporter do not trust what they carry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the full recording-time scrub over every field on import and again on export: no token, credential key, secret value or reference survives", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    context.secretService.createSecret({ name: "Known", provider: "slack", value: PLANTED_SECRET, projectId: "default" });
    context.store.upsertWorkflow(setWorkflow(counter.base));
    const setId = await suite(context, builder.cookie, "wf-set", 1);
    const raw = JSON.parse(JSON.stringify(await exportFile(context, builder.cookie, setId))) as GoldenSetFile;
    const recording = raw.cases[0]!.recording as GoldenSetFile["cases"][number]["recording"] & Record<string, unknown>;
    recording.input = planted();
    (recording.nodes.label as { output: unknown }).output = planted();
    recording.nodes.label!.error = `boom ${GH_TOKEN}`;
    recording.facts.output = planted();
    recording.facts.error = `failed ${PLANTED_SECRET}`;
    recording.cassette = plantedCassette();
    const notify = (recording.workflow.nodes as Array<{ id: string; config: Record<string, unknown> }>).find((node) => node.id === "notify")!;
    Object.assign(notify.config, planted(), { headers: { Authorization: `Bearer ${GH_TOKEN}` } });
    recording.modelTape = { calls: [{ request: planted() }] };
    recording.memorySeed = { note: PLANTED_SECRET, ...planted() };
    recording.notes = "notes";

    const imported = await importFile(context, builder.cookie, rehash(raw));
    expect(imported.statusCode, imported.body).toBe(201);
    const body = imported.json<{ dataset: { id: string }; warnings: string[] }>();
    expect(body.warnings.join(" ")).toContain("model tape or memory seed");
    expectNoNeedles(imported.body, "the import response");
    expectNoNeedles(storedRows(context, body.dataset.id), "the stored rows");
    // Structure survives the scrub: node ids and types, the cassette's match fields.
    const stored = context.store.getReplayRecording(context.store.listEvalFixtures(body.dataset.id)[0]!.recordingId!)!;
    expect((stored.capturedWorkflow.nodes as Array<{ id: string; type: string }>).map((node) => `${node.id}:${node.type}`)).toEqual(["start:manual_trigger", "label:set_node", "notify:slack_send_message", "output:output"]);
    expect(stored.mcpCassette!.entries[0]).toMatchObject({ server: "registry:srv", method: "tools/call", name: "lookup" });
    expect(stored.mcpCassette!.entries[0]!.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored.nodes.label!.output)).toContain("visible");

    const reexport = await call(context, "GET", `/api/eval/datasets/${body.dataset.id}/export`, builder.cookie);
    expect(reexport.statusCode).toBe(200);
    expectNoNeedles(reexport.body, "the export");
  });

  it("scrubs again on export: a stored row with planted values and a secret created after the run never leave", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    context.store.upsertWorkflow(setWorkflow(counter.base));
    const setId = await suite(context, builder.cookie, "wf-set", 1);
    // A row as an older version or a bug could have left it: nothing in it was scrubbed.
    const workflow = setWorkflow(counter.base) as unknown as Record<string, unknown>;
    (workflow.nodes as Array<{ id: string; config: Record<string, unknown> }>)[2]!.config = { ...planted(), text: "done" };
    const row = context.store.saveReplayRecording({
      id: "rec_planted",
      workflowId: "wf-set",
      projectId: "default",
      name: "Planted",
      notes: null,
      sourceExecutionId: null,
      sourceTriggerType: "manual",
      sourceStatus: "success",
      workflowHash: "h",
      workflowSavedVersion: null,
      capturedWorkflowJson: JSON.stringify(workflow),
      inputJson: JSON.stringify(planted()),
      nodeOutputsJson: JSON.stringify({ label: { nodeId: "label", nodeType: "set_node", status: "success", output: planted() } }),
      factsJson: JSON.stringify({ status: "success", error: null, output: planted(), nodes: [], toolCalls: [], modelCalls: [], guard: [], totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null, durationMs: 1, modelCalls: 0, toolCalls: 0 } }),
      mcpCassetteJson: JSON.stringify(plantedCassette()),
      capabilities: { mcp: "cassette", models: "live", memory: "empty", workflowSource: "captured" },
      bytes: 1000,
      truncated: false,
      createdAt: new Date().toISOString(),
      createdBy: null
    });
    expect((await call(context, "POST", `/api/eval/datasets/${setId}/recordings`, builder.cookie, { recordingId: row.id })).statusCode).toBe(201);
    // The known value only becomes a secret now, after the row was stored.
    context.secretService.createSecret({ name: "Late", provider: "slack", value: PLANTED_SECRET, projectId: "default" });
    const exported = await call(context, "GET", `/api/eval/datasets/${setId}/export`, builder.cookie);
    expect(exported.statusCode, exported.body).toBe(200);
    expectNoNeedles(exported.body, "the export");
    // And the file it gives is importable: its hashes are the hashes of what it carries.
    expect((await importFile(context, builder.cookie, exported.json())).statusCode).toBe(201);
  });

  it("authenticates before reading the body: an anonymous oversized, malformed upload is a 401, never a 400 or 413", async () => {
    const context = await createTestContext({ GOLDEN_SET_IMPORT_MAX_BYTES: "65536" });
    const builder = await login(context, "builder");
    // Larger than the body limit and not JSON: reading it would answer 413, parsing it 400.
    const payload = `{"file": ${"[".repeat(200_000)}`;
    const anonymous = await context.app.inject({ method: "POST", url: "/api/eval/datasets/import", headers: { "content-type": "application/json" }, payload });
    expect(anonymous.statusCode, anonymous.body).toBe(401);
    const badKey = await context.app.inject({ method: "POST", url: "/api/eval/datasets/import", headers: { "content-type": "application/json", authorization: "Bearer not-a-key" }, payload });
    expect(badKey.statusCode, badKey.body).toBe(401);
    // A signed-in builder gets the body limit from GOLDEN_SET_IMPORT_MAX_BYTES.
    const tooBig = await context.app.inject({ method: "POST", url: "/api/eval/datasets/import", headers: { "content-type": "application/json", cookie: builder.cookie }, payload });
    expect(tooBig.statusCode, tooBig.body).toBe(413);
    // A viewer is refused before the body is read too.
    const viewer = await login(context, "viewer");
    expect((await context.app.inject({ method: "POST", url: "/api/eval/datasets/import", headers: { "content-type": "application/json", cookie: viewer.cookie }, payload })).statusCode).toBe(403);
    expect(parseConfig({ SECRET_MASTER_KEY_BASE64: MASTER_KEY }).GOLDEN_SET_IMPORT_MAX_BYTES).toBeUndefined();
    expect(() => parseConfig({ SECRET_MASTER_KEY_BASE64: MASTER_KEY, GOLDEN_SET_IMPORT_MAX_BYTES: "10" })).toThrow();
  });

  it("refuses JSON nested deeper than 64 levels with 400, however deep", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    context.store.upsertWorkflow(setWorkflow(counter.base));
    const setId = await suite(context, builder.cookie, "wf-set", 1);
    const file = await exportFile(context, builder.cookie, setId);
    const deep = JSON.parse(JSON.stringify(file)) as GoldenSetFile;
    let nested: unknown = "bottom";
    for (let level = 0; level < 70; level += 1) nested = { level: nested };
    deep.cases[0]!.recording.input = nested;
    const refused = await importFile(context, builder.cookie, deep);
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json<{ error: string }>().error).toContain("64 levels");
    const levels = 100_000;
    const payload = `{"workflowId":"wf-set","file":${'{"a":'.repeat(levels)}1${"}".repeat(levels)}}`;
    const huge = await context.app.inject({ method: "POST", url: "/api/eval/datasets/import", headers: { "content-type": "application/json", cookie: builder.cookie }, payload });
    expect(huge.statusCode, huge.body.slice(0, 200)).toBe(400);
  });

  it("checks the workflow hash, keeps the claimed recording time (never in the future) and marks imported golden runs", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const counter = await startCounter();
    context.store.upsertWorkflow(setWorkflow(counter.base));
    const setId = await suite(context, builder.cookie, "wf-set", 2);
    const file = await exportFile(context, builder.cookie, setId);
    expect(file.cases[0]!.recording).toMatchObject({ origin: "recorded" });
    expect(file.cases[0]!.recording.workflowHash).toBe(crypto.createHash("sha256").update(canonicalJson(file.cases[0]!.recording.workflow)).digest("hex"));

    const forged = JSON.parse(JSON.stringify(file)) as GoldenSetFile;
    forged.cases[1]!.recording.workflowHash = "forged-hash";
    const refused = await importFile(context, builder.cookie, forged);
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json<{ error: string }>().error).toContain("does not match");
    // Editing the workflow without taking the hash again is refused too.
    const edited = JSON.parse(JSON.stringify(file)) as GoldenSetFile;
    (edited.cases[0]!.recording.workflow as { name: string }).name = "Edited";
    expect((await importFile(context, builder.cookie, edited)).statusCode).toBe(400);

    const aged = JSON.parse(JSON.stringify(file)) as GoldenSetFile;
    aged.cases[0]!.recording.recordedAt = "2024-01-02T03:04:05.000Z";
    aged.cases[1]!.recording.recordedAt = "2999-01-01T00:00:00.000Z";
    const before = Date.now();
    const imported = await importFile(context, builder.cookie, aged);
    expect(imported.statusCode, imported.body).toBe(201);
    const datasetId = imported.json<{ dataset: { id: string } }>().dataset.id;
    const listed = (await call(context, "GET", "/api/replay/recordings?workflowId=wf-set", builder.cookie)).json<{ items: ReplayRecordingSummary[] }>().items;
    const importedRuns = listed.filter((entry) => entry.capabilities.origin === "imported");
    expect(importedRuns).toHaveLength(2);
    const old = importedRuns.find((entry) => entry.createdAt.startsWith("2024"))!;
    expect(old.capabilities).toMatchObject({ origin: "imported", recordedAt: "2024-01-02T03:04:05.000Z", sourceWorkflowId: "wf-set" });
    expect(Date.parse(old.capabilities.importedAt!)).toBeGreaterThanOrEqual(before);
    const future = importedRuns.find((entry) => entry !== old)!;
    expect(Date.parse(future.createdAt)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(future.createdAt)).toBeGreaterThanOrEqual(before);
    // The stored hash is the hash of the workflow as stored here.
    const stored = context.store.getReplayRecording(old.id)!;
    expect(stored.workflowHash).toBe(crypto.createHash("sha256").update(canonicalJson(stored.capturedWorkflow)).digest("hex"));
    expect(listed.filter((entry) => entry.capabilities.origin !== "imported").every((entry) => entry.capabilities.origin === undefined)).toBe(true);

    // Exported again, even signed by an admin, the cases still say they were imported, and when they were recorded.
    const again = await exportFile(context, admin.cookie, datasetId, true);
    const oldCase = again.cases.find((entry) => entry.recording.recordedAt.startsWith("2024"))!;
    expect(oldCase.recording).toMatchObject({ origin: "imported", sourceWorkflowId: "wf-set" });
    expect(again.cases.every((entry) => entry.recording.origin === "imported")).toBe(true);
  });

  it("ignores secret references in the config comparison only for imported golden runs", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    const staging = context.secretService.createSecret({ name: "Staging", provider: "slack", value: "staging-value-000000", projectId: "default" });
    const production = context.secretService.createSecret({ name: "Production", provider: "slack", value: "production-value-111111", projectId: "default" });
    context.store.upsertWorkflow(setWorkflow(counter.base, "wf-set", "default", staging.secretId));
    const setId = await suite(context, builder.cookie, "wf-set", 1);
    const nativeId = context.store.listEvalFixtures(setId)[0]!.recordingId!;
    const imported = await importFile(context, builder.cookie, await exportFile(context, builder.cookie, setId));
    expect(imported.statusCode, imported.body).toBe(201);
    const importedId = context.store.listEvalFixtures(imported.json<{ dataset: { id: string } }>().dataset.id)[0]!.recordingId!;

    const replayDraft = async (recordingId: string) => {
      const response = await call(context, "POST", `/api/replay/recordings/${recordingId}/replay`, builder.cookie, { draft: true });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<ReplayRunResponse>();
    };
    const notifyChanged = (result: ReplayRunResponse) => result.diff.health.some((warning) => warning.kind === "config_changed" && warning.nodeId === "notify");

    // Unchanged candidate: neither reports a change.
    expect(notifyChanged(await replayDraft(nativeId))).toBe(false);
    expect(notifyChanged(await replayDraft(importedId))).toBe(false);

    // The candidate moves the stubbed write node to the production credential.
    context.store.upsertWorkflow(setWorkflow(counter.base, "wf-set", "default", production.secretId));
    expect(notifyChanged(await replayDraft(nativeId))).toBe(true);
    // An imported run carries no reference to compare, so it cannot tell.
    expect(notifyChanged(await replayDraft(importedId))).toBe(false);
  }, 60_000);

  it("scrubs and validates outside the transaction, yielding between cases; the transaction only inserts", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    context.store.upsertWorkflow(setWorkflow(counter.base));
    const setId = await suite(context, builder.cookie, "wf-set", 3);
    const file = await exportFile(context, builder.cookie, setId);

    const textSpy = vi.spyOn(SecretScrubber.prototype, "text");
    const treeSpy = vi.spyOn(SecretScrubber.prototype, "tree");
    const immediateSpy = vi.spyOn(globalThis, "setImmediate");
    const original = context.store.transaction.bind(context.store);
    let scrubCallsInside = 0;
    let transactions = 0;
    vi.spyOn(context.store, "transaction").mockImplementation(<T,>(fn: () => T): T =>
      original(() => {
        transactions += 1;
        const before = textSpy.mock.calls.length + treeSpy.mock.calls.length;
        try {
          return fn();
        } finally {
          scrubCallsInside += textSpy.mock.calls.length + treeSpy.mock.calls.length - before;
        }
      })
    );
    const imported = await importFile(context, builder.cookie, file);
    expect(imported.statusCode, imported.body).toBe(201);
    expect(transactions).toBe(1);
    expect(scrubCallsInside).toBe(0);
    expect(textSpy.mock.calls.length).toBeGreaterThan(0);
    expect(immediateSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses to export a golden set that holds a golden run of another workflow", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    context.store.upsertWorkflow(setWorkflow(counter.base));
    context.store.upsertWorkflow(setWorkflow(counter.base, "wf-b"));
    const setId = await suite(context, builder.cookie, "wf-set", 1);
    const otherSet = await suite(context, builder.cookie, "wf-b", 1);
    const foreign = context.store.listEvalFixtures(otherSet)[0]!.recordingId!;
    context.store.createEvalFixture({ id: "fix_foreign", datasetId: setId, name: "Foreign", input: null, recordingId: foreign });
    const refused = await call(context, "GET", `/api/eval/datasets/${setId}/export`, builder.cookie);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ error: string }>().error).toContain("another workflow");
  });

  it("strict project isolation: another project's set cannot be exported or imported into, and imports land in the target's project", async () => {
    const context = await createTestContext({ PROJECT_ISOLATION: "strict" });
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const counter = await startCounter();
    context.store.upsertProject({ id: "team", name: "Team" });
    context.store.upsertProject({ id: "other", name: "Other" });
    context.store.upsertProjectRole({ userId: builder.id, projectId: "team", role: "editor" });
    context.store.upsertWorkflow(setWorkflow(counter.base, "wf-team", "team"));
    context.store.upsertWorkflow(setWorkflow(counter.base, "wf-other", "other"));
    const teamSet = await suite(context, builder.cookie, "wf-team", 1);
    const otherSet = await suite(context, admin.cookie, "wf-other", 1);

    // The other project's set is invisible, exactly like a missing one.
    const hidden = await call(context, "GET", `/api/eval/datasets/${otherSet}/export`, builder.cookie);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).toBe((await call(context, "GET", "/api/eval/datasets/ds_missing/export", builder.cookie)).body);
    const teamFile = await exportFile(context, builder.cookie, teamSet);
    expect(JSON.stringify(teamFile)).not.toContain("wf-other");

    // Nor can the builder import into the other project's workflow, even with its own file.
    expect((await importFile(context, builder.cookie, teamFile, { workflowId: "wf-other", allowWorkflowMismatch: true })).statusCode).toBe(404);
    expect((await importFile(context, builder.cookie, teamFile, { workflowId: "wf-team", projectId: "other" })).statusCode).toBe(400);

    // A file an admin exported from the other project imports into the team's workflow only, in the team's project.
    const otherFile = await exportFile(context, admin.cookie, otherSet);
    const imported = await importFile(context, builder.cookie, otherFile, { workflowId: "wf-team", allowWorkflowMismatch: true });
    expect(imported.statusCode, imported.body).toBe(201);
    const dataset = imported.json<{ dataset: { id: string; projectId: string; workflowId: string } }>().dataset;
    expect(dataset).toMatchObject({ projectId: "team", workflowId: "wf-team" });
    const recording = context.store.getReplayRecording(context.store.listEvalFixtures(dataset.id)[0]!.recordingId!)!;
    expect(recording).toMatchObject({ projectId: "team", workflowId: "wf-team" });
    // And the other project gains nothing.
    expect(context.store.listEvalDatasets({ projectId: "other" }).map((entry) => entry.id)).toEqual([otherSet]);
  }, 60_000);

  it("the CLI exports a signed file from a running server and 'golden verify' checks it with the deployment's public key", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const counter = await startCounter();
    context.store.upsertWorkflow(setWorkflow(counter.base));
    const setId = await suite(context, admin.cookie, "wf-set", 1);
    const created = await call(context, "POST", "/api/auth/api-keys", admin.cookie, { name: "ci" });
    expect(created.statusCode, created.body).toBe(200);
    const apiKey = created.json<{ key: string }>().key;
    await context.app.listen({ port: 0, host: "127.0.0.1" });
    const address = context.app.server.address();
    if (!address || typeof address === "string") throw new Error("not listening");
    const env = { L2M_API_URL: `http://127.0.0.1:${address.port}`, L2M_API_KEY: apiKey };
    const out = path.join(context.tempDir, "suite.golden.json");

    const exported = memoryIo(env);
    expect(await cliMain(["golden", "export", setId, "-o", out, "--sign"], exported.io), exported.err()).toBe(0);
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);

    const keys = (await call(context, "GET", "/api/audit/signing-keys", admin.cookie)).json<{ activeKeyId: string; keys: Array<{ keyId: string; publicKey: string }> }>();
    const publicKey = keys.keys.find((key) => key.keyId === keys.activeKeyId)!.publicKey;
    const verified = memoryIo({});
    expect(await cliMain(["golden", "verify", out, "--public-key", publicKey], verified.io), verified.out()).toBe(0);
    expect(verified.out()).toContain("PASS");
    const unverified = memoryIo({});
    expect(await cliMain(["golden", "verify", out], unverified.io)).toBe(3);

    const tampered = JSON.parse(fs.readFileSync(out, "utf8")) as GoldenSetFile;
    tampered.cases[0]!.name = "Edited";
    const tamperedFile = path.join(context.tempDir, "tampered.json");
    fs.writeFileSync(tamperedFile, JSON.stringify(tampered));
    const failed = memoryIo({});
    expect(await cliMain(["golden", "verify", tamperedFile, "--public-key", publicKey], failed.io)).toBe(1);

    // And the CLI imports it back into the same server.
    const importedIo = memoryIo(env);
    expect(await cliMain(["golden", "import", out, "--workflow", "wf-set", "--public-key", publicKey], importedIo.io), importedIo.err()).toBe(0);
    expect(importedIo.out()).toContain("Imported 1 case");
  }, 60_000);
});
