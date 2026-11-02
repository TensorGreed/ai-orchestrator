/**
 * 12.6 (D7) — model allowlist routes.
 *
 *   GET    /api/model-allowlist           entries (deployment and every project) and the providers to pick from
 *   POST   /api/model-allowlist           add an entry (admin), audited `model_allowlist.entry_added`
 *   DELETE /api/model-allowlist/:id       remove an entry (admin), audited `model_allowlist.entry_removed`
 *   GET    /api/model-allowlist/check     is `providerId` + `model` allowed in `projectId`? (the builder's warning)
 *
 * Reads are open to every signed-in role (the Security page shows them read-only to non-admins); only admins change
 * the lists.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { MODEL_ALLOWLIST_ANY_PROVIDER, effectiveModelName, modelAllowlistEntryCreateSchema, type ProviderDefinition } from "@ai-orchestrator/shared";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import { ModelAllowlistError, type ModelAllowlistService } from "./services/model-allowlist-service.js";

export interface ModelAllowlistRoutesDeps {
  app: FastifyInstance;
  service: ModelAllowlistService;
  listProviders: () => ProviderDefinition[];
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  audit: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void | Promise<void>;
}

const checkQuerySchema = z.object({
  providerId: z.string().trim().min(1).max(100),
  model: z.string().max(200).optional().default(""),
  /** Azure OpenAI nodes send their deployment name here; it is the model name the allowlist matches. */
  deployment: z.string().max(200).optional(),
  projectId: z.string().trim().min(1).max(200).optional()
});

export function registerModelAllowlistRoutes(deps: ModelAllowlistRoutesDeps): void {
  const { app, service, requireRole } = deps;

  app.get("/api/model-allowlist", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    return {
      entries: await service.list(),
      providers: [
        { id: MODEL_ALLOWLIST_ANY_PROVIDER, name: "Any provider" },
        ...deps.listProviders().map((definition) => ({ id: definition.id, name: definition.label || definition.id }))
      ],
      canEdit: user.role === "admin"
    };
  });

  app.post<{ Body: unknown }>("/api/model-allowlist", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = modelAllowlistEntryCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid allowlist entry", details: parsed.error.issues };
    }
    try {
      const entry = await service.add(parsed.data, user.email);
      await deps.audit(request, user, {
        category: "system",
        eventType: "model_allowlist.entry_added",
        action: "create",
        resourceType: "model_allowlist_entry",
        resourceId: entry.id,
        projectId: entry.projectId,
        metadata: { scope: entry.scope, projectId: entry.projectId, providerId: entry.providerId, modelGlob: entry.modelGlob }
      });
      reply.code(201);
      return { entry };
    } catch (error) {
      if (error instanceof ModelAllowlistError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>("/api/model-allowlist/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const removed = await service.remove(request.params.id);
    if (!removed) {
      reply.code(404);
      return { error: "Allowlist entry not found" };
    }
    await deps.audit(request, user, {
      category: "system",
      eventType: "model_allowlist.entry_removed",
      action: "delete",
      resourceType: "model_allowlist_entry",
      resourceId: removed.id,
      projectId: removed.projectId,
      metadata: { scope: removed.scope, projectId: removed.projectId, providerId: removed.providerId, modelGlob: removed.modelGlob }
    });
    return { ok: true, entry: removed };
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/model-allowlist/check", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const parsed = checkQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid check", details: parsed.error.issues };
    }
    const { providerId, projectId } = parsed.data;
    const model = effectiveModelName({
      providerId,
      model: parsed.data.model,
      ...(parsed.data.deployment ? { extra: { deployment: parsed.data.deployment } } : {})
    });
    const decision = await service.evaluate({ providerId, model, projectId: projectId ?? null });
    return { providerId, model, projectId: projectId ?? null, ...decision };
  });
}
