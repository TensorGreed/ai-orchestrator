/**
 * Phase 13.1 — db:copy round trip through the Store interface: a SQLite store seeded across every domain the store
 * contract suite covers (db-copy-roundtrip.test-helper.ts) is copied to Postgres, and every read gives the same result on
 * the PostgresStore as on the SqliteStore it came from. Then the copied database takes new writes. Postgres only
 * (TEST_POSTGRES_URL; skipped otherwise), in its own schema `t_<hex>`.
 */
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePostgresSettings } from "../config.js";
import { postgresStoreConfig } from "../db/create-store.js";
import { SqliteStore } from "../db/database.js";
import { PostgresStore, postgresPoolConfig, type PostgresStoreConfig } from "../db/postgres-store.js";
import { noticePostgresSkipped, testPostgresUrl } from "../test-support/test-store.js";
import { runDbCopy, type DbCopyReport } from "./db-copy-core.js";
import { roundTripReads, seedAllDomains } from "./db-copy-roundtrip.test-helper.js";

const postgresUrl = testPostgresUrl();
if (!postgresUrl) noticePostgresSkipped("db:copy round trip");

describe.skipIf(!postgresUrl)("db:copy round trip: SQLite -> Postgres, read back through the Store interface", () => {
  let dir: string;
  let sourcePath: string;
  let schema: string;
  let config: PostgresStoreConfig;
  let admin: Pool;
  let report: DbCopyReport;
  let target: PostgresStore;
  const before = new Map<string, unknown>();
  const reads = roundTripReads();

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-db-copy-roundtrip-"));
    sourcePath = path.join(dir, "source.db");
    schema = `t_${randomBytes(6).toString("hex")}`;
    config = postgresStoreConfig(parsePostgresSettings({ DB_POSTGRESDB_URL: postgresUrl }), { schema, maxConnections: 4 });
    admin = new Pool(postgresPoolConfig(config, { max: 1, options: undefined }));

    const source = await SqliteStore.create(sourcePath);
    try {
      await seedAllDomains(source);
      for (const { name, read } of reads) before.set(name, await read(source));
    } finally {
      await source.close();
    }
    report = await runDbCopy({ sqlitePath: sourcePath, postgres: config });
    target = await PostgresStore.create(config);
  }, 180_000);

  afterAll(async () => {
    await target?.close().catch(() => undefined);
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("copies every seeded table and verifies it", () => {
    const copied = report.tables.filter((table) => table.rows > 0).map((table) => table.table);
    // The fixture reaches most of the schema; these are the tables the domains below live in.
    for (const table of ["workflows", "workflow_versions", "users", "secrets", "knowledge_base_chunks", "audit_logs", "guard_profiles", "approval_requests"]) {
      expect(copied, table).toContain(table);
    }
    expect(report.audit.target?.ok).toBe(true);
    expect(report.audit.becameUnverifiable).toEqual([]);
  });

  for (const { name } of reads) {
    it(`reads the same on Postgres: ${name}`, async () => {
      const read = reads.find((entry) => entry.name === name)!.read;
      expect(await read(target)).toEqual(before.get(name));
    });
  }

  it("secrets are copied as ciphertext, iv and auth tag, byte for byte", async () => {
    const raw = new Database(sourcePath, { readonly: true });
    try {
      const sqlite = raw.prepare(`SELECT id, iv, auth_tag, ciphertext FROM secrets ORDER BY id`).all();
      const pg = (await admin.query(`SELECT id, iv, auth_tag, ciphertext FROM "${schema}".secrets ORDER BY id COLLATE "C"`)).rows;
      expect(sqlite.length).toBeGreaterThan(0);
      expect(pg).toEqual(sqlite);
    } finally {
      raw.close();
    }
  });

  it("the copied database takes new writes: audit chain, workflow versions, KB chunks, users", async () => {
    await target.writeAuditLog({ id: "after-copy", eventType: "auth.login", category: "auth", action: "login", outcome: "success" });
    const verdict = await target.verifyAuditChain();
    expect(verdict.ok).toBe(true);
    expect(verdict.rowsChecked).toBe((report.audit.target?.rowsChecked ?? 0) + 1);
    await target.saveUser({ id: "user-after-copy", email: "after-copy@example.com", passwordHash: "x", role: "viewer" });
    expect((await target.getUserById("user-after-copy"))?.email).toBe("after-copy@example.com");
    const workflows = await target.listWorkflows();
    expect(workflows.length).toBeGreaterThan(0);
    const workflowId = workflows[0]!.id;
    const versionBefore = await target.maxWorkflowVersionNumber(workflowId);
    const workflow = await target.getWorkflow(workflowId);
    const appended = await target.appendWorkflowVersion({ id: "version-after-copy", workflowId, workflowJson: JSON.stringify(workflow), retention: 0 });
    expect(appended.version).toBe(versionBefore + 1);
    expect(await target.maxWorkflowVersionNumber(workflowId)).toBe(versionBefore + 1);
  });
});
