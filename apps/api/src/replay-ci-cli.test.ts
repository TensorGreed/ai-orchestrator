/**
 * Phase 15.5 - the CI CLI against the real routes. The CLI (packages/cli) runs
 * in this process against a listening app with a real API key, so every
 * request it builds is checked by the API's own zod schemas: replay jobs with
 * overrides and inline candidates (not release proof), the estimate, publish
 * through a release gate (blocked 409 then published 200), and the model tape
 * surviving a golden-set file round trip.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  goldenSetFileSchema,
  modelTapeSchema,
  type EvalRunView,
  type ReleasePublishPreview,
  type ReplayJobEstimate,
  type ReplayRecordingSummary,
  type Workflow,
  type WorkflowRelease
} from "@ai-orchestrator/shared";
import { main as cliMain, type CliIo } from "../../../packages/cli/src/main.js";
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
  env: Record<string, string>;
  adminCookie: string;
}

const contexts: TestContext[] = [];
const closers: Array<() => Promise<void>> = [];
const MODEL_KEY = "sk-model-CLI-key-0a1b2c3d4e5f60718293";
const MASTER_KEY = crypto.randomBytes(32).toString("base64");

/** A listening app and an admin API key, as a CI job has them. */
async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-ci-cli-"));
  const store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: MASTER_KEY,
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    REPLAY_CONCURRENCY: "2",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git")
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  await authService.register({ email: "admin@example.com", password: "admin-Pass-123!", role: "admin" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "admin-Pass-123!" } });
  const raw = login.headers["set-cookie"];
  const adminCookie = (Array.isArray(raw) ? raw : [raw ?? ""]).find((value) => value.startsWith(`${config.SESSION_COOKIE_NAME}=`))!.split(";")[0]!;
  const created = await app.inject({ method: "POST", url: "/api/auth/api-keys", headers: { cookie: adminCookie }, payload: { name: "ci" } });
  expect(created.statusCode, created.body).toBe(200);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("not listening");
  const context: TestContext = {
    app,
    store,
    authService,
    secretService,
    config,
    tempDir,
    adminCookie,
    env: { L2M_API_URL: `http://127.0.0.1:${address.port}`, L2M_API_KEY: created.json<{ key: string }>().key }
  };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    await context.app.close();
    try {
      await context.store.close();
    } catch {
      // Already closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

const call = (context: TestContext, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie: context.adminCookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

/** The CLI with output captured and polls that do not wait. */
async function cli(context: TestContext, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const sink = (append: (text: string) => void) => ({ write: (chunk: string | Uint8Array) => (append(String(chunk)), true) }) as unknown as NodeJS.WritableStream;
  const io: CliIo = { stdin: process.stdin, stdout: sink((text) => (out += text)), stderr: sink((text) => (err += text)), env: context.env, sleep: () => new Promise((resolve) => setTimeout(resolve, 20)) };
  const code = await cliMain(argv, io);
  return { code, out, err };
}

async function startModel() {
  const calls: Array<{ model: string }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let model = "";
      try {
        model = String((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown }).model ?? "");
      } catch {
        model = "";
      }
      calls.push({ model });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello" } }], usage: { prompt_tokens: 400, completion_tokens: 20 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind fake model");
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, calls };
}

function agentWorkflow(baseUrl: string, secretId: string): Workflow {
  return {
    id: "wf-cli",
    name: "CLI agent",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "agent_1", type: "agent_orchestrator", name: "Agent", position: { x: 150, y: 0 }, config: { systemPromptTemplate: "Be brief.", userPromptTemplate: "Say hi", maxIterations: 1, toolCallingEnabled: false } },
      { id: "model", type: "llm_call", name: "Model", position: { x: 150, y: 160 }, config: { provider: { providerId: "openai", model: "gpt-4o-mini", baseUrl, secretRef: { secretId }, extra: { maxRetries: 0 } } } },
      { id: "output", type: "output", name: "Output", position: { x: 300, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "start", target: "agent_1" },
      { id: "e2", source: "agent_1", sourceHandle: "chat_model", target: "model" },
      { id: "e3", source: "agent_1", target: "output" }
    ]
  } as Workflow;
}

