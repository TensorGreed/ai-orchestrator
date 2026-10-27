/**
 * End-to-end test for db:export / db:import + master-key re-encryption.
 *
 * Driven against SQLite because it doesn't need a live Postgres. The shared
 * adapter abstracts over both stores, so this exercises everything except
 * the Postgres-specific INSERT batching (covered separately by integration
 * tests that need a real Postgres).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { SqliteStore } from "../db/database.js";
import { appendLegacySqliteAuditRow, bomAuditEntry, sqliteAuditBytes, wtf8 } from "./legacy-audit.test-helper.js";
import { SecretService } from "../services/secret-service.js";
import {
  AuditVerdictMismatch,
  EXPORTED_TABLES,
  ENCRYPTED_COLUMNS,
  exportDump,
  importDump,
  openBackupAdapter,
  type BackupDump,
  type ImportOptions
} from "./db-shared.js";

const KEY_A = crypto.randomBytes(32).toString("base64");
const KEY_B = crypto.randomBytes(32).toString("base64");

function tempPath(label: string): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), `aio-backup-${label}-`)),
    "db.sqlite"
  );
}

describe("db:export / db:import round trip", () => {
  let dbPath: string;
  let backupPath: string;

  beforeEach(() => {
    dbPath = tempPath("source");
    backupPath = path.join(path.dirname(dbPath), "backup.json");
    process.env.DB_TYPE = "sqlite";
    process.env.DB_SQLITE_PATH = dbPath;
  });

  afterEach(() => {
    delete process.env.DB_TYPE;
    delete process.env.DB_SQLITE_PATH;
    delete process.env.SECRET_MASTER_KEY_BASE64;
    try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("exports and imports a workflow + secret round-trip with the same master key", async () => {
    process.env.SECRET_MASTER_KEY_BASE64 = KEY_A;
    const sourceStore = await SqliteStore.create(dbPath);
    const secrets = new SecretService(sourceStore, KEY_A);

    await sourceStore.upsertWorkflow({
      id: "wf-1",
      name: "Hello",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [],
      edges: []
    } as never);
    const stored = await secrets.createSecret({ name: "OPENAI_KEY", provider: "openai", value: "sk-test-12345" });
    await sourceStore.close();

    // ---- Export ----
    const exporter = await openBackupAdapter();
    const dump = {
      format: "ai-orchestrator-backup",
      formatVersion: 1,
      schemaVersion: await exporter.schemaVersion(),
      exportedAt: new Date().toISOString(),
      dbType: exporter.kind,
      tables: {} as Record<string, Record<string, unknown>[]>
    };
    for (const table of EXPORTED_TABLES) {
      try { dump.tables[table] = await exporter.selectAll(table); } catch { dump.tables[table] = []; }
    }
    await exporter.close();
    fs.writeFileSync(backupPath, JSON.stringify(dump));

    expect(dump.tables.workflows).toHaveLength(1);
    expect(dump.tables.secrets).toHaveLength(1);
    expect(dump.tables.secrets[0].id).toBe(stored.secretId);

    // ---- Import into a fresh DB, same master key ----
    const destPath = tempPath("dest");
    process.env.DB_SQLITE_PATH = destPath;

    const dest = await openBackupAdapter();
    for (const table of [...EXPORTED_TABLES].reverse()) {
      try { await dest.truncate(table); } catch { /* ignore */ }
    }
    for (const table of EXPORTED_TABLES) {
      const rows = dump.tables[table];
      if (rows.length > 0) await dest.insertRows(table, rows);
    }
    await dest.close();

    const restoredStore = await SqliteStore.create(destPath);
    const restoredSecrets = new SecretService(restoredStore, KEY_A);
    const list = await restoredSecrets.listSecrets();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("OPENAI_KEY");
    const revealed = await restoredSecrets.resolveSecret({ secretId: stored.secretId });
    expect(revealed).toBe("sk-test-12345");
    await restoredStore.close();
    try { fs.rmSync(path.dirname(destPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("re-encrypts secrets when the destination master key differs", async () => {
    process.env.SECRET_MASTER_KEY_BASE64 = KEY_A;
    const sourceStore = await SqliteStore.create(dbPath);
    const sourceSecrets = new SecretService(sourceStore, KEY_A);
    const stored = await sourceSecrets.createSecret({ name: "STRIPE_KEY", provider: "openai-compatible", value: "sk-live-rotateme" });
    await sourceStore.close();

    const exporter = await openBackupAdapter();
    const exportedSecrets = await exporter.selectAll("secrets");
    await exporter.close();
    expect(exportedSecrets).toHaveLength(1);

    // Re-encrypt the row in memory the way db:import would.
    const cols = ENCRYPTED_COLUMNS.secrets;
    const sourceKey = Buffer.from(KEY_A, "base64");
    const destKey = Buffer.from(KEY_B, "base64");

    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      sourceKey,
      Buffer.from(String(exportedSecrets[0][cols.iv]), "base64")
    );
    decipher.setAuthTag(Buffer.from(String(exportedSecrets[0][cols.authTag]), "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(String(exportedSecrets[0][cols.ciphertext]), "base64")),
      decipher.final()
    ]);
    expect(plaintext.toString("utf8")).toBe("sk-live-rotateme");

    const newIv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", destKey, newIv);
    const newCiphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const newAuthTag = cipher.getAuthTag();
    const reencryptedRow = {
      ...exportedSecrets[0],
      [cols.iv]: newIv.toString("base64"),
      [cols.authTag]: newAuthTag.toString("base64"),
      [cols.ciphertext]: newCiphertext.toString("base64")
    };

    // Restore into a fresh DB under KEY_B and verify SecretService can reveal.
    const destPath = tempPath("dest");
    process.env.DB_SQLITE_PATH = destPath;
    process.env.SECRET_MASTER_KEY_BASE64 = KEY_B;

    const dest = await openBackupAdapter();
    await dest.truncate("secrets");
    await dest.insertRows("secrets", [reencryptedRow]);
    await dest.close();

    const restoredStore = await SqliteStore.create(destPath);
    const restoredSecrets = new SecretService(restoredStore, KEY_B);
    const revealed = await restoredSecrets.resolveSecret({ secretId: stored.secretId });
    expect(revealed).toBe("sk-live-rotateme");
    await restoredStore.close();
    try { fs.rmSync(path.dirname(destPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("a Node-20 lone-surrogate audit row (stored as generalized UTF-8) survives export -> JSON -> import and still verifies", async () => {
    const sourceStore = await SqliteStore.create(dbPath);
    await sourceStore.writeAuditLog({ id: "a1", eventType: "auth.login", category: "auth", action: "login", outcome: "success" });
    await sourceStore.close();
    const raw = new Database(dbPath);
    appendLegacySqliteAuditRow(raw, "legacy-surrogate", { message: "tag \ud800 here" });
    appendLegacySqliteAuditRow(raw, "legacy-nul", { userAgent: "agent\u0000x" });
    const stored = raw.prepare(`SELECT hex(message) AS h FROM audit_logs WHERE id = 'legacy-surrogate'`).get() as { h: string };
    expect(stored.h).toContain("EDA080");
    raw.close();
    const reopened = await SqliteStore.create(dbPath);
    await reopened.writeAuditLog({ id: "a2", eventType: "auth.logout", category: "auth", action: "logout", outcome: "success" });
    expect(await reopened.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 4 });
    await reopened.close();

    const exporter = await openBackupAdapter();
    const audit = await exporter.selectAll("audit_logs");
    await exporter.close();
    expect(audit.map((row) => row.id)).toEqual(["a1", "legacy-surrogate", "legacy-nul", "a2"]);
    // Read exactly: the surrogate itself (three U+FFFD through the driver), which JSON keeps as its escape.
    expect(audit[1]!.message).toBe("tag \ud800 here");
    const file = JSON.stringify({ audit });
    expect(file).toContain("tag \\ud800 here");

    const destPath = tempPath("dest-legacy");
    process.env.DB_SQLITE_PATH = destPath;
    const dest = await openBackupAdapter();
    await dest.insertRows("audit_logs", (JSON.parse(file) as { audit: Record<string, unknown>[] }).audit);
    await dest.close();
    const restored = await SqliteStore.create(destPath);
    try {
      // Node 20 stores the surrogate exactly again; Node 24 stores U+FFFD, which the single-U+FFFD search explains.
      expect(await restored.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 4 });
    } finally {
      await restored.close();
      fs.rmSync(path.dirname(destPath), { recursive: true, force: true });
    }
  });
  it("audit rows whose every text field starts with U+FEFF survive export -> JSON -> import byte for byte and still verify", async () => {
    const sourceStore = await SqliteStore.create(dbPath);
    await sourceStore.writeAuditLog({ id: "a1", eventType: "auth.login", category: "auth", action: "login", outcome: "success" });
    await sourceStore.writeAuditLog(bomAuditEntry("bom-plain"));
    // With a U+FFFD in the row, the text is taken from the stored bytes (the exact reader): U+FEFF must survive that too.
    await sourceStore.writeAuditLog(bomAuditEntry("bom-real-fffd", "\ufeffreal \ufffd"));
    await sourceStore.writeAuditLog(bomAuditEntry("bom-surrogate", "\ufeffx \ud800"));
    expect(await sourceStore.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 4 });
    await sourceStore.close();
    const sourceRaw = new Database(dbPath, { readonly: true });
    const sourceBytes = sqliteAuditBytes(sourceRaw);
    sourceRaw.close();
    expect(sourceBytes[2]!.resource_id).toBe(Buffer.from("\ufeffwf-1").toString("hex").toUpperCase());

    const exporter = await openBackupAdapter();
    const audit = await exporter.selectAll("audit_logs");
    await exporter.close();
    expect(audit.slice(1).every((row) => String(row.id).startsWith("\ufeff") && String(row.resource_id).startsWith("\ufeff"))).toBe(true);
    expect(audit[2]!.message).toBe("\ufeffreal \ufffd");
    const file = JSON.stringify({ audit });

    const destPath = tempPath("dest-bom");
    process.env.DB_SQLITE_PATH = destPath;
    const dest = await openBackupAdapter();
    await dest.insertRows("audit_logs", (JSON.parse(file) as { audit: Record<string, unknown>[] }).audit);
    await dest.close();
    const restored = await SqliteStore.create(destPath);
    try {
      expect(await restored.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 4 });
    } finally {
      await restored.close();
    }
    const restoredRaw = new Database(destPath, { readonly: true });
    try {
      expect(sqliteAuditBytes(restoredRaw)).toEqual(sourceBytes);
    } finally {
      restoredRaw.close();
      fs.rmSync(path.dirname(destPath), { recursive: true, force: true });
    }
  });
});

/** Whether this Node's better-sqlite3 stores a lone surrogate exactly (Node 20: generalized UTF-8) or as U+FFFD (24). */
function sqliteKeepsLoneSurrogates(): boolean {
  const db = new Database(":memory:");
  try {
    return (db.prepare(`SELECT hex(?) AS h`).get("\ud800") as { h: string }).h === "EDA080";
  } finally {
    db.close();
  }
}

describe("db:export records the audit verdict; db:import refuses a restore that changes it", () => {
  let dir: string;
  let sourcePath: string;
  let destPath: string;
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-backup-verdict-"));
    sourcePath = path.join(dir, "source.db");
    destPath = path.join(dir, "dest.db");
    lines.length = 0;
    process.env.DB_TYPE = "sqlite";
  });

  afterEach(() => {
    delete process.env.DB_TYPE;
    delete process.env.DB_SQLITE_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function exportFrom(file: string, options: { excludeHistory?: boolean } = {}): Promise<BackupDump> {
    process.env.DB_SQLITE_PATH = file;
    const adapter = await openBackupAdapter();
    try {
      // Through JSON, as the file on disk.
      return JSON.parse(JSON.stringify(await exportDump(adapter, { ...options, log }))) as BackupDump;
    } finally {
      await adapter.close();
    }
  }

  async function importInto(file: string, dump: BackupDump, options: ImportOptions = {}) {
    process.env.DB_SQLITE_PATH = file;
    const adapter = await openBackupAdapter();
    try {
      return await importDump(adapter, dump, { log, ...options });
    } finally {
      await adapter.close();
    }
  }

  /** The destination holds one workflow and one audit row before the restore, to see a rollback leave them. */
  async function destinationWithData(): Promise<void> {
    const store = await SqliteStore.create(destPath);
    await store.upsertWorkflow({ id: "wf-before", name: "Before", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);
    await store.writeAuditLog({ id: "before", eventType: "e", category: "c", action: "a", outcome: "success" });
    await store.close();
  }

  async function destinationState(): Promise<{ workflows: string[]; audit: string[] }> {
    const raw = new Database(destPath, { readonly: true });
    try {
      return {
        workflows: (raw.prepare(`SELECT id FROM workflows ORDER BY id`).all() as Array<{ id: string }>).map((row) => row.id),
        audit: (raw.prepare(`SELECT id FROM audit_logs ORDER BY rowid`).all() as Array<{ id: string }>).map((row) => row.id)
      };
    } finally {
      raw.close();
    }
  }

  it("records the verdict (ok / broken at a row / unverifiable rows) and restores a clean backup with the same verdict", async () => {
    const store = await SqliteStore.create(sourcePath);
    await store.writeAuditLog({ id: "a1", eventType: "e", category: "c", action: "a", outcome: "success" });
    await store.writeAuditLog({ id: "a2", eventType: "e", category: "c", action: "a", outcome: "success" });
    await store.close();
    const dump = await exportFrom(sourcePath);
    expect(dump.auditVerdict).toEqual({ ok: true, rowsChecked: 2, unverifiable: [] });
    expect(lines).toContain("  audit chain: intact (2 rows verified) (recorded in the backup)");
    const report = await importInto(destPath, dump);
    expect(report.audit?.restored).toEqual({ ok: true, rowsChecked: 2 });
    expect(lines).toContain("Audit chain: intact (2 rows verified), as the backup recorded (intact (2 rows verified)).");

    const withoutHistory = await exportFrom(sourcePath, { excludeHistory: true });
    expect(withoutHistory.auditVerdict).toBeUndefined();
  });

  it("refuses and rolls back a restore whose chain breaks where the backup recorded it intact (an edited backup file)", async () => {
    const store = await SqliteStore.create(sourcePath);
    await store.writeAuditLog({ id: "a1", eventType: "e", category: "c", action: "a", outcome: "success", message: "approved by alice" });
    await store.writeAuditLog({ id: "a2", eventType: "e", category: "c", action: "a", outcome: "success" });
    await store.close();
    const dump = await exportFrom(sourcePath);
    dump.tables.audit_logs![0]!.message = "approved by mallory";
    await destinationWithData();
    const before = await destinationState();
    const error = await importInto(destPath, dump).then(() => undefined, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(AuditVerdictMismatch);
    expect(error!.message).toMatch(/does not match the backup's recorded verdict \(intact \(2 rows verified\)\): row a1 \(position 1\) would be broken on the restored database/);
    expect(error!.message).toContain("Nothing was restored (rolled back).");
    expect(await destinationState()).toEqual(before);
  });

  it("a backup of a broken chain must restore broken at the same row (review probe p9: a swapped Node-20 surrogate)", async () => {
    const store = await SqliteStore.create(sourcePath);
    await store.writeAuditLog({ id: "a1", eventType: "e", category: "c", action: "a", outcome: "success" });
    await store.close();
    const raw = new Database(sourcePath);
    appendLegacySqliteAuditRow(raw, "legacy", { message: "tag \ud800 here" });
    raw.prepare(`UPDATE audit_logs SET message = CAST(? AS TEXT) WHERE id = 'legacy'`).run(wtf8("tag \udfff here"));
    raw.close();
    const dump = await exportFrom(sourcePath);
    expect(dump.auditVerdict).toEqual({ ok: false, rowsChecked: 1, firstBrokenAt: { id: "legacy", position: 2 }, unverifiable: [] });
    await destinationWithData();
    const before = await destinationState();
    const result = await importInto(destPath, dump).then((report) => report, (e: unknown) => e as Error);
    if (sqliteKeepsLoneSurrogates()) {
      // Node 20 stores the swapped surrogate exactly again: still broken at the same row.
      expect(result).not.toBeInstanceOf(Error);
      expect((result as Awaited<ReturnType<typeof importDump>>).audit?.restored.firstBrokenAt?.id).toBe("legacy");
    } else {
      // Node 24 stores U+FFFD, which the one-U+FFFD search then "explains": the restore would call the chain intact.
      expect(result).toBeInstanceOf(AuditVerdictMismatch);
      expect((result as Error).message).toContain("the backup's chain was broken at row legacy, the restored one is intact (2 rows verified)");
      expect(await destinationState()).toEqual(before);
    }
  });

  it("allows only the documented change: a row with two lone surrogates may become unverifiable where they become U+FFFD", async () => {
    const store = await SqliteStore.create(sourcePath);
    await store.writeAuditLog({ id: "a1", eventType: "e", category: "c", action: "a", outcome: "success" });
    await store.close();
    const raw = new Database(sourcePath);
    appendLegacySqliteAuditRow(raw, "two-surrogates", { message: "\udbff and \udc00" });
    raw.close();
    const dump = await exportFrom(sourcePath);
    expect(dump.auditVerdict).toEqual({ ok: true, rowsChecked: 2, unverifiable: [] });
    const report = await importInto(destPath, dump);
    if (sqliteKeepsLoneSurrogates()) {
      expect(report.audit?.restored).toEqual({ ok: true, rowsChecked: 2 });
      expect(report.audit?.becameUnverifiable).toEqual([]);
    } else {
      expect(report.audit?.restored).toMatchObject({ ok: false, rowsChecked: 1, unverifiable: [{ id: "two-surrogates" }] });
      expect(report.audit?.becameUnverifiable).toEqual(["two-surrogates"]);
      expect(lines.join("\n")).toContain("1 audit row(s) verified in the backup cannot be verified after the restore (two-surrogates)");
    }
  });

  it("an older backup without a recorded verdict restores as before, with a note", async () => {
    const store = await SqliteStore.create(sourcePath);
    await store.writeAuditLog({ id: "a1", eventType: "e", category: "c", action: "a", outcome: "success" });
    await store.close();
    const dump = await exportFrom(sourcePath);
    delete dump.auditVerdict;
    dump.tables.audit_logs![0]!.message = "edited";
    const report = await importInto(destPath, dump);
    expect(report.totalInserted).toBeGreaterThan(0);
    expect(report.audit?.restored.firstBrokenAt?.id).toBe("a1");
    expect(lines.join("\n")).toContain(
      "Note: this backup does not record its audit-chain verdict (written by an older db:export), so the restored chain is not compared with it. " +
        "Restored audit chain: broken at row a1"
    );
  });
  describe("--merge and --allow-audit-change", () => {
    async function tamperedDump(): Promise<BackupDump> {
      const store = await SqliteStore.create(sourcePath);
      await store.writeAuditLog({ id: "a1", eventType: "e", category: "c", action: "a", outcome: "success" });
      await store.writeAuditLog({ id: "a2", eventType: "e", category: "c", action: "a", outcome: "success" });
      await store.close();
      const dump = await exportFrom(sourcePath);
      dump.tables.audit_logs![0]!.message = "approved by mallory";
      return dump;
    }

    async function emptyDestination(): Promise<void> {
      const store = await SqliteStore.create(destPath);
      await store.close();
    }

    async function auditIds(): Promise<string[]> {
      const raw = new Database(destPath, { readonly: true });
      try {
        return (raw.prepare(`SELECT id FROM audit_logs ORDER BY rowid`).all() as Array<{ id: string }>).map((row) => row.id);
      } finally {
        raw.close();
      }
    }

    it("--merge into an empty audit log compares the verdict like a plain restore, and refuses (probe r5)", async () => {
      const dump = await tamperedDump();
      await emptyDestination();
      const error = await importInto(destPath, dump, { merge: true }).then(() => undefined, (e: unknown) => e as Error);
      expect(error).toBeInstanceOf(AuditVerdictMismatch);
      expect(error!.message).toContain("pass --allow-audit-change to restore anyway");
      expect(await auditIds()).toEqual([]);
    });

    it("--allow-audit-change restores a changed verdict on a plain and an empty-target merge import, and prints both verdicts and a WARNING", async () => {
      const dump = await tamperedDump();
      for (const merge of [false, true]) {
        lines.length = 0;
        fs.rmSync(destPath, { force: true });
        await emptyDestination();
        const report = await importInto(destPath, dump, { merge, allowAuditChange: true });
        expect(await auditIds()).toEqual(["a1", "a2"]);
        expect(lines.join("\n")).toMatch(/Audit chain before \(backup\): intact \(2 rows verified\)\. After \(restored\): broken at row a1/);
        expect(report.audit?.changedWarning).toMatch(/^WARNING: .*before \(backup\) intact \(2 rows verified\), after \(restored\) broken at row a1/);
      }
    });

    it("--allow-audit-change prints no warning when the verdict is unchanged", async () => {
      const store = await SqliteStore.create(sourcePath);
      await store.writeAuditLog({ id: "a1", eventType: "e", category: "c", action: "a", outcome: "success" });
      await store.close();
      const report = await importInto(destPath, await exportFrom(sourcePath), { allowAuditChange: true });
      expect(report.audit?.changedWarning).toBeUndefined();
    });

    it("--merge into a non-empty audit log keeps merging, says the verdict was not compared, and shows the restored chain's verdict", async () => {
      const dump = await tamperedDump();
      await destinationWithData();
      const report = await importInto(destPath, dump, { merge: true });
      expect(await auditIds()).toEqual(["before", "a1", "a2"]);
      expect(lines.join("\n")).toContain(
        "Note: --merge keeps the audit rows already in the database, so the audit verdict was not compared with the backup's (intact (2 rows verified)). Restored audit chain: "
      );
      expect(report.audit?.restored).toBeDefined();
      expect(report.audit?.changedWarning).toBeUndefined();
    });

    it("a failing table in --merge rolls the whole merge back", async () => {
      const store = await SqliteStore.create(sourcePath);
      await store.writeAuditLog({ id: "a1", eventType: "e", category: "c", action: "a", outcome: "success" });
      await store.upsertWorkflow({ id: "wf-dup", name: "Dup", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);
      await store.close();
      const dump = await exportFrom(sourcePath);
      await destinationWithData();
      // Tables restore in EXPORTED_TABLES order; a duplicate workflow id fails the merge after earlier tables went in.
      const dup = { ...dump.tables.workflows![0]!, id: "wf-before" };
      dump.tables.workflows = [dump.tables.workflows![0]!, dup];
      const before = await destinationState();
      const error = await importInto(destPath, dump, { merge: true }).then(() => undefined, (e: unknown) => e as Error);
      expect(error?.message).toMatch(/Failed to insert into workflows/);
      expect(await destinationState()).toEqual(before);
    });
  });
});
