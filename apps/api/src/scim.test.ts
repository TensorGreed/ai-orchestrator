/**
 * 13.2 — SCIM 2.0 provisioning end to end: off by default, the SCIM token (admin-made, hashed, rotated, revoked,
 * accepted nowhere else), Users and Groups with the PATCH shapes identity providers send, deactivation and
 * deprovisioning ending sessions and revoking API keys at once (break-glass untouched, the last admin kept), and group
 * mappings granting and taking back roles. Runs on SQLite, or on Postgres with TEST_STORE=postgres.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";

const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
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

async function createContext(env: Record<string, string> = { SCIM_ENABLED: "true" }): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-scim-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "fatal",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git"),
    ...env
  });
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), authService);
  await app.ready();
  const context = { app, store, authService, config, tempDir };
  contexts.push(context);
  return context;
}

type Role = "admin" | "builder" | "operator" | "viewer";

async function signIn(context: TestContext, email: string, password: string): Promise<{ status: number; cookie: string }> {
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [raw ?? ""]).find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`)) ?? "";
  return { status: response.statusCode, cookie: cookie.split(";")[0] ?? "" };
}

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string; email: string; password: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = await context.authService.register({ email, password, role });
  const signedIn = await signIn(context, email, password);
  if (signedIn.status !== 200) throw new Error(`Login failed for ${name}`);
  return { cookie: signedIn.cookie, id: user.id, email, password };
}

const asCookie = (context: TestContext, cookie: string, method: string, url: string, payload?: unknown) =>
  context.app.inject({ method: method as "GET", url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function scimToken(context: TestContext, adminCookie: string): Promise<string> {
  const response = await asCookie(context, adminCookie, "POST", "/api/scim/tokens", { name: "idp" });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ token: string }>().token;
}

function scim(context: TestContext, token: string) {
  return (method: string, url: string, payload?: unknown, contentType = "application/scim+json") =>
    context.app.inject({
      method: method as "GET",
      url: `/scim/v2${url}`,
      headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { "content-type": contentType } : {}) },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {})
    });
}

async function setup(env?: Record<string, string>) {
  const context = await createContext(env);
  const admin = await login(context, "admin");
  const token = await scimToken(context, admin.cookie);
  return { context, admin, token, call: scim(context, token) };
}

const userBody = (userName: string, extra: Record<string, unknown> = {}) => ({
  schemas: [USER_SCHEMA],
  userName,
  name: { givenName: "Test", familyName: "User" },
  emails: [{ value: userName, type: "work", primary: true }],
  active: true,
  ...extra
});

describe("SCIM provisioning", () => {
  it("is off by default: no /scim routes, while admins can still prepare a token", async () => {
    const context = await createContext({});
    const admin = await login(context, "admin");
    const token = await scimToken(context, admin.cookie);
    const response = await context.app.inject({ method: "GET", url: "/scim/v2/Users", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(404);
    const settings = await asCookie(context, admin.cookie, "GET", "/api/scim");
    expect(settings.json()).toMatchObject({ enabled: false, baseUrl: "/scim/v2", provisionedUsers: 0 });
  });

  it("authenticates only with a live SCIM token, and the token reaches nothing else", async () => {
    const { context, admin, token, call } = await setup();
    // No token, a malformed one, a wrong secret.
    const none = await context.app.inject({ method: "GET", url: "/scim/v2/Users" });
    expect(none.statusCode).toBe(401);
    expect(none.headers["content-type"]).toContain("application/scim+json");
    expect(none.json()).toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401" });
    expect(none.headers["www-authenticate"]).toContain("Bearer");
    const wrong = `${token.slice(0, token.indexOf(".") + 1)}${"A".repeat(43)}`;
    expect((await scim(context, wrong)("GET", "/Users")).statusCode).toBe(401);
    // A session or an API key is not a SCIM credential.
    expect((await context.app.inject({ method: "GET", url: "/scim/v2/Users", headers: { cookie: admin.cookie } })).statusCode).toBe(401);
    const key = await asCookie(context, admin.cookie, "POST", "/api/auth/api-keys", { name: "mine" });
    expect((await scim(context, key.json<{ key: string }>().key)("GET", "/Users")).statusCode).toBe(401);
    // A SCIM token is not an API credential.
    expect((await context.app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    expect((await call("GET", "/ServiceProviderConfig")).json()).toMatchObject({ patch: { supported: true }, bulk: { supported: false } });
    expect((await call("GET", "/ResourceTypes")).json()).toMatchObject({ totalResults: 2 });
    expect((await call("GET", `/Schemas/${USER_SCHEMA}`)).json()).toMatchObject({ id: USER_SCHEMA });
    // Refusals are audited (sampled).
    const audits = await context.store.listAuditLogs({ eventType: "scim.auth_failed" });
    expect(audits.total).toBeGreaterThan(0);
    // The stored token is a hash: the secret appears nowhere in the table.
    const [stored] = await context.store.listScimTokens();
    expect(JSON.stringify(stored)).not.toContain(token.split(".")[1]);
  });

  it("rotates with a grace window and revokes a token (audited, step-up action)", async () => {
    const { context, admin, token, call } = await setup();
    const [record] = (await asCookie(context, admin.cookie, "GET", "/api/scim")).json<{ tokens: Array<{ id: string }> }>().tokens;
    const rotated = await asCookie(context, admin.cookie, "POST", `/api/scim/tokens/${record!.id}/rotate`, { graceHours: 0 });
    expect(rotated.statusCode, rotated.body).toBe(200);
    const next = rotated.json<{ token: string; record: { id: string } }>();
    expect((await call("GET", "/Users")).statusCode).toBe(401);
    expect((await scim(context, next.token)("GET", "/Users")).statusCode).toBe(200);
    // A second rotation of the old token is refused.
    expect((await asCookie(context, admin.cookie, "POST", `/api/scim/tokens/${record!.id}/rotate`, {})).statusCode).toBe(409);
    expect((await asCookie(context, admin.cookie, "DELETE", `/api/scim/tokens/${next.record.id}`)).statusCode).toBe(200);
    expect((await scim(context, next.token)("GET", "/Users")).statusCode).toBe(401);
    for (const eventType of ["scim_token.create", "scim_token.rotate", "scim_token.revoke"]) {
      expect((await context.store.listAuditLogs({ eventType })).total, eventType).toBe(1);
    }
    // Only admins manage tokens.
    const builder = await login(context, "builder");
    expect((await asCookie(context, builder.cookie, "POST", "/api/scim/tokens", { name: "x" })).statusCode).toBe(403);
    void token;
  });

  it("creates, reads, filters, pages, replaces and patches users", async () => {
    const { context, call } = await setup();
    const created = await call("POST", "/Users", userBody("ada@example.com", { externalId: "ext-ada" }));
    expect(created.statusCode, created.body).toBe(201);
    expect(created.headers["content-type"]).toContain("application/scim+json");
    const ada = created.json<{ id: string; active: boolean; meta: { location: string } }>();
    expect(created.headers.location).toBe(`/scim/v2/Users/${ada.id}`);
    expect(ada).toMatchObject({ schemas: [USER_SCHEMA], userName: "ada@example.com", active: true, externalId: "ext-ada", emails: [{ value: "ada@example.com", primary: true }] });
    // The account exists as a viewer that cannot sign in with a password.
    expect((await context.store.getUserByEmail("ada@example.com"))?.role).toBe("viewer");
    // Duplicate userName (case-insensitive).
    const duplicate = await call("POST", "/Users", userBody("ADA@example.com"));
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ scimType: "uniqueness" });
    // application/json works too.
    expect((await call("POST", "/Users", userBody("bob@example.com"), "application/json")).statusCode).toBe(201);
    await call("POST", "/Users", userBody("cy@example.com"));

    const byName = (await call("GET", `/Users?filter=${encodeURIComponent('userName eq "Ada@Example.com"')}`)).json<{ totalResults: number; Resources: Array<{ id: string }> }>();
    expect(byName.totalResults).toBe(1);
    expect(byName.Resources[0]!.id).toBe(ada.id);
    expect((await call("GET", `/Users?filter=${encodeURIComponent('externalId eq "ext-ada"')}`)).json()).toMatchObject({ totalResults: 1 });
    expect((await call("GET", `/Users?filter=${encodeURIComponent('userName eq "nobody"')}`)).json()).toMatchObject({ totalResults: 0, Resources: [] });
    expect((await call("GET", `/Users?filter=${encodeURIComponent('title eq "x"')}`)).json()).toMatchObject({ status: "400", scimType: "invalidFilter" });
    const page = (await call("GET", "/Users?startIndex=2&count=1")).json<{ totalResults: number; startIndex: number; itemsPerPage: number }>();
    expect(page).toMatchObject({ totalResults: 3, startIndex: 2, itemsPerPage: 1 });

    const put = await call("PUT", `/Users/${ada.id}`, userBody("ada.l@example.com", { name: { givenName: "Ada", familyName: "King" } }));
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ userName: "ada.l@example.com", name: { familyName: "King" }, emails: [{ value: "ada.l@example.com" }] });
    // SCIM made this account, so its email follows.
    expect((await context.store.getUserById(ada.id))?.email).toBe("ada.l@example.com");

    const patched = await call("PATCH", `/Users/${ada.id}`, {
      schemas: [PATCH],
      Operations: [{ op: "Replace", value: { "name.givenName": "Augusta", displayName: "Augusta Ada" } }]
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ displayName: "Augusta Ada", name: { givenName: "Augusta" } });
    expect((await call("GET", "/Users/usr_missing")).statusCode).toBe(404);
    expect((await call("PATCH", `/Users/${ada.id}`, { schemas: [PATCH], Operations: [{ op: "jump", value: {} }] })).json()).toMatchObject({ scimType: "invalidSyntax" });
    const audits = await context.store.listAuditLogs({ eventType: "scim.user.create" });
    expect(audits.total).toBe(3);
    expect(audits.items[0]!.actorEmail).toBe("scim:idp");
  });

  it("deactivation ends sessions and revokes API keys at once; reactivation lets the user sign in again", async () => {
    const { context, call } = await setup();
    const person = await login(context, "builder", "olga");
    const key = (await asCookie(context, person.cookie, "POST", "/api/auth/api-keys", { name: "cli" })).json<{ key: string }>().key;
    const asKey = () => context.app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${key}` } });
    expect((await asKey()).statusCode).toBe(200);
    // A break-glass session (the recovery path) is left alone.
    const breakGlass = await context.authService.sessions.issueSession({ user: { id: person.id, role: "builder" }, method: "break_glass" });

    // The provider links the existing account (adopted) and then deactivates it.
    const created = await call("POST", "/Users", userBody(person.email));
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ id: string }>().id;
    expect(id).toBe(person.id);
    const deactivated = await call("PATCH", `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: "False" }] });
    expect(deactivated.statusCode, deactivated.body).toBe(200);
    expect(deactivated.json()).toMatchObject({ active: false });

    expect((await asCookie(context, person.cookie, "GET", "/api/auth/me")).statusCode).toBe(401);
    expect((await asKey()).statusCode).toBe(401);
    expect((await context.store.listApiKeys(person.id)).every((entry) => entry.revokedAt)).toBe(true);
    expect((await signIn(context, person.email, person.password)).status).toBe(401);
    expect((await context.store.getSession(breakGlass.sessionId))?.revokedAt).toBeNull();
    expect((await context.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `${context.config.SESSION_COOKIE_NAME}=${breakGlass.sessionId}` } })).statusCode).toBe(200);
    const audit = await context.store.listAuditLogs({ eventType: "scim.user.deactivate" });
    expect(audit.items[0]!.metadata).toMatchObject({ sessionsEnded: 1, keysRevoked: 1 });

    // Admins see it disabled.
    const admin = await signIn(context, "admin@example.com", "admin-Pass-123!");
    const users = (await asCookie(context, admin.cookie, "GET", "/api/users")).json<{ users: Array<{ id: string; disabledAt?: string }> }>().users;
    expect(users.find((entry) => entry.id === person.id)?.disabledAt).toBeTruthy();

    // Back on: the password works again; the revoked key stays revoked; an adopted account keeps its email.
    const reactivated = await call("PUT", `/Users/${id}`, userBody("renamed@example.com"));
    expect(reactivated.json()).toMatchObject({ active: true, userName: "renamed@example.com", emails: [{ value: person.email }] });
    expect((await signIn(context, person.email, person.password)).status).toBe(200);
    expect((await asKey()).statusCode).toBe(401);
  });

  it("deprovisioning (DELETE) disables the account, keeps it and its history, and the SCIM user is gone", async () => {
    const { context, call } = await setup();
    const created = (await call("POST", "/Users", userBody("dan@example.com"))).json<{ id: string }>();
    const deleted = await call("DELETE", `/Users/${created.id}`);
    expect(deleted.statusCode).toBe(204);
    expect((await call("GET", `/Users/${created.id}`)).statusCode).toBe(404);
    const account = await context.store.getUserById(created.id);
    expect(account?.disabledAt).toBeTruthy();
    expect((await context.store.listAuditLogs({ eventType: "scim.user.deprovision" })).total).toBe(1);
    // The provider may create the user again: the same account comes back enabled.
    const again = await call("POST", "/Users", userBody("dan@example.com"));
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json()).toMatchObject({ id: created.id, active: true });
  });

  it("links admins only when SCIM_LINK_EXISTING_USERS allows it, and nobody with none", async () => {
    const { context, admin, call } = await setup();
    const refused = await call("POST", "/Users", userBody(admin.email, { active: false }));
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ scimType: "uniqueness" });
    expect((await context.store.getUserById(admin.id))?.disabledAt ?? null).toBeNull();
    expect(await context.store.getScimUser(admin.id)).toBeNull();

    const none = await setup({ SCIM_ENABLED: "true", SCIM_LINK_EXISTING_USERS: "none" });
    const person = await login(none.context, "builder", "nina");
    expect((await none.call("POST", "/Users", userBody(person.email))).statusCode).toBe(409);
    expect((await none.call("POST", "/Users", userBody("fresh@example.com"))).statusCode).toBe(201);
  });

  it("never disables the only enabled admin; break-glass is the way back otherwise", async () => {
    const { context, admin, call } = await setup({ SCIM_ENABLED: "true", SCIM_LINK_EXISTING_USERS: "all" });
    // Refused as the only enabled admin: nothing is linked or disabled.
    const refusedCreate = await call("POST", "/Users", userBody(admin.email, { active: false }));
    expect(refusedCreate.statusCode).toBe(400);
    expect(await context.store.getScimUser(admin.id)).toBeNull();
    const linked = await call("POST", "/Users", userBody(admin.email));
    expect(linked.statusCode).toBe(201);
    const refused = await call("PATCH", `/Users/${admin.id}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ scimType: "mutability" });
    expect((await call("DELETE", `/Users/${admin.id}`)).statusCode).toBe(400);
    expect((await context.store.getUserById(admin.id))?.disabledAt ?? null).toBeNull();
    // With a second admin, the first can be disabled; a break-glass session for it still issues.
    await context.authService.register({ email: "second@example.com", password: "second-Pass-123!", role: "admin" });
    expect((await call("PATCH", `/Users/${admin.id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: false }] })).statusCode).toBe(200);
    const glass = await context.authService.sessions.issueSession({ user: { id: admin.id, role: "admin" }, method: "break_glass" });
    expect(glass.sessionId).toBeTruthy();
    await expect(context.authService.sessions.issueSession({ user: { id: admin.id, role: "admin" }, method: "password" })).rejects.toThrow("disabled");
    // The second admin is now the last enabled one: a user delete of it is refused as before.
    const second = await context.store.getUserByEmail("second@example.com");
    const glassCookie = `${context.config.SESSION_COOKIE_NAME}=${glass.sessionId}`;
    expect((await asCookie(context, glassCookie, "DELETE", `/api/users/${second!.id}`)).statusCode).toBe(409);
    // An admin enables the disabled one again (audited).
    expect((await asCookie(context, glassCookie, "POST", `/api/users/${admin.id}/enable`)).json()).toMatchObject({ enabled: true });
    expect((await context.store.listAuditLogs({ eventType: "user.enable" })).total).toBe(1);
  });

  it("keeps groups and members, and maps groups to roles (and takes them back)", async () => {
    const { context, admin, call } = await setup();
    await context.store.upsertProject({ id: "proj_eng", name: "Eng" });
    const ada = (await call("POST", "/Users", userBody("ada@example.com"))).json<{ id: string }>().id;
    const bob = (await call("POST", "/Users", userBody("bob@example.com"))).json<{ id: string }>().id;

    // Mapped by display name: project editor; by externalId: global builder. An unmapped group grants nothing.
    for (const mapping of [
      { provider: "scim", groupName: "Engineering", projectId: "proj_eng", role: "editor" },
      { provider: "scim", groupName: "ext-builders", role: "builder" }
    ]) {
      expect((await asCookie(context, admin.cookie, "POST", "/api/auth/sso/mappings", mapping)).statusCode).toBe(200);
    }
    const eng = await call("POST", "/Groups", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Engineering", members: [{ value: ada }] });
    expect(eng.statusCode, eng.body).toBe(201);
    const engId = eng.json<{ id: string; members: Array<{ value: string }> }>().id;
    expect(eng.json()).toMatchObject({ displayName: "Engineering", members: [{ value: ada, display: "ada@example.com" }] });
    expect((await context.store.getProjectRole(ada, "proj_eng"))?.role).toBe("editor");

    const builders = (await call("POST", "/Groups", { displayName: "Builders", externalId: "ext-builders", members: [] })).json<{ id: string }>().id;
    const misc = (await call("POST", "/Groups", { displayName: "Misc", members: [{ value: bob }] })).json<{ id: string }>().id;
    expect((await context.store.getUserById(bob))?.role).toBe("viewer");
    expect(await context.store.getProjectRole(bob, "proj_eng")).toBeNull();

    // PATCH add (no members in the answer unless asked) and the user resource lists its groups.
    const added = await call("PATCH", `/Groups/${builders}`, { schemas: [PATCH], Operations: [{ op: "Add", path: "members", value: [{ value: bob }, { value: "usr_unknown" }] }] });
    expect(added.statusCode).toBe(204);
    expect((await context.store.getUserById(bob))?.role).toBe("builder");
    expect((await call("GET", `/Users/${bob}`)).json<{ groups: Array<{ display: string }> }>().groups.map((group) => group.display).sort()).toEqual(["Builders", "Misc"]);
    expect((await call("GET", `/Groups?filter=${encodeURIComponent('displayName eq "builders"')}&excludedAttributes=members`)).json()).toMatchObject({
      totalResults: 1,
      Resources: [{ id: builders, displayName: "Builders" }]
    });
    expect((await call("GET", `/Groups/${builders}?excludedAttributes=members`)).json()).not.toHaveProperty("members");

    // An admin changed Ada's project role by hand: SCIM leaves it when she leaves the group.
    const removedBob = await call("PATCH", `/Groups/${builders}`, { schemas: [PATCH], Operations: [{ op: "remove", path: `members[value eq "${bob}"]` }] });
    expect(removedBob.statusCode).toBe(204);
    expect((await context.store.getUserById(bob))?.role).toBe("viewer");
    await context.store.upsertProjectRole({ userId: ada, projectId: "proj_eng", role: "project_admin" });
    await call("PATCH", `/Groups/${engId}`, { schemas: [PATCH], Operations: [{ op: "Remove", path: "members", value: [{ value: ada }] }] });
    expect((await context.store.getProjectRole(ada, "proj_eng"))?.role).toBe("project_admin");

    // Back in the group, then the mapping is deleted: the role SCIM set is taken back at once.
    await context.store.removeProjectRole(ada, "proj_eng");
    await call("PUT", `/Groups/${engId}`, { displayName: "Engineering", members: [{ value: ada }] });
    expect((await context.store.getProjectRole(ada, "proj_eng"))?.role).toBe("editor");
    const mappings = (await asCookie(context, admin.cookie, "GET", "/api/auth/sso/mappings?provider=scim")).json<{ mappings: Array<{ id: string; groupName: string }> }>().mappings;
    const engMapping = mappings.find((mapping) => mapping.groupName === "Engineering")!;
    const groupsView = (await asCookie(context, admin.cookie, "GET", "/api/scim/groups")).json<{ groups: Array<{ id: string; memberCount: number; mappingIds: string[] }> }>().groups;
    expect(groupsView.find((group) => group.id === engId)).toMatchObject({ memberCount: 1, mappingIds: [engMapping.id] });
    expect(groupsView.find((group) => group.id === misc)).toMatchObject({ mappingIds: [] });
    expect((await asCookie(context, admin.cookie, "DELETE", `/api/auth/sso/mappings/${engMapping.id}`)).statusCode).toBe(200);
    expect(await context.store.getProjectRole(ada, "proj_eng")).toBeNull();

    // A renamed group is matched again; deleting a group takes back what it granted.
    await asCookie(context, admin.cookie, "POST", "/api/auth/sso/mappings", { provider: "scim", groupName: "Release managers", role: "operator" });
    await call("PATCH", `/Groups/${misc}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { id: misc, displayName: "Release managers" } }] });
    expect((await context.store.getUserById(bob))?.role).toBe("operator");
    expect((await call("DELETE", `/Groups/${misc}`)).statusCode).toBe(204);
    expect((await context.store.getUserById(bob))?.role).toBe("viewer");
    expect((await call("GET", `/Groups/${misc}`)).statusCode).toBe(404);
    expect((await context.store.listAuditLogs({ eventType: "scim.user.roles_synced" })).total).toBeGreaterThan(0);

    // Group display names are unique (case-insensitive).
    expect((await call("POST", "/Groups", { displayName: "engineering" })).json()).toMatchObject({ status: "409", scimType: "uniqueness" });
  });

  it("deprovisioning takes back the roles a user's groups granted", async () => {
    const { context, admin, call } = await setup();
    await asCookie(context, admin.cookie, "POST", "/api/auth/sso/mappings", { provider: "scim", groupName: "Ops", role: "operator" });
    const eve = (await call("POST", "/Users", userBody("eve@example.com"))).json<{ id: string }>().id;
    const ops = (await call("POST", "/Groups", { displayName: "Ops", members: [{ value: eve }] })).json<{ id: string }>().id;
    expect((await context.store.getUserById(eve))?.role).toBe("operator");
    await call("DELETE", `/Users/${eve}`);
    expect((await context.store.getUserById(eve))).toMatchObject({ role: "viewer" });
    expect((await call("GET", `/Groups/${ops}`)).json()).toMatchObject({ members: [] });
  });

  it("never lowers a role it did not set, and never raises again a role an admin lowered", async () => {
    const { context, admin, call } = await setup();
    for (const mapping of [
      { provider: "scim", groupName: "Everyone", role: "viewer" },
      { provider: "scim", groupName: "Admins", role: "admin" }
    ]) {
      await asCookie(context, admin.cookie, "POST", "/api/auth/sso/mappings", mapping);
    }
    // An adopted builder in an "everyone is a viewer" group keeps builder.
    const builder = await login(context, "builder", "bea");
    expect((await call("POST", "/Users", userBody(builder.email))).statusCode).toBe(201);
    await call("POST", "/Groups", { displayName: "Everyone", members: [{ value: builder.id }] });
    expect((await context.store.getUserById(builder.id))?.role).toBe("builder");

    // SCIM raises Al to admin; an admin lowers him by hand; group and mapping changes do not raise him again.
    const al = (await call("POST", "/Users", userBody("al@example.com"))).json<{ id: string }>().id;
    const admins = (await call("POST", "/Groups", { displayName: "Admins", members: [{ value: al }] })).json<{ id: string }>().id;
    expect((await context.store.getUserById(al))?.role).toBe("admin");
    expect((await asCookie(context, admin.cookie, "PUT", `/api/users/${al}`, { role: "viewer" })).statusCode).toBe(200);
    await call("PATCH", `/Users/${al}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "displayName", value: "Al" }] });
    await call("PATCH", `/Groups/${admins}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { displayName: "Admins" } }] });
    await asCookie(context, admin.cookie, "POST", "/api/auth/sso/mappings", { provider: "scim", groupName: "Unused", role: "operator" });
    expect((await context.store.getUserById(al))?.role).toBe("viewer");

    // Raised from builder, the earlier role comes back when the group no longer grants it.
    await call("PATCH", `/Groups/${admins}`, { schemas: [PATCH], Operations: [{ op: "add", path: "members", value: [{ value: builder.id }] }] });
    expect((await context.store.getUserById(builder.id))?.role).toBe("admin");
    await call("PATCH", `/Groups/${admins}`, { schemas: [PATCH], Operations: [{ op: "remove", path: `members[value eq "${builder.id}"]` }] });
    expect((await context.store.getUserById(builder.id))?.role).toBe("builder");
  });

  it("a refused update changes nothing, and an email change keeps the role", async () => {
    const { context, admin, call } = await setup();
    const one = (await call("POST", "/Users", userBody("one@example.com"))).json<{ id: string }>().id;
    await call("POST", "/Users", userBody("two@example.com"));
    // userName taken: the deactivation in the same PUT does not happen.
    const clash = await call("PUT", `/Users/${one}`, userBody("two@example.com", { active: false }));
    expect(clash.statusCode).toBe(409);
    expect((await context.store.getUserById(one))?.disabledAt ?? null).toBeNull();
    await asCookie(context, admin.cookie, "PUT", `/api/users/${one}`, { role: "operator" });
    const moved = await call("PUT", `/Users/${one}`, userBody("uno@example.com"));
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await context.store.getUserById(one)).toMatchObject({ email: "uno@example.com", role: "operator" });
  });

  it("deleting a user (admin or data-subject erasure) removes its SCIM link and memberships", async () => {
    const { context, admin, call } = await setup();
    const fay = (await call("POST", "/Users", userBody("fay@example.com"))).json<{ id: string }>().id;
    const group = (await call("POST", "/Groups", { displayName: "G", members: [{ value: fay }] })).json<{ id: string }>().id;
    expect((await asCookie(context, admin.cookie, "DELETE", `/api/users/${fay}`)).statusCode).toBe(200);
    expect(await context.store.getScimUser(fay)).toBeNull();
    expect(await context.store.listScimGroupMembers(group)).toEqual([]);
  });
});
