/**
 * Phase 16 — data destinations (deployment-wide).
 *
 *   GET    /api/data-destinations               admin rows and the read-only built-ins (any signed-in role)
 *   GET    /api/data-destinations/unclassified  configured destinations no row covers (any signed-in role,
 *                                               scoped to the workflows and projects the user can read)
 *   POST   /api/data-destinations               add a row (admins)
 *   PUT    /api/data-destinations/:id           change a row (admins)
 *   DELETE /api/data-destinations/:id           remove a row (admins)
 *
 * Every change is audited (`data_destination.created|updated|deleted`) with
 * the row's match and classification. Built-in rows cannot be changed; an
 * admin row for the same host overrides one. On Postgres every route
 * answers 501. Destinations do nothing until a guard profile has
 * destination rules.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DataDestinationRow } from "@ai-orchestrator/shared";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import { DataDestinationError, type DataDestinationService } from "./services/data-destination-service.js";

export interface DataDestinationRoutesDeps {
  app: FastifyInstance;
  destinations: DataDestinationService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  audit: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void | Promise<void>;
}

type Params = { Params: { id: string } };

/** What the audit log keeps of a row: its match and classification, nothing else. */
function auditView(row: DataDestinationRow) {
  return { name: row.name, kind: row.kind, targetId: row.targetId, host: row.host, tier: row.tier, region: row.region, holdsDataClasses: row.holdsDataClasses };
}

export function registerDataDestinationRoutes(deps: DataDestinationRoutesDeps): void {
  const { app, destinations, requireRole } = deps;

  const handle = async <T>(request: FastifyRequest, reply: FastifyReply, roles: UserRole[], work: (user: SafeUser) => T | Promise<T>) => {
    const user = await requireRole(request, reply, roles);
    if (!user) return reply;
    if (!destinations.available) {
      reply.code(501);
      return { error: "Data destinations need the SQLite store in this release" };
    }
    try {
      return await work(user);
    } catch (error) {
      if (error instanceof DataDestinationError) {
        reply.code(error.statusCode);
        return { error: error.message, ...(error.details ?? {}) };
      }
      throw error;
    }
  };

  app.get("/api/data-destinations", (request, reply) =>
    handle(request, reply, ["viewer"], async (user) => ({ ...await destinations.list(), canEdit: user.role === "admin" }))
  );

  app.get("/api/data-destinations/unclassified", (request, reply) =>
    handle(request, reply, ["viewer"], async (user) => ({ destinations: await destinations.unclassified(user) }))
  );

  app.post<{ Body: unknown }>("/api/data-destinations", (request, reply) =>
    handle(request, reply, ["admin"], async (user) => {
      const destination = await destinations.create(request.body, user.email);
      await deps.audit(request, user, {
        eventType: "data_destination.created",
        category: "system",
        action: "create",
        resourceType: "data_destination",
        resourceId: destination.id,
        metadata: auditView(destination)
      });
      reply.code(201);
      return { destination };
    })
  );

  app.put<Params & { Body: unknown }>("/api/data-destinations/:id", (request, reply) =>
    handle(request, reply, ["admin"], async (user) => {
      const { before, after } = await destinations.update(request.params.id, request.body, user.email);
      await deps.audit(request, user, {
        eventType: "data_destination.updated",
        category: "system",
        action: "update",
        resourceType: "data_destination",
        resourceId: after.id,
        metadata: { before: auditView(before), after: auditView(after) }
      });
      return { destination: after };
    })
  );

  app.delete<Params>("/api/data-destinations/:id", (request, reply) =>
    handle(request, reply, ["admin"], async (user) => {
      const removed = await destinations.remove(request.params.id);
      await deps.audit(request, user, {
        eventType: "data_destination.deleted",
        category: "system",
        action: "delete",
        resourceType: "data_destination",
        resourceId: removed.id,
        metadata: auditView(removed)
      });
      return { deleted: true, id: removed.id };
    })
  );
}
