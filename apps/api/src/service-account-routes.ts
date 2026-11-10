/**
 * 13.2 — service accounts: machine identities that act only through API keys.
 *
 *   GET    /api/service-accounts                     admin: the service accounts, with project roles and live key count
 *   POST   /api/service-accounts                     admin: creates one ({name, role, description?})
 *   PATCH  /api/service-accounts/:id                 admin: changes its role and/or description
 *   DELETE /api/service-accounts/:id                 admin: deletes it with its keys and project roles
 *   GET    /api/service-accounts/:id/keys            admin: its API keys
 *   POST   /api/service-accounts/:id/keys            admin: creates a key (shown once), optionally scoped
 *   DELETE /api/service-accounts/:id/keys/:keyId     admin: revokes a key
 *   POST   /api/service-accounts/:id/keys/:keyId/rotate  admin: a new key (shown once) with the same name and scope;
 *                                                    the old one works for the grace window ({graceHours}, 24 by default)
 *
 * A service account is a `users` row with kind `service`: it has a global role, project memberships (the project
 * member routes take its id), RBAC and audit like a person, but no usable password, and every sign-in path (password,
 * OIDC, SAML, LDAP, invites) refuses it. Its email is `<name>+<random>@service.invalid`: a reserved domain no person or
 * SSO login can hold, with a random part no identity provider can name (even on a build before service accounts, see
 * the v62 rollback notes). Names are unique among service accounts. The admin who created it is recorded as text: deleting that admin leaves the account working.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import { credentialRotateBodySchema, DEFAULT_PROJECT_ID, KEY_ROTATION_GRACE_HOURS } from "@ai-orchestrator/shared";
import type { Store, StoredUserSummary } from "./db/store.js";
import { apiKeyRotationRefusal, type ApiKeyService } from "./services/api-key-service.js";
import type { AuditActor, AuditEventInput } from "./services/audit-service.js";
import { SERVICE_ACCOUNT_EMAIL_DOMAIN, type SafeUser, type UserRole } from "./services/auth-service.js";
import { apiKeyCreateBodySchema, resolveNewKeyScope, type KeyScope } from "./services/key-scopes.js";

/** A service account name: the local part of its email. Letters, digits, `.`, `_` and `-`, starting with a letter or digit. */
export const SERVICE_ACCOUNT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const roleSchema = z.enum(["admin", "builder", "operator", "viewer"]);

const serviceAccountCreateSchema = z.object({
  name: z.string().trim().toLowerCase().regex(SERVICE_ACCOUNT_NAME_PATTERN, "Use 1 to 63 letters, digits, '.', '_' or '-', starting with a letter or digit"),
  role: roleSchema.default("viewer"),
  description: z.string().trim().max(500).nullable().optional()
});

const serviceAccountPatchSchema = z
  .object({
    role: roleSchema.optional(),
    description: z.string().trim().max(500).nullable().optional()
  })
  .refine((body) => body.role !== undefined || body.description !== undefined, { message: "Nothing to change: pass role and/or description" });

export interface ServiceAccountRoutesDeps {
  app: FastifyInstance;
  store: Store;
  apiKeyService: ApiKeyService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  audit: (
    request: FastifyRequest,
    user: SafeUser | null,
    event: Omit<AuditEventInput, "actor"> & { actor?: Partial<AuditActor> }
  ) => Promise<void>;
  /** The scope of the API key the request was made with, when it was made with one. */
  requestKeyScope: (request: FastifyRequest) => KeyScope | null;
  /** Removes the account's own MCP OAuth connections (and their tokens), as deleting a person does. */
  disconnectMcpOAuth: (userId: string) => Promise<unknown>;
  /**
   * 13.2 — step-up (STEP_UP_MAX_AGE_MINUTES) before creating a service-account key, changing a service account's role
   * or deleting one; false means it has answered.
   */
  requireStepUp?: (
    request: FastifyRequest,
    reply: FastifyReply,
    action: "api_key.create" | "api_key.rotate" | "user.role_change" | "user.delete"
  ) => Promise<boolean>;
  /** 13.2 — SERVICE_ACCOUNT_KEY_MAX_AGE_DAYS: every new or rotated key expires within this many days (0 = no limit). */
  keyMaxAgeDays?: number;
}

