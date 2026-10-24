/**
 * Phase 15.6 — production capture.
 *
 *   GET    /api/workflows/:id/replay-capture       the workflow's capture settings and inbox counts (viewer)
 *   PUT    /api/workflows/:id/replay-capture       change them (builder; turning masking off is admin-only, with a reason)
 *   GET    /api/workflows/:id/replay-captures      the "Captured runs" inbox: candidates, newest first (viewer)
 *   POST   /api/replay/captures/:id/promote        a candidate becomes a golden run and joins a golden set (builder)
 *   POST   /api/replay/captures/promote            the same for up to 100 candidates (builder)
 *   DELETE /api/replay/captures/:id                discard a candidate: hard delete (builder)
 *   POST   /api/replay/captures/discard            the same for up to 100 candidates (builder)
 *   POST   /api/replay/recordings/find-subject     admins: every recording that holds a value, as its surrogate or raw; optional delete
 *
 * Access follows the workflow (run-access.ts): reading needs `workflow:read`
 * (404 otherwise), changing needs `workflow:write` (403 when readable but not
 * writable). In bulk requests every id is checked on its own; one the user
 * cannot read reports "not found" like a missing one. SQLite only: on
 * Postgres every route answers 501.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  replayCaptureBulkDiscardSchema,
  replayCaptureBulkPromoteSchema,
  replayCaptureListQuerySchema,
  replayCapturePromoteSchema,
  replayCaptureSettingsUpdateSchema,
  replayFindSubjectSchema,
  type ReplayCapturePromoteOutcome
} from "@ai-orchestrator/shared";
import type { z } from "zod";
import type { SqliteStore } from "./db/database.js";
import type { RunAccess, RunAccessDenial } from "./run-access.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import { ReplayCaptureError, ReplayCaptureService } from "./services/replay-capture-service.js";

export interface ReplayCaptureRoutesDeps {
  app: FastifyInstance;
  store: SqliteStore;
  captures: ReplayCaptureService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  runAccess: RunAccess;
  audit: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void;
  /** False on Postgres: every route answers 501. */
  available: boolean;
}

