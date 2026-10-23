/**
 * Phase 12.1 — Guard routes:
 *
 *   - profiles: list, read, create, edit (each edit is a new immutable
 *     version), delete, versions, diff between versions, export and import
 *     of the profile document as JSON. Admins and builders write; operators
 *     and viewers read. The built-in `default` profile is read-only.
 *   - bindings: per project (`inherit` | `override` | `enforced`) and per
 *     workflow (`inherit` | `override`). Only admins set, change or remove an
 *     enforced project binding; builders cannot replace it.
 *   - the effective profile for a workflow or project, with the binding chain;
 *   - guard events (masked evidence only) for one execution and across runs,
 *     and the grouped counts behind the Security page;
 *   - the detector catalogue the profile editor offers per channel.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createDefaultGuardRegistry, GUARD_CHANNELS, type GuardChannel } from "@ai-orchestrator/guard-sdk";
import {
  GUARD_ACTION_VALUES,
  GUARD_BUILTIN_PROFILE_ID,
  GUARD_CHANNEL_VALUES,
  guardProfileCreateSchema,
  guardProfileUpdateSchema,
  guardProjectBindingInputSchema,
  guardWorkflowBindingInputSchema,
  type Workflow
} from "@ai-orchestrator/shared";
import type { GuardEventFilters, SqliteStore } from "./db/database.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import { GuardConflictError, GuardNotFoundError, GuardValidationError, type GuardFieldIssue, type GuardService } from "./services/guard-service.js";
import type { RunAccess } from "./run-access.js";

export interface GuardRoutesDeps {
  app: FastifyInstance;
  store: SqliteStore;
  guard: GuardService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  /** Run-level access: a run of a workflow the user cannot read answers 404. */
  runAccess: RunAccess;
  canAccessWorkflow: (user: SafeUser, workflow: { id: string; projectId?: string }, permission: "workflow:read" | "workflow:write") => boolean;
  /** Project-level permission (memberships, then the global role); admins always pass. */
  canInProject: (user: SafeUser, projectId: string, permission: "workflow:read" | "workflow:write") => boolean;
  audit: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function zodIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>, prefix?: string): GuardFieldIssue[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return { path: [prefix, path].filter(Boolean).join(".") || "(root)", message: issue.message };
  });
}

function eventFilters(query: Record<string, unknown>): GuardEventFilters & { limit?: number; offset?: number } {
  const channel = str(query.channel);
  const action = str(query.action);
  const days = Number(query.days);
  const since = str(query.since) ?? (Number.isFinite(days) && days > 0 ? new Date(Date.now() - Math.min(days, 366) * 86_400_000).toISOString() : undefined);
  const limit = Number(query.limit);
  const offset = Number(query.offset);
  return {
    ...(str(query.projectId) ? { projectId: str(query.projectId) } : {}),
    ...(str(query.workflowId) ? { workflowId: str(query.workflowId) } : {}),
    ...(str(query.profileId) ? { profileId: str(query.profileId) } : {}),
    ...(channel && (GUARD_CHANNEL_VALUES as readonly string[]).includes(channel) ? { channel } : {}),
    ...(action && (GUARD_ACTION_VALUES as readonly string[]).includes(action) ? { action } : {}),
    ...(since && !Number.isNaN(Date.parse(since)) ? { since: new Date(since).toISOString() } : {}),
    ...(query.findings === "true" || query.findings === "1" ? { onlyFindings: true } : {}),
    ...(Number.isFinite(limit) ? { limit } : {}),
    ...(Number.isFinite(offset) ? { offset } : {})
  };
}