/** The service account's name: the email's local part, without the random part after the last `+`. */
export function serviceAccountName(email: string): string {
  const local = email.slice(0, email.lastIndexOf("@"));
  const plus = local.lastIndexOf("+");
  return plus > 0 ? local.slice(0, plus) : local;
}

/** A new service account's email: its name, a random part no identity provider can guess, and the reserved domain. */
export function serviceAccountEmail(name: string): string {
  return `${name}+${randomBytes(9).toString("hex")}@${SERVICE_ACCOUNT_EMAIL_DOMAIN}`;
}

function asUserRole(role: string): UserRole {
  return role === "admin" || role === "builder" || role === "operator" ? role : "viewer";
}

export function registerServiceAccountRoutes(deps: ServiceAccountRoutesDeps): void {
  const { app, store, apiKeyService, requireRole, audit, disconnectMcpOAuth } = deps;

  const view = async (account: StoredUserSummary) => {
    const keys = await apiKeyService.list(account.id);
    const now = Date.now();
    return {
      id: account.id,
      name: serviceAccountName(account.email),
      email: account.email,
      role: account.role,
      description: account.description,
      createdBy: account.createdBy,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      projects: (await store.listUserProjectRoles(account.id)).map((row) => ({ projectId: row.projectId, role: row.role, customRoleId: row.customRoleId })),
      activeKeys: keys.filter((key) => !key.revokedAt && (!key.expiresAt || Date.parse(key.expiresAt) > now)).length
    };
  };

  /** The service account an id names, or null (a person's id reads as missing). */
  const findAccount = async (id: string): Promise<StoredUserSummary | null> => {
    const row = await store.getUserById(id);
    if (!row || row.kind !== "service") return null;
    const { passwordHash: _hash, ...summary } = row;
    return summary;
  };

  const notFound = (reply: FastifyReply) => {
    reply.code(404);
    return { error: "Service account not found" };
  };

  app.get("/api/service-accounts", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const accounts = await store.listUsers({ kind: "service" });
    const serviceAccounts = [];
    for (const account of accounts) serviceAccounts.push(await view(account));
    return { serviceAccounts };
  });

  app.post<{ Body: unknown }>("/api/service-accounts", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = serviceAccountCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid service account payload", details: parsed.error.issues };
    }
    const taken = (await store.listUsers({ kind: "service" })).some((account) => serviceAccountName(account.email) === parsed.data.name);
    const created = taken ? null : await store.createServiceAccount({
      id: `usr_${nanoid(12)}`,
      email: serviceAccountEmail(parsed.data.name),
      role: parsed.data.role,
      description: parsed.data.description || null,
      createdBy: user.id
    });
    if (!created) {
      reply.code(409);
      return { error: `A service account named '${parsed.data.name}' already exists` };
    }
    await audit(request, user, {
      category: "auth",
      eventType: "service_account.create",
      action: "create",
      resourceType: "service_account",
      resourceId: created.id,
      metadata: { name: parsed.data.name, role: created.role }
    });
    reply.code(201);
    return { serviceAccount: await view(created) };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/service-accounts/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = serviceAccountPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid service account payload", details: parsed.error.issues };
    }
    const existing = await findAccount(request.params.id);
    if (!existing) return notFound(reply);
    if (parsed.data.role && parsed.data.role !== existing.role && deps.requireStepUp && !(await deps.requireStepUp(request, reply, "user.role_change"))) {
      return reply;
    }
    const updated = await store.updateServiceAccount(existing.id, {
      ...(parsed.data.role ? { role: parsed.data.role } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description || null } : {})
    });
    if (!updated) return notFound(reply);
    await audit(request, user, {
      category: "auth",
      eventType: "service_account.update",
      action: "update",
      resourceType: "service_account",
      resourceId: updated.id,
      metadata: {
        ...(parsed.data.role ? { previousRole: existing.role, newRole: updated.role } : {}),
        ...(parsed.data.description !== undefined ? { descriptionChanged: true } : {})
      }
    });
    return { serviceAccount: await view(updated) };
  });

  app.delete<{ Params: { id: string } }>("/api/service-accounts/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = await findAccount(request.params.id);
    if (!existing) return notFound(reply);
    if (deps.requireStepUp && !(await deps.requireStepUp(request, reply, "user.delete"))) return reply;
    // Its keys, project roles, MCP OAuth connections and any other rows go with it (the same delete as for a person).
    await disconnectMcpOAuth(existing.id);
    if (!await store.deleteUser(existing.id)) return notFound(reply);
    await audit(request, user, {
      category: "auth",
      eventType: "service_account.delete",
      action: "delete",
      resourceType: "service_account",
      resourceId: existing.id,
      metadata: { email: existing.email, role: existing.role }
    });
    return { ok: true, id: existing.id };
  });

  app.get<{ Params: { id: string } }>("/api/service-accounts/:id/keys", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const account = await findAccount(request.params.id);
    if (!account) return notFound(reply);
    return { keys: await apiKeyService.list(account.id) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/service-accounts/:id/keys", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const account = await findAccount(request.params.id);
    if (!account) return notFound(reply);
    if (deps.requireStepUp && !(await deps.requireStepUp(request, reply, "api_key.create"))) return reply;
    const parsed = apiKeyCreateBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid API key payload", details: parsed.error.issues };
    }
    const scope = await resolveNewKeyScope(parsed.data, {
      ownerRole: asUserRole(account.role),
      callerRole: user.role,
      callerScope: deps.requestKeyScope(request),
      projectExists: async (projectId) => projectId === DEFAULT_PROJECT_ID || Boolean(await store.getProject(projectId))
    });
    if (!scope.ok) {
      reply.code(scope.status);
      return { error: scope.error };
    }
    const { plaintext, record } = await apiKeyService.create({
      userId: account.id,
      name: parsed.data.name,
      scopes: scope.scopes,
      expiresInDays: parsed.data.expiresInDays ?? null,
      maxAgeDays: deps.keyMaxAgeDays ?? 0
    });
    await audit(request, user, {
      category: "api_key",
      eventType: "api_key.create",
      action: "create",
      resourceType: "api_key",
      resourceId: record.id,
      metadata: { name: record.name, scopes: record.scopes, keyPrefix: record.keyPrefix, ownerKind: "service", serviceAccountId: account.id }
    });
    reply.code(201);
    // The only response that carries the key.
    return { key: plaintext, record };
  });

  app.post<{ Params: { id: string; keyId: string }; Body: unknown }>("/api/service-accounts/:id/keys/:keyId/rotate", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    if (deps.requireStepUp && !(await deps.requireStepUp(request, reply, "api_key.rotate"))) return reply;
    const parsed = credentialRotateBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid rotation payload", details: parsed.error.issues };
    }
    const account = await findAccount(request.params.id);
    if (!account) return notFound(reply);
    const graceHours = parsed.data.graceHours ?? KEY_ROTATION_GRACE_HOURS.default;
    const rotated = await apiKeyService.rotate({ id: request.params.keyId, userId: account.id, graceHours, maxAgeDays: deps.keyMaxAgeDays ?? 0 });
    if (!rotated.ok) {
      const refusal = apiKeyRotationRefusal(rotated.reason);
      reply.code(refusal.status);
      return refusal.body;
    }
    await audit(request, user, {
      category: "api_key",
      eventType: "api_key.rotate",
      action: "update",
      resourceType: "api_key",
      resourceId: rotated.previous.id,
      metadata: {
        name: rotated.record.name,
        newKeyId: rotated.record.id,
        keyPrefix: rotated.record.keyPrefix,
        previousKeyPrefix: rotated.previous.keyPrefix,
        graceHours,
        previousExpiresAt: rotated.previous.expiresAt,
        expiresAt: rotated.record.expiresAt,
        ownerKind: "service",
        serviceAccountId: account.id
      }
    });
    // The only response that carries the new key.
    return { key: rotated.plaintext, record: rotated.record, previous: rotated.previous };
  });

  app.delete<{ Params: { id: string; keyId: string } }>("/api/service-accounts/:id/keys/:keyId", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const account = await findAccount(request.params.id);
    if (!account) return notFound(reply);
    if (!await apiKeyService.revoke(request.params.keyId, account.id)) {
      reply.code(404);
      return { error: "API key not found" };
    }
    await audit(request, user, {
      category: "api_key",
      eventType: "api_key.revoke",
      action: "revoke",
      resourceType: "api_key",
      resourceId: request.params.keyId,
      metadata: { ownerKind: "service", serviceAccountId: account.id }
    });
    return { ok: true };
  });
}
