/**
 * Phase 15.4 — release gate and publish.
 *
 *   GET  /api/workflows/:id/release-gate     the gate settings (viewer)                 -> { gate }
 *   PUT  /api/workflows/:id/release-gate     save them (workflow:write; enforced: admin) -> { gate }
 *   POST /api/workflows/:id/publish          publish a saved version (workflow:publish)
 *        200 { release }                                  published (passed | overridden | ungated)
 *        202 { verdict: "needs_approval", approvalRequestId } sent to the gate's approvers (approvals inbox)
 *        409 { verdict: "blocked", reasons, replayRunId?, canRequestApproval }
 *   GET  /api/workflows/:id/releases         release history and the published version (viewer)
 *   POST /api/workflows/:id/rollback         back to a version published before (workflow:publish)
 *   GET  /api/workflows/:id/release-state    the editor's version pill: draft, published, ahead by (viewer)
 *   GET  /api/workflows/:id/publish-preview  ?version=N[&replayRunId=]: the verdict publishing would get now (viewer)
 *
 * Access goes through the shared run-access helper (run-access.ts): a
 * workflow the user cannot read answers 404, one they can read but may not
 * act on 403; admins always pass. Releases need the SQLite store in this
 * release; on Postgres every route answers 501.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { releasePublishInputSchema, releaseRollbackInputSchema } from "@ai-orchestrator/shared";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import { ReleaseError, type ReleaseService } from "./services/release-service.js";

export interface ReleaseRoutesDeps {
  app: FastifyInstance;
  releases: ReleaseService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
}

type Params = { Params: { id: string } };

export function registerReleaseRoutes(deps: ReleaseRoutesDeps): void {
  const { app, releases, requireRole } = deps;

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof ReleaseError) {
      reply.code(error.statusCode);
      return { error: error.message, ...(error.details ?? {}) };
    }
    throw error;
  };

  const handle = async <T>(request: FastifyRequest, reply: FastifyReply, roles: UserRole[], work: (user: SafeUser) => T | Promise<T>) => {
    const user = await requireRole(request, reply, roles);
    if (!user) return reply;
    if (!releases.available) {
      reply.code(501);
      return { error: "Releases need the SQLite store in this release" };
    }
    try {
      return await work(user);
    } catch (error) {
      return fail(reply, error);
    }
  };

  app.get<Params>("/api/workflows/:id/release-gate", (request, reply) =>
    handle(request, reply, ["viewer"], (user) => ({ gate: releases.gate(user, request.params.id) }))
  );

  app.put<Params & { Body: unknown }>("/api/workflows/:id/release-gate", (request, reply) =>
    handle(request, reply, ["builder"], (user) => ({ gate: releases.updateGate(user, request.params.id, (request.body ?? {}) as never) }))
  );

  app.post<Params & { Body: unknown }>("/api/workflows/:id/publish", (request, reply) =>
    handle(request, reply, ["viewer"], (user) => {
      const parsed = releasePublishInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: "Invalid publish request", details: parsed.error.issues };
      }
      const outcome = releases.publish(user, request.params.id, parsed.data);
      reply.code(outcome.status);
      if (outcome.status === 200) return { release: outcome.release };
      if (outcome.status === 202) return { verdict: outcome.verdict, approvalRequestId: outcome.approvalRequestId, reasons: outcome.reasons };
      return { verdict: outcome.verdict, reasons: outcome.reasons, ...(outcome.replayRunId ? { replayRunId: outcome.replayRunId } : {}), canRequestApproval: outcome.canRequestApproval };
    })
  );

  app.get<Params & { Querystring: { limit?: string } }>("/api/workflows/:id/releases", (request, reply) =>
    handle(request, reply, ["viewer"], (user) => {
      const limit = request.query.limit ? Number.parseInt(request.query.limit, 10) : undefined;
      return releases.releases(user, request.params.id, limit && Number.isFinite(limit) ? limit : undefined);
    })
  );

  app.post<Params & { Body: unknown }>("/api/workflows/:id/rollback", (request, reply) =>
    handle(request, reply, ["viewer"], (user) => {
      const parsed = releaseRollbackInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: "Invalid rollback request", details: parsed.error.issues };
      }
      return { release: releases.rollback(user, request.params.id, parsed.data) };
    })
  );

  app.get<Params>("/api/workflows/:id/release-state", (request, reply) =>
    handle(request, reply, ["viewer"], (user) => ({ state: releases.state(user, request.params.id) }))
  );

  app.get<Params & { Querystring: { version?: string; replayRunId?: string } }>("/api/workflows/:id/publish-preview", (request, reply) =>
    handle(request, reply, ["viewer"], (user) => {
      const version = Number.parseInt(request.query.version ?? "", 10);
      if (!Number.isFinite(version) || version <= 0) {
        reply.code(400);
        return { error: "version must be a positive integer" };
      }
      return { preview: releases.preview(user, request.params.id, version, request.query.replayRunId || undefined) };
    })
  );
}
