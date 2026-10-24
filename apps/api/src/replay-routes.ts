/**
 * Phase 15.1 — golden runs and replay.
 *
 *   POST   /api/replay/recordings              save a finished execution as a golden run (builder)
 *   GET    /api/replay/recordings              golden runs of the workflows the user can read (viewer)
 *   GET    /api/replay/recordings/:id          one golden run: input, recorded node results, run facts (viewer)
 *   DELETE /api/replay/recordings/:id          (builder)
 *   POST   /api/replay/recordings/:id/replay   replay it against the draft or a saved version and diff (builder)
 *
 * Access follows the workflow (see run-access.ts): reading needs
 * `workflow:read` on it, saving and deleting need `workflow:write`, replaying
 * needs `workflow:execute` (admins always pass). A user who cannot read the
 * workflow gets 404. Golden runs of a deleted workflow are deleted with it.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { replayRecordingCreateSchema, replayRunRequestSchema } from "@ai-orchestrator/shared";
import type { SqliteStore } from "./db/database.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import { ReplayRecordingError, ReplayRecordingService } from "./services/replay-recording-service.js";
import { ReplayRunError, type ReplayService } from "./services/replay-service.js";
import type { RunAccess, RunAccessDenial } from "./run-access.js";

export interface ReplayRoutesDeps {
  app: FastifyInstance;
  store: SqliteStore;
  recordings: ReplayRecordingService;
  replays: ReplayService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  runAccess: RunAccess;
  audit: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void;
  /** Phase 15.4 — why `user` may not delete a golden run (an enforced release gate's case uses it); null when they may. */
  recordingDeleteDenial?: (user: SafeUser, workflowId: string, recordingId: string) => string | null;
}

const RECORDING_STATUS: Record<ReplayRecordingError["code"], number> = {
  not_found: 404,
  in_progress: 409,
  not_allowed: 409,
  duplicate: 409,
  limit: 409,
  too_large: 413,
  invalid: 400
};

export function registerReplayRoutes(deps: ReplayRoutesDeps): void {
  const { app, store, recordings, replays, requireRole, runAccess } = deps;

  const deny = (reply: FastifyReply, denial: RunAccessDenial) => {
    reply.code(denial.status);
    return { error: denial.error };
  };

  app.post<{ Body: unknown }>("/api/replay/recordings", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const parsed = replayRecordingCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid golden run", details: parsed.error.issues };
    }
    const access = runAccess.run(user, store.getExecutionHistory(parsed.data.executionId), "workflow:write");
    if (!access.ok) return deny(reply, access);
    const history = access.run;
    try {
      const recording = recordings.create(parsed.data, user.email);
      deps.audit(request, user, {
        eventType: "replay.recording.created",
        category: "workflow",
        action: "create",
        resourceType: "replay_recording",
        resourceId: recording.id,
        projectId: recording.projectId,
        metadata: { recordingId: recording.id, workflowId: recording.workflowId, executionId: history.id, bytes: recording.bytes, truncated: recording.truncated }
      });
      reply.code(201);
      return { recording };
    } catch (error) {
      if (error instanceof ReplayRecordingError) {
        reply.code(RECORDING_STATUS[error.code]);
        return { error: error.message, code: error.code };
      }
      throw error;
    }
  });

  app.get<{ Querystring: { workflowId?: string; limit?: string; offset?: string } }>("/api/replay/recordings", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const workflowId = typeof request.query.workflowId === "string" && request.query.workflowId.trim() ? request.query.workflowId.trim() : undefined;
    const limit = Number(request.query.limit);
    const offset = Number(request.query.offset);
    const paging = { limit: Number.isFinite(limit) ? limit : 50, offset: Number.isFinite(offset) ? offset : 0 };
    // Admins also see golden runs of a workflow id that is gone; everyone else only readable workflows.
    const readable = runAccess.readableWorkflowIds(user);
    // Phase 15.6 — golden runs only; captured candidates are listed by the inbox.
    if (workflowId) {
      if (readable !== null && !readable.includes(workflowId)) return { items: [], total: 0 };
      return store.listReplayRecordings({ workflowId, status: "golden", ...paging });
    }
    return store.listReplayRecordings(readable === null ? { status: "golden", ...paging } : { workflowIds: readable, status: "golden", ...paging });
  });

  app.get<{ Params: { id: string } }>("/api/replay/recordings/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const record = recordings.get(request.params.id);
    if (!record) {
      reply.code(404);
      return { error: "Golden run not found" };
    }
    const access = runAccess.run(user, record, "workflow:read", "Golden run");
    if (!access.ok) return deny(reply, access);
    return { recording: ReplayRecordingService.detail(record) };
  });

  app.delete<{ Params: { id: string } }>("/api/replay/recordings/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const summary = store.getReplayRecordingSummary(request.params.id);
    if (!summary) {
      reply.code(404);
      return { error: "Golden run not found" };
    }
    const access = runAccess.run(user, summary, "workflow:write", "Golden run");
    if (!access.ok) return deny(reply, access);
    const gateDenial = deps.recordingDeleteDenial?.(user, summary.workflowId, summary.id) ?? null;
    if (gateDenial) {
      reply.code(403);
      return { error: gateDenial };
    }
    store.deleteReplayRecording(summary.id);
    deps.audit(request, user, {
      eventType: "replay.recording.deleted",
      category: "workflow",
      action: "delete",
      resourceType: "replay_recording",
      resourceId: summary.id,
      projectId: summary.projectId,
      metadata: { recordingId: summary.id, workflowId: summary.workflowId }
    });
    return { deleted: true };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/replay/recordings/:id/replay", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const parsed = replayRunRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid replay request", details: parsed.error.issues };
    }
    const record = recordings.get(request.params.id);
    if (!record) {
      reply.code(404);
      return { error: "Golden run not found" };
    }
    const access = runAccess.run(user, record, "workflow:execute", "Golden run");
    if (!access.ok) return deny(reply, access);
    if (record.status === "candidate") {
      reply.code(409);
      return { error: "This is a captured run waiting in the inbox; promote it before replaying it.", code: "candidate" };
    }
    try {
      const result = await replays.replay(record, parsed.data, user);
      deps.audit(request, user, {
        eventType: "replay.run",
        category: "execution",
        action: "execute",
        outcome: result.verdict === "error" ? "failure" : "success",
        resourceType: "replay_recording",
        resourceId: record.id,
        projectId: record.projectId,
        metadata: {
          recordingId: record.id,
          executionId: result.executionId,
          workflowId: record.workflowId,
          candidate: result.candidate,
          verdict: result.verdict,
          mcpMode: parsed.data.mcpMode ?? "strict"
        }
      });
      return result;
    } catch (error) {
      if (error instanceof ReplayRunError) {
        reply.code(error.code === "not_found" ? 404 : 422);
        return { error: error.message, code: error.code };
      }
      throw error;
    }
  });
}
