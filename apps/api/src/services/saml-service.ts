import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { nanoid } from "nanoid";
import type { UserRole } from "./auth-service.js";
import type { Store } from "../db/store.js";
import { checkSsoAllowLists, emailDomainOf } from "./sso-policy.js";

const require = createRequire(import.meta.url);

/**
 * Phase 13.2 — cookie that binds an SP-initiated SAML login to the browser that started it (SAML_REQUIRE_IN_RESPONSE_TO).
 * SameSite=None (the IdP's HTTP-POST to the callback is a cross-site request, which a Lax cookie would not join),
 * Secure, HttpOnly, path-scoped to the SAML routes, ten minutes. It holds the sealed AuthnRequest ID only.
 */
export const SAML_REQUEST_COOKIE_NAME = "l2m_saml_req";
export const SAML_REQUEST_COOKIE_PATH = "/api/auth/saml";
export const SAML_REQUEST_MAX_AGE_MS = 10 * 60 * 1000;
/** How long a consumed assertion ID is remembered at most (an assertion valid for longer is still held this long). */
export const SAML_ASSERTION_REPLAY_CAP_MS = 24 * 60 * 60 * 1000;
/** Kept past an assertion's NotOnOrAfter so a clock difference with the IdP cannot reopen it. */
const SAML_ASSERTION_REPLAY_SKEW_MS = 5 * 60 * 1000;
const SAML_REQUEST_AAD = Buffer.from("l2m-saml-request-v1");
const SAML_REPLAY_ENDPOINT_KEY = "saml_assertion";

export interface SamlConfig {
  enabled: boolean;
  entryPoint?: string;
  issuer?: string;
  callbackUrl?: string;
  idpCert?: string;
  groupsAttribute: string;
  /** Phase 13.2 — SAML_IDP_ISSUER: the IdP entity ID a response's Issuer must equal (unset = not pinned). */
  idpIssuer?: string;
  /** Phase 13.2 — SAML_ALLOWED_EMAIL_DOMAINS (lower-cased); empty = any. */
  allowedEmailDomains?: string[];
  /** Phase 13.2 — SAML_ALLOWED_GROUPS; empty = any. */
  allowedGroups?: string[];
  /**
   * Phase 13.2 — true when SSO_MFA is on: the AuthnRequest then carries no RequestedAuthnContext, so the IdP reports
   * the method it really used (the library's default request for PasswordProtectedTransport would hide MFA).
   */
  reportActualAuthnContext?: boolean;
  /**
   * Phase 13.2 — SAML_REQUIRE_IN_RESPONSE_TO: accept only responses to a login this browser started here (the
   * assertion's InResponseTo must equal the AuthnRequest ID sealed in its request cookie); IdP-initiated sign-in is
   * then refused.
   */
  requireInResponseTo?: boolean;
  /** Key the request cookie is sealed with (32 bytes); instances behind one load balancer must share it. */
  requestCookieKey?: Buffer;
}

export interface SamlAssertionProfile {
  nameId: string;
  email?: string;
  displayName?: string;
  groups: string[];
  attributes: Record<string, unknown>;
  /** Phase 13.2 — the assertion's Issuer (the IdP entity ID), when present. */
  issuer?: string;
  /** Phase 13.2 — every AuthnContextClassRef of the assertion's AuthnStatements. */
  authnContexts: string[];
  /** Phase 13.2 — the assertion's ID (remembered so the assertion is accepted once). */
  assertionId?: string;
  /** Phase 13.2 — the latest moment the assertion is valid (its NotOnOrAfter bounds), epoch ms. */
  validUntilMs?: number;
  /** Phase 13.2 — the AuthnRequest ID the assertion answers, when it answers one. */
  inResponseTo?: string;
}

/** Options handed to the SAML library (exported for the test seam). */
export interface NodeSamlOptions {
  entryPoint?: string;
  issuer?: string;
  callbackUrl?: string;
  cert?: string;
  idpCert?: string;
  disableRequestedAuthnContext?: boolean;
  /** The AuthnRequest ID generator; the app supplies it so it knows the ID it binds to the browser. */
  generateUniqueId?: () => string;
}

