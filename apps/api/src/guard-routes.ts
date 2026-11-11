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
  GUARD_EVENT_ACTION_VALUES,
  GUARD_BUILTIN_PROFILE_ID,
  GUARD_DESTINATION_RULES_PROFILE_ID,
  GUARD_EVENT_CHANNEL_VALUES,
  REVEAL_RULES_ADMIN_ONLY_MESSAGE,
  destinationRulesEnforcementSchema,
  guardDocumentHasRevealRules,
  destinationRulesUpdateSchema,
  guardGatewayBindingInputSchema,
  guardProfileCreateSchema,
  guardProfileUpdateSchema,
  guardProjectBindingInputSchema,
  guardWorkflowBindingInputSchema,
  type Workflow
} from "@ai-orchestrator/shared";
import type { GuardEventFilters } from "./db/database.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import { GuardConflictError, GuardNotFoundError, GuardValidationError, type GuardFieldIssue, type GuardSaveActor, type GuardService } from "./services/guard-service.js";
import type { RunAccess } from "./run-access.js";
import type { Store } from "./db/store.js";
import { filterAsync } from "./async-array.js";

export interface GuardRoutesDeps {
  app: FastifyInstance;
  store: Store;
  guard: GuardService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  /** Run-level access: a run of a workflow the user cannot read answers 404. */
  runAccess: RunAccess;
  canAccessWorkflow: (user: SafeUser, workflow: { id: string; projectId?: string }, permission: "workflow:read" | "workflow:write") => Promise<boolean>;
  /** Project-level permission (memberships, then the global role); admins always pass. */
  canInProject: (user: SafeUser, projectId: string, permission: "workflow:read" | "workflow:write") => Promise<boolean>;
  /** Phase 12 coverage — whether the user may use a stored secret in a run (a rule set's check model may name one). */
  canUseSecret: (user: SafeUser, secretId: string) => Promise<boolean>;
  audit: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void | Promise<void>;
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
    ...(channel && (GUARD_EVENT_CHANNEL_VALUES as readonly string[]).includes(channel) ? { channel } : {}),
    // Phase 12 coverage — `reveal` is an event action (a Reveal node's events), not a rule action.
    ...(action && (GUARD_EVENT_ACTION_VALUES as readonly string[]).includes(action) ? { action } : {}),
    ...(since && !Number.isNaN(Date.parse(since)) ? { since: new Date(since).toISOString() } : {}),
    ...(query.findings === "true" || query.findings === "1" ? { onlyFindings: true } : {}),
    // 12.6 — gateway server tool calls, or workflow runs only.
    ...(query.placement === "gateway" || query.placement === "run" || query.placement === "response" || query.placement === "request" ? { placement: query.placement } : {}),
    // 12.7 — eval runs and replay jobs (red-team suites among them) stay out unless asked for.
    ...(query.includeEval === "true" || query.includeEval === "1" ? {} : { excludeEvalRuns: true }),
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
  const refuseEnforcedEdit = async (user: SafeUser, reply: FastifyReply, profileId: string) => {
    if (user.role === "admin") return null;
    // Phase 16 — the deployment's destination rules apply to every run: admin-only, like an enforced profile.
    if (profileId === GUARD_DESTINATION_RULES_PROFILE_ID) {
      reply.code(403);
      return { error: "The deployment's destination rules apply to every workflow; only an admin can change them" };
    }
    const enforcedBy = (await store.listGuardBindingsForProfile(profileId)).filter((binding) => binding.scope === "project" && binding.mode === "enforced");
    if (enforcedBy.length === 0) return null;
    reply.code(403);
    return { error: "This rule set is enforced on a project; only an admin can change it" };
  };

