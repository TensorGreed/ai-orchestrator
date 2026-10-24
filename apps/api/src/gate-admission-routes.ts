/**
 * Release gate admission and required cases (enforced gates only).
 *
 *   GET  /api/workflows/:id/release-gate/cases                       the gate's cases: admitted, pending, required (viewer)
 *   POST /api/workflows/:id/release-gate/cases/admit                 { fixtureIds, reason? }: count pending cases (admins)
 *   POST /api/workflows/:id/release-gate/cases/reject                { fixtureIds, reason? }: pending cases leave their sets (admins)
 *   PUT  /api/workflows/:id/release-gate/cases/:fixtureId/required   { required }: must pass on every publish (admins)
 *   POST /api/workflows/:id/release-gate/cases/requests              { action: "admit" | "remove", fixtureIds, reason }:
 *                                                                     ask the gate's approvers (workflow:write) -> 202 { request }
 *
 * Requests are decided in the approvals inbox (`/api/approvals/:id/approve`
 * and `/reject` with a `gcr_` id). Access goes through the shared
 * run-access helper (run-access.ts): a workflow the user cannot read
 * answers 404, one they can read but may not act on 403; admins always pass.
 * On Postgres every route answers 501.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { gateCaseDecisionInputSchema, gateCaseRequestInputSchema, gateCaseRequiredInputSchema } from "@ai-orchestrator/shared";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { GateAdmissionService } from "./services/gate-admission-service.js";
import { ReleaseError } from "./services/release-service.js";

export interface GateAdmissionRoutesDeps {
  app: FastifyInstance;
  admission: GateAdmissionService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
}

type Params = { Params: { id: string } };

export function registerGateAdmissionRoutes(deps: GateAdmissionRoutesDeps): void {
  const { app, admission, requireRole } = deps;

  const handle = async <T>(request: FastifyRequest, reply: FastifyReply, roles: UserRole[], work: (user: SafeUser) => T | Promise<T>) => {
    const user = await requireRole(request, reply, roles);
    if (!user) return reply;
    if (!admission.available) {
      reply.code(501);
      return { error: "Release gates need the SQLite store in this release" };
    }
    try {
      return await work(user);
    } catch (error) {
      if (error instanceof ReleaseError) {
        reply.code(error.statusCode);
        return { error: error.message, ...(error.details ?? {}) };
      }
      throw error;
    }
  };

  const invalid = (reply: FastifyReply, what: string, issues: unknown) => {
    reply.code(400);
    return { error: `Invalid ${what}`, details: issues };
  };

  app.get<Params>("/api/workflows/:id/release-gate/cases", (request, reply) =>
    handle(request, reply, ["viewer"], (user) => ({ cases: admission.casesView(user, request.params.id) }))
  );

  app.post<Params & { Body: unknown }>("/api/workflows/:id/release-gate/cases/admit", (request, reply) =>
    handle(request, reply, ["builder"], (user) => {
      const parsed = gateCaseDecisionInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, "admission", parsed.error.issues);
      return { cases: admission.admit(user, request.params.id, parsed.data) };
    })
  );

  app.post<Params & { Body: unknown }>("/api/workflows/:id/release-gate/cases/reject", (request, reply) =>
    handle(request, reply, ["builder"], (user) => {
      const parsed = gateCaseDecisionInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, "rejection", parsed.error.issues);
      return { cases: admission.reject(user, request.params.id, parsed.data) };
    })
  );

  app.put<{ Params: { id: string; fixtureId: string }; Body: unknown }>("/api/workflows/:id/release-gate/cases/:fixtureId/required", (request, reply) =>
    handle(request, reply, ["builder"], (user) => {
      const parsed = gateCaseRequiredInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, "required setting", parsed.error.issues);
      return { cases: admission.setRequired(user, request.params.id, request.params.fixtureId, parsed.data.required) };
    })
  );

  app.post<Params & { Body: unknown }>("/api/workflows/:id/release-gate/cases/requests", (request, reply) =>
    handle(request, reply, ["builder"], (user) => {
      const parsed = gateCaseRequestInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, "request", parsed.error.issues);
      const view = admission.request(user, request.params.id, parsed.data);
      reply.code(202);
      return { request: view };
    })
  );
}
