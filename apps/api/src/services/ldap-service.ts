import { createRequire } from "node:module";
import type { UserRole } from "./auth-service";
import type { Store } from "../db/store.js";

const require = createRequire(import.meta.url);

export interface LdapConfig {
  enabled: boolean;
  url?: string;
  bindDn?: string;
  bindPassword?: string;
  baseDn?: string;
  userFilter: string;
  groupsAttribute: string;
}

export interface LdapProfile {
  dn: string;
  email: string;
  displayName?: string;
  groups: string[];
  attributes: Record<string, unknown>;
}

export interface LdapClientLike {
  bind(dn: string, password: string): Promise<void>;
  search(
    baseDn: string,
    options: { filter?: string; scope?: string; attributes?: string[] }
  ): Promise<{ searchEntries: Array<Record<string, unknown>> }>;
  unbind(): Promise<void>;
}

export interface LdaptsModule {
  Client: new (options: { url: string }) => LdapClientLike;
}

const CONFIGURATION_ERROR = (detail: string): Error => {
  const err = new Error(`LDAP not configured: ${detail}`);
  (err as Error & { code?: string }).code = "CONFIGURATION_ERROR";
  return err;
};

/** Why a directory sign-in was refused: for the server log and the audit entry only, never for the caller. */
export type LdapSignInRefusal = "user_not_found" | "invalid_credentials" | "directory_error";

/** A refused LDAP sign-in. The route answers the same for every reason, so a caller cannot tell them apart. */
export class LdapAuthError extends Error {
  constructor(
    readonly reason: LdapSignInRefusal,
    detail: string
  ) {
    super(detail);
    this.name = "LdapAuthError";
  }
}

/** The directory's "invalid credentials" (result code 49), as ldapts reports it. */
function isInvalidCredentials(error: unknown): boolean {
  const err = error as { name?: unknown; code?: unknown };
  return err?.name === "InvalidCredentialsError" || err?.code === 49;
}

function loadLdapts(): LdaptsModule | null {
  try {
    return require("ldapts") as LdaptsModule;
  } catch {
    return null;
  }
}

/**
 * A value for an LDAP search filter, escaped as RFC 4515 requires: `*`, `(`, `)`, `\` and NUL become `\2a`, `\28`,
 * `\29`, `\5c` and `\00`, so the value is always matched literally (never a wildcard or a nested filter). A
 * backslash before the character (`\*`) is not RFC 4515: ldapts refuses such a filter as an invalid hex escape.
 */
export function escapeLdapFilterValue(value: string): string {
  return value.replace(/[*()\\\0]/g, (char) => `\\${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function normalizeStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === "string");
  }
  if (typeof raw === "string") {
    return [raw];
  }
  return [];
}

export class LdapService {
  private readonly loadClient: () => LdaptsModule | null;

  constructor(
    private readonly store: Store,
    private readonly config: LdapConfig,
    /** Tests: the LDAP client module (default: the optional `ldapts` package, when installed). */
    options: { loadClient?: () => LdaptsModule | null } = {}
  ) {
    this.loadClient = options.loadClient ?? loadLdapts;
  }

  isReady(): boolean {
    if (!this.config.enabled) return false;
    if (!this.config.url || !this.config.baseDn) return false;
    return Boolean(this.loadClient());
  }

  async authenticate(email: string, password: string): Promise<LdapProfile> {
    if (!this.config.enabled) {
      throw CONFIGURATION_ERROR("LDAP_ENABLED is false");
    }
    if (!this.config.url || !this.config.baseDn) {
      throw CONFIGURATION_ERROR("LDAP_URL and LDAP_BASE_DN must be set");
    }
    const mod = this.loadClient();
    if (!mod) {
      throw CONFIGURATION_ERROR("ldapts package is not installed");
    }

    const client = new mod.Client({ url: this.config.url });
    try {
      if (this.config.bindDn) {
        await client.bind(this.config.bindDn, this.config.bindPassword ?? "");
      }

      const filter = this.config.userFilter.replace(/\{\{email\}\}/g, () => escapeLdapFilterValue(email));
      const { searchEntries } = await client.search(this.config.baseDn, {
        filter,
        scope: "sub",
        attributes: ["dn", "mail", "cn", "displayName", this.config.groupsAttribute]
      });

      if (!searchEntries.length) {
        throw new LdapAuthError("user_not_found", "User not found in LDAP directory");
      }

      const entry = searchEntries[0];
      const userDn = typeof entry.dn === "string" ? entry.dn : "";
      if (!userDn) {
        throw new LdapAuthError("directory_error", "LDAP entry is missing dn");
      }

      // Rebind as the user to verify password.
      await client.unbind();
      const verifyClient = new mod.Client({ url: this.config.url });
      try {
        await verifyClient.bind(userDn, password);
      } catch (error) {
        if (isInvalidCredentials(error)) throw new LdapAuthError("invalid_credentials", "The directory refused the password");
        throw error;
      } finally {
        await verifyClient.unbind().catch(() => undefined);
      }

      const groups = normalizeStringArray(entry[this.config.groupsAttribute]);
      return {
        dn: userDn,
        email:
          typeof entry.mail === "string"
            ? (entry.mail as string)
            : Array.isArray(entry.mail)
              ? String(entry.mail[0])
              : email,
        displayName:
          typeof entry.displayName === "string"
            ? (entry.displayName as string)
            : typeof entry.cn === "string"
              ? (entry.cn as string)
              : undefined,
        groups,
        attributes: entry
      };
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }

  async resolveGlobalRole(groups: string[]): Promise<UserRole | null> {
    if (!groups || groups.length === 0) return null;
    const mappings = await this.store.listSsoGroupMappings("ldap");
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
    const mappings = await this.store.listSsoGroupMappings("ldap");
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
}

function isUserRole(value: string): value is UserRole {
  return value === "admin" || value === "builder" || value === "operator" || value === "viewer";
}