const CAPTURE_ERROR_STATUS: Record<ReplayCaptureError["code"], number> = {
  not_found: 404,
  invalid: 400,
  forbidden: 403,
  conflict: 409,
  too_large: 413,
  limit: 409
};

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}` : "invalid request";
}

export function registerReplayCaptureRoutes(deps: ReplayCaptureRoutesDeps): void {
  const { app, store, captures, requireRole, runAccess } = deps;

  const deny = (reply: FastifyReply, denial: RunAccessDenial) => {
    reply.code(denial.status);
    return { error: denial.error };
  };
  const unavailable = (reply: FastifyReply) => {
    reply.code(501);
    return { error: "Production capture needs the SQLite store; it is not available on Postgres yet." };
  };

  /** A candidate the user may act on, or the denial (404 for missing, golden or unreadable; 403 for read-only). */
  const candidateAccess = (user: SafeUser, id: string, permission: "workflow:read" | "workflow:write") => {
    const summary = store.getReplayRecordingSummary(id);
    if (!summary || summary.status !== "candidate") return { ok: false as const, status: 404 as const, error: "Captured run not found" };
    const access = runAccess.run(user, summary, permission, "Captured run");
    return access.ok ? { ok: true as const, summary } : access;
  };

  app.get<{ Params: { id: string } }>("/api/workflows/:id/replay-capture", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    if (!deps.available) return unavailable(reply);
    const access = runAccess.workflow(user, request.params.id, "workflow:read");
    if (!access.ok) return deny(reply, access);
    const view = captures.view(access.workflow.id);
    // Why masking is off is for admins.
    return { settings: user.role === "admin" ? view : { ...view, dlpOffReason: null } };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id/replay-capture", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    if (!deps.available) return unavailable(reply);
    const parsed = replayCaptureSettingsUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: firstIssue(parsed.error), details: parsed.error.issues };
    }
    const access = runAccess.workflow(user, request.params.id, "workflow:write");
    if (!access.ok) return deny(reply, access);
    const before = captures.settings(access.workflow.id);
    try {
      const settings = captures.update(access.workflow, parsed.data, user);
      const projectId = access.workflow.projectId ?? null;
      deps.audit(request, user, {
        eventType: "replay.capture.settings_updated",
        category: "workflow",
        action: "update",
        resourceType: "workflow",
        resourceId: access.workflow.id,
        projectId,
        metadata: {
          workflowId: access.workflow.id,
          enabled: settings.enabled,
          rate: settings.rate,
          maxPerDay: settings.maxPerDay,
          onlyStatuses: settings.onlyStatuses,
          dlp: settings.dlp,
          targetDatasetId: settings.targetDatasetId
        }
      });
      if ((before?.dlp ?? true) && !settings.dlp) {
        deps.audit(request, user, {
          eventType: "replay.capture.masking_disabled",
          category: "workflow",
          action: "update",
          resourceType: "workflow",
          resourceId: access.workflow.id,
          projectId,
          message: settings.dlpOffReason ?? undefined,
          metadata: { workflowId: access.workflow.id, reason: settings.dlpOffReason }
        });
      }
      return { settings };
    } catch (error) {
      if (error instanceof ReplayCaptureError) {
        reply.code(CAPTURE_ERROR_STATUS[error.code]);
        return { error: error.message, code: error.code };
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>("/api/workflows/:id/replay-captures", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    if (!deps.available) return unavailable(reply);
    const access = runAccess.workflow(user, request.params.id, "workflow:read");
    if (!access.ok) return deny(reply, access);
    const parsed = replayCaptureListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: firstIssue(parsed.error), details: parsed.error.issues };
    }
    const page = store.listReplayCaptures({ workflowId: access.workflow.id, ...parsed.data });
    return { items: page.items.map(ReplayCaptureService.view), total: page.total };
  });

  const promoteOne = (request: FastifyRequest, user: SafeUser, id: string, input: { datasetId?: string; name?: string }): ReplayCapturePromoteOutcome & { status: number } => {
    const access = candidateAccess(user, id, "workflow:write");
    if (!access.ok) return { id, ok: false, error: access.error, status: access.status };
    const outcome = captures.promote(id, input, user);
    if (!outcome.ok) return { id, ok: false, error: outcome.error, status: /not found/i.test(outcome.error ?? "") ? 404 : 409 };
    deps.audit(request, user, {
      eventType: "replay.capture.promoted",
      category: "workflow",
      action: "update",
      resourceType: "replay_recording",
      resourceId: id,
      projectId: access.summary.projectId,
      metadata: { recordingId: id, workflowId: access.summary.workflowId, datasetId: outcome.datasetId ?? null, fixtureId: outcome.fixtureId ?? null }
    });
    return { id, ok: true, datasetId: outcome.datasetId, fixtureId: outcome.fixtureId, status: 200 };
  };

  app.post<{ Params: { id: string }; Body: unknown }>("/api/replay/captures/:id/promote", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    if (!deps.available) return unavailable(reply);
    const parsed = replayCapturePromoteSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: firstIssue(parsed.error), details: parsed.error.issues };
    }
    const { status, ...outcome } = promoteOne(request, user, request.params.id, parsed.data);
    if (!outcome.ok) {
      // A too-large run or a full golden-run budget is a 409 with the reason; access answers as run-access does.
      reply.code(status === 200 ? 409 : status);
      return { error: outcome.error };
    }
    return { result: outcome, recording: store.getReplayRecordingSummary(outcome.id) };
  });

  app.post<{ Body: unknown }>("/api/replay/captures/promote", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    if (!deps.available) return unavailable(reply);
    const parsed = replayCaptureBulkPromoteSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: firstIssue(parsed.error), details: parsed.error.issues };
    }
    const results = [...new Set(parsed.data.ids)].map((id) => {
      const { status: _status, ...outcome } = promoteOne(request, user, id, parsed.data.datasetId ? { datasetId: parsed.data.datasetId } : {});
      return outcome;
    });
    return { results, promoted: results.filter((result) => result.ok).length };
  });

  const discardOne = (request: FastifyRequest, user: SafeUser, id: string): { id: string; ok: boolean; error?: string; status: number } => {
    const access = candidateAccess(user, id, "workflow:write");
    if (!access.ok) return { id, ok: false, error: access.error, status: access.status };
    store.deleteReplayRecording(id);
    deps.audit(request, user, {
      eventType: "replay.capture.discarded",
      category: "workflow",
      action: "delete",
      resourceType: "replay_recording",
      resourceId: id,
      projectId: access.summary.projectId,
      metadata: { recordingId: id, workflowId: access.summary.workflowId }
    });
    return { id, ok: true, status: 200 };
  };

  app.delete<{ Params: { id: string } }>("/api/replay/captures/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    if (!deps.available) return unavailable(reply);
    const { status, ...outcome } = discardOne(request, user, request.params.id);
    if (!outcome.ok) {
      reply.code(status);
      return { error: outcome.error };
    }
    return { deleted: true };
  });

  app.post<{ Body: unknown }>("/api/replay/captures/discard", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    if (!deps.available) return unavailable(reply);
    const parsed = replayCaptureBulkDiscardSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: firstIssue(parsed.error), details: parsed.error.issues };
    }
    const results = [...new Set(parsed.data.ids)].map((id) => {
      const { status: _status, ...outcome } = discardOne(request, user, id);
      return outcome;
    });
    return { results, discarded: results.filter((result) => result.ok).length };
  });

  app.post<{ Body: unknown }>("/api/replay/recordings/find-subject", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    if (!deps.available) return unavailable(reply);
    const parsed = replayFindSubjectSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      // Never echo the value back, not even in a validation message.
      return { error: firstIssue(parsed.error).replace(/"[^"]*"/g, '"…"') };
    }
    const result = captures.findSubject(parsed.data.value, parsed.data.delete === true);
    deps.audit(request, user, {
      eventType: parsed.data.delete ? "replay.find_subject.deleted" : "replay.find_subject.searched",
      category: "system",
      action: parsed.data.delete ? "delete" : "read",
      resourceType: "replay_recording",
      metadata: {
        classesTried: result.classesTried,
        matches: result.matches.length,
        recordingIds: result.matches.map((match) => match.recordingId).slice(0, 200),
        deleted: result.deleted,
        casesDeleted: result.casesDeleted
      }
    });
    return result;
  });
}
