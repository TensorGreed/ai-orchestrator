/**
 * Phase 13.1 — the Postgres store never loads the SQLite module (database.ts and its better-sqlite3 binding): shared
 * values live in store-shared.ts, and database.ts is imported for its types only.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./database.js", () => {
  throw new Error("The Postgres store loaded the SQLite module (database.ts).");
});

describe("Postgres store imports", () => {
  it("loads without database.ts", async () => {
    const module = await import("./postgres-store.js");
    expect(typeof module.PostgresStore.create).toBe("function");
  });

  it("store-shared.ts carries the values both stores use", async () => {
    const shared = await import("./store-shared.js");
    expect(shared.SUBJECT_EXECUTION_TRIGGERS).toEqual(["replay", "mcp_replay", "eval", "eval_judge"]);
    expect(shared.SUBJECT_CASSETTE_SOURCES).toEqual(["replay", "eval"]);
    expect(shared.normalizeMcpSamplingSettings({ allow: true, maxTokens: 0 }).allow).toBe(true);
  });
});
