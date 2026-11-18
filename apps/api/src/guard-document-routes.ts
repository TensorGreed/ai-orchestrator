/**
 * The rule set page's "Scan a document" test.
 *
 *   POST /api/guard/profiles/:id/scan-document   { source: upload | url, document? | version?, entityTypes?, redact? }
 *
 * Builders and admins. The rule set's unsaved draft (`document`, never stored), a saved `version`, or else the latest.
 * URL fetches go through the outbound URL checks with the deployment's policy (OUTBOUND_DENY_PRIVATE,
 * OUTBOUND_ALLOWLIST), as HTTP Request nodes do. No rule events (a test); an audit entry `guard.document_scan_test`
 * with the origin or "upload", the size and the counts per class, never content. Errors: 400 for an invalid,
 * unsupported or oversized document, 404 for an unknown rule set or version, 422 for a URL the outbound checks refuse,
 * 429 past 10 scans a minute (or when the process is busy), 502/504 when the server fails or is too slow, 503 when
 * names and addresses could not be checked. A caller that goes away stops the fetch and the scan (audited as cancelled).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { documentScanRequestSchema } from "@ai-orchestrator/shared";
import { DocumentError } from "@ai-orchestrator/workflow-engine";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import type { AuditEventInput } from "./services/audit-service.js";
import { GuardNotFoundError, GuardValidationError, type GuardService } from "./services/guard-service.js";
import { DocumentScanBusyError, type ContentDocumentScanService } from "./services/content-document-scan-service.js";

export interface GuardDocumentRoutesDeps {
  app: FastifyInstance;
  guard: GuardService;
  documents: ContentDocumentScanService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  audit: (request: FastifyRequest, user: SafeUser, event: Omit<AuditEventInput, "actor">) => void | Promise<void>;
}

export function registerGuardDocumentRoutes(deps: GuardDocumentRoutesDeps): void {
  const { app, guard, documents, requireRole } = deps;

  app.post<{ Params: { id: string }; Body: unknown }>("/api/guard/profiles/:id/scan-document", async (request, reply) => {
    const user = await requireRole(request, reply, ["builder"]);
    if (!user) return reply;
    const parsed = documentScanRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.message ?? "Invalid scan request", issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join(".") || "(root)", message: issue.message })) };
    }
    const body = parsed.data;
    const profileId = request.params.id;
    let ruleSet: { id: string; version: number; profile: Awaited<ReturnType<GuardService["simulationProfile"]>>["profile"] };
    try {
      if (body.document !== undefined || body.version !== undefined) {
        const substitute = await guard.simulationProfile(profileId, body.document !== undefined ? { document: body.document } : { version: body.version! });
        ruleSet = { id: profileId, version: substitute.version, profile: substitute.profile };
      } else {
        const loaded = await guard.loadProfile(profileId);
        if (!loaded) throw new GuardNotFoundError("Rule set not found");
        ruleSet = { id: profileId, version: loaded.version, profile: loaded.profile };
      }
    } catch (error) {
      if (error instanceof GuardValidationError) {
        reply.code(400);
        return { error: error.message, issues: error.issues };
      }
      if (error instanceof GuardNotFoundError) {
        reply.code(404);
        return { error: error.message };
      }
      throw error;
    }

    const auditScan = async (outcome: "success" | "failure", metadata: Record<string, unknown>) =>
      await deps.audit(request, user, {
        eventType: "guard.document_scan_test",
        category: "system",
        action: "execute",
        outcome,
        resourceType: "guard_profile",
        resourceId: profileId,
        metadata: { ruleSetVersion: ruleSet.version, draft: body.document !== undefined, ...metadata }
      });

    const sourceRef = body.source.kind === "upload" ? { source: "upload" } : (() => {
      try {
        return { source: new URL(body.source.url).origin };
      } catch {
        return { source: "url" };
      }
    })();
    // The caller closing the connection before the answer is sent stops the fetch and the scan.
    const disconnect = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) disconnect.abort();
    };
    reply.raw.on("close", onClose);
    // A connection that closed while the rule set loaded has already sent its close event.
    if (reply.raw.destroyed && !reply.raw.writableFinished) disconnect.abort();
    try {
      const { result, total } = await documents.testScan(body, ruleSet, user, disconnect.signal);
      await auditScan("success", {
        ...(result.source.kind === "url" ? { source: result.source.origin, pathHash: result.source.pathHash } : { source: "upload" }),
        bytes: result.bytes,
        type: result.sniffedType,
        findings: total,
        counts: result.countsByClass,
        truncated: result.truncated,
        ...(result.pages ? { pages: result.pages, textLayer: result.textLayer } : {})
      });
      return { result };
    } catch (error) {
      if (error instanceof DocumentScanBusyError) {
        reply.code(429);
        return { error: error.message };
      }
      if (error instanceof DocumentError) {
        await auditScan("failure", { ...sourceRef, code: error.code, ...(error.reason ? { reason: error.reason } : {}) });
        reply.code(error.status);
        return { error: error.message, code: error.code, ...(error.reason ? { reason: error.reason } : {}) };
      }
      throw error;
    } finally {
      reply.raw.off("close", onClose);
    }
  });
}
