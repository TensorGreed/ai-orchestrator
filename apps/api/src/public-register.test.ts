/**
 * POST /api/auth/register, every caller against every requested role. With AUTH_ALLOW_PUBLIC_REGISTER on, a signed-out
 * caller always gets viewer, a signed-in caller cannot grant a role above its own, and an API key is refused. With it
 * off, the route is admin user creation (a session or a key of an admin). The first user is the bootstrap admin either
 * way. Runs on SQLite and, under TEST_STORE=postgres, on Postgres.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Store } from "./db/store.js";
import { ApiKeyService } from "./services/api-key-service.js";
import {
  closeReleaseTestContext,
  createReleaseTestContext,
  loginAs,
  type ReleaseTestContext,
  type ReleaseTestRole
} from "./test-support/release.test-helper.js";

const ROLES: ReleaseTestRole[] = ["viewer", "operator", "builder", "admin"];
const RANK: Record<ReleaseTestRole, number> = { viewer: 1, operator: 2, builder: 3, admin: 4 };
const a = (role: string) => (/^[aeiou]/.test(role) ? `an ${role}` : `a ${role}`);

type AuditLogEntry = Awaited<ReturnType<Store["listAuditLogs"]>>["items"][number];

const contexts: ReleaseTestContext[] = [];

async function context(publicRegister: boolean): Promise<ReleaseTestContext> {
  const created = await createReleaseTestContext({ env: { AUTH_ALLOW_PUBLIC_REGISTER: publicRegister ? "true" : "false" } });
  contexts.push(created);
  return created;
}

afterEach(async () => {
  while (contexts.length > 0) await closeReleaseTestContext(contexts.pop()!);
});

let counter = 0;
const newEmail = () => `new-user-${++counter}@example.com`;

function register(ctx: ReleaseTestContext, payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return ctx.app.inject({ method: "POST", url: "/api/auth/register", headers, payload: { password: "NewUser-Pass-123!", ...payload } });
}

async function registerAudits(ctx: ReleaseTestContext, email: string): Promise<AuditLogEntry[]> {
  const { items } = await ctx.store.listAuditLogs({ eventType: "user.register", pageSize: 200 });
  return items.filter((entry) => (entry.metadata as { email?: string } | undefined)?.email === email);
}

async function apiKeyFor(ctx: ReleaseTestContext, role: ReleaseTestRole): Promise<string> {
  const { id } = await loginAs(ctx, role);
  return (await new ApiKeyService(ctx.store).create({ userId: id, name: `${role} key` })).plaintext;
}

describe("public registration on: a signed-out caller", () => {
  it.each([
    ["no role", {}],
    ["role viewer", { role: "viewer" }],
    ["role operator", { role: "operator" }],
    ["role builder", { role: "builder" }],
    ["role admin", { role: "admin" }],
    ["the admin shortcut", { admin: true }]
  ])("asking for %s is registered as a viewer", async (_label, extra) => {
    const ctx = await context(true);
    await loginAs(ctx, "admin");
    const email = newEmail();
    const response = await register(ctx, { email, ...extra });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ user: { role: string } }>().user.role).toBe("viewer");
    expect((await ctx.store.getUserByEmail(email))?.role).toBe("viewer");
    const audits = await registerAudits(ctx, email);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ outcome: "success", metadata: { role: "viewer" } });
  });

  it("with a cookie that names no session is a signed-out caller", async () => {
    const ctx = await context(true);
    await loginAs(ctx, "admin");
    const email = newEmail();
    const response = await register(ctx, { email, role: "admin" }, { cookie: `${ctx.config.SESSION_COOKIE_NAME}=sess_${"x".repeat(32)}` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ user: { role: string } }>().user.role).toBe("viewer");
  });

  it("behind a proxy that sends Basic credentials is still a signed-out caller", async () => {
    const ctx = await context(true);
    await loginAs(ctx, "admin");
    const email = newEmail();
    const response = await register(ctx, { email, role: "builder" }, { authorization: "Basic dXNlcjpwYXNz" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ user: { role: string } }>().user.role).toBe("viewer");
  });
});

describe("public registration on: a signed-in caller", () => {
  for (const actorRole of ROLES) {
    for (const requested of ROLES) {
      const allowed = RANK[requested] <= RANK[actorRole];
      it(`${a(actorRole)} asking for ${requested} is ${allowed ? "allowed" : "refused"}`, async () => {
        const ctx = await context(true);
        if (actorRole !== "admin") await loginAs(ctx, "admin");
        const actor = await loginAs(ctx, actorRole);
        const email = newEmail();
        const response = await register(ctx, { email, role: requested }, { cookie: actor.cookie });
        const audits = await registerAudits(ctx, email);
        expect(audits).toHaveLength(1);
        if (allowed) {
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json<{ user: { role: string } }>().user.role).toBe(requested);
          expect((await ctx.store.getUserByEmail(email))?.role).toBe(requested);
          expect(audits[0]).toMatchObject({ outcome: "success", metadata: { role: requested, actorEmail: actor.email } });
        } else {
          expect(response.statusCode, response.body).toBe(403);
          expect(await ctx.store.getUserByEmail(email)).toBeNull();
          expect(audits[0]).toMatchObject({
            outcome: "denied",
            metadata: { role: requested, reason: "role_above_actor", actorRole }
          });
        }
      });
    }
  }

  it("a viewer using the admin shortcut is refused", async () => {
    const ctx = await context(true);
    await loginAs(ctx, "admin");
    const viewer = await loginAs(ctx, "viewer");
    const email = newEmail();
    const response = await register(ctx, { email, admin: true }, { cookie: viewer.cookie });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ error: string }>().error).toBe("Only admins can create admin users");
    expect(await ctx.store.getUserByEmail(email)).toBeNull();
  });

  it("asking for no role registers a viewer", async () => {
    const ctx = await context(true);
    const builder = await loginAs(ctx, "builder");
    const email = newEmail();
    const response = await register(ctx, { email }, { cookie: builder.cookie });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ user: { role: string } }>().user.role).toBe("viewer");
  });
});

describe("public registration on: an API key", () => {
  for (const keyRole of ROLES) {
    it(`a key of ${a(keyRole)} is refused, whatever role it asks for`, async () => {
      const ctx = await context(true);
      if (keyRole !== "admin") await loginAs(ctx, "admin");
      const key = await apiKeyFor(ctx, keyRole);
      for (const requested of [undefined, ...ROLES]) {
        const email = newEmail();
        const response = await register(ctx, { email, ...(requested ? { role: requested } : {}) }, { authorization: `Bearer ${key}` });
        expect(response.statusCode, response.body).toBe(403);
        expect(response.json<{ error: string }>().error).toBe("API keys cannot be used for public registration");
        expect(await ctx.store.getUserByEmail(email)).toBeNull();
        const audits = await registerAudits(ctx, email);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({ outcome: "denied", metadata: { reason: "api_key" } });
      }
    });
  }

  it("a key that does not verify is refused too", async () => {
    const ctx = await context(true);
    await loginAs(ctx, "admin");
    const email = newEmail();
    const response = await register(ctx, { email }, { authorization: "Bearer not-a-real-key" });
    expect(response.statusCode, response.body).toBe(403);
    expect(await ctx.store.getUserByEmail(email)).toBeNull();
  });

  it("a key sent with an admin session is refused", async () => {
    const ctx = await context(true);
    const admin = await loginAs(ctx, "admin");
    const key = await apiKeyFor(ctx, "admin");
    const email = newEmail();
    const response = await register(ctx, { email, role: "builder" }, { cookie: admin.cookie, authorization: `Bearer ${key}` });
    expect(response.statusCode, response.body).toBe(403);
    expect(await ctx.store.getUserByEmail(email)).toBeNull();
  });
});

describe("public registration off: admin user creation", () => {
  it("a signed-out caller is refused", async () => {
    const ctx = await context(false);
    await loginAs(ctx, "admin");
    const email = newEmail();
    const response = await register(ctx, { email });
    expect(response.statusCode, response.body).toBe(401);
    expect(await ctx.store.getUserByEmail(email)).toBeNull();
  });

  for (const actorRole of ["viewer", "operator", "builder"] as const) {
    it(`${a(actorRole)} session is refused`, async () => {
      const ctx = await context(false);
      await loginAs(ctx, "admin");
      const actor = await loginAs(ctx, actorRole);
      const email = newEmail();
      const response = await register(ctx, { email, role: "viewer" }, { cookie: actor.cookie });
      expect(response.statusCode, response.body).toBe(403);
      expect(await ctx.store.getUserByEmail(email)).toBeNull();
    });

    it(`a key of ${a(actorRole)} is refused`, async () => {
      const ctx = await context(false);
      await loginAs(ctx, "admin");
      const key = await apiKeyFor(ctx, actorRole);
      const email = newEmail();
      const response = await register(ctx, { email, role: "viewer" }, { authorization: `Bearer ${key}` });
      expect(response.statusCode, response.body).toBe(403);
      expect(await ctx.store.getUserByEmail(email)).toBeNull();
    });
  }

  it("an admin session creates any role", async () => {
    const ctx = await context(false);
    const admin = await loginAs(ctx, "admin");
    for (const requested of ROLES) {
      const email = newEmail();
      const response = await register(ctx, { email, role: requested }, { cookie: admin.cookie });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ user: { role: string } }>().user.role).toBe(requested);
      expect(await registerAudits(ctx, email)).toMatchObject([{ outcome: "success", metadata: { role: requested, actorEmail: admin.email } }]);
    }
  });

  it("an admin key creates any role, as before", async () => {
    const ctx = await context(false);
    const key = await apiKeyFor(ctx, "admin");
    for (const requested of ROLES) {
      const email = newEmail();
      const response = await register(ctx, { email, role: requested }, { authorization: `Bearer ${key}` });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ user: { role: string } }>().user.role).toBe(requested);
    }
  });
});

describe("the first user", () => {
  for (const publicRegister of [true, false]) {
    it(`is the bootstrap admin with public registration ${publicRegister ? "on" : "off"}`, async () => {
      const ctx = await context(publicRegister);
      const response = await register(ctx, { email: newEmail() });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ user: { role: string } }>().user.role).toBe("admin");
    });
  }
});
