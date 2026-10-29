/**
 * Phase 13.1 — db:export / db:import round trip on Postgres (runs when TEST_POSTGRES_URL is set).
 *
 * v40 gives the insertion-order tables (INSERTION_SEQ_TABLES) a `seq GENERATED ALWAYS AS IDENTITY` column. A backup
 * keeps `seq`: the export reads those tables in `seq` order, the import writes `seq` back with OVERRIDING SYSTEM VALUE
 * and then moves each identity past the restored max, so the restored chain and cursor walk the same order and the
 * next insert gets max + 1. Generated columns (knowledge_base_chunks.content_tsv) are left out of the export and dropped
 * on import, so Postgres recomputes them.
 */
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { parsePostgresSettings } from "../config.js";
import { postgresStoreConfig } from "../db/create-store.js";
import { PostgresStore, postgresPoolConfig } from "../db/postgres-store.js";
import { AuthService } from "../services/auth-service.js";
import { createEmptyTestDatabase, noticePostgresSkipped, testPostgresUrl } from "../test-support/test-store.js";
import { AuditVerdictMismatch, EXPORTED_TABLES, ImportRefusal, NOT_EXPORTED_TABLES, exportDump, importDump, openBackupAdapter, type BackupDump } from "./db-shared.js";

const url = testPostgresUrl();
if (!url) noticePostgresSkipped("db:export / db:import on Postgres");

