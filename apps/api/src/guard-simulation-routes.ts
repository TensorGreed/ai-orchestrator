/**
 * Phase 15.6 — guard policy simulation routes.
 *
 *   POST /api/guard/profiles/:id/simulate        start one: { document } (unsaved, never stored) or { version }; 202
 *   GET  /api/guard/profiles/:id/simulations     recent simulations of the profile (summaries)
 *   GET  /api/guard/simulations/:id              one simulation with its per-workflow detail
 *   POST /api/guard/simulations/:id/cancel       cancel a running one (admins, or whoever started it)
 *
 * Only guard-profile editors: admins, and builders for a profile they may
 * edit (not the built-in one, not one a project enforces; the same rule as
 * saving a version). Everyone else gets 403; a profile or simulation that
 * does not exist gets 404. Cases come only from workflows the starter can
 * read (run-access.ts), and a viewer sees only the workflows they can read
 * now: the summary and progress are computed from those, and nothing is
 * said about the others. A simulation that includes none of the viewer's
 * readable workflows (and is not theirs) is not listed and reads as 404.
 * One simulation runs at a time per deployment: a second start gets 409
 * with the running simulation's id (without one while another start is
 * still being set up).
 *
 * SQLite only in this release: on Postgres every route answers 501.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { guardSimulationRequestSchema } from "@ai-orchestrator/shared";
import type { SqliteStore } from "./db/database.js";
import type { RunAccess } from "./run-access.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import { GuardNotFoundError, GuardValidationError } from "./services/guard-service.js";
import { GuardSimulationBusyError, type GuardSimulationService } from "./services/guard-simulation-service.js";

export interface GuardSimulationRoutesDeps {
  app: FastifyInstance;
  store: SqliteStore;
  simulations: GuardSimulationService | null;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  runAccess: RunAccess;
  audit: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void;
}

export function registerGuardSimulationRoutes(deps: GuardSimulationRoutesDeps): void {
  const { app, store, simulations, requireRole } = deps;

  const unavailable = (reply: FastifyReply) => {
    reply.code(501);
    return { error: "Guard policy simulation needs the SQLite store in this release." };
  };

  /** Why `user` may not simulate this profile (404 when it does not exist); null when they may. */
  const editorDenial = (user: SafeUser, profileId: string) => simulations!.editorDenial(user, profileId);

  const deny = (reply: FastifyReply, denial: { status: number; error: string }) => {
    reply.code(denial.status);
    return { error: denial.error };
  };

  app.post<{ Params: { id: string }; Body: unknown; Querystring: { wait?: string } }>("/api/guard/profiles/:id/simulate", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    if (!simulations) return unavailable(reply);
    const denial = editorDenial(user, request.params.id);
    if (denial) return deny(reply, denial);
    const parsed = guardSimulationRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid simulation request", issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join(".") || "(root)", message: issue.message })) };
    }
    try {
      let simulation = await simulations.start(request.params.id, parsed.data, user);
      deps.audit(request, user, {
        eventType: "guard.simulation.started",
        category: "system",
        action: "execute",
        resourceType: "guard_profile",
        resourceId: request.params.id,
        metadata: {
          simulationId: simulation.id,
          source: simulation.source,
          baseVersion: simulation.baseVersion,
          jobIds: simulation.jobIds,
          workflows: simulation.workflows?.length ?? 0
        }
      });
      if (request.query.wait === "true") {
        await simulations.wait(simulation.id);
        simulation = simulations.get(simulation.id, user) ?? simulation;
      }
      reply.code(simulation.status === "running" ? 202 : 200);
      return { simulation };
    } catch (error) {
      if (error instanceof GuardValidationError) {
        reply.code(400);
        return { error: error.message, issues: error.issues };
      }
      if (error instanceof GuardNotFoundError) {
        reply.code(404);
        return { error: error.message };
      }
      if (error instanceof GuardSimulationBusyError) {
        reply.code(409);
        return { error: error.message, ...(error.simulationId !== "starting" ? { simulationId: error.simulationId } : {}) };
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/guard/profiles/:id/simulations", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    if (!simulations) return unavailable(reply);
    const denial = editorDenial(user, request.params.id);
    if (denial) return deny(reply, denial);
    const limit = Number(request.query.limit);
    return { simulations: simulations.list(request.params.id, user, Number.isFinite(limit) ? limit : 20) };
  });

  app.get<{ Params: { id: string } }>("/api/guard/simulations/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    if (!simulations) return unavailable(reply);
    const record = store.getGuardSimulation(request.params.id);
    if (!record) {
      reply.code(404);
      return { error: "Simulation not found" };
    }
    const denial = editorDenial(user, record.profileId);
    if (denial) return deny(reply, denial.status === 404 ? { status: 404, error: "Simulation not found" } : denial);
    if (!simulations.visibleTo(record, user)) {
      reply.code(404);
      return { error: "Simulation not found" };
    }
    const simulation = simulations.get(record.id, user);
    if (!simulation) {
      reply.code(404);
      return { error: "Simulation not found" };
    }
    return { simulation };
  });

  app.post<{ Params: { id: string } }>("/api/guard/simulations/:id/cancel", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    if (!simulations) return unavailable(reply);
    const record = store.getGuardSimulation(request.params.id);
    if (!record || !simulations.visibleTo(record, user)) {
      reply.code(404);
      return { error: "Simulation not found" };
    }
    if (!simulations.mayCancel(record, user)) {
      reply.code(403);
      return { error: "Only an admin or the person who started a simulation can cancel it" };
    }
    const simulation = simulations.cancel(record.id, user);
    if (!simulation) {
      reply.code(404);
      return { error: "Simulation not found" };
    }
    deps.audit(request, user, {
      eventType: "guard.simulation.canceled",
      category: "system",
      action: "execute",
      resourceType: "guard_profile",
      resourceId: record.profileId,
      metadata: { simulationId: record.id }
    });
    return { simulation };
  });
}