/** The part of `@node-saml/node-saml`'s `SAML` class the app uses (4.x and 5.x signatures). */
export interface NodeSamlLike {
  getAuthorizeUrlAsync(relayState: string, host: string | undefined, options: Record<string, unknown>): Promise<string>;
  validatePostResponseAsync(body: { SAMLResponse: string }): Promise<{ profile: Record<string, unknown> | null }>;
}

interface NodeSamlModule {
  SAML: new (options: NodeSamlOptions) => NodeSamlLike;
}

export type SamlClientFactory = (options: NodeSamlOptions) => NodeSamlLike;

export type SamlLoginErrorCode =
  | "invalid_assertion"
  | "missing_issuer"
  | "issuer_mismatch"
  | "invalid_issuer"
  | "missing_identity"
  | "not_allowed"
  | "replayed_assertion"
  | "missing_assertion_id"
  | "unsolicited_response";

/** A refused SAML login: `message` is a reason for the log, `details` are assertion-free facts safe for the audit. */
export class SamlLoginError extends Error {
  constructor(
    public readonly code: SamlLoginErrorCode,
    message: string,
    public readonly details: Record<string, string> = {}
  ) {
    super(message);
    this.name = "SamlLoginError";
  }
}

/** The short code put on the login page URL (`?sso_error=`) for a refused SAML login. */
export function samlUserErrorCode(error: unknown): string {
  if (error instanceof SamlLoginError && error.code === "not_allowed") return "saml_not_allowed";
  if ((error as { code?: unknown } | null)?.code === "CONFIGURATION_ERROR") return "saml_unavailable";
  return "saml_failed";
}

const CONFIGURATION_ERROR = (detail: string): Error => {
  const err = new Error(`SAML not configured: ${detail}`);
  (err as Error & { code?: string }).code = "CONFIGURATION_ERROR";
  return err;
};

function loadNodeSaml(): NodeSamlModule | null {
  try {
    return require("@node-saml/node-saml") as NodeSamlModule;
  } catch {
    return null;
  }
}

/**
 * The `sso_identities.subject` stored for a SAML login: the IdP entity ID and the NameID together, because a NameID
 * is unique only within one IdP. Entity IDs containing `#` are refused, so the first `#` separates the two.
 */
export function samlIdentitySubject(entityId: string, nameId: string): string {
  return `${entityId}#${nameId}`;
}

function localName(key: string): string {
  const colon = key.indexOf(":");
  return colon >= 0 ? key.slice(colon + 1) : key;
}

/** Children of a parsed XML element (xml2js shape: element name → array), matched by local name. */
function childElements(node: unknown, name: string): unknown[] {
  if (!node || typeof node !== "object") return [];
  const out: unknown[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (localName(key) !== name) continue;
    if (Array.isArray(value)) out.push(...value);
    else out.push(value);
  }
  return out;
}

