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
 * workflow that no longer exists are admin-only, and runs of a workflow the
 * user cannot read answer 404. Runs still in progress are refused with 409.
 */

import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import { AuditBundleError, type AuditBundleService } from "./services/audit-bundle-service.js";
import { AuditSigningKeyError, type AuditSigningService } from "./services/audit-signing-service.js";
import type { RunAccess } from "./run-access.js";
import type { Store } from "./db/store.js";

export interface AuditBundleRoutesDeps {
  app: FastifyInstance;
  store: Store;
  bundles: AuditBundleService;
  signing: AuditSigningService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  runAccess: RunAccess;
  audit: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void | Promise<void>;
}

const STATUS_BY_CODE: Record<AuditBundleError["code"], number> = {
  not_found: 404,
  in_progress: 409,
  too_large: 413,
  invalid: 500
};

export function registerAuditBundleRoutes(deps: AuditBundleRoutesDeps): void {
  const { app, store, bundles, signing, requireRole } = deps;

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
    // Readable workflow required (404 otherwise); a deleted workflow's runs are admin-only.
    const access = await deps.runAccess.run(user, await store.getExecutionHistory(request.params.id), "workflow:read");
    if (!access.ok) {
      reply.code(access.status).send({ error: access.error });
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
      prepared = await bundles.prepareBundle(request.params.id, { includeActorEmails: user.role === "admin" });
    } catch (error) {
      if (error instanceof AuditBundleError && error.code === "too_large") {
        await deps.audit(request, user, {
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
    await deps.audit(request, user, {
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
      return await signing.list();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/api/audit/signing-keys/rotate", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    try {
      // Read from the store: rotation must also work when the current key can no longer be decrypted.
      const previous = (await store.getActiveAuditSigningKey())?.keyId ?? null;
      const key = await signing.rotate();
      await deps.audit(request, user, {
        eventType: "audit.signing_key.rotated",
        category: "system",
        action: "rotate",
        resourceType: "audit_signing_key",
        resourceId: key.keyId,
        metadata: { keyId: key.keyId, previousKeyId: previous }
      });
      reply.code(201);
      return { key, keys: await signing.list() };
    } catch (error) {
      return fail(reply, error);
    }
  });
}
