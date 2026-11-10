/**
 * Phase 12 coverage — the controlled reveal step over the API:
 *
 * - migration v69: the token vault records the project and run that issued each token;
 * - a run's vault writes its project, and a Reveal node reveals only that project's tokens;
 * - a reveal writes rule events (placement and action `reveal`, token hashes, never values) and an audit entry;
 * - a signed-in admin's run reveals; a webhook run of the same workflow does not (role rules never match it);
 * - simulations, candidate rule set runs (replays) and eval runs never reveal.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { MIGRATIONS } from "./db/migrations.js";
import { contiguousMigrationVersions } from "./db/migration-versions.test-helper.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { AuthService } from "./services/auth-service.js";
import { GuardService } from "./services/guard-service.js";
import { SecretService } from "./services/secret-service.js";
import { GuardSimulationSink, GuardSimulationVault } from "./services/guard-simulation-sink.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const dirs: string[] = [];

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
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-reveal-"));
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
  const context = { app, store, authService, config, tempDir };
  contexts.push(context);
  return context;
}

async function login(context: TestContext, role: "admin" | "builder"): Promise<string> {
  const email = `${role}@example.com`;
  const password = `${role}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [raw ?? ""]).find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`))!;
  return cookie.split(";")[0]!;
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

const EMAIL = "ana.lopez@example.org";

const SUPPORT_RULES = {
  id: "support",
  name: "Support",
  version: "1",
  channels: {
    prompt: { detectors: [{ id: "dlp.patterns", threshold: 0.5 }], actions: { email: { action: "protect" } }, defaultAction: { action: "allow" } }
  },
  reveal: { rules: [{ name: "Admins", dataClasses: ["email"], subjects: { roles: ["admin"] } }] }
};

/** hook → protect (token vault) → reveal → out */
function revealWorkflow(id: string): Workflow {
  return {
    id,
    name: `Reveal ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: `hook-${id}`, method: "POST" } },
      { id: "protect", type: "guard", name: "Protect", position: { x: 100, y: 0 }, config: { profileId: "support", channel: "prompt", inputField: "user_prompt" } },
      { id: "vault", type: "guard_protection", name: "Vault", position: { x: 100, y: 100 }, config: { providerId: "token_vault", dataClasses: ["email"] } },
      { id: "reveal", type: "guard_reveal", name: "Reveal", position: { x: 200, y: 0 }, config: { profileId: "support", inputField: "user_prompt" } },
      { id: "out", type: "output", name: "Out", position: { x: 300, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "hook", target: "protect" },
      { id: "e2", source: "protect", sourceHandle: "pass", target: "reveal" },
      { id: "e3", source: "protect", sourceHandle: "protection", target: "vault" },
      { id: "e4", source: "reveal", target: "out" }
    ]
  } as Workflow;
}

type RunResult = { status: string; executionId?: string; error?: string; nodeResults: Array<{ nodeId: string; status: string; output?: Record<string, any> }> };
const outputOf = (run: RunResult, nodeId: string) => run.nodeResults.find((entry) => entry.nodeId === nodeId)?.output ?? {};

describe("migration v69", () => {
  it("adds the issuing project and run to the token vault, with a rollback, in both stores", async () => {
    const versions = MIGRATIONS.map((entry) => entry.version).sort((a, b) => a - b);
    expect(versions).toEqual(contiguousMigrationVersions(versions));
    const migration = MIGRATIONS.find((entry) => entry.version === 69)!;
    expect(migration.up).toContain("ALTER TABLE guard_token_vault ADD COLUMN IF NOT EXISTS project_id TEXT");
    expect(migration.up).toContain("CREATE INDEX IF NOT EXISTS idx_guard_token_vault_project");
    expect(migration.down).toContain("DROP COLUMN IF EXISTS project_id");
    const context = await createTestContext();
    const sql = testSql(context.store);
    const columns = (
      sql.kind === "sqlite"
        ? await sql.all<{ name: string }>(`PRAGMA table_info(guard_token_vault)`)
        : await sql.all<{ name: string }>(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?`, "guard_token_vault")
    ).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["project_id", "execution_id"]));
  });
});

