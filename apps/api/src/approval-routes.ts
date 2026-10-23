/**
 * Phase 11.2 — the approvals inbox.
 *
 *   GET  /api/approvals                  requests the user can see (pending by default; ?status=decided|all, ?workflowId, ?executionId)
 *   POST /api/approvals/:id/approve      approve the run paused as execution :id, optionally with edits and a reason
 *   POST /api/approvals/:id/reject       reject it, with a reason when the request requires one
 *   POST /api/approvals/eligibility      who could approve with these approver settings (editor warning; needs workflow:write)
 *
 * Listing needs `workflow:read` on the workflow's project; deciding needs
 * `workflow:execute` on it and must satisfy the request's approvers and its
 * self-approval rule. With the execution queue in use the resume runs on the
 * queue and the decision answers 202; otherwise it runs inline and answers
 * with the run result, as before.
 *
 * A decision is never lost: when its resume cannot be started the request
 * goes back to pending and the route answers 503, so it can be decided
 * again. Approvals need the SQLite store in this release; on Postgres every
 * route answers 501.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { approvalApproveInputSchema, approvalEligibilityInputSchema, approvalRejectInputSchema } from "@ai-orchestrator/shared";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import { ApprovalDecisionError, type ApprovalResumeJob, type ApprovalService } from "./services/approval-service.js";

export interface ApprovalRoutesDeps {
  app: FastifyInstance;
  approvals: ApprovalService;
  /** False on stores without approval requests (Postgres in this release). */
  available: boolean;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  /** The workflow as stored, for the eligibility check; null when it does not exist. */
  loadWorkflow: (id: string) => { id: string; projectId?: string } | null;
  canReadWorkflow: (user: SafeUser, workflow: { id: string; projectId?: string }) => boolean;
  /** Edit rights on the workflow (or, for an unsaved one, on the project it will be saved in). */
  canUpdateWorkflow: (user: SafeUser, workflow: { id: string; projectId?: string }) => boolean;
  /** May list the accounts of the workflow's project (admins, or `project:invite`). */
  canSeeProjectAccounts: (user: SafeUser, workflow: { id: string; projectId?: string }) => boolean;
  /** Resumes the run: inline (resolves with the run result) or on the queue (resolves with `{ queued: true }`). */
  dispatch: (job: ApprovalResumeJob) => Promise<{ queued: true } | { queued: false; result: { status: string } } | null>;
}

const STATUS_FILTERS = new Set(["pending", "decided", "all"]);

export function registerApprovalRoutes(deps: ApprovalRoutesDeps): void {
  const { app, approvals, requireRole } = deps;
  const unavailable = (reply: FastifyReply) => {
    reply.code(501);
    return { error: "Approvals need the SQLite store in this release" };
  };

  app.get<{ Querystring: Record<string, string | undefined> }>("/api/approvals", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    if (!deps.available) return unavailable(reply);
    const query = request.query ?? {};
    const status = query.status && STATUS_FILTERS.has(query.status) ? (query.status as "pending" | "decided" | "all") : "pending";
    const limit = query.limit ? Number(query.limit) : undefined;
    return {
      items: approvals.list(user, {
        status,
        ...(query.workflowId ? { workflowId: query.workflowId } : {}),
        ...(query.executionId ? { executionId: query.executionId } : {}),
        ...(limit && Number.isFinite(limit) ? { limit } : {})
      })
    };
  });

  const decide = async (request: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply: FastifyReply, decision: "approve" | "reject") => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return;
    if (!deps.available) return unavailable(reply);
    const parsed = (decision === "approve" ? approvalApproveInputSchema : approvalRejectInputSchema).safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: decision === "approve" ? "Invalid approval payload" : "Invalid rejection payload", details: parsed.error.issues };
    }
    const body = parsed.data as { reason?: string; edits?: Record<string, unknown>; requestId?: string };
    let job: ApprovalResumeJob;
    try {
      job = approvals.decide({
        executionId: request.params.id,
        user,
        decision,
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.edits ? { edits: body.edits } : {}),
        ...(body.requestId ? { requestId: body.requestId } : {})
      }).job;
    } catch (error) {
      if (error instanceof ApprovalDecisionError) {
        reply.code(error.statusCode);
        return { error: error.message, ...(error.details ? { details: error.details } : {}) };
      }
      throw error;
    }
    let outcome: Awaited<ReturnType<ApprovalRoutesDeps["dispatch"]>>;
    try {
      outcome = await deps.dispatch(job);
    } catch (error) {
      approvals.reopenAfterFailedResume(job);
      request.log.warn({ executionId: job.executionId, error: error instanceof Error ? error.name : "Error" }, "Resuming an approved run failed");
      reply.code(503);
      return { error: "Could not resume the run; decide again", executionId: job.executionId, requestId: job.requestId };
    }
    if (!outcome) {
      reply.code(409);
      return { error: "The run is already being resumed" };
    }
    if (outcome.queued) {
      reply.code(202);
      return { queued: true, executionId: job.executionId, requestId: job.requestId, decision };
    }
    if (outcome.result.status === "error") reply.code(400);
    return outcome.result;
  };

  app.post<{ Body: unknown }>("/api/approvals/eligibility", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return;
    if (!deps.available) return unavailable(reply);
    const parsed = approvalEligibilityInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid eligibility payload", details: parsed.error.issues };
    }
    // An unsaved workflow is checked against the project it will be saved in.
    const workflow = deps.loadWorkflow(parsed.data.workflowId) ?? { id: parsed.data.workflowId, ...(parsed.data.projectId ? { projectId: parsed.data.projectId } : {}) };
    if (!deps.canReadWorkflow(user, workflow)) {
      reply.code(404);
      return { error: "Workflow not found" };
    }
    // Only an editor configuring the gate needs this answer.
    if (!deps.canUpdateWorkflow(user, workflow)) {
      reply.code(403);
      return { error: "Editing the workflow is required to check its approvers" };
    }
    return approvals.eligibility({ workflow, spec: parsed.data, requester: user, accountBlind: !deps.canSeeProjectAccounts(user, workflow) });
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/approvals/:id/approve", (request, reply) => decide(request, reply, "approve"));
  app.post<{ Params: { id: string }; Body: unknown }>("/api/approvals/:id/reject", (request, reply) => decide(request, reply, "reject"));
}
