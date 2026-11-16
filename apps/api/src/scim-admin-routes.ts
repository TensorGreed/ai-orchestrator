/**
 * 13.2 — admin routes for SCIM provisioning (registered whether or not SCIM_ENABLED is set, so a token can be made
 * before the endpoints are switched on):
 *
 *   GET    /api/scim                         admin: whether SCIM is on, the base URL, the tokens and counts
 *   GET    /api/scim/groups                  admin: provisioned groups, member counts and the mappings naming each
 *   POST   /api/scim/tokens                  admin + step-up: a token (shown once) {name, expiresInDays?}
 *   POST   /api/scim/tokens/:id/rotate       admin + step-up: a new token (shown once); the old one works for {graceHours}
 *   DELETE /api/scim/tokens/:id              admin + step-up: revokes a token
 *
 * Group-to-role mappings for SCIM groups are the SSO group mappings with provider `scim` (/api/auth/sso/mappings).
 * Every change is audited (`scim_token.create`, `scim_token.rotate`, `scim_token.revoke`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  credentialRotateBodySchema,
  KEY_ROTATION_GRACE_HOURS,
  SCIM_BASE_PATH,
  SCIM_MAPPING_PROVIDER,
  scimTokenCreateBodySchema,
  type ScimGroupSummary,
  type ScimSettingsView
} from "@ai-orchestrator/shared";
import type { Store } from "./db/store.js";
import type { AuditActor, AuditEventInput } from "./services/audit-service.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import { mappingsForGroups } from "./services/scim-provisioning-service.js";
import type { ScimTokenService } from "./services/scim-token-service.js";

export interface ScimAdminRoutesDeps {
  app: FastifyInstance;
  store: Store;
  tokens: ScimTokenService;
  enabled: boolean;
  publicUrl?: string | null;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  requireStepUp: (request: FastifyRequest, reply: FastifyReply) => Promise<boolean>;
  audit: (
    request: FastifyRequest,
    user: SafeUser | null,
    event: Omit<AuditEventInput, "actor"> & { actor?: Partial<AuditActor> }
  ) => Promise<void>;
}

const PAGE = 200;

export function registerScimAdminRoutes(deps: ScimAdminRoutesDeps): void {
  const { app, store, tokens, requireRole, audit } = deps;
  const baseUrl = `${(deps.publicUrl ?? "").replace(/\/+$/, "")}${SCIM_BASE_PATH}`;

  app.get("/api/scim", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const users = await store.listScimUsers({ offset: 0, limit: 1 });
    const groups = await store.listScimGroups({ offset: 0, limit: 1 });
    const disabledUsers = (await store.listUsers({ kind: "human" })).filter((entry) => entry.disabledAt).length;
    const view: ScimSettingsView = {
      enabled: deps.enabled,
      baseUrl,
      tokens: await tokens.list(),
      provisionedUsers: users.total,
      disabledUsers,
      groups: groups.total
    };
    return view;
  });

  app.get("/api/scim/groups", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const mappings = await store.listSsoGroupMappings(SCIM_MAPPING_PROVIDER);
    const summaries: ScimGroupSummary[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await store.listScimGroups({ offset, limit: PAGE });
      const counts = await store.countScimGroupMembers(page.items.map((group) => group.id));
      for (const group of page.items) {
        summaries.push({
          id: group.id,
          displayName: group.displayName,
          externalId: group.externalId,
          memberCount: counts.get(group.id) ?? 0,
          mappingIds: mappingsForGroups([group], mappings).map((mapping) => mapping.id),
          createdAt: group.createdAt,
          updatedAt: group.updatedAt
        });
      }
      if (page.items.length < PAGE || offset + PAGE >= page.total) break;
    }
    return { groups: summaries };
  });

  app.post<{ Body: unknown }>("/api/scim/tokens", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    if (!(await deps.requireStepUp(request, reply))) return reply;
    const parsed = scimTokenCreateBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid SCIM token payload", details: parsed.error.issues };
    }
    const { plaintext, record } = await tokens.create({ name: parsed.data.name, createdBy: user.id, expiresInDays: parsed.data.expiresInDays ?? null });
    await audit(request, user, {
      category: "auth",
      eventType: "scim_token.create",
      action: "create",
      resourceType: "scim_token",
      resourceId: record.id,
      metadata: { name: record.name, tokenPrefix: record.tokenPrefix, expiresAt: record.expiresAt }
    });
    reply.code(201);
    // The only response that carries the token.
    return { token: plaintext, record };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/scim/tokens/:id/rotate", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    if (!(await deps.requireStepUp(request, reply))) return reply;
    const parsed = credentialRotateBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid rotation payload", details: parsed.error.issues };
    }
    const graceHours = parsed.data.graceHours ?? KEY_ROTATION_GRACE_HOURS.default;
    const rotated = await tokens.rotate({ id: request.params.id, graceHours, createdBy: user.id });
    if (!rotated) {
      reply.code(409);
      return { error: "Only a live token that was not rotated already can be rotated" };
    }
    await audit(request, user, {
      category: "auth",
      eventType: "scim_token.rotate",
      action: "update",
      resourceType: "scim_token",
      resourceId: rotated.previous.id,
      metadata: {
        name: rotated.record.name,
        newTokenId: rotated.record.id,
        tokenPrefix: rotated.record.tokenPrefix,
        previousTokenPrefix: rotated.previous.tokenPrefix,
        graceHours,
        previousExpiresAt: rotated.previous.expiresAt
      }
    });
    // The only response that carries the new token.
    return { token: rotated.plaintext, record: rotated.record, previous: rotated.previous };
  });

  app.delete<{ Params: { id: string } }>("/api/scim/tokens/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    if (!(await deps.requireStepUp(request, reply))) return reply;
    if (!(await tokens.revoke(request.params.id))) {
      reply.code(404);
      return { error: "SCIM token not found or already revoked" };
    }
    await audit(request, user, {
      category: "auth",
      eventType: "scim_token.revoke",
      action: "revoke",
      resourceType: "scim_token",
      resourceId: request.params.id
    });
    return { ok: true };
  });
}
