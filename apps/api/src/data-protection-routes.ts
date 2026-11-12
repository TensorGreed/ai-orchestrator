/**
 * 13.3 — data-subject requests and subject references.
 *
 *   POST /api/data-protection/requests                 make a request for a person's data (managers; the value is used, then dropped)
 *   GET  /api/data-protection/requests                 requests, newest first (managers)
 *   GET  /api/data-protection/requests/:id             one request with its progress (managers)
 *   GET  /api/data-protection/requests/:id/export      the export zip, once (managers; step-up)
 *   POST /api/data-protection/requests/:id/confirm     confirm a deletion request after its preview (managers; step-up)
 *   POST /api/data-protection/subject-refs/preview     how subject references resolve on a workflow's latest runs (workflow editors)
 *
 * Managers: admins, and members through a deployment-wide custom role granting `data_subject:manage`.
 *
 * The person's value is never logged, audited or returned: the audit trail names the request id, its type and what it
 * found.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { subjectRefPreviewSchema, subjectRequestConfirmSchema, subjectRequestCreateSchema } from "@ai-orchestrator/shared";
import type { Store } from "./db/store.js";
import type { RunAccess } from "./run-access.js";
import type { AuditEventInput } from "./services/audit-service.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { StepUpAction } from "./services/mfa-policy.js";
import { SubjectRequestError, runSessionId, type SubjectRequestService } from "./services/subject-request-service.js";

/** Runs a subject reference preview reads at most. */
export const SUBJECT_REF_PREVIEW_RUNS = 10;

export interface DataProtectionRoutesDeps {
  app: FastifyInstance;
  store: Store;
  requests: SubjectRequestService;
  /** False when the master key is missing: references and requests need it. */
  available: boolean;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  requireStepUp: (request: FastifyRequest, reply: FastifyReply, action: StepUpAction, targetUserId?: string) => Promise<boolean>;
  /** The account a staff erasure would delete, or null. */
  staffAccount: (email: string) => Promise<{ id: string } | null>;
  /** `data_subject:manage` (deployment-wide). */
  canManage: (user: SafeUser) => Promise<boolean>;
  runAccess: RunAccess;
  audit: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => Promise<void>;
}

const ERROR_STATUS: Record<SubjectRequestError["code"], number> = { invalid: 400, not_found: 404, unavailable: 503, conflict: 409 };

