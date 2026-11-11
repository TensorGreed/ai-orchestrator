/**
 * 13.2 — service accounts and scoped API keys, end to end: the admin routes, sign-in refusal on every path, role
 * ceilings (requireRole and project RBAC), legacy scopes, key-made-by-key narrowing, the audit trail, and a service
 * account outliving the admin who created it. Runs on SQLite, or on Postgres with TEST_STORE=postgres.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuditService } from "./services/audit-service.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { LdapService } from "./services/ldap-service.js";
import { MockOidcProvider } from "./test-support/mock-oidc-provider.js";
import { MockSamlIdp } from "./test-support/mock-saml-idp.js";
import { openTestStore } from "./test-support/test-store.js";

const WEB = "http://localhost:5173";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  saml: MockSamlIdp;
  tempDir: string;
}

const contexts: TestContext[] = [];

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

async function createContext(env: Record<string, string> = {}, options: { oidc?: MockOidcProvider } = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-service-accounts-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const saml = new MockSamlIdp("https://idp.example.test/saml/metadata");
  const config = parseConfig({
    LOG_LEVEL: "fatal",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git"),
    WEB_ORIGIN: WEB,
    SAML_ENABLED: "true",
    SAML_ENTRY_POINT: "https://idp.example.test/saml/sso",
    SAML_ISSUER: "l2m-sp",
    SAML_CALLBACK_URL: "http://localhost:4000/api/auth/saml/callback",
    SAML_IDP_CERT: "MIIC-test",
    ...(options.oidc
      ? { OIDC_ENABLED: "true", OIDC_ISSUER: options.oidc.issuer, OIDC_CLIENT_ID: options.oidc.clientId, ...(options.oidc.clientSecret ? { OIDC_CLIENT_SECRET: options.oidc.clientSecret } : {}) }
      : {}),
    ...env
  });
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), authService, undefined, undefined, undefined, {
    samlClientFactory: saml.factory,
    ...(options.oidc ? { oidcFetch: options.oidc.fetch } : {})
  });
  await app.ready();
  const context = { app, store, authService, config, saml, tempDir };
  contexts.push(context);
  return context;
}

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${name}: ${response.body}`);
  const raw = response.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [raw ?? ""]).find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`))!;
  return { cookie: cookie.split(";")[0]!, id: user.id };
}

const asCookie = (context: TestContext, cookie: string, method: string, url: string, payload?: unknown) =>
  context.app.inject({ method: method as "GET", url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

const asKey = (context: TestContext, key: string, method: string, url: string, payload?: unknown) =>
  context.app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${key}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function createAccount(context: TestContext, cookie: string, name: string, role: Role): Promise<{ id: string; email: string }> {
  const response = await asCookie(context, cookie, "POST", "/api/service-accounts", { name, role, description: `${name} robot` });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ serviceAccount: { id: string; email: string } }>().serviceAccount;
}

async function createKey(context: TestContext, cookie: string, accountId: string, body: Record<string, unknown> = {}): Promise<{ key: string; id: string; scopes: string[] }> {
  const response = await asCookie(context, cookie, "POST", `/api/service-accounts/${accountId}/keys`, { name: "ci", ...body });
  expect(response.statusCode, response.body).toBe(201);
  const created = response.json<{ key: string; record: { id: string; scopes: string[] } }>();
  return { key: created.key, id: created.record.id, scopes: created.record.scopes };
}

function workflow(id: string, projectId = "default"): Workflow {
  return {
    id,
    name: `Workflow ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: { responseTemplate: "done" } }
    ],
    edges: [{ id: "e1", source: "start", target: "out" }]
  };
}

const status = (response: LightMyRequestResponse) => response.statusCode;

describe("service accounts", () => {
  it("admins create, list, change and delete them; /api/users lists people unless asked for service accounts", async () => {
    const context = await createContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");

    const account = await createAccount(context, admin.cookie, "Deployer", "operator");
    // A random part no identity provider can name, so not even a build without service accounts links an SSO login to it.
    expect(account.email).toMatch(/^deployer\+[0-9a-f]{18}@service\.invalid$/);
    expect(status(await asCookie(context, admin.cookie, "POST", "/api/service-accounts", { name: "deployer", role: "viewer" }))).toBe(409);
    expect(status(await asCookie(context, admin.cookie, "POST", "/api/service-accounts", { name: "bad name!", role: "viewer" }))).toBe(400);

    const listed = (await asCookie(context, admin.cookie, "GET", "/api/service-accounts")).json<{ serviceAccounts: Array<Record<string, unknown>> }>();
    expect(listed.serviceAccounts).toEqual([
      expect.objectContaining({ id: account.id, name: "deployer", role: "operator", description: "Deployer robot", createdBy: admin.id, activeKeys: 0, projects: [] })
    ]);

    const people = (await asCookie(context, admin.cookie, "GET", "/api/users")).json<{ users: Array<{ id: string }> }>().users.map((u) => u.id);
    expect(people.sort()).toEqual([admin.id, builder.id].sort());
    const paged = (await asCookie(context, admin.cookie, "GET", "/api/users?page=1&pageSize=10")).json<{ items: unknown[]; total: number }>();
    expect(paged.total).toBe(2);
    const machines = (await asCookie(context, admin.cookie, "GET", "/api/users?kind=service")).json<{ users: Array<{ id: string }> }>().users.map((u) => u.id);
    expect(machines).toEqual([account.id]);

    // Project membership uses the project member routes, as for people.
    await context.store.upsertProject({ id: "ops", name: "ops" });
    expect(status(await asCookie(context, admin.cookie, "POST", "/api/projects/ops/members", { userId: account.id, role: "editor" }))).toBeLessThan(300);
    const withProject = (await asCookie(context, admin.cookie, "GET", "/api/service-accounts")).json<{ serviceAccounts: Array<{ projects: unknown[] }> }>();
    expect(withProject.serviceAccounts[0]!.projects).toEqual([{ projectId: "ops", role: "editor", customRoleId: null }]);

    const patched = await asCookie(context, admin.cookie, "PATCH", `/api/service-accounts/${account.id}`, { role: "builder", description: null });
    expect(patched.json<{ serviceAccount: { role: string; description: string | null } }>().serviceAccount).toMatchObject({ role: "builder", description: null });
    expect(status(await asCookie(context, admin.cookie, "PATCH", `/api/service-accounts/${account.id}`, {}))).toBe(400);
    // A person's id is not a service account.
    expect(status(await asCookie(context, admin.cookie, "PATCH", `/api/service-accounts/${builder.id}`, { role: "viewer" }))).toBe(404);
    expect(status(await asCookie(context, admin.cookie, "DELETE", `/api/service-accounts/${builder.id}`))).toBe(404);

    const key = await createKey(context, admin.cookie, account.id);
    expect((await asCookie(context, admin.cookie, "GET", `/api/service-accounts/${account.id}/keys`)).json<{ keys: Array<{ id: string }> }>().keys.map((k) => k.id)).toEqual([key.id]);
    expect(status(await asKey(context, key.key, "GET", "/api/workflows"))).toBe(200);

    // Builders cannot manage service accounts.
    for (const [method, url] of [["GET", "/api/service-accounts"], ["POST", "/api/service-accounts"], ["DELETE", `/api/service-accounts/${account.id}`]] as const) {
      expect(status(await asCookie(context, builder.cookie, method, url, method === "POST" ? { name: "x", role: "viewer" } : undefined))).toBe(403);
    }

    expect(status(await asCookie(context, admin.cookie, "DELETE", `/api/service-accounts/${account.id}/keys/${key.id}`))).toBe(200);
    expect(status(await asKey(context, key.key, "GET", "/api/workflows"))).toBe(401);
    expect(status(await asCookie(context, admin.cookie, "DELETE", `/api/service-accounts/${account.id}`))).toBe(200);
    expect(await context.store.getUserById(account.id)).toBeNull();
    expect(await context.store.listApiKeys(account.id)).toEqual([]);

    const events = (await context.store.listAuditLogs({ pageSize: 100 })).items.map((entry) => entry.eventType);
    for (const event of ["service_account.create", "service_account.update", "service_account.delete", "api_key.create", "api_key.revoke"]) {
      expect(events).toContain(event);
    }
    const keyAudit = (await context.store.listAuditLogs({ eventType: "api_key.create" })).items[0]!;
    expect(keyAudit.metadata).toMatchObject({ ownerKind: "service", serviceAccountId: account.id });
  });

  it("never signs in: password, SAML, sessions, registration and invites all refuse it", async () => {
    const context = await createContext({ AUTH_ALLOW_PUBLIC_REGISTER: "true" });
    const admin = await login(context, "admin");
    const account = await createAccount(context, admin.cookie, "robot", "admin");

    for (const password of ["!", "", "anything-at-all"]) {
      expect(status(await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: account.email, password } }))).not.toBe(200);
    }
    await expect(context.authService.verifyCredentials(account.email, "!")).rejects.toThrow("Invalid email or password");

    // SAML for the service account's email, and for a new email in the reserved domain: no session, no new user.
    for (const email of [account.email, "newbot@service.invalid"]) {
      const response = await context.app.inject({
        method: "POST",
        url: "/api/auth/saml/callback",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ SAMLResponse: context.saml.issue({ nameID: email, email }) }).toString()
      });
      const cookies = response.headers["set-cookie"];
      expect(JSON.stringify(cookies ?? "")).not.toContain(`${context.config.SESSION_COOKIE_NAME}=sess_`);
      expect(String(response.headers.location ?? "")).toContain("sso_error");
    }
    expect(await context.store.getUserByEmail("newbot@service.invalid")).toBeNull();

    // A session row naming a service account (none can be issued; this one is planted) is not honoured.
    const planted = await context.authService.sessions.issueSession({ user: { id: account.id }, method: "password" });
    expect(status(await context.app.inject({ method: "GET", url: "/api/auth/me", cookies: { [context.config.SESSION_COOKIE_NAME]: planted.sessionId } }))).toBe(401);

    // The reserved domain cannot be registered or invited.
    expect(status(await context.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "x@service.invalid", password: "Some-Pass-123!" } }))).toBe(400);
    expect(status(await asCookie(context, admin.cookie, "POST", "/api/users/invite", { email: "y@service.invalid", role: "viewer" }))).toBe(400);
    expect(status(await asCookie(context, admin.cookie, "POST", "/api/users/invite", { email: account.email, role: "viewer" }))).not.toBeLessThan(400);
  });

  it("keeps working after the admin who created it is deleted", async () => {
    const context = await createContext();
    const admin = await login(context, "admin");
    const other = await login(context, "admin", "other-admin");
    const account = await createAccount(context, other.cookie, "nightly", "builder");
    const key = await createKey(context, other.cookie, account.id);
    expect(status(await asCookie(context, admin.cookie, "DELETE", `/api/users/${other.id}`))).toBe(200);
    expect(status(await asKey(context, key.key, "POST", "/api/workflows", workflow("wf-nightly")))).toBe(200);
    const listed = (await asCookie(context, admin.cookie, "GET", "/api/service-accounts")).json<{ serviceAccounts: Array<{ createdBy: string }> }>();
    expect(listed.serviceAccounts[0]!.createdBy).toBe(other.id);
  });
});

describe("scoped API keys", () => {
  it("a role ceiling caps requireRole and project permissions; no scope keeps the owner's role", async () => {
    const context = await createContext();
    const admin = await login(context, "admin");
    const account = await createAccount(context, admin.cookie, "ops-bot", "admin");
    const full = await createKey(context, admin.cookie, account.id);
    const viewer = await createKey(context, admin.cookie, account.id, { role: "viewer" });
    const builder = await createKey(context, admin.cookie, account.id, { scopes: ["role:builder"] });
    expect(viewer.scopes).toEqual(["role:viewer"]);

    // No scope: the account's own role (admin).
    expect(status(await asKey(context, full.key, "GET", "/api/users"))).toBe(200);
    // Viewer ceiling: admin and builder routes are refused, reading works.
    expect(status(await asKey(context, viewer.key, "GET", "/api/users"))).toBe(403);
    expect(status(await asKey(context, viewer.key, "POST", "/api/workflows", workflow("wf-v")))).toBe(403);
    expect(status(await asKey(context, viewer.key, "GET", "/api/workflows"))).toBe(200);
    expect((await asKey(context, viewer.key, "GET", "/api/auth/me")).json<{ user: { role: string } }>().user.role).toBe("viewer");
    // Builder ceiling: builder routes work, admin routes do not.
    expect(status(await asKey(context, builder.key, "POST", "/api/workflows", workflow("wf-b")))).toBe(200);
    expect(status(await asKey(context, builder.key, "GET", "/api/users"))).toBe(403);

    // Lowering the account's role narrows every key, whatever its ceiling.
    expect(status(await asCookie(context, admin.cookie, "PATCH", `/api/service-accounts/${account.id}`, { role: "viewer" }))).toBe(200);
    expect(status(await asKey(context, builder.key, "POST", "/api/workflows", workflow("wf-b2")))).toBe(403);
    expect(status(await asKey(context, full.key, "GET", "/api/users"))).toBe(403);
  });

  it("refuses scopes the owner or the caller cannot grant, and unknown projects", async () => {
    const context = await createContext();
    const admin = await login(context, "admin");
    const builderUser = await login(context, "builder");
    const account = await createAccount(context, admin.cookie, "limited", "operator");
    const keyUrl = `/api/service-accounts/${account.id}/keys`;
    const refusal = async (body: Record<string, unknown>, url = keyUrl, cookie = admin.cookie) => {
      const response = await asCookie(context, cookie, "POST", url, { name: "k", ...body });
      return [response.statusCode, response.json<{ error: string }>().error] as const;
    };
    expect((await refusal({ role: "builder" }))[0]).toBe(403);
    expect((await refusal({ scopes: ["role:admin"] }))[0]).toBe(403);
    expect(await refusal({ projects: ["nope"] })).toEqual([400, "Unknown project 'nope'"]);
    expect((await refusal({ scopes: ["role:superuser"] }))[0]).toBe(400);
    expect((await refusal({ scopes: ["project:"] }))[0]).toBe(400);

    // Admin + project list is refused: admin is global.
    const adminAccount = await createAccount(context, admin.cookie, "root-bot", "admin");
    expect((await refusal({ role: "admin", projects: ["default"] }, `/api/service-accounts/${adminAccount.id}/keys`))[0]).toBe(400);

    // Personal keys: a builder cannot give its key an admin ceiling.
    expect((await refusal({ role: "admin" }, "/api/auth/api-keys", builderUser.cookie))[0]).toBe(403);
    const ok = await asCookie(context, builderUser.cookie, "POST", "/api/auth/api-keys", { name: "mine", role: "operator", projects: ["default"] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<{ record: { scopes: string[] } }>().record.scopes).toEqual(["role:operator", "project:default"]);
  });

  it("legacy free-form scopes are kept and enforce nothing, as before", async () => {
    const context = await createContext();
    const admin = await login(context, "admin");
    const created = await asCookie(context, admin.cookie, "POST", "/api/auth/api-keys", { name: "old", scopes: ["read", "deploy:prod"] });
    expect(created.statusCode, created.body).toBe(200);
    const { key, record } = created.json<{ key: string; record: { scopes: string[] } }>();
    expect(record.scopes).toEqual(["read", "deploy:prod"]);
    expect(status(await asKey(context, key, "GET", "/api/users"))).toBe(200);
    // A key stored before structured scopes existed (any strings, written directly) acts with its owner's role too.
    const legacy = await asCookie(context, admin.cookie, "POST", "/api/auth/api-keys", { name: "plain" });
    expect(status(await asKey(context, legacy.json<{ key: string }>().key, "GET", "/api/users"))).toBe(200);
  });

  it("a key made with a scoped key reaches no further than that key", async () => {
    const context = await createContext();
    const admin = await login(context, "admin");
    await context.store.upsertProject({ id: "alpha", name: "alpha" });
    const capped = (await asCookie(context, admin.cookie, "POST", "/api/auth/api-keys", { name: "capped", role: "builder" })).json<{ key: string }>().key;
    const child = await asKey(context, capped, "POST", "/api/auth/api-keys", { name: "child" });
    expect(child.statusCode, child.body).toBe(200);
    expect(child.json<{ record: { scopes: string[] } }>().record.scopes).toEqual(["role:builder"]);
    expect(status(await asKey(context, child.json<{ key: string }>().key, "GET", "/api/users"))).toBe(403);
    expect(status(await asKey(context, capped, "POST", "/api/auth/api-keys", { name: "up", role: "admin" }))).toBe(403);
  });

  it("a service account's own key cannot mint keys: only the admin route makes them", async () => {
    const context = await createContext();
    const admin = await login(context, "admin");
    const account = await createAccount(context, admin.cookie, "builder-bot", "builder");
    const key = await createKey(context, admin.cookie, account.id, { expiresInDays: 30 });
    const refused = await asKey(context, key.key, "POST", "/api/auth/api-keys", { name: "forever" });
    expect(refused.statusCode, refused.body).toBe(403);
    expect((await context.store.listApiKeys(account.id)).map((entry) => entry.id)).toEqual([key.id]);
    // An admin-ceiling key of an admin service account is refused the same way.
    const adminAccount = await createAccount(context, admin.cookie, "admin-bot", "admin");
    const adminKey = await createKey(context, admin.cookie, adminAccount.id, { role: "admin" });
    expect(status(await asKey(context, adminKey.key, "POST", "/api/auth/api-keys", { name: "more" }))).toBe(403);
  });

  it("a key made with another key ends no later than the calling key", async () => {
    const context = await createContext();
    const admin = await login(context, "admin");
    const parent = await asCookie(context, admin.cookie, "POST", "/api/auth/api-keys", { name: "parent", expiresInDays: 7 });
    expect(parent.statusCode, parent.body).toBe(200);
    const { key, record } = parent.json<{ key: string; record: { id: string; expiresAt: string } }>();
    const forever = await asKey(context, key, "POST", "/api/auth/api-keys", { name: "child" });
    expect(forever.statusCode, forever.body).toBe(200);
    expect(forever.json<{ record: { expiresAt: string | null } }>().record.expiresAt).toBe(record.expiresAt);
    const longer = await asKey(context, key, "POST", "/api/auth/api-keys", { name: "child-90", expiresInDays: 90 });
    expect(longer.json<{ record: { expiresAt: string | null } }>().record.expiresAt).toBe(record.expiresAt);
    const shorter = await asKey(context, key, "POST", "/api/auth/api-keys", { name: "child-1", expiresInDays: 1 });
    expect(Date.parse(shorter.json<{ record: { expiresAt: string } }>().record.expiresAt)).toBeLessThan(Date.parse(record.expiresAt));
    // A session has no calling key: the requested expiry stands.
    const fromSession = await asCookie(context, admin.cookie, "POST", "/api/auth/api-keys", { name: "session-made" });
    expect(fromSession.json<{ record: { expiresAt: string | null } }>().record.expiresAt).toBeNull();
    const audit = (await context.store.listAuditLogs({ eventType: "api_key.create" })).items.find((item) => (item.metadata as { name?: string }).name === "child");
    expect(audit?.metadata).toMatchObject({ createdWithApiKeyId: record.id });
  });

  it("audit entries made with a key record the key and whether a service account owns it", async () => {
    const context = await createContext();
    const admin = await login(context, "admin");
    const account = await createAccount(context, admin.cookie, "auditor", "builder");
    const key = await createKey(context, admin.cookie, account.id);
    expect(status(await asKey(context, key.key, "POST", "/api/workflows", workflow("wf-audited")))).toBe(200);
    const entry = (await context.store.listAuditLogs({ eventType: "workflow.create" })).items[0]!;
    expect(entry.actorType).toBe("api_key");
    expect(entry.actorUserId).toBe(account.id);
    expect(entry.metadata).toMatchObject({ actorApiKeyId: key.id, actorServiceAccount: true });

    const personal = (await asCookie(context, admin.cookie, "POST", "/api/auth/api-keys", { name: "mine" })).json<{ key: string; record: { id: string } }>();
    expect(status(await asKey(context, personal.key, "POST", "/api/workflows", workflow("wf-mine")))).toBe(200);
    const mine = (await context.store.listAuditLogs({ eventType: "workflow.create", actorUserId: admin.id })).items[0]!;
    expect(mine.metadata).toMatchObject({ actorApiKeyId: personal.record.id });
    expect(mine.metadata).not.toHaveProperty("actorServiceAccount");
  });

  it("an API-key run takes the production channel through the shared credential path", async () => {
    const context = await createContext();
    const admin = await login(context, "admin");
    const account = await createAccount(context, admin.cookie, "runner", "builder");
    const key = await createKey(context, admin.cookie, account.id);
    await context.store.upsertProject({ id: "ops", name: "ops" });
    await context.store.upsertCustomRole({ id: "run-only", projectId: "ops", name: "Run only", permissions: ["workflow:read", "workflow:execute"] });
    await context.store.upsertProjectRole({ userId: account.id, projectId: "ops", role: "custom", customRoleId: "run-only" });
    await context.store.upsertWorkflow(workflow("wf-run", "ops"));
    // The key is recognised as a key: the draft needs workflow:write, which this account lacks in ops.
    const draft = await asKey(context, key.key, "POST", "/api/workflows/wf-run/execute?channel=draft", {});
    expect(draft.statusCode, draft.body).toBe(403);
    expect(draft.json<{ error: string }>().error).toContain("channel=draft");
    const production = await asKey(context, key.key, "POST", "/api/workflows/wf-run/execute", {});
    expect(production.statusCode, production.body).toBe(200);
    // A signed-in person runs the draft without asking.
    expect(status(await asCookie(context, admin.cookie, "POST", "/api/workflows/wf-run/execute", {}))).toBe(200);
  });

  it("a scoped key cannot change its owner's account security: MFA needs a session or an unscoped key, and it revokes only itself", async () => {
    const context = await createContext();
    const admin = await login(context, "admin");
    const mint = async (body: Record<string, unknown>) => {
      const created = await asCookie(context, admin.cookie, "POST", "/api/auth/api-keys", { name: "k", ...body });
      expect(created.statusCode, created.body).toBe(200);
      return created.json<{ key: string; record: { id: string } }>();
    };
    const dashboard = await mint({ role: "viewer" });
    const projectKey = await mint({ projects: ["default"] });
    const other = await mint({});
    for (const scoped of [dashboard, projectKey]) {
      for (const url of ["/api/auth/mfa/enroll", "/api/auth/mfa/activate", "/api/auth/mfa/disable"]) {
        expect(status(await asKey(context, scoped.key, "POST", url, { code: "123456" })), url).toBe(403);
      }
      expect(status(await asKey(context, scoped.key, "DELETE", `/api/auth/api-keys/${other.record.id}`))).toBe(403);
    }
    expect((await context.store.listApiKeys(admin.id)).find((key) => key.id === other.record.id)?.revokedAt).toBeNull();
    // Nothing was enrolled by the refused calls.
    expect((await asCookie(context, admin.cookie, "GET", "/api/auth/mfa/status")).json<{ enabled: boolean }>().enabled).toBe(false);
    // A role-ceiling key may still make a key no wider than itself (POST /api/auth/api-keys inherits its ceiling) and revoke itself.
    expect(status(await asKey(context, dashboard.key, "POST", "/api/auth/api-keys", { name: "child" }))).not.toBe(200);
    expect(status(await asKey(context, dashboard.key, "DELETE", `/api/auth/api-keys/${dashboard.record.id}`))).toBe(200);
    expect(status(await asKey(context, dashboard.key, "GET", "/api/auth/me"))).toBe(401);
    // An unscoped key passes this gate, but setting up an authenticator needs a signed-in session (400 for any key).
    expect(status(await asKey(context, other.key, "POST", "/api/auth/mfa/enroll"))).toBe(400);
    expect(status(await asCookie(context, admin.cookie, "DELETE", `/api/auth/api-keys/${projectKey.record.id}`))).toBe(200);
  });

  it("demoting the owner lowers every key at once, and restoring the role restores it", async () => {
    const context = await createContext();
    const admin = await login(context, "admin");
    const account = await createAccount(context, admin.cookie, "demoted", "builder");
    const capped = await createKey(context, admin.cookie, account.id, { role: "builder" });
    expect(status(await asKey(context, capped.key, "POST", "/api/workflows", workflow("wf-before")))).toBe(200);
    expect(status(await asCookie(context, admin.cookie, "PATCH", `/api/service-accounts/${account.id}`, { role: "viewer" }))).toBe(200);
    expect(status(await asKey(context, capped.key, "POST", "/api/workflows", workflow("wf-during")))).toBe(403);
    expect(status(await asKey(context, capped.key, "GET", "/api/workflows"))).toBe(200);
    expect(status(await asCookie(context, admin.cookie, "PATCH", `/api/service-accounts/${account.id}`, { role: "builder" }))).toBe(200);
    expect(status(await asKey(context, capped.key, "POST", "/api/workflows", workflow("wf-after")))).toBe(200);
  });

  it("OIDC and LDAP sign-in refuse it too", async () => {
    const oidc = await MockOidcProvider.create({ clientSecret: "oidc-secret" });
    const context = await createContext({}, { oidc });
    const admin = await login(context, "admin");
    const account = await createAccount(context, admin.cookie, "sso-bot", "admin");

    oidc.user = { sub: "idp-sso-bot", email: account.email, email_verified: true, name: "Bot", groups: [] };
    const start = await context.app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(start.statusCode).toBe(302);
    const flowCookie = (Array.isArray(start.headers["set-cookie"]) ? start.headers["set-cookie"] : [start.headers["set-cookie"] ?? ""])
      .find((value) => value.startsWith("l2m_oidc_flow="))!.split(";")[0]!.slice("l2m_oidc_flow=".length);
    const callback = new URL(oidc.authorize(String(start.headers.location)));
    const finish = await context.app.inject({ method: "GET", url: `${callback.pathname}${callback.search}`, cookies: { l2m_oidc_flow: flowCookie } });
    expect(JSON.stringify(finish.headers["set-cookie"] ?? "")).not.toContain(`${context.config.SESSION_COOKIE_NAME}=sess_`);
    expect(String(finish.headers.location ?? "")).toContain("sso_error");

    const ldap = vi.spyOn(LdapService.prototype, "authenticate").mockResolvedValue({ dn: "cn=sso-bot", email: account.email, groups: [], attributes: {} });
    try {
      const response = await context.app.inject({ method: "POST", url: "/api/auth/ldap/login", payload: { email: account.email, password: "whatever" } });
      expect(response.statusCode).toBe(401);
      expect(JSON.stringify(response.headers["set-cookie"] ?? "")).not.toContain(`${context.config.SESSION_COOKIE_NAME}=sess_`);
    } finally {
      ldap.mockRestore();
    }
    expect(await context.store.listUserSessions(account.id)).toEqual([]);
  });

  it("deleting it removes its own MCP OAuth connections, as deleting a person does", async () => {
    const context = await createContext();
    const admin = await login(context, "admin");
    const account = await createAccount(context, admin.cookie, "oauth-bot", "builder");
    await context.store.upsertMcpUserOAuthConnection({
      serverId: "srv-oauth", userId: account.id, secretId: null, state: "connected", subject: null, scope: null, authorizationServer: null,
      clientRegistration: null, clientId: null, expiresAt: null, hasRefreshToken: false, lastRefreshAt: null, connectedAt: new Date().toISOString(), lastError: null
    });
    expect(await context.store.listMcpUserOAuthConnections({ userId: account.id })).toHaveLength(1);
    expect(status(await asCookie(context, admin.cookie, "DELETE", `/api/service-accounts/${account.id}`))).toBe(200);
    expect(await context.store.listMcpUserOAuthConnections({ userId: account.id })).toEqual([]);
  });

  it("audit keeps the key id when an event's metadata is not an object", async () => {
    const context = await createContext();
    const audit = new AuditService(context.store);
    const actor = { userId: "u-1", email: "u@x", type: "api_key" as const, apiKeyId: "key-1", serviceAccount: true };
    const stored = async (eventType: string) => (await context.store.listAuditLogs({ eventType })).items[0]!.metadata;
    await audit.record({ eventType: "test.text", category: "auth", action: "x", actor, metadata: "plain note" as unknown as Record<string, unknown> });
    expect(await stored("test.text")).toEqual({ value: "plain note", actorApiKeyId: "key-1", actorServiceAccount: true });
    await audit.record({ eventType: "test.list", category: "auth", action: "x", actor, metadata: ["a", "b"] as unknown as Record<string, unknown> });
    expect(await stored("test.list")).toEqual({ value: ["a", "b"], actorApiKeyId: "key-1", actorServiceAccount: true });
    // The event cannot spoof the key fields.
    await audit.record({ eventType: "test.spoof", category: "auth", action: "x", actor, metadata: { actorApiKeyId: "forged" } });
    expect(await stored("test.spoof")).toMatchObject({ actorApiKeyId: "key-1" });
  });
});
