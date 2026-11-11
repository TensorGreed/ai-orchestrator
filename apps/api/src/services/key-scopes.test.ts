import { describe, expect, it } from "vitest";
import type { Store } from "../db/store.js";
import type { SafeUser } from "./auth-service.js";
import {
  effectiveKeyRole,
  formatKeyScopes,
  isStructuredScope,
  keyBoundUser,
  keyMayCallRoute,
  keyMayManageAccount,
  parseKeyScopes,
  resolveNewKeyScope,
  scopedKeyUser
} from "./key-scopes.js";
import { RbacService } from "./rbac-service.js";

const projectExists = async (id: string) => ["default", "alpha", "beta"].includes(id);

describe("parseKeyScopes", () => {
  it("reads role ceilings and projects; anything else is legacy", () => {
    expect(parseKeyScopes(["role:operator", "project:alpha", "project:beta", "project:alpha", "read", "role:root", "project:"])).toEqual({
      roleCeiling: "operator",
      projects: ["alpha", "beta"],
      legacy: ["read", "role:root", "project:"]
    });
    expect(parseKeyScopes(["role:builder", "role:viewer"]).roleCeiling).toBe("viewer");
    expect(parseKeyScopes([])).toEqual({ roleCeiling: null, projects: null, legacy: [] });
    expect(parseKeyScopes(undefined)).toEqual({ roleCeiling: null, projects: null, legacy: [] });
    expect(isStructuredScope(parseKeyScopes(["read", "write"]))).toBe(false);
    expect(isStructuredScope(parseKeyScopes(["project:alpha"]))).toBe(true);
  });

  it("formats back to the stored form", () => {
    expect(formatKeyScopes({ roleCeiling: "viewer", projects: ["a", "a", "b"], legacy: ["x"] })).toEqual(["role:viewer", "project:a", "project:b", "x"]);
    expect(formatKeyScopes({})).toEqual([]);
  });
});

describe("effective role", () => {
  it("is the owner's role capped by the ceiling, and at builder with a project list", () => {
    expect(effectiveKeyRole("admin", parseKeyScopes([]))).toBe("admin");
    expect(effectiveKeyRole("admin", parseKeyScopes(["role:operator"]))).toBe("operator");
    expect(effectiveKeyRole("viewer", parseKeyScopes(["role:admin"]))).toBe("viewer");
    expect(effectiveKeyRole("admin", parseKeyScopes(["project:alpha"]))).toBe("builder");
    expect(effectiveKeyRole("admin", parseKeyScopes(["role:admin", "project:alpha"]))).toBe("builder");
    expect(scopedKeyUser({ id: "u", email: "e", role: "admin" }, parseKeyScopes(["project:alpha"]))).toEqual({
      id: "u",
      email: "e",
      role: "builder",
      projectScope: ["alpha"]
    });
    expect(scopedKeyUser({ id: "u", email: "e", role: "builder" }, parseKeyScopes(["legacy"]))).toEqual({ id: "u", email: "e", role: "builder" });
  });

  it("project RBAC sees the capped role and the project list", async () => {
    const store = { getProjectRole: async () => null, listWorkflowShares: async () => [] } as unknown as Store;
    const rbac = new RbacService(store, "role");
    const owner: SafeUser = { id: "u", email: "e", role: "admin" };
    const viewerKey = scopedKeyUser(owner, parseKeyScopes(["role:viewer"]));
    expect(await rbac.can(viewerKey, "alpha", "workflow:read")).toBe(true);
    expect(await rbac.can(viewerKey, "alpha", "workflow:write")).toBe(false);
    const alphaKey = scopedKeyUser(owner, parseKeyScopes(["project:alpha"]));
    expect(await rbac.can(alphaKey, "alpha", "workflow:write")).toBe(true);
    expect(await rbac.can(alphaKey, "beta", "workflow:read")).toBe(false);
    expect(await rbac.canAccessWorkflow(alphaKey, { id: "w", projectId: "beta" }, "workflow:read")).toBe(false);
  });
});

