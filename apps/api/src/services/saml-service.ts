import { createRequire } from "node:module";
import { nanoid } from "nanoid";
import { SqliteStore } from "../db/database";
import type { UserRole } from "./auth-service";

const require = createRequire(import.meta.url);

export interface SamlConfig {
  enabled: boolean;
  entryPoint?: string;
  issuer?: string;
  callbackUrl?: string;
  idpCert?: string;
  groupsAttribute: string;
}

export interface SamlAssertionProfile {
  nameId: string;
  email?: string;
  displayName?: string;
  groups: string[];
  attributes: Record<string, unknown>;
}

interface NodeSamlLike {
  generateAuthorizeUrl(req?: unknown): Promise<string> | string;
  validatePostResponseAsync(body: { SAMLResponse: string }): Promise<{ profile: Record<string, unknown> | null }>;
}

interface NodeSamlModule {
  SAML: new (options: {
    entryPoint?: string;
    issuer?: string;
    callbackUrl?: string;
    cert?: string;
    idpCert?: string;
  }) => NodeSamlLike;
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

export class SamlService {
  private readonly client: NodeSamlLike | null;

  constructor(
    private readonly store: SqliteStore,
    private readonly config: SamlConfig
  ) {
    if (!config.enabled) {
      this.client = null;
      return;
    }
    if (!config.entryPoint || !config.issuer || !config.callbackUrl) {
      this.client = null;
      return;
    }
    const mod = loadNodeSaml();
    if (!mod) {
      this.client = null;
      return;
    }
    this.client = new mod.SAML({
      entryPoint: config.entryPoint,
      issuer: config.issuer,
      callbackUrl: config.callbackUrl,
      cert: config.idpCert,
      idpCert: config.idpCert
    });
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

    return {
      nameId: nameId || email || "",
      email,
      displayName: typeof profile.displayName === "string" ? profile.displayName : undefined,
      groups,
      attributes: profile
    };
  }

  /**
   * Link or create a local user for an incoming SAML assertion and resolve the user's
   * default role from configured group mappings.
   */
  resolveGlobalRole(groups: string[]): UserRole | null {
    if (!groups || groups.length === 0) return null;
    const mappings = this.store.listSsoGroupMappings("saml");
    for (const group of groups) {
      const match = mappings.find((m) => !m.projectId && m.groupName === group);
      if (match && isUserRole(match.role)) {
        return match.role;
      }
    }
    return null;
  }

  listProjectRoleAssignments(groups: string[]): Array<{ projectId: string; role: string; customRoleId: string | null }> {
    if (!groups || groups.length === 0) return [];
    const mappings = this.store.listSsoGroupMappings("saml");
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

  recordIdentity(userId: string, profile: SamlAssertionProfile): void {
    this.store.upsertSsoIdentity({
      id: `sso_${nanoid(16)}`,
      userId,
      provider: "saml",
      subject: profile.nameId,
      email: profile.email ?? null,
      attributes: profile.attributes
    });
  }
}

function isUserRole(value: string): value is UserRole {
  return value === "admin" || value === "builder" || value === "operator" || value === "viewer";
}
