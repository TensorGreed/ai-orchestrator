import { createRequire } from "node:module";
import { SqliteStore } from "../db/database";
import type { UserRole } from "./auth-service";

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

interface LdapClientLike {
  bind(dn: string, password: string): Promise<void>;
  search(
    baseDn: string,
    options: { filter?: string; scope?: string; attributes?: string[] }
  ): Promise<{ searchEntries: Array<Record<string, unknown>> }>;
  unbind(): Promise<void>;
}

interface LdaptsModule {
  Client: new (options: { url: string }) => LdapClientLike;
}

const CONFIGURATION_ERROR = (detail: string): Error => {
  const err = new Error(`LDAP not configured: ${detail}`);
  (err as Error & { code?: string }).code = "CONFIGURATION_ERROR";
  return err;
};

function loadLdapts(): LdaptsModule | null {
  try {
    return require("ldapts") as LdaptsModule;
  } catch {
    return null;
  }
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
  constructor(
    private readonly store: SqliteStore,
    private readonly config: LdapConfig
  ) {}

  isReady(): boolean {
    if (!this.config.enabled) return false;
    if (!this.config.url || !this.config.baseDn) return false;
    return Boolean(loadLdapts());
  }

  async authenticate(email: string, password: string): Promise<LdapProfile> {
    if (!this.config.enabled) {
      throw CONFIGURATION_ERROR("LDAP_ENABLED is false");
    }
    if (!this.config.url || !this.config.baseDn) {
      throw CONFIGURATION_ERROR("LDAP_URL and LDAP_BASE_DN must be set");
    }
    const mod = loadLdapts();
    if (!mod) {
      throw CONFIGURATION_ERROR("ldapts package is not installed");
    }

    const client = new mod.Client({ url: this.config.url });
    try {
      if (this.config.bindDn) {
        await client.bind(this.config.bindDn, this.config.bindPassword ?? "");
      }

      const filter = this.config.userFilter.replace(
        /\{\{email\}\}/g,
        email.replace(/([\\*()\0])/g, "\\$1")
      );
      const { searchEntries } = await client.search(this.config.baseDn, {
        filter,
        scope: "sub",
        attributes: ["dn", "mail", "cn", "displayName", this.config.groupsAttribute]
      });

      if (!searchEntries.length) {
        throw new Error("User not found in LDAP directory");
      }

      const entry = searchEntries[0];
      const userDn = typeof entry.dn === "string" ? entry.dn : "";
      if (!userDn) {
        throw new Error("LDAP entry is missing dn");
      }

      // Rebind as the user to verify password.
      await client.unbind();
      const verifyClient = new mod.Client({ url: this.config.url });
      try {
        await verifyClient.bind(userDn, password);
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

  resolveGlobalRole(groups: string[]): UserRole | null {
    if (!groups || groups.length === 0) return null;
    const mappings = this.store.listSsoGroupMappings("ldap");
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
    const mappings = this.store.listSsoGroupMappings("ldap");
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