  /**
   * Phase 12 coverage — only an admin may save a rule set that carries reveal rules (who may turn tokens back into
   * values). A refused save is audited as denied.
   */
  const refuseRevealRules = async (request: FastifyRequest, user: SafeUser, reply: FastifyReply, document: unknown, profileId: string, operation: "create" | "import" | "update") => {
    if (!guardDocumentHasRevealRules(document)) return null;
    if (user.role === "admin") {
      const problem = await revealSubjectProblem(document);
      if (!problem) return null;
      reply.code(400);
      return { error: problem };
    }
    await deps.audit(request, user, {
      eventType: "guard.profile.reveal_rules_denied",
      category: "system",
      action: operation,
      outcome: "denied",
      resourceType: "guard_profile",
      ...(profileId ? { resourceId: profileId } : {}),
      message: REVEAL_RULES_ADMIN_ONLY_MESSAGE
    });
    reply.code(403);
    return { error: REVEAL_RULES_ADMIN_ONLY_MESSAGE };
  };

  /**
   * Phase 12 coverage — reveal rule subjects name the right kind of account: `serviceAccounts` only service accounts,
   * `users` only people (a service account listed there would never match: its runs match only by service account).
   */
  const revealSubjectProblem = async (document: unknown): Promise<string | null> => {
    const rules = ((document as { reveal?: { rules?: unknown } }).reveal?.rules ?? []) as unknown[];
    for (const [index, rule] of rules.entries()) {
      const subjects = (rule && typeof rule === "object" ? (rule as { subjects?: Record<string, unknown> }).subjects : undefined) ?? {};
      const ids = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
      for (const id of ids(subjects.serviceAccounts)) {
        const found = await deps.store.getUserById(id);
        if (found?.kind !== "service") return `Reveal rule ${index + 1}: '${id}' is not a service account`;
      }
      for (const id of ids(subjects.users)) {
        const found = await deps.store.getUserById(id);
        if (found?.kind === "service") return `Reveal rule ${index + 1}: '${id}' is a service account; list it under service accounts`;
      }
    }
    return null;
  };

  const saveActor = (user: SafeUser): GuardSaveActor => ({ admin: user.role === "admin", canUseSecret: async (secretId) => await deps.canUseSecret(user, secretId) });

  const forbidden = (reply: FastifyReply) => {
    reply.code(403);
    return { error: "Insufficient permissions for project" };
  };

  /** Workflows a non-admin may read, for scoping guard events; undefined for admins (no filter). */
  const readableWorkflowIds = async (user: SafeUser): Promise<string[] | undefined> => await deps.runAccess.readableWorkflowIds(user) ?? undefined;

  // ---------------------------------------------------------------------------
  // Profiles
  // ---------------------------------------------------------------------------

