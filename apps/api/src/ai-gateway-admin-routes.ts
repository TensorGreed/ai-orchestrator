/**
 * 12.6b — the admin API of the /v1 AI gateway: route sets (project-owned), their routes, which clients may call
 * which sets, a set's rule set binding, and usage. Builders read; admins change. Usage is spend across every project,
 * so it is admin-only, like /api/usage/*. Every change is audited. A route names its provider key only as a stored
 * secret's id (secretRef); the value is never read here or returned.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { EmbeddingProviderRegistry, ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import {
  AI_GATEWAY_LIMITS,
  aiGatewayGrantsInputSchema,
  aiGatewayRouteInputSchema,
  aiGatewayRouteSetInputSchema,
  aiGatewayRouteSetUpdateSchema,
  aiGatewayRouteUpdateSchema,
  guardGatewayBindingInputSchema,
  normalizeGatewayRateLimit,
  type AiGatewayRoute,
  type AiGatewayRouteSet
} from "@ai-orchestrator/shared";
import type { z } from "zod";
import { AiGatewayAliasTakenError, type AiGatewayRouteWrite } from "./db/ai-gateway-store.js";
import type { Store } from "./db/store.js";
import type { AuditEventInput } from "./services/audit-service.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import { GuardConflictError, GuardNotFoundError, GuardValidationError, type GuardService } from "./services/guard-service.js";
import { MCP_TELEMETRY_WINDOWS, parseMcpTelemetryWindow } from "./services/mcp-tool-telemetry.js";

export interface AiGatewayAdminDeps {
  app: FastifyInstance;
  store: Store;
  providerRegistry: ProviderRegistry;
  embeddingRegistry: EmbeddingProviderRegistry;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  auditUser: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void | Promise<void>;
  /**
   * Null when the secret may be used by routes of a set owned by `projectId` (null: the default project), else why
   * not. The same rule as a workflow run's: the secret's own project, a default-project secret in `role` isolation, or
   * one shared to the project.
   */
  secretProblem: (secretId: string, projectId: string | null) => Promise<string | null>;
  guard?: GuardService;
}

const MAX_REQUEST_ROWS = 200;

