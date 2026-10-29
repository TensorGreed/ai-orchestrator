/**
 * Phase 13.1 — what db:export carries, found by the restore drill (scripts/dr-drill.mjs):
 *  - every table of the live schema is exported or listed in NOT_EXPORTED_TABLES with its reason (db:export used to
 *    write 29 of them, so a JSON backup lost MCP servers, approval requests, guard profiles, knowledge bases,
 *    releases, audit signing keys and more);
 *  - an import empties only the tables the backup holds (and the history tables, as before), so an older, smaller
 *    backup leaves the rest alone;
 *  - --source-master-key re-seals the guard token vault too, and --source-master-key-file reads the key from a file;
 *  - the CLIs accept the `--` pnpm passes through (pnpm --filter @ai-orchestrator/api db:export -- --out x).
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../db/database.js";
import { SecretService } from "../services/secret-service.js";
import {
  EXPORTED_TABLES,
  HISTORY_TABLES,
  NOT_EXPORTED_TABLES,
  SEALED_COLUMNS,
  exportDump,
  importDump,
  openBackupAdapter,
  tablesToTruncate,
  type BackupDump
} from "./db-shared.js";
import { readKeyFile, reencryptRows, resealValue } from "./db-reencrypt.js";

const KEY_A = crypto.randomBytes(32).toString("base64");
const KEY_B = crypto.randomBytes(32).toString("base64");
const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("db:export table coverage", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-backup-coverage-"));
  });

  afterEach(() => {
    delete process.env.DB_TYPE;
    delete process.env.DB_SQLITE_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exports every table of the SQLite schema except the listed transient ones", async () => {
    const file = path.join(dir, "schema.db");
    await (await SqliteStore.create(file)).close();
    const db = new Database(file, { readonly: true });
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>).map((row) => row.name);
    db.close();
    const exported = new Set<string>(EXPORTED_TABLES);
    const unlisted = tables.filter((table) => !exported.has(table) && !(table in NOT_EXPORTED_TABLES));
    expect(unlisted, "add new tables to EXPORTED_TABLES, or to NOT_EXPORTED_TABLES with the reason").toEqual([]);
    expect(EXPORTED_TABLES.filter((table) => !tables.includes(table))).toEqual([]);
    expect(EXPORTED_TABLES.filter((table) => table in NOT_EXPORTED_TABLES)).toEqual([]);
    expect(new Set(EXPORTED_TABLES).size).toBe(EXPORTED_TABLES.length);
  });

  it("round-trips an MCP server, a guard vault entry (re-sealed with a new key) and a knowledge base through export and import", async () => {
    const source = path.join(dir, "source.db");
    const store = await SqliteStore.create(source);
    const secrets = new SecretService(store, KEY_A);
    await store.createMcpServer({ id: "mcp_one", name: "One", adapterId: "mock-mcp" });
    await store.putGuardVault({ token: "tok_1", dataClass: "email", valueHash: "h1", valueSealed: secrets.sealValue("guard-token-vault", "ana@example.com"), createdAt: new Date().toISOString() });
    await store.createKnowledgeBase({ id: "kb1", name: "KB", embedderId: "mock" });
    await store.addKnowledgeBaseChunks({ knowledgeBaseId: "kb1", chunks: [{ id: "c1", chunkIndex: 0, content: "refund policy for orders", vector: [1, 0] }] });
    await store.close();

    process.env.DB_TYPE = "sqlite";
    process.env.DB_SQLITE_PATH = source;
    const exporter = await openBackupAdapter();
    const dump = JSON.parse(JSON.stringify(await exportDump(exporter))) as BackupDump;
    await exporter.close();
    expect(Object.keys(dump.tables).sort()).toEqual([...EXPORTED_TABLES].sort());

    const dest = path.join(dir, "dest.db");
    process.env.DB_SQLITE_PATH = dest;
    const importer = await openBackupAdapter();
    await importDump(importer, dump, {
      prepare: (table, rows) => reencryptRows(table, rows, Buffer.from(KEY_A, "base64"), Buffer.from(KEY_B, "base64"))
    });
    await importer.close();

    const restored = await SqliteStore.create(dest);
    try {
      expect((await restored.getMcpServer("mcp_one"))?.name).toBe("One");
      const vault = await restored.getGuardVaultByToken("tok_1");
      expect(new SecretService(restored, KEY_B).openValue("guard-token-vault", vault!.value_sealed)).toBe("ana@example.com");
      // The full-text index is rebuilt by the chunk table's triggers.
      const raw = new Database(dest, { readonly: true });
      expect(raw.prepare(`SELECT COUNT(*) AS n FROM knowledge_base_chunks_fts WHERE knowledge_base_chunks_fts MATCH 'refund'`).get()).toEqual({ n: 1 });
      raw.close();
    } finally {
      await restored.close();
    }
  });

  it("leaves tables an older, smaller backup does not hold, and still empties the history tables", async () => {
    const old = { tables: { workflows: [], users: [] } } as unknown as BackupDump;
    const truncated = tablesToTruncate(old);
    expect(truncated).toEqual(expect.arrayContaining(["workflows", "users", ...HISTORY_TABLES]));
    expect(truncated).not.toContain("mcp_servers");

    const dest = path.join(dir, "dest.db");
    const store = await SqliteStore.create(dest);
    await store.createMcpServer({ id: "mcp_kept", name: "Kept", adapterId: "mock-mcp" });
    await store.close();
    process.env.DB_TYPE = "sqlite";
    process.env.DB_SQLITE_PATH = dest;
    const importer = await openBackupAdapter();
    await importDump(importer, { format: "ai-orchestrator-backup", formatVersion: 1, schemaVersion: 1, exportedAt: "", dbType: "sqlite", tables: { workflows: [] } });
    await importer.close();
    const reopened = await SqliteStore.create(dest);
    try {
      expect((await reopened.getMcpServer("mcp_kept"))?.name).toBe("Kept");
    } finally {
      await reopened.close();
    }
  });
});

describe("db:import re-encryption helpers", () => {
  it("re-seals a sealed value for its purpose, and refuses a wrong source key", () => {
    const sealed = new SecretService({} as never, KEY_A).sealValue("guard-token-vault", "secret value");
    const resealed = resealValue(sealed, "guard-token-vault", Buffer.from(KEY_A, "base64"), Buffer.from(KEY_B, "base64"));
    expect(new SecretService({} as never, KEY_B).openValue("guard-token-vault", resealed)).toBe("secret value");
    expect(() => resealValue(sealed, "guard-token-vault", Buffer.from(KEY_B, "base64"), Buffer.from(KEY_A, "base64"))).toThrow();
    expect(() => resealValue(sealed, "another-purpose", Buffer.from(KEY_A, "base64"), Buffer.from(KEY_B, "base64"))).toThrow();
  });

  it("uses the purpose guard-service seals the vault with", () => {
    const source = fs.readFileSync(path.join(API_ROOT, "src", "services", "guard-service.ts"), "utf8");
    expect(source).toContain(`const VAULT_PURPOSE = "${SEALED_COLUMNS.guard_token_vault!.purpose}";`);
  });

  it("reads a key file's first line, and never echoes its content in an error", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-keyfile-"));
    try {
      const file = path.join(dir, "key");
      fs.writeFileSync(file, `  ${KEY_A}  \nignored\n`);
      expect(readKeyFile(file)).toBe(KEY_A);
      fs.writeFileSync(file, "\n");
      expect(() => readKeyFile(file)).toThrow(/is empty/);
      expect(() => readKeyFile(path.join(dir, "missing"))).toThrow(/cannot read .*ENOENT/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the backup CLIs accept pnpm's `--`", () => {
  const tsx = path.join(API_ROOT, "node_modules", ".bin", "tsx");
  for (const script of ["db-export.ts", "db-import.ts", "db-rollback.ts"]) {
    it(`${script} -- --help`, () => {
      const result = spawnSync(tsx, [path.join("src", "scripts", script), "--", "--help"], { cwd: API_ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
      expect(result.stderr).not.toContain("Unknown argument");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage:");
    }, 30_000);
  }
});