/** start → label → output that answers `answer`. */
function labelWorkflow(answer: string): Workflow {
  return {
    id: "wf-pub",
    name: "Publishable",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "label", type: "set_node", name: "Label", position: { x: 150, y: 0 }, config: { assignments: [{ key: "answer", valueTemplate: answer }] } },
      { id: "output", type: "output", name: "Output", position: { x: 300, y: 0 }, config: { responseTemplate: "answer {{results.label.answer}}" } }
    ],
    edges: [
      { id: "e1", source: "start", target: "label" },
      { id: "e2", source: "label", target: "output" }
    ]
  } as Workflow;
}

async function goldenSet(context: TestContext, workflowId: string, count: number): Promise<{ setId: string; recordings: ReplayRecordingSummary[] }> {
  const recordings: ReplayRecordingSummary[] = [];
  for (let index = 0; index < count; index += 1) {
    const run = await call(context, "POST", `/api/workflows/${workflowId}/execute`, { record: true });
    expect(run.statusCode, run.body).toBe(200);
    const saved = await call(context, "POST", "/api/replay/recordings", { executionId: run.json<{ executionId: string }>().executionId, name: `Golden ${index + 1}` });
    expect(saved.statusCode, saved.body).toBe(201);
    recordings.push(saved.json<{ recording: ReplayRecordingSummary }>().recording);
  }
  const created = await call(context, "POST", "/api/eval/datasets", { name: "Suite", workflowId });
  const setId = created.json<{ dataset: { id: string } }>().dataset.id;
  for (const recording of recordings) expect((await call(context, "POST", `/api/eval/datasets/${setId}/recordings`, { recordingId: recording.id })).statusCode).toBe(201);
  return { setId, recordings };
}

async function saveVersion(context: TestContext, workflow: Workflow): Promise<number> {
  const saved = await context.store.upsertWorkflow(workflow);
  return (await new WorkflowVersionService(context.store).snapshot({ workflow: saved, changeNote: "test" })).version;
}

