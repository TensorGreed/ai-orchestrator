/**
 * 12.7 — content rules benchmark routes.
 *
 *   POST /api/guard/profiles/:id/benchmark   run the red-team corpus through the rule set: the latest saved version, a
 *                                            given `version` (both stored when the run is full), or an unsaved
 *                                            `document` (returned only); a category or split filter is never stored
 *   GET  /api/guard/profiles/:id/benchmarks  the rule set's stored benchmarks, newest first (headline rates)
 *   GET  /api/guard/benchmarks/:id           one stored benchmark with its full report
 *
 * Builders and admins run benchmarks. A saved version may be benchmarked by
 * any builder (the default rule set included): it is a measurement that
 * reads no workflow data and changes nothing. A draft follows the rule set
 * editor's rule (as simulations do): not the default rule set, not a
 * rule set a project enforces, not the deployment's destination rules,
 * unless the user is an admin. Viewers and up read stored results, like the
 * rest of the Security page. One benchmark runs at a time per instance: a
 * second gets 409. Storing is a write: a user who is not an admin stores at
 * most one benchmark per rule set version every 10 minutes (429). Benchmark
 * verdicts never reach guard_events.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GUARD_DESTINATION_RULES_PROFILE_ID, guardBenchmarkRequestSchema } from "@ai-orchestrator/shared";
import type { Store } from "./db/store.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import { GuardBenchmarkBusyError, GuardBenchmarkRateLimitedError, type GuardBenchmarkService } from "./services/guard-benchmark-service.js";
import { GuardNotFoundError, GuardValidationError } from "./services/guard-service.js";

export interface GuardBenchmarkRoutesDeps {
  app: FastifyInstance;
  store: Store;
  benchmarks: GuardBenchmarkService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  audit: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void | Promise<void>;
}

export function registerGuardBenchmarkRoutes(deps: GuardBenchmarkRoutesDeps): void {
  const { app, store, benchmarks, requireRole } = deps;

  /** Why `user` may not benchmark this rule set (a draft needs editor rights); null when they may. */
  const denial = async (user: SafeUser, profileId: string, draft: boolean): Promise<{ status: 403 | 404; error: string } | null> => {
    const profile = await store.getGuardProfile(profileId);
    if (!profile) return { status: 404, error: "Rule set not found" };
    if (user.role === "admin" || !draft) return null;
    if (profileId === GUARD_DESTINATION_RULES_PROFILE_ID) return { status: 403, error: "The deployment's destination rules apply to every workflow; only an admin can benchmark a draft of them" };
    if (profile.builtIn) return { status: 403, error: "The default rule set is read-only; only an admin can benchmark a draft of it. Duplicate it to benchmark your own." };
    const enforced = (await store.listGuardBindingsForProfile(profileId)).some((binding) => binding.scope === "project" && binding.mode === "enforced");
    if (enforced) return { status: 403, error: "This rule set is enforced on a project; only an admin can benchmark a draft of it" };
    return null;
  };

  app.post<{ Params: { id: string }; Body: unknown }>("/api/guard/profiles/:id/benchmark", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const parsed = guardBenchmarkRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid benchmark request", issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join(".") || "(root)", message: issue.message })) };
    }
    const denied = await denial(user, request.params.id, parsed.data.document !== undefined);
    if (denied) {
      reply.code(denied.status);
      return { error: denied.error };
    }
    try {
      const result = await benchmarks.run(request.params.id, parsed.data, user);
      await deps.audit(request, user, {
        eventType: "guard.benchmark.run",
        category: "system",
        action: "execute",
        resourceType: "guard_profile",
        resourceId: request.params.id,
        metadata: {
          draft: result.draft,
          version: result.report.profile.version,
          suites: parsed.data.suites ?? ["profile"],
          corpusHash: result.report.corpus.hash,
          storedId: result.stored?.id ?? null,
          partial: result.partial,
          regressions: result.comparison?.failures.length ?? 0
        }
      });
      return result;
    } catch (error) {
      if (error instanceof GuardValidationError) {
        reply.code(400);
        return { error: error.message, issues: error.issues };
      }
      if (error instanceof GuardNotFoundError) {
        reply.code(404);
        return { error: error.message };
      }
      if (error instanceof GuardBenchmarkBusyError) {
        reply.code(409);
        return { error: error.message };
      }
      if (error instanceof GuardBenchmarkRateLimitedError) {
        reply.code(429);
        reply.header("retry-after", String(error.retryAfterSeconds));
        return { error: error.message };
      }
      if (error instanceof Error && /^No corpus category/.test(error.message)) {
        reply.code(400);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/guard/profiles/:id/benchmarks", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    if (!(await store.getGuardProfile(request.params.id))) {
      reply.code(404);
      return { error: "Rule set not found" };
    }
    const limit = Number(request.query.limit);
    return { benchmarks: await benchmarks.list(request.params.id, Number.isFinite(limit) && limit > 0 ? limit : undefined) };
  });

  app.get<{ Params: { id: string } }>("/api/guard/benchmarks/:id", async (request, reply) => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return reply;
    const found = await benchmarks.get(request.params.id);
    if (!found) {
      reply.code(404);
      return { error: "Benchmark not found" };
    }
    return { benchmark: found.record, report: found.report };
  });
}
