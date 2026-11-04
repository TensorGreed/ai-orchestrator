/**
 * Roadmap 7.3 — POST /api/users/invite (admin), the public lookup and accept routes, and the pending flag on
 * GET /api/users. Runs on SQLite and, under TEST_STORE=postgres, on Postgres.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationService } from "./services/notification-service.js";
import { hashInviteToken } from "./user-invite-routes.js";
import {
  callAs,
  closeReleaseTestContext,
  createReleaseTestContext,
  loginAs,
  type ReleaseTestContext
} from "./test-support/release.test-helper.js";

const contexts: ReleaseTestContext[] = [];

async function context(env?: Record<string, string>): Promise<ReleaseTestContext> {
  const created = await createReleaseTestContext(env ? { env } : {});
  contexts.push(created);
  return created;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (contexts.length > 0) await closeReleaseTestContext(contexts.pop()!);
});

interface InviteResponse {
  user: { id: string; email: string; role: string; pending: boolean };
  invite: { id: string; expiresAt: string };
  emailed: boolean;
  inviteUrl?: string;
}

const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get("invite")!;

const login = (ctx: ReleaseTestContext, email: string, password: string) =>
  ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });

describe("POST /api/users/invite", () => {
  it("creates a pending user that cannot sign in until it accepts, then signs in with its password", async () => {
    const ctx = await context({ APP_PUBLIC_URL: "https://l2m.example.com" });
    const admin = await loginAs(ctx, "admin");
    const response = await callAs(ctx, "POST", "/api/users/invite", admin.cookie, { email: " New.Person@Example.com ", role: "builder" });
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json<InviteResponse>();
    expect(body).toMatchObject({ user: { email: "new.person@example.com", role: "builder", pending: true }, emailed: false });
    expect(body.inviteUrl).toMatch(/^https:\/\/l2m\.example\.com\/#invite=[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(body.inviteUrl!);
    // Only the token's hash is stored.
    const stored = await ctx.store.findUserInviteByTokenHash(hashInviteToken(token));
    expect(stored).toMatchObject({ userId: body.user.id, acceptedAt: null });
    expect(JSON.stringify(await ctx.store.listOpenUserInvites())).not.toContain(token);
    const expiresIn = Date.parse(body.invite.expiresAt) - Date.now();
    expect(expiresIn).toBeGreaterThan(167 * 3_600_000);
    expect(expiresIn).toBeLessThanOrEqual(168 * 3_600_000);

    const users = (await callAs(ctx, "GET", "/api/users", admin.cookie)).json<{ users: Array<Record<string, unknown>> }>().users;
    expect(users.find((user) => user.id === body.user.id)).toMatchObject({ pending: true, inviteExpiresAt: body.invite.expiresAt });
    expect(users.find((user) => user.id === admin.id)).toEqual({ id: admin.id, email: admin.email, role: "admin", createdAt: expect.any(String) });

    // A pending user has no usable password.
    expect((await login(ctx, "new.person@example.com", "")).statusCode).toBe(400);
    expect((await login(ctx, "new.person@example.com", "anything-at-all")).statusCode).toBe(401);

    const lookup = await ctx.app.inject({ method: "POST", url: "/api/auth/invite/lookup", payload: { token } });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toEqual({ email: "new.person@example.com", role: "builder", expiresAt: body.invite.expiresAt });

    const accepted = await ctx.app.inject({ method: "POST", url: "/api/auth/invite/accept", payload: { token, password: "Chosen-Pass-1" } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toEqual({ ok: true, email: "new.person@example.com" });
    const signedIn = await login(ctx, "new.person@example.com", "Chosen-Pass-1");
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json<{ user: { role: string } }>().user.role).toBe("builder");

    // The link works once.
    expect((await ctx.app.inject({ method: "POST", url: "/api/auth/invite/accept", payload: { token, password: "Another-Pass-2" } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "POST", url: "/api/auth/invite/lookup", payload: { token } })).statusCode).toBe(404);
    const after = (await callAs(ctx, "GET", "/api/users", admin.cookie)).json<{ users: Array<Record<string, unknown>> }>().users;
    expect(after.find((user) => user.id === body.user.id)?.pending).toBeUndefined();

    const events = (await ctx.store.listAuditLogs({ category: "auth", pageSize: 50 })).items.map((item) => `${item.eventType}:${item.outcome}`);
    expect(events).toContain("user.invite:success");
    expect(events).toContain("user.invite.accept:success");
    expect(events).toContain("user.invite.accept:failure");
  });

  it("is admin only, validates the payload and refuses an active account", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    const builder = await loginAs(ctx, "builder");
    expect((await callAs(ctx, "POST", "/api/users/invite", builder.cookie, { email: "x@example.com" })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "POST", url: "/api/users/invite", payload: { email: "x@example.com" } })).statusCode).toBe(401);
    expect((await callAs(ctx, "POST", "/api/users/invite", admin.cookie, { email: "not-an-email" })).statusCode).toBe(400);
    expect((await callAs(ctx, "POST", "/api/users/invite", admin.cookie, { email: "x@example.com", role: "owner" })).statusCode).toBe(400);
    expect((await callAs(ctx, "POST", "/api/users/invite", admin.cookie, { email: "x@example.com", expiresInHours: 721 })).statusCode).toBe(400);
    const taken = await callAs(ctx, "POST", "/api/users/invite", admin.cookie, { email: "BUILDER@example.com" });
    expect(taken.statusCode).toBe(409);
    const viewer = await callAs(ctx, "POST", "/api/users/invite", admin.cookie, { email: "v@example.com" });
    expect(viewer.json<InviteResponse>().user.role).toBe("viewer");
  });

  it("invites a pending user again: the role changes and only the new link works", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    const first = (await callAs(ctx, "POST", "/api/users/invite", admin.cookie, { email: "p@example.com", role: "viewer" })).json<InviteResponse>();
    const againResponse = await callAs(ctx, "POST", "/api/users/invite", admin.cookie, { email: "p@example.com", role: "operator", expiresInHours: 1 });
    expect(againResponse.statusCode).toBe(200);
    const again = againResponse.json<InviteResponse>();
    expect(again.user.id).toBe(first.user.id);
    expect((await ctx.store.getUserById(first.user.id))?.role).toBe("operator");
    expect((await ctx.app.inject({ method: "POST", url: "/api/auth/invite/lookup", payload: { token: tokenOf(first.inviteUrl!) } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "POST", url: "/api/auth/invite/lookup", payload: { token: tokenOf(again.inviteUrl!) } })).json()).toMatchObject({ role: "operator" });
  });

  it("refuses an expired invite and a short password", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    const body = (await callAs(ctx, "POST", "/api/users/invite", admin.cookie, { email: "e@example.com", expiresInHours: 1 })).json<InviteResponse>();
    const token = tokenOf(body.inviteUrl!);
    expect((await ctx.app.inject({ method: "POST", url: "/api/auth/invite/accept", payload: { token, password: "short" } })).statusCode).toBe(400);
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 2 * 3_600_000);
    expect((await ctx.app.inject({ method: "POST", url: "/api/auth/invite/lookup", payload: { token } })).statusCode).toBe(404);
    vi.restoreAllMocks();
    // The accept route compares with the clock in the store's statement.
    await ctx.store.createUserInvite({
      inviteId: "inv_old",
      userId: "usr_old",
      email: "old@example.com",
      role: "viewer",
      tokenHash: hashInviteToken("an-old-token-0123456789"),
      createdBy: null,
      createdAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-08T00:00:00.000Z"
    });
    const late = await ctx.app.inject({ method: "POST", url: "/api/auth/invite/accept", payload: { token: "an-old-token-0123456789", password: "Long-Enough-1" } });
    expect(late.statusCode).toBe(404);
    expect(late.json<{ error: string }>().error).toBe("This invite link is invalid or has expired");
  });

  it("deleting the pending user revokes the invite", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    const body = (await callAs(ctx, "POST", "/api/users/invite", admin.cookie, { email: "d@example.com" })).json<InviteResponse>();
    expect((await callAs(ctx, "DELETE", `/api/users/${body.user.id}`, admin.cookie)).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: "/api/auth/invite/accept", payload: { token: tokenOf(body.inviteUrl!), password: "Long-Enough-1" } })).statusCode).toBe(404);
  });

  it("emails the link when an SMTP server is set, and then does not return it", async () => {
    const send = vi.spyOn(NotificationService.prototype, "sendDirectEmail").mockResolvedValue(true);
    const ctx = await context({ NOTIFICATIONS_ENABLED: "true", NOTIFICATION_SMTP_HOST: "smtp.example.com" });
    const admin = await loginAs(ctx, "admin");
    const response = await callAs(ctx, "POST", "/api/users/invite", admin.cookie, { email: "m@example.com", role: "operator" });
    expect(response.statusCode).toBe(201);
    const body = response.json<InviteResponse>();
    expect(body.emailed).toBe(true);
    expect(body.inviteUrl).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0]![0];
    expect(message.to).toBe("m@example.com");
    expect(message.text).toMatch(/http:\/\/localhost:5173\/#invite=[A-Za-z0-9_-]{43}/);
    expect(message.html).toContain("operator");
  });

  it("sendDirectEmail is false without an SMTP server", async () => {
    const ctx = await context();
    const service = new NotificationService(ctx.config, () => []);
    expect(await service.sendDirectEmail({ to: "a@example.com", subject: "s", html: "h", text: "t" })).toBe(false);
  });
});
