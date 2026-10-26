/**
 * Phase 13.1 — db:export / db:import round trip on Postgres (runs when TEST_POSTGRES_URL is set).
 *
 * v40 gives the insertion-order tables (INSERTION_SEQ_TABLES) a `seq GENERATED ALWAYS AS IDENTITY` column. A backup
 * keeps `seq`: the export reads those tables in `seq` order, the import writes `seq` back with OVERRIDING SYSTEM VALUE
 * and then moves each identity past the restored max, so the restored chain and cursor walk the same order and the
 * next insert gets max + 1.
 */
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { parsePostgresSettings } from "../config.js";
import { postgresStoreConfig } from "../db/create-store.js";
import { PostgresStore, postgresPoolConfig } from "../db/postgres-store.js";
import { noticePostgresSkipped, testPostgresUrl } from "../test-support/test-store.js";
import { EXPORTED_TABLES, openBackupAdapter } from "./db-shared.js";

const url = testPostgresUrl();
if (!url) noticePostgresSkipped("db:export / db:import on Postgres");

function databaseUrl(name: string): string {
  const u = new URL(url as string);
  u.pathname = `/${name}`;
  return u.toString();
}

function adminPool(): Pool {
  return new Pool({ connectionString: url, max: 1 });
}

async function openStore(dbUrl: string): Promise<PostgresStore> {
  return PostgresStore.create(postgresStoreConfig(parsePostgresSettings({ DB_POSTGRESDB_URL: dbUrl }), { maxConnections: 2 }));
}

async function auditOrder(dbUrl: string): Promise<Array<{ id: string; seq: string }>> {
  const pool = new Pool(postgresPoolConfig(postgresStoreConfig(parsePostgresSettings({ DB_POSTGRESDB_URL: dbUrl })), { max: 1 }));
  try {
    const r = await pool.query<{ id: string; seq: string }>(`SELECT id, seq::text AS seq FROM audit_logs ORDER BY seq`);
    return r.rows;
  } finally {
    await pool.end();
  }
}

