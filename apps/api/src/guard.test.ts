/**
 * Phase 12.1 — Guard wiring over the API: stored, versioned profiles and
 * their RBAC, field-level validation, export/import, project and workflow
 * bindings with the enforced lock, effective-profile resolution, guard
 * events written with masked evidence only, the token vault sealed through
 * SecretService, protection keys only through secret references, and
 * migration 28 (Postgres DDL and the SQLite schema).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { GuardEventView, GuardProfileSummary, GuardResolutionView, Workflow } from "@ai-orchestrator/shared";
import { createDefaultGuardProfile } from "@ai-orchestrator/guard-sdk";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { MIGRATIONS } from "./db/migrations.js";
import { AuthService } from "./services/auth-service.js";
import { GuardService } from "./services/guard-service.js";
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
const SECRET = "sk-live-abcdefghijklmnopqrstuvwxyz123456";
const EMAIL = "maria.gonzalez@example.org";

async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-guard-"));
  const dbPath = path.join(tempDir, "orchestrator.db");
  const store = await SqliteStore.create(dbPath);
  store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "info",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
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
  vi.restoreAllMocks();
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

const call = (context: TestContext, method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

function strictProfile(id: string, name = "Strict support"): Record<string, unknown> {
  return {
    id,
    name,
    version: "1",
    description: "Blocks email addresses in prompts",
    channels: {
      prompt: {
        detectors: [{ id: "dlp.patterns", threshold: 0.5 }],
        actions: { email: { action: "block" }, sensitive_data: { action: "redact" } },
        defaultAction: { action: "allow" }
      }
    }
  };
}

function guardWorkflow(id: string, guardConfig: Record<string, unknown> = {}, extraNodes: Workflow["nodes"] = [], extraEdges: Workflow["edges"] = []): Workflow {
  return {
    id,
    name: `Guarded ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: `hook-${id}`, method: "POST" } },
      { id: "guard", type: "guard", name: "Prompt guard", position: { x: 200, y: 0 }, config: guardConfig },
      { id: "pass", type: "output", name: "Pass", position: { x: 400, y: 0 }, config: { responseTemplate: "{{results.guard.user_prompt}}" } },
      { id: "blocked", type: "output", name: "Blocked", position: { x: 400, y: 200 }, config: { responseTemplate: "blocked" } },
      ...extraNodes
    ],
    edges: [
      { id: "e1", source: "hook", target: "guard" },
      { id: "e2", source: "guard", sourceHandle: "pass", target: "pass" },
      { id: "e3", source: "guard", sourceHandle: "blocked", target: "blocked" },
      ...extraEdges
    ]
  } as Workflow;
}

type RunResult = { status: string; executionId?: string; error?: string; nodeResults: Array<{ nodeId: string; status: string; output?: Record<string, any> }> };

describe("migration 28", () => {
  it("creates the guard tables with indexes and a rollback, in Postgres DDL", () => {
    const versions = MIGRATIONS.map((entry) => entry.version).sort((a, b) => a - b);
    expect(versions).toEqual(versions.map((_, index) => index + 1));
    const migration = MIGRATIONS.find((entry) => entry.version === 28);
    expect(migration?.description).toContain("12.1");
    for (const table of ["guard_profiles", "guard_profile_versions", "guard_bindings", "guard_events", "guard_token_vault"]) {
      expect(migration!.up).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(migration!.down).toContain(`DROP TABLE IF EXISTS ${table}`);
    }
    for (const fragment of [
      "verdict_id TEXT NOT NULL",
      "execution_id TEXT NOT NULL",
      "iteration INTEGER",
      "detector_id TEXT",
      "data_class TEXT",
      "score DOUBLE PRECISION",
      "requested_action TEXT NOT NULL",
      "effective_action TEXT NOT NULL",
      "shadow INTEGER NOT NULL DEFAULT 0",
      "evidence_json TEXT NOT NULL",
      "profile_hash TEXT NOT NULL",
      "latency_ms DOUBLE PRECISION",
      "created_at TIMESTAMPTZ NOT NULL",
      "value_sealed TEXT NOT NULL",
      "PRIMARY KEY (profile_id, version)",
      "PRIMARY KEY (scope, scope_id)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_guard_token_vault_hash"
    ]) {
      expect(migration!.up).toContain(fragment);
    }
    // Postgres syntax only: no SQLite-only types or functions.
    expect(migration!.up).not.toMatch(/AUTOINCREMENT|datetime\(|\bREAL\b/);
    // No column of guard_events can hold raw content.
    const eventsDdl = /CREATE TABLE IF NOT EXISTS guard_events \(([\s\S]*?)\);/.exec(migration!.up)![1]!;
    expect(eventsDdl).not.toMatch(/\b(content|raw|value|input|payload)\b/);
  });

  it("creates the SQLite tables, and opening an existing database again keeps its rows", async () => {
    const context = await createTestContext();
    const tables = ["guard_profiles", "guard_profile_versions", "guard_bindings", "guard_events", "guard_token_vault"];
    const admin = await login(context, "admin");
    const created = await call(context, "POST", "/api/guard/profiles", admin.cookie, { document: strictProfile("kept") });
    expect(created.statusCode).toBe(201);
    await context.app.close();
    context.store.close();

    const copy = path.join(context.tempDir, "copy.db");
    fs.copyFileSync(context.dbPath, copy);
    const reopened = await SqliteStore.create(copy);
    for (const table of tables) {
      expect((reopened as unknown as { queryAll: (sql: string) => unknown[] }).queryAll(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`)).toHaveLength(1);
    }
    expect(reopened.getGuardProfile("kept")?.latestVersion).toBe(1);
    reopened.close();
    contexts.pop();
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  });
});

describe("guard profiles", () => {
  it("seeds the built-in default read-only and lets admins and builders write while operators and viewers read", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const operator = await login(context, "operator");
    const viewer = await login(context, "viewer");

    const list = await call(context, "GET", "/api/guard/profiles", viewer.cookie);
    expect(list.statusCode).toBe(200);
    const builtIn = list.json<{ profiles: GuardProfileSummary[] }>().profiles.find((profile) => profile.id === "default");
    expect(builtIn).toMatchObject({ builtIn: true, latestVersion: 1 });

    expect((await call(context, "PUT", "/api/guard/profiles/default", admin.cookie, { document: createDefaultGuardProfile() as unknown as Record<string, unknown> })).statusCode).toBe(409);
    expect((await call(context, "DELETE", "/api/guard/profiles/default", admin.cookie)).statusCode).toBe(409);

    for (const reader of [operator, viewer]) {
      expect((await call(context, "POST", "/api/guard/profiles", reader.cookie, { document: strictProfile("nope") })).statusCode).toBe(403);
      expect((await call(context, "GET", "/api/guard/profiles/default/versions", reader.cookie)).statusCode).toBe(200);
    }
    expect((await call(context, "POST", "/api/guard/profiles", builder.cookie, { document: strictProfile("by-builder") })).statusCode).toBe(201);
    expect((await call(context, "POST", "/api/guard/profiles", admin.cookie, { document: strictProfile("by-admin") })).statusCode).toBe(201);
    expect((await call(context, "POST", "/api/guard/profiles", admin.cookie, { document: strictProfile("by-admin") })).statusCode).toBe(409);
    expect((await call(context, "DELETE", "/api/guard/profiles/by-admin", operator.cookie)).statusCode).toBe(403);
    expect((await call(context, "DELETE", "/api/guard/profiles/by-admin", builder.cookie)).statusCode).toBe(200);
  });

  it("returns field-level errors from the guard-sdk schema and refuses inline keys", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const bad = await call(context, "POST", "/api/guard/profiles", builder.cookie, {
      document: { id: "bad", name: "", version: "1", channels: { prompt: { detectors: [{ id: "dlp.patterns", threshold: 3 }] } } }
    });
    expect(bad.statusCode).toBe(400);
    const paths = bad.json<{ issues: Array<{ path: string; message: string }> }>().issues.map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(["name", "channels.prompt.detectors.0.threshold"]));

    const inlineKey = await call(context, "POST", "/api/guard/profiles", builder.cookie, {
      document: { ...strictProfile("inline"), protection: { dataClasses: { email: { providerId: "aes_gcm", options: { key: "c2VjcmV0LWtleS1tYXRlcmlhbA==" } } } } }
    });
    expect(inlineKey.statusCode).toBe(400);
    expect(inlineKey.json<{ issues: Array<{ path: string }> }>().issues[0]!.path).toBe("protection.dataClasses.email.options.key");
    expect(inlineKey.body).not.toContain("c2VjcmV0LWtleS1tYXRlcmlhbA==");

    const unknownKey = await call(context, "POST", "/api/guard/profiles", builder.cookie, {
      document: { ...strictProfile("unknown"), protection: { dataClasses: { email: { providerId: "aes_gcm", options: { keyId: "sec_missing" } } } } }
    });
    expect(unknownKey.json<{ issues: Array<{ path: string }> }>().issues[0]!.path).toBe("protection.dataClasses.email.options.keyId");

    const secret = context.secretService.createSecret({ name: "guard key", provider: "custom", value: crypto.randomBytes(32).toString("base64") });
    const keyed = await call(context, "POST", "/api/guard/profiles", builder.cookie, {
      document: { ...strictProfile("keyed"), protection: { dataClasses: { email: { providerId: "aes_gcm", options: { keyId: secret.secretId } } } } }
    });
    expect(keyed.statusCode).toBe(201);
  });

  it("versions every change, diffs versions and round-trips export and import", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    await call(context, "POST", "/api/guard/profiles", builder.cookie, { document: strictProfile("support") });
    const unchanged = await call(context, "PUT", "/api/guard/profiles/support", builder.cookie, { document: strictProfile("support") });
    expect(unchanged.json<{ changed: boolean }>().changed).toBe(false);
    const edited = strictProfile("support", "Strict support v2");
    (edited.channels as any).prompt.actions.email = { action: "review" };
    const updated = await call(context, "PUT", "/api/guard/profiles/support", builder.cookie, { document: edited, note: "Review instead" });
    expect(updated.json<{ changed: boolean; version: { version: number; author: string } }>().version).toMatchObject({ version: 2, author: builder.id });

    const versions = (await call(context, "GET", "/api/guard/profiles/support/versions", builder.cookie)).json<{ versions: Array<{ version: number; hash: string }> }>().versions;
    expect(versions.map((entry) => entry.version)).toEqual([2, 1]);
    expect(versions[0]!.hash).not.toBe(versions[1]!.hash);

    const diff = (await call(context, "GET", "/api/guard/profiles/support/diff?from=1&to=2", builder.cookie)).json<{ changes: Array<{ path: string; kind: string }> }>();
    expect(diff.changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: "channels.prompt.actions.email.action", kind: "changed" }), expect.objectContaining({ path: "name" })]));

    const exported = await call(context, "GET", "/api/guard/profiles/support/export?version=1", builder.cookie);
    expect(exported.headers["content-disposition"]).toContain("guard-profile-support-v1.json");
    expect(exported.headers["x-guard-profile-hash"]).toBe(versions[1]!.hash);
    const imported = await call(context, "POST", "/api/guard/profiles/import", builder.cookie, { text: exported.body });
    expect(imported.statusCode).toBe(200);
    expect(imported.json<{ created: boolean; profile: GuardProfileSummary }>()).toMatchObject({ created: false, profile: { latestVersion: 3, hash: versions[1]!.hash } });
    const fresh = await call(context, "POST", "/api/guard/profiles/import", builder.cookie, { text: exported.body.replace('"id": "support"', '"id": "support-copy"') });
    expect(fresh.statusCode).toBe(201);
  });
});

describe("bindings and resolution", () => {
  it("applies the built-in default automatically, and nothing when GUARD_AUTO_APPLY is off", async () => {
    const on = await createTestContext();
    const viewer = await login(on, "viewer");
    const effective = (await call(on, "GET", "/api/guard/effective?projectId=default", viewer.cookie)).json<{ effective: GuardResolutionView }>().effective;
    expect(effective.source).toBe("instance");
    expect(effective.stack.map((entry) => entry.profileId)).toEqual(["default"]);

    const off = await createTestContext({ GUARD_AUTO_APPLY: "false" });
    const offViewer = await login(off, "viewer");
    const none = (await call(off, "GET", "/api/guard/effective?projectId=default", offViewer.cookie)).json<{ effective: GuardResolutionView }>().effective;
    expect(none).toMatchObject({ source: "none", stack: [] });
  });

  it("keeps an enforced project profile first; builders can neither set, change nor remove it", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await call(context, "POST", "/api/guard/profiles", admin.cookie, { document: strictProfile("org-floor", "Org floor") });
    await call(context, "POST", "/api/guard/profiles", builder.cookie, { document: strictProfile("team", "Team") });
    context.store.upsertWorkflow(guardWorkflow("wf-bind"));

    expect((await call(context, "PUT", "/api/guard/bindings/projects/default", builder.cookie, { mode: "enforced", profileId: "org-floor" })).statusCode).toBe(403);
    const missing = await call(context, "PUT", "/api/guard/bindings/projects/default", admin.cookie, { mode: "enforced" });
    expect(missing.json<{ issues: Array<{ path: string }> }>().issues[0]!.path).toBe("profileId");
    const enforced = await call(context, "PUT", "/api/guard/bindings/projects/default", admin.cookie, { mode: "enforced", profileId: "org-floor" });
    expect(enforced.statusCode).toBe(200);
    expect(enforced.json<{ binding: { locked: boolean } }>().binding.locked).toBe(true);

    for (const body of [{ mode: "inherit" }, { mode: "override", profileId: "team" }]) {
      expect((await call(context, "PUT", "/api/guard/bindings/projects/default", builder.cookie, body)).statusCode).toBe(403);
    }
    expect((await call(context, "PUT", "/api/guard/bindings/workflows/wf-bind", builder.cookie, { mode: "enforced", profileId: "team" })).statusCode).toBe(400);
    expect((await call(context, "DELETE", "/api/guard/profiles/org-floor", admin.cookie)).statusCode).toBe(409);

    const override = await call(context, "PUT", "/api/guard/bindings/workflows/wf-bind", builder.cookie, { mode: "override", profileId: "team" });
    expect(override.statusCode).toBe(200);
    const effective = override.json<{ effective: GuardResolutionView }>().effective;
    expect(effective.source).toBe("enforced");
    expect(effective.stack.map((entry) => entry.profileId)).toEqual(["org-floor", "team"]);
    expect(effective.chain.map((level) => [level.level, level.mode, level.profileId])).toEqual([
      ["project", "enforced", "org-floor"],
      ["workflow", "override", "team"],
      ["instance", "auto", "default"]
    ]);

    const audit = context.store.listAuditLogs({ eventType: "guard.binding.updated" } as never) as unknown as { items: unknown[] };
    expect(audit.items.length).toBeGreaterThanOrEqual(2);
  });
});

describe("guard events and the token vault", () => {
  it("writes events with masked evidence only; raw secrets and PII never reach events, responses, audit logs or logs", async () => {
    const written: string[] = [];
    const capture = (chunk: unknown) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    };
    const originalWriteSync = fs.writeSync;
    vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => {
      capture(data);
      return (originalWriteSync as (...args: unknown[]) => number)(fd, data, ...rest);
    }) as typeof fs.writeSync);
    const stdout = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      capture(chunk);
      return (stdout as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write);

    const context = await createTestContext();
    const builder = await login(context, "builder");
    const admin = await login(context, "admin");
    context.store.upsertWorkflow(guardWorkflow("wf-events"));
    const run = (await call(context, "POST", "/api/workflows/wf-events/execute", builder.cookie, { user_prompt: `Use ${SECRET} to reach ${EMAIL}` })).json<RunResult>();
    expect(run.status).toBe("success");
    const guardOutput = run.nodeResults.find((entry) => entry.nodeId === "guard")!.output!;
    expect(guardOutput._branchHandle).toBe("pass");
    expect(guardOutput.user_prompt).toContain("[REDACTED:credential]");

    const events = (await call(context, "GET", `/api/executions/${run.executionId}/guard-events`, admin.cookie)).json<{ events: GuardEventView[] }>().events;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({ executionId: run.executionId, nodeId: "guard", placement: "node", channel: "prompt", profileId: "default", profileVersion: 1 });
    const credential = events.find((event) => event.dataClass === "credential")!;
    expect(credential).toMatchObject({ requestedAction: "redact", effectiveAction: "redact", shadow: false });
    expect(credential.evidence[0]!.evidence).toBeTruthy();
    expect(credential.evidence[0]!.spans[0]!.end).toBeGreaterThan(credential.evidence[0]!.spans[0]!.start);

    const listed = await call(context, "GET", "/api/guard/events?workflowId=wf-events", admin.cookie);
    const stats = await call(context, "GET", "/api/guard/stats?workflowId=wf-events", admin.cookie);
    expect(stats.json<{ stats: { verdicts: Array<{ key: string; count: number }> } }>().stats.verdicts).toEqual([{ key: "redact", count: 1 }]);
    const auditLogs = JSON.stringify(context.store.listAuditLogs({} as never));
    const rows = JSON.stringify((context.store as unknown as { queryAll: (sql: string) => unknown[] }).queryAll("SELECT * FROM guard_events"));
    for (const haystack of [JSON.stringify(events), listed.body, stats.body, auditLogs, rows, written.join("")]) {
      expect(haystack).not.toContain(SECRET);
      expect(haystack).not.toContain(EMAIL);
    }
    expect(written.join("")).toContain("guard-events");
  });

  it("persists deterministic vault tokens sealed with the master key, keyed through a secret reference", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const key = context.secretService.createSecret({ name: "vault key", provider: "custom", value: crypto.randomBytes(32).toString("base64") });
    const workflow = guardWorkflow(
      "wf-vault",
      { profileId: "default" },
      [{ id: "vault", type: "guard_protection", name: "Vault", position: { x: 200, y: 200 }, config: { providerId: "token_vault", dataClasses: ["email"], deterministic: true, keySecretRef: { secretId: key.secretId } } }],
      [{ id: "e4", source: "guard", sourceHandle: "protection", target: "vault" }]
    );
    context.store.upsertWorkflow(workflow);
    const first = (await call(context, "POST", "/api/workflows/wf-vault/execute", builder.cookie, { user_prompt: `Email ${EMAIL}` })).json<RunResult>();
    const token = /tok_email_\S+/.exec(String(first.nodeResults.find((entry) => entry.nodeId === "guard")!.output!.user_prompt))?.[0];
    expect(token).toBeTruthy();
    const second = (await call(context, "POST", "/api/workflows/wf-vault/execute", builder.cookie, { user_prompt: `Email ${EMAIL}` })).json<RunResult>();
    expect(String(second.nodeResults.find((entry) => entry.nodeId === "guard")!.output!.user_prompt)).toContain(token!);

    const rows = (context.store as unknown as { queryAll: (sql: string) => Array<Record<string, string>> }).queryAll("SELECT * FROM guard_token_vault");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(EMAIL);
    expect(rows[0]!.value_sealed.startsWith("v1.")).toBe(true);
    expect(context.secretService.openValue("guard-token-vault", rows[0]!.value_sealed)).toBe(EMAIL);
    // Bound to its purpose: the same sealed value does not open for another purpose.
    expect(() => context.secretService.openValue("something-else", rows[0]!.value_sealed)).toThrow();
    // A restart (a new service over the same store) still resolves the token.
    const restarted = new GuardService(context.store, context.secretService, { autoApply: true });
    expect((await restarted.vault.getByToken(token!))?.value).toBe(EMAIL);
    // The protection node carries a secret reference only; raw key material never appears in the stored workflow.
    const keyValue = (await context.secretService.resolveSecret(key))!;
    expect(keyValue.length).toBeGreaterThan(20);
    expect(JSON.stringify(context.store.getWorkflow("wf-vault"))).not.toContain(keyValue);
  });

  it("hands require_approval to the approvals queue and resumes to pass on approve", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const operator = await login(context, "operator");
    const document = strictProfile("approve-email");
    (document.channels as any).prompt.actions.email = { action: "require_approval" };
    expect((await call(context, "POST", "/api/guard/profiles", builder.cookie, { document })).statusCode).toBe(201);
    context.store.upsertWorkflow(guardWorkflow("wf-approve", { profileId: "approve-email", approvalMessage: "Check the address" }));
    const run = (await call(context, "POST", "/api/workflows/wf-approve/execute", builder.cookie, { user_prompt: `Write to ${EMAIL}` })).json<RunResult>();
    expect(run.status).toBe("waiting_approval");
    const approvals = (await call(context, "GET", "/api/approvals", operator.cookie)).json<{ items?: Array<{ id: string; approvalMessage?: string }> } | Array<{ id: string; approvalMessage?: string }>>();
    const items = Array.isArray(approvals) ? approvals : approvals.items ?? [];
    const pending = items.find((item) => item.id === run.executionId);
    expect(pending?.approvalMessage).toBe("Check the address");
    const approved = (await call(context, "POST", `/api/approvals/${run.executionId}/approve`, operator.cookie, {})).json<RunResult>();
    expect(approved.status).toBe("success");
    expect(approved.nodeResults.find((entry) => entry.nodeId === "pass")?.status).toBe("success");
    expect(approved.nodeResults.find((entry) => entry.nodeId === "blocked")?.status).toBe("skipped");
  });

  it("follows the execution-history retention", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    context.store.upsertWorkflow(guardWorkflow("wf-retention"));
    await call(context, "POST", "/api/workflows/wf-retention/execute", builder.cookie, { user_prompt: "hello" });
    const count = () => context.store.listGuardEvents({ workflowId: "wf-retention" }).total;
    expect(count()).toBe(1);
    context.store.pruneExecutionHistory({ before: new Date(Date.now() + 60_000).toISOString() });
    expect(count()).toBe(0);
  });
});
