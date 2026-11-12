import type { McpToolClassificationOverride } from "@ai-orchestrator/shared";
import { describe, expect, it } from "vitest";
import { createReadOnlyMarkLookup } from "./mcp-tool-policy.js";

const mark = (registryServerId: string, toolName: string, readOnly: boolean): McpToolClassificationOverride =>
  ({ registryServerId, toolName, readOnly, setBy: "admin@example.com", updatedAt: "2026-11-12T00:00:00.000Z" }) as McpToolClassificationOverride;

describe("read-only marks for the safe re-issue rule", () => {
  it("reads a server's marks once per ttl, and again after invalidate or expiry", async () => {
    let now = 0;
    const rows = [mark("s1", "write_row", true), mark("s1", "lookup", false)];
    const loads: string[] = [];
    const marks = createReadOnlyMarkLookup(
      async (serverId) => {
        loads.push(serverId);
        return rows.filter((row) => row.registryServerId === serverId);
      },
      { ttlMs: 1000, now: () => now }
    );
    expect(await marks.lookup("s1", "write_row")).toBe(true);
    expect(await marks.lookup("s1", "lookup")).toBe(false);
    expect(await marks.lookup("s1", "other")).toBeNull();
    expect(loads).toEqual(["s1"]);

    rows[0] = mark("s1", "write_row", false);
    expect(await marks.lookup("s1", "write_row")).toBe(true);
    marks.invalidate("s1");
    expect(await marks.lookup("s1", "write_row")).toBe(false);
    now = 1500;
    await marks.lookup("s1", "write_row");
    expect(loads).toEqual(["s1", "s1", "s1"]);
  });

  it("does not keep a failed read", async () => {
    let fail = true;
    const marks = createReadOnlyMarkLookup(async () => {
      if (fail) throw new Error("store down");
      return [mark("s1", "t", true)];
    });
    await expect(marks.lookup("s1", "t")).rejects.toThrow("store down");
    fail = false;
    expect(await marks.lookup("s1", "t")).toBe(true);
  });
});
