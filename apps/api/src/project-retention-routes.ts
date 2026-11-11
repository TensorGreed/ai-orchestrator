/**
 * 13.3 — per-project retention.
 *
 *   GET /api/projects/:id/retention   the project's value per class, what it inherits, and the bounds (project members)
 *   PUT /api/projects/:id/retention   set or clear values (admins and the project's admins; step-up when it is on)
 *
 * A value must fall within RETENTION_MIN_DAYS and RETENTION_MAX_DAYS; 0 (keep forever) only when no maximum is set.
 * Tool calls and rule events are security evidence: only a deployment admin may set them shorter than the deployment's
 * value (a project admin's attempt answers 403 `retention_admin_required` and is audited). Every change is audited
 * (`project.retention.update`) with the values before and after.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  RETENTION_ADMIN_TO_SHORTEN,
  RETENTION_DATA_CLASSES,
  RETENTION_DATA_CLASS_LABELS,
  projectRetentionUpdateSchema,
  retentionDaysProblem,
  retentionShortensDeployment,
  type ProjectRetentionView,
  type RetentionDataClass
} from "@ai-orchestrator/shared";
import type { Store } from "./db/store.js";
import type { RunAccessDenial } from "./run-access.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import type { StepUpAction } from "./services/mfa-policy.js";
import type { RetentionService } from "./services/retention-service.js";

export interface ProjectRetentionRoutesDeps {
  app: FastifyInstance;
  store: Pick<Store, "getProject" | "setRetentionPolicies">;
  retention: Pick<RetentionService, "projectView" | "bounds" | "deploymentRetention">;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  /** Whether the user may read the project (members, and everyone in role isolation); a denial answers 404 or 403. */
  projectAccess: (user: SafeUser, projectId: string) => Promise<{ ok: true } | RunAccessDenial>;
  /** Whether the user holds `project:manage` in the project (its admins; deployment admins hold every permission). */
  canManageProject: (user: SafeUser, projectId: string) => Promise<boolean>;
  requireStepUp: (request: FastifyRequest, reply: FastifyReply, action: StepUpAction) => Promise<boolean>;
  audit: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => Promise<void>;
}

export function registerProjectRetentionRoutes(deps: ProjectRetentionRoutesDeps): void {
  const { app, store, retention, requireRole } = deps;

  /** The project, once the caller may read it; otherwise the reply is sent and null comes back. */
  const readableProject = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return null;
    const project = await store.getProject(request.params.id);
    const access = project ? await deps.projectAccess(user, project.id) : null;
    if (!project || !access || !access.ok) {
      reply.code(access && !access.ok ? access.status : 404).send({ error: access && !access.ok ? access.error : "Project not found" });
      return null;
    }
    return { user, project };
  };
  const mayEdit = async (user: SafeUser, projectId: string) => await deps.canManageProject(user, projectId);
  // A deployment admin: the admin role, not narrowed to some projects.
  const deploymentAdmin = (user: SafeUser) => user.role === "admin" && !(user.projectScope && user.projectScope.length > 0);

  app.get<{ Params: { id: string } }>("/api/projects/:id/retention", async (request, reply): Promise<ProjectRetentionView | undefined> => {
    const found = await readableProject(request, reply);
    if (!found) return undefined;
    return await retention.projectView(found.project.id, await mayEdit(found.user, found.project.id), deploymentAdmin(found.user));
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/retention", async (request, reply) => {
    const found = await readableProject(request, reply);
    if (!found) return undefined;
    const { user, project } = found;
    if (!(await mayEdit(user, project.id))) {
      reply.code(403);
      return { error: "Permission 'project:manage' required in this project" };
    }
    const parsed = projectRetentionUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid retention payload", details: parsed.error.issues };
    }
    const bounds = retention.bounds();
    const values: Partial<Record<RetentionDataClass, number | null>> = {};
    const problems: string[] = [];
    for (const dataClass of RETENTION_DATA_CLASSES) {
      const days = parsed.data.classes[dataClass];
      if (days === undefined) continue;
      const problem = days === null ? null : retentionDaysProblem(days, bounds);
      if (problem) problems.push(`${RETENTION_DATA_CLASS_LABELS[dataClass].label}: ${problem}`);
      values[dataClass] = days;
    }
    if (problems.length > 0) {
      reply.code(400);
      return { error: problems.join("; "), code: "retention_out_of_bounds", bounds };
    }
    // Shortening security evidence below the deployment's value is for deployment admins only.
    if (!deploymentAdmin(user)) {
      const refused = RETENTION_ADMIN_TO_SHORTEN.filter((dataClass) => {
        const days = values[dataClass];
        return typeof days === "number" && retentionShortensDeployment(days, retention.deploymentRetention(dataClass).days);
      });
      if (refused.length > 0) {
        await deps.audit(request, user, {
          category: "project",
          eventType: "project.retention.update_denied",
          action: "update",
          outcome: "failure",
          resourceType: "project",
          resourceId: project.id,
          projectId: project.id,
          metadata: { requested: values, refused, reason: "admin_required_to_shorten" }
        });
        reply.code(403);
        return {
          error: `Only an admin can keep ${refused.map((dataClass) => RETENTION_DATA_CLASS_LABELS[dataClass].label.toLowerCase()).join(" and ")} for less time than the deployment default.`,
          code: "retention_admin_required",
          classes: refused
        };
      }
    }
    if (Object.keys(values).length === 0) return await retention.projectView(project.id, true, deploymentAdmin(user));
    if (!(await deps.requireStepUp(request, reply, "project_retention.change"))) return undefined;
    const previous = await store.setRetentionPolicies({ scopeId: project.id, values, updatedBy: user.email });
    const before = Object.fromEntries(previous.map((policy) => [policy.dataClass, policy.days]));
    const after: Record<string, number | null> = {};
    for (const [dataClass, days] of Object.entries(values)) after[dataClass] = days;
    await deps.audit(request, user, {
      category: "project",
      eventType: "project.retention.update",
      action: "update",
      resourceType: "project",
      resourceId: project.id,
      projectId: project.id,
      // Days per class; a class missing from `before` inherited the deployment's value, null in `after` returns to it.
      metadata: { before, after }
    });
    return await retention.projectView(project.id, true, deploymentAdmin(user));
  });
}