function elementAttribute(node: unknown, name: string): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const attributes = (node as Record<string, unknown>).$;
  if (!attributes || typeof attributes !== "object") return undefined;
  for (const [key, value] of Object.entries(attributes as Record<string, unknown>)) {
    if (localName(key) === name && typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function elementText(node: unknown): string | undefined {
  if (typeof node === "string") return node.trim() || undefined;
  if (node && typeof node === "object" && typeof (node as Record<string, unknown>)._ === "string") {
    return ((node as Record<string, unknown>)._ as string).trim() || undefined;
  }
  return undefined;
}

/** The top-level Assertion element(s) of the library's parsed, validated assertion (`profile.getAssertion()`). */
function parsedAssertions(profile: Record<string, unknown>): unknown[] {
  const getAssertion = profile.getAssertion;
  if (typeof getAssertion !== "function") return [];
  let parsed: unknown;
  try {
    parsed = (getAssertion as () => unknown).call(profile);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const roots = childElements(parsed, "Assertion");
  return roots.length > 0 ? roots : [parsed];
}

/**
 * The AuthnContextClassRef values of a validated assertion, read from the library's parsed assertion
 * (`profile.getAssertion()`, xml2js with the namespace prefixes stripped or kept). Never parsed from raw XML text.
 */
export function extractAuthnContextClassRefs(profile: Record<string, unknown>): string[] {
  const assertions = parsedAssertions(profile);
  const refs: string[] = [];
  for (const assertion of assertions) {
    for (const statement of childElements(assertion, "AuthnStatement")) {
      for (const context of childElements(statement, "AuthnContext")) {
        for (const ref of childElements(context, "AuthnContextClassRef")) {
          const text = elementText(ref);
          if (text && !refs.includes(text)) refs.push(text);
        }
      }
    }
  }
  return refs;
}

/**
 * Facts of the validated assertion used against replay and unsolicited responses, from the parsed assertion only: its
 * Issuer and ID, the latest NotOnOrAfter that bounds it (Conditions, and the latest bearer SubjectConfirmationData;
 * the earlier of the two), and the InResponseTo of its SubjectConfirmationData.
 */
export function extractAssertionFacts(profile: Record<string, unknown>): {
  issuer?: string;
  assertionId?: string;
  validUntilMs?: number;
  inResponseTo?: string;
} {
  const [assertion] = parsedAssertions(profile);
  if (!assertion) return {};
  const issuer = childElements(assertion, "Issuer").map(elementText).find(Boolean);
  const assertionId = elementAttribute(assertion, "ID");
  const toMs = (value: string | undefined): number | undefined => {
    const ms = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(ms) ? ms : undefined;
  };
  const limits: number[] = [];
  const conditionsLimit = toMs(childElements(assertion, "Conditions").map((c) => elementAttribute(c, "NotOnOrAfter")).find(Boolean));
  if (conditionsLimit !== undefined) limits.push(conditionsLimit);
  const confirmationData = childElements(assertion, "Subject")
    .flatMap((subject) => childElements(subject, "SubjectConfirmation"))
    .flatMap((confirmation) => childElements(confirmation, "SubjectConfirmationData"));
  const confirmationLimits = confirmationData
    .map((data) => toMs(elementAttribute(data, "NotOnOrAfter")))
    .filter((ms): ms is number => ms !== undefined);
  if (confirmationLimits.length > 0) limits.push(Math.max(...confirmationLimits));
  const inResponseTo = confirmationData.map((data) => elementAttribute(data, "InResponseTo")).find(Boolean);
  return {
    issuer,
    assertionId,
    ...(limits.length > 0 ? { validUntilMs: Math.min(...limits) } : {}),
    inResponseTo
  };
}

/** Key the SAML request cookie is sealed with: HKDF of the master key (a random per-process key without one). */
export function deriveSamlRequestKey(masterKeyBase64: string | undefined): Buffer {
  const master = Buffer.from(masterKeyBase64 ?? "", "base64");
  if (master.length === 0) return crypto.randomBytes(32);
  return Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), Buffer.from("l2m-saml-request-cookie"), 32));
}

export function sealSamlRequest(requestId: string, key: Buffer, now: number): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(SAML_REQUEST_AAD);
  const plain = JSON.stringify({ v: 1, id: requestId, createdAt: now });
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

/** The AuthnRequest ID in a request cookie, or null when it is missing, tampered with or older than ten minutes. */
export function openSamlRequest(value: string | undefined, key: Buffer, now: number): string | null {
  if (!value) return null;
  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAAD(SAML_REQUEST_AAD);
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plain) as { v?: unknown; id?: unknown; createdAt?: unknown };
    if (parsed.v !== 1 || typeof parsed.id !== "string" || !parsed.id || typeof parsed.createdAt !== "number") return null;
    const age = now - parsed.createdAt;
    if (age < -SAML_ASSERTION_REPLAY_SKEW_MS || age > SAML_REQUEST_MAX_AGE_MS) return null;
    return parsed.id;
  } catch {
    return null;
  }
}

export class SamlService {
  private readonly client: NodeSamlLike | null;
  /** The AuthnRequest ID the library should use for the login being started (see `generateUniqueId`). */
  private readonly pendingRequestId = new AsyncLocalStorage<string>();

