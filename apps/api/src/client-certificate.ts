/**
 * Phase 13.2 — client certificates for the MCP gateway. A TLS-terminating proxy (nginx, an ingress, Envoy) verifies
 * the client certificate and forwards it in a header (MCP_GATEWAY_CLIENT_CERT_HEADER). The header is honoured only
 * when the connecting socket is one of MCP_GATEWAY_CLIENT_CERT_PROXIES; from anywhere else it is ignored, so a
 * client cannot present a certificate by setting the header itself. Everything downstream works on the
 * `ClientCertificate` shape, whatever carried the certificate.
 */
import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";
import { normalizeCertFingerprint, type McpClient } from "@ai-orchestrator/shared";
import type { AddressList } from "./network-controls.js";

export interface ClientCertificate {
  /** SHA-256 of the DER certificate, 64 lower-case hex digits. */
  fingerprint256: string;
  /** The subject as Node prints it (`CN=agent\nO=Example`). */
  subject: string;
  commonName: string | null;
  /** Subject alternative names as `TYPE:value` (`DNS:agent.example.com`, `URI:spiffe://…`). */
  subjectAltNames: string[];
  validFrom: string;
  validTo: string;
  /** How the certificate reached the server. */
  source: "forwarded_header";
}

export type ClientCertificateReading =
  | { status: "none" }
  /** The header arrived from an address that is not a trusted proxy and was ignored. */
  | { status: "untrusted" }
  | { status: "invalid" }
  | { status: "expired"; certificate: ClientCertificate }
  | { status: "ok"; certificate: ClientCertificate };

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

/** The certificate text out of an Envoy `x-forwarded-client-cert` element (`Hash=…;Cert="…";Subject="…"`), if any. */
function xfccCert(value: string): string | null {
  const match = value.match(/(?:^|[;,])\s*Cert="([^"]*)"/i);
  return match ? match[1]! : null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Reads a forwarded certificate: a PEM block (as `$ssl_client_cert` gives it), URL-encoded PEM (nginx
 * `$ssl_client_escaped_cert`, AWS ALB), an Envoy XFCC element with `Cert="…"`, or base64 DER. Null when it is none.
 */
export function parseForwardedCertificate(raw: string): crypto.X509Certificate | null {
  let value = raw.trim();
  if (!value) return null;
  value = xfccCert(value) ?? value;
  if (value.includes("%")) value = safeDecode(value);
  const pem = value.match(PEM_BLOCK)?.[0];
  try {
    if (pem) {
      // A PEM block folded onto one header line (tabs or spaces for newlines) is restored line by line.
      const body = pem
        .replace("-----BEGIN CERTIFICATE-----", "")
        .replace("-----END CERTIFICATE-----", "")
        .replace(/\s+/g, "");
      return new crypto.X509Certificate(`-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`);
    }
    if (/^[A-Za-z0-9+/=\s]+$/.test(value)) return new crypto.X509Certificate(Buffer.from(value.replace(/\s+/g, ""), "base64"));
  } catch {
    return null;
  }
  return null;
}

export function describeCertificate(certificate: crypto.X509Certificate): ClientCertificate {
  const commonName = certificate.subject
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("CN="));
  return {
    fingerprint256: normalizeCertFingerprint(certificate.fingerprint256) ?? "",
    subject: certificate.subject,
    commonName: commonName ? commonName.slice(3) : null,
    subjectAltNames: (certificate.subjectAltName ?? "")
      .split(/,\s*/)
      .map((entry) => entry.trim())
      .filter(Boolean),
    validFrom: new Date(certificate.validFrom).toISOString(),
    validTo: new Date(certificate.validTo).toISOString(),
    source: "forwarded_header"
  };
}

/** The client certificate a request carries, honoured only from a trusted proxy's socket address. */
export function readClientCertificate(
  request: Pick<FastifyRequest, "headers" | "socket">,
  settings: { header: string | null; proxies: AddressList },
  now: Date = new Date()
): ClientCertificateReading {
  if (!settings.header) return { status: "none" };
  const header = request.headers[settings.header];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return { status: "none" };
  if (!settings.proxies.has(request.socket?.remoteAddress)) return { status: "untrusted" };
  const parsed = parseForwardedCertificate(value);
  if (!parsed) return { status: "invalid" };
  const certificate = describeCertificate(parsed);
  const at = now.getTime();
  if (at < new Date(certificate.validFrom).getTime() || at > new Date(certificate.validTo).getTime()) {
    return { status: "expired", certificate };
  }
  return { status: "ok", certificate };
}

/** True when the subject pin names the certificate's CN or one of its alternative names (with or without `TYPE:`). */
export function subjectPinMatches(pin: string, certificate: ClientCertificate): boolean {
  if (certificate.commonName === pin || certificate.subject === pin) return true;
  return certificate.subjectAltNames.some((entry) => entry === pin || entry.slice(entry.indexOf(":") + 1) === pin);
}

/** A client that pins certificates accepts one whose fingerprint it lists and, with a subject pin, whose subject matches. */
export function certificateAccepted(client: Pick<McpClient, "certFingerprints" | "certSubject">, certificate: ClientCertificate): boolean {
  if (!client.certFingerprints.includes(certificate.fingerprint256)) return false;
  return client.certSubject ? subjectPinMatches(client.certSubject, certificate) : true;
}
