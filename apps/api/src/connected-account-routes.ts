/**
 * Connected accounts (Secrets → Connected accounts, and "Connect <provider>" in node credential pickers).
 *
 *   GET    /api/connect/providers?projectId=               providers, whether each is set up here, the redirect URL and setup steps (builder)
 *   PUT    /api/connect/providers/:providerId/app          set up the OAuth app: { projectId | null, clientId, clientSecret?, tenant? }
 *                                                          (instance: admin; project: secret:write there)
 *   DELETE /api/connect/providers/:providerId/app?projectId=  remove it (same rule)
 *   POST   /api/connect/:providerId/start                  { projectId, scopeSets?, reconnectSecretId? } → the provider's sign-in URL
 *                                                          (who may create secrets in the project; a reconnect needs secret:write on it)
 *   GET    /api/connect/callback                           where the provider sends the browser back (same signed-in session and user)
 *   GET    /api/connect/accounts/:secretId                 one account's details (who may see the secret)
 *   POST   /api/connect/accounts/:secretId/refresh         renew its token now (secret:write)
 *   DELETE /api/connect/accounts/:secretId                 disconnect: revoke where the provider offers it, delete the secret (secret:write)
 *
 * No route returns a token or a client secret. Every change is audited (connect, reconnect, refresh failure, disconnect,
 * app set up or removed); step-up applies like the secret routes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CONNECTED_ACCOUNT_SECRET_PROVIDER, DEFAULT_PROJECT_ID } from "@ai-orchestrator/shared";
import type { Store } from "./db/store.js";
import type { AuditEventInput } from "./services/audit-service.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { StepUpAction } from "./services/mfa-policy.js";
import type { Permission } from "./services/rbac-service.js";
import { CONNECT_CALLBACK_PATH, ConnectedAccountError, renderConnectCallbackPage, type ConnectedAccountService } from "./services/connected-account-service.js";

export interface ConnectedAccountRoutesDeps {
  app: FastifyInstance;
  store: Store;
  service: ConnectedAccountService;
  webOrigin: string;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  requireStepUp: (request: FastifyRequest, reply: FastifyReply, action: StepUpAction) => Promise<boolean>;
  can: (user: SafeUser, projectId: string, permission: Permission) => Promise<boolean>;
  /** Who may see (and pick) the secret: secret:read in its project or a project it is shared to. */
  canSeeSecret: (user: SafeUser, secret: { id: string; projectId?: string | null }) => Promise<boolean>;
  auditUser: (request: FastifyRequest, user: SafeUser | null, event: Omit<AuditEventInput, "actor">) => Promise<void>;
  sessionIdOf: (request: FastifyRequest) => string;
  sessionUser: (sessionId: string) => Promise<SafeUser | null>;
}

const appSchema = z
  .object({
    projectId: z.string().trim().min(1).max(120).nullable().optional(),
    clientId: z.string().max(512),
    clientSecret: z.string().max(4096).optional(),
    tenant: z.string().max(128).optional()
  })
  .strict();

const startSchema = z
  .object({
    projectId: z.string().trim().min(1).max(120).optional(),
    scopeSets: z.array(z.string().max(64)).max(16).optional(),
    reconnectSecretId: z.string().min(1).max(64).optional()
  })
  .strict();

function projectOf(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_PROJECT_ID;
}

