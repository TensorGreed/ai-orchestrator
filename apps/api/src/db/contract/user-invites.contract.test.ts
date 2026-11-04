/**
 * Roadmap 7.3 — store contract: deployment-level user invites and the paged workflow and user lists, on both stores.
 */
import { expect, it } from "vitest";
import type { Workflow } from "@ai-orchestrator/shared";
import type { UserInviteCreate } from "../store.js";
import { describeStoreContract } from "../../test-support/test-store.js";

const NOW = "2026-11-04T10:00:00.000Z";
const LATER = "2026-11-11T10:00:00.000Z";

function invite(overrides: Partial<UserInviteCreate> = {}): UserInviteCreate {
  return {
    inviteId: "inv_1",
    userId: "usr_new",
    email: "new@example.com",
    role: "builder",
    tokenHash: "hash-1",
    createdBy: "usr_admin",
    createdAt: NOW,
    expiresAt: LATER,
    ...overrides
  };
}

function workflow(id: string, tags: string[] = []): Workflow {
  return { id, name: id, schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [], tags } as unknown as Workflow;
}

describeStoreContract("store contract: user invites and paged lists", (ctx) => {
  it("creates a pending user with an unusable password and an open invite", async () => {
    const store = ctx.store();
    const created = await store.createUserInvite(invite());
    expect(created).toEqual({
      created: true,
      invite: { id: "inv_1", userId: "usr_new", email: "new@example.com", role: "builder", createdBy: "usr_admin", createdAt: NOW, expiresAt: LATER, acceptedAt: null }
    });
    const user = await store.getUserByEmail("new@example.com");
    expect(user).toMatchObject({ id: "usr_new", role: "builder", passwordHash: "" });
    expect(await store.listOpenUserInvites()).toEqual([created!.invite]);
    expect(await store.findUserInviteByTokenHash("hash-1")).toEqual(created!.invite);
    expect(await store.findUserInviteByTokenHash("other")).toBeNull();
  });

  it("invites a pending user again (role set, old invite gone) and refuses an active user", async () => {
    const store = ctx.store();
    await store.createUserInvite(invite());
    const again = await store.createUserInvite(invite({ inviteId: "inv_2", userId: "usr_ignored", tokenHash: "hash-2", role: "operator" }));
    expect(again).toMatchObject({ created: false, invite: { id: "inv_2", userId: "usr_new", role: "operator" } });
    expect((await store.getUserById("usr_new"))?.role).toBe("operator");
    expect(await store.findUserInviteByTokenHash("hash-1")).toBeNull();
    expect(await store.getUserById("usr_ignored")).toBeNull();

    await store.saveUser({ id: "usr_active", email: "active@example.com", passwordHash: "salt:hash", role: "viewer" });
    expect(await store.createUserInvite(invite({ inviteId: "inv_3", userId: "usr_x", email: "active@example.com", tokenHash: "hash-3" }))).toBeNull();
    expect(await store.findUserInviteByTokenHash("hash-3")).toBeNull();
  });

  it("accepts an invite once, and never an expired one", async () => {
    const store = ctx.store();
    await store.createUserInvite(invite());
    await store.createUserInvite(invite({ inviteId: "inv_old", userId: "usr_old", email: "old@example.com", tokenHash: "hash-old", expiresAt: "2026-11-04T09:00:00.000Z" }));
    expect(await store.acceptUserInvite({ tokenHash: "hash-old", passwordHash: "p", now: NOW })).toBeNull();
    expect(await store.acceptUserInvite({ tokenHash: "missing", passwordHash: "p", now: NOW })).toBeNull();

    const [first, second] = await Promise.all([
      store.acceptUserInvite({ tokenHash: "hash-1", passwordHash: "salt:one", now: NOW }),
      store.acceptUserInvite({ tokenHash: "hash-1", passwordHash: "salt:two", now: NOW })
    ]);
    const winners = [first, second].filter(Boolean);
    expect(winners).toEqual([{ id: "usr_new", email: "new@example.com", role: "builder" }]);
    const user = await store.getUserById("usr_new");
    expect(["salt:one", "salt:two"]).toContain(user?.passwordHash);
    expect((await store.findUserInviteByTokenHash("hash-1"))?.acceptedAt).toBe(NOW);
    expect((await store.listOpenUserInvites()).map((item) => item.id)).toEqual(["inv_old"]);
    // An accepted user is active: inviting the email again is refused.
    expect(await store.createUserInvite(invite({ inviteId: "inv_9", tokenHash: "hash-9" }))).toBeNull();
  });

  it("closes a user's open invites, and deleteUser removes them", async () => {
    const store = ctx.store();
    await store.createUserInvite(invite());
    expect(await store.closeUserInvites("usr_new", NOW)).toBe(1);
    expect(await store.closeUserInvites("usr_new", NOW)).toBe(0);
    expect(await store.acceptUserInvite({ tokenHash: "hash-1", passwordHash: "p", now: NOW })).toBeNull();

    await store.createUserInvite(invite({ inviteId: "inv_b", userId: "usr_b", email: "b@example.com", tokenHash: "hash-b" }));
    expect(await store.deleteUser("usr_b")).toBe(true);
    expect(await store.findUserInviteByTokenHash("hash-b")).toBeNull();
  });

  it("pages workflows with filters, readable ids and an id tiebreak", async () => {
    const store = ctx.store();
    for (const id of ["w-c", "w-a", "w-b", "w-d"]) await store.upsertWorkflow(workflow(id, id === "w-d" ? [] : ["Team"]));
    const all = await store.listWorkflowsPage({ limit: 10, offset: 0 });
    expect(all.total).toBe(4);
    const first = await store.listWorkflowsPage({ limit: 2, offset: 0 });
    const second = await store.listWorkflowsPage({ limit: 2, offset: 2 });
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(all.items.map((item) => item.id));
    expect(await store.listWorkflowsPage({ workflowIds: ["w-a", "w-d"], limit: 10, offset: 0 })).toMatchObject({ total: 2 });
    expect(await store.listWorkflowsPage({ workflowIds: [], limit: 10, offset: 0 })).toEqual({ items: [], total: 0 });
    const tagged = await store.listWorkflowsPage({ tag: "team", workflowIds: ["w-a", "w-b", "w-d"], limit: 1, offset: 1 });
    expect(tagged.total).toBe(2);
    expect(tagged.items).toHaveLength(1);
  });

  it("pages users newest first with a count", async () => {
    const store = ctx.store();
    for (const id of ["u1", "u2", "u3"]) await store.saveUser({ id, email: `${id}@example.com`, passwordHash: "x", role: "viewer" });
    const page = await store.listUsersPage({ limit: 2, offset: 0 });
    const rest = await store.listUsersPage({ limit: 2, offset: 2 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(new Set([...page.items, ...rest.items].map((item) => item.id))).toEqual(new Set(["u1", "u2", "u3"]));
  });
});
