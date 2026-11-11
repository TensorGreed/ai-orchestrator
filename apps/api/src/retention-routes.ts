/**
 * 13.3 — data retention, read-only.
 *
 *   GET /api/admin/retention   the deployment's retention per class, the backlog, the latest purges and the next one (admins)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RetentionAdminView } from "@ai-orchestrator/shared";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { RetentionService } from "./services/retention-service.js";

export interface RetentionRoutesDeps {
  app: FastifyInstance;
  retention: RetentionService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
}

export function registerRetentionRoutes(deps: RetentionRoutesDeps): void {
  const { app, retention, requireRole } = deps;
  app.get("/api/admin/retention", async (request, reply): Promise<RetentionAdminView | undefined> => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return undefined;
    return await retention.view();
  });
}