  constructor(
    private readonly store: Store,
    private readonly config: SamlConfig,
    clientFactory?: SamlClientFactory
  ) {
    if (!config.enabled) {
      this.client = null;
      return;
    }
    if (!config.entryPoint || !config.issuer || !config.callbackUrl) {
      this.client = null;
      return;
    }
    const options: NodeSamlOptions = {
      entryPoint: config.entryPoint,
      issuer: config.issuer,
      callbackUrl: config.callbackUrl,
      cert: config.idpCert,
      idpCert: config.idpCert,
      // SAML_IDP_ISSUER is checked by the app on the assertion's Issuer (resolveEntityId), not handed to the library:
      // some library versions would also demand the optional Response-level Issuer.
      ...(config.reportActualAuthnContext ? { disableRequestedAuthnContext: true } : {}),
      generateUniqueId: () => this.pendingRequestId.getStore() ?? newSamlRequestId()
    };
    if (clientFactory) {
      this.client = clientFactory(options);
      return;
    }
    const mod = loadNodeSaml();
    if (!mod) {
      this.client = null;
      return;
    }
    this.client = new mod.SAML(options);
  }

  isReady(): boolean {
    return Boolean(this.client);
  }

  /**
   * The IdP redirect for an SP-initiated login. With SAML_REQUIRE_IN_RESPONSE_TO it also returns the sealed request
   * cookie holding the AuthnRequest ID, which the callback then requires as the assertion's InResponseTo.
   */
  async buildLoginUrl(now = Date.now()): Promise<{ url: string; requestCookie?: string }> {
    if (!this.config.enabled) {
      throw CONFIGURATION_ERROR("SAML_ENABLED is false");
    }
    const client = this.client;
    if (!client) {
      throw CONFIGURATION_ERROR(
        "SAML_ENTRY_POINT/SAML_ISSUER/SAML_CALLBACK_URL must be set and @node-saml/node-saml must be installed"
      );
    }
    const requestId = newSamlRequestId();
    const url = await this.pendingRequestId.run(requestId, async () => await client.getAuthorizeUrlAsync("", undefined, {}));
    if (!this.config.requireInResponseTo) return { url };
    return { url, requestCookie: sealSamlRequest(requestId, this.requestCookieKey(), now) };
  }

  private requestCookieKey(): Buffer {
    if (!this.config.requestCookieKey || this.config.requestCookieKey.length !== 32) {
      throw CONFIGURATION_ERROR("the SAML request cookie key is missing");
    }
    return this.config.requestCookieKey;
  }

  /**
   * Accepts each assertion once: its (Issuer, ID) is remembered in the store until it expires (its NotOnOrAfter plus
   * five minutes, at most 24 hours), so a second post of the same SAMLResponse, on this instance or another one sharing
   * the database, is refused. An assertion without an ID is refused.
   */
  async recordAssertion(profile: Pick<SamlAssertionProfile, "issuer" | "assertionId" | "validUntilMs">, now = Date.now()): Promise<void> {
    if (!profile.assertionId) {
      throw new SamlLoginError("missing_assertion_id", "SAML assertion has no ID, so it cannot be checked for replay");
    }
    const cap = now + SAML_ASSERTION_REPLAY_CAP_MS;
    const until = profile.validUntilMs === undefined ? cap : Math.min(profile.validUntilMs + SAML_ASSERTION_REPLAY_SKEW_MS, cap);
    if (until <= now) return; // already expired: the library refuses it anyway
    const replayKey = `saml-assertion:${crypto.createHash("sha256").update(JSON.stringify([profile.issuer ?? "", profile.assertionId])).digest("hex")}`;
    await this.store.clearExpiredWebhookSecurityState(new Date(now).toISOString());
    const first = await this.store.saveWebhookReplayKey({
      replayKey,
      endpointKey: SAML_REPLAY_ENDPOINT_KEY,
      expiresAt: new Date(until).toISOString()
    });
    if (!first) {
      throw new SamlLoginError("replayed_assertion", "SAML assertion was already used");
    }
  }

