/**
 * 13.2 — network controls: the address allowlists a deployment, an MCP gateway client or a webhook trigger can set,
 * and the client certificate pin of a gateway client. Everything here is pure (no Node APIs) so the studio validates
 * entries the same way the API does; the API matches addresses with Node's `net.BlockList`.
 */
import { z } from "zod";
import { canonicalIpRange } from "./data-destinations";

/**
 * The deployment-wide scopes a request falls in, by route family and credential:
 * - `ui`: studio traffic (`/api/*` with a session cookie or no credential, sign-in, SSO and OAuth callbacks)
 * - `api`: `/api/*` with a bearer token or API key
 * - `webhook`: `/webhook/*`, `/webhook-test/*`, provider webhooks under `/api/webhooks/*`, `/api/mcp-server/*`
 * - `public`: forms, chat, the widget and the helper chat
 * - `mcp_gateway`: `/mcp/*`
 * - `metrics`: `/metrics` and the API docs
 */
export const NETWORK_SCOPES = ["ui", "api", "webhook", "public", "mcp_gateway", "metrics"] as const;
export type NetworkScope = (typeof NETWORK_SCOPES)[number];

/** The environment variable that holds each scope's list. */
export const NETWORK_SCOPE_ENV: Record<NetworkScope, string> = {
  ui: "NETWORK_ALLOW_UI",
  api: "NETWORK_ALLOW_API",
  webhook: "NETWORK_ALLOW_WEBHOOK",
  public: "NETWORK_ALLOW_PUBLIC",
  mcp_gateway: "NETWORK_ALLOW_MCP_GATEWAY",
  metrics: "NETWORK_ALLOW_METRICS"
};

export const NETWORK_ALLOWLIST_MODES = ["enforce", "report"] as const;
export type NetworkAllowlistMode = (typeof NETWORK_ALLOWLIST_MODES)[number];

/** Most entries one allowlist (a scope, a client or a webhook trigger) takes. */
export const IP_ALLOWLIST_MAX_ENTRIES = 200;
/** Most certificate fingerprints one gateway client keeps (old and new during a rotation). */
export const CERT_FINGERPRINTS_MAX = 10;

/** The fixed body of a refused request: it never says which list or address was checked. */
export const NETWORK_DENIED_MESSAGE = "Access from this address is not allowed";

/**
 * Reads an allowlist: each entry an IP address or CIDR range (IPv4 or IPv6), returned canonical and without
 * duplicates. `invalid` lists the entries that are neither, as given.
 */
export function parseIpAllowlist(entries: readonly string[]): { ranges: string[]; invalid: string[] } {
  const ranges: string[] = [];
  const invalid: string[] = [];
  for (const raw of entries) {
    const entry = String(raw ?? "").trim();
    if (!entry) continue;
    const canonical = canonicalIpRange(entry);
    if (!canonical) invalid.push(entry);
    else if (!ranges.includes(canonical)) ranges.push(canonical);
  }
  return { ranges, invalid };
}

/** A comma- or whitespace-separated list as entries (how the environment and the studio's text fields hold them). */
export function splitIpAllowlist(text: string | null | undefined): string[] {
  return String(text ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * An allowlist stored on an object (a webhook trigger's `allowedIps`, read from its config): the raw entries and
 * the valid ranges among them. `restricted` is true whenever any entry was given, so a list holding only entries
 * that are not addresses admits nobody rather than everybody.
 */
export function readStoredIpAllowlist(value: unknown): { restricted: boolean; ranges: string[]; invalid: string[] } {
  const entries = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? splitIpAllowlist(value)
      : [];
  const { ranges, invalid } = parseIpAllowlist(entries);
  return { restricted: ranges.length + invalid.length > 0, ranges, invalid };
}

export const ipAllowlistSchema = z
  .array(z.string().trim().max(64))
  .max(IP_ALLOWLIST_MAX_ENTRIES)
  .superRefine((entries, ctx) => {
    const { invalid } = parseIpAllowlist(entries);
    for (const entry of invalid) {
      ctx.addIssue({ code: "custom", message: `'${entry}' is not an IP address or CIDR range` });
    }
  })
  .transform((entries) => parseIpAllowlist(entries).ranges);

/**
 * A SHA-256 certificate fingerprint as 64 lower-case hex digits. Accepts the colon-separated form OpenSSL and Node
 * print (`AB:CD:…`) and an optional `sha256:` prefix. Undefined when the text is not one.
 */
export function normalizeCertFingerprint(value: string | null | undefined): string | undefined {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^sha-?256[:=]/, "")
    .replace(/[\s:]/g, "");
  return /^[0-9a-f]{64}$/.test(text) ? text : undefined;
}

export const certFingerprintListSchema = z
  .array(z.string().trim().max(128))
  .max(CERT_FINGERPRINTS_MAX)
  .superRefine((entries, ctx) => {
    for (const entry of entries) {
      if (entry && !normalizeCertFingerprint(entry)) {
        ctx.addIssue({ code: "custom", message: `'${entry}' is not a SHA-256 certificate fingerprint (64 hex digits)` });
      }
    }
  })
  .transform((entries) => [...new Set(entries.map((entry) => normalizeCertFingerprint(entry)).filter((entry): entry is string => Boolean(entry)))]);

/** `PUT /api/mcp/clients/:id/network`: the client's address allowlist and certificate pin (each field replaces). */
export const mcpClientNetworkUpdateSchema = z
  .object({
    allowedIps: ipAllowlistSchema.optional(),
    certFingerprints: certFingerprintListSchema.optional(),
    /** The certificate's subject CN, or one of its subject alternative names; null or empty clears it. */
    certSubject: z
      .string()
      .trim()
      .max(256)
      .nullable()
      .optional()
      .transform((value) => (value === undefined ? undefined : value ? value : null))
  })
  .strict()
  .refine((value) => value.allowedIps !== undefined || value.certFingerprints !== undefined || value.certSubject !== undefined, {
    message: "Empty update payload"
  });

export type McpClientNetworkUpdate = z.infer<typeof mcpClientNetworkUpdateSchema>;

/** `GET /api/settings/network` (admin): the deployment's lists, read-only, and how the caller's address fares. */
export interface NetworkSettingsView {
  mode: NetworkAllowlistMode;
  /** True when at least one scope has a list. */
  active: boolean;
  scopes: Array<{ scope: NetworkScope; env: string; ranges: string[]; matched: boolean | null }>;
  breakGlass: { ranges: string[]; matched: boolean };
  trustProxy: { configured: boolean; summary: string };
  clientCertificate: { header: string | null; proxies: string[] };
  /** The address this request is counted from (request.ip, which honours TRUST_PROXY). */
  yourIp: string;
  /** Scopes whose list holds your address (scopes without a list are open, so they are not named). */
  matchedScopes: NetworkScope[];
  warnings: string[];
}