function issues(error: z.ZodError) {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

export function registerAiGatewayAdminRoutes(deps: AiGatewayAdminDeps): void {
  const { app, store, requireRole } = deps;

  const invalid = (reply: FastifyReply, error: string, list: Array<{ path: string; message: string }> = []) => {
    reply.code(400);
    return { error, issues: list };
  };
  const notFound = (reply: FastifyReply, what: string) => {
    reply.code(404);
    return { error: `${what} not found` };
  };

  const setView = async (set: AiGatewayRouteSet, grants?: Array<{ clientId: string; routeSetId: string }>) => {
    const all = grants ?? (await store.listAllAiGatewayClientGrants());
    return { ...set, routes: await store.listAiGatewayRoutes(set.id), clientIds: all.filter((grant) => grant.routeSetId === set.id).map((grant) => grant.clientId) };
  };

  /** Project, provider and secret checks for a set's project and a route's settings. */
  const projectProblem = async (projectId: string | null | undefined): Promise<string | null> => {
    if (!projectId) return null;
    return (await store.getProject(projectId)) ? null : `Project '${projectId}' does not exist`;
  };

  const routeProblems = async (
    route: Pick<AiGatewayRoute, "kind" | "providerId" | "secretRef">,
    projectId: string | null
  ): Promise<Array<{ path: string; message: string }>> => {
    const problems: Array<{ path: string; message: string }> = [];
    if (route.kind === "embedding") {
      if (!deps.embeddingRegistry.tryGet(route.providerId)) {
        problems.push({ path: "providerId", message: `Provider '${route.providerId}' has no embeddings. Use one of: ${deps.embeddingRegistry.ids().join(", ")}` });
      }
    } else if (!deps.providerRegistry.tryGet(route.providerId)) {
      problems.push({ path: "providerId", message: `Unknown provider '${route.providerId}'` });
    }
    if (route.secretRef) {
      const secretId = route.secretRef.secretId;
      if (!(await store.getSecret(secretId))) problems.push({ path: "secretRef.secretId", message: `Secret '${secretId}' does not exist` });
      else {
        const problem = await deps.secretProblem(secretId, projectId);
        if (problem) problems.push({ path: "secretRef.secretId", message: problem });
      }
    }
    return problems;
  };

  // ---------------------------------------------------------------------------
  // Route sets
  // ---------------------------------------------------------------------------

  app.get("/api/ai-gateway/route-sets", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const grants = await store.listAllAiGatewayClientGrants();
    const sets = await store.listAiGatewayRouteSets();
    return {
      routeSets: await Promise.all(sets.map((set) => setView(set, grants))),
      providers: {
        chat: deps.providerRegistry.listDefinitions().map((definition) => definition.id).filter((id) => id !== "echo"),
        embedding: deps.embeddingRegistry.ids()
      }
    };
  });

  app.get<{ Params: { id: string } }>("/api/ai-gateway/route-sets/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const set = await store.getAiGatewayRouteSet(request.params.id);
    if (!set) return notFound(reply, "Route set");
    return await setView(set);
  });

  app.post<{ Body: unknown }>("/api/ai-gateway/route-sets", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = aiGatewayRouteSetInputSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, "Invalid route set", issues(parsed.error));
    const problem = await projectProblem(parsed.data.projectId);
    if (problem) return invalid(reply, "Invalid route set", [{ path: "projectId", message: problem }]);
    if ((await store.listAiGatewayRouteSets()).length >= AI_GATEWAY_LIMITS.routeSets) {
      reply.code(409);
      return { error: `A deployment can have at most ${AI_GATEWAY_LIMITS.routeSets} route sets` };
    }
    const set = await store.createAiGatewayRouteSet({
      id: `aiset_${crypto.randomUUID()}`,
      name: parsed.data.name,
      description: parsed.data.description ?? "",
      projectId: parsed.data.projectId ?? null,
      enabled: parsed.data.enabled ?? true,
      rateLimit: normalizeGatewayRateLimit(parsed.data.rateLimit),
      createdBy: user.id
    });
    await deps.auditUser(request, user, {
      eventType: "ai_gateway.route_set.created",
      category: "system",
      action: "create",
      resourceType: "ai_gateway_route_set",
      resourceId: set.id,
      projectId: set.projectId,
      metadata: { name: set.name, enabled: set.enabled, rateLimit: set.rateLimit }
    });
    reply.code(201);
    return await setView(set);
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/ai-gateway/route-sets/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = await store.getAiGatewayRouteSet(request.params.id);
    if (!existing) return notFound(reply, "Route set");
    const parsed = aiGatewayRouteSetUpdateSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, "Invalid route set", issues(parsed.error));
    const patch = parsed.data;
    if (patch.projectId !== undefined && (patch.projectId ?? null) !== existing.projectId) {
      const problem = await projectProblem(patch.projectId);
      if (problem) return invalid(reply, "Invalid route set", [{ path: "projectId", message: problem }]);
      // A new owner must be able to use every route's secret.
      const routeIssues: Array<{ path: string; message: string }> = [];
      for (const route of await store.listAiGatewayRoutes(existing.id)) {
        if (!route.secretRef) continue;
        const secretIssue = await deps.secretProblem(route.secretRef.secretId, patch.projectId ?? null);
        if (secretIssue) routeIssues.push({ path: "projectId", message: `Route '${route.alias}': ${secretIssue}` });
      }
      if (routeIssues.length > 0) return invalid(reply, "Invalid route set", routeIssues);
    }
    const updated = await store.updateAiGatewayRouteSet(existing.id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.projectId !== undefined ? { projectId: patch.projectId ?? null } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.rateLimit !== undefined ? { rateLimit: normalizeGatewayRateLimit(patch.rateLimit) } : {})
    });
    if (!updated) return notFound(reply, "Route set");
    await deps.auditUser(request, user, {
      eventType: "ai_gateway.route_set.updated",
      category: "system",
      action: "update",
      resourceType: "ai_gateway_route_set",
      resourceId: updated.id,
      projectId: updated.projectId,
      metadata: { fields: Object.keys(patch), ...(patch.projectId !== undefined ? { fromProjectId: existing.projectId, toProjectId: updated.projectId } : {}) }
    });
    return await setView(updated);
  });

  app.delete<{ Params: { id: string } }>("/api/ai-gateway/route-sets/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = await store.getAiGatewayRouteSet(request.params.id);
    if (!existing) return notFound(reply, "Route set");
    const routes = await store.listAiGatewayRoutes(existing.id);
    await store.deleteAiGatewayRouteSet(existing.id);
    const clearedGuard = await deps.guard?.clearGatewayBinding("ai_route_set", existing.id, user.id);
    await deps.auditUser(request, user, {
      eventType: "ai_gateway.route_set.deleted",
      category: "system",
      action: "delete",
      resourceType: "ai_gateway_route_set",
      resourceId: existing.id,
      projectId: existing.projectId,
      metadata: { name: existing.name, aliases: routes.map((route) => route.alias), ...(clearedGuard ? { clearedGuardBinding: clearedGuard } : {}) }
    });
    reply.code(204);
    return null;
  });

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  const aliasTaken = (reply: FastifyReply, error: unknown) => {
    if (error instanceof AiGatewayAliasTakenError) {
      reply.code(409);
      return { error: error.message, issues: [{ path: "alias", message: error.message }] };
    }
    throw error;
  };

  const routeAudit = (route: AiGatewayRoute) => ({
    alias: route.alias,
    kind: route.kind,
    providerId: route.providerId,
    model: route.model,
    baseUrl: route.baseUrl,
    secretId: route.secretRef?.secretId ?? null,
    enabled: route.enabled
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/ai-gateway/route-sets/:id/routes", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const set = await store.getAiGatewayRouteSet(request.params.id);
    if (!set) return notFound(reply, "Route set");
    const parsed = aiGatewayRouteInputSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, "Invalid route", issues(parsed.error));
    const input = parsed.data;
    const kind = input.kind ?? "chat";
    const problems = await routeProblems({ kind, providerId: input.providerId, secretRef: input.secretRef ?? null }, set.projectId);
    if (problems.length > 0) return invalid(reply, "Invalid route", problems);
    if ((await store.listAiGatewayRoutes(set.id)).length >= AI_GATEWAY_LIMITS.routesPerSet) {
      reply.code(409);
      return { error: `A route set can have at most ${AI_GATEWAY_LIMITS.routesPerSet} routes` };
    }
    let route: AiGatewayRoute;
    try {
      route = await store.createAiGatewayRoute({
        id: `airoute_${crypto.randomUUID()}`,
        routeSetId: set.id,
        alias: input.alias,
        kind,
        providerId: input.providerId,
        model: input.model,
        baseUrl: input.baseUrl ?? null,
        secretId: input.secretRef?.secretId ?? null,
        extra: input.extra ?? {},
        defaults: input.defaults ?? {},
        enabled: input.enabled ?? true,
        createdBy: user.id
      });
    } catch (error) {
      return aliasTaken(reply, error);
    }
    await deps.auditUser(request, user, {
      eventType: "ai_gateway.route.created",
      category: "system",
      action: "create",
      resourceType: "ai_gateway_route",
      resourceId: route.id,
      projectId: set.projectId,
      metadata: { routeSetId: set.id, ...routeAudit(route) }
    });
    reply.code(201);
    return route;
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/ai-gateway/routes/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = await store.getAiGatewayRoute(request.params.id);
    if (!existing) return notFound(reply, "Route");
    const set = await store.getAiGatewayRouteSet(existing.routeSetId);
    if (!set) return notFound(reply, "Route set");
    const parsed = aiGatewayRouteUpdateSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, "Invalid route", issues(parsed.error));
    const patch = parsed.data;
    const next = {
      kind: patch.kind ?? existing.kind,
      providerId: patch.providerId ?? existing.providerId,
      secretRef: patch.secretRef !== undefined ? patch.secretRef : existing.secretRef
    };
    const problems = await routeProblems(next, set.projectId);
    if (problems.length > 0) return invalid(reply, "Invalid route", problems);
    const write: Partial<AiGatewayRouteWrite> = {
      ...(patch.alias !== undefined ? { alias: patch.alias } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl ?? null } : {}),
      ...(patch.secretRef !== undefined ? { secretId: patch.secretRef?.secretId ?? null } : {}),
      ...(patch.extra !== undefined ? { extra: patch.extra } : {}),
      ...(patch.defaults !== undefined ? { defaults: patch.defaults } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {})
    };
    let updated: AiGatewayRoute | null;
    try {
      updated = await store.updateAiGatewayRoute(existing.id, write);
    } catch (error) {
      return aliasTaken(reply, error);
    }
    if (!updated) return notFound(reply, "Route");
    await deps.auditUser(request, user, {
      eventType: "ai_gateway.route.updated",
      category: "system",
      action: "update",
      resourceType: "ai_gateway_route",
      resourceId: updated.id,
      projectId: set.projectId,
      metadata: { routeSetId: set.id, fields: Object.keys(patch), from: routeAudit(existing), to: routeAudit(updated) }
    });
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/api/ai-gateway/routes/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const existing = await store.getAiGatewayRoute(request.params.id);
    if (!existing) return notFound(reply, "Route");
    const set = await store.getAiGatewayRouteSet(existing.routeSetId);
    await store.deleteAiGatewayRoute(existing.id);
    await deps.auditUser(request, user, {
      eventType: "ai_gateway.route.deleted",
      category: "system",
      action: "delete",
      resourceType: "ai_gateway_route",
      resourceId: existing.id,
      projectId: set?.projectId ?? null,
      metadata: { routeSetId: existing.routeSetId, ...routeAudit(existing) }
    });
    reply.code(204);
    return null;
  });

  // ---------------------------------------------------------------------------
  // Client grants (A1: the client's own token, plus the route sets it may call)
  // ---------------------------------------------------------------------------

  app.get<{ Params: { clientId: string } }>("/api/ai-gateway/clients/:clientId/grants", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const client = await store.getMcpClient(request.params.clientId);
    if (!client) return notFound(reply, "Client");
    return { clientId: client.id, routeSetIds: await store.listAiGatewayClientGrants(client.id) };
  });

  app.put<{ Params: { clientId: string }; Body: unknown }>("/api/ai-gateway/clients/:clientId/grants", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const client = await store.getMcpClient(request.params.clientId);
    if (!client) return notFound(reply, "Client");
    const parsed = aiGatewayGrantsInputSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, "Invalid grants", issues(parsed.error));
    const ids = [...new Set(parsed.data.routeSetIds)];
    if (client.revokedAt && ids.length > 0) {
      reply.code(409);
      return { error: "This client is revoked; it can no longer call the gateway" };
    }
    const missing: string[] = [];
    for (const id of ids) if (!(await store.getAiGatewayRouteSet(id))) missing.push(id);
    if (missing.length > 0) return invalid(reply, "Invalid grants", missing.map((id) => ({ path: "routeSetIds", message: `Route set '${id}' does not exist` })));
    const before = await store.listAiGatewayClientGrants(client.id);
    const after = await store.setAiGatewayClientGrants(client.id, ids, user.id);
    await deps.auditUser(request, user, {
      eventType: "ai_gateway.grants.updated",
      category: "system",
      action: "update",
      resourceType: "mcp_client",
      resourceId: client.id,
      metadata: { from: before, to: after }
    });
    return { clientId: client.id, routeSetIds: after };
  });

  // ---------------------------------------------------------------------------
  // A route set's rule set binding (it stands where a toolset's does for /v1 calls)
  // ---------------------------------------------------------------------------

  const guardFail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof GuardValidationError) return invalid(reply, error.message, error.issues);
    if (error instanceof GuardConflictError) {
      reply.code(409);
      return { error: error.message };
    }
    if (error instanceof GuardNotFoundError) return notFound(reply, "rule set");
    throw error;
  };

  const guardView = async (guard: GuardService, set: AiGatewayRouteSet) => ({
    binding: { scope: "ai_route_set", scopeId: set.id, ...(await guard.getBinding("ai_route_set", set.id)) },
    effective: guard.resolutionView((await guard.resolveGateway({ toolsetId: set.id, clientId: "", projectId: set.projectId, setScope: "ai_route_set" })).resolution)
  });

  app.get<{ Params: { id: string } }>("/api/ai-gateway/route-sets/:id/guard", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    if (!deps.guard) return notFound(reply, "Content rules");
    const set = await store.getAiGatewayRouteSet(request.params.id);
    if (!set) return notFound(reply, "Route set");
    return await guardView(deps.guard, set);
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/ai-gateway/route-sets/:id/guard", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    if (!deps.guard) return notFound(reply, "Content rules");
    const set = await store.getAiGatewayRouteSet(request.params.id);
    if (!set) return notFound(reply, "Route set");
    const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
    if (body.mode === "enforced") {
      return invalid(reply, "Invalid binding", [{ path: "mode", message: "Only a project can enforce a rule set; a route set or client overrides" }]);
    }
    const parsed = guardGatewayBindingInputSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, "Invalid binding", issues(parsed.error));
    try {
      const current = await deps.guard.getBinding("ai_route_set", set.id);
      await deps.guard.setBinding("ai_route_set", set.id, parsed.data, user.id);
      await deps.auditUser(request, user, {
        eventType: "guard.binding.updated",
        category: "system",
        action: "update",
        resourceType: "ai_gateway_route_set",
        resourceId: set.id,
        projectId: set.projectId,
        metadata: { scope: "ai_route_set", from: { mode: current.mode, profileId: current.profileId }, to: { mode: parsed.data.mode, profileId: parsed.data.profileId ?? null } }
      });
      return await guardView(deps.guard, set);
    } catch (error) {
      return guardFail(reply, error);
    }
  });

  // ---------------------------------------------------------------------------
  // Usage (metadata only)
  // ---------------------------------------------------------------------------

  const usageFilter = (reply: FastifyReply, query: Record<string, unknown>) => {
    const window = parseMcpTelemetryWindow(query.window);
    if (!window) return { error: invalid(reply, "Invalid window", [{ path: "window", message: `Use one of: ${Object.keys(MCP_TELEMETRY_WINDOWS).join(", ")}` }]) };
    const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
    const clientId = str(query.clientId);
    const routeSetId = str(query.routeSetId);
    return {
      window,
      filter: {
        from: new Date(Date.now() - MCP_TELEMETRY_WINDOWS[window]).toISOString(),
        ...(clientId ? { clientId } : {}),
        ...(routeSetId ? { routeSetId } : {})
      }
    };
  };

  app.get<{ Querystring: Record<string, unknown> }>("/api/ai-gateway/usage", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = usageFilter(reply, request.query);
    if ("error" in parsed) return parsed.error;
    return { window: parsed.window, ...(await store.summarizeAiGatewayUsage(parsed.filter)) };
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/ai-gateway/requests", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = usageFilter(reply, request.query);
    if ("error" in parsed) return parsed.error;
    const limit = Math.min(MAX_REQUEST_ROWS, Math.max(1, Number(request.query.limit) || 50));
    return { window: parsed.window, requests: await store.listAiGatewayRequests({ ...parsed.filter, limit }) };
  });
}