describe("Reveal over the API", () => {
  it("reveals for a signed-in admin's run, records hashes and an audit entry, and keeps tokens on a webhook run", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    expect((await call(context, "POST", "/api/guard/profiles", admin, { id: "support", document: SUPPORT_RULES })).statusCode).toBe(201);
    const workflow = revealWorkflow("wf-reveal");
    await context.store.upsertWorkflow(workflow);

    const run = (await call(context, "POST", `/api/workflows/${workflow.id}/execute`, admin, { user_prompt: `Mail ${EMAIL} today` })).json<RunResult>();
    expect(run.status, run.error).toBe("success");
    const tokenised = String(outputOf(run, "protect").user_prompt);
    expect(tokenised).toMatch(/^Mail tok_email_\S+ today$/);
    expect(outputOf(run, "reveal").user_prompt).toBe(`Mail ${EMAIL} today`);
    expect(outputOf(run, "reveal").reveal.revealed).toEqual([expect.objectContaining({ dataClass: "email", count: 1 })]);

    const sql = testSql(context.store);
    const row = await sql.get<{ project_id: string | null; execution_id: string | null }>(`SELECT project_id, execution_id FROM guard_token_vault WHERE token = ?`, tokenised.split(" ")[1]!);
    expect(row).toMatchObject({ project_id: "default", execution_id: run.executionId });

    const events = (await call(context, "GET", `/api/guard/events?action=reveal`, admin)).json<{ events: Array<Record<string, any>> }>().events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ placement: "reveal", channel: "reveal", nodeId: "reveal", dataClass: "email", requestedAction: "reveal", effectiveAction: "reveal", verdictAction: "reveal", profileId: "support" });
    expect(JSON.stringify(events)).not.toContain(EMAIL);
    expect(JSON.stringify(events)).not.toContain(tokenised.split(" ")[1]);
    const audit = (await context.store.listAuditLogs({ eventType: "content_rules.reveal", pageSize: 10 })).items;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: "success", resourceId: workflow.id, projectId: "default" });
    expect(JSON.stringify(audit)).not.toContain(EMAIL);

    // A webhook run acts as the workflow's owner, not a signed-in person: the admin role rule never matches it.
    const hook = await context.app.inject({ method: "POST", url: `/webhook/hook-${workflow.id}`, payload: { user_prompt: `Mail ${EMAIL} today` } });
    expect(hook.statusCode, hook.body).toBe(200);
    const refused = (await call(context, "GET", `/api/guard/events?action=block`, admin)).json<{ events: Array<Record<string, any>> }>().events.filter((event) => event.placement === "reveal");
    expect(refused).toEqual([expect.objectContaining({ dataClass: "email", requestedAction: "reveal", effectiveAction: "block" })]);
    expect(hook.body).not.toContain(EMAIL);
    const denied = (await context.store.listAuditLogs({ eventType: "content_rules.reveal", outcome: "denied", pageSize: 10 })).items;
    expect(denied).toHaveLength(1);
  });

  it("refuses a builder's save of a rule set with reveal rules", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const saved = await call(context, "POST", "/api/guard/profiles", builder, { id: "support", document: SUPPORT_RULES });
    expect(saved.statusCode).toBe(403);
  });
});

describe("GuardService reveal wiring", () => {
  async function service() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-reveal-svc-"));
    dirs.push(dir);
    const store = await openTestStore(path.join(dir, "db.sqlite"));
    await store.ensureDefaultProject();
    const secrets = new SecretService(store, crypto.randomBytes(32).toString("base64"));
    const audits: Array<Record<string, unknown>> = [];
    const guard = new GuardService(store, secrets, { autoApply: false, audit: async (event) => audits.push(event as unknown as Record<string, unknown>) });
    await guard.ensureBuiltIns();
    return { store, guard, audits };
  }

  it("scopes a run's vault writes to its project and run, and reads them back", async () => {
    const { guard } = await service();
    const runtime = guard.runtimeFor({ workflowId: "wf", projectId: "proj-a", executionId: "exec-1" });
    await runtime.vault!.put({ token: "tok_email_AAAAAAAAAAAAAAAA", dataClass: "email", value: EMAIL, createdAt: new Date().toISOString() });
    expect(await runtime.vault!.getByToken("tok_email_AAAAAAAAAAAAAAAA")).toMatchObject({ value: EMAIL, projectId: "proj-a", executionId: "exec-1" });
    await guard.vault.put({ token: "tok_email_BBBBBBBBBBBBBBBB", dataClass: "email", value: EMAIL, createdAt: new Date().toISOString() });
    expect(await guard.vault.getByToken("tok_email_BBBBBBBBBBBBBBBB")).toMatchObject({ projectId: null, executionId: null });
    expect(runtime.projectId).toBe("proj-a");
    expect(runtime.onReveal).toBeTypeOf("function");
    expect(runtime.revealDisabled).toBeUndefined();
  });

  it("turns reveal off for simulations, candidate rule set runs (replays) and eval runs", async () => {
    const { guard } = await service();
    const simulation = { sink: new GuardSimulationSink(), vault: new GuardSimulationVault() };
    for (const context of [
      { workflowId: "wf", simulation },
      { workflowId: "wf", profileOverride: { profileId: "default" } },
      { workflowId: "wf", runSource: "eval" as const }
    ]) {
      const runtime = guard.runtimeFor(context);
      expect(runtime.revealDisabled).toBe(true);
      expect(runtime.onReveal).toBeUndefined();
    }
  });

  it("records revealed and refused classes as reveal events with hashes, and audits the step", async () => {
    const { guard, audits } = await service();
    await guard.recordReveal(
      {
        executionId: "exec-9",
        workflowId: "wf",
        nodeId: "reveal",
        subject: { source: "user", role: "admin", userId: "u-1" },
        profiles: [{ profileId: "default", version: 1, hash: "h1" }],
        revealed: [{ dataClass: "email", count: 2, tokenHashes: ["aaaa", "bbbb"], rule: { profileId: "default", version: 1, index: 0 } }],
        refused: [{ dataClass: "card_number", count: 1, tokenHashes: ["cccc"], reason: "other_project" }],
        approved: false
      },
      { workflowId: "wf", projectId: "proj-a", executionId: "exec-9" }
    );
    const { events } = await guard.listEvents({ executionId: "exec-9" });
    expect(events.map((event) => [event.dataClass, event.effectiveAction, event.verdictAction])).toEqual(
      expect.arrayContaining([
        ["email", "reveal", "reveal"],
        ["card_number", "block", "reveal"]
      ])
    );
    const email = events.find((event) => event.dataClass === "email")!;
    expect(email.evidence.map((entry) => entry.evidence)).toEqual(["sha256:aaaa", "sha256:bbbb"]);
    expect(email.profileHash).toBe("h1");
    expect(audits).toEqual([expect.objectContaining({ eventType: "content_rules.reveal", outcome: "success", projectId: "proj-a", actor: { type: "user", userId: "u-1" } })]);
    const stats = await guard.stats({ executionId: "exec-9" });
    expect(stats.verdicts).toEqual([{ key: "reveal", count: 1 }]);
  });
});
