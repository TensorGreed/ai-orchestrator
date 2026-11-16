/**
 * 13.2 (v75) — store contract: SCIM tokens, provisioned users, groups and members, and disabling a user, on both stores.
 */
import { expect, it } from "vitest";
import type { ScimTokenWrite, ScimUserLink } from "../scim-store.js";
import { describeStoreContract } from "../../test-support/test-store.js";

const NOW = "2026-11-16T10:00:00.000Z";
const LATER = "2026-11-17T10:00:00.000Z";
const FAR = "2027-11-16T10:00:00.000Z";

function token(overrides: Partial<ScimTokenWrite> = {}): ScimTokenWrite {
  return {
    id: "sct_1",
    name: "idp",
    tokenPrefix: "scim_aaaaaaaaaa",
    tokenHash: "hash-1",
    createdBy: "usr_admin",
    createdAt: NOW,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    supersededBy: null,
    ...overrides
  };
}

function link(userId: string, userName: string, overrides: Partial<ScimUserLink> = {}): ScimUserLink {
  return {
    userId,
    userName,
    externalId: null,
    displayName: null,
    givenName: null,
    familyName: null,
    origin: "created",
    grants: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

describeStoreContract("store contract: SCIM provisioning", (ctx) => {
  it("stores tokens by hash, rotates them with a grace end, and revokes the chain", async () => {
    const store = ctx.store();
    await store.createScimToken(token({ expiresAt: FAR }));
    expect(await store.findScimTokenByPrefix("scim_aaaaaaaaaa")).toMatchObject({ id: "sct_1", tokenHash: "hash-1", expiresAt: FAR });
    expect(await store.findScimTokenByPrefix("scim_missing00")).toBeNull();
    const listed = await store.listScimTokens();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("tokenHash");

    const next = token({ id: "sct_2", tokenPrefix: "scim_bbbbbbbbbb", tokenHash: "hash-2", createdAt: LATER, expiresAt: FAR });
    expect(await store.rotateScimToken({ id: "sct_1", next, graceUntil: LATER, now: NOW })).toBe(true);
    // Rotated once only.
    expect(await store.rotateScimToken({ id: "sct_1", next: { ...next, id: "sct_3", tokenPrefix: "scim_cccccccccc" }, graceUntil: LATER, now: NOW })).toBe(false);
    expect(await store.findScimTokenByPrefix("scim_cccccccccc")).toBeNull();
    expect(await store.findScimTokenByPrefix("scim_aaaaaaaaaa")).toMatchObject({ supersededBy: "sct_2", expiresAt: LATER });

    await store.touchScimToken("sct_2", NOW);
    expect((await store.findScimTokenByPrefix("scim_bbbbbbbbbb"))?.lastUsedAt).toBe(NOW);
    // A second rotation while the first is in grace: revoking the newest ends the whole chain still in grace.
    const third = token({ id: "sct_3", tokenPrefix: "scim_dddddddddd", tokenHash: "hash-3", createdAt: LATER, expiresAt: FAR });
    expect(await store.rotateScimToken({ id: "sct_2", next: third, graceUntil: LATER, now: NOW })).toBe(true);
    expect(await store.revokeScimToken("sct_3", NOW)).toBe(true);
    expect(await store.revokeScimToken("sct_3", NOW)).toBe(false);
    expect((await store.findScimTokenByPrefix("scim_bbbbbbbbbb"))?.revokedAt).toBe(NOW);
    expect((await store.findScimTokenByPrefix("scim_aaaaaaaaaa"))?.revokedAt).toBe(NOW);
  });

  it("links users, finds them case-insensitively, filters and pages", async () => {
    const store = ctx.store();
    for (const [id, email] of [["usr_a", "ada@example.com"], ["usr_b", "bob@example.com"], ["usr_c", "cy@example.com"]] as const) {
      await store.saveUser({ id, email, passwordHash: "x:y", role: "viewer" });
    }
    expect(await store.createScimUser(link("usr_a", "Ada@Example.com", { externalId: "ext-a", createdAt: "2026-11-16T10:00:01.000Z" }))).toBe(true);
    expect(await store.createScimUser(link("usr_b", "bob", { createdAt: "2026-11-16T10:00:02.000Z" }))).toBe(true);
    expect(await store.createScimUser(link("usr_c", "cy", { createdAt: "2026-11-16T10:00:03.000Z", origin: "adopted" }))).toBe(true);
    // userName is unique case-insensitively; a user links once.
    expect(await store.createScimUser(link("usr_c", "other"))).toBe(false);
    expect(await store.createScimUser(link("usr_x", "ada@example.com"))).toBe(false);

    expect(await store.findScimUserByUserName("ADA@example.com")).toMatchObject({ userId: "usr_a", email: "ada@example.com", role: "viewer", disabledAt: null });
    expect((await store.getScimUser("usr_c"))?.origin).toBe("adopted");
    expect((await store.listScimUsers({ filter: { field: "externalId", value: "ext-a" }, offset: 0, limit: 10 })).items.map((u) => u.userId)).toEqual(["usr_a"]);
    expect((await store.listScimUsers({ filter: { field: "email", value: "BOB@example.com" }, offset: 0, limit: 10 })).total).toBe(1);
    const page = await store.listScimUsers({ offset: 1, limit: 1 });
    expect(page).toMatchObject({ total: 3, items: [{ userId: "usr_b" }] });

    const grant = { projectId: null, role: "builder", customRoleId: null, restore: { role: "viewer", customRoleId: null } };
    await store.setScimUserGrants("usr_b", [grant], NOW);
    // Attributes and grants are written separately: an attribute update never overwrites the grants.
    const updated = await store.updateScimUser({ ...link("usr_b", "Robert"), grants: [], updatedAt: LATER });
    expect(updated).toBe(true);
    expect(await store.getScimUser("usr_b")).toMatchObject({ userName: "Robert", grants: [grant], updatedAt: LATER });
    // The email of a person's account changes alone; a taken address and a service account are refused.
    expect(await store.updateScimUserEmail("usr_b", "robert@example.com", LATER)).toBe("updated");
    expect(await store.getUserById("usr_b")).toMatchObject({ email: "robert@example.com", role: "viewer" });
    expect(await store.updateScimUserEmail("usr_b", "ada@example.com", LATER)).toBe("taken");
    await store.createServiceAccount({ id: "usr_svc", email: "bot+1@service.invalid", role: "viewer", description: null, createdBy: null });
    expect(await store.updateScimUserEmail("usr_svc", "bot@example.com", LATER)).toBe("not_found");
    // A taken userName is refused.
    expect(await store.updateScimUser(link("usr_b", "ada@EXAMPLE.com"))).toBe(false);
  });

  it("keeps groups and members of provisioned users only", async () => {
    const store = ctx.store();
    await store.saveUser({ id: "usr_a", email: "ada@example.com", passwordHash: "x:y", role: "viewer" });
    await store.saveUser({ id: "usr_local", email: "local@example.com", passwordHash: "x:y", role: "admin" });
    await store.createScimUser(link("usr_a", "ada"));
    const group = { id: "scg_1", displayName: "Engineering", externalId: "g-1", createdAt: NOW, updatedAt: NOW };
    expect(await store.createScimGroup(group)).toBe(true);
    expect(await store.createScimGroup({ ...group, id: "scg_2", displayName: "ENGINEERING" })).toBe(false);
    expect(await store.createScimGroup({ ...group, id: "scg_2", displayName: "Ops", externalId: null })).toBe(true);

    // A user SCIM did not provision never joins.
    expect(await store.addScimGroupMembers("scg_1", ["usr_a", "usr_local", "usr_a"], NOW)).toEqual(["usr_a"]);
    expect(await store.addScimGroupMembers("scg_missing", ["usr_a"], NOW)).toEqual([]);
    expect(await store.listScimGroupMembers("scg_1")).toEqual([{ userId: "usr_a", userName: "ada" }]);
    expect((await store.listScimGroupsOfUser("usr_a")).map((g) => g.id)).toEqual(["scg_1"]);
    expect(await store.countScimGroupMembers(["scg_1", "scg_2"])).toEqual(new Map([["scg_1", 1]]));
    expect((await store.listScimGroups({ filter: { field: "displayName", value: "engineering" }, offset: 0, limit: 5 })).items.map((g) => g.id)).toEqual(["scg_1"]);
    expect((await store.listScimGroups({ filter: { field: "member", value: "usr_a" }, offset: 0, limit: 5 })).total).toBe(1);

    expect(await store.updateScimGroup({ ...group, displayName: "ops" })).toBe(false);
    expect(await store.updateScimGroup({ ...group, displayName: "Eng", updatedAt: LATER })).toBe(true);
    expect(await store.getScimGroup("scg_1")).toMatchObject({ displayName: "Eng", updatedAt: LATER });

    expect(await store.removeScimGroupMembers("scg_1", ["usr_a"])).toBe(1);
    await store.addScimGroupMembers("scg_1", ["usr_a"], NOW);
    expect(await store.removeAllScimGroupMembers("scg_1")).toEqual(["usr_a"]);
    await store.addScimGroupMembers("scg_1", ["usr_a"], NOW);
    expect(await store.deleteScimGroup("scg_1")).toBe(true);
    expect(await store.listScimGroupsOfUser("usr_a")).toEqual([]);

    await store.addScimGroupMembers("scg_2", ["usr_a"], NOW);
    expect(await store.deleteScimUser("usr_a")).toBe(true);
    expect(await store.listScimGroupMembers("scg_2")).toEqual([]);
    expect(await store.getUserById("usr_a")).not.toBeNull();
  });

  it("disables a person (sessions and keys ended, break-glass kept), never the last enabled admin", async () => {
    const store = ctx.store();
    await store.saveUser({ id: "usr_admin", email: "admin@example.com", passwordHash: "x:y", role: "admin" });
    await store.saveUser({ id: "usr_p", email: "p@example.com", passwordHash: "x:y", role: "builder" });
    await store.saveSession({ id: "s_p1", userId: "usr_p", expiresAt: FAR });
    await store.saveSession({ id: "s_p2", userId: "usr_p", expiresAt: FAR, authMethod: "break_glass", breakGlass: true });
    await store.saveApiKey({ id: "apk_p", userId: "usr_p", name: "k", keyPrefix: "ao_pppppppppp", keyHash: "h", expiresAt: null });

    expect(await store.setUserDisabled("usr_p", { disabled: true, now: NOW })).toEqual({ status: "updated", sessionsEnded: 1, keysRevoked: 1 });
    expect((await store.getUserById("usr_p"))?.disabledAt).toBe(NOW);
    expect((await store.getSession("s_p1"))).toMatchObject({ endedReason: "admin" });
    expect((await store.getSession("s_p2"))?.revokedAt).toBeNull();
    expect((await store.listApiKeys("usr_p"))[0]?.revokedAt).toBe(NOW);
    // Again: no change to the time it was disabled.
    expect(await store.setUserDisabled("usr_p", { disabled: true, now: LATER })).toEqual({ status: "updated", sessionsEnded: 0, keysRevoked: 0 });
    expect((await store.getUserById("usr_p"))?.disabledAt).toBe(NOW);
    expect(await store.setUserDisabled("usr_p", { disabled: false, now: LATER })).toMatchObject({ status: "updated" });
    expect((await store.getUserById("usr_p"))?.disabledAt).toBeNull();

    expect(await store.setUserDisabled("usr_admin", { disabled: true, now: NOW })).toEqual({ status: "last_admin" });
    expect(await store.setUserDisabled("usr_missing", { disabled: true, now: NOW })).toEqual({ status: "not_found" });
    await store.createServiceAccount({ id: "usr_svc", email: "bot+1@service.invalid", role: "viewer", description: null, createdBy: null });
    expect(await store.setUserDisabled("usr_svc", { disabled: true, now: NOW })).toEqual({ status: "service_account" });

    // A disabled admin does not count: the remaining enabled admin cannot be demoted or deleted.
    await store.saveUser({ id: "usr_admin2", email: "admin2@example.com", passwordHash: "x:y", role: "admin" });
    expect(await store.setUserDisabled("usr_admin", { disabled: true, now: NOW })).toMatchObject({ status: "updated" });
    expect(await store.updateUserRoleKeepingAdmin("usr_admin2", "viewer")).toBe("last_admin");
    expect(await store.deleteUserKeepingAdmin("usr_admin2")).toBe("last_admin");
    // Deleting the disabled admin is allowed (it is not the one who can sign in), with its SCIM rows.
    await store.createScimUser(link("usr_admin", "admin"));
    expect(await store.deleteUserKeepingAdmin("usr_admin")).toBe("deleted");
    expect(await store.getScimUser("usr_admin")).toBeNull();
  });
});
