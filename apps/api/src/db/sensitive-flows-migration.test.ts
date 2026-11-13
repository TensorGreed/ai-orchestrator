/**
 * v74 — a database main left at v73 (no `sensitive` column on run records or knowledge base chunks) upgrades on both
 * stores: it starts, applies v74 only, keeps its rows unmarked (no backfill), and then marks new writes. The run mark is
 * sticky across later writes of the record, the memory mark is read in the same query as the messages, and a backup
 * (db:export / db:import) keeps both marks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "./database.js";
import { MIGRATIONS } from "./migrations.js";
import type { Store } from "./store.js";
import type { Workflow } from "@ai-orchestrator/shared";
import { EXPORTED_TABLES, openBackupAdapter } from "../scripts/db-shared.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, testStorePool, type TestStore } from "../test-support/test-store.js";

const v74 = MIGRATIONS.find((migration) => migration.version === 74)!;
const TABLES = ["execution_history", "knowledge_base_chunks"] as const;
const NS = "proj:wf:agent";

async function seedOld(store: Store) {
  await store.ensureDefaultProject();
  await store.saveExecutionHistory({ id: "run-old", workflowId: "wf", status: "success", startedAt: "2026-11-01T00:00:00.000Z" });
  await store.createKnowledgeBase({ id: "kb", name: "kb", projectId: "default", embedderId: "token-embedder" });
  await store.addKnowledgeBaseChunks({ knowledgeBaseId: "kb", chunks: [{ id: "old-chunk", chunkIndex: 0, content: "old", vector: [1, 0] }] });
}

/** After the upgrade: old rows unmarked, new writes marked, the run mark sticky, chunk marks read back. */
async function expectUpgraded(store: Store) {
  expect(await store.getExecutionSensitive("run-old")).toBe(false);
  expect(await store.getExecutionSensitive("missing")).toBeNull();
  expect((await store.listKnowledgeBaseChunks("kb")).map((chunk) => [chunk.id, chunk.sensitive])).toEqual([["old-chunk", undefined]]);

  await store.saveExecutionHistory({ id: "run-new", workflowId: "wf", status: "running", startedAt: "2026-11-02T00:00:00.000Z", sensitive: true });
  expect(await store.getExecutionSensitive("run-new")).toBe(true);
  // A later write of the record without the flag (the finished run's write, a cancel) keeps the mark.
  await store.saveExecutionHistory({ id: "run-new", workflowId: "wf", status: "success", startedAt: "2026-11-02T00:00:00.000Z", completedAt: "2026-11-02T00:00:01.000Z" });
  expect(await store.getExecutionSensitive("run-new")).toBe(true);
  // A write made before the run finished counts as sensitive until the run's final write says otherwise; a write that
  // does not say keeps what is stored; a final "not sensitive" clears a pending record but never a mark.
  await store.saveExecutionHistory({ id: "run-pending", workflowId: "wf", status: "running", startedAt: "2026-11-02T00:00:00.000Z", sensitive: "pending" });
  expect(await store.getExecutionSensitive("run-pending")).toBe(true);
  await store.saveExecutionHistory({ id: "run-pending", workflowId: "wf", status: "error", startedAt: "2026-11-02T00:00:00.000Z", error: "worker failed" });
  expect(await store.getExecutionSensitive("run-pending")).toBe(true);
  await store.saveExecutionHistory({ id: "run-pending", workflowId: "wf", status: "success", startedAt: "2026-11-02T00:00:00.000Z", sensitive: false });
  expect(await store.getExecutionSensitive("run-pending")).toBe(false);
  await store.saveExecutionHistory({ id: "run-new", workflowId: "wf", status: "success", startedAt: "2026-11-02T00:00:00.000Z", sensitive: false });
  expect(await store.getExecutionSensitive("run-new")).toBe(true);
  await store.saveExecutionHistory({ id: "run-fresh", workflowId: "wf", status: "error", startedAt: "2026-11-02T00:00:00.000Z" });
  expect(await store.getExecutionSensitive("run-fresh")).toBe(false);
  // The record the API returns carries no new field.
  expect(await store.getExecutionHistory("run-new")).not.toHaveProperty("sensitive");

  await store.addKnowledgeBaseChunks({ knowledgeBaseId: "kb", chunks: [{ id: "new-chunk", chunkIndex: 1, content: "new", vector: [0, 1] }], sensitive: true });
  const chunks = new Map((await store.listKnowledgeBaseChunks("kb")).map((chunk) => [chunk.id, chunk.sensitive]));
  expect(chunks.get("new-chunk")).toBe(true);
  expect(chunks.get("old-chunk")).toBeUndefined();
  const bm25 = await store.bm25SearchKnowledgeBase({ knowledgeBaseId: "kb", query: "new", topK: 5 });
  expect(bm25.find((chunk) => chunk.id === "new-chunk")?.sensitive).toBe(true);

  // Memory and its mark in one read (train-e question 1).
  await store.saveSessionMemory(NS, "s", [{ role: "user", content: "card 4242" }], undefined, { sensitive: true });
  await store.saveSessionMemory(NS, "plain", [{ role: "user", content: "hi" }]);
  await store.saveSessionMemory(NS, "labelled", [{ role: "user", content: "x" }], { provenance: ["sensitive"], dataClasses: [], source: "propagated" });
  expect(await store.loadSessionMemoryMarked(NS, "s")).toEqual({ messages: [{ role: "user", content: "card 4242" }], sensitive: true });
  expect(await store.loadSessionMemoryMarked(NS, "plain")).toEqual({ messages: [{ role: "user", content: "hi" }], sensitive: false });
  expect(await store.loadSessionMemoryMarked(NS, "labelled")).toEqual({ messages: [{ role: "user", content: "x" }], sensitive: true });
  expect(await store.loadSessionMemoryMarked(NS, "none")).toEqual({ messages: [], sensitive: false });
}