  app.get("/api/guard/profiles", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    return { profiles: await guard.listProfiles(), autoApply: guard.autoApply, builtInId: GUARD_BUILTIN_PROFILE_ID };
  });

  app.post<{ Body: unknown }>("/api/guard/profiles", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const parsed = guardProfileCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid rule set", issues: zodIssues(parsed.error.issues) };
    }
    const createId = parsed.data.id ?? (typeof parsed.data.document.id === "string" ? parsed.data.document.id : "");
    const refusedCreate = createId ? await refuseEnforcedEdit(user, reply, createId) : null;
    if (refusedCreate) return refusedCreate;
    const refusedReveal = await refuseRevealRules(request, user, reply, parsed.data.document, createId, "create");
    if (refusedReveal) return refusedReveal;
    try {
      const profile = await guard.createProfile(parsed.data, user.id, { actor: saveActor(user) });
      await deps.audit(request, user, { eventType: "guard.profile.created", category: "system", action: "create", resourceType: "guard_profile", resourceId: profile.id, metadata: { version: 1, hash: profile.hash } });
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
        return { error: "Invalid rule set", issues: [{ path: "text", message: "Not valid JSON" }] };
      }
    }
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      reply.code(400);
      return { error: "Invalid rule set", issues: [{ path: "document", message: "Expected a rule set document object" }] };
    }
    const importId = typeof (document as Record<string, unknown>).id === "string" ? ((document as Record<string, unknown>).id as string) : "";
    const refused = importId ? await refuseEnforcedEdit(user, reply, importId) : null;
    if (refused) return refused;
    const refusedReveal = await refuseRevealRules(request, user, reply, document, importId, "import");
    if (refusedReveal) return refusedReveal;
    try {
      const result = await guard.importProfile({ document: document as Record<string, unknown>, ...(str(body.note) ? { note: str(body.note) } : {}) }, user.id, saveActor(user));
      await deps.audit(request, user, {
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
    const found = await guard.getProfile(request.params.id);
    if (!found) {
      reply.code(404);
      return { error: "Rule set not found" };
    }
    const bindings = await filterAsync(await store.listGuardBindingsForProfile(request.params.id), async (binding) => {
      if (binding.mode === "inherit") return false;
      if (binding.scope === "project") return await deps.canInProject(user, binding.scopeId, "workflow:read");
      const workflow = await store.getWorkflow(binding.scopeId);
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
      return { error: "Invalid rule set", issues: zodIssues(parsed.error.issues) };
    }
    const refused = await refuseEnforcedEdit(user, reply, request.params.id);
    if (refused) return refused;
    const refusedReveal = await refuseRevealRules(request, user, reply, parsed.data.document, request.params.id, "update");
    if (refusedReveal) return refusedReveal;
    try {
      const result = await guard.updateProfile(request.params.id, parsed.data, user.id, saveActor(user));
      if (result.changed) {
        await deps.audit(request, user, {
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
    const refusedDelete = await refuseEnforcedEdit(user, reply, request.params.id);
    if (refusedDelete) return refusedDelete;
    try {
      await guard.deleteProfile(request.params.id);
      await deps.audit(request, user, { eventType: "guard.profile.deleted", category: "system", action: "delete", resourceType: "guard_profile", resourceId: request.params.id });
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  // ---------------------------------------------------------------------------
  // Phase 16 — the deployment's destination rules (Security page)
  // ---------------------------------------------------------------------------

  const rulesStatus = async (user: SafeUser) => {
    const status = await guard.destinationRulesStatus();
    return user.role === "admin" ? status : { ...status, observing: null };
  };

  app.get("/api/guard/destination-rules", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    return await rulesStatus(user);
  });

  app.post("/api/guard/destination-rules/starter", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    try {
      const { status, created } = await guard.addStarterDestinationRule(user.id);
      if (created) {
        await deps.audit(request, user, {
          eventType: "guard.destination_rules.starter_added",
          category: "system",
          action: "update",
          resourceType: "guard_profile",
          resourceId: GUARD_DESTINATION_RULES_PROFILE_ID,
          metadata: { version: status.version, mode: status.mode }
        });
      }
      reply.code(created ? 201 : 200);
      return status;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/api/guard/destination-rules/enforcement", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = destinationRulesEnforcementSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Send { enforce: true } or { enforce: false }", issues: zodIssues(parsed.error.issues) };
    }
    try {
      const status = await guard.setDestinationRulesEnforcement(parsed.data.enforce, user.id);
      await deps.audit(request, user, {
        eventType: parsed.data.enforce ? "guard.destination_rules.enforced" : "guard.destination_rules.observing",
        category: "system",
        action: "update",
        resourceType: "guard_profile",
        resourceId: GUARD_DESTINATION_RULES_PROFILE_ID,
        metadata: { version: status.version, mode: status.mode }
      });
      return status;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.put<{ Body: unknown }>("/api/guard/destination-rules", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = destinationRulesUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid destination rules", issues: zodIssues(parsed.error.issues) };
    }
    try {
      const status = await guard.setDestinationRules(parsed.data.rules, user.id, parsed.data.note);
      await deps.audit(request, user, {
        eventType: "guard.destination_rules.updated",
        category: "system",
        action: "update",
        resourceType: "guard_profile",
        resourceId: GUARD_DESTINATION_RULES_PROFILE_ID,
        metadata: { version: status.version, rules: status.rules.length, mode: status.mode }
      });
      return status;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/guard/profiles/:id/versions", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    if (!await store.getGuardProfile(request.params.id)) {
      reply.code(404);
      return { error: "Rule set not found" };
    }
    return { versions: await guard.listVersions(request.params.id) };
  });

  app.get<{ Params: { id: string; version: string } }>("/api/guard/profiles/:id/versions/:version", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const version = await guard.getVersion(request.params.id, Number(request.params.version));
    if (!version) {
      reply.code(404);
      return { error: "Rule set version not found" };
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
    const diff = await guard.diff(request.params.id, from, to);
    if (!diff) {
      reply.code(404);
      return { error: "Rule set version not found" };
    }
    return diff;
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>("/api/guard/profiles/:id/export", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const version = request.query.version !== undefined ? Number(request.query.version) : undefined;
    const exported = await guard.exportProfile(request.params.id, Number.isInteger(version) ? version : undefined);
    if (!exported) {
      reply.code(404);
      return { error: "Rule set not found" };
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

  const projectBindingView = async (projectId: string) => {
    const binding = await guard.getBinding("project", projectId);
    return { projectId, ...binding, locked: binding.mode === "enforced" };
  };

  app.get<{ Params: { projectId: string } }>("/api/guard/bindings/projects/:projectId", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    if (!await store.getProject(request.params.projectId)) {
      reply.code(404);
      return { error: "Project not found" };
    }
    if (!await deps.canInProject(user, request.params.projectId, "workflow:read")) return forbidden(reply);
    return {
      binding: await projectBindingView(request.params.projectId),
      effective: guard.resolutionView(await guard.resolveRun({ workflowId: "", projectId: request.params.projectId }))
    };
  });

  app.put<{ Params: { projectId: string }; Body: unknown }>("/api/guard/bindings/projects/:projectId", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const projectId = request.params.projectId;
    if (!await store.getProject(projectId)) {
      reply.code(404);
      return { error: "Project not found" };
    }
    if (!await deps.canInProject(user, projectId, "workflow:write")) return forbidden(reply);
    const parsed = guardProjectBindingInputSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid binding", issues: zodIssues(parsed.error.issues) };
    }
    const current = await guard.getBinding("project", projectId);
    if (user.role !== "admin" && (parsed.data.mode === "enforced" || current.mode === "enforced")) {
      reply.code(403);
      return {
        error:
          current.mode === "enforced"
            ? "This project's rule set is enforced by an admin; only an admin can change it"
            : "Only an admin can enforce a rule set"
      };
    }
    try {
      await guard.setBinding("project", projectId, parsed.data, user.id);
      await deps.audit(request, user, {
        eventType: "guard.binding.updated",
        category: "project",
        action: "update",
        resourceType: "project",
        resourceId: projectId,
        projectId,
        metadata: { scope: "project", from: { mode: current.mode, profileId: current.profileId }, to: { mode: parsed.data.mode, profileId: parsed.data.profileId ?? null } }
      });
      return {
        binding: await projectBindingView(projectId),
        effective: guard.resolutionView(await guard.resolveRun({ workflowId: "", projectId }))
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  const workflowFor = async (request: FastifyRequest, reply: FastifyReply, workflowId: string, permission: "workflow:read" | "workflow:write", roles: UserRole[]) => {
    const user = await requireRole(request, reply, roles);
    if (!user) return null;
    // An unreadable workflow reads as missing; a readable one without the permission is 403.
    const access = await deps.runAccess.workflow(user, workflowId, permission);
    if (!access.ok) {
      reply.code(access.status);
      reply.send({ error: access.status === 404 ? "Workflow not found" : "Insufficient permissions" });
      return null;
    }
    return { user, workflow: access.workflow };
  };

  const workflowBindingResponse = async (workflow: Workflow) => {
    const projectId = workflow.projectId ?? "default";
    return {
      binding: { workflowId: workflow.id, ...await guard.getBinding("workflow", workflow.id) },
      project: await projectBindingView(projectId),
      effective: guard.resolutionView(await guard.resolveRun({ workflowId: workflow.id, projectId }))
    };
  };

  app.get<{ Params: { workflowId: string } }>("/api/guard/bindings/workflows/:workflowId", async (request, reply) => {
    const found = await workflowFor(request, reply, request.params.workflowId, "workflow:read", ["viewer"]);
    if (!found) return;
    return await workflowBindingResponse(found.workflow);
  });

  app.put<{ Params: { workflowId: string }; Body: unknown }>("/api/guard/bindings/workflows/:workflowId", async (request, reply) => {
    const found = await workflowFor(request, reply, request.params.workflowId, "workflow:write", ["builder"]);
    if (!found) return;
    const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
    if (body.mode === "enforced") {
      reply.code(400);
      return { error: "Invalid binding", issues: [{ path: "mode", message: "Only a project can enforce a rule set; set it on the project" }] };
    }
    const parsed = guardWorkflowBindingInputSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid binding", issues: zodIssues(parsed.error.issues) };
    }
    try {
      const current = await guard.getBinding("workflow", found.workflow.id);
      await guard.setBinding("workflow", found.workflow.id, parsed.data, found.user.id);
      await deps.audit(request, found.user, {
        eventType: "guard.binding.updated",
        category: "workflow",
        action: "update",
        resourceType: "workflow",
        resourceId: found.workflow.id,
        projectId: found.workflow.projectId ?? "default",
        metadata: { scope: "workflow", from: { mode: current.mode, profileId: current.profileId }, to: { mode: parsed.data.mode, profileId: parsed.data.profileId ?? null } }
      });
      return await workflowBindingResponse(found.workflow);
    } catch (error) {
      return fail(reply, error);
    }
  });

  // ---------------------------------------------------------------------------
  // 12.6 — MCP gateway toolsets and clients. Builders read (the toolset and client pages show them); only admins set
  // or change one, as with the rest of a toolset or client. Every change is audited.
  // ---------------------------------------------------------------------------

  const gatewayBindingView = async (scope: "toolset" | "mcp_client", scopeId: string) => ({ scope, scopeId, ...await guard.getBinding(scope, scopeId) });

  const toolsetEffective = async (toolset: { id: string; projectId: string | null }, clientId = "") =>
    guard.resolutionView((await guard.resolveGateway({ toolsetId: toolset.id, clientId, projectId: toolset.projectId })).resolution);

  const toolsetBindingResponse = async (toolset: { id: string; projectId: string | null }) => ({
    binding: await gatewayBindingView("toolset", toolset.id),
    effective: await toolsetEffective(toolset)
  });

  const clientBindingResponse = async (client: { id: string; toolsetIds: string[] }) => {
    const toolsets: Array<{ toolsetId: string; effective: ReturnType<typeof guard.resolutionView> }> = [];
    for (const toolsetId of client.toolsetIds) {
      const toolset = await store.getMcpToolset(toolsetId);
      if (toolset) toolsets.push({ toolsetId, effective: await toolsetEffective(toolset, client.id) });
    }
    return { binding: await gatewayBindingView("mcp_client", client.id), toolsets };
  };

  const gatewayBindingInput = (reply: FastifyReply, body: unknown) => {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    if (record.mode === "enforced") {
      reply.code(400);
      return { error: { error: "Invalid binding", issues: [{ path: "mode", message: "Only a project can enforce a rule set; a toolset or client overrides" }] } };
    }
    const parsed = guardGatewayBindingInputSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return { error: { error: "Invalid binding", issues: zodIssues(parsed.error.issues) } };
    }
    return { input: parsed.data };
  };

  app.get<{ Params: { toolsetId: string } }>("/api/guard/bindings/toolsets/:toolsetId", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const toolset = await store.getMcpToolset(request.params.toolsetId);
    if (!toolset) {
      reply.code(404);
      return { error: "Toolset not found" };
    }
    return await toolsetBindingResponse(toolset);
  });

  app.put<{ Params: { toolsetId: string }; Body: unknown }>("/api/guard/bindings/toolsets/:toolsetId", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const toolset = await store.getMcpToolset(request.params.toolsetId);
    if (!toolset) {
      reply.code(404);
      return { error: "Toolset not found" };
    }
    const parsed = gatewayBindingInput(reply, request.body);
    if ("error" in parsed) return parsed.error;
    try {
      const current = await guard.getBinding("toolset", toolset.id);
      await guard.setBinding("toolset", toolset.id, parsed.input, user.id);
      await deps.audit(request, user, {
        eventType: "guard.binding.updated",
        category: "system",
        action: "update",
        resourceType: "mcp_toolset",
        resourceId: toolset.id,
        projectId: toolset.projectId,
        metadata: { scope: "toolset", from: { mode: current.mode, profileId: current.profileId }, to: { mode: parsed.input.mode, profileId: parsed.input.profileId ?? null } }
      });
      return await toolsetBindingResponse(toolset);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Params: { clientId: string } }>("/api/guard/bindings/clients/:clientId", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    const client = await store.getMcpClient(request.params.clientId);
    if (!client) {
      reply.code(404);
      return { error: "Client not found" };
    }
    return await clientBindingResponse(client);
  });

  app.put<{ Params: { clientId: string }; Body: unknown }>("/api/guard/bindings/clients/:clientId", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const client = await store.getMcpClient(request.params.clientId);
    if (!client) {
      reply.code(404);
      return { error: "Client not found" };
    }
    if (client.revokedAt) {
      reply.code(409);
      return { error: "This client is revoked; it can no longer call the gateway" };
    }
    const parsed = gatewayBindingInput(reply, request.body);
    if ("error" in parsed) return parsed.error;
    try {
      const current = await guard.getBinding("mcp_client", client.id);
      await guard.setBinding("mcp_client", client.id, parsed.input, user.id);
      await deps.audit(request, user, {
        eventType: "guard.binding.updated",
        category: "system",
        action: "update",
        resourceType: "mcp_client",
        resourceId: client.id,
        metadata: { scope: "mcp_client", from: { mode: current.mode, profileId: current.profileId }, to: { mode: parsed.input.mode, profileId: parsed.input.profileId ?? null } }
      });
      return await clientBindingResponse(client);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/guard/effective", async (request, reply) => {
    const workflowId = str(request.query.workflowId);
    if (workflowId) {
      const found = await workflowFor(request, reply, workflowId, "workflow:read", ["viewer"]);
      if (!found) return;
      return await workflowBindingResponse(found.workflow);
    }
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const projectId = str(request.query.projectId) ?? "default";
    if (!await deps.canInProject(user, projectId, "workflow:read")) return forbidden(reply);
    return { project: await projectBindingView(projectId), effective: guard.resolutionView(await guard.resolveRun({ workflowId: "", projectId })) };
  });

  // ---------------------------------------------------------------------------
  // Events and the Security page
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/executions/:id/guard-events", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const access = await deps.runAccess.run(user, await store.getExecutionHistory(request.params.id), "workflow:read");
    if (!access.ok) {
      reply.code(access.status);
      return { error: access.error };
    }
    return { events: await guard.eventsForExecution(request.params.id) };
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/guard/events", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const workflowIds = await readableWorkflowIds(user);
    const filters = { ...eventFilters(request.query), ...(workflowIds ? { workflowIds } : {}) };
    const { events, total } = await guard.listEvents(filters);
    const names = new Map<string, string>();
    for (const event of events) {
      if (event.workflowId && !names.has(event.workflowId)) names.set(event.workflowId, (await store.getWorkflow(event.workflowId))?.name ?? event.workflowId);
    }
    // 13.3 — a rule event can outlive its run (a project keeps rule events longer than runs): say the run is gone instead of linking
    // to a run that is gone. Gateway events name a gateway call, not a run.
    const runIds = [...new Set(events.filter((event) => event.placement !== "gateway").map((event) => event.executionId))];
    const existing = new Set(runIds.length > 0 ? await store.listExistingExecutionIds(runIds) : []);
    return {
      events: events.map((event) => ({
        ...event,
        workflowName: event.workflowId ? names.get(event.workflowId) : undefined,
        ...(event.placement !== "gateway" && !existing.has(event.executionId) ? { runDeleted: true } : {})
      })),
      total
    };
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/guard/stats", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    const query = { days: 14, ...request.query };
    const workflowIds = await readableWorkflowIds(user);
    const filters = { ...eventFilters(query), ...(workflowIds ? { workflowIds } : {}) };
    return { since: filters.since ?? null, stats: await guard.stats(filters) };
  });
}