export function registerConnectedAccountRoutes(deps: ConnectedAccountRoutesDeps): void {
  const { app, store, service } = deps;

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof ConnectedAccountError) {
      reply.code(error.statusCode);
      return { error: error.message };
    }
    throw error;
  };

  /** The same rule as creating a secret: secret:write, or an editor's workflow:write + secret:use. */
  const mayCreateSecretIn = async (user: SafeUser, projectId: string) =>
    (await deps.can(user, projectId, "secret:write")) || ((await deps.can(user, projectId, "workflow:write")) && (await deps.can(user, projectId, "secret:use")));

  const mayConfigure = async (user: SafeUser, projectId: string | null) =>
    projectId === null ? user.role === "admin" : await deps.can(user, projectId, "secret:write");

  /** The account's secret, when the user may see it; null otherwise (shown as not found). */
  const visibleAccountSecret = async (user: SafeUser, secretId: string) => {
    const row = await store.getSecret(secretId);
    if (!row || row.provider !== CONNECTED_ACCOUNT_SECRET_PROVIDER) return null;
    return (await deps.canSeeSecret(user, { id: row.id, projectId: row.projectId })) ? row : null;
  };

  app.get<{ Querystring: { projectId?: string } }>("/api/connect/providers", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const projectId = projectOf(request.query?.projectId);
    if (!(await deps.can(user, projectId, "secret:read"))) {
      reply.code(403);
      return { error: "Permission 'secret:read' required in this project" };
    }
    return {
      redirectUrl: service.redirectUri,
      providers: await service.listProviders(projectId, {
        canConfigureProject: await mayConfigure(user, projectId),
        canConfigureInstance: user.role === "admin"
      })
    };
  });

  app.put<{ Params: { providerId: string }; Body: unknown }>("/api/connect/providers/:providerId/app", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    if (!(await deps.requireStepUp(request, reply, "secret.update"))) return;
    const parsed = appSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Send { projectId, clientId, clientSecret, tenant }.", details: parsed.error.issues };
    }
    const projectId = parsed.data.projectId ?? null;
    if (!(await mayConfigure(user, projectId))) {
      reply.code(403);
      return { error: projectId === null ? "Only an admin can set up an app for the whole instance." : "Permission 'secret:write' required in this project" };
    }
    try {
      const saved = await service.saveApp({
        providerId: request.params.providerId,
        projectId,
        clientId: parsed.data.clientId,
        ...(parsed.data.clientSecret !== undefined ? { clientSecret: parsed.data.clientSecret } : {}),
        ...(parsed.data.tenant !== undefined ? { tenant: parsed.data.tenant } : {}),
        actorEmail: user.email
      });
      await deps.auditUser(request, user, {
        category: "secret",
        eventType: "oauth_app.saved",
        action: "update",
        resourceType: "oauth_app",
        resourceId: saved.id,
        projectId: projectId ?? DEFAULT_PROJECT_ID,
        metadata: { providerId: saved.providerId, scope: projectId ? "project" : "instance", clientId: saved.clientId, secretChanged: Boolean(parsed.data.clientSecret) }
      });
      return { id: saved.id, providerId: saved.providerId, projectId: saved.projectId, clientId: saved.clientId, tenant: saved.tenant, updatedAt: saved.updatedAt };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete<{ Params: { providerId: string }; Querystring: { projectId?: string } }>("/api/connect/providers/:providerId/app", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    if (!(await deps.requireStepUp(request, reply, "secret.delete"))) return;
    const projectId = typeof request.query?.projectId === "string" && request.query.projectId.trim() ? request.query.projectId.trim() : null;
    if (!(await mayConfigure(user, projectId))) {
      reply.code(403);
      return { error: projectId === null ? "Only an admin can remove the instance's app." : "Permission 'secret:write' required in this project" };
    }
    try {
      const removed = await service.deleteApp(request.params.providerId, projectId);
      if (!removed) {
        reply.code(404);
        return { error: "No app is set up there." };
      }
      await deps.auditUser(request, user, {
        category: "secret",
        eventType: "oauth_app.removed",
        action: "delete",
        resourceType: "oauth_app",
        resourceId: `${request.params.providerId}:${projectId ?? "*"}`,
        projectId: projectId ?? DEFAULT_PROJECT_ID,
        metadata: { providerId: request.params.providerId, scope: projectId ? "project" : "instance" }
      });
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { providerId: string }; Body: unknown }>("/api/connect/:providerId/start", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    if (!(await deps.requireStepUp(request, reply, "secret.create"))) return;
    const parsed = startSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Send { projectId, scopeSets }.", details: parsed.error.issues };
    }
    const sessionId = deps.sessionIdOf(request);
    if (!sessionId) {
      reply.code(400);
      return { error: "Connecting an account needs a signed-in browser session (not an API key)." };
    }
    let projectId = projectOf(parsed.data.projectId);
    if (parsed.data.reconnectSecretId) {
      const row = await visibleAccountSecret(user, parsed.data.reconnectSecretId);
      if (!row) {
        reply.code(404);
        return { error: "Connected account not found" };
      }
      projectId = row.projectId ?? DEFAULT_PROJECT_ID;
      if (!(await deps.can(user, projectId, "secret:write"))) {
        reply.code(403);
        return { error: "Permission 'secret:write' required in the account's project" };
      }
    } else if (!(await mayCreateSecretIn(user, projectId))) {
      reply.code(403);
      return { error: "Permission 'secret:write' required in the target project" };
    }
    try {
      const started = await service.startConnect({
        providerId: request.params.providerId,
        projectId,
        ...(parsed.data.scopeSets ? { scopeSetIds: parsed.data.scopeSets } : {}),
        sessionId,
        userId: user.id,
        userEmail: user.email,
        ...(parsed.data.reconnectSecretId ? { reconnectSecretId: parsed.data.reconnectSecretId } : {})
      });
      await deps.auditUser(request, user, {
        category: "secret",
        eventType: "oauth_account.connect_started",
        action: "create",
        resourceType: "secret",
        resourceId: parsed.data.reconnectSecretId ?? request.params.providerId,
        projectId,
        metadata: { providerId: request.params.providerId, reconnect: Boolean(parsed.data.reconnectSecretId), scopeSets: parsed.data.scopeSets ?? [] }
      });
      return started;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>(CONNECT_CALLBACK_PATH, async (request, reply) => {
    const query = request.query ?? {};
    const sessionId = deps.sessionIdOf(request);
    const user = sessionId ? await deps.sessionUser(sessionId) : null;
    const outcome = user
      ? await service.completeConnect({
          state: query.state,
          code: query.code,
          ...(query.error ? { error: query.error } : {}),
          ...(query.error_description ? { errorDescription: query.error_description } : {}),
          sessionId,
          userId: user.id,
          // Roles may have changed while the person was at the provider: the same rule as starting.
          authorize: async ({ projectId, reconnectSecretId }) => {
            if (reconnectSecretId) {
              return (await deps.can(user, projectId, "secret:write")) ? null : "You may no longer change secrets in this project.";
            }
            return (await mayCreateSecretIn(user, projectId)) ? null : "You may no longer add secrets to this project.";
          }
        })
      : { ok: false, providerId: null, error: "Sign in to L2M in this browser, then connect again." };
    if (outcome.providerId) {
      await deps.auditUser(request, user, {
        category: "secret",
        eventType: outcome.ok ? (outcome.reconnected ? "oauth_account.reconnected" : "oauth_account.connected") : "oauth_account.connect_failed",
        action: "create",
        outcome: outcome.ok ? "success" : "failure",
        resourceType: "secret",
        resourceId: outcome.secretId ?? outcome.providerId,
        projectId: outcome.projectId ?? DEFAULT_PROJECT_ID,
        metadata: {
          providerId: outcome.providerId,
          ...(outcome.ok ? { accountLabel: outcome.accountLabel ?? null } : { error: (outcome.error ?? "").slice(0, 300) })
        }
      });
    }
    const page = renderConnectCallbackPage(outcome, deps.webOrigin);
    reply
      .code(outcome.ok ? 200 : 400)
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header(
        "content-security-policy",
        `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${page.nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      );
    return page.html;
  });

  app.get<{ Params: { secretId: string } }>("/api/connect/accounts/:secretId", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const row = await visibleAccountSecret(user, request.params.secretId);
    if (!row) {
      reply.code(404);
      return { error: "Connected account not found" };
    }
    try {
      return { id: row.id, name: row.name, projectId: row.projectId, connection: await service.view(row.id) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { secretId: string } }>("/api/connect/accounts/:secretId/refresh", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    const row = await visibleAccountSecret(user, request.params.secretId);
    if (!row) {
      reply.code(404);
      return { error: "Connected account not found" };
    }
    if (!(await deps.can(user, row.projectId ?? DEFAULT_PROJECT_ID, "secret:write"))) {
      reply.code(403);
      return { error: "Permission 'secret:write' required in the account's project" };
    }
    try {
      return { id: row.id, connection: await service.refreshNow(row.id) };
    } catch (error) {
      if (error instanceof ConnectedAccountError) {
        reply.code(error.statusCode);
        return { error: error.message, connection: await service.view(row.id).catch(() => null) };
      }
      throw error;
    }
  });

  app.delete<{ Params: { secretId: string } }>("/api/connect/accounts/:secretId", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["builder"]);
    if (!user) return;
    if (!(await deps.requireStepUp(request, reply, "secret.delete"))) return;
    const row = await visibleAccountSecret(user, request.params.secretId);
    if (!row) {
      reply.code(404);
      return { error: "Connected account not found" };
    }
    if (!(await deps.can(user, row.projectId ?? DEFAULT_PROJECT_ID, "secret:write"))) {
      reply.code(403);
      return { error: "Permission 'secret:write' required in the account's project" };
    }
    if (user.role !== "admin" && (await store.listSensitiveOutputSecretIds()).includes(row.id)) {
      reply.code(403);
      return { error: "Only an admin can delete a secret flagged sensitive output." };
    }
    try {
      const result = await service.disconnect(row.id);
      await deps.auditUser(request, user, {
        category: "secret",
        eventType: "oauth_account.disconnected",
        action: "delete",
        resourceType: "secret",
        resourceId: row.id,
        projectId: result.projectId,
        metadata: { name: row.name, providerId: result.providerId, revoked: result.revoked }
      });
      return { ok: true, revoked: result.revoked };
    } catch (error) {
      return fail(reply, error);
    }
  });
}