describe.skipIf(!url)("db:export / db:import round trip [postgres]", () => {
  const created: string[] = [];
  const savedEnv = { DB_TYPE: process.env.DB_TYPE, DB_POSTGRESDB_URL: process.env.DB_POSTGRESDB_URL };

  afterEach(async () => {
    process.env.DB_TYPE = savedEnv.DB_TYPE;
    process.env.DB_POSTGRESDB_URL = savedEnv.DB_POSTGRESDB_URL;
    if (savedEnv.DB_TYPE === undefined) delete process.env.DB_TYPE;
    if (savedEnv.DB_POSTGRESDB_URL === undefined) delete process.env.DB_POSTGRESDB_URL;
    const pool = adminPool();
    try {
      for (const name of created.splice(0)) await pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await pool.end();
    }
  }, 60_000);

  async function freshDatabase(label: string): Promise<string> {
    const name = `q3a_backup_${label}_${randomBytes(4).toString("hex")}`;
    const pool = adminPool();
    try {
      await pool.query(`CREATE DATABASE "${name}"`);
    } finally {
      await pool.end();
    }
    created.push(name);
    return databaseUrl(name);
  }

  it("keeps seq through export and import: same rows, same order, the chain verifies, the next insert is max + 1", async () => {
    const srcUrl = await freshDatabase("src");
    const source = await openStore(srcUrl);
    // Ids sort opposite to insertion and every row has the same created_at, so only seq gives the order.
    for (let i = 0; i < 6; i += 1) {
      await source.writeAuditLog({
        id: `z${9 - i}`, eventType: "auth.login", category: "auth", action: "login", outcome: "success",
        createdAt: "2026-03-01T00:00:00.000Z", message: `row ${i}`
      });
    }
    await source.close();
    // Move the first row to the end of the heap, so a plain SELECT * would return it last.
    const srcPool = new Pool(postgresPoolConfig(postgresStoreConfig(parsePostgresSettings({ DB_POSTGRESDB_URL: srcUrl })), { max: 1 }));
    await srcPool.query(`UPDATE audit_logs SET prev_hash = prev_hash WHERE id = 'z9'`);
    await srcPool.end();
    const before = await auditOrder(srcUrl);
    expect(before.map((r) => r.id)).toEqual(["z9", "z8", "z7", "z6", "z5", "z4"]);

    process.env.DB_TYPE = "postgres";
    process.env.DB_POSTGRESDB_URL = srcUrl;
    const exporter = await openBackupAdapter();
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const table of EXPORTED_TABLES) tables[table] = await exporter.selectAll(table);
    await exporter.close();
    expect(tables.audit_logs.map((r) => r.id)).toEqual(["z9", "z8", "z7", "z6", "z5", "z4"]);
    const dump = JSON.parse(JSON.stringify({ tables })) as { tables: Record<string, Record<string, unknown>[]> };

    const dstUrl = await freshDatabase("dst");
    process.env.DB_POSTGRESDB_URL = dstUrl;
    const importer = await openBackupAdapter();
    for (const table of [...EXPORTED_TABLES].reverse()) await importer.truncate(table);
    for (const table of EXPORTED_TABLES) {
      const rows = dump.tables[table];
      if (rows.length > 0) await importer.insertRows(table, rows);
    }
    await importer.close();

    expect(await auditOrder(dstUrl)).toEqual(before);
    const restored = await openStore(dstUrl);
    try {
      expect(await restored.verifyAuditChain()).toMatchObject({ ok: true, rowsChecked: 6 });
      await restored.writeAuditLog({ id: "a-next", eventType: "auth.login", category: "auth", action: "login", outcome: "success" });
      expect(await restored.verifyAuditChain()).toMatchObject({ ok: true, rowsChecked: 7 });
    } finally {
      await restored.close();
    }
    const after = await auditOrder(dstUrl);
    const maxBefore = Math.max(...before.map((r) => Number(r.seq)));
    expect(after.at(-1)).toEqual({ id: "a-next", seq: String(maxBefore + 1) });
  }, 120_000);

  it("imports into a database that already used its identity (truncate, then restore lower seq values)", async () => {
    const srcUrl = await freshDatabase("src");
    const source = await openStore(srcUrl);
    for (let i = 0; i < 3; i += 1) {
      await source.writeAuditLog({ id: `s${i}`, eventType: "e", category: "c", action: "a", outcome: "success" });
    }
    await source.close();
    process.env.DB_TYPE = "postgres";
    process.env.DB_POSTGRESDB_URL = srcUrl;
    const exporter = await openBackupAdapter();
    const rows = await exporter.selectAll("audit_logs");
    await exporter.close();

    const dstUrl = await freshDatabase("dst");
    const dest = await openStore(dstUrl);
    for (let i = 0; i < 10; i += 1) {
      await dest.writeAuditLog({ id: `old${i}`, eventType: "e", category: "c", action: "a", outcome: "success" });
    }
    await dest.close();
    process.env.DB_POSTGRESDB_URL = dstUrl;
    const importer = await openBackupAdapter();
    await importer.truncate("audit_logs");
    await importer.insertRows("audit_logs", JSON.parse(JSON.stringify(rows)) as Record<string, unknown>[]);
    await importer.close();

    const restored = await openStore(dstUrl);
    try {
      await restored.writeAuditLog({ id: "s-next", eventType: "e", category: "c", action: "a", outcome: "success" });
      expect(await restored.verifyAuditChain()).toMatchObject({ ok: true, rowsChecked: 4 });
    } finally {
      await restored.close();
    }
    expect((await auditOrder(dstUrl)).map((r) => `${r.id}:${r.seq}`)).toEqual(["s0:1", "s1:2", "s2:3", "s-next:4"]);
  }, 120_000);
});
