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
import { appendLegacySqliteAuditRow, bomAuditEntry, sqliteAuditBytes } from "./legacy-audit.test-helper.js";
import { SecretService } from "../services/secret-service.js";
import {
  EXPORTED_TABLES,
  ENCRYPTED_COLUMNS,
  openBackupAdapter
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
