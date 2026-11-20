/**
 * Passwords of people who sign in with one:
 *
 *   POST /api/auth/password              a signed-in person changes their own password (current + new); their other
 *                                        sessions end, the current one stays
 *   POST /api/users/:id/password/reset   an admin sets a new temporary password for another person (generated, shown
 *                                        once in the answer); all of that person's sessions end
 *
 * Both need a signed-in browser session called from the studio's own page (no API key; Origin/Referer checked, so
 * another site cannot fire them with the admin's cookie). Both are audited (`user.password.change`,
 * `user.password.reset`) without the password. A new password follows the rules of registration and the bootstrap
 * admin (8 to 1024 characters). Five wrong current passwords in 15 minutes lock the change for that person (429).
 *
 * SSO: an admin cannot set a password on an account linked to an OIDC, SAML or LDAP identity (it would give an SSO-only
 * person a password they never had). Changing your own needs the current password, which an SSO-only person does not
 * know (theirs was random), so the self-change touches only a local password someone actually holds.
 * There is no email reset: an admin's reset is the way back for someone who forgot their password.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Store } from "./db/store.js";
import type { AuditEventInput } from "./services/audit-service.js";
import { hashPassword, verifyPassword, type SafeUser, type UserRole } from "./services/auth-service.js";
import type { StepUpAction } from "./services/mfa-policy.js";
import type { SessionService } from "./services/session-service.js";

export interface PasswordRoutesDeps {
  app: FastifyInstance;
  store: Store;
  sessions: SessionService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  audit: (request: FastifyRequest, user: SafeUser, event: AuditEventInput) => Promise<void>;
  /** Step-up (STEP_UP_MAX_AGE_MINUTES); false means it has answered. */
  requireStepUp: (request: FastifyRequest, reply: FastifyReply, action: StepUpAction, targetUserId?: string) => Promise<boolean>;
  /** Whether a cookie-authenticated call comes from the studio's own page (Origin/Referer, Sec-Fetch-Site). */
  calledFromStudio: (request: FastifyRequest) => boolean;
}

/** Wrong current passwords allowed per person in the window before the change is locked. */
export const CHANGE_FAILURE_LIMIT = 5;
export const CHANGE_FAILURE_WINDOW_MS = 15 * 60_000;

/** The password rules of registration and the bootstrap admin. */
export const newPasswordSchema = z.string().min(8, "Use at least 8 characters").max(1024);

const changeBodySchema = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: newPasswordSchema }).strict();

const SSO_ONLY_MESSAGE = "This account signs in with single sign-on; its password is managed by the identity provider.";

/** A temporary password: 18 random bytes, base64url (24 characters). */
export function temporaryPassword(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export function registerPasswordRoutes(deps: PasswordRoutesDeps): void {
  const { app, store, sessions, requireRole, audit, requireStepUp, calledFromStudio } = deps;

  /** A signed-in session from the studio's page; otherwise answers and returns null. */
  const studioSession = (request: FastifyRequest, reply: FastifyReply) => {
    const context = sessions.getRequestAuth(request);
    if (context?.credential !== "session") {
      reply.code(400).send({ error: "Use a signed-in browser session for passwords, not an API key", code: "session_required" });
      return null;
    }
    if (!calledFromStudio(request)) {
      reply.code(403).send({ error: "This request must come from the studio", code: "cross_site_refused" });
      return null;
    }
    return context;
  };

  app.post<{ Body: unknown }>("/api/auth/password", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const context = studioSession(request, reply);
    if (!context) return reply;
    const parsed = changeBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.path[0] === "newPassword" ? `New password: ${parsed.error.issues[0].message}` : "Invalid payload", details: parsed.error.issues };
    }
    const stored = await store.getUserById(user.id);
    if (!stored || stored.kind !== "human") {
      reply.code(404);
      return { error: "User not found" };
    }
    const recentFailures = await store.listAuditLogs({
      eventType: "user.password.change",
      outcome: "failure",
      resourceId: user.id,
      from: new Date(Date.now() - CHANGE_FAILURE_WINDOW_MS).toISOString(),
      pageSize: CHANGE_FAILURE_LIMIT
    });
    if (recentFailures.items.length >= CHANGE_FAILURE_LIMIT) {
      reply.code(429);
      return { error: "Too many wrong passwords. Try again in 15 minutes.", code: "password_change_locked" };
    }
    if (!verifyPassword(parsed.data.currentPassword, stored.passwordHash)) {
      await audit(request, user, {
        category: "auth",
        eventType: "user.password.change",
        action: "update",
        outcome: "failure",
        resourceType: "user",
        resourceId: user.id,
        metadata: { reason: "current_password" }
      });
      // 403, not 401: the session is still signed in.
      reply.code(403);
      return { error: "The current password is not correct", code: "current_password_invalid" };
    }
    if (parsed.data.newPassword === parsed.data.currentPassword) {
      reply.code(400);
      return { error: "The new password is the same as the current one", code: "password_unchanged" };
    }
    const changed = await store.setUserPassword({
      userId: user.id,
      passwordHash: hashPassword(parsed.data.newPassword),
      now: new Date().toISOString(),
      expectedPasswordHash: stored.passwordHash
    });
    if (!changed) {
      // Another change landed between the check and the write.
      reply.code(409);
      return { error: "The password was changed meanwhile. Sign in again and retry.", code: "password_changed_meanwhile" };
    }
    const sessionsEnded = await store.revokeUserSessions(user.id, { exceptId: context.session.id, reason: "policy" });
    await audit(request, user, {
      category: "auth",
      eventType: "user.password.change",
      action: "update",
      resourceType: "user",
      resourceId: user.id,
      metadata: { sessionsEnded }
    });
    return { ok: true, sessionsEnded };
  });

  app.post<{ Params: { id: string } }>("/api/users/:id/password/reset", async (request, reply) => {
    const admin = await requireRole(request, reply, ["admin"]);
    if (!admin) return reply;
    if (!studioSession(request, reply)) return reply;
    if (!await requireStepUp(request, reply, "user.password_reset", request.params.id)) return reply;
    if (admin.id === request.params.id) {
      reply.code(400);
      return { error: "Change your own password under Settings > Security, with your current password.", code: "own_account" };
    }
    const target = await store.getUserById(request.params.id);
    if (!target || target.kind !== "human") {
      reply.code(404);
      return { error: "User not found" };
    }
    if (target.disabledAt) {
      reply.code(409);
      return { error: "This user is disabled. Enable them first.", code: "user_disabled" };
    }
    if ((await store.listOpenUserInvites()).some((invite) => invite.userId === target.id)) {
      reply.code(409);
      return { error: "This user has not accepted their invite yet. Send the invite again instead.", code: "invite_pending" };
    }
    if (await store.userHasSsoIdentity(target.id)) {
      reply.code(409);
      return { error: SSO_ONLY_MESSAGE, code: "sso_account" };
    }
    const password = temporaryPassword();
    if (!await store.setUserPassword({ userId: target.id, passwordHash: hashPassword(password), now: new Date().toISOString() })) {
      reply.code(404);
      return { error: "User not found" };
    }
    const sessionsEnded = await store.revokeUserSessions(target.id, { reason: "admin" });
    await audit(request, admin, {
      category: "auth",
      eventType: "user.password.reset",
      action: "update",
      resourceType: "user",
      resourceId: target.id,
      metadata: { email: target.email, sessionsEnded }
    });
    reply.header("cache-control", "no-store");
    return { ok: true, userId: target.id, temporaryPassword: password, sessionsEnded };
  });
}
