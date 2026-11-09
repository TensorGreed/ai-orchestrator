/**
 * Roadmap 7.3 — deployment-level user invites.
 *
 *   POST /api/users/invite          admin: creates a pending user with a role and a one-time invite link
 *   POST /api/auth/invite/lookup    public: the email and role an invite token is for (the accept page)
 *   POST /api/auth/invite/accept    public: sets the invitee's password; the invite is used up
 *
 * The token is 32 random bytes (base64url), only its SHA-256 is stored, and it expires (7 days unless the admin sets
 * `expiresInHours`, 1 to 720). A pending user is an account with an unusable password: it cannot sign in with a
 * password until it accepts, and an SSO sign-in to the same email (OIDC, SAML, LDAP) closes its invite. Inviting the
 * email of a pending user again sets its role and replaces its invite (the old link stops working). With an SMTP
 * server set in the environment the link is emailed; otherwise (or when the send fails) it is returned to the admin.
 * Invites are an admin action, so they work whatever AUTH_ALLOW_PUBLIC_REGISTER says. A pending user is revoked by
 * deleting it (DELETE /api/users/:id), which removes its invite.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Store, UserInviteRecord } from "./db/store.js";
import type { AuditActor, AuditEventInput } from "./services/audit-service.js";
import { hashPassword, isServiceAccountEmail, SERVICE_ACCOUNT_EMAIL_DOMAIN, type SafeUser, type UserRole } from "./services/auth-service.js";
import { escapeHtml } from "./services/notification-service.js";

export const USER_INVITE_DEFAULT_HOURS = 168;
export const USER_INVITE_MAX_HOURS = 720;

const INVALID_INVITE = "This invite link is invalid or has expired";

const inviteCreateSchema = z.object({
  email: z.string().trim().email().max(320),
  role: z.enum(["admin", "builder", "operator", "viewer"]).default("viewer"),
  expiresInHours: z.number().int().min(1).max(USER_INVITE_MAX_HOURS).optional()
});

const inviteTokenSchema = z.object({ token: z.string().min(16).max(200) });

const inviteAcceptSchema = inviteTokenSchema.extend({ password: z.string().min(8).max(1024) });

export interface UserInviteRoutesDeps {
  app: FastifyInstance;
  store: Store;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  /** 13.2 — step-up before inviting (STEP_UP_MAX_AGE_MINUTES); false means the answer was sent. Absent = no step-up. */
  requireStepUp?: (request: FastifyRequest, reply: FastifyReply, action: "user.invite") => Promise<boolean>;
  audit: (
    request: FastifyRequest,
    user: SafeUser | null,
    event: Omit<AuditEventInput, "actor"> & { actor?: Partial<AuditActor> }
  ) => Promise<void>;
  /** The page the invite link opens (APP_PUBLIC_URL, else the first WEB_ORIGIN), without a trailing slash. */
  webBaseUrl: string;
  /** Sends the invite email; false when no mail server is set or the send failed. */
  sendEmail: (message: { to: string; subject: string; html: string; text: string }) => Promise<boolean>;
}

export function hashInviteToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function inviteLink(webBaseUrl: string, token: string): string {
  return `${webBaseUrl.replace(/\/+$/, "")}/#invite=${encodeURIComponent(token)}`;
}

function openInvite(invite: UserInviteRecord | null, now: number): invite is UserInviteRecord {
  return Boolean(invite && !invite.acceptedAt && Date.parse(invite.expiresAt) > now);
}

function inviteEmail(link: string, role: string, expiresAt: string, invitedBy: string) {
  const text =
    `${invitedBy} invited you to L2M as ${role}.\n\n` +
    `Open this link to choose your password and sign in:\n${link}\n\n` +
    `The link works once and expires at ${expiresAt}.`;
  const html =
    `<p>${escapeHtml(invitedBy)} invited you to L2M as <strong>${escapeHtml(role)}</strong>.</p>` +
    `<p><a href="${escapeHtml(link)}">Choose your password and sign in</a></p>` +
    `<p>The link works once and expires at ${escapeHtml(expiresAt)}.</p>`;
  return { subject: "You are invited to L2M", text, html };
}

