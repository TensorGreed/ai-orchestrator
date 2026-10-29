/**
 * Phase 13.1 — the Postgres boot check for a migration that merged below a version a database already recorded: the
 * forward-only chain would skip it for good, so the store refuses to start and names it. A contiguous database that is
 * behind still migrates as before. SQLite re-runs its idempotent migrate() on every start, so it has no such gap.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, MigrationGapError, missingMigrationVersions } from "./migrations.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, testStorePool, type TestStore } from "../test-support/test-store.js";

const versions = MIGRATIONS.map((migration) => migration.version).sort((a, b) => a - b);
const highest = versions.at(-1)!;
const belowHighest = versions.at(-2)!;

describe("missingMigrationVersions", () => {
  it("finds versions defined below the highest applied one that were never applied", () => {
    expect(missingMigrationVersions([1, 2, 3, 5], [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }])).toEqual([4]);
    expect(missingMigrationVersions([1, 2, 5], [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }])).toEqual([3, 4]);
  });

  it("passes contiguous, empty, behind and ahead databases, and versions this build never defined", () => {
    const defined = [{ version: 1 }, { version: 2 }, { version: 4 }];
    expect(missingMigrationVersions([], defined)).toEqual([]);
    expect(missingMigrationVersions([1], defined)).toEqual([]);
    expect(missingMigrationVersions([1, 2, 4], defined)).toEqual([]);
    // 3 is not defined here (a version another build used): nothing to apply.
    expect(missingMigrationVersions([1, 2, 3, 4, 9], defined)).toEqual([]);
  });

  it("the error names the missing versions and how to fix them", () => {
    const error = new MigrationGapError([43], 44);
    expect(error.message).toContain("at v44 but never applied v43");
    expect(error.message).toContain("schema_migrations");
    expect(error.message).toContain("apps/api/src/db/migrations.ts");
  });
});

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("migration gap check at start");

run("Postgres start with a migration gap", () => {
  let test: TestStore | undefined;

  afterEach(async () => {
    await test?.cleanup();
    test = undefined;
  });

  async function sql(text: string, params: unknown[] = []): Promise<void> {
    const pool = testStorePool(test!);
    try {
      await pool.query(text, params);
    } finally {
      await pool.end();
    }
  }

  it("refuses to start when a version below the highest applied one is missing, naming it", async () => {
    test = await createTestStore({ kind: "postgres" });
    await sql(`DELETE FROM schema_migrations WHERE version = $1`, [belowHighest]);
    const opened = openTestStoreTwin(test);
    await expect(opened).rejects.toBeInstanceOf(MigrationGapError);
    await expect(opened).rejects.toThrow(`never applied v${belowHighest}`);
  });

  it("a contiguous database that is behind migrates forward as before", async () => {
    test = await createTestStore({ kind: "postgres" });
    await sql(`DELETE FROM schema_migrations WHERE version = $1`, [highest]);
    const twin = await openTestStoreTwin(test);
    await twin.close();
    const pool = testStorePool(test);
    try {
      const rows = (await pool.query<{ version: number }>(`SELECT MAX(version)::int AS version FROM schema_migrations`)).rows;
      expect(rows[0]!.version).toBe(highest);
    } finally {
      await pool.end();
    }
  });

  it("a database at the cluster signalling migration (shared flow state rolled back) starts and gains its tables", async () => {
    test = await createTestStore({ kind: "postgres" });
    const flowState = MIGRATIONS.find((migration) => migration.description.includes("shared auth and per-user flow state"))!;
    expect(flowState).toBeDefined();
    await sql(flowState.down);
    await sql(`DELETE FROM schema_migrations WHERE version >= $1`, [flowState.version]);
    const twin = await openTestStoreTwin(test);
    await twin.close();
    const pool = testStorePool(test);
    try {
      const tables = (await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()
            AND table_name IN ('pending_challenges', 'rate_limit_buckets', 'capture_reservations') ORDER BY table_name`
      )).rows.map((row) => row.table_name);
      expect(tables).toEqual(["capture_reservations", "pending_challenges", "rate_limit_buckets"]);
      const unlogged = (await pool.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema() AND c.relpersistence = 'u' AND c.relkind = 'r' ORDER BY c.relname`
      )).rows.map((row) => row.relname);
      expect(unlogged).toEqual(["capture_reservations", "rate_limit_buckets"]);
      const holder = (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'mcp_elicitations' AND column_name = 'holder_id'`)).rows;
      expect(holder).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });
});
