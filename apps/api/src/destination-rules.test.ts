/**
 * Phase 16 (p3) — the deployment's destination rules over the API: zero
 * config changes nothing; the starter rule is created observing (shadow),
 * counted by the observing banner and enforced with one switch; only admins
 * change it; HTTP Request egress is checked at call time against the stored
 * destination rows; "Preview impact" replays recent runs with unsaved rows
 * (never stored) and names where newly blocked content was going.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DestinationRulesStatus, GuardSimulationView, Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { AuthService } from "./services/auth-service.js";
import { GuardService } from "./services/guard-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const closers: Array<() => Promise<void>> = [];
const MASTER_KEY = crypto.randomBytes(32).toString("base64");
const CARD = "4111 1111 1111 1111";

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-dest-rules-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: MASTER_KEY,
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git")
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  const context = { app, store, authService, config, tempDir };
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
      // Closed by the app's shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

async function login(context: TestContext, role: "admin" | "builder" | "viewer"): Promise<{ cookie: string }> {
  const email = `${role}@example.com`;
  const password = `${role}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`))!;
  return { cookie: cookie.split(";")[0]! };
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

/** A local server that records what reaches it. */
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

/** webhook → HTTP Request (POSTs the prompt to `url`) → output. */
function senderWorkflow(url: string, id = "wf-sender"): Workflow {
  return {
    id,
    name: "Sender",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: `hook-${id}`, method: "POST" } },
      { id: "send", type: "http_request", name: "Send note", position: { x: 200, y: 0 }, config: { method: "POST", urlTemplate: url, bodyTemplate: '{"note":"{{user_prompt}}"}' } },
      { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "hook", target: "send" },
      { id: "e2", source: "send", target: "out" }
    ]
  } as Workflow;
}

const PUBLIC_LOOPBACK = { name: "Test receiver", kind: "http", host: "127.0.0.1", tier: "public" };

