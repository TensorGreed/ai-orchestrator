/**
 * Phase 13.1 — store contract: guard profiles, versions, the revision counter, bindings, events, stats and the token
 * vault. The same assertions run on SQLite and, with TEST_POSTGRES_URL, on Postgres.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";
import type { GuardEventInsert } from "../database.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function profileInput(id: string, overrides: Partial<{ name: string; builtIn: boolean; document: Record<string, unknown>; hash: string }> = {}) {
  return {
    id,
    name: overrides.name ?? `Profile ${id}`,
    description: null,
    builtIn: overrides.builtIn ?? false,
    document: overrides.document ?? { id, name: overrides.name ?? `Profile ${id}` },
    hash: overrides.hash ?? `hash-${id}-1`,
    note: "first",
    createdBy: "admin@example.com"
  };
}

function event(id: string, overrides: Partial<GuardEventInsert> = {}): GuardEventInsert {
  return {
    id,
    verdictId: `v-${id}`,
    executionId: "exec-1",
    workflowId: "wf-1",
    projectId: "default",
    nodeId: "agent",
    placement: "pre_tool",
    iteration: 1,
    toolName: "search",
    channel: "tool_args",
    detectorId: "email",
    category: "pii",
    dataClass: "email",
    score: 0.75,
    requestedAction: "mask",
    effectiveAction: "mask",
    verdictAction: "mask",
    shadow: false,
    evidence: [{ spans: [{ start: 1, end: 4 }], message: "an email" }] as GuardEventInsert["evidence"],
    profileId: "default",
    profileVersion: 1,
    profileHash: "h1",
    latencyMs: 1.5,
    budgetExceeded: false,
    skippedDetectors: ["slow"],
    createdAt: "2026-10-01T10:00:00.000Z",
    ...overrides
  };
}

describeStoreContract("store contract: guard", (ctx) => {
  it("creates a profile with version 1, reads it back, lists built-in first then by name ignoring case", async () => {
    const store = ctx.store();
    const created = await store.insertGuardProfile(profileInput("zeta", { name: "zeta" }));
    expect(created).toMatchObject({ id: "zeta", name: "zeta", description: null, builtIn: false, latestVersion: 1, latestHash: "hash-zeta-1", createdBy: "admin@example.com", updatedBy: "admin@example.com" });
    expect(created.createdAt).toMatch(ISO);
    await store.insertGuardProfile(profileInput("alpha", { name: "Alpha" }));
    await store.insertGuardProfile(profileInput("builtin", { name: "Zzz default", builtIn: true }));
    await store.insertGuardProfile(profileInput("beta", { name: "beta" }));
    expect((await store.listGuardProfiles()).map((p) => p.id)).toEqual(["builtin", "alpha", "beta", "zeta"]);
    expect(await store.getGuardProfile("missing")).toBeNull();
    const version = await store.getGuardProfileVersion("zeta");
    expect(version).toMatchObject({ profileId: "zeta", version: 1, hash: "hash-zeta-1", document: { id: "zeta", name: "zeta" }, note: "first", createdBy: "admin@example.com" });
    expect(version?.createdAt).toMatch(ISO);
    await expect(store.insertGuardProfile(profileInput("zeta"))).rejects.toThrow();
    expect((await store.listGuardProfileVersions("zeta")).length).toBe(1);
  });

  it("appends versions, moves the latest, keeps old versions; delete removes profile and versions once", async () => {
    const store = ctx.store();
    await store.insertGuardProfile(profileInput("p"));
    const v2 = await store.addGuardProfileVersion({ profileId: "p", name: "Renamed", description: "d", document: { v: 2 }, hash: "h2", note: null, createdBy: "b@example.com" });
    expect(v2).toMatchObject({ profileId: "p", version: 2, hash: "h2", document: { v: 2 }, note: null, createdBy: "b@example.com" });
    const v3 = await store.addGuardProfileVersion({ profileId: "p", name: "Renamed", document: { v: 3 }, hash: "h3", createdBy: null });
    expect(v3.version).toBe(3);
    expect(await store.getGuardProfile("p")).toMatchObject({ name: "Renamed", description: null, latestVersion: 3, latestHash: "h3", updatedBy: null });
    expect((await store.getGuardProfileVersion("p"))?.version).toBe(3);
    expect((await store.getGuardProfileVersion("p", 1))?.hash).toBe("hash-p-1");
    expect(await store.getGuardProfileVersion("p", 9)).toBeNull();
    expect((await store.listGuardProfileVersions("p")).map((v) => v.version)).toEqual([3, 2, 1]);
    await expect(store.addGuardProfileVersion({ profileId: "nope", name: "x", document: {}, hash: "x", createdBy: null })).rejects.toThrow(/not found/);
    expect(await store.deleteGuardProfile("p")).toBe(true);
    expect(await store.deleteGuardProfile("p")).toBe(false);
    expect(await store.getGuardProfile("p")).toBeNull();
    expect(await store.listGuardProfileVersions("p")).toEqual([]);
  });

  it("the revision counter moves on every profile or version write and not on reads", async () => {
    const store = ctx.store();
    const start = await store.guardProfileRevision();
    expect(typeof start).toBe("number");
    await store.insertGuardProfile(profileInput("p"));
    const afterInsert = (await store.guardProfileRevision())!;
    expect(afterInsert).toBeGreaterThan(start!);
    await store.listGuardProfiles();
    await store.getGuardProfileVersion("p");
    expect(await store.guardProfileRevision()).toBe(afterInsert);
    await store.addGuardProfileVersion({ profileId: "p", name: "p", document: {}, hash: "h2", createdBy: null });
    const afterVersion = (await store.guardProfileRevision())!;
    expect(afterVersion).toBeGreaterThan(afterInsert);
    await store.deleteGuardProfile("p");
    expect(await store.guardProfileRevision()).toBeGreaterThan(afterVersion);
  });

  it("anyGuardProfileUsesLabels reads the stored JSON: propagated labels, destination rules or an egress channel", async () => {
    const store = ctx.store();
    await store.insertGuardProfile(profileInput("plain", { document: { labels: "off", destinations: { rules: [] }, channels: { egress: null } } }));
    expect(await store.anyGuardProfileUsesLabels()).toBe(false);
    await store.addGuardProfileVersion({ profileId: "plain", name: "plain", document: { destinations: { rules: [{ id: "r" }] } }, hash: "h2", createdBy: null });
    expect(await store.anyGuardProfileUsesLabels()).toBe(true);
    await store.deleteGuardProfile("plain");
    expect(await store.anyGuardProfileUsesLabels()).toBe(false);
    await store.insertGuardProfile(profileInput("egress", { document: { channels: { egress: { mode: "block" } } } }));
    expect(await store.anyGuardProfileUsesLabels()).toBe(true);
    await store.deleteGuardProfile("egress");
    await store.insertGuardProfile(profileInput("labels", { document: { name: "x", labels: "propagated" } }));
    expect(await store.anyGuardProfileUsesLabels()).toBe(true);
  });

  it("bindings upsert by scope and id, and list by profile in scope then id order", async () => {
    const store = ctx.store();
    expect(await store.getGuardBinding("project", "default")).toBeNull();
    const first = await store.setGuardBinding({ scope: "project", scopeId: "default", mode: "enforced", profileId: "p", updatedBy: "a" });
    expect(first).toMatchObject({ scope: "project", scopeId: "default", mode: "enforced", profileId: "p", updatedBy: "a" });
    expect(first.updatedAt).toMatch(ISO);
    const second = await store.setGuardBinding({ scope: "project", scopeId: "default", mode: "inherit", profileId: null, updatedBy: null });
    expect(second).toMatchObject({ mode: "inherit", profileId: null, updatedBy: null });
    await store.setGuardBinding({ scope: "workflow", scopeId: "wf-b", mode: "override", profileId: "q", updatedBy: null });
    await store.setGuardBinding({ scope: "workflow", scopeId: "wf-a", mode: "override", profileId: "q", updatedBy: null });
    await store.setGuardBinding({ scope: "project", scopeId: "proj", mode: "override", profileId: "q", updatedBy: null });
    expect((await store.listGuardBindingsForProfile("q")).map((b) => `${b.scope}:${b.scopeId}`)).toEqual(["project:proj", "workflow:wf-a", "workflow:wf-b"]);
    expect(await store.listGuardBindingsForProfile("p")).toEqual([]);
  });

  it("events round-trip, list newest first with filters, totals and pagination; per execution oldest first", async () => {
    const store = ctx.store();
    await store.insertGuardEvents([]);
    await store.insertGuardEvents([
      event("e1", { createdAt: "2026-10-01T10:00:00.000Z" }),
      event("e2", { createdAt: "2026-10-01T11:00:00.000Z", detectorId: null, category: null, dataClass: null, score: null, iteration: null, toolName: null, channel: "output" }),
      event("e3", { createdAt: "2026-10-02T09:00:00.000Z", executionId: "exec-2", workflowId: "wf-2", shadow: true, effectiveAction: "block", budgetExceeded: true })
    ]);
    const listed = await store.listGuardEvents();
    expect(listed.total).toBe(3);
    expect(listed.events.map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
    expect(listed.events[2]).toEqual(event("e1"));
    expect(listed.events[1]).toMatchObject({ detectorId: null, category: null, score: null, iteration: null, toolName: null });
    expect(listed.events[0]).toMatchObject({ shadow: true, budgetExceeded: true });
    expect((await store.listGuardEvents({ executionId: "exec-1" })).events.map((e) => e.id)).toEqual(["e2", "e1"]);
    expect((await store.listGuardEvents({ workflowIds: [] })).total).toBe(0);
    expect((await store.listGuardEvents({ workflowIds: ["wf-2"] })).events.map((e) => e.id)).toEqual(["e3"]);
    expect((await store.listGuardEvents({ onlyFindings: true })).total).toBe(2);
    expect((await store.listGuardEvents({ since: "2026-10-01T10:30:00.000Z" })).total).toBe(2);
    expect((await store.listGuardEvents({ action: "block", channel: "tool_args" })).events.map((e) => e.id)).toEqual(["e3"]);
    const page = await store.listGuardEvents({ limit: 1, offset: 1 });
    expect(page).toMatchObject({ total: 3 });
    expect(page.events.map((e) => e.id)).toEqual(["e2"]);
    expect((await store.listGuardEventsForExecution("exec-1")).map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(await store.listGuardEventsForExecution("none")).toEqual([]);
  });

  it("stats group by verdict, action, category, channel and day; shadow and budget counts per verdict", async () => {
    const store = ctx.store();
    await store.insertGuardEvents([
      event("a1", { verdictId: "va", createdAt: "2026-10-01T10:00:00.000Z" }),
      event("a2", { verdictId: "va", detectorId: "phone", category: "pii", createdAt: "2026-10-01T10:00:00.000Z" }),
      event("b1", { verdictId: "vb", verdictAction: "block", effectiveAction: "block", shadow: true, category: "secret", detectorId: "key", createdAt: "2026-10-02T23:59:59.000Z" }),
      event("c1", { verdictId: "vc", verdictAction: "allow", effectiveAction: "allow", detectorId: null, category: null, budgetExceeded: true, channel: "output", createdAt: "2026-10-02T00:00:00.000Z" })
    ]);
    const stats = await store.guardEventStats();
    const byKey = (rows: Array<{ key: string; count: number }>) => Object.fromEntries(rows.map((row) => [row.key, row.count]));
    expect(byKey(stats.verdicts)).toEqual({ mask: 1, block: 1, allow: 1 });
    expect(byKey(stats.actions)).toEqual({ mask: 2, block: 1 });
    expect(stats.categories[0]).toEqual({ key: "pii", count: 2 });
    expect(byKey(stats.categories)).toEqual({ pii: 2, secret: 1 });
    expect(byKey(stats.channels)).toEqual({ tool_args: 2, output: 1 });
    expect(byKey(stats.detectors)).toEqual({ email: 1, phone: 1, key: 1 });
    expect(stats).toMatchObject({ shadowWouldBlock: 1, shadowFindings: 1, budgetExceeded: 1 });
    expect(stats.daily).toEqual(
      expect.arrayContaining([
        { day: "2026-10-01", action: "mask", count: 1 },
        { day: "2026-10-02", action: "block", count: 1 },
        { day: "2026-10-02", action: "allow", count: 1 }
      ])
    );
    expect(stats.daily.map((row) => row.day)).toEqual([...stats.daily.map((row) => row.day)].sort());
    expect(stats.daily).toHaveLength(3);
    const scoped = await store.guardEventStats({ channel: "output" });
    expect(scoped).toMatchObject({ shadowWouldBlock: 0, shadowFindings: 0, budgetExceeded: 1, actions: [], detectors: [] });
  });

  it("counts observed destination blocks once per verdict, since a time, leaving replays and evals out", async () => {
    const store = ctx.store();
    const block = (id: string, overrides: Partial<GuardEventInsert> = {}) =>
      event(id, { detectorId: "<destinations>", shadow: true, effectiveAction: "block", profileId: "p", createdAt: "2026-10-05T00:00:00.000Z", ...overrides });
    await store.saveExecutionHistory({ id: "replay-run", workflowId: "wf-1", status: "success", startedAt: "2026-10-05T00:00:00.000Z", triggerType: "replay" });
    await store.saveExecutionHistory({ id: "live-run", workflowId: "wf-1", status: "success", startedAt: "2026-10-05T00:00:00.000Z", triggerType: "manual" });
    await store.insertGuardEvents([
      block("x1", { verdictId: "v1", executionId: "live-run" }),
      block("x2", { verdictId: "v1", executionId: "live-run", effectiveAction: "review" }),
      block("x3", { verdictId: "v2", executionId: "no-history", effectiveAction: "require_approval" }),
      block("x4", { verdictId: "v3", executionId: "replay-run" }),
      block("x5", { verdictId: "v4", executionId: "live-run", shadow: false }),
      block("x6", { verdictId: "v5", executionId: "live-run", effectiveAction: "mask" }),
      block("x7", { verdictId: "v6", executionId: "live-run", createdAt: "2026-09-01T00:00:00.000Z" }),
      block("x8", { verdictId: "v7", executionId: "live-run", profileId: "other" })
    ]);
    expect(await store.countObservedDestinationBlocks("p", "2026-10-01T00:00:00.000Z")).toBe(2);
    expect(await store.countObservedDestinationBlocks("p", "2026-08-01T00:00:00.000Z")).toBe(3);
    expect(await store.countObservedDestinationBlocks("none", "2026-01-01T00:00:00.000Z")).toBe(0);
  });

  it("the vault stores a token once: a second insert of the same token or value hash keeps the first", async () => {
    const store = ctx.store();
    expect(await store.getGuardVaultByToken("tok")).toBeNull();
    await store.putGuardVault({ token: "tok", dataClass: "email", valueHash: "vh", valueSealed: "sealed-1", createdAt: "2026-10-01T00:00:00.000Z" });
    await store.putGuardVault({ token: "tok", dataClass: "email", valueHash: "vh2", valueSealed: "sealed-2", createdAt: "2026-10-01T00:00:00.000Z" });
    await store.putGuardVault({ token: "tok-2", dataClass: "email", valueHash: "vh", valueSealed: "sealed-3", createdAt: "2026-10-01T00:00:00.000Z" });
    await store.putGuardVault({ token: "random", dataClass: "phone", valueHash: null, valueSealed: "sealed-4", createdAt: "2026-10-01T00:00:00.000Z" });
    expect(await store.getGuardVaultByToken("tok")).toEqual({ token: "tok", data_class: "email", value_hash: "vh", value_sealed: "sealed-1", created_at: "2026-10-01T00:00:00.000Z" });
    expect(await store.getGuardVaultByToken("tok-2")).toBeNull();
    expect((await store.getGuardVaultByHash("vh"))?.token).toBe("tok");
    expect(await store.getGuardVaultByToken("random")).toMatchObject({ value_hash: null, value_sealed: "sealed-4" });
    expect(await store.getGuardVaultByHash("missing")).toBeNull();
  });
});