export function registerGuardRoutes(deps: GuardRoutesDeps): void {
  const { app, store, guard, requireRole } = deps;

  /** Maps service errors to responses; field-level issues on validation errors. */
  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof GuardValidationError) {
      reply.code(400);
      return { error: error.message, issues: error.issues };
    }
    if (error instanceof GuardConflictError) {
      reply.code(409);
      return { error: error.message };
    }
    if (error instanceof GuardNotFoundError) {
      reply.code(404);
      return { error: error.message };
    }
    throw error;
  };

  /**
   * An enforced profile is the admin's floor for a project: a builder who
   * could append a version to it would loosen every run it covers. Edits and
   * re-imports of a profile any project enforces are admin-only.
   */
  const refuseEnforcedEdit = (user: SafeUser, reply: FastifyReply, profileId: string) => {
    if (user.role === "admin") return null;
    const enforcedBy = store.listGuardBindingsForProfile(profileId).filter((binding) => binding.scope === "project" && binding.mode === "enforced");
    if (enforcedBy.length === 0) return null;
    reply.code(403);
    return { error: "This guard profile is enforced on a project; only an admin can change it" };
  };

  const forbidden = (reply: FastifyReply) => {
    reply.code(403);
    return { error: "Insufficient permissions for project" };
  };

  /** Workflows a non-admin may read, for scoping guard events; undefined for admins (no filter). */
  const readableWorkflowIds = (user: SafeUser): string[] | undefined => deps.runAccess.readableWorkflowIds(user) ?? undefined;

  // ---------------------------------------------------------------------------
  // Profiles
  // ---------------------------------------------------------------------------

  app.get("/api/guard/profiles", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    return { profiles: guard.listProfiles(), autoApply: guard.autoApply, builtInId: GUARD_BUILTIN_PROFILE_ID };
  });

  app.post<{ Body: unknown }>("/api/guard/profiles", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = guardProfileCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid guard profile", issues: zodIssues(parsed.error.issues) };
    }
    try {
      const profile = guard.createProfile(parsed.data, user.id);
      deps.audit(request, user, { eventType: "guard.profile.created", category: "system", action: "create", resourceType: "guard_profile", resourceId: profile.id, metadata: { version: 1, hash: profile.hash } });
      reply.code(201);
      return { profile };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/api/guard/profiles/import", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
    let document: unknown = body.document;
    if (document === undefined && typeof body.text === "string") {
      try {
        document = JSON.parse(body.text);
      } catch {
        reply.code(400);
        return { error: "Invalid guard profile", issues: [{ path: "text", message: "Not valid JSON" }] };
      }
    }
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      reply.code(400);
      return { error: "Invalid guard profile", issues: [{ path: "document", message: "Expected a profile document object" }] };
    }
    const importId = typeof (document as Record<string, unknown>).id === "string" ? ((document as Record<string, unknown>).id as string) : "";
    const refused = importId ? refuseEnforcedEdit(user, reply, importId) : null;
    if (refused) return refused;
    try {
      const result = guard.importProfile({ document: document as Record<string, unknown>, ...(str(body.note) ? { note: str(body.note) } : {}) }, user.id);
      deps.audit(request, user, {
        eventType: "guard.profile.imported",
        category: "system",
        action: result.created ? "create" : "update",
        resourceType: "guard_profile",
        resourceId: result.profile.id,
        metadata: { version: result.profile.latestVersion, hash: result.profile.hash, changed: result.changed }
      });
      reply.code(result.created ? 201 : 200);
      return result;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/guard/profiles/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const found = guard.getProfile(request.params.id);
    if (!found) {
      reply.code(404);
      return { error: "Guard profile not found" };
    }
    const bindings = store.listGuardBindingsForProfile(request.params.id).filter((binding) => {
      if (binding.mode === "inherit") return false;
      if (binding.scope === "project") return deps.canInProject(user, binding.scopeId, "workflow:read");
      const workflow = store.getWorkflow(binding.scopeId);
      return workflow ? deps.canAccessWorkflow(user, workflow, "workflow:read") : user.role === "admin";
    });
    return { ...found, bindings };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/guard/profiles/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = guardProfileUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid guard profile", issues: zodIssues(parsed.error.issues) };
    }
    const refused = refuseEnforcedEdit(user, reply, request.params.id);
    if (refused) return refused;
    try {
      const result = guard.updateProfile(request.params.id, parsed.data, user.id);
      if (result.changed) {
        deps.audit(request, user, {
          eventType: "guard.profile.updated",
          category: "system",
          action: "update",
          resourceType: "guard_profile",
          resourceId: request.params.id,
          metadata: { version: result.version.version, hash: result.version.hash }
        });
      }
      return result;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/guard/profiles/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    try {
      guard.deleteProfile(request.params.id);
      deps.audit(request, user, { eventType: "guard.profile.deleted", category: "system", action: "delete", resourceType: "guard_profile", resourceId: request.params.id });
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/guard/profiles/:id/versions", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    if (!store.getGuardProfile(request.params.id)) {
      reply.code(404);
      return { error: "Guard profile not found" };
    }
    return { versions: guard.listVersions(request.params.id) };
  });

  app.get<{ Params: { id: string; version: string } }>("/api/guard/profiles/:id/versions/:version", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const version = guard.getVersion(request.params.id, Number(request.params.version));
    if (!version) {
      reply.code(404);
      return { error: "Guard profile version not found" };
    }
    return { version };
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>("/api/guard/profiles/:id/diff", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const from = Number(request.query.from);
    const to = Number(request.query.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      reply.code(400);
      return { error: "Invalid diff request", issues: [{ path: Number.isInteger(from) ? "to" : "from", message: "Expected a version number" }] };
    }
    const diff = guard.diff(request.params.id, from, to);
    if (!diff) {
      reply.code(404);
      return { error: "Guard profile version not found" };
    }
    return diff;
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>("/api/guard/profiles/:id/export", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const version = request.query.version !== undefined ? Number(request.query.version) : undefined;
    const exported = guard.exportProfile(request.params.id, Number.isInteger(version) ? version : undefined);
    if (!exported) {
      reply.code(404);
      return { error: "Guard profile not found" };
    }
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${exported.fileName}"`);
    reply.header("x-guard-profile-version", String(exported.version));
    reply.header("x-guard-profile-hash", exported.hash);
    return reply.send(exported.body);
  });

  app.get("/api/guard/detectors", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const registry = createDefaultGuardRegistry();
    return {
      channels: GUARD_CHANNELS,
      detectors: registry.list().map((detector) => ({
        id: detector.id,
        tier: detector.tier,
        description: detector.description,
        channels: detector.channels as GuardChannel[],
        categories: detector.categories
      }))
    };
  });

  // ---------------------------------------------------------------------------
  // Bindings and effective profile
  // ---------------------------------------------------------------------------

  const projectBindingView = (projectId: string) => {
    const binding = guard.getBinding("project", projectId);
    return { projectId, ...binding, locked: binding.mode === "enforced" };
  };

  app.get<{ Params: { projectId: string } }>("/api/guard/bindings/projects/:projectId", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    if (!store.getProject(request.params.projectId)) {
      reply.code(404);
      return { error: "Project not found" };
    }
    if (!deps.canInProject(user, request.params.projectId, "workflow:read")) return forbidden(reply);
    return {
      binding: projectBindingView(request.params.projectId),
      effective: guard.resolutionView(guard.resolveRun({ workflowId: "", projectId: request.params.projectId }))
    };
  });

  app.put<{ Params: { projectId: string }; Body: unknown }>("/api/guard/bindings/projects/:projectId", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const projectId = request.params.projectId;
    if (!store.getProject(projectId)) {
      reply.code(404);
      return { error: "Project not found" };
    }
    if (!deps.canInProject(user, projectId, "workflow:write")) return forbidden(reply);
    const parsed = guardProjectBindingInputSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid binding", issues: zodIssues(parsed.error.issues) };
    }
    const current = guard.getBinding("project", projectId);
    if (user.role !== "admin" && (parsed.data.mode === "enforced" || current.mode === "enforced")) {
      reply.code(403);
      return {
        error:
          current.mode === "enforced"
            ? "This project's guard profile is enforced by an admin; only an admin can change it"
            : "Only an admin can enforce a guard profile"
      };
    }
    try {
      guard.setBinding("project", projectId, parsed.data, user.id);
      deps.audit(request, user, {
        eventType: "guard.binding.updated",
        category: "project",
        action: "update",
        resourceType: "project",
        resourceId: projectId,
        projectId,
        metadata: { scope: "project", from: { mode: current.mode, profileId: current.profileId }, to: { mode: parsed.data.mode, profileId: parsed.data.profileId ?? null } }
      });
      return {
        binding: projectBindingView(projectId),
        effective: guard.resolutionView(guard.resolveRun({ workflowId: "", projectId }))
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  const workflowFor = async (request: FastifyRequest, reply: FastifyReply, workflowId: string, permission: "workflow:read" | "workflow:write", roles: UserRole[]) => {
    const user = await requireRole(request, reply, roles);
    if (!user) return null;
    // An unreadable workflow reads as missing; a readable one without the permission is 403.
    const access = deps.runAccess.workflow(user, workflowId, permission);
    if (!access.ok) {
      reply.code(access.status);
      reply.send({ error: access.status === 404 ? "Workflow not found" : "Insufficient permissions" });
      return null;
    }
    return { user, workflow: access.workflow };
  };

  const workflowBindingResponse = (workflow: Workflow) => {
    const projectId = workflow.projectId ?? "default";
    return {
      binding: { workflowId: workflow.id, ...guard.getBinding("workflow", workflow.id) },
      project: projectBindingView(projectId),
      effective: guard.resolutionView(guard.resolveRun({ workflowId: workflow.id, projectId }))
    };
  };

  app.get<{ Params: { workflowId: string } }>("/api/guard/bindings/workflows/:workflowId", async (request, reply) => {
    const found = await workflowFor(request, reply, request.params.workflowId, "workflow:read", ["viewer"]);
    if (!found) return;
    return workflowBindingResponse(found.workflow);
  });

  app.put<{ Params: { workflowId: string }; Body: unknown }>("/api/guard/bindings/workflows/:workflowId", async (request, reply) => {
    const found = await workflowFor(request, reply, request.params.workflowId, "workflow:write", ["builder"]);
    if (!found) return;
    const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
    if (body.mode === "enforced") {
      reply.code(400);
      return { error: "Invalid binding", issues: [{ path: "mode", message: "Only a project can enforce a profile; set it on the project" }] };
    }
    const parsed = guardWorkflowBindingInputSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid binding", issues: zodIssues(parsed.error.issues) };
    }
    try {
      const current = guard.getBinding("workflow", found.workflow.id);
      guard.setBinding("workflow", found.workflow.id, parsed.data, found.user.id);
      deps.audit(request, found.user, {
        eventType: "guard.binding.updated",
        category: "workflow",
        action: "update",
        resourceType: "workflow",
        resourceId: found.workflow.id,
        projectId: found.workflow.projectId ?? "default",
        metadata: { scope: "workflow", from: { mode: current.mode, profileId: current.profileId }, to: { mode: parsed.data.mode, profileId: parsed.data.profileId ?? null } }
      });
      return workflowBindingResponse(found.workflow);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/guard/effective", async (request, reply) => {
    const workflowId = str(request.query.workflowId);
    if (workflowId) {
      const found = await workflowFor(request, reply, workflowId, "workflow:read", ["viewer"]);
      if (!found) return;
      return workflowBindingResponse(found.workflow);
    }
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const projectId = str(request.query.projectId) ?? "default";
    if (!deps.canInProject(user, projectId, "workflow:read")) return forbidden(reply);
    return { project: projectBindingView(projectId), effective: guard.resolutionView(guard.resolveRun({ workflowId: "", projectId })) };
  });

  // ---------------------------------------------------------------------------
  // Events and the Security page
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/executions/:id/guard-events", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const access = deps.runAccess.run(user, store.getExecutionHistory(request.params.id), "workflow:read");
    if (!access.ok) {
      reply.code(access.status);
      return { error: access.error };
    }
    return { events: guard.eventsForExecution(request.params.id) };
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/guard/events", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const workflowIds = readableWorkflowIds(user);
    const filters = { ...eventFilters(request.query), ...(workflowIds ? { workflowIds } : {}) };
    const { events, total } = guard.listEvents(filters);
    const names = new Map<string, string>();
    for (const event of events) {
      if (event.workflowId && !names.has(event.workflowId)) names.set(event.workflowId, store.getWorkflow(event.workflowId)?.name ?? event.workflowId);
    }
    return { events: events.map((event) => ({ ...event, workflowName: event.workflowId ? names.get(event.workflowId) : undefined })), total };
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/guard/stats", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const query = { days: 14, ...request.query };
    const workflowIds = readableWorkflowIds(user);
    const filters = { ...eventFilters(query), ...(workflowIds ? { workflowIds } : {}) };
    return { since: filters.since ?? null, stats: guard.stats(filters) };
  });
}
