/**
 * Phase 13.1 — the one-running-simulation unique index (v39) is recognised on both stores, and only that index:
 * `isOneRunningSimulationViolation` matches SQLite's SQLITE_CONSTRAINT_UNIQUE on guard_simulations.status and
 * Postgres's 23505 on idx_guard_simulations_one_running, and nothing else (a duplicate id is a different violation).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, type TestStore, testStorePool } from "../test-support/test-store.js";
import { isOneRunningSimulationViolation } from "./store-errors.js";

const row = (id: string, status: string) => ({
  id,
  profileId: "p",
  sourceKind: "inline" as const,
  sourceVersion: null,
  simulatedHash: "h",
  baseVersion: null,
  jobIds: [],
  detail: { workflows: [] },
  status,
  createdAt: new Date().toISOString(),
  createdBy: "a@example.com",
  createdByUserId: null
});

const caught = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the write to be refused");
};

let current: TestStore | undefined;
afterEach(async () => {
  await current?.cleanup();
  current = undefined;
});

describe("one running guard simulation [sqlite]", () => {
  it("a second running row is that violation; a duplicate id and a second finished row are not", async () => {
    current = await createTestStore({ kind: "sqlite" });
    const { store } = current;
    await store.insertGuardSimulation(row("a", "running"));
    expect(isOneRunningSimulationViolation(await caught(() => store.insertGuardSimulation(row("b", "running"))))).toBe(true);
    expect(isOneRunningSimulationViolation(await caught(() => store.insertGuardSimulation(row("a", "completed"))))).toBe(false);
    await store.insertGuardSimulation(row("c", "completed"));
    await store.insertGuardSimulation(row("d", "completed"));
    expect(isOneRunningSimulationViolation(new Error("UNIQUE constraint failed: guard_simulations.status"))).toBe(false);
    expect(isOneRunningSimulationViolation(undefined)).toBe(false);
  });
});

const postgres = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("one running guard simulation");

postgres("one running guard simulation [postgres]", () => {
  it("a second running row is that violation; a duplicate id and a second finished row are not", async () => {
    // The rows go in with plain SQL on the migrated schema, so the index itself (not the store method) is tested.
    current = await createTestStore({ kind: "postgres" });
    const pool = testStorePool(current!);
    try {
      const insert = (id: string, status: string) =>
        pool.query(
          `INSERT INTO guard_simulations (id, profile_id, source_kind, simulated_hash, job_ids_json, status, created_at, created_by)
           VALUES ($1, 'p', 'inline', 'h', '[]', $2, now(), 'a@example.com')`,
          [id, status]
        );
      await insert("a", "running");
      expect(isOneRunningSimulationViolation(await caught(() => insert("b", "running")))).toBe(true);
      expect(isOneRunningSimulationViolation(await caught(() => insert("a", "completed")))).toBe(false);
      await insert("c", "completed");
      await insert("d", "completed");
      expect(isOneRunningSimulationViolation(Object.assign(new Error("duplicate key"), { code: "23505", constraint: "guard_simulations_pkey" }))).toBe(false);
    } finally {
      await pool.end();
    }
  }, 60_000);
});