  /**
   * SAML_REQUIRE_IN_RESPONSE_TO: the assertion must answer the AuthnRequest this browser started (the ID sealed in its
   * request cookie). No cookie, an expired or tampered one, an IdP-initiated response or another request's answer are
   * refused. Does nothing when the setting is off.
   */
  assertSolicited(profile: Pick<SamlAssertionProfile, "inResponseTo">, requestCookie: string | undefined, now = Date.now()): void {
    if (!this.config.requireInResponseTo) return;
    const expected = openSamlRequest(requestCookie, this.requestCookieKey(), now);
    if (!expected) {
      throw new SamlLoginError("unsolicited_response", "SAML response arrived without a login started from this browser");
    }
    if (!profile.inResponseTo || profile.inResponseTo !== expected) {
      throw new SamlLoginError("unsolicited_response", "SAML response does not answer the login this browser started");
    }
  }

  async consumeAssertion(samlResponse: string): Promise<SamlAssertionProfile> {
    if (!this.client) {
      throw CONFIGURATION_ERROR(
        "SAML not initialised; install @node-saml/node-saml and set SAML_* env vars"
      );
    }
    const { profile } = await this.client.validatePostResponseAsync({ SAMLResponse: samlResponse });
    if (!profile) {
      throw new Error("SAML assertion did not include a profile");
    }
    return this.normalizeProfile(profile);
  }

  normalizeProfile(profile: Record<string, unknown>): SamlAssertionProfile {
    const nameId =
      typeof profile.nameID === "string"
        ? profile.nameID
        : typeof profile.nameId === "string"
          ? (profile.nameId as string)
          : typeof profile["urn:oid:0.9.2342.19200300.100.1.1"] === "string"
            ? (profile["urn:oid:0.9.2342.19200300.100.1.1"] as string)
            : "";
    const email =
      typeof profile.email === "string"
        ? profile.email
        : typeof profile.mail === "string"
          ? (profile.mail as string)
          : undefined;

    const groupsAttrRaw = profile[this.config.groupsAttribute];
    const groups = Array.isArray(groupsAttrRaw)
      ? groupsAttrRaw.filter((v): v is string => typeof v === "string")
      : typeof groupsAttrRaw === "string"
        ? groupsAttrRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : [];

    // Attribute values only: the library's accessors (raw assertion and response XML) are left out.
    const attributes = Object.fromEntries(Object.entries(profile).filter(([, value]) => typeof value !== "function"));
    // Issuer, ID, validity and InResponseTo come from the parsed assertion (an IdP attribute named `issuer` cannot
    // shadow them); `profile.issuer` / `profile.inResponseTo` only when the library offers no parsed assertion.
    const facts = extractAssertionFacts(profile);
    const issuer =
      facts.issuer ?? (typeof profile.issuer === "string" && profile.issuer.trim() ? profile.issuer.trim() : undefined);
    const inResponseTo =
      facts.inResponseTo ?? (typeof profile.inResponseTo === "string" && profile.inResponseTo ? profile.inResponseTo : undefined);

    return {
      nameId: nameId || email || "",
      email,
      displayName: typeof profile.displayName === "string" ? profile.displayName : undefined,
      groups,
      attributes,
      issuer,
      authnContexts: extractAuthnContextClassRefs(profile),
      ...(facts.assertionId ? { assertionId: facts.assertionId } : {}),
      ...(facts.validUntilMs !== undefined ? { validUntilMs: facts.validUntilMs } : {}),
      ...(inResponseTo ? { inResponseTo } : {})
    };
  }

  /**
   * The IdP entity ID behind an assertion: its Issuer, which must equal SAML_IDP_ISSUER when that is set. Refuses an
   * assertion with no Issuer, or one containing `#` (the identity key separator).
   */
  resolveEntityId(profile: Pick<SamlAssertionProfile, "issuer">): string {
    const issuer = profile.issuer;
    if (!issuer) {
      throw new SamlLoginError("missing_issuer", "SAML assertion has no Issuer");
    }
    if (this.config.idpIssuer && issuer !== this.config.idpIssuer) {
      throw new SamlLoginError("issuer_mismatch", "SAML assertion Issuer does not match SAML_IDP_ISSUER");
    }
    if (issuer.includes("#")) {
      throw new SamlLoginError("invalid_issuer", "SAML assertion Issuer contains '#', which cannot be bound to an identity");
    }
    return issuer;
  }

