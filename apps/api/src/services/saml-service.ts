import { createRequire } from "node:module";
import { nanoid } from "nanoid";
import type { UserRole } from "./auth-service";
import type { Store } from "../db/store.js";
import { checkSsoAllowLists, emailDomainOf } from "./sso-policy.js";

const require = createRequire(import.meta.url);

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
}

/** Options handed to the SAML library (exported for the test seam). */
export interface NodeSamlOptions {
  entryPoint?: string;
  issuer?: string;
  callbackUrl?: string;
  cert?: string;
  idpCert?: string;
  idpIssuer?: string;
  disableRequestedAuthnContext?: boolean;
}

export interface NodeSamlLike {
  generateAuthorizeUrl(req?: unknown): Promise<string> | string;
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
  | "not_allowed";

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

function elementText(node: unknown): string | undefined {
  if (typeof node === "string") return node.trim() || undefined;
  if (node && typeof node === "object" && typeof (node as Record<string, unknown>)._ === "string") {
    return ((node as Record<string, unknown>)._ as string).trim() || undefined;
  }
  return undefined;
}

/**
 * The AuthnContextClassRef values of a validated assertion, read from the library's parsed assertion
 * (`profile.getAssertion()`, xml2js with the namespace prefixes stripped or kept). Never parsed from raw XML text.
 */
export function extractAuthnContextClassRefs(profile: Record<string, unknown>): string[] {
  const getAssertion = profile.getAssertion;
  if (typeof getAssertion !== "function") return [];
  let parsed: unknown;
  try {
    parsed = (getAssertion as () => unknown).call(profile);
  } catch {
    return [];
  }
  const roots = childElements(parsed, "Assertion");
  const assertions = roots.length > 0 ? roots : [parsed];
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

export class SamlService {
  private readonly client: NodeSamlLike | null;

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
      ...(config.idpIssuer ? { idpIssuer: config.idpIssuer } : {}),
      ...(config.reportActualAuthnContext ? { disableRequestedAuthnContext: true } : {})
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

  async buildLoginUrl(): Promise<string> {
    if (!this.config.enabled) {
      throw CONFIGURATION_ERROR("SAML_ENABLED is false");
    }
    if (!this.client) {
      throw CONFIGURATION_ERROR(
        "SAML_ENTRY_POINT/SAML_ISSUER/SAML_CALLBACK_URL must be set and @node-saml/node-saml must be installed"
      );
    }
    return await this.client.generateAuthorizeUrl();
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
    const issuer = typeof profile.issuer === "string" && profile.issuer.trim() ? profile.issuer.trim() : undefined;

    return {
      nameId: nameId || email || "",
      email,
      displayName: typeof profile.displayName === "string" ? profile.displayName : undefined,
      groups,
      attributes,
      issuer,
      authnContexts: extractAuthnContextClassRefs(profile)
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
   * Finds the SSO identity of an assertion under the entity-scoped key. A row from before identities were scoped holds
   * the bare NameID: it is upgraded in place to the scoped key once (on its first login after the upgrade), then used.
   * Returns null when neither exists.
   */
  async findIdentity(entityId: string, nameId: string): Promise<{ userId: string; identityKey: string; upgraded: boolean } | null> {
    const identityKey = samlIdentitySubject(entityId, nameId);
    const scoped = await this.store.findSsoIdentity("saml", identityKey);
    if (scoped) return { userId: scoped.userId, identityKey, upgraded: false };
    const legacy = await this.store.findSsoIdentity("saml", nameId);
    if (!legacy) return null;
    const renamed = await this.store.renameSsoIdentitySubject({ provider: "saml", from: nameId, to: identityKey });
    // Another login may have upgraded (or the scoped key been created) meanwhile: read whatever is there now.
    const current = await this.store.findSsoIdentity("saml", identityKey);
    if (current) return { userId: current.userId, identityKey, upgraded: renamed };
    return null;
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