describe("keyMayCallRoute", () => {
  it("lets unscoped and role-only keys call anything; project keys only the listed routes", () => {
    expect(keyMayCallRoute(parseKeyScopes([]), "GET", "/api/users")).toBe(true);
    expect(keyMayCallRoute(parseKeyScopes(["role:viewer"]), "GET", "/api/users")).toBe(true);
    const projectKey = parseKeyScopes(["project:alpha"]);
    expect(keyMayCallRoute(projectKey, "GET", "/api/users")).toBe(false);
    expect(keyMayCallRoute(projectKey, "GET", "/api/workflows/:id")).toBe(true);
    expect(keyMayCallRoute(projectKey, "HEAD", "/api/workflows/:id")).toBe(true);
    expect(keyMayCallRoute(projectKey, "DELETE", "/api/workflows/:id")).toBe(false);
    expect(keyMayCallRoute(projectKey, undefined, undefined)).toBe(false);
  });
});

describe("resolveNewKeyScope", () => {
  const base = { ownerRole: "admin" as const, callerRole: "admin" as const, callerScope: null, projectExists };

  it("builds the stored scopes from role, projects and raw strings", async () => {
    expect(await resolveNewKeyScope({ role: "operator", projects: ["alpha"], scopes: ["legacy"] }, base)).toMatchObject({
      ok: true,
      scopes: ["role:operator", "project:alpha", "legacy"]
    });
    expect(await resolveNewKeyScope({ scopes: ["role:builder"], role: "viewer" }, base)).toMatchObject({ ok: true, scopes: ["role:viewer"] });
    expect(await resolveNewKeyScope({}, base)).toMatchObject({ ok: true, scopes: [] });
  });

  it("refuses what the owner or the caller cannot hold", async () => {
    expect(await resolveNewKeyScope({ role: "builder" }, { ...base, ownerRole: "operator" })).toMatchObject({ ok: false, status: 403 });
    expect(await resolveNewKeyScope({ role: "admin" }, { ...base, callerRole: "builder" })).toMatchObject({ ok: false, status: 403 });
    expect(await resolveNewKeyScope({ role: "admin", projects: ["alpha"] }, base)).toMatchObject({ ok: false, status: 400 });
    expect(await resolveNewKeyScope({ projects: ["gamma"] }, base)).toMatchObject({ ok: false, status: 400, error: "Unknown project 'gamma'" });
    expect(await resolveNewKeyScope({ scopes: ["role:root"] }, base)).toMatchObject({ ok: false, status: 400 });
    expect(await resolveNewKeyScope({ projects: Array.from({ length: 51 }, (_, i) => `p${i}`) }, base)).toMatchObject({ ok: false, status: 400 });
  });

  it("a key made with a scoped key inherits and stays inside its scope", async () => {
    const caller = parseKeyScopes(["role:builder", "project:alpha"]);
    const options = { ...base, callerRole: "builder" as const, callerScope: caller };
    expect(await resolveNewKeyScope({}, options)).toMatchObject({ ok: true, scopes: ["role:builder", "project:alpha"] });
    expect(await resolveNewKeyScope({ projects: ["beta"] }, options)).toMatchObject({ ok: false, status: 403 });
    expect(await resolveNewKeyScope({ role: "viewer" }, options)).toMatchObject({ ok: true, scopes: ["role:viewer", "project:alpha"] });
    // A legacy-only caller key is not a scoped key: nothing is inherited.
    expect(await resolveNewKeyScope({}, { ...base, callerScope: parseKeyScopes(["read"]) })).toMatchObject({ ok: true, scopes: [] });
  });
});

