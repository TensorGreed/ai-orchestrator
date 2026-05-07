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
import { SqliteStore } from "../db/database.js";
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

    sourceStore.upsertWorkflow({
      id: "wf-1",
      name: "Hello",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [],
      edges: []
    } as never);
    const stored = secrets.createSecret({ name: "OPENAI_KEY", provider: "openai", value: "sk-test-12345" });
    sourceStore.close();

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
    const list = restoredSecrets.listSecrets();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("OPENAI_KEY");
    const revealed = await restoredSecrets.resolveSecret({ secretId: stored.secretId });
    expect(revealed).toBe("sk-test-12345");
    restoredStore.close();
    try { fs.rmSync(path.dirname(destPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("re-encrypts secrets when the destination master key differs", async () => {
    process.env.SECRET_MASTER_KEY_BASE64 = KEY_A;
    const sourceStore = await SqliteStore.create(dbPath);
    const sourceSecrets = new SecretService(sourceStore, KEY_A);
    const stored = sourceSecrets.createSecret({ name: "STRIPE_KEY", provider: "openai-compatible", value: "sk-live-rotateme" });
    sourceStore.close();

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
    restoredStore.close();
    try { fs.rmSync(path.dirname(destPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
