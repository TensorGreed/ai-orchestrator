/**
 * 13.2 — signed-in sessions: a user lists and ends their own; an admin lists and ends another user's.
 *
 * A session is named by its handle (`sessionHandle`), never by its ID: the ID is the cookie value.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { LoginSession, Store } from "./db/store.js";
import type { AuditEventInput } from "./services/audit-service.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import { configuredAbsoluteHoursFor, absoluteHoursFor, idleMinutesFor, maxSessionsFor } from "./services/session-policy.js";
import { sessionHandle, type SessionService } from "./services/session-service.js";

export interface SessionRoutesDeps {
  app: FastifyInstance;
  store: Store;
  sessions: SessionService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  audit: (request: FastifyRequest, user: SafeUser, event: AuditEventInput) => Promise<void>;
  clearSessionCookie: (reply: FastifyReply) => void;
}

/** What the sessions API shows about one session (no ID: the handle names it). */
export interface SessionView {
  handle: string;
  current: boolean;
  authMethod: LoginSession["authMethod"];
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  mfaVerified: boolean;
  breakGlass: boolean;
}

export function sessionView(session: LoginSession, currentId: string | null): SessionView {
  return {
    handle: sessionHandle(session.id),
    current: session.id === currentId,
    authMethod: session.authMethod,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt ?? null,
    expiresAt: session.expiresAt,
    mfaVerified: session.mfaVerifiedAt !== null,
    breakGlass: session.breakGlass
  };
}

const revokeBodySchema = z.object({ handle: z.string().min(1).max(64).optional() }).strict();

export function registerSessionRoutes(deps: SessionRoutesDeps): void {
  const { app, store, sessions, requireRole, audit, clearSessionCookie } = deps;

  /** The session this request was authenticated with (null for API-key requests). */
  const currentSessionId = (request: FastifyRequest): string | null => {
    const context = sessions.getRequestAuth(request);
    return context?.credential === "session" ? context.session.id : null;
  };

  /** Live sessions as the policy sees them: idle or role-expired rows are ended and left out. */
  const liveSessions = async (userId: string, role?: UserRole) => {
    const target = role ? { role } : await store.getUserById(userId);
    const known = target?.role;
    return await sessions.liveSessions(userId, known === "admin" || known === "builder" || known === "operator" || known === "viewer" ? known : undefined);
  };

  app.get("/api/auth/sessions", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const currentId = currentSessionId(request);
    const policy = sessions.policy;
    return {
      sessions: (await liveSessions(user.id, user.role)).map((session) => sessionView(session, currentId)),
      policy: {
        idleTimeoutMinutes: idleMinutesFor(policy, user.role),
        absoluteTimeoutHours: absoluteHoursFor(policy, user.role),
        absoluteTimeoutConfigured: configuredAbsoluteHoursFor(policy, user.role) !== null,
        maxPerUser: maxSessionsFor(policy, user.role)
      }
    };
  });

  /**
   * Ending your own sessions is for a signed-in browser: an API key has no session of its own, so it could only sign
   * its owner out everywhere. Those requests get 403 and end nothing.
   */
  const refuseWithoutSession = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (currentSessionId(request)) return false;
    reply.code(403).send({ error: "Ending sessions needs a signed-in browser session, not an API key" });
    return true;
  };

  app.delete<{ Params: { handle: string } }>("/api/auth/sessions/:handle", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    if (refuseWithoutSession(request, reply)) return reply;
    const target = (await liveSessions(user.id, user.role)).find((session) => sessionHandle(session.id) === request.params.handle);
    if (!target) {
      reply.code(404);
      return { error: "Session not found" };
    }
    const currentId = currentSessionId(request);
    await sessions.endSession(target.id, "logout");
    const current = target.id === currentId;
    if (current) clearSessionCookie(reply);
    await audit(request, user, {
      category: "auth",
      eventType: "session.revoked",
      action: "revoke",
      resourceType: "user",
      resourceId: user.id,
      metadata: { by: "self", sessions: [request.params.handle], current }
    });
    return { ok: true, current };
  });

  app.post("/api/auth/sessions/revoke-others", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    if (refuseWithoutSession(request, reply)) return reply;
    const currentId = currentSessionId(request)!;
    const revoked = await store.revokeUserSessions(user.id, { exceptId: currentId, reason: "logout" });
    await audit(request, user, {
      category: "auth",
      eventType: "session.revoked",
      action: "revoke",
      resourceType: "user",
      resourceId: user.id,
      metadata: { by: "self", scope: "others", count: revoked }
    });
    return { revoked };
  });

  app.get<{ Params: { id: string } }>("/api/users/:id/sessions", async (request, reply) => {
    const admin = await requireRole(request, reply, ["admin"]);
    if (!admin) return reply;
    if (!(await store.getUserById(request.params.id))) {
      reply.code(404);
      return { error: "User not found" };
    }
    const currentId = currentSessionId(request);
    return { sessions: (await liveSessions(request.params.id)).map((session) => sessionView(session, currentId)) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/users/:id/sessions/revoke", async (request, reply) => {
    const admin = await requireRole(request, reply, ["admin"]);
    if (!admin) return reply;
    const parsed = revokeBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid payload", details: parsed.error.issues };
    }
    const target = await store.getUserById(request.params.id);
    if (!target) {
      reply.code(404);
      return { error: "User not found" };
    }
    // An admin ending their own sessions here keeps the one they are using.
    const keepId = target.id === admin.id ? currentSessionId(request) : null;
    let revoked = 0;
    if (parsed.data.handle) {
      const session = (await liveSessions(target.id)).find((row) => sessionHandle(row.id) === parsed.data.handle);
      if (!session || session.id === keepId) {
        reply.code(404);
        return { error: "Session not found" };
      }
      revoked = (await sessions.endSession(session.id, "admin")) ? 1 : 0;
    } else {
      revoked = await store.revokeUserSessions(target.id, { ...(keepId ? { exceptId: keepId } : {}), reason: "admin" });
    }
    await audit(request, admin, {
      category: "auth",
      eventType: "session.revoked",
      action: "revoke",
      resourceType: "user",
      resourceId: target.id,
      metadata: { by: "admin", ...(parsed.data.handle ? { sessions: [parsed.data.handle] } : { scope: "all" }), count: revoked }
    });
    return { revoked };
  });
}