describe("keyBoundUser (13.2: work that goes on later keeps the key's limits)", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  const keys = [
    { id: "k-alpha", userId: "u-admin", scopes: ["project:alpha"], revokedAt: null, expiresAt: null },
    { id: "k-viewer", userId: "u-admin", scopes: ["role:viewer"], revokedAt: null, expiresAt: "2026-12-01T00:00:00Z" },
    { id: "k-revoked", userId: "u-admin", scopes: [], revokedAt: "2026-11-01T00:00:00Z", expiresAt: null },
    { id: "k-expired", userId: "u-admin", scopes: [], revokedAt: null, expiresAt: "2026-11-09T11:59:59Z" },
    { id: "k-other", userId: "u-other", scopes: [], revokedAt: null, expiresAt: null }
  ];
  const users: Record<string, { id: string; email: string; role: string; kind: "human" | "service" }> = {
    "u-admin": { id: "u-admin", email: "admin@x", role: "admin", kind: "human" },
    "u-bot": { id: "u-bot", email: "bot+1@service.invalid", role: "admin", kind: "service" }
  };
  const store = {
    getUserById: async (id: string) => (users[id] ? { ...users[id]!, passwordHash: "", description: null, createdBy: null, createdAt: "", updatedAt: "" } : null),
    listApiKeys: async (userId?: string) =>
      keys.filter((key) => !userId || key.userId === userId).map((key) => ({ ...key, name: key.id, keyPrefix: key.id, lastUsedAt: null, createdAt: "" }))
  } as unknown as Pick<Store, "getUserById" | "listApiKeys">;

  it("without a key: the owner as stored", async () => {
    expect(await keyBoundUser(store, "u-admin", null, now)).toEqual({ id: "u-admin", email: "admin@x", role: "admin" });
    expect(await keyBoundUser(store, "u-bot", undefined, now)).toEqual({ id: "u-bot", email: "bot+1@service.invalid", role: "admin", serviceAccount: true });
    expect(await keyBoundUser(store, "u-gone", null, now)).toBeNull();
  });

  it("with a live key: its ceiling and project list, never the owner's full role", async () => {
    expect(await keyBoundUser(store, "u-admin", "k-alpha", now)).toEqual({ id: "u-admin", email: "admin@x", role: "builder", projectScope: ["alpha"], apiKeyId: "k-alpha" });
    expect(await keyBoundUser(store, "u-admin", "k-viewer", now)).toEqual({ id: "u-admin", email: "admin@x", role: "viewer", apiKeyId: "k-viewer" });
  });

  it("refuses a revoked, expired, unknown or someone else's key, as for a deleted user", async () => {
    for (const keyId of ["k-revoked", "k-expired", "k-missing", "k-other"]) {
      expect(await keyBoundUser(store, "u-admin", keyId, now), keyId).toBeNull();
    }
  });
});

describe("keyMayManageAccount (13.2)", () => {
  it("refuses a scoped key on the MFA routes only", () => {
    const roleOnly = parseKeyScopes(["role:viewer"]);
    const projects = parseKeyScopes(["project:alpha"]);
    const legacy = parseKeyScopes(["read"]);
    for (const url of ["/api/auth/mfa/enroll", "/api/auth/mfa/activate", "/api/auth/mfa/disable"]) {
      expect(keyMayManageAccount(roleOnly, "POST", url)).toBe(false);
      expect(keyMayManageAccount(projects, "post", url)).toBe(false);
      expect(keyMayManageAccount(legacy, "POST", url)).toBe(true);
    }
    expect(keyMayManageAccount(roleOnly, "GET", "/api/auth/mfa/status")).toBe(true);
    expect(keyMayManageAccount(roleOnly, "POST", "/api/auth/api-keys")).toBe(true);
  });
});

describe("scopedKeyUser carries the key and the account kind", () => {
  it("records the key id and keeps the service-account flag", () => {
    const owner: SafeUser = { id: "u", email: "u@x", role: "admin", serviceAccount: true };
    expect(scopedKeyUser(owner, parseKeyScopes(["role:operator"]), "k1")).toEqual({ id: "u", email: "u@x", role: "operator", apiKeyId: "k1", serviceAccount: true });
  });
});