function databaseUrl(name: string): string {
  const u = new URL(url as string);
  u.pathname = `/${name}`;
  return u.toString();
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
  const savedEnv = { DB_TYPE: process.env.DB_TYPE, DB_POSTGRESDB_URL: process.env.DB_POSTGRESDB_URL };

  afterEach(() => {
    process.env.DB_TYPE = savedEnv.DB_TYPE;
    process.env.DB_POSTGRESDB_URL = savedEnv.DB_POSTGRESDB_URL;
    if (savedEnv.DB_TYPE === undefined) delete process.env.DB_TYPE;
    if (savedEnv.DB_POSTGRESDB_URL === undefined) delete process.env.DB_POSTGRESDB_URL;
  });

  /** An empty database the test migrates or restores into; dropped with the file's other test databases. */
  async function freshDatabase(): Promise<string> {
    return databaseUrl(await createEmptyTestDatabase());
  }

  it("exports every table of the Postgres schema except the listed transient ones, and restores them in foreign-key order", async () => {
    const srcUrl = await freshDatabase();
    const source = await openStore(srcUrl);
    await source.createMcpServer({ id: "mcp_one", name: "One", adapterId: "mock-mcp" });
    await source.putGuardVault({ token: "tok_1", dataClass: "email", valueHash: "h1", valueSealed: "v1.a.b.c", createdAt: "2026-03-01T00:00:00.000Z" });
    await source.close();
    const pool = new Pool(postgresPoolConfig(postgresStoreConfig(parsePostgresSettings({ DB_POSTGRESDB_URL: srcUrl })), { max: 1 }));
    const tables = (await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
    )).rows.map((row) => row.table_name);
    await pool.end();
    const exported = new Set<string>(EXPORTED_TABLES);
    expect(tables.filter((table) => !exported.has(table) && !(table in NOT_EXPORTED_TABLES))).toEqual([]);
    expect(EXPORTED_TABLES.filter((table) => !tables.includes(table))).toEqual([]);

    process.env.DB_TYPE = "postgres";
    process.env.DB_POSTGRESDB_URL = srcUrl;
    const exporter = await openBackupAdapter();
    const dump = JSON.parse(JSON.stringify(await exportDump(exporter))) as BackupDump;
    await exporter.close();
    expect(Object.keys(dump.tables).sort()).toEqual([...EXPORTED_TABLES].sort());

    const dstUrl = await freshDatabase();
    process.env.DB_POSTGRESDB_URL = dstUrl;
    const importer = await openBackupAdapter();
    await importDump(importer, dump);
    await importer.close();
    const restored = await openStore(dstUrl);
    try {
      expect((await restored.getMcpServer("mcp_one"))?.name).toBe("One");
      expect((await restored.getGuardVaultByToken("tok_1"))?.value_sealed).toBe("v1.a.b.c");
    } finally {
      await restored.close();
    }
  }, 120_000);

  it("--replace empties the destination's sessions, so everyone signs in again", async () => {
    const dstUrl = await freshDatabase();
    const dest = await openStore(dstUrl);
    const auth = new AuthService(dest, 24);
    await auth.register({ email: "ana@example.com", password: "Ana-Pass-123!", role: "admin" });
    await auth.login("ana@example.com", "Ana-Pass-123!");
    await dest.close();
    process.env.DB_TYPE = "postgres";
    process.env.DB_POSTGRESDB_URL = dstUrl;
    const importer = await openBackupAdapter();
    try {
      expect(await importer.countRows("sessions")).toBe(1);
      const lines: string[] = [];
      await importDump(importer, { format: "ai-orchestrator-backup", formatVersion: 1, schemaVersion: 1, exportedAt: "", dbType: "postgres", tables: { workflows: [] } }, { replace: true, log: (line) => lines.push(line) });
      expect(lines).toContain("  sessions: emptied (never in a backup: everyone signs in again)");
      expect(await importer.countRows("sessions")).toBe(0);
    } finally {
      await importer.close();
    }
  }, 120_000);

  it("keeps seq through export and import: same rows, same order, the chain verifies, the next insert is max + 1", async () => {
    const srcUrl = await freshDatabase();
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

    const dstUrl = await freshDatabase();
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

  it("skips generated columns (the knowledge-base tsvector) on export, and on import of a backup that carries them", async () => {
    const srcUrl = await freshDatabase();
    const source = await openStore(srcUrl);
    await source.createKnowledgeBase({ id: "kb1", name: "KB", embedderId: "mock" });
    await source.addKnowledgeBaseChunks({
      knowledgeBaseId: "kb1",
      chunks: [
        { id: "c1", chunkIndex: 0, content: "refund policy for orders", vector: [1, 0] },
        { id: "c2", chunkIndex: 1, content: "shipping times", vector: [0, 1] }
      ]
    });
    await source.close();

    process.env.DB_TYPE = "postgres";
    process.env.DB_POSTGRESDB_URL = srcUrl;
    const exporter = await openBackupAdapter();
    const kbs = await exporter.selectAll("knowledge_bases");
    const chunks = await exporter.selectAll("knowledge_base_chunks");
    await exporter.close();
    expect(chunks.map((r) => r.id)).toEqual(["c1", "c2"]);
    expect(chunks[0]).not.toHaveProperty("content_tsv");
    expect(chunks[0]).toHaveProperty("seq");

    const dstUrl = await freshDatabase();
    process.env.DB_POSTGRESDB_URL = dstUrl;
    const importer = await openBackupAdapter();
    await importer.insertRows("knowledge_bases", JSON.parse(JSON.stringify(kbs)) as Record<string, unknown>[]);
    // A backup taken before this fix carries the generated column: the import drops it and Postgres recomputes it.
    const carried = (JSON.parse(JSON.stringify(chunks)) as Record<string, unknown>[]).map((r) => ({ ...r, content_tsv: "'stale':1" }));
    await importer.insertRows("knowledge_base_chunks", carried);
    await importer.close();

    const restored = await openStore(dstUrl);
    try {
      const hits = await restored.bm25SearchKnowledgeBase({ knowledgeBaseId: "kb1", query: "refunds", topK: 5 });
      expect(hits.map((h) => h.id)).toEqual(["c1"]);
      expect((await restored.listKnowledgeBaseChunks("kb1")).map((c) => c.id)).toEqual(["c1", "c2"]);
    } finally {
      await restored.close();
    }
  }, 120_000);

  it("imports into a database that already used its identity (truncate, then restore lower seq values)", async () => {
    const srcUrl = await freshDatabase();
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

    const dstUrl = await freshDatabase();
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

  it("records the audit verdict in one snapshot, and a restore that changes it rolls back on Postgres too", async () => {
    const srcUrl = await freshDatabase();
    const source = await openStore(srcUrl);
    await source.writeAuditLog({ id: "p1", eventType: "e", category: "c", action: "a", outcome: "success", message: "approved by alice" });
    await source.writeAuditLog({ id: "p2", eventType: "e", category: "c", action: "a", outcome: "success" });
    await source.close();
    process.env.DB_TYPE = "postgres";
    process.env.DB_POSTGRESDB_URL = srcUrl;
    const exporter = await openBackupAdapter();
    const dump = JSON.parse(JSON.stringify(await exportDump(exporter))) as BackupDump;
    await exporter.close();
    expect(dump.auditVerdict).toEqual({ ok: true, rowsChecked: 2, unverifiable: [] });

    const dstUrl = await freshDatabase();
    const dest = await openStore(dstUrl);
    await dest.writeAuditLog({ id: "kept", eventType: "e", category: "c", action: "a", outcome: "success" });
    await dest.close();
    process.env.DB_POSTGRESDB_URL = dstUrl;
    const tampered = JSON.parse(JSON.stringify(dump)) as BackupDump;
    tampered.tables.audit_logs![0]!.message = "approved by mallory";
    let importer = await openBackupAdapter();
    // The destination holds a row, so it takes --replace (a plain import refuses it, below).
    expect(await importDump(importer, tampered).then(() => undefined, (e: unknown) => e as Error)).toBeInstanceOf(ImportRefusal);
    const error = await importDump(importer, tampered, { replace: true }).then(() => undefined, (e: unknown) => e as Error);
    await importer.close();
    expect(error).toBeInstanceOf(AuditVerdictMismatch);
    expect(error!.message).toContain("row p1 (position 1) would be broken on the restored database");
    expect((await auditOrder(dstUrl)).map((r) => r.id)).toEqual(["kept"]);

    importer = await openBackupAdapter();
    const report = await importDump(importer, dump, { replace: true });
    await importer.close();
    expect(report.audit?.restored).toEqual({ ok: true, rowsChecked: 2 });
    expect((await auditOrder(dstUrl)).map((r) => r.id)).toEqual(["p1", "p2"]);
  }, 120_000);

  it("--merge into an empty audit log refuses a changed verdict; --allow-audit-change restores it with a warning", async () => {
    const srcUrl = await freshDatabase();
    const source = await openStore(srcUrl);
    await source.writeAuditLog({ id: "m1", eventType: "e", category: "c", action: "a", outcome: "success" });
    await source.writeAuditLog({ id: "m2", eventType: "e", category: "c", action: "a", outcome: "success" });
    await source.close();
    process.env.DB_TYPE = "postgres";
    process.env.DB_POSTGRESDB_URL = srcUrl;
    const exporter = await openBackupAdapter();
    const dump = JSON.parse(JSON.stringify(await exportDump(exporter))) as BackupDump;
    await exporter.close();
    dump.tables.audit_logs![0]!.message = "approved by mallory";

    const dstUrl = await freshDatabase();
    await (await openStore(dstUrl)).close();
    process.env.DB_POSTGRESDB_URL = dstUrl;
    let importer = await openBackupAdapter();
    const error = await importDump(importer, dump, { merge: true }).then(() => undefined, (e: unknown) => e as Error);
    await importer.close();
    expect(error).toBeInstanceOf(AuditVerdictMismatch);
    expect(await auditOrder(dstUrl)).toEqual([]);

    importer = await openBackupAdapter();
    const report = await importDump(importer, dump, { merge: true, allowAuditChange: true });
    await importer.close();
    expect(report.audit?.changedWarning).toMatch(/^WARNING: .*before \(backup\) intact \(2 rows verified\), after \(restored\) broken at row m1/);
    expect((await auditOrder(dstUrl)).map((r) => r.id)).toEqual(["m1", "m2"]);
  }, 120_000);

  it("a failing later table in --merge rolls back the earlier tables too", async () => {
    const srcUrl = await freshDatabase();
    const source = await openStore(srcUrl);
    await source.upsertWorkflow({ id: "wf-new", name: "New", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);
    await source.writeAuditLog({ id: "r1", eventType: "e", category: "c", action: "a", outcome: "success" });
    await source.close();
    process.env.DB_TYPE = "postgres";
    process.env.DB_POSTGRESDB_URL = srcUrl;
    const exporter = await openBackupAdapter();
    const dump = JSON.parse(JSON.stringify(await exportDump(exporter))) as BackupDump;
    await exporter.close();

    const dstUrl = await freshDatabase();
    const dest = await openStore(dstUrl);
    await dest.writeAuditLog({ id: "before", eventType: "e", category: "c", action: "a", outcome: "success" });
    await dest.close();
    // workflows (first table) inserts cleanly; audit_logs then hits the destination's existing "before" id.
    dump.tables.audit_logs![0]!.id = "before";
    dump.tables.audit_logs![0]!.seq = 1000;
    process.env.DB_POSTGRESDB_URL = dstUrl;
    const importer = await openBackupAdapter();
    const error = await importDump(importer, dump, { merge: true }).then(() => undefined, (e: unknown) => e as Error);
    await importer.close();
    expect(error?.message).toMatch(/Failed to insert into audit_logs/);
    const pool = new Pool(postgresPoolConfig(postgresStoreConfig(parsePostgresSettings({ DB_POSTGRESDB_URL: dstUrl })), { max: 1 }));
    try {
      expect((await pool.query(`SELECT id FROM workflows`)).rows).toEqual([]);
    } finally {
      await pool.end();
    }
    expect((await auditOrder(dstUrl)).map((r) => r.id)).toEqual(["before"]);
  }, 120_000);
});