export function registerUserInviteRoutes(deps: UserInviteRoutesDeps): void {
  const { app, store, requireRole, audit } = deps;

  app.post<{ Body: unknown }>("/api/users/invite", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    if (deps.requireStepUp && !(await deps.requireStepUp(request, reply, "user.invite"))) return;
    const parsed = inviteCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid invite payload", details: parsed.error.issues };
    }
    const email = parsed.data.email.toLowerCase();
    // 13.2 — the service-account domain is reserved: nobody is invited into it.
    if (isServiceAccountEmail(email)) {
      reply.code(400);
      return { error: `Emails in @${SERVICE_ACCOUNT_EMAIL_DOMAIN} are reserved for service accounts` };
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (parsed.data.expiresInHours ?? USER_INVITE_DEFAULT_HOURS) * 3_600_000).toISOString();
    const result = await store.createUserInvite({
      inviteId: `inv_${nanoid(16)}`,
      userId: `usr_${nanoid(12)}`,
      email,
      role: parsed.data.role,
      tokenHash: hashInviteToken(token),
      createdBy: user.id,
      createdAt: now.toISOString(),
      expiresAt
    });
    if (!result) {
      reply.code(409);
      return { error: "An account with this email already exists" };
    }
    const link = inviteLink(deps.webBaseUrl, token);
    const message = inviteEmail(link, parsed.data.role, expiresAt, user.email);
    const emailed = await deps.sendEmail({ to: email, ...message });
    await audit(request, user, {
      category: "auth",
      eventType: "user.invite",
      action: "invite",
      resourceType: "user",
      resourceId: result.invite.userId,
      metadata: { email, role: parsed.data.role, expiresAt, reinvite: !result.created, emailed }
    });
    reply.code(result.created ? 201 : 200);
    return {
      user: { id: result.invite.userId, email, role: parsed.data.role, pending: true },
      invite: { id: result.invite.id, expiresAt },
      emailed,
      // Without an email the admin passes the link on; it is shown this once and never stored.
      ...(emailed ? {} : { inviteUrl: link })
    };
  });

  app.post<{ Body: unknown }>("/api/auth/invite/lookup", async (request, reply) => {
    const parsed = inviteTokenSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "token is required" };
    }
    const invite = await store.findUserInviteByTokenHash(hashInviteToken(parsed.data.token));
    if (!openInvite(invite, Date.now())) {
      reply.code(404);
      return { error: INVALID_INVITE };
    }
    return { email: invite.email, role: invite.role, expiresAt: invite.expiresAt };
  });

  app.post<{ Body: unknown }>("/api/auth/invite/accept", async (request, reply) => {
    const parsed = inviteAcceptSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid invite payload", details: parsed.error.issues };
    }
    // The token is checked before the password is hashed (scrypt is costly): a bad token is a cheap 404.
    const tokenHash = hashInviteToken(parsed.data.token);
    const open = openInvite(await store.findUserInviteByTokenHash(tokenHash), Date.now());
    const accepted = open
      ? await store.acceptUserInvite({ tokenHash, passwordHash: hashPassword(parsed.data.password), now: new Date().toISOString() })
      : null;
    if (!accepted) {
      await audit(request, null, {
        category: "auth",
        eventType: "user.invite.accept",
        action: "accept_invite",
        outcome: "failure",
        metadata: { reason: "invalid_or_expired" }
      });
      reply.code(404);
      return { error: INVALID_INVITE };
    }
    await audit(request, null, {
      category: "auth",
      eventType: "user.invite.accept",
      action: "accept_invite",
      resourceType: "user",
      resourceId: accepted.id,
      actor: { userId: accepted.id, email: accepted.email },
      metadata: { email: accepted.email, role: accepted.role }
    });
    // The page signs in with the new password next, through the normal login (and its MFA step).
    return { ok: true, email: accepted.email };
  });
}
