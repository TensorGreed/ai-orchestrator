/**
 * v73 — a database main left at v72 (no `sensitive` column on session rows) upgrades on both stores: it starts, applies
 * v73 only, keeps its rows unmarked, and then marks new writes. A backup (db:export / db:import) keeps the mark.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "./database.js";
import { MIGRATIONS } from "./migrations.js";
import { EXPORTED_TABLES, openBackupAdapter } from "../scripts/db-shared.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, testStorePool, type TestStore } from "../test-support/test-store.js";

const v73 = MIGRATIONS.find((migration) => migration.version === 73)!;
const TABLES = ["session_memory", "session_tool_cache", "session_artifacts"] as const;
const NS = "proj:wf:agent";

describe("migration v73 (sensitive session rows)", () => {
  it("comes right after v72 and adds and drops the column on the three session tables", () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions.indexOf(73)).toBe(versions.indexOf(72) + 1);
    for (const table of TABLES) {
      expect(v73.up).toContain(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS sensitive INTEGER NOT NULL DEFAULT 0`);
      expect(v73.down).toContain(`ALTER TABLE ${table} DROP COLUMN IF EXISTS sensitive`);
    }
  });
});

describe("SQLite: a database from before v73 upgrades", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    delete process.env.DB_TYPE;
    delete process.env.DB_SQLITE_PATH;
  });

  it("gains the column on open, keeps old rows unmarked (their labels still count), and marks new writes", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-v73-sqlite-"));
    const file = path.join(dir, "orchestrator.db");
    const first = await SqliteStore.create(file);
    await first.saveSessionMemory(NS, "old", [{ role: "user", content: "kept" }]);
    await first.saveSessionMemory(NS, "old-labelled", [{ role: "user", content: "x" }], { provenance: ["sensitive"], dataClasses: [], source: "propagated" });
    await first.saveSessionToolCall({ namespace: NS, sessionId: "old", toolName: "t", args: {}, output: 1 });
    await first.saveSessionArtifact({ namespace: NS, sessionId: "old", artifactKey: "a", value: 1 });
    await first.close();
    // The schema main left at v72: no sensitive column.
    const raw = new Database(file);
    for (const table of TABLES) raw.exec(`ALTER TABLE ${table} DROP COLUMN sensitive`);
    for (const table of TABLES) {
      expect((raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)).not.toContain("sensitive");
    }
    raw.close();

    const upgraded = await SqliteStore.create(file);
    try {
      expect(await upgraded.loadSessionMemory(NS, "old")).toEqual([{ role: "user", content: "kept" }]);
      expect(await upgraded.loadSessionMemorySensitive(NS, "old")).toBe(false);
      expect(await upgraded.loadSessionMemorySensitive(NS, "old-labelled")).toBe(true);
      expect((await upgraded.listSessionToolCalls({ namespace: NS, sessionId: "old" }))[0]).not.toHaveProperty("sensitive");
      expect(await upgraded.loadSessionArtifact({ namespace: NS, sessionId: "old", artifactKey: "a" })).not.toHaveProperty("sensitive");
      await upgraded.saveSessionMemory(NS, "old", [{ role: "user", content: "new" }], undefined, { sensitive: true });
      expect(await upgraded.loadSessionMemorySensitive(NS, "old")).toBe(true);
    } finally {
      await upgraded.close();
    }
  });

  it("db:export / db:import keeps the mark on memory and artifacts (the tool cache is not exported)", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-v73-backup-"));
    const source = path.join(dir, "source.db");
    const store = await SqliteStore.create(source);
    await store.saveSessionMemory(NS, "s", [{ role: "user", content: "card 4242" }], undefined, { sensitive: true });
    await store.saveSessionMemory(NS, "plain", [{ role: "user", content: "hi" }]);
    await store.saveSessionArtifact({ namespace: NS, sessionId: "s", artifactKey: "a", value: 1, sensitive: true });
    await store.close();

    process.env.DB_TYPE = "sqlite";
    process.env.DB_SQLITE_PATH = source;
    const exporter = await openBackupAdapter();
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const table of EXPORTED_TABLES) tables[table] = await exporter.selectAll(table);
    await exporter.close();
    expect(EXPORTED_TABLES).not.toContain("session_tool_cache");
    expect(tables.session_memory!.map((row) => [row.session_id, Number(row.sensitive)]).sort()).toEqual([["plain", 0], ["s", 1]]);

    const destination = path.join(dir, "dest.db");
    process.env.DB_SQLITE_PATH = destination;
    const importer = await openBackupAdapter();
    for (const table of ["session_memory", "session_artifacts"]) await importer.insertRows(table, tables[table]!);
    await importer.close();
    const restored = await SqliteStore.create(destination);
    try {
      expect(await restored.loadSessionMemorySensitive(NS, "s")).toBe(true);
      expect(await restored.loadSessionMemorySensitive(NS, "plain")).toBe(false);
      expect((await restored.loadSessionArtifact({ namespace: NS, sessionId: "s", artifactKey: "a" }))?.sensitive).toBe(true);
    } finally {
      await restored.close();
    }
  });
});

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("v72 to v73 upgrade");

run("Postgres: a database at v72 upgrades to v73", () => {
  let test: TestStore | undefined;
  afterEach(async () => {
    await test?.cleanup();
    test = undefined;
  });

  it("starts, applies v73 only, keeps old rows unmarked, and marks new writes", async () => {
    test = await createTestStore({ kind: "postgres" });
    await test.store.saveSessionMemory(NS, "old", [{ role: "user", content: "kept" }]);
    await test.store.saveSessionToolCall({ namespace: NS, sessionId: "old", toolName: "t", args: {}, output: 1 });
    await test.store.saveSessionArtifact({ namespace: NS, sessionId: "old", artifactKey: "a", value: 1 });
    const pool = testStorePool(test);
    try {
      // The state main left: v72 applied, v73 never.
      await pool.query(v73.down);
      await pool.query(`DELETE FROM schema_migrations WHERE version > 72`);
      const before = (await pool.query<{ version: number }>(`SELECT version::int AS version FROM schema_migrations ORDER BY version`)).rows.map((row) => row.version);
      expect(before.at(-1)).toBe(72);

      const twin = await openTestStoreTwin(test);
      try {
        expect(await twin.loadSessionMemory(NS, "old")).toEqual([{ role: "user", content: "kept" }]);
        expect(await twin.loadSessionMemorySensitive(NS, "old")).toBe(false);
        expect((await twin.listSessionToolCalls({ namespace: NS, sessionId: "old" }))[0]).not.toHaveProperty("sensitive");
        expect(await twin.loadSessionArtifact({ namespace: NS, sessionId: "old", artifactKey: "a" })).not.toHaveProperty("sensitive");
        await twin.saveSessionMemory(NS, "old", [{ role: "user", content: "new" }], undefined, { sensitive: true });
        expect(await twin.loadSessionMemorySensitive(NS, "old")).toBe(true);
        expect((await twin.saveSessionToolCall({ namespace: NS, sessionId: "old", toolName: "t", args: {}, output: 2, sensitive: true })).sensitive).toBe(true);
      } finally {
        await twin.close();
      }
      const after = (await pool.query<{ version: number }>(`SELECT version::int AS version FROM schema_migrations ORDER BY version`)).rows.map((row) => row.version);
      expect(after).toContain(73);
      expect(after.at(-1)).toBe(Math.max(...MIGRATIONS.map((migration) => migration.version)));
      for (const table of TABLES) {
        const column = await pool.query(
          `SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'sensitive'`,
          [table]
        );
        expect(column.rows, table).toEqual([{ data_type: "integer", is_nullable: "NO", column_default: "0" }]);
      }
    } finally {
      await pool.end();
    }
  });
});
