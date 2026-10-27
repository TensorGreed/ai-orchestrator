/**
 * Release gate admission meets production capture (Phase 15.6) over the API:
 * a candidate never becomes a case of a golden set except through promote,
 * promote lands the case pending on an enforced gate without making earlier
 * jobs stale and never re-scrubs a golden run a case already replays, and an
 * admin's data-subject delete of an admitted case is carried out but audited
 * as loosening, and the jobs that held its results stop being release proof.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ReleaseGateCasesView, ReleaseGateView, ReleasePublishPreview, ReplayCaptureView, ReplayFindSubjectDeleteResult, ReplayFindSubjectResult, Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { goldenSetSnapshots } from "./services/release-snapshot.js";
import { WorkflowVersionService } from "./services/workflow-version-service.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const EMAIL = "jane.doe@example.com";

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-admission-capture-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync")
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  const context: TestContext = { app, store, authService, config, tempDir };
  contexts.push(context);
  return context;
}

afterEach(async () => {
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

async function login(context: TestContext, role: "admin" | "builder"): Promise<{ cookie: string; email: string }> {
  const email = `${role}@example.com`;
  const password = `${role}-Pass-123!`;
  if (!await context.store.getUserByEmail(email)) await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${role}: ${response.body}`);
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`))!;
  return { cookie: cookie.split(";")[0]!, email };
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

/** webhook → output that answers `answer`. */
function hookWorkflow(id: string, answer: string): Workflow {
  return {
    id,
    name: `Captured ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "hook", type: "webhook_input", name: "hook", position: { x: 0, y: 0 }, config: { path: `hook-${id}`, method: "POST" } },
      { id: "out", type: "output", name: "out", position: { x: 200, y: 0 }, config: { responseTemplate: answer } }
    ],
    edges: [{ id: "e1", source: "hook", target: "out" }]
  } as Workflow;
}

async function save(context: TestContext, workflow: Workflow): Promise<number> {
  const saved = await context.store.upsertWorkflow(workflow);
  return (await new WorkflowVersionService(context.store).snapshot({ workflow: saved, changeNote: "test" })).version;
}

async function preview(context: TestContext, cookie: string, workflowId: string, version: number, runId: string): Promise<ReleasePublishPreview> {
  const response = await call(context, "GET", `/api/workflows/${workflowId}/publish-preview?version=${version}&replayRunId=${runId}`, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ preview: ReleasePublishPreview }>().preview;
}

async function casesOf(context: TestContext, cookie: string, workflowId: string): Promise<ReleaseGateCasesView> {
  const response = await call(context, "GET", `/api/workflows/${workflowId}/release-gate/cases`, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ cases: ReleaseGateCasesView }>().cases;
}

/** A finished replay job over the sets as they are now, every listed case passing. */
async function seedJob(context: TestContext, input: { workflowId: string; datasetId: string; version: number; hash: string; fixtureIds: string[] }): Promise<string> {
  const id = `run_${crypto.randomUUID()}`;
  await context.store.createEvalRun({
    id,
    datasetId: input.datasetId,
    workflowId: input.workflowId,
    kind: "replay",
    status: "running",
    datasetIds: [input.datasetId],
    candidate: { kind: "version", version: input.version, workflowHash: input.hash, releaseEligible: true, releaseIneligibleReasons: [] },
    workflowHash: input.hash,
    workflowVersion: input.version,
    options: { mcpMode: "strict", maxCostUsd: 5 }
  });
  await context.store.setEvalRunSetSnapshot(id, await goldenSetSnapshots([input.datasetId], async (datasetId) => await context.store.listEvalFixtures(datasetId)));
  for (const [index, fixtureId] of input.fixtureIds.entries()) {
    await context.store.recordEvalResult({
      id: `res_${index}_${id}`,
      runId: id,
      fixtureId,
      status: "pass",
      score: { pass: true, details: [{ type: "status", pass: true, reason: "pass" }] },
      diff: { verdict: "same", reasons: [], diff: { totals: { costUsd: { baseline: 0.01, candidate: 0.01 }, latencyMs: { baseline: 100, candidate: 100 } }, guard: { added: [], changed: [] } } }
    });
  }
  await context.store.finalizeEvalRun({ id, status: "completed" });
  return id;
}

/** Fixtures of any golden set that point at a captured candidate: must always be none. */
async function fixturesOnCandidates(context: TestContext): Promise<number> {
  const row = await testSql(context.store).get<{ n: unknown }>(
    "SELECT COUNT(*) AS n FROM eval_fixtures f JOIN replay_recordings r ON r.id = f.recording_id WHERE r.status = 'candidate'"
  );
  return Number(row!.n);
}

async function rawRecording(context: TestContext, id: string): Promise<string> {
  return JSON.stringify(await testSql(context.store).get("SELECT * FROM replay_recordings WHERE id = ?", id));
}

/**
 * An enforced gate on one golden set with two admitted cases, capture on at
 * 100%, version 2 saved, and a passing job over the admitted cases.
 */
async function capturedGateSetup(workflowId: string) {
  const context = await createTestContext();
  const admin = await login(context, "admin");
  const builder = await login(context, "builder");
  await save(context, hookWorkflow(workflowId, "v1"));
  const setId = `set-${workflowId}`;
  await context.store.createEvalDataset({ id: setId, name: "Golden", workflowId });
  const original: string[] = [];
  for (const suffix of ["a", "b"]) {
    const id = `${workflowId}_${suffix}`;
    await context.store.createEvalFixture({ id, datasetId: setId, name: `Case ${suffix}`, input: {}, recordingId: `rec_${id}` });
    original.push(id);
  }
  const gate = await call(context, "PUT", `/api/workflows/${workflowId}/release-gate`, admin.cookie, { enabled: true, enforced: true, datasetIds: [setId], policy: { minPassRate: 0.9, minCases: 1 } });
  expect(gate.statusCode, gate.body).toBe(200);
  expect(gate.json<{ gate: ReleaseGateView }>().gate.enforced).toBe(true);
  const capture = await call(context, "PUT", `/api/workflows/${workflowId}/replay-capture`, builder.cookie, { enabled: true, rate: 1 });
  expect(capture.statusCode, capture.body).toBe(200);
  const version = await save(context, hookWorkflow(workflowId, "v2"));
  const hash = (await call(context, "GET", `/api/workflows/${workflowId}/publish-preview?version=${version}`, builder.cookie)).json<{ preview: ReleasePublishPreview }>().preview.workflowHash;
  const job = await seedJob(context, { workflowId, datasetId: setId, version, hash, fixtureIds: original });
  const first = await preview(context, builder.cookie, workflowId, version, job);
  expect(first.verdict, first.reasons.join(" | ")).toBe("passed");
  return { context, admin, builder, setId, original, version, hash, job };
}

async function captureOne(context: TestContext, cookie: string, workflowId: string): Promise<ReplayCaptureView> {
  const hooked = await context.app.inject({ method: "POST", url: `/webhook/hook-${workflowId}`, payload: { user_prompt: `Refund for ${EMAIL}` } });
  expect(hooked.statusCode, hooked.body).toBe(200);
  for (const until = Date.now() + 20_000; ; ) {
    const items = (await call(context, "GET", `/api/workflows/${workflowId}/replay-captures`, cookie)).json<{ items: ReplayCaptureView[] }>().items;
    if (items.length > 0) return items[0]!;
    if (Date.now() > until) throw new Error("The capture never arrived");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("captured runs on an enforced release gate", () => {
  it("a candidate is never a case; promote lands the case pending, leaves earlier jobs fresh, and never re-scrubs a golden run a case replays", async () => {
    const { context, builder, setId, original, version, job } = await capturedGateSetup("wf-cap-pending");
    const capture = await captureOne(context, builder.cookie, "wf-cap-pending");
    expect(capture).toMatchObject({ status: "candidate", masked: true });

    // The ordinary add path refuses the candidate: no case may replay it while promote can still rewrite it.
    const added = await call(context, "POST", `/api/eval/datasets/${setId}/recordings`, builder.cookie, { recordingId: capture.id });
    expect(added.statusCode, added.body).toBe(409);
    expect(await fixturesOnCandidates(context)).toBe(0);

    const promoted = await call(context, "POST", `/api/replay/captures/${capture.id}/promote`, builder.cookie, { datasetId: setId });
    expect(promoted.statusCode, promoted.body).toBe(200);
    const fixtureId = promoted.json<{ result: { fixtureId?: string } }>().result.fixtureId!;
    expect(fixtureId).toBeTruthy();
    expect(await context.store.getEvalFixture(fixtureId)).toMatchObject({ recordingId: capture.id, required: false });
    expect(await context.store.getReplayRecordingSummary(capture.id)).toMatchObject({ status: "golden" });
    expect(await fixturesOnCandidates(context)).toBe(0);

    // Pending on the enforced gate: it does not count, and the earlier job is not stale.
    const view = await casesOf(context, builder.cookie, "wf-cap-pending");
    expect(view.cases.find((entry) => entry.fixtureId === fixtureId)).toMatchObject({ admission: "pending" });
    for (const id of original) expect(view.cases.find((entry) => entry.fixtureId === id)).toMatchObject({ admission: "admitted" });
    const judged = await preview(context, builder.cookie, "wf-cap-pending", version, job);
    expect(judged.verdict).toBe("passed");
    expect(judged.reasons.join(" ")).not.toMatch(/changed after replay job/);

    // Promote only rewrites candidates: a second promote of the now-golden run is refused and changes nothing.
    const before = await rawRecording(context, capture.id);
    const again = await call(context, "POST", `/api/replay/captures/${capture.id}/promote`, builder.cookie, { datasetId: setId });
    expect(again.statusCode).toBe(404);
    expect(again.json<{ error: string }>().error).toBe("Captured run not found");
    expect(await rawRecording(context, capture.id)).toBe(before);
    expect((await context.store.listEvalFixtures(setId)).filter((fixture) => fixture.recordingId === capture.id)).toHaveLength(1);
  }, 60_000);

  it("an admin's data-subject delete removes an admitted case: audited as loosening, and the jobs that held its results are stale", async () => {
    const { context, admin, builder, setId, original, version, hash } = await capturedGateSetup("wf-cap-erase");
    const capture = await captureOne(context, builder.cookie, "wf-cap-erase");
    const promoted = await call(context, "POST", `/api/replay/captures/${capture.id}/promote`, builder.cookie, { datasetId: setId });
    const fixtureId = promoted.json<{ result: { fixtureId: string } }>().result.fixtureId;
    const admitted = await call(context, "POST", "/api/workflows/wf-cap-erase/release-gate/cases/admit", admin.cookie, { fixtureIds: [fixtureId] });
    expect(admitted.statusCode, admitted.body).toBe(200);
    const required = await call(context, "PUT", `/api/workflows/wf-cap-erase/release-gate/cases/${fixtureId}/required`, admin.cookie, { required: true });
    expect(required.statusCode, required.body).toBe(200);
    const job = await seedJob(context, { workflowId: "wf-cap-erase", datasetId: setId, version, hash, fixtureIds: [...original, fixtureId] });
    const other = await seedJob(context, { workflowId: "wf-cap-erase", datasetId: setId, version, hash, fixtureIds: original });
    expect((await preview(context, builder.cookie, "wf-cap-erase", version, job)).verdict).toBe("passed");

    // Erasure is a legal obligation: the admin's delete is not refused for an admitted case.
    const found = (await call(context, "POST", "/api/replay/recordings/find-subject", admin.cookie, { value: EMAIL })).json<ReplayFindSubjectResult>();
    const targets = found.matches.map((match) => ({ kind: match.kind, id: match.id }));
    expect(targets).toContainEqual({ kind: "recording", id: capture.id });
    const removed = await call(context, "POST", "/api/replay/recordings/find-subject/delete", admin.cookie, { value: EMAIL, targets });
    expect(removed.statusCode, removed.body).toBe(200);
    const outcome = removed.json<ReplayFindSubjectDeleteResult>();
    expect(outcome.deleted.recording).toBe(1);
    expect(await context.store.getEvalFixture(fixtureId)).toBeNull();

    // Audited as loosening the gate, naming the case.
    const release = (await context.store.listAuditLogs({ category: "release", pageSize: 500 })).items;
    const casesRemoved = release.filter((entry) => entry.eventType === "release.gate.cases_removed").map((entry) => entry.metadata as Record<string, unknown>);
    expect(casesRemoved).toContainEqual(expect.objectContaining({ via: "data_subject", target: `recording:${capture.id}`, fixtureIds: [fixtureId] }));
    const row = casesRemoved.find((entry) => entry.via === "data_subject")!;
    expect((row.loosened as string[]).length).toBeGreaterThan(0);
    expect(row.requiredFixtureIds).toEqual([fixtureId]);

    // The job that ran the erased case is stale for good; the one that never ran it is untouched.
    const stale = release.find((entry) => entry.eventType === "release.jobs.evidence_removed");
    expect(stale?.metadata).toMatchObject({ via: "data_subject", runIds: [job] });
    expect((await context.store.getEvalRun(job))!.candidate).toMatchObject({ releaseEligible: false });
    const judged = await preview(context, builder.cookie, "wf-cap-erase", version, job);
    expect(judged.verdict).toBe("blocked");
    expect(judged.reasons.join(" ")).toMatch(/data-subject delete/);
    expect((await context.store.getEvalRun(other))!.candidate).toMatchObject({ releaseEligible: true });
    expect((await preview(context, builder.cookie, "wf-cap-erase", version, other)).verdict).toBe("passed");
  }, 60_000);
});
