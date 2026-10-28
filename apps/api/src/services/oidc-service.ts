/**
 * Phase 13.2 — OpenID Connect single sign-on (Authorization Code flow with PKCE).
 *
 * Flow: `beginLogin` reads the IdP's discovery document, creates `state`, `nonce` and a PKCE (S256) pair, and returns
 * the authorization URL plus a sealed flow cookie (AES-256-GCM, HttpOnly, ten minutes). `completeLogin` opens that
 * cookie, checks `state`, exchanges the code (with the PKCE verifier and, for confidential clients, the client
 * secret), and validates the ID token: signature against the IdP's JWKS (asymmetric algorithms only, so `none` and
 * HS* are refused), `iss`, `aud`, `azp`, `exp`/`iat` with a small clock skew, and `nonce`.
 *
 * Discovery and the JWKS are cached; an ID token signed with an unknown `kid` refetches the JWKS once (rate limited),
 * so IdP key rotation needs no restart. User provisioning and role mapping reuse the SAML/LDAP path in app.ts; this
 * service only resolves the mappings stored for provider `oidc`.
 *
 * Nothing here logs or returns tokens, codes or the client secret; error messages carry reasons only.
 */

import crypto from "node:crypto";
import {
  createLocalJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey
} from "jose";
import { nanoid } from "nanoid";
import { isAllowedOidcUrl, type OidcSettings } from "../config.js";
import type { Store } from "../db/store.js";
import type { UserRole } from "./auth-service.js";

export const OIDC_FLOW_COOKIE_NAME = "l2m_oidc_flow";
export const OIDC_FLOW_COOKIE_PATH = "/api/auth/oidc";
export const OIDC_FLOW_MAX_AGE_MS = 10 * 60 * 1000;
/** Asymmetric signature algorithms accepted for ID tokens. `none` and HS* are never accepted. */
export const OIDC_ID_TOKEN_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"];
export const OIDC_CLOCK_SKEW_SECONDS = 60;
/** ID tokens are minted during the code exchange; anything older than this is refused. */
export const OIDC_MAX_ID_TOKEN_AGE_SECONDS = 10 * 60;

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_REFETCH_COOLDOWN_MS = 30 * 1000;
const HTTP_TIMEOUT_MS = 10 * 1000;
const FLOW_AAD = Buffer.from("l2m-oidc-flow-v1");

export type OidcErrorCode =
  | "not_configured"
  | "discovery_failed"
  | "state_mismatch"
  | "idp_error"
  | "invalid_response"
  | "token_exchange_failed"
  | "invalid_id_token"
  | "missing_email"
  | "email_not_verified";

export class OidcError extends Error {
  constructor(
    public readonly code: OidcErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OidcError";
  }
}

/** The short code put on the login page URL (`?sso_error=`); details stay in the server log. */
export function oidcUserErrorCode(error: unknown): string {
  if (error instanceof OidcError) {
    switch (error.code) {
      case "state_mismatch":
        return "oidc_state";
      case "idp_error":
        return "oidc_denied";
      case "missing_email":
      case "email_not_verified":
        return "oidc_email";
      case "not_configured":
      case "discovery_failed":
        return "oidc_unavailable";
      default:
        return "oidc_failed";
    }
  }
  return "oidc_failed";
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OidcServiceOptions {
  /** Key the flow cookie is sealed with (32 bytes). Instances behind one load balancer must share it. */
  flowKey: Buffer;
  fetch?: FetchLike;
  now?: () => number;
  jwksRefetchCooldownMs?: number;
  logger?: (message: string, metadata?: Record<string, unknown>) => void;
}

interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

interface FlowState {
  v: 1;
  state: string;
  nonce: string;
  verifier: string;
  createdAt: number;
}

export interface OidcProfile {
  subject: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
  groups: string[];
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function randomToken(bytes = 32): string {
  return base64Url(crypto.randomBytes(bytes));
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = crypto.createHash("sha256").update(a).digest();
  const right = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(left, right) && a.length === b.length;
}

/** Keeps an IdP-supplied error code printable and short before it reaches a log line. */
function sanitizeCode(value: unknown): string {
  return typeof value === "string" ? value.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "unknown" : "unknown";
}

/** Derives the flow-cookie key from the master key (HKDF), or a random per-process key when there is none. */
export function deriveOidcFlowKey(masterKeyBase64: string | undefined): Buffer {
  const master = Buffer.from(masterKeyBase64 ?? "", "base64");
  if (master.length === 0) {
    return crypto.randomBytes(32);
  }
  return Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), Buffer.from("l2m-oidc-flow-cookie"), 32));
}

