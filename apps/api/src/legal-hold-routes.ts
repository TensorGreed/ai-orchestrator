/**
 * 13.3 — legal holds.
 *
 *   GET  /api/legal-holds                 holds, newest first (?status=active|released)       hold managers
 *   POST /api/legal-holds                 place a hold (step-up when it is on; audited)        hold managers
 *   GET  /api/legal-holds/status          is a workflow, project or run held (the badge)       anyone who can read it
 *   GET  /api/legal-holds/:id             one hold                                             hold managers
 *   GET  /api/legal-holds/:id/items       the rows a runs or subject hold names, paged         hold managers
 *   POST /api/legal-holds/:id/release     release, with a reason (step-up when it is on)       hold managers
 *
 * Hold managers: admins, and members through a deployment-wide custom role granting `legal_hold:manage`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { legalHoldPlaceSchema, legalHoldReleaseSchema, type LegalHoldStatus } from "@ai-orchestrator/shared";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { StepUpAction } from "./services/mfa-policy.js";
import { LegalHoldRequestError, type LegalHoldService, type LegalHoldStatusView } from "./services/legal-hold-service.js";
import type { RunAccess } from "./run-access.js";
import type { Store } from "./db/store.js";

export interface LegalHoldRoutesDeps {
  app: FastifyInstance;
  store: Store;
  /** The service with `audit` bound to a request: one per request, so the audit row names its actor. */
  service: (request: FastifyRequest, user: SafeUser) => LegalHoldService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  requireStepUp: (request: FastifyRequest, reply: FastifyReply, action: StepUpAction) => Promise<boolean>;
  /** `legal_hold:manage` (deployment-wide). */
  canManage: (user: SafeUser) => Promise<boolean>;
  runAccess: RunAccess;
}

const STATUSES: ReadonlySet<string> = new Set<LegalHoldStatus>(["active", "released"]);

function firstIssue(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  const issue = issues[0];
  if (!issue) return "Invalid request";
  return issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ${issue.message}` : issue.message;
}

function queryNumber(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

export function registerLegalHoldRoutes(deps: LegalHoldRoutesDeps): void {
  const { app, requireRole, requireStepUp, canManage, runAccess } = deps;

  /** A signed-in hold manager, or null after answering 401/403. */
  const manager = async (request: FastifyRequest, reply: FastifyReply): Promise<SafeUser | null> => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return null;
    if (!(await canManage(user))) {
      reply.code(403).send({ error: "Managing legal holds needs the legal_hold:manage permission (admins have it)." });
      return null;
    }
    return user;
  };

  const refuse = (reply: FastifyReply, error: unknown) => {
    if (error instanceof LegalHoldRequestError) {
      reply.code(error.status);
      return { error: error.message };
    }
    throw error;
  };

  app.get<{ Querystring: { status?: string } }>("/api/legal-holds", async (request, reply) => {
    const user = await manager(request, reply);
    if (!user) return reply;
    const status = request.query?.status;
    if (status !== undefined && !STATUSES.has(status)) {
      reply.code(400);
      return { error: "status is active or released" };
    }
    return { holds: await deps.service(request, user).list(status ? { status: status as LegalHoldStatus } : {}) };
  });

  app.post<{ Body: unknown }>("/api/legal-holds", async (request, reply) => {
    const user = await manager(request, reply);
    if (!user) return reply;
    if (!(await requireStepUp(request, reply, "legal_hold.change"))) return reply;
    const parsed = legalHoldPlaceSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: firstIssue(parsed.error.issues), details: parsed.error.issues };
    }
    try {
      const hold = await deps.service(request, user).place(parsed.data, { userId: user.id, email: user.email });
      reply.code(201);
      return { hold };
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.get<{ Querystring: { workflowId?: string; projectId?: string; executionId?: string } }>("/api/legal-holds/status", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const { workflowId, projectId, executionId } = request.query ?? {};
    const given = [workflowId, projectId, executionId].filter((value) => typeof value === "string" && value.length > 0);
    if (given.length !== 1) {
      reply.code(400);
      return { error: "Name one of workflowId, projectId or executionId." };
    }
    if (workflowId) {
      const access = await runAccess.workflow(user, workflowId, "workflow:read");
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
    } else if (projectId) {
      const access = await runAccess.project(user, projectId, "workflow:read", "Project");
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
    } else if (executionId) {
      const access = await runAccess.run(user, await deps.store.getExecutionHistory(executionId), "workflow:read", "Execution");
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
    }
    const holds = await deps.service(request, user).on({ workflowId, projectId, executionId });
    // Hold names can name a matter; only hold managers see them.
    const view: LegalHoldStatusView = { held: holds.length > 0, holds: (await canManage(user)) ? holds : [] };
    return view;
  });

  app.get<{ Params: { id: string } }>("/api/legal-holds/:id", async (request, reply) => {
    const user = await manager(request, reply);
    if (!user) return reply;
    const hold = await deps.service(request, user).get(request.params.id);
    if (!hold) {
      reply.code(404);
      return { error: "Legal hold not found" };
    }
    return { hold };
  });

  app.get<{ Params: { id: string }; Querystring: { offset?: string; limit?: string } }>("/api/legal-holds/:id/items", async (request, reply) => {
    const user = await manager(request, reply);
    if (!user) return reply;
    const offset = Math.max(0, queryNumber(request.query?.offset, 0));
    const limit = Math.max(1, Math.min(500, queryNumber(request.query?.limit, 100)));
    const page = await deps.service(request, user).items(request.params.id, { offset, limit });
    if (!page) {
      reply.code(404);
      return { error: "Legal hold not found" };
    }
    return { ...page, offset, limit };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/legal-holds/:id/release", async (request, reply) => {
    const user = await manager(request, reply);
    if (!user) return reply;
    if (!(await requireStepUp(request, reply, "legal_hold.change"))) return reply;
    const parsed = legalHoldReleaseSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "A release needs a reason.", details: parsed.error.issues };
    }
    const outcome = await deps.service(request, user).release(request.params.id, parsed.data.reason, { userId: user.id, email: user.email });
    if (!outcome) {
      reply.code(404);
      return { error: "Legal hold not found" };
    }
    if (!outcome.changed) {
      reply.code(409);
      return { error: "This legal hold is already released.", hold: outcome.hold };
    }
    return { hold: outcome.hold };
  });
}
