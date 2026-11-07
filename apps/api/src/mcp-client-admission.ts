/**
 * Phase 13.2 — the per-client network checks a gateway client's token is subject to: its pinned client certificates
 * and its address list. One implementation for every endpoint that accepts these tokens (`/mcp/*` and `/v1/*`), so a
 * token pinned to an address or certificate is pinned everywhere; each endpoint answers a refusal in its own format.
 */
import type { FastifyRequest } from "fastify";
import type { McpClient } from "@ai-orchestrator/shared";
import { certificateAccepted, readClientCertificate, type ClientCertificateReading } from "./client-certificate.js";
import { KeySampler, NETWORK_AUDIT_SAMPLE_MS, type NetworkControls } from "./network-controls.js";
import type { AuditEventInput } from "./services/audit-service.js";

export interface McpClientAdmissionDeps {
  /** Absent: a client with a pin or an address list is refused (nothing can vouch for it). */
  network?: NetworkControls;
  auditRaw: (event: AuditEventInput) => void | Promise<void>;
  /** Added to the audit event, to tell the endpoints apart. */
  auditMetadata?: Record<string, unknown>;
}

export interface McpClientAdmission {
  /** Null when the client pins no certificate or presented one it accepts; otherwise why it was refused, for the caller. */
  certificateRefusal(request: FastifyRequest, client: McpClient): Promise<string | null>;
  /** True when the client has no address list or the request's address is on it (report mode: admitted and recorded). */
  addressAdmitted(request: FastifyRequest, client: McpClient): Promise<boolean>;
}

/** Why a client that pins certificates was refused, as the client sees it. */
function refusalText(reading: ClientCertificateReading | { status: "mismatch" }): string {
  switch (reading.status) {
    case "invalid":
      return "The client certificate could not be read.";
    case "expired":
      return "The client certificate has expired or is not yet valid.";
    case "mismatch":
      return "The client certificate is not one this client accepts.";
    default:
      return "This client requires a client certificate, presented through the gateway's TLS proxy.";
  }
}

export function createMcpClientAdmission(deps: McpClientAdmissionDeps): McpClientAdmission {
  const auditSampler = new KeySampler(NETWORK_AUDIT_SAMPLE_MS);
  return {
    async certificateRefusal(request, client) {
      // A client that pins certificates needs its token AND one of its certificates.
      if (client.certFingerprints.length === 0) return null;
      const reading = deps.network
        ? readClientCertificate(request, { header: deps.network.settings.clientCertHeader, proxies: deps.network.clientCertProxies })
        : ({ status: "none" } as const);
      const refusal = reading.status !== "ok" ? reading : certificateAccepted(client, reading.certificate) ? null : ({ status: "mismatch" } as const);
      if (!refusal) return null;
      if (auditSampler.take(`${client.id}|${request.ip}|${refusal.status}`)) {
        await deps.auditRaw({
          category: "system",
          eventType: "mcp_gateway.client_certificate_refused",
          action: "access",
          outcome: "denied",
          actor: { type: "api_key", email: client.name, ipAddress: request.ip },
          resourceType: "mcp_client",
          resourceId: client.id,
          metadata: {
            reason: refusal.status,
            ...(reading.status === "ok" || reading.status === "expired" ? { fingerprint256: reading.certificate.fingerprint256, subject: reading.certificate.subject } : {}),
            sampleWindowSeconds: NETWORK_AUDIT_SAMPLE_MS / 1000,
            ...deps.auditMetadata
          }
        });
      }
      return refusalText(refusal);
    },

    async addressAdmitted(request, client) {
      // Empty = any address.
      if (client.allowedIps.length === 0) return true;
      if (!deps.network) return false;
      return await deps.network.checkObjectList(
        request,
        { restricted: true, ranges: client.allowedIps },
        { list: "mcp_client", clientId: client.id, clientName: client.name }
      );
    }
  };
}
