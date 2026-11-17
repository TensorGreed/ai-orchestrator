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