describe("migration v74 (sensitive runs and knowledge base chunks)", () => {
  it("comes right after v73 and adds and drops the column on both tables", () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions.indexOf(74)).toBe(versions.indexOf(73) + 1);
    for (const table of TABLES) {
      expect(v74.up).toContain(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS sensitive INTEGER NOT NULL DEFAULT 0`);
      expect(v74.down).toContain(`ALTER TABLE ${table} DROP COLUMN IF EXISTS sensitive`);
    }
  });
});

describe("SQLite: a database from before v74 upgrades", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    delete process.env.DB_TYPE;
    delete process.env.DB_SQLITE_PATH;
  });

  it("gains the columns on open, keeps old rows unmarked, and marks new writes", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-v74-sqlite-"));
    const file = path.join(dir, "orchestrator.db");
    const first = await SqliteStore.create(file);
    await seedOld(first);
    await first.close();
    // The schema main left at v73: no sensitive column on these tables.
    const raw = new Database(file);
    for (const table of TABLES) raw.exec(`ALTER TABLE ${table} DROP COLUMN sensitive`);
    for (const table of TABLES) {
      expect((raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)).not.toContain("sensitive");
    }
    raw.close();

    const upgraded = await SqliteStore.create(file);
    try {
      await expectUpgraded(upgraded);
    } finally {
      await upgraded.close();
    }
  });

  it("db:export / db:import keeps the marks on run records and chunks", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-v74-backup-"));
    const source = path.join(dir, "source.db");
    const store = await SqliteStore.create(source);
    await store.ensureDefaultProject();
    await store.saveExecutionHistory({ id: "run-s", workflowId: "wf", status: "success", startedAt: "2026-11-01T00:00:00.000Z", sensitive: true });
    await store.saveExecutionHistory({ id: "run-plain", workflowId: "wf", status: "success", startedAt: "2026-11-01T00:00:00.000Z" });
    await store.createKnowledgeBase({ id: "kb", name: "kb", projectId: "default", embedderId: "token-embedder" });
    await store.addKnowledgeBaseChunks({ knowledgeBaseId: "kb", chunks: [{ id: "c-s", chunkIndex: 0, content: "a", vector: [1, 0] }], sensitive: true });
    await store.addKnowledgeBaseChunks({ knowledgeBaseId: "kb", chunks: [{ id: "c-plain", chunkIndex: 1, content: "b", vector: [0, 1] }] });
    await store.close();

    process.env.DB_TYPE = "sqlite";
    process.env.DB_SQLITE_PATH = source;
    const exporter = await openBackupAdapter();
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const table of EXPORTED_TABLES) tables[table] = await exporter.selectAll(table);
    await exporter.close();
    expect(tables.execution_history!.map((row) => [row.id, Number(row.sensitive)]).sort()).toEqual([["run-plain", 0], ["run-s", 1]]);

    const destination = path.join(dir, "dest.db");
    process.env.DB_SQLITE_PATH = destination;
    const importer = await openBackupAdapter();
    for (const table of ["projects", "execution_history", "knowledge_bases", "knowledge_base_chunks"]) {
      if (tables[table]) await importer.insertRows(table, tables[table]!);
    }
    await importer.close();
    const restored = await SqliteStore.create(destination);
    try {
      expect(await restored.getExecutionSensitive("run-s")).toBe(true);
      expect(await restored.getExecutionSensitive("run-plain")).toBe(false);
      expect(new Map((await restored.listKnowledgeBaseChunks("kb")).map((chunk) => [chunk.id, chunk.sensitive]))).toEqual(
        new Map([["c-s", true], ["c-plain", undefined]])
      );
    } finally {
      await restored.close();
    }
  });
});

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("v73 to v74 upgrade");

run("Postgres: a database at v73 upgrades to v74", () => {
  let test: TestStore | undefined;
  afterEach(async () => {
    await test?.cleanup();
    test = undefined;
  });

  it("starts, applies v74 only, keeps old rows unmarked, and marks new writes", async () => {
    test = await createTestStore({ kind: "postgres" });
    await seedOld(test.store);
    const pool = testStorePool(test);
    try {
      // The state main left: v73 applied, v74 never.
      await pool.query(v74.down);
      await pool.query(`DELETE FROM schema_migrations WHERE version > 73`);
      const before = (await pool.query<{ version: number }>(`SELECT version::int AS version FROM schema_migrations ORDER BY version`)).rows.map((row) => row.version);
      expect(before.at(-1)).toBe(73);

      const twin = await openTestStoreTwin(test);
      try {
        await expectUpgraded(twin);
      } finally {
        await twin.close();
      }
      const after = (await pool.query<{ version: number }>(`SELECT version::int AS version FROM schema_migrations ORDER BY version`)).rows.map((row) => row.version);
      expect(after).toContain(74);
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

run("Postgres: pin marks under concurrent saves (v74)", () => {
  let test: TestStore | undefined;
  afterEach(async () => {
    await test?.cleanup();
    test = undefined;
  });

  it("a save that read the workflow before another save stored a pin mark keeps that mark", async () => {
    test = await createTestStore({ kind: "postgres" });
    await test.store.ensureDefaultProject();
    const base = {
      id: "wf-pins",
      name: "Pins",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [{ id: "a", type: "manual_trigger", name: "a", position: { x: 0, y: 0 }, config: {} }],
      edges: [],
      pinnedData: { a: { answer: "card 4242" } }
    } as Workflow;
    await test.store.upsertWorkflow(base);
    const pool = testStorePool(test);
    const client = await pool.connect();
    try {
      // Another save holds the row and stores the mark; this save starts meanwhile, without the mark.
      await client.query("BEGIN");
      const locked = await client.query<{ workflow_json: string }>(`SELECT workflow_json FROM workflows WHERE id = $1 FOR UPDATE`, ["wf-pins"]);
      const marked = { ...(JSON.parse(locked.rows[0]!.workflow_json) as Workflow), pinnedDataSensitive: ["a"] };
      await client.query(`UPDATE workflows SET workflow_json = $1 WHERE id = $2`, [JSON.stringify(marked), "wf-pins"]);
      const concurrent = test.store.upsertWorkflow({ ...base, name: "Renamed" });
      // Commit only once that save waits for the row lock: it has read the workflow (without the mark) by then.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'`
        );
        if (Number(waiting.rows[0]!.n) > 0) break;
        if (Date.now() > deadline) throw new Error("the concurrent save never waited for the row lock");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await client.query("COMMIT");
      expect((await concurrent).pinnedDataSensitive).toEqual(["a"]);
    } finally {
      client.release();
      await pool.end();
    }
    const stored = await test.store.getWorkflow("wf-pins");
    expect(stored?.name).toBe("Renamed");
    expect(stored?.pinnedDataSensitive).toEqual(["a"]);
  });

  it("two first saves of a new workflow do not overwrite each other's marks", async () => {
    test = await createTestStore({ kind: "postgres" });
    await test.store.ensureDefaultProject();
    const base = { id: "wf-new", name: "New", schemaVersion: "1.0.0", workflowVersion: 1, projectId: "default", nodes: [], edges: [], pinnedData: { a: 1 } } as unknown as Workflow;
    await Promise.all([test.store.upsertWorkflow({ ...base, pinnedDataSensitive: ["a"] }), test.store.upsertWorkflow(base)]);
    expect((await test.store.getWorkflow("wf-new"))?.pinnedDataSensitive).toEqual(["a"]);
  });
});