  /**
   * Finds the SSO identity of an assertion under the entity-scoped key, else a row from before identities were scoped
   * (the bare NameID), reported as `legacySubject`. Reads only: the legacy row is upgraded by `upgradeLegacyIdentity`
   * once the login has passed the allow-lists and MFA. Returns null when neither exists.
   */
  async findIdentity(
    entityId: string,
    nameId: string
  ): Promise<{ userId: string; identityKey: string; legacySubject?: string } | null> {
    const identityKey = samlIdentitySubject(entityId, nameId);
    const scoped = await this.store.findSsoIdentity("saml", identityKey);
    if (scoped) return { userId: scoped.userId, identityKey };
    const legacy = await this.store.findSsoIdentity("saml", nameId);
    if (!legacy) return null;
    return { userId: legacy.userId, identityKey, legacySubject: nameId };
  }

  /**
   * Re-keys a pre-upgrade bare-NameID identity to the entity-scoped key, once (a concurrent login may have done it).
   * True when this call renamed the row.
   */
  async upgradeLegacyIdentity(legacySubject: string, identityKey: string): Promise<boolean> {
    return await this.store.renameSsoIdentitySubject({ provider: "saml", from: legacySubject, to: identityKey });
  }

  /** Applies SAML_ALLOWED_EMAIL_DOMAINS / SAML_ALLOWED_GROUPS (nothing when both are unset). */
  assertLoginAllowed(input: { identityKey: string; email?: string; groups: string[] }): void {
    const refused = checkSsoAllowLists({
      allowedEmailDomains: this.config.allowedEmailDomains ?? [],
      allowedGroups: this.config.allowedGroups ?? [],
      trustedEmail: input.email,
      groups: input.groups
    });
    if (!refused) return;
    const list = refused === "email_domains" ? "SAML_ALLOWED_EMAIL_DOMAINS" : "SAML_ALLOWED_GROUPS";
    const domain = emailDomainOf(input.email);
    throw new SamlLoginError(
      "not_allowed",
      refused === "email_domains"
        ? "Login refused: the email is not in SAML_ALLOWED_EMAIL_DOMAINS"
        : "Login refused: the user holds none of SAML_ALLOWED_GROUPS",
      { list, identityKey: input.identityKey, ...(domain ? { emailDomain: domain } : {}) }
    );
  }

  /**
   * Link or create a local user for an incoming SAML assertion and resolve the user's
   * default role from configured group mappings.
   */
  async resolveGlobalRole(groups: string[]): Promise<UserRole | null> {
    if (!groups || groups.length === 0) return null;
    const mappings = await this.store.listSsoGroupMappings("saml");
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
    const mappings = await this.store.listSsoGroupMappings("saml");
    const assignments: Array<{ projectId: string; role: string; customRoleId: string | null }> = [];
    for (const group of groups) {
      for (const mapping of mappings) {
        if (mapping.projectId && mapping.groupName === group) {
          assignments.push({
            projectId: mapping.projectId,
            role: mapping.role,
            customRoleId: mapping.customRoleId
          });
        }
      }
    }
    return assignments;
  }

  /** Stores the link under the entity-scoped key; the entity ID and NameID are kept in attributes for operators. */
  async recordIdentity(
    userId: string,
    profile: { identityKey: string; entityId: string; nameId: string; email?: string; groups: string[] }
  ): Promise<void> {
    await this.store.upsertSsoIdentity({
      id: `sso_${nanoid(16)}`,
      userId,
      provider: "saml",
      subject: profile.identityKey,
      email: profile.email ?? null,
      attributes: { issuer: profile.entityId, nameId: profile.nameId, groups: profile.groups }
    });
  }
}

function isUserRole(value: string): value is UserRole {
  return value === "admin" || value === "builder" || value === "operator" || value === "viewer";
}

/** An AuthnRequest ID: `_` and 160 random bits in hex (an XML ID must not start with a digit). */
function newSamlRequestId(): string {
  return `_${crypto.randomBytes(20).toString("hex")}`;
}