export function sealOidcFlow(flow: FlowState, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(FLOW_AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(flow), "utf8"), cipher.final()]);
  return base64Url(Buffer.concat([iv, cipher.getAuthTag(), ciphertext]));
}

export function openOidcFlow(value: string | undefined, key: Buffer, now: number): FlowState | null {
  if (!value) return null;
  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAAD(FLOW_AAD);
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plain) as Partial<FlowState>;
    if (
      parsed.v !== 1 ||
      typeof parsed.state !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.verifier !== "string" ||
      typeof parsed.createdAt !== "number"
    ) {
      return null;
    }
    const age = now - parsed.createdAt;
    if (age < -OIDC_CLOCK_SKEW_SECONDS * 1000 || age > OIDC_FLOW_MAX_AGE_MS) return null;
    return parsed as FlowState;
  } catch {
    return null;
  }
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Validates an ID token: signature (asymmetric algorithms only), `iss`, `aud`, `exp`, `iat` (not in the future and
 * not older than OIDC_MAX_ID_TOKEN_AGE_SECONDS, both with OIDC_CLOCK_SKEW_SECONDS of skew), `sub`, `nonce`, and `azp`
 * (required to be the client id when there are several audiences, checked whenever present).
 */
export async function validateIdToken(
  idToken: string,
  options: { issuer: string; clientId: string; nonce: string; getKey: JWTVerifyGetKey; currentDate?: Date }
): Promise<JWTPayload> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(idToken, options.getKey, {
      issuer: options.issuer,
      audience: options.clientId,
      algorithms: OIDC_ID_TOKEN_ALGORITHMS,
      clockTolerance: OIDC_CLOCK_SKEW_SECONDS,
      maxTokenAge: OIDC_MAX_ID_TOKEN_AGE_SECONDS,
      requiredClaims: ["sub", "iat", "exp"],
      currentDate: options.currentDate
    });
    payload = result.payload;
  } catch (error) {
    const reason = error instanceof joseErrors.JOSEError ? `${error.code}: ${error.message}` : "verification failed";
    throw new OidcError("invalid_id_token", `ID token rejected (${reason})`);
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new OidcError("invalid_id_token", "ID token rejected (empty sub)");
  }
  if (typeof payload.nonce !== "string" || !constantTimeEqual(payload.nonce, options.nonce)) {
    throw new OidcError("invalid_id_token", "ID token rejected (nonce mismatch)");
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const azp = payload.azp;
  if (audiences.length > 1 && azp === undefined) {
    throw new OidcError("invalid_id_token", "ID token rejected (azp missing with several audiences)");
  }
  if (azp !== undefined && azp !== options.clientId) {
    throw new OidcError("invalid_id_token", "ID token rejected (azp is not this client)");
  }
  return payload;
}

/** JWKS cache with refetch on an unknown `kid` (at most once per cooldown) and a periodic refresh. */
export class JwksCache {
  private keySet: JWTVerifyGetKey | null = null;
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    readonly uri: string,
    private readonly fetchJson: (url: string) => Promise<unknown>,
    private readonly now: () => number,
    private readonly cooldownMs: number
  ) {}

  readonly getKey: JWTVerifyGetKey = async (header, token) => {
    if (!this.keySet || this.now() - this.fetchedAt > JWKS_TTL_MS) {
      await this.refresh();
    }
    try {
      return await this.keySet!(header, token);
    } catch (error) {
      if (error instanceof joseErrors.JWKSNoMatchingKey && this.now() - this.fetchedAt >= this.cooldownMs) {
        await this.refresh();
        return await this.keySet!(header, token);
      }
      throw error;
    }
  };

  private async refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          const body = await this.fetchJson(this.uri);
          const keys = (body as { keys?: unknown })?.keys;
          if (!Array.isArray(keys)) {
            throw new OidcError("discovery_failed", "JWKS response has no keys array");
          }
          this.keySet = createLocalJWKSet(body as JSONWebKeySet);
          this.fetchedAt = this.now();
        } finally {
          this.inflight = null;
        }
      })();
    }
    await this.inflight;
  }
}

