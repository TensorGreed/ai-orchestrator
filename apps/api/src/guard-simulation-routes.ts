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
 * Phase 16 — destination previews ("Preview impact" on the Destinations tab):
 *
 *   POST /api/data-destinations/preview          start one: { rows, removedIds } (unsaved, never stored); 202
 *   GET  /api/data-destinations/previews         recent previews (summaries)
 *
 * Admin only; read, cancel and the one-at-a-time rule through the routes above.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DESTINATION_PREVIEW_SIMULATION_PROFILE, destinationPreviewRequestSchema, guardSimulationRequestSchema } from "@ai-orchestrator/shared";
import type { RunAccess } from "./run-access.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import { GuardNotFoundError, GuardValidationError } from "./services/guard-service.js";
import { DataDestinationError, type DataDestinationService } from "./services/data-destination-service.js";
import { GuardSimulationBusyError, type GuardSimulationService } from "./services/guard-simulation-service.js";
import type { Store } from "./db/store.js";

export interface GuardSimulationRoutesDeps {
  app: FastifyInstance;
  store: Store;
  simulations: GuardSimulationService;
  /** Phase 16 — builds a destination preview's rows (validated, never stored). */
  destinations: DataDestinationService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  runAccess: RunAccess;
  audit: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void | Promise<void>;
}

export function registerGuardSimulationRoutes(deps: GuardSimulationRoutesDeps): void {
  const { app, store, simulations, requireRole } = deps;

  /** Why `user` may not simulate this profile (404 when it does not exist); null when they may. */
  const editorDenial = async (user: SafeUser, profileId: string) => await simulations.editorDenial(user, profileId);

  const deny = (reply: FastifyReply, denial: { status: number; error: string }) => {
    reply.code(denial.status);
    return { error: denial.error };
  };

  app.post<{ Params: { id: string }; Body: unknown; Querystring: { wait?: string } }>("/api/guard/profiles/:id/simulate", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const denial = await editorDenial(user, request.params.id);
    if (denial) return deny(reply, denial);
    const parsed = guardSimulationRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid simulation request", issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join(".") || "(root)", message: issue.message })) };
    }
    try {
      let simulation = await simulations.start(request.params.id, parsed.data, user);
      await deps.audit(request, user, {
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
        simulation = await simulations.get(simulation.id, user) ?? simulation;
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

  app.post<{ Body: unknown; Querystring: { wait?: string } }>("/api/data-destinations/preview", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    const parsed = destinationPreviewRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.message ?? "Invalid preview request", issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join(".") || "(root)", message: issue.message })) };
    }
    try {
      const rows = await deps.destinations.previewRows({ rows: parsed.data.rows as Array<Record<string, unknown>>, removedIds: parsed.data.removedIds });
      let simulation = await simulations.startDestinationPreview(rows, { ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}) }, user);
      await deps.audit(request, user, {
        eventType: "guard.destination_preview.started",
        category: "system",
        action: "execute",
        resourceType: "data_destination",
        resourceId: simulation.id,
        metadata: { simulationId: simulation.id, rows: parsed.data.rows.length, removed: parsed.data.removedIds.length, jobIds: simulation.jobIds, workflows: simulation.workflows?.length ?? 0 }
      });
      if (request.query.wait === "true") {
        await simulations.wait(simulation.id);
        simulation = await simulations.get(simulation.id, user) ?? simulation;
      }
      reply.code(simulation.status === "running" ? 202 : 200);
      return { simulation };
    } catch (error) {
      if (error instanceof DataDestinationError) {
        reply.code(error.statusCode);
        return { error: error.message, ...(error.details ?? {}) };
      }
      if (error instanceof GuardSimulationBusyError) {
        reply.code(409);
        return { error: error.message, ...(error.simulationId !== "starting" ? { simulationId: error.simulationId } : {}) };
      }
      throw error;
    }
  });

  app.get<{ Querystring: { limit?: string } }>("/api/data-destinations/previews", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    const limit = Number(request.query.limit);
    return { simulations: await simulations.list(DESTINATION_PREVIEW_SIMULATION_PROFILE, user, Number.isFinite(limit) ? limit : 5) };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/guard/profiles/:id/simulations", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const denial = await editorDenial(user, request.params.id);
    if (denial) return deny(reply, denial);
    const limit = Number(request.query.limit);
    return { simulations: await simulations.list(request.params.id, user, Number.isFinite(limit) ? limit : 20) };
  });

  app.get<{ Params: { id: string } }>("/api/guard/simulations/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const record = await store.getGuardSimulation(request.params.id);
    if (!record) {
      reply.code(404);
      return { error: "Simulation not found" };
    }
    const denial = await editorDenial(user, record.profileId);
    if (denial) return deny(reply, denial.status === 404 ? { status: 404, error: "Simulation not found" } : denial);
    if (!await simulations.visibleTo(record, user)) {
      reply.code(404);
      return { error: "Simulation not found" };
    }
    const simulation = await simulations.get(record.id, user);
    if (!simulation) {
      reply.code(404);
      return { error: "Simulation not found" };
    }
    return { simulation };
  });

  app.post<{ Params: { id: string } }>("/api/guard/simulations/:id/cancel", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const record = await store.getGuardSimulation(request.params.id);
    if (!record || !await simulations.visibleTo(record, user)) {
      reply.code(404);
      return { error: "Simulation not found" };
    }
    if (!simulations.mayCancel(record, user)) {
      reply.code(403);
      return { error: "Only an admin or the person who started a simulation can cancel it" };
    }
    const simulation = await simulations.cancel(record.id, user);
    if (!simulation) {
      reply.code(404);
      return { error: "Simulation not found" };
    }
    await deps.audit(request, user, {
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
