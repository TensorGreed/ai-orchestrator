/**
 * Phase 11.1 — signed run manifests, audit bundle export and the
 * deployment's signing keys.
 *
 *   GET  /api/executions/:id/manifest      the run's signed manifest (generated once, then cached)
 *   GET  /api/executions/:id/bundle        the audit bundle (zip), streamed; audit-logged
 *   GET  /api/audit/signing-keys           public keys, active and retired (admins)
 *   POST /api/audit/signing-keys/rotate    new generated key, old one retired (admins)
 *
 * Who may read a manifest or export a bundle: anyone who may read the
 * execution (viewer and up) and the workflow it belongs to; runs of a
 * workflow that no longer exists are admin-only. Runs still in progress
 * are refused with 409.
 */

import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SqliteStore } from "./db/database.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import { AuditBundleError, type AuditBundleService } from "./services/audit-bundle-service.js";
import { AuditSigningKeyError, type AuditSigningService } from "./services/audit-signing-service.js";

export interface AuditBundleRoutesDeps {
  app: FastifyInstance;
  store: SqliteStore;
  bundles: AuditBundleService;
  signing: AuditSigningService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  canAccessWorkflow: (user: SafeUser, workflow: { id: string; projectId?: string }, permission: "workflow:read" | "workflow:write") => boolean;
  audit: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void;
}

const STATUS_BY_CODE: Record<AuditBundleError["code"], number> = {
  not_found: 404,
  in_progress: 409,
  too_large: 413,
  invalid: 500
};

export function registerAuditBundleRoutes(deps: AuditBundleRoutesDeps): void {
  const { app, store, bundles, signing, requireRole } = deps;

  /** The execution's workflow must be readable by the user; a deleted workflow's runs are admin-only. */
  const canReadExecution = (user: SafeUser, executionId: string): "ok" | "not_found" | "forbidden" => {
    const history = store.getExecutionHistory(executionId);
    if (!history) return "not_found";
    if (user.role === "admin") return "ok";
    const workflow = store.getWorkflow(history.workflowId);
    if (!workflow) return "forbidden";
    return deps.canAccessWorkflow(user, workflow, "workflow:read") ? "ok" : "forbidden";
  };

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof AuditBundleError) {
      reply.code(STATUS_BY_CODE[error.code]);
      return { error: error.message, code: error.code };
    }
    if (error instanceof AuditSigningKeyError) {
      reply.code(error.code === "env_managed" ? 409 : 503);
      return { error: error.message, code: error.code };
    }
    throw error;
  };

  const guard = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<SafeUser | null> => {
    const user = await requireRole(request, reply, ["viewer"]);
    if (!user) return null;
    const access = canReadExecution(user, request.params.id);
    if (access === "not_found") {
      reply.code(404).send({ error: "Execution not found" });
      return null;
    }
    if (access === "forbidden") {
      reply.code(403).send({ error: "Insufficient permissions for this execution" });
      return null;
    }
    return user;
  };

  app.get<{ Params: { id: string } }>("/api/executions/:id/manifest", async (request, reply) => {
    const user = await guard(request, reply);
    if (!user) return reply;
    try {
      return await bundles.getManifest(request.params.id);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/executions/:id/bundle", async (request, reply) => {
    const user = await guard(request, reply);
    if (!user) return reply;
    let prepared;
    try {
      prepared = await bundles.prepareBundle(request.params.id);
    } catch (error) {
      if (error instanceof AuditBundleError && error.code === "too_large") {
        deps.audit(request, user, {
          eventType: "execution.audit_bundle.export",
          category: "execution",
          action: "export",
          outcome: "failure",
          resourceType: "execution",
          resourceId: request.params.id,
          metadata: { executionId: request.params.id, reason: "too_large" }
        });
      }
      return fail(reply, error);
    }
    deps.audit(request, user, {
      eventType: "execution.audit_bundle.export",
      category: "execution",
      action: "export",
      resourceType: "execution",
      resourceId: request.params.id,
      metadata: { executionId: request.params.id, manifestDigest: prepared.manifestDigest, keyId: prepared.keyId, bytes: prepared.zip.size, files: prepared.files }
    });
    const chunks = prepared.zip.chunks();
    reply.header("content-type", "application/zip");
    reply.header("content-length", String(prepared.zip.size));
    reply.header("content-disposition", `attachment; filename="${prepared.fileName}"`);
    reply.header("cache-control", "no-store");
    reply.header("x-l2m-manifest-digest", prepared.manifestDigest);
    reply.header("x-l2m-signing-key-id", prepared.keyId);
    return reply.send(Readable.from((function* () {
      for (const chunk of chunks) yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    })()));
  });

  app.get("/api/audit/signing-keys", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    try {
      return signing.list();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/api/audit/signing-keys/rotate", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    try {
      // Read from the store: rotation must also work when the current key can no longer be decrypted.
      const previous = store.getActiveAuditSigningKey()?.keyId ?? null;
      const key = signing.rotate();
      deps.audit(request, user, {
        eventType: "audit.signing_key.rotated",
        category: "system",
        action: "rotate",
        resourceType: "audit_signing_key",
        resourceId: key.keyId,
        metadata: { keyId: key.keyId, previousKeyId: previous }
      });
      reply.code(201);
      return { key, keys: signing.list() };
    } catch (error) {
      return fail(reply, error);
    }
  });
}