describe("the CI CLI against the real replay routes", () => {
  it("estimates, then runs a job with a model override and a baseline rerun: the job is not release proof and the CLI says so", async () => {
    const model = await startModel();
    const context = await createTestContext();
    const secret = await context.secretService.createSecret({ name: "Model key", provider: "openai", value: MODEL_KEY });
    await context.store.upsertWorkflow(agentWorkflow(model.baseUrl, secret.secretId));
    await context.store.writeWorkflowVersion({ id: "wf-cli-v1", workflowId: "wf-cli", version: 1, workflowJson: JSON.stringify(await context.store.getWorkflow("wf-cli")) });
    const { setId } = await goldenSet(context, "wf-cli", 2);
    const callsAfterGolden = model.calls.length;

    const flags = ["--model", "agent_1=gpt-5-mini", "--repeats", "2", "--compare", "baseline_rerun", "--aggregate", "majority"];
    const estimate = await cli(context, ["replay", "run", "--set", setId, ...flags, "--estimate", "--json"]);
    expect(estimate.code, estimate.err).toBe(0);
    const estimated = JSON.parse(estimate.out) as ReplayJobEstimate;
    expect(estimated).toMatchObject({ cases: 2, runsPerCase: 4 });
    expect(Array.isArray(estimated.warnings)).toBe(true);
    const text = await cli(context, ["replay", "run", "--set", setId, ...flags, "--estimate"]);
    expect(text.code, text.err).toBe(0);
    expect(text.out).toMatch(/Estimate: 2 cases, 4 runs each/);
    expect(model.calls).toHaveLength(callsAfterGolden);

    const junit = path.join(context.tempDir, "junit.xml");
    const job = await cli(context, ["replay", "run", "--set", setId, ...flags, "--json", "--junit", junit, "--timeout", "60"]);
    expect(job.code, job.err + job.out).toBe(0);
    const run = JSON.parse(job.out) as EvalRunView & { exitCode: number };
    expect(run).toMatchObject({ status: "completed", exitCode: 0, summary: { total: 2, pass: 2 } });
    expect(run.candidate).toMatchObject({ kind: "draft", releaseEligible: false, overrides: { models: [{ nodeId: "agent_1", model: "gpt-5-mini" }] } });
    expect(run.candidate!.releaseIneligibleReasons!.join(" ")).toMatch(/Model overrides/);
    expect(run.options).toMatchObject({ compare: "baseline_rerun", repeats: 2, aggregate: "majority" });
    expect(fs.readFileSync(junit, "utf8")).toContain('name="releaseEligible" value="false"');

    // The text report and `replay status` print why the job is no release proof.
    const status = await cli(context, ["replay", "status", run.id]);
    expect(status.code, status.err).toBe(0);
    expect(status.out).toContain("not release proof");
    expect(status.out).toContain("Model overrides change the workflow under test.");

    // An inline candidate (a workflow file) is not release proof either; an export file holding the workflow works too.
    const file = path.join(context.tempDir, "candidate.json");
    fs.writeFileSync(file, JSON.stringify({ format: "l2m.workflow", workflow: await context.store.getWorkflow("wf-cli") }));
    const inline = await cli(context, ["replay", "run", "--set", setId, "--file", file, "--json", "--timeout", "60"]);
    expect(inline.code, inline.err + inline.out).toBe(0);
    expect(JSON.parse(inline.out).candidate).toMatchObject({ kind: "inline", releaseEligible: false });

    // Models answered from the tape cost no model call and are not release proof.
    const before = model.calls.length;
    const taped = await cli(context, ["replay", "run", "--set", setId, "--models", "replay", "--json", "--timeout", "60"]);
    expect(taped.code, taped.err + taped.out).toBe(0);
    expect(JSON.parse(taped.out).candidate).toMatchObject({ releaseEligible: false });
    expect(model.calls).toHaveLength(before);

    // A plain draft job is release proof.
    const plain = await cli(context, ["replay", "run", "--set", setId, "--json", "--timeout", "60"]);
    expect(plain.code, plain.err + plain.out).toBe(0);
    expect(JSON.parse(plain.out).candidate).toMatchObject({ kind: "draft", releaseEligible: true });
    expect((await cli(context, ["replay", "run", "--set", setId, "--timeout", "60"])).out).toContain("release eligible");

    // The API refuses what its schemas refuse, and the CLI exits 2 with the API's words.
    const refused = await cli(context, ["replay", "run", "--set", setId, "--live-read", "agent_1"]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("agent_1");
    const missing = await cli(context, ["replay", "run", "--set", "ds_missing", "--estimate"]);
    expect(missing.code).toBe(4);
    expect(missing.err).not.toContain("no estimate route");
  }, 120_000);

  it("publish through a release gate: blocked is exit 1 and names the job, a passing job publishes with exit 0", async () => {
    const context = await createTestContext();
    const v1 = await saveVersion(context, labelWorkflow("good"));
    const { setId } = await goldenSet(context, "wf-pub", 3);
    // Ungated: publishing needs no job.
    const first = await cli(context, ["release", "publish", "wf-pub", "--version", String(v1), "--json"]);
    expect(first.code, first.err + first.out).toBe(0);
    expect(JSON.parse(first.out).release).toMatchObject({ version: v1, verdict: "ungated" });

    const gate = await call(context, "PUT", "/api/workflows/wf-pub/release-gate", { enabled: true, datasetIds: [setId] });
    expect(gate.statusCode, gate.body).toBe(200);

    // A regressing version with no job: blocked, nothing published.
    const v2 = await saveVersion(context, labelWorkflow("bad"));
    const noJob = await cli(context, ["release", "publish", "wf-pub", "--version", String(v2)]);
    expect(noJob.code).toBe(1);
    expect(noJob.out).toContain("blocked by the release gate");
    expect(noJob.out).toMatch(/No completed replay job/);

    // The job for it fails (exit 1); publishing is still blocked, and the reply names the job.
    const failing = await cli(context, ["replay", "run", "--set", setId, "--version", String(v2), "--json", "--timeout", "60"]);
    expect(failing.code, failing.err + failing.out).toBe(1);
    const failedRun = JSON.parse(failing.out) as EvalRunView;
    const stillBlocked = await cli(context, ["release", "publish", "wf-pub", "--version", String(v2), "--json"]);
    expect(stillBlocked.code).toBe(1);
    expect(JSON.parse(stillBlocked.out)).toMatchObject({ verdict: "blocked", replayRunId: failedRun.id, canRequestApproval: false, exitCode: 1 });
    expect((await cli(context, ["release", "publish", "wf-pub", "--version", String(v2)])).out).toContain(`replay job ${failedRun.id}`);

    // A fixed version with a passing job publishes: exit 0, verdict passed.
    const v3 = await saveVersion(context, labelWorkflow("good"));
    const passing = await cli(context, ["replay", "run", "--set", setId, "--version", String(v3), "--json", "--timeout", "60"]);
    expect(passing.code, passing.err + passing.out).toBe(0);
    const passedRun = JSON.parse(passing.out) as EvalRunView;
    expect(passedRun.candidate).toMatchObject({ kind: "version", version: v3, releaseEligible: true });
    const published = await cli(context, ["release", "publish", "wf-pub", "--version", String(v3), "--hash", passedRun.candidate!.workflowHash, "--run", passedRun.id]);
    expect(published.code, published.err + published.out).toBe(0);
    expect(published.out).toContain(`Published version ${v3}`);
    expect(published.out).toContain("(passed)");
    const history = (await call(context, "GET", "/api/workflows/wf-pub/releases")).json<{ releases: WorkflowRelease[]; publishedVersion: number }>();
    expect(history.publishedVersion).toBe(v3);
    expect(history.releases[0]).toMatchObject({ verdict: "passed", replayRunId: passedRun.id });

    // An admin override with a reason publishes the regressing version: exit 0, verdict overridden.
    const overridden = await cli(context, ["release", "publish", "wf-pub", "--version", String(v2), "--override-reason", "Hotfix"]);
    expect(overridden.code, overridden.err + overridden.out).toBe(0);
    expect(overridden.out).toContain("(overridden)");
    // A version that does not exist.
    expect((await cli(context, ["release", "publish", "wf-pub", "--version", "99"])).code).toBe(1);
  }, 120_000);
});

describe("golden-set files carry the model tape and the memory seed", () => {
  it("round-trips a model tape through export and import, scrubs planted secrets in it and replays the imported set from it", async () => {
    const model = await startModel();
    const context = await createTestContext();
    const secret = await context.secretService.createSecret({ name: "Model key", provider: "openai", value: MODEL_KEY });
    await context.store.upsertWorkflow(agentWorkflow(model.baseUrl, secret.secretId));
    await context.store.writeWorkflowVersion({ id: "wf-cli-v1", workflowId: "wf-cli", version: 1, workflowJson: JSON.stringify(await context.store.getWorkflow("wf-cli")) });
    const { setId, recordings } = await goldenSet(context, "wf-cli", 1);
    expect(recordings[0]!.capabilities).toMatchObject({ models: "tape" });

    const out = path.join(context.tempDir, "suite.golden.json");
    const exported = await cli(context, ["golden", "export", setId, "-o", out]);
    expect(exported.code, exported.err).toBe(0);
    const file = JSON.parse(fs.readFileSync(out, "utf8")) as { cases: Array<{ recording: { modelTape?: { entries: Array<{ requestHash: string; response?: unknown }> }; memorySeed?: unknown } }> };
    expect(goldenSetFileSchema.safeParse(file).success).toBe(true);
    const tape = file.cases[0]!.recording.modelTape!;
    const checkedTape = modelTapeSchema.safeParse(tape);
    expect(checkedTape.success, JSON.stringify(checkedTape.error?.issues)).toBe(true);
    expect(tape.entries).toHaveLength(1);
    expect(JSON.stringify(file)).not.toContain(MODEL_KEY);

    const imported = await cli(context, ["golden", "import", out, "--workflow", "wf-cli", "--name", "From git", "--json"]);
    expect(imported.code, imported.err + imported.out).toBe(0);
    const body = JSON.parse(imported.out) as { dataset: { id: string }; imported: number; warnings: string[] };
    expect(body.imported).toBe(1);
    expect(body.warnings.join(" ")).not.toMatch(/tape/);
    const stored = (await context.store.getReplayRecording((await context.store.listEvalFixtures(body.dataset.id))[0]!.recordingId!))!;
    expect(stored.capabilities).toMatchObject({ models: "tape", origin: "imported" });
    expect(stored.modelTape!.entries.map((entry) => entry.requestHash)).toEqual(tape.entries.map((entry) => entry.requestHash));
    expect(stored.modelTape!.entries[0]!.response).toEqual(tape.entries[0]!.response);

    // The imported set replays from the tape: no model call, and it passes.
    const calls = model.calls.length;
    const replay = await cli(context, ["replay", "run", "--set", body.dataset.id, "--models", "replay", "--json", "--timeout", "60"]);
    expect(replay.code, replay.err + replay.out).toBe(0);
    expect(model.calls).toHaveLength(calls);

    // A hand-edited file: a secret value planted in the tape is scrubbed, an invalid tape is refused with 400.
    const planted = JSON.parse(JSON.stringify(file)) as typeof file;
    const secretValue = MODEL_KEY;
    (planted.cases[0]!.recording.modelTape!.entries[0] as { response: unknown }).response = { text: `leaked ${secretValue}` };
    const scrubbedImport = await call(context, "POST", "/api/eval/datasets/import", { file: planted, workflowId: "wf-cli" });
    expect(scrubbedImport.statusCode, scrubbedImport.body).toBe(201);
    const scrubbedSet = scrubbedImport.json<{ dataset: { id: string } }>().dataset.id;
    const scrubbedRow = (await context.store.getReplayRecording((await context.store.listEvalFixtures(scrubbedSet))[0]!.recordingId!))!;
    expect(JSON.stringify(scrubbedRow.modelTape)).not.toContain(secretValue);
    expect(scrubbedRow.modelTape!.entries[0]!.requestHash).toBe(tape.entries[0]!.requestHash);

    const broken = JSON.parse(JSON.stringify(file)) as typeof file;
    broken.cases[0]!.recording.modelTape = { format: "something-else" } as never;
    const refused = await call(context, "POST", "/api/eval/datasets/import", { file: broken, workflowId: "wf-cli" });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toMatch(/model tape/);

    // Exporting an imported set keeps the tape.
    const again = (await call(context, "GET", `/api/eval/datasets/${body.dataset.id}/export`)).json<typeof file>();
    expect(again.cases[0]!.recording.modelTape!.entries).toHaveLength(1);
  }, 120_000);
});

describe("an enforced gate's admission in the CLI", () => {
  it("reports admitted, pending and required cases exactly as the gate judges them, and marks a failing required case in JUnit", async () => {
    const context = await createTestContext();
    await saveVersion(context, labelWorkflow("good"));
    const { setId } = await goldenSet(context, "wf-pub", 3);
    const gate = await call(context, "PUT", "/api/workflows/wf-pub/release-gate", { enabled: true, enforced: true, datasetIds: [setId] });
    expect(gate.statusCode, gate.body).toBe(200);
    // A fourth golden run added after the gate was enforced waits for admission.
    const run = await call(context, "POST", "/api/workflows/wf-pub/execute", { record: true });
    const saved = await call(context, "POST", "/api/replay/recordings", { executionId: run.json<{ executionId: string }>().executionId, name: "Late golden" });
    expect((await call(context, "POST", `/api/eval/datasets/${setId}/recordings`, { recordingId: saved.json<{ recording: { id: string } }>().recording.id })).statusCode).toBe(201);
    const first = (await context.store.listEvalFixtures(setId))[0]!;
    const marked = await context.app.inject({ method: "PUT", url: `/api/workflows/wf-pub/release-gate/cases/${first.id}/required`, headers: { cookie: context.adminCookie }, payload: { required: true } });
    expect(marked.statusCode, marked.body).toBe(200);

    // A regressing version: every case fails, the required one included.
    const v2 = await saveVersion(context, labelWorkflow("bad"));
    const junit = path.join(context.tempDir, "gate.xml");
    const job = await cli(context, ["replay", "run", "--set", setId, "--version", String(v2), "--json", "--junit", junit, "--timeout", "60"]);
    expect(job.code, job.err + job.out).toBe(1);
    const view = JSON.parse(job.out) as EvalRunView;
    expect(view.releaseGate).toMatchObject({ enforced: true, requiredFixtureIds: [first.id] });
    expect(view.releaseGate!.pendingFixtureIds).toHaveLength(1);

    const preview = (await call(context, "GET", `/api/workflows/wf-pub/publish-preview?version=${v2}&replayRunId=${view.id}`)).json<{ preview: ReleasePublishPreview }>().preview;
    expect(preview.verdict).toBe("blocked");
    const admission = preview.stats!.admission!;
    expect(admission).toMatchObject({ admitted: 3, pending: 1, required: 1 });
    expect(preview.reasons).toContain(`Required case "${first.name}" failed: a required case must pass whatever the pass rate.`);

    const status = await cli(context, ["replay", "status", view.id]);
    expect(status.out).toContain(`enforced release gate: ${admission.admitted} admitted, ${admission.pending} pending admission (they run but do not count yet), ${admission.required} required`);
    expect(status.out).toContain(`required case "${first.name}" failed: it blocks a publish whatever the pass rate`);
    expect(status.out).toContain("(pending admission, not counted)");
    const xml = fs.readFileSync(junit, "utf8");
    expect(xml).toContain('type="required_case"');
    expect(xml).toContain('<property name="gatePendingCases" value="1"/>');
    expect(xml).toContain('<property name="gateRequiredFailing" value="1"/>');
    expect(xml.match(/type="regression"/g)).toHaveLength(3);
  }, 120_000);
});
