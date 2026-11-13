/**
 * v72 — a database that main left at v71 (gateway label marks, no run trace id) upgrades to v72 on both stores. v70 is
 * retired: no migration defines it, so a Postgres database that recorded v71 without v70 has no gap to refuse.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "./database.js";
import { MIGRATIONS, missingMigrationVersions, rollbackMigrations } from "./migrations.js";
import { RETIRED_MIGRATION_VERSIONS } from "./migration-versions.test-helper.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, testStorePool, type TestStore } from "../test-support/test-store.js";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const v72 = MIGRATIONS.find((migration) => migration.version === 72)!;

describe("migration v72 (run trace id)", () => {
  it("comes after v71, adds execution_history.trace_id, and no migration uses a retired version", () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions.indexOf(72)).toBe(versions.indexOf(71) + 1);
    expect(v72.up).toContain("ALTER TABLE execution_history ADD COLUMN IF NOT EXISTS trace_id TEXT");
    expect(v72.down).toContain("ALTER TABLE execution_history DROP COLUMN IF EXISTS trace_id");
    for (const retired of RETIRED_MIGRATION_VERSIONS) expect(versions).not.toContain(retired);
    // A database at v71 without v70 has nothing missing.
    const atMain = versions.filter((version) => version <= 71);
    expect(missingMigrationVersions(atMain)).toEqual([]);
  });
});

describe("rolling back past the retired v70", () => {
  it("records the next defined version below, never 70", async () => {
    let current = 72;
    const recorded: number[] = [];
    const result = await rollbackMigrations(
      async () => undefined,
      async () => current,
      async (version) => {
        recorded.push(version);
        current = version;
      },
      70
    );
    expect(result.rolledBack).toEqual([72, 71]);
    expect(recorded).toEqual([71, 69]);
  });
});

describe("SQLite: a database from before v72 upgrades", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("gains trace_id on open and keeps its runs", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-v72-sqlite-"));
    const file = path.join(dir, "orchestrator.db");
    const first = await SqliteStore.create(file);
    await first.saveExecutionHistory({ id: "run-old", workflowId: "wf", status: "success", startedAt: new Date().toISOString() });
    await first.close();
    // The schema main left: v71's table, no trace_id column.
    const raw = new Database(file);
    raw.exec("ALTER TABLE execution_history DROP COLUMN trace_id");
    expect((raw.prepare("PRAGMA table_info(execution_history)").all() as Array<{ name: string }>).map((row) => row.name)).not.toContain("trace_id");
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_gateway_label_marks'").get()).toBeTruthy();
    raw.close();

    const upgraded = await SqliteStore.create(file);
    try {
      expect((await upgraded.getExecutionHistory("run-old"))?.traceId ?? null).toBeNull();
      expect(await upgraded.setExecutionTraceId("run-old", TRACE_ID)).toBe(true);
      expect((await upgraded.getExecutionHistory("run-old"))?.traceId).toBe(TRACE_ID);
    } finally {
      await upgraded.close();
    }
  });
});

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("v71 to v72 upgrade");

run("Postgres: a database at v71 upgrades to v72", () => {
  let test: TestStore | undefined;
  afterEach(async () => {
    await test?.cleanup();
    test = undefined;
  });

  it("starts, applies v72 only, and records no v70", async () => {
    test = await createTestStore({ kind: "postgres" });
    await test.store.saveExecutionHistory({ id: "run-old", workflowId: "wf", status: "success", startedAt: new Date().toISOString() });
    const pool = testStorePool(test);
    try {
      // The state main left: v71 applied, v72 never.
      await pool.query(v72.down);
      await pool.query(`DELETE FROM schema_migrations WHERE version > 71`);
      const before = (await pool.query<{ version: number }>(`SELECT version::int AS version FROM schema_migrations ORDER BY version`)).rows.map((row) => row.version);
      expect(before.at(-1)).toBe(71);
      expect(before).not.toContain(70);

      const twin = await openTestStoreTwin(test);
      try {
        expect(await twin.setExecutionTraceId("run-old", TRACE_ID)).toBe(true);
        expect((await twin.getExecutionHistory("run-old"))?.traceId).toBe(TRACE_ID);
      } finally {
        await twin.close();
      }
      const after = (await pool.query<{ version: number }>(`SELECT version::int AS version FROM schema_migrations ORDER BY version`)).rows.map((row) => row.version);
      expect(after.at(-1)).toBe(72);
      expect(after).not.toContain(70);
      const column = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'execution_history' AND column_name = 'trace_id'`);
      expect(column.rows).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });
});