describe("deployment destination rules", () => {
  it("zero config: no rules profile, nothing resolved or evaluated, and the request goes out", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const receiver = await startReceiver();
    await context.store.upsertWorkflow(senderWorkflow(receiver.url));
    const status = (await call(context, "GET", "/api/guard/destination-rules", admin.cookie)).json<DestinationRulesStatus>();
    expect(status).toMatchObject({ available: true, version: null, rules: [], mode: "off", hasStarter: false, observing: { wouldBlock: 0, days: 7 } });
    expect(await context.store.getGuardProfile("destination-rules")).toBeNull();
    expect(await context.store.anyGuardProfileUsesLabels()).toBe(false);
    const run = await call(context, "POST", "/api/workflows/wf-sender/execute", admin.cookie, { user_prompt: `card ${CARD}` });
    expect(run.json<{ status: string }>().status).toBe("success");
    expect(receiver.bodies.at(-1)).toContain("4111");
    expect((await context.store.listGuardEvents({})).total).toBe(0);
  }, 60_000);

  it("the starter rule observes first, counts would-be blocks, then enforces with one switch", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");
    const receiver = await startReceiver();
    await context.store.upsertWorkflow(senderWorkflow(receiver.url));
    expect((await call(context, "POST", "/api/data-destinations", admin.cookie, PUBLIC_LOOPBACK)).statusCode).toBe(201);

    // Only admins add it; it is created observing.
    expect((await call(context, "POST", "/api/guard/destination-rules/starter", builder.cookie)).statusCode).toBe(403);
    const created = await call(context, "POST", "/api/guard/destination-rules/starter", admin.cookie);
    expect(created.statusCode).toBe(201);
    const status = created.json<DestinationRulesStatus>();
    expect(status).toMatchObject({ mode: "observing", hasStarter: true, version: 1 });
    expect(status.rules[0]).toMatchObject({ name: "Keep sensitive data in-house", allow: { maxTier: "private" }, action: "block", shadow: true });
    // A second click changes nothing.
    expect((await call(context, "POST", "/api/guard/destination-rules/starter", admin.cookie)).statusCode).toBe(200);
    expect(await context.store.anyGuardProfileUsesLabels()).toBe(true);

    // Observing: the card still goes out, and the would-be block is counted.
    const observed = await call(context, "POST", "/api/workflows/wf-sender/execute", admin.cookie, { user_prompt: `card ${CARD}` });
    expect(observed.json<{ status: string }>().status).toBe("success");
    expect(receiver.bodies.at(-1)).toContain("4111");
    const clean = await call(context, "POST", "/api/workflows/wf-sender/execute", admin.cookie, { user_prompt: "hello" });
    expect(clean.json<{ status: string }>().status).toBe("success");
    const watching = (await call(context, "GET", "/api/guard/destination-rules", admin.cookie)).json<DestinationRulesStatus>();
    expect(watching.observing).toEqual({ wouldBlock: 1, days: 7 });
    // Non-admins see the rules, not the count.
    expect((await call(context, "GET", "/api/guard/destination-rules", viewer.cookie)).json<DestinationRulesStatus>()).toMatchObject({ mode: "observing", observing: null });
    const events = (await context.store.listGuardEvents({ channel: "egress" })).events;
    expect(events.find((event) => event.detectorId === "<destinations>")).toMatchObject({ effectiveAction: "block", shadow: true, profileId: "destination-rules", dataClass: "card_number" });
    expect(JSON.stringify(events)).not.toContain("4111 1111 1111 1111");

    // Builders cannot change it through the profile routes either.
    expect((await call(context, "PUT", "/api/guard/profiles/destination-rules", builder.cookie, { document: { id: "destination-rules", name: "x", version: "1" } })).statusCode).toBe(403);
    expect((await call(context, "DELETE", "/api/guard/profiles/destination-rules", builder.cookie)).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/guard/destination-rules/enforcement", builder.cookie, { enforce: true })).statusCode).toBe(403);

    // Enforcement on: the next card is stopped before it leaves, with the reason.
    const sent = receiver.bodies.length;
    const enforced = await call(context, "POST", "/api/guard/destination-rules/enforcement", admin.cookie, { enforce: true });
    expect(enforced.json<DestinationRulesStatus>()).toMatchObject({ mode: "enforcing", version: 2 });
    const blocked = await call(context, "POST", "/api/workflows/wf-sender/execute", admin.cookie, { user_prompt: `card ${CARD}` });
    const body = blocked.json<{ status: string; nodeResults?: Array<{ nodeId: string; error?: string }> }>();
    expect(body.status).toBe("error");
    expect(receiver.bodies.length).toBe(sent);
    expect(JSON.stringify(body)).toContain("may go no further than private network");
    expect(JSON.stringify(body)).toContain("Test receiver (public)");

    // The full rule list is editable (validated like a profile).
    const invalid = await call(context, "PUT", "/api/guard/destination-rules", admin.cookie, { rules: [{ allow: { maxTier: "private" }, action: "redact" }] });
    expect(invalid.statusCode).toBe(400);
    const cleared = await call(context, "PUT", "/api/guard/destination-rules", admin.cookie, { rules: [] });
    expect(cleared.json<DestinationRulesStatus>()).toMatchObject({ mode: "off", rules: [] });
    const after = await call(context, "POST", "/api/workflows/wf-sender/execute", admin.cookie, { user_prompt: `card ${CARD}` });
    expect(after.json<{ status: string }>().status).toBe("success");
  }, 90_000);

  it("Preview impact replays recent runs with unsaved rows, never stores them, and names the destination", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const receiver = await startReceiver();
    await context.store.upsertWorkflow(senderWorkflow(receiver.url));
    expect((await call(context, "POST", "/api/guard/destination-rules/starter", admin.cookie)).statusCode).toBe(201);
    expect((await call(context, "POST", "/api/guard/destination-rules/enforcement", admin.cookie, { enforce: true })).statusCode).toBe(200);
    // Two recorded runs: the loopback receiver is local by default, so both went out.
    for (const prompt of [`card ${CARD}`, "hello"]) {
      const run = await call(context, "POST", "/api/workflows/wf-sender/execute", admin.cookie, { record: true, user_prompt: prompt });
      expect(run.json<{ status: string }>().status).toBe("success");
      const saved = await call(context, "POST", "/api/replay/recordings", admin.cookie, { executionId: run.json<{ executionId: string }>().executionId, name: prompt });
      expect(saved.statusCode, saved.body).toBe(201);
    }
    const sent = receiver.bodies.length;

    // Admin only; rows are validated like a save.
    expect((await call(context, "POST", "/api/data-destinations/preview", builder.cookie, { rows: [PUBLIC_LOOPBACK] })).statusCode).toBe(403);
    const invalid = await call(context, "POST", "/api/data-destinations/preview", admin.cookie, { rows: [{ name: "x", kind: "http", tier: "public" }] });
    expect(invalid.statusCode).toBe(400);

    const started = await call(context, "POST", "/api/data-destinations/preview?wait=true", admin.cookie, { rows: [PUBLIC_LOOPBACK] });
    expect(started.statusCode, started.body).toBe(200);
    const preview = started.json<{ simulation: GuardSimulationView }>().simulation;
    expect(preview).toMatchObject({ profileId: "destinations-preview", status: "completed" });
    expect(preview.summary).toMatchObject({ runs: 2, runsNewlyBlocked: 1 });
    expect(preview.summary!.byDestination?.["Test receiver (public)"]).toMatchObject({ newlyBlocked: 1, tier: "public" });
    expect(preview.summary!.sentence).toContain("1 newly blocked going to Test receiver (public)");
    // Nothing was sent, and the rows were never stored.
    expect(receiver.bodies.length).toBe(sent);
    expect(await context.store.listDataDestinations()).toEqual([]);
    expect(JSON.stringify(await context.store.getGuardSimulation(preview.id))).not.toContain("Test receiver\",\"kind");

    // Listed for admins; the builder cannot read it.
    const listed = (await call(context, "GET", "/api/data-destinations/previews", admin.cookie)).json<{ simulations: GuardSimulationView[] }>().simulations;
    expect(listed.map((entry) => entry.id)).toEqual([preview.id]);
    expect((await call(context, "GET", `/api/guard/simulations/${preview.id}`, builder.cookie)).statusCode).toBe(403);
    expect((await call(context, "GET", "/api/data-destinations/previews", builder.cookie)).statusCode).toBe(403);
  }, 120_000);

  it("Preview impact of removing a stored row: removedIds take it out of the candidate side only", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const receiver = await startReceiver();
    await context.store.upsertWorkflow(senderWorkflow(receiver.url));
    expect((await call(context, "POST", "/api/guard/destination-rules/starter", admin.cookie)).statusCode).toBe(201);
    expect((await call(context, "POST", "/api/guard/destination-rules/enforcement", admin.cookie, { enforce: true })).statusCode).toBe(200);
    // Recorded while the loopback receiver is local (built-in): the card went out.
    const run = await call(context, "POST", "/api/workflows/wf-sender/execute", admin.cookie, { record: true, user_prompt: `card ${CARD}` });
    expect(run.json<{ status: string }>().status).toBe("success");
    expect((await call(context, "POST", "/api/replay/recordings", admin.cookie, { executionId: run.json<{ executionId: string }>().executionId, name: "card" })).statusCode).toBe(201);
    // The stored row makes loopback public: the baseline side blocks the card.
    const stored = await call(context, "POST", "/api/data-destinations", admin.cookie, PUBLIC_LOOPBACK);
    expect(stored.statusCode, stored.body).toBe(201);
    const rowId = stored.json<{ destination: { id: string } }>().destination.id;

    const started = await call(context, "POST", "/api/data-destinations/preview?wait=true", admin.cookie, { rows: [], removedIds: [rowId] });
    expect(started.statusCode, started.body).toBe(200);
    const preview = started.json<{ simulation: GuardSimulationView }>().simulation;
    expect(preview.status).toBe("completed");
    expect(preview.summary).toMatchObject({ runs: 1, runsNewlyBlocked: 0, runsNoLongerBlocked: 1 });
    // The removal was only previewed.
    expect((await context.store.listDataDestinations()).map((row) => row.id)).toEqual([rowId]);
  }, 120_000);

  it("reserves the rules profile's and the preview's ids: nobody creates or imports them through the profile routes", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    for (const id of ["destination-rules", "destinations-preview"]) {
      const document = { id, name: "Mine", version: "1" };
      const created = await call(context, "POST", "/api/guard/profiles", admin.cookie, { document });
      expect(created.statusCode, `${id}: ${created.body}`).toBe(400);
      expect(created.body).toContain("reserved");
      expect((await call(context, "POST", "/api/guard/profiles", builder.cookie, { document })).statusCode).not.toBe(201);
      const imported = await call(context, "POST", "/api/guard/profiles/import", admin.cookie, { document });
      expect(imported.statusCode, `${id}: ${imported.body}`).toBe(400);
      expect(await context.store.getGuardProfile(id)).toBeNull();
    }
    // The Security page still creates the rules profile.
    expect((await call(context, "POST", "/api/guard/destination-rules/starter", admin.cookie)).statusCode).toBe(201);
    expect(await context.store.getGuardProfile("destination-rules")).not.toBeNull();
    // And an import cannot overwrite it afterwards.
    const overwrite = await call(context, "POST", "/api/guard/profiles/import", admin.cookie, { document: { id: "destination-rules", name: "Mine", version: "1" } });
    expect(overwrite.statusCode).toBe(400);
  }, 60_000);

  it("the opt-in check reads profiles as JSON: reformatted or reordered documents are seen, look-alike text is not", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-dest-optin-"));
    const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
    try {
      const raw = testSql(store);
      const write = async (id: string, json: string) => {
        await raw.run(`INSERT INTO guard_profiles (id, name, description, built_in, latest_version, created_at, created_by, updated_at, updated_by) VALUES (?, ?, NULL, ?, 1, '2026-01-01', NULL, '2026-01-01', NULL)`, id, id, 0);
        await raw.run(`INSERT INTO guard_profile_versions (profile_id, version, hash, document_json, note, created_at, created_by) VALUES (?, 1, ?, ?, NULL, '2026-01-01', NULL)`, id, `h-${id}`, json);
      };
      // Look-alike text that is not a rule, an empty rule list and an egress action category: no opt-in.
      await write("lookalike", JSON.stringify({ id: "lookalike", description: '"destinations":{"rules":[{', destinations: { rules: [] }, actions: { egress: { action: "block" } } }, null, 2));
      expect(await store.anyGuardProfileUsesLabels()).toBe(false);
      // Pretty-printed, with a key that sorts before "rules": still seen.
      await write("pretty", JSON.stringify({ id: "pretty", destinations: { aardvark: true, rules: [{ allow: { maxTier: "private" }, action: "block" }] } }, null, 2));
      expect(await store.anyGuardProfileUsesLabels()).toBe(true);
    } finally {
      await store.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    const egressTemp = fs.mkdtempSync(path.join(os.tmpdir(), "ao-dest-optin-"));
    const egressStore = await openTestStore(path.join(egressTemp, "orchestrator.db"));
    try {
      const raw = testSql(egressStore);
      await raw.run(`INSERT INTO guard_profiles (id, name, description, built_in, latest_version, created_at, created_by, updated_at, updated_by) VALUES ('e', 'e', NULL, ?, 1, '2026-01-01', NULL, '2026-01-01', NULL)`, 0);
      await raw.run(`INSERT INTO guard_profile_versions (profile_id, version, hash, document_json, note, created_at, created_by) VALUES ('e', 1, 'h', ?, NULL, '2026-01-01', NULL)`,
        JSON.stringify({ channels: { egress: { defaultAction: { action: "allow" }, actions: {} } }, id: "e" }, null, 1)
      );
      expect(await egressStore.anyGuardProfileUsesLabels()).toBe(true);
    } finally {
      await egressStore.close();
      fs.rmSync(egressTemp, { recursive: true, force: true });
    }
  });

  it("clean outbound calls write no verdict row once rules exist, and replays do not count as observed traffic", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const receiver = await startReceiver();
    await context.store.upsertWorkflow(senderWorkflow(receiver.url));
    expect((await call(context, "POST", "/api/data-destinations", admin.cookie, PUBLIC_LOOPBACK)).statusCode).toBe(201);
    expect((await call(context, "POST", "/api/guard/destination-rules/starter", admin.cookie)).statusCode).toBe(201);
    const clean = await call(context, "POST", "/api/workflows/wf-sender/execute", admin.cookie, { user_prompt: "hello" });
    expect(clean.json<{ status: string }>().status).toBe("success");
    expect((await context.store.listGuardEvents({})).total).toBe(0);

    // A real run with a card: observed once. A replay of it: not traffic, not counted.
    const run = await call(context, "POST", "/api/workflows/wf-sender/execute", admin.cookie, { record: true, user_prompt: `card ${CARD}` });
    expect(run.json<{ status: string }>().status).toBe("success");
    expect((await call(context, "GET", "/api/guard/destination-rules", admin.cookie)).json<DestinationRulesStatus>().observing).toEqual({ wouldBlock: 1, days: 7 });
    const saved = await call(context, "POST", "/api/replay/recordings", admin.cookie, { executionId: run.json<{ executionId: string }>().executionId, name: "card" });
    expect(saved.statusCode, saved.body).toBe(201);
    const set = (await call(context, "POST", "/api/eval/datasets", admin.cookie, { name: "Suite", workflowId: "wf-sender" })).json<{ dataset: { id: string } }>().dataset.id;
    expect((await call(context, "POST", `/api/eval/datasets/${set}/recordings`, admin.cookie, { recordingId: saved.json<{ recording: { id: string } }>().recording.id })).statusCode).toBe(201);
    const started = await call(context, "POST", "/api/replay/runs?wait=true", admin.cookie, { datasetIds: [set] });
    expect([200, 202]).toContain(started.statusCode);
    const until = Date.now() + 30_000;
    while ((await context.store.listGuardEvents({})).events.filter((event) => event.detectorId === "<destinations>").length < 2) {
      if (Date.now() > until) throw new Error("The replay recorded no verdict");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect((await call(context, "GET", "/api/guard/destination-rules", admin.cookie)).json<DestinationRulesStatus>().observing).toEqual({ wouldBlock: 1, days: 7 });
  }, 90_000);

  it("the rules profile comes after a run's own profiles, a candidate's too, and keeps the instance default", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-dest-resolve-"));
    const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
    try {
      const guard = new GuardService(store, new SecretService(store, MASTER_KEY), { autoApply: true });
      await guard.ensureBuiltIns();
      const before = await guard.resolveRun({ workflowId: "wf" });
      expect(before.stack.map((entry) => entry.profileId)).toEqual(["default"]);
      expect(before.deployment).toBeUndefined();
      await guard.addStarterDestinationRule(null);
      const after = await guard.resolveRun({ workflowId: "wf" });
      expect(after.stack.map((entry) => entry.profileId)).toEqual(["default", "destination-rules"]);
      expect(after.source).toBe("instance");
      expect(after.deployment?.profileId).toBe("destination-rules");
      expect(after.chain.at(-1)).toMatchObject({ level: "destinations", mode: "enforced", profileId: "destination-rules", version: 1 });
      const candidate = await guard.resolveRun({ workflowId: "wf", profileOverride: { profileId: "default" } });
      expect(candidate.stack.map((entry) => entry.profileId)).toEqual(["default", "destination-rules"]);
      // A rules profile without rules is not applied.
      await guard.setDestinationRules([], null);
      expect((await guard.resolveRun({ workflowId: "wf" })).stack.map((entry) => entry.profileId)).toEqual(["default"]);
    } finally {
      await store.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
