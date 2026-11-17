/**
 * v76 — the retention purge's `redactions` step: expired redaction maps go with every purge, whatever the cutoff, and
 * maps still in their lifetime stay.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTestStore, type TestStore } from "../test-support/test-store.js";
import { redactionStep } from "./retention-service.js";

const opened: TestStore[] = [];
afterEach(async () => {
  for (const test of opened.splice(0)) await test.cleanup().catch(() => undefined);
});

describe("retention: redaction maps", () => {
  it("deletes expired maps up to the limit, reports a cap, and shows the longest lifetime as its days", async () => {
    const test = await createTestStore({ kind: "sqlite" });
    opened.push(test);
    const { store } = test;
    const put = (id: string, expiresAt: string) =>
      store.putContentRedaction({
        id, scope: "gateway", clientId: "mcpc_1", toolsetId: "mts_1", projectId: "default", executionId: "mcpgw_1",
        entriesSealed: "v1.sealed", entryCount: 1, classes: ["email"], createdAt: "2026-11-17T09:00:00.000Z", updatedAt: "2026-11-17T09:00:00.000Z", expiresAt
      });
    await put("red_old1", "2026-11-17T09:30:00.000Z");
    await put("red_old2", "2026-11-17T09:40:00.000Z");
    await put("red_old3", "2026-11-17T09:50:00.000Z");
    await put("red_live", "2026-11-18T09:00:00.000Z");
    const step = redactionStep(store, 172_800, () => new Date("2026-11-17T10:00:00.000Z"));
    expect(step.class).toBe("redactions");
    expect(step.days()).toBe(2);
    expect(await step.run({ before: "2026-11-15T10:00:00.000Z", limit: 2 })).toEqual({ deleted: 2, capped: true });
    expect(await step.run({ before: "2026-11-15T10:00:00.000Z", limit: 2 })).toEqual({ deleted: 1, capped: false });
    expect((await store.listContentRedactions({ afterId: null, limit: 10, now: "2026-11-17T10:00:00.000Z" })).map((row) => row.id)).toEqual(["red_live"]);
  });
});
