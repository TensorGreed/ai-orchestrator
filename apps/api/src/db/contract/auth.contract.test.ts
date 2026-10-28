/**
 * Phase 13.1 — store contract: users, project roles, custom roles, SSO group mappings, API keys, MFA secrets and SSO
 * identities. The same assertions run on SQLite and, with TEST_POSTGRES_URL, on Postgres.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";
import type { Store } from "../store.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function user(store: Store, id: string, email = `${id}@example.com`) {
  return store.saveUser({ id, email, passwordHash: `hash-${id}`, role: "builder" });
}

async function project(store: Store, id: string) {
  return store.upsertProject({ id, name: `Project ${id}` });
}

describeStoreContract("store contract: users and auth", (ctx) => {
  it("saves, reads, lists, counts and re-roles users; emails are lower-cased and matched case-insensitively", async () => {
    const store = ctx.store();
    expect(await store.countUsers()).toBe(0);
    const saved = await user(store, "u1", "Alice@Example.COM");
    expect(saved).toMatchObject({ id: "u1", email: "alice@example.com", role: "builder" });
    expect(saved.createdAt).toMatch(ISO);
    await tick();
    await user(store, "u2");
    expect(await store.countUsers()).toBe(2);
    expect(await store.getUserByEmail("ALICE@example.com")).toMatchObject({ id: "u1", passwordHash: "hash-u1" });
    expect(await store.getUserByEmail("nobody@example.com")).toBeNull();
    expect(await store.getUserById("missing")).toBeNull();
    expect((await store.listUsers()).map((u) => u.id)).toEqual(["u2", "u1"]);

    const before = await store.getUserById("u1");
    await tick();
    const resaved = await store.saveUser({ id: "u1", email: "alice@example.com", passwordHash: "h2", role: "admin" });
    expect(resaved.createdAt).toBe(before?.createdAt);
    expect(await store.updateUserRole("u1", "viewer")).toBe(true);
    expect(await store.updateUserRole("missing", "viewer")).toBe(false);
    expect(await store.getUserById("u1")).toMatchObject({ role: "viewer", passwordHash: "h2" });
  });

  it("deleteUser removes the user's sessions, API keys, MFA secret, SSO identities and project roles", async () => {
    const store = ctx.store();
    await user(store, "u1");
    await user(store, "u2");
    await project(store, "p1");
    await store.saveSession({ id: "s1", userId: "u1", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await store.saveApiKey({ id: "k1", userId: "u1", name: "ci", keyPrefix: "pre1", keyHash: "h" });
    await store.saveApiKey({ id: "k2", userId: "u2", name: "ci", keyPrefix: "pre2", keyHash: "h" });
    await store.upsertMfaSecret({ userId: "u1", secretIv: "iv", secretAuthTag: "tag", secretCiphertext: "ct", backupCodes: ["a"], enabled: true, activatedAt: null });
    await store.upsertSsoIdentity({ id: "sso1", userId: "u1", provider: "oidc", subject: "sub-1" });
    await store.upsertProjectRole({ userId: "u1", projectId: "p1", role: "builder" });
    await store.upsertProjectRole({ userId: "u2", projectId: "p1", role: "viewer" });

    expect(await store.deleteUser("u1")).toBe(true);
    expect(await store.getUserById("u1")).toBeNull();
    expect(await store.getSession("s1")).toBeNull();
    expect((await store.listApiKeys()).map((k) => k.id)).toEqual(["k2"]);
    expect(await store.getMfaSecret("u1")).toBeNull();
    expect(await store.findSsoIdentity("oidc", "sub-1")).toBeNull();
    expect(await store.listUserProjectRoles("u1")).toEqual([]);
    expect((await store.listProjectMembers("p1")).map((m) => m.userId)).toEqual(["u2"]);
    expect(await store.deleteUser("u1")).toBe(false);
    expect(await store.countUsers()).toBe(1);
  });

  it("project roles: upsert keeps creation time, lists by project in creation order and by user in project id order", async () => {
    const store = ctx.store();
    await user(store, "u1");
    await user(store, "u2");
    await project(store, "pb");
    await project(store, "PA");
    await project(store, "pa");
    expect(await store.countProjectMemberships()).toBe(0);
    await store.upsertProjectRole({ userId: "u1", projectId: "pb", role: "builder" });
    await tick();
    await store.upsertProjectRole({ userId: "u2", projectId: "pb", role: "viewer", customRoleId: "cr1" });
    await store.upsertProjectRole({ userId: "u1", projectId: "pa", role: "viewer" });
    await store.upsertProjectRole({ userId: "u1", projectId: "PA", role: "viewer" });
    expect(await store.countProjectMemberships()).toBe(4);

    const members = await store.listProjectMembers("pb");
    expect(members.map((m) => m.userId)).toEqual(["u1", "u2"]);
    expect(members[1]).toMatchObject({ projectId: "pb", role: "viewer", customRoleId: "cr1" });
    expect(members[0].customRoleId).toBeNull();
    expect(members[0].createdAt).toMatch(ISO);
    expect((await store.listUserProjectRoles("u1")).map((r) => r.projectId)).toEqual(["PA", "pa", "pb"]);
    expect(await store.listUserProjectRoles("u1")).toContainEqual({ userId: "u1", projectId: "pb", role: "builder", customRoleId: null });

    const firstCreated = members[0].createdAt;
    await tick();
    await store.upsertProjectRole({ userId: "u1", projectId: "pb", role: "admin", customRoleId: "cr2" });
    expect(await store.getProjectRole("u1", "pb")).toEqual({ userId: "u1", projectId: "pb", role: "admin", customRoleId: "cr2" });
    const after = (await store.listProjectMembers("pb")).find((m) => m.userId === "u1");
    expect(after?.createdAt).toBe(firstCreated);
    expect(Date.parse(after!.updatedAt)).toBeGreaterThan(Date.parse(firstCreated));
    expect(await store.getProjectRole("u1", "nope")).toBeNull();

    expect(await store.removeProjectRole("u1", "pb")).toBe(true);
    expect(await store.removeProjectRole("u1", "pb")).toBe(false);
    expect(await store.countProjectMemberships()).toBe(3);
  });

  it("custom roles: list filters by scope and sorts by name in byte order; delete clears member references", async () => {
    const store = ctx.store();
    await user(store, "u1");
    await project(store, "p1");
    await store.upsertCustomRole({ id: "r1", name: "beta", permissions: ["workflow:read"], createdBy: "u1" });
    await store.upsertCustomRole({ id: "r2", projectId: "p1", name: "Alpha", description: "desc", permissions: ["a", "b"] });
    await store.upsertCustomRole({ id: "r3", projectId: "p2", name: "alpha", permissions: [] });
    expect((await store.listCustomRoles()).map((r) => r.name)).toEqual(["Alpha", "alpha", "beta"]);
    expect((await store.listCustomRoles(null)).map((r) => r.id)).toEqual(["r1"]);
    expect((await store.listCustomRoles("p1")).map((r) => r.id)).toEqual(["r2", "r1"]);
    const r2 = await store.getCustomRole("r2");
    expect(r2).toMatchObject({ id: "r2", projectId: "p1", name: "Alpha", description: "desc", permissions: ["a", "b"], createdBy: null });
    expect(await store.getCustomRole("r1")).toMatchObject({ projectId: null, description: null, createdBy: "u1" });
    expect(r2?.createdAt).toMatch(ISO);

    await tick();
    await store.upsertCustomRole({ id: "r1", name: "gamma", permissions: ["x"], createdBy: "someone-else" });
    const r1 = await store.getCustomRole("r1");
    expect(r1).toMatchObject({ name: "gamma", permissions: ["x"], createdBy: "u1" });
    expect(Date.parse(r1!.updatedAt)).toBeGreaterThan(Date.parse(r1!.createdAt));

    await store.upsertProjectRole({ userId: "u1", projectId: "p1", role: "viewer", customRoleId: "r2" });
    expect(await store.deleteCustomRole("r2")).toBe(true);
    expect(await store.deleteCustomRole("r2")).toBe(false);
    expect(await store.getCustomRole("r2")).toBeNull();
    expect(await store.getProjectRole("u1", "p1")).toMatchObject({ customRoleId: null });
  });

  it("SSO group mappings: upsert, list per provider by group and all by provider then group, delete once", async () => {
    const store = ctx.store();
    await store.upsertSsoGroupMapping({ id: "m1", provider: "okta", groupName: "eng", role: "builder" });
    await store.upsertSsoGroupMapping({ id: "m2", provider: "okta", groupName: "Admins", projectId: "p1", role: "admin", customRoleId: "cr" });
    await store.upsertSsoGroupMapping({ id: "m3", provider: "Azure", groupName: "ops", role: "viewer" });
    expect((await store.listSsoGroupMappings("okta")).map((m) => m.groupName)).toEqual(["Admins", "eng"]);
    expect((await store.listSsoGroupMappings()).map((m) => m.id)).toEqual(["m3", "m2", "m1"]);
    const m2 = (await store.listSsoGroupMappings("okta"))[0];
    expect(m2).toMatchObject({ id: "m2", provider: "okta", projectId: "p1", role: "admin", customRoleId: "cr" });
    expect(m2.createdAt).toMatch(ISO);
    await tick();
    await store.upsertSsoGroupMapping({ id: "m2", provider: "okta", groupName: "admins", role: "viewer" });
    const updated = (await store.listSsoGroupMappings("okta")).find((m) => m.id === "m2");
    expect(updated).toMatchObject({ groupName: "admins", role: "viewer", projectId: null, customRoleId: null, createdAt: m2.createdAt });
    expect(await store.deleteSsoGroupMapping("m2")).toBe(true);
    expect(await store.deleteSsoGroupMapping("m2")).toBe(false);
    expect(await store.listSsoGroupMappings("nobody")).toEqual([]);
  });

  it("API keys: save, list newest first, find active by prefix, touch, revoke (owner-scoped)", async () => {
    const store = ctx.store();
    await user(store, "u1");
    await user(store, "u2");
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    await store.saveApiKey({ id: "k1", userId: "u1", name: "first", keyPrefix: "pfx1", keyHash: "hash1", scopes: ["workflow:run"], expiresAt });
    await tick();
    await store.saveApiKey({ id: "k2", userId: "u2", name: "second", keyPrefix: "pfx2", keyHash: "hash2" });
    expect((await store.listApiKeys()).map((k) => k.id)).toEqual(["k2", "k1"]);
    const [k1] = await store.listApiKeys("u1");
    expect(k1).toEqual({
      id: "k1",
      userId: "u1",
      name: "first",
      keyPrefix: "pfx1",
      scopes: ["workflow:run"],
      lastUsedAt: null,
      expiresAt,
      revokedAt: null,
      createdAt: k1.createdAt
    });
    expect(k1.createdAt).toMatch(ISO);
    expect(k1).not.toHaveProperty("keyHash");
    expect(await store.findApiKeyByPrefix("pfx1")).toMatchObject({ id: "k1", keyHash: "hash1", scopes: ["workflow:run"] });
    expect(await store.findApiKeyByPrefix("nope")).toBeNull();

    await store.touchApiKey("k1");
    expect((await store.findApiKeyByPrefix("pfx1"))?.lastUsedAt).toMatch(ISO);

    expect(await store.revokeApiKey("k1", "u2")).toBe(false);
    expect(await store.revokeApiKey("k1", "u1")).toBe(true);
    expect(await store.findApiKeyByPrefix("pfx1")).toBeNull();
    expect((await store.listApiKeys("u1"))[0].revokedAt).toMatch(ISO);
    expect(await store.revokeApiKey("k2")).toBe(true);
    expect(await store.revokeApiKey("missing")).toBe(false);
    expect((await store.listApiKeys("u2"))[0].scopes).toEqual([]);
  });

  it("MFA secrets: upsert keeps creation time, backup codes compare-and-set, delete once", async () => {
    const store = ctx.store();
    await user(store, "u1");
    expect(await store.getMfaSecret("u1")).toBeNull();
    await store.upsertMfaSecret({ userId: "u1", secretIv: "iv", secretAuthTag: "tag", secretCiphertext: "ct", backupCodes: ["a", "b"], enabled: false, activatedAt: null });
    const first = await store.getMfaSecret("u1");
    expect(first).toMatchObject({ userId: "u1", secretIv: "iv", secretAuthTag: "tag", secretCiphertext: "ct", backupCodes: ["a", "b"], enabled: false, activatedAt: null });
    expect(first?.createdAt).toMatch(ISO);
    await tick();
    const activatedAt = new Date().toISOString();
    await store.upsertMfaSecret({ userId: "u1", secretIv: "iv2", secretAuthTag: "tag2", secretCiphertext: "ct2", backupCodes: ["a", "b"], enabled: true, activatedAt });
    const second = await store.getMfaSecret("u1");
    expect(second).toMatchObject({ secretIv: "iv2", enabled: true, activatedAt, createdAt: first?.createdAt });

    expect(await store.replaceMfaBackupCodes({ userId: "u1", expected: ["a"], next: [] })).toBe(false);
    expect(await store.replaceMfaBackupCodes({ userId: "u1", expected: ["a", "b"], next: ["b"] })).toBe(true);
    expect((await store.getMfaSecret("u1"))?.backupCodes).toEqual(["b"]);
    expect(await store.replaceMfaBackupCodes({ userId: "u1", expected: ["a", "b"], next: ["a"] })).toBe(false);
    expect(await store.replaceMfaBackupCodes({ userId: "missing", expected: [], next: [] })).toBe(false);

    expect(await store.deleteMfaSecret("u1")).toBe(true);
    expect(await store.deleteMfaSecret("u1")).toBe(false);
  });

  it("two backup-code spends of the same stored codes at once: exactly one wins", async () => {
    const store = ctx.store();
    await user(store, "u1");
    await store.upsertMfaSecret({ userId: "u1", secretIv: "iv", secretAuthTag: "tag", secretCiphertext: "ct", backupCodes: ["a", "b", "c"], enabled: true, activatedAt: null });
    for (let round = 0; round < 5; round += 1) {
      const current = (await store.getMfaSecret("u1"))!.backupCodes;
      const results = await Promise.all([
        store.replaceMfaBackupCodes({ userId: "u1", expected: current, next: [...current, `x${round}`] }),
        store.replaceMfaBackupCodes({ userId: "u1", expected: current, next: [...current, `y${round}`] })
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const stored = (await store.getMfaSecret("u1"))!.backupCodes;
      expect(stored).toEqual([...current, results[0] ? `x${round}` : `y${round}`]);
    }
  });

  it("SSO identities: an upsert of the same provider/subject keeps its id and creation time", async () => {
    const store = ctx.store();
    await user(store, "u1");
    await user(store, "u2");
    expect(await store.findSsoIdentity("oidc", "sub")).toBeNull();
    await store.upsertSsoIdentity({ id: "i1", userId: "u1", provider: "oidc", subject: "sub", email: "a@example.com", attributes: { groups: ["eng"] } });
    const first = await store.findSsoIdentity("oidc", "sub");
    expect(first).toMatchObject({ id: "i1", userId: "u1", provider: "oidc", subject: "sub", email: "a@example.com", attributes: { groups: ["eng"] } });
    expect(first?.createdAt).toMatch(ISO);
    await tick();
    await store.upsertSsoIdentity({ id: "i2", userId: "u2", provider: "oidc", subject: "sub" });
    const second = await store.findSsoIdentity("oidc", "sub");
    expect(second).toMatchObject({ id: "i1", userId: "u2", email: null, attributes: null, createdAt: first?.createdAt });
    expect(await store.findSsoIdentity("oidc", "SUB")).toBeNull();
  });

  it("SSO identities: renameSsoIdentitySubject moves a subject once and never over an existing one", async () => {
    const store = ctx.store();
    await user(store, "u1");
    await user(store, "u2");
    await store.upsertSsoIdentity({ id: "legacy", userId: "u1", provider: "saml", subject: "alice", email: "a@example.com" });
    const before = await store.findSsoIdentity("saml", "alice");
    await tick();
    expect(await store.renameSsoIdentitySubject({ provider: "saml", from: "alice", to: "https://idp.example/x#alice" })).toBe(true);
    expect(await store.findSsoIdentity("saml", "alice")).toBeNull();
    const moved = await store.findSsoIdentity("saml", "https://idp.example/x#alice");
    expect(moved).toMatchObject({ id: "legacy", userId: "u1", email: "a@example.com", createdAt: before?.createdAt });
    expect(moved!.updatedAt >= before!.updatedAt).toBe(true);
    // Already moved, missing, other provider: nothing happens.
    expect(await store.renameSsoIdentitySubject({ provider: "saml", from: "alice", to: "https://idp.example/x#alice" })).toBe(false);
    expect(await store.renameSsoIdentitySubject({ provider: "oidc", from: "https://idp.example/x#alice", to: "z" })).toBe(false);
    // The target already exists: both rows stay as they were.
    await store.upsertSsoIdentity({ id: "other", userId: "u2", provider: "saml", subject: "bob" });
    await store.upsertSsoIdentity({ id: "scoped", userId: "u1", provider: "saml", subject: "https://idp.example/x#bob" });
    expect(await store.renameSsoIdentitySubject({ provider: "saml", from: "bob", to: "https://idp.example/x#bob" })).toBe(false);
    expect(await store.findSsoIdentity("saml", "bob")).toMatchObject({ id: "other", userId: "u2" });
    expect(await store.findSsoIdentity("saml", "https://idp.example/x#bob")).toMatchObject({ id: "scoped", userId: "u1" });
  });
});
