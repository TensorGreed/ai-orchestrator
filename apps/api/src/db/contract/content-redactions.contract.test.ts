/**
 * v76 — store contract: content redaction maps (sealed elsewhere; the store keeps text) and the content rules toolset
 * member, on both stores.
 */
import { expect, it } from "vitest";
import type { ContentRedactionRecord } from "../content-redaction-store.js";
import { describeStoreContract } from "../../test-support/test-store.js";

const NOW = "2026-11-17T10:00:00.000Z";
const LATER = "2026-11-17T11:00:00.000Z";
const PAST = "2026-11-17T09:00:00.000Z";

function record(overrides: Partial<ContentRedactionRecord> = {}): ContentRedactionRecord {
  return {
    id: "red_aaaaaaaaaaaaaaaaaaaaaaaa",
    scope: "gateway",
    clientId: "mcpc_1",
    toolsetId: "mts_1",
    projectId: "default",
    executionId: "mcpgw_1",
    entriesSealed: "v1.sealed",
    entryCount: 2,
    classes: ["phone", "email", "email"],
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: LATER,
    ...overrides
  };
}

describeStoreContract("store contract: content redaction maps", (ctx) => {
  it("stores a map, replaces its contents under the same id, and never returns it once expired", async () => {
    const store = ctx.store();
    await store.putContentRedaction(record({ expiresAt: "2026-11-17T12:00:00.000Z" }));
    expect(await store.getContentRedaction("red_aaaaaaaaaaaaaaaaaaaaaaaa", NOW)).toMatchObject({
      scope: "gateway",
      clientId: "mcpc_1",
      toolsetId: "mts_1",
      projectId: "default",
      entriesSealed: "v1.sealed",
      entryCount: 2,
      classes: ["email", "phone"],
      expiresAt: "2026-11-17T12:00:00.000Z"
    });
    await store.putContentRedaction(record({ entriesSealed: "v1.other", entryCount: 3, clientId: "mcpc_2", updatedAt: LATER, expiresAt: "2026-11-17T13:00:00.000Z" }));
    const replaced = await store.getContentRedaction("red_aaaaaaaaaaaaaaaaaaaaaaaa", LATER);
    // The owner columns stay as first written.
    expect(replaced).toMatchObject({ entriesSealed: "v1.other", entryCount: 3, clientId: "mcpc_1", createdAt: NOW, expiresAt: "2026-11-17T13:00:00.000Z" });
    expect(await store.getContentRedaction("red_aaaaaaaaaaaaaaaaaaaaaaaa", "2026-11-17T13:00:00.000Z")).toBeNull();
    expect(await store.getContentRedaction("red_missing", NOW)).toBeNull();
  });

  it("sweeps expired maps, on demand and on every write", async () => {
    const store = ctx.store();
    await store.putContentRedaction(record({ id: "red_old_aaaaaaaaaaaaaaaaaa", createdAt: PAST, updatedAt: PAST, expiresAt: NOW }));
    await store.putContentRedaction(record({ id: "run:exec-1", scope: "run", clientId: null, toolsetId: null, executionId: "exec-1", createdAt: PAST, updatedAt: PAST, expiresAt: LATER }));
    expect(await store.deleteExpiredContentRedactions("2026-11-17T10:30:00.000Z")).toBe(1);
    expect((await store.getContentRedaction("run:exec-1", "2026-11-17T10:30:00.000Z"))?.scope).toBe("run");
    // A write at 11:30 sweeps the run book that ended at 11:00.
    await store.putContentRedaction(record({ id: "red_new_aaaaaaaaaaaaaaaaaa", updatedAt: "2026-11-17T11:30:00.000Z", expiresAt: "2026-11-17T13:00:00.000Z" }));
    expect(await store.deleteExpiredContentRedactions("2026-11-17T11:30:00.000Z")).toBe(0);
    expect((await store.getContentRedaction("red_new_aaaaaaaaaaaaaaaaaa", "2026-11-17T11:30:00.000Z"))?.scope).toBe("gateway");
  });

  it("pages through unexpired maps in id order and deletes one by id", async () => {
    const store = ctx.store();
    for (const id of ["red_c", "red_a", "red_b"]) await store.putContentRedaction(record({ id }));
    await store.putContentRedaction(record({ id: "red_0", expiresAt: NOW }));
    const first = await store.listContentRedactions({ afterId: null, limit: 2, now: NOW });
    expect(first.map((row) => row.id)).toEqual(["red_a", "red_b"]);
    expect((await store.listContentRedactions({ afterId: "red_b", limit: 2, now: NOW })).map((row) => row.id)).toEqual(["red_c"]);
    expect(await store.deleteContentRedaction("red_b")).toBe(true);
    expect(await store.deleteContentRedaction("red_b")).toBe(false);
    expect((await store.listContentRedactions({ afterId: null, limit: 10, now: NOW })).map((row) => row.id)).toEqual(["red_a", "red_c"]);
  });

  it("writes conditionally on the version: one insert wins, a stale update loses, an expired or deleted row never comes back", async () => {
    const store = ctx.store();
    const run = record({ id: "run:exec-9", scope: "run", clientId: null, toolsetId: null, executionId: "exec-9" });
    const first = (await store.writeContentRedactionIfVersion(run, null))!;
    expect(first).toBeGreaterThanOrEqual(1);
    expect(await store.writeContentRedactionIfVersion({ ...run, entriesSealed: "v1.second" }, null)).toBeNull();
    expect(await store.writeContentRedactionIfVersion({ ...run, entriesSealed: "v1.two" }, first)).toBe(first + 1);
    expect(await store.writeContentRedactionIfVersion({ ...run, entriesSealed: "v1.stale" }, first)).toBeNull();
    expect(await store.getContentRedaction("run:exec-9", NOW)).toMatchObject({ entriesSealed: "v1.two", version: first + 1 });
    // Deleted, then written again by another writer: a writer still holding the old version never matches the new row.
    expect(await store.deleteContentRedaction("run:exec-9")).toBe(true);
    const replaced = (await store.writeContentRedactionIfVersion({ ...run, entriesSealed: "v1.new-book" }, null))!;
    expect(replaced).not.toBe(first + 1);
    expect(await store.writeContentRedactionIfVersion({ ...run, entriesSealed: "v1.old-book" }, first + 1)).toBeNull();
    expect((await store.getContentRedaction("run:exec-9", NOW))?.entriesSealed).toBe("v1.new-book");
    const later = "2026-11-17T12:00:00.000Z";
    const fresh = await store.writeContentRedactionIfVersion({ ...run, entriesSealed: "v1.fresh", updatedAt: later, expiresAt: "2026-11-17T13:00:00.000Z" }, null);
    expect(fresh).not.toBeNull();
    expect((await store.getContentRedaction("run:exec-9", later))?.entriesSealed).toBe("v1.fresh");
  });

  it("keeps a content rules toolset member with its rule set", async () => {
    const store = ctx.store();
    const toolset = await store.createMcpToolset({
      id: "mts_privacy",
      slug: "privacy",
      name: "Privacy",
      description: null,
      projectId: null,
      enabled: true,
      trackSessionLabels: false,
      rateLimit: null,
      members: [{ kind: "content_rules", ruleSetId: "pii" }],
      createdBy: null
    });
    expect((await store.getMcpToolset(toolset.id))?.members).toEqual([expect.objectContaining({ kind: "content_rules", ruleSetId: "pii" })]);
  });
});