/** A validation message without quoted input (it could hold the person's value). */
function quietIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue?.message ?? "Invalid request"}`.replace(/"[^"]*"/g, '"…"');
}

export function registerDataProtectionRoutes(deps: DataProtectionRoutesDeps): void {
  const { app, store, requests, requireRole, requireStepUp, canManage, runAccess } = deps;

  /** A signed-in request manager, or null after answering 401/403. */
  const manager = async (request: FastifyRequest, reply: FastifyReply): Promise<SafeUser | null> => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return null;
    if (!(await canManage(user))) {
      reply.code(403).send({ error: "Data-subject requests need the data_subject:manage permission (admins have it)." });
      return null;
    }
    return user;
  };

  const unavailable = (reply: FastifyReply) => {
    reply.code(503);
    return { error: "Data-subject requests need SECRET_MASTER_KEY_BASE64 (a 32-byte key) to be set.", code: "unavailable" };
  };
  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof SubjectRequestError) {
      reply.code(ERROR_STATUS[error.code]);
      return { error: error.message, code: error.code };
    }
    throw error;
  };

  app.post<{ Body: unknown }>("/api/data-protection/requests", async (request, reply) => {
    const user = await manager(request, reply);
    if (!user) return reply;
    if (!deps.available) return unavailable(reply);
    const parsed = subjectRequestCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: quietIssue(parsed.error) };
    }
    if (parsed.data.revealTokens && !(await requireStepUp(request, reply, "subject_request.reveal"))) return reply;
    try {
      const created = await requests.create(parsed.data, { id: user.id, email: user.email });
      await deps.audit(request, user, {
        eventType: "data_subject.request_created",
        category: "data_protection",
        action: "create",
        resourceType: "subject_request",
        resourceId: created.id,
        metadata: { requestId: created.id, type: created.type, subjectKind: created.subjectKind, scan: created.scan, revealTokens: created.revealTokens, dueAt: created.dueAt }
      });
      reply.code(201);
      return created;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Querystring: { limit?: string } }>("/api/data-protection/requests", async (request, reply) => {
    const user = await manager(request, reply);
    if (!user) return reply;
    if (!deps.available) return unavailable(reply);
    const limit = Number(request.query.limit ?? 100);
    return { requests: await requests.list(Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100) };
  });

  app.get<{ Params: { id: string } }>("/api/data-protection/requests/:id", async (request, reply) => {
    const user = await manager(request, reply);
    if (!user) return reply;
    if (!deps.available) return unavailable(reply);
    const found = await requests.get(request.params.id);
    if (!found) {
      reply.code(404);
      return { error: "Request not found" };
    }
    return found;
  });

  app.get<{ Params: { id: string } }>("/api/data-protection/requests/:id/export", async (request, reply) => {
    const user = await manager(request, reply);
    if (!user) return reply;
    if (!deps.available) return unavailable(reply);
    if (!(await requireStepUp(request, reply, "subject_export.download"))) return reply;
    try {
      const result = await requests.download(request.params.id, { email: user.email });
      await deps.audit(request, user, {
        eventType: "data_subject.export_downloaded",
        category: "data_protection",
        action: "export",
        resourceType: "subject_request",
        resourceId: request.params.id,
        metadata: { requestId: request.params.id, bytes: result.bytes.length, counts: result.request.counts }
      });
      reply.header("content-type", "application/zip");
      reply.header("content-disposition", `attachment; filename="${result.filename}"`);
      reply.header("cache-control", "no-store");
      return reply.send(result.bytes);
    } catch (error) {
      if (error instanceof SubjectRequestError && error.code === "conflict") {
        await deps.audit(request, user, {
          eventType: "data_subject.export_downloaded",
          category: "data_protection",
          action: "export",
          outcome: "failure",
          resourceType: "subject_request",
          resourceId: request.params.id,
          metadata: { requestId: request.params.id, reason: error.message }
        });
      }
      return fail(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/data-protection/requests/:id/confirm", async (request, reply) => {
    const user = await manager(request, reply);
    if (!user) return reply;
    if (!deps.available) return unavailable(reply);
    // A staff erasure deletes the person's account: only an admin may confirm it, with the user.delete step-up for that
    // account too (it refuses a service-account key acting on a person, as DELETE /api/users/:id does).
    const staffEmail = await requests.staffTarget(request.params.id);
    const account = staffEmail ? await deps.staffAccount(staffEmail) : null;
    if (account && user.role !== "admin") {
      reply.code(403);
      return { error: "Only an admin can erase a staff member who has an account (it deletes the account)." };
    }
    if (!(await requireStepUp(request, reply, "subject_request.delete"))) return reply;
    if (account && !(await requireStepUp(request, reply, "user.delete", account.id))) return reply;
    const parsed = subjectRequestConfirmSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: quietIssue(parsed.error) };
    }
    try {
      // The intent row, before any row is deleted: the request, what its preview counted and who confirmed it.
      return await requests.confirm(request.params.id, { id: user.id, email: user.email }, async (confirmed) => {
        await deps.audit(request, user, {
          eventType: "data_subject.deletion_confirmed",
          category: "data_protection",
          action: "delete",
          resourceType: "subject_request",
          resourceId: confirmed.id,
          metadata: {
            requestId: confirmed.id,
            subjectKind: confirmed.subjectKind,
            counts: confirmed.counts,
            ...(confirmed.staffPreview ? { staffPreview: confirmed.staffPreview } : {})
          }
        });
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/api/data-protection/subject-refs/preview", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const parsed = subjectRefPreviewSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: quietIssue(parsed.error) };
    }
    const access = await runAccess.workflow(user, parsed.data.workflowId, "workflow:write");
    if (!access.ok) {
      reply.code(access.status);
      return { error: access.error };
    }
    const listed = await store.listExecutionHistory({ workflowId: parsed.data.workflowId, page: 1, pageSize: SUBJECT_REF_PREVIEW_RUNS });
    const runs = [];
    for (const item of listed.items) {
      const run = await store.getExecutionHistory(item.id);
      if (!run) continue;
      runs.push({
        input: run.input,
        output: run.output,
        customData: run.customData,
        sessionId: runSessionId(run.input, run.customData),
        triggeredBy: run.triggeredBy
      });
    }
    return await requests.previewRefs({ workflowId: parsed.data.workflowId, subjectRefs: parsed.data.subjectRefs, runs });
  });
}