function readClaimPath(claims: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(claims, path)) return claims[path];
  let current: unknown = claims;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function extractGroups(claims: Record<string, unknown>, groupsClaim: string): string[] {
  const raw = readClaimPath(claims, groupsClaim);
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === "string" && value.length > 0);
  }
  if (typeof raw === "string") {
    return raw.split(",").map((value) => value.trim()).filter(Boolean);
  }
  return [];
}

function isUserRole(value: string): value is UserRole {
  return value === "admin" || value === "builder" || value === "operator" || value === "viewer";
}

export class OidcService {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private discovery: { doc: DiscoveryDocument; fetchedAt: number } | null = null;
  private discoveryInflight: Promise<DiscoveryDocument> | null = null;
  private jwks: JwksCache | null = null;

  constructor(
    private readonly store: Store,
    private readonly settings: OidcSettings | null,
    private readonly options: OidcServiceOptions
  ) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.cooldownMs = options.jwksRefetchCooldownMs ?? JWKS_REFETCH_COOLDOWN_MS;
  }

  isEnabled(): boolean {
    return this.settings !== null;
  }

  getSettings(): OidcSettings | null {
    return this.settings;
  }

  private requireSettings(): OidcSettings {
    if (!this.settings) {
      throw new OidcError("not_configured", "OIDC is not enabled");
    }
    return this.settings;
  }

  private async fetchJson(url: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { accept: "application/json", ...(init?.headers as Record<string, string> | undefined) }
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const errorCode = body && typeof body === "object" ? sanitizeCode((body as Record<string, unknown>).error) : "unknown";
      throw new OidcError("token_exchange_failed", `HTTP ${response.status} from ${new URL(url).origin} (error=${errorCode})`);
    }
    if (body === null || typeof body !== "object") {
      throw new OidcError("invalid_response", `Non-JSON response from ${new URL(url).origin}`);
    }
    return body;
  }

  async getDiscovery(): Promise<DiscoveryDocument> {
    const settings = this.requireSettings();
    if (this.discovery && this.now() - this.discovery.fetchedAt < DISCOVERY_TTL_MS) {
      return this.discovery.doc;
    }
    if (!this.discoveryInflight) {
      this.discoveryInflight = (async () => {
        try {
          const url = `${settings.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
          let raw: Record<string, unknown>;
          try {
            raw = (await this.fetchJson(url)) as Record<string, unknown>;
          } catch (error) {
            throw new OidcError("discovery_failed", `Discovery failed: ${error instanceof Error ? error.message : "unknown error"}`);
          }
          const doc = this.parseDiscovery(raw, settings);
          this.discovery = { doc, fetchedAt: this.now() };
          if (!this.jwks || this.jwks.uri !== doc.jwks_uri) {
            this.jwks = new JwksCache(
              doc.jwks_uri,
              async (jwksUrl) => {
                try {
                  return await this.fetchJson(jwksUrl);
                } catch (error) {
                  throw new OidcError("discovery_failed", `JWKS fetch failed: ${error instanceof Error ? error.message : "unknown error"}`);
                }
              },
              this.now,
              this.cooldownMs
            );
          }
          return doc;
        } finally {
          this.discoveryInflight = null;
        }
      })();
    }
    return await this.discoveryInflight;
  }

  private parseDiscovery(raw: Record<string, unknown>, settings: OidcSettings): DiscoveryDocument {
    if (raw.issuer !== settings.issuer) {
      throw new OidcError("discovery_failed", "Discovery issuer does not match OIDC_ISSUER exactly");
    }
    const endpoint = (key: string, required: boolean): string | undefined => {
      const value = raw[key];
      if (value === undefined && !required) return undefined;
      if (typeof value !== "string") {
        throw new OidcError("discovery_failed", `Discovery document has no ${key}`);
      }
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new OidcError("discovery_failed", `Discovery ${key} is not a URL`);
      }
      if (!isAllowedOidcUrl(parsed)) {
        throw new OidcError("discovery_failed", `Discovery ${key} must use https`);
      }
      return value;
    };
    const methods = raw.token_endpoint_auth_methods_supported;
    return {
      issuer: settings.issuer,
      authorization_endpoint: endpoint("authorization_endpoint", true)!,
      token_endpoint: endpoint("token_endpoint", true)!,
      jwks_uri: endpoint("jwks_uri", true)!,
      userinfo_endpoint: endpoint("userinfo_endpoint", false),
      token_endpoint_auth_methods_supported: Array.isArray(methods)
        ? methods.filter((value): value is string => typeof value === "string")
        : undefined
    };
  }

  /** Starts a login: the IdP authorization URL and the sealed flow cookie value to set on the browser. */
  async beginLogin(): Promise<{ authorizationUrl: string; flowCookie: string }> {
    const settings = this.requireSettings();
    const doc = await this.getDiscovery();
    const state = randomToken();
    const nonce = randomToken();
    const pkce = createPkcePair();
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", settings.clientId);
    url.searchParams.set("redirect_uri", settings.redirectUrl);
    url.searchParams.set("scope", settings.scopes);
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    const flowCookie = sealOidcFlow(
      { v: 1, state, nonce, verifier: pkce.verifier, createdAt: this.now() },
      this.options.flowKey
    );
    return { authorizationUrl: url.toString(), flowCookie };
  }

  /** Finishes a login from the callback's query parameters and the flow cookie. Returns the verified profile. */
  async completeLogin(input: { query: Record<string, unknown>; flowCookie: string | undefined }): Promise<OidcProfile> {
    const settings = this.requireSettings();
    const flow = openOidcFlow(input.flowCookie, this.options.flowKey, this.now());
    if (!flow) {
      throw new OidcError("state_mismatch", "Login flow cookie is missing, expired or invalid");
    }
    const query = input.query;
    if (query.error !== undefined) {
      throw new OidcError("idp_error", `IdP returned error=${sanitizeCode(query.error)}`);
    }
    const state = typeof query.state === "string" ? query.state : "";
    if (!state || !constantTimeEqual(state, flow.state)) {
      throw new OidcError("state_mismatch", "state does not match the login flow");
    }
    // RFC 9207: when the IdP names itself on the redirect, it must be our issuer (mix-up defence).
    if (query.iss !== undefined && query.iss !== settings.issuer) {
      throw new OidcError("invalid_response", "iss parameter does not match OIDC_ISSUER");
    }
    const code = typeof query.code === "string" ? query.code : "";
    if (!code) {
      throw new OidcError("invalid_response", "Authorization response has no code");
    }

    const doc = await this.getDiscovery();
    const tokens = await this.exchangeCode(doc, settings, code, flow.verifier);
    const claims = (await validateIdToken(tokens.idToken, {
      issuer: settings.issuer,
      clientId: settings.clientId,
      nonce: flow.nonce,
      getKey: this.jwks!.getKey,
      currentDate: new Date(this.now())
    })) as Record<string, unknown>;

    const merged = await this.mergeUserInfo(doc, settings, claims, tokens.accessToken);
    const rawEmail = typeof merged.email === "string" ? merged.email.trim().toLowerCase() : "";
    const verifiedRaw = merged.email_verified;
    return {
      subject: claims.sub as string,
      email: rawEmail || undefined,
      emailVerified: verifiedRaw === true || verifiedRaw === "true",
      displayName: typeof merged.name === "string" ? merged.name : undefined,
      groups: extractGroups(merged, settings.groupsClaim)
    };
  }

  private async exchangeCode(
    doc: DiscoveryDocument,
    settings: OidcSettings,
    code: string,
    verifier: string
  ): Promise<{ idToken: string; accessToken?: string }> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: settings.redirectUrl,
      code_verifier: verifier
    });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (settings.clientSecret) {
      const methods = doc.token_endpoint_auth_methods_supported;
      const useBasic = !methods || methods.length === 0 || methods.includes("client_secret_basic") || !methods.includes("client_secret_post");
      if (useBasic) {
        const credentials = `${encodeURIComponent(settings.clientId)}:${encodeURIComponent(settings.clientSecret)}`;
        headers.authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
      } else {
        body.set("client_id", settings.clientId);
        body.set("client_secret", settings.clientSecret);
      }
    } else {
      body.set("client_id", settings.clientId);
    }
    let raw: Record<string, unknown>;
    try {
      raw = (await this.fetchJson(doc.token_endpoint, { method: "POST", headers, body: body.toString() })) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof OidcError) {
        throw new OidcError("token_exchange_failed", `Token exchange failed: ${error.message}`);
      }
      throw new OidcError("token_exchange_failed", "Token exchange failed");
    }
    if (typeof raw.id_token !== "string" || raw.id_token.length === 0) {
      throw new OidcError("token_exchange_failed", "Token response has no id_token");
    }
    return {
      idToken: raw.id_token,
      accessToken: typeof raw.access_token === "string" && raw.access_token ? raw.access_token : undefined
    };
  }

  /**
   * Fills email / email_verified / name / groups from the userinfo endpoint when the ID token lacks them. Userinfo is
   * used only when its `sub` equals the ID token's; a failure leaves the ID token claims as they are.
   */
  private async mergeUserInfo(
    doc: DiscoveryDocument,
    settings: OidcSettings,
    claims: Record<string, unknown>,
    accessToken: string | undefined
  ): Promise<Record<string, unknown>> {
    const missingEmail = typeof claims.email !== "string" || claims.email.length === 0;
    const missingGroups = readClaimPath(claims, settings.groupsClaim) === undefined;
    if ((!missingEmail && !missingGroups) || !accessToken || !doc.userinfo_endpoint) {
      return claims;
    }
    let info: Record<string, unknown>;
    try {
      info = (await this.fetchJson(doc.userinfo_endpoint, {
        headers: { authorization: `Bearer ${accessToken}` }
      })) as Record<string, unknown>;
    } catch (error) {
      this.options.logger?.("OIDC userinfo request failed; using ID token claims only", {
        reason: error instanceof Error ? error.message : "unknown"
      });
      return claims;
    }
    if (info.sub !== claims.sub) {
      this.options.logger?.("OIDC userinfo sub does not match the ID token; ignoring userinfo");
      return claims;
    }
    const merged: Record<string, unknown> = { ...claims };
    if (missingEmail && typeof info.email === "string") {
      merged.email = info.email;
      merged.email_verified = info.email_verified;
    }
    if (merged.name === undefined && typeof info.name === "string") {
      merged.name = info.name;
    }
    if (missingGroups) {
      const groups = readClaimPath(info, settings.groupsClaim);
      if (groups !== undefined) merged[settings.groupsClaim] = groups;
    }
    return merged;
  }

  async resolveGlobalRole(groups: string[]): Promise<UserRole | null> {
    if (!groups || groups.length === 0) return null;
    const mappings = await this.store.listSsoGroupMappings("oidc");
    for (const group of groups) {
      const match = mappings.find((m) => !m.projectId && m.groupName === group);
      if (match && isUserRole(match.role)) {
        return match.role;
      }
    }
    return null;
  }

  async listProjectRoleAssignments(groups: string[]): Promise<Array<{ projectId: string; role: string; customRoleId: string | null }>> {
    if (!groups || groups.length === 0) return [];
    const mappings = await this.store.listSsoGroupMappings("oidc");
    const assignments: Array<{ projectId: string; role: string; customRoleId: string | null }> = [];
    for (const group of groups) {
      for (const mapping of mappings) {
        if (mapping.projectId && mapping.groupName === group) {
          assignments.push({ projectId: mapping.projectId, role: mapping.role, customRoleId: mapping.customRoleId });
        }
      }
    }
    return assignments;
  }

  async recordIdentity(userId: string, profile: { subject: string; email?: string; groups: string[] }): Promise<void> {
    await this.store.upsertSsoIdentity({
      id: `sso_${nanoid(16)}`,
      userId,
      provider: "oidc",
      subject: profile.subject,
      email: profile.email ?? null,
      attributes: { groups: profile.groups }
    });
  }
}
