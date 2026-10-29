/**
 * Phase 13.1 — what db:export carries and how db:import restores it, found by the restore drill (scripts/dr-drill.mjs)
 * and its review:
 *  - every table of the live schema is exported or listed in NOT_EXPORTED_TABLES with its reason (db:export used to
 *    write 29 of them, so a JSON backup lost MCP servers, approval requests, guard profiles, knowledge bases,
 *    releases, audit signing keys and more);
 *  - db:import refuses a destination that holds data; --replace empties every exported table, including ones an older
 *    backup does not hold, so the result is exactly the backup; --merge leaves those untouched; each table is logged;
 *  - --source-master-key re-encrypts every encrypted or sealed value, JSON-embedded ones included (a source scan fails
 *    when a new place encrypts with the master key), names the table it cannot open, and --source-master-key-file
 *    reads the key from a file (warning when others can read it);
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
import { AuthService } from "../services/auth-service.js";
import { SecretService } from "../services/secret-service.js";
import {
  ENCRYPTED_COLUMNS,
  EXPORTED_TABLES,
  ImportRefusal,
  JSON_SEALED_FIELDS,
  NOT_EXPORTED_TABLES,
  SEALED_COLUMNS,
  exportDump,
  importDump,
  isMissingTableError,
  openBackupAdapter,
  type BackupAdapter,
  type BackupDump
} from "./db-shared.js";
import { readKeyFile, reencryptRows, resealValue, tablesTheKeyCannotOpen } from "./db-reencrypt.js";

const KEY_A = crypto.randomBytes(32).toString("base64");
const KEY_B = crypto.randomBytes(32).toString("base64");
const KEY_A_BYTES = Buffer.from(KEY_A, "base64");
const KEY_B_BYTES = Buffer.from(KEY_B, "base64");
const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const backupOf = (tables: BackupDump["tables"]): BackupDump => ({
  format: "ai-orchestrator-backup",
  formatVersion: 1,
  schemaVersion: 1,
  exportedAt: "",
  dbType: "sqlite",
  tables
});

describe("db:export table coverage", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-backup-coverage-"));
    process.env.DB_TYPE = "sqlite";
  });

  afterEach(() => {
    delete process.env.DB_TYPE;
    delete process.env.DB_SQLITE_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function exportFrom(file: string): Promise<BackupDump> {
    process.env.DB_SQLITE_PATH = file;
    const adapter = await openBackupAdapter();
    try {
      return JSON.parse(JSON.stringify(await exportDump(adapter))) as BackupDump;
    } finally {
      await adapter.close();
    }
  }

  async function importInto(file: string, dump: BackupDump, options: Parameters<typeof importDump>[2] = {}) {
    process.env.DB_SQLITE_PATH = file;
    const adapter = await openBackupAdapter();
    try {
      return await importDump(adapter, dump, options);
    } finally {
      await adapter.close();
    }
  }

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
    // Live sessions stay out of backups: users sign in again.
    expect(EXPORTED_TABLES).not.toContain("sessions");
  });

  it("round-trips an MCP server, an elicitation's holder, a guard vault entry (re-sealed with a new key) and a knowledge base", async () => {
    const source = path.join(dir, "source.db");
    const store = await SqliteStore.create(source);
    const secrets = new SecretService(store, KEY_A);
    await store.createMcpServer({ id: "mcp_one", name: "One", adapterId: "mock-mcp" });
    await store.putGuardVault({ token: "tok_1", dataClass: "email", valueHash: "h1", valueSealed: secrets.sealValue("guard-token-vault", "ana@example.com"), createdAt: new Date().toISOString() });
    await store.createKnowledgeBase({ id: "kb1", name: "KB", embedderId: "mock" });
    await store.addKnowledgeBaseChunks({ knowledgeBaseId: "kb1", chunks: [{ id: "c1", chunkIndex: 0, content: "refund policy for orders", vector: [1, 0] }] });
    await store.close();
    const raw = new Database(source);
    raw.prepare(
      `INSERT INTO mcp_elicitations (id, execution_id, workflow_id, node_id, server_id, tool_name, message, schema_json, status, created_at, expires_at, holder_id)
       VALUES ('el1', 'run1', 'wf1', 'n1', 'mcp_one', 'ask', 'Which?', '{}', 'pending', '2026-10-29T00:00:00.000Z', '2026-10-30T00:00:00.000Z', 'instance-a')`
    ).run();
    raw.close();

    const dump = await exportFrom(source);
    expect(Object.keys(dump.tables).sort()).toEqual([...EXPORTED_TABLES].sort());

    const dest = path.join(dir, "dest.db");
    await importInto(dest, dump, { prepare: (table, rows) => reencryptRows(table, rows, KEY_A_BYTES, KEY_B_BYTES) });

    const restored = await SqliteStore.create(dest);
    try {
      expect((await restored.getMcpServer("mcp_one"))?.name).toBe("One");
      expect((await restored.getMcpElicitation("el1"))?.holderId).toBe("instance-a");
      const vault = await restored.getGuardVaultByToken("tok_1");
      expect(new SecretService(restored, KEY_B).openValue("guard-token-vault", vault!.value_sealed)).toBe("ana@example.com");
      // The full-text index is rebuilt by the chunk table's triggers.
      const check = new Database(dest, { readonly: true });
      expect(check.prepare(`SELECT COUNT(*) AS n FROM knowledge_base_chunks_fts WHERE knowledge_base_chunks_fts MATCH 'refund'`).get()).toEqual({ n: 1 });
      check.close();
    } finally {
      await restored.close();
    }
  });

  it("refuses a destination that holds data, and changes nothing", async () => {
    const dest = path.join(dir, "dest.db");
    const store = await SqliteStore.create(dest);
    await store.createMcpServer({ id: "mcp_kept", name: "Kept", adapterId: "mock-mcp" });
    await store.close();
    const error = await importInto(dest, backupOf({ workflows: [] })).then(() => undefined, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(ImportRefusal);
    expect(error!.message).toMatch(/already holds data \(mcp_servers: 1\).*--replace.*Nothing was changed\./);
    const reopened = await SqliteStore.create(dest);
    try {
      expect((await reopened.getMcpServer("mcp_kept"))?.name).toBe("Kept");
    } finally {
      await reopened.close();
    }
    await expect(importInto(dest, backupOf({}), { merge: true, replace: true })).rejects.toThrow(/choose one/);
  });

  it("--replace restores exactly the backup: tables an older backup does not hold are emptied, and the log says so", async () => {
    const dest = path.join(dir, "dest.db");
    const store = await SqliteStore.create(dest);
    await store.createMcpServer({ id: "mcp_old", name: "Old", adapterId: "mock-mcp" });
    await store.upsertWorkflow({ id: "wf-old", name: "Old", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);
    await store.close();
    const source = path.join(dir, "source.db");
    const sourceStore = await SqliteStore.create(source);
    await sourceStore.upsertWorkflow({ id: "wf-new", name: "New", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);
    await sourceStore.close();
    // An older db:export: the workflow tables only.
    const full = await exportFrom(source);
    const older = backupOf({ workflows: full.tables.workflows!, workflow_versions: full.tables.workflow_versions! });
    const lines: string[] = [];
    const report = await importInto(dest, older, { replace: true, log: (line) => lines.push(line) });
    expect(report.tables.find((entry) => entry.table === "workflows")).toEqual({ table: "workflows", action: "restored", rows: 1 });
    expect(report.tables.find((entry) => entry.table === "mcp_servers")).toEqual({ table: "mcp_servers", action: "emptied", rows: 0 });
    expect(lines).toContain("  mcp_servers: emptied (not in the backup)");
    expect(lines).toContain("  workflows: restored, 1 rows");
    expect(lines.some((line) => /does not hold \d+ table\(s\).*They are empty now\./.test(line))).toBe(true);
    const raw = new Database(dest, { readonly: true });
    try {
      expect(raw.prepare(`SELECT COUNT(*) AS n FROM mcp_servers`).get()).toEqual({ n: 0 });
      expect((raw.prepare(`SELECT id FROM workflows`).all() as Array<{ id: string }>).map((row) => row.id)).toEqual(["wf-new"]);
    } finally {
      raw.close();
    }
  });

  it("--replace also signs everyone out: the destination's sessions are emptied, never restored", async () => {
    const dest = path.join(dir, "dest.db");
    const store = await SqliteStore.create(dest);
    const auth = new AuthService(store, 24);
    await auth.register({ email: "ana@example.com", password: "Ana-Pass-123!", role: "admin" });
    const { sessionId } = await auth.login("ana@example.com", "Ana-Pass-123!");
    expect(await auth.getSessionUser(sessionId)).not.toBeNull();
    await store.close();
    const lines: string[] = [];
    await importInto(dest, backupOf({ workflows: [] }), { replace: true, log: (line) => lines.push(line) });
    expect(lines).toContain("  sessions: emptied (never in a backup: everyone signs in again)");
    const raw = new Database(dest, { readonly: true });
    try {
      expect(raw.prepare(`SELECT COUNT(*) AS n FROM sessions`).get()).toEqual({ n: 0 });
    } finally {
      raw.close();
    }
  });

  /** `adapter` with some methods replaced (the rest bound to it). */
  function withFaults(adapter: BackupAdapter, faults: Partial<BackupAdapter>): BackupAdapter {
    return new Proxy(adapter, {
      get(target, property, receiver) {
        if (property in faults) return faults[property as keyof BackupAdapter];
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }

  it("a table that cannot be emptied fails the restore and rolls it back, never logged as emptied", async () => {
    const dest = path.join(dir, "dest.db");
    const store = await SqliteStore.create(dest);
    await store.createMcpServer({ id: "mcp_kept", name: "Kept", adapterId: "mock-mcp" });
    await store.close();
    process.env.DB_SQLITE_PATH = dest;
    const adapter = await openBackupAdapter();
    const lines: string[] = [];
    try {
      const faulty = withFaults(adapter, {
        truncate: async (table: string) => {
          if (table === "mcp_servers") throw new Error("disk I/O error");
          return adapter.truncate(table);
        }
      });
      await expect(importDump(faulty, backupOf({ workflows: [] }), { replace: true, log: (line) => lines.push(line) })).rejects.toThrow(
        /^Failed to empty mcp_servers before the restore: disk I\/O error$/
      );
    } finally {
      await adapter.close();
    }
    expect(lines.some((line) => line.includes("mcp_servers"))).toBe(false);
    const reopened = await SqliteStore.create(dest);
    try {
      expect((await reopened.getMcpServer("mcp_kept"))?.name).toBe("Kept");
    } finally {
      await reopened.close();
    }
  });

  it("counts only a missing table as empty when deciding whether the destination holds data", async () => {
    expect(isMissingTableError(new Error("no such table: mcp_servers"))).toBe(true);
    expect(isMissingTableError(Object.assign(new Error('relation "mcp_servers" does not exist'), { code: "42P01" }))).toBe(true);
    expect(isMissingTableError(new Error("database is locked"))).toBe(false);
    expect(isMissingTableError(Object.assign(new Error("permission denied"), { code: "42501" }))).toBe(false);

    const dest = path.join(dir, "dest.db");
    process.env.DB_SQLITE_PATH = dest;
    const adapter = await openBackupAdapter();
    try {
      const count = (failure: Error) =>
        withFaults(adapter, {
          countRows: async (table: string) => {
            if (table === "mcp_servers") throw failure;
            return adapter.countRows(table);
          }
        });
      await expect(importDump(count(new Error("database is locked")), backupOf({ workflows: [] }))).rejects.toThrow(
        /^Cannot tell whether the destination is empty: counting mcp_servers failed: database is locked$/
      );
      const report = await importDump(count(new Error("no such table: mcp_servers")), backupOf({ workflows: [] }));
      expect(report.tables.find((entry) => entry.table === "workflows")?.action).toBe("restored");
    } finally {
      await adapter.close();
    }
  });

  it("--merge leaves tables the backup does not hold untouched, and says so", async () => {
    const dest = path.join(dir, "dest.db");
    const store = await SqliteStore.create(dest);
    await store.createMcpServer({ id: "mcp_old", name: "Old", adapterId: "mock-mcp" });
    await store.close();
    const report = await importInto(dest, backupOf({ workflows: [] }), { merge: true });
    expect(report.tables.find((entry) => entry.table === "mcp_servers")).toEqual({ table: "mcp_servers", action: "untouched", rows: 0 });
    const reopened = await SqliteStore.create(dest);
    try {
      expect((await reopened.getMcpServer("mcp_old"))?.name).toBe("Old");
    } finally {
      await reopened.close();
    }
  });
});

describe("db:import re-encryption", () => {
  const vaultSecret = (key: string) => new SecretService({} as never, key);

  it("re-seals a sealed value for its purpose, and refuses a wrong source key", () => {
    const sealed = vaultSecret(KEY_A).sealValue("guard-token-vault", "secret value");
    const resealed = resealValue(sealed, "guard-token-vault", KEY_A_BYTES, KEY_B_BYTES);
    expect(vaultSecret(KEY_B).openValue("guard-token-vault", resealed)).toBe("secret value");
    expect(() => resealValue(sealed, "guard-token-vault", KEY_B_BYTES, KEY_A_BYTES)).toThrow();
    expect(() => resealValue(sealed, "another-purpose", KEY_A_BYTES, KEY_B_BYTES)).toThrow();
  });

  it("re-seals approved tool results inside a paused run's state, sub-workflow states included", () => {
    const seal = (text: string) => vaultSecret(KEY_A).sealValue("approval_tool_results", text);
    const state = {
      nodeResults: [{ nodeId: "n1" }],
      approvedToolResultsSealed: seal('{"call_1":{"ok":true}}'),
      approvalHandoff: { kind: "sub_workflow", childState: { approvedToolResultsSealed: seal('{"call_2":{"ok":true}}') } }
    };
    const untouched = { id: "run-2", state_json: JSON.stringify({ nodeResults: [] }) };
    const { rows, touched } = reencryptRows("workflow_executions", [{ id: "run-1", state_json: JSON.stringify(state) }, untouched], KEY_A_BYTES, KEY_B_BYTES);
    expect(touched).toBe(2);
    expect(rows[1]).toBe(untouched);
    const out = JSON.parse(String(rows[0]!.state_json)) as typeof state;
    expect(out.nodeResults).toEqual([{ nodeId: "n1" }]);
    expect(vaultSecret(KEY_B).openValue("approval_tool_results", out.approvedToolResultsSealed)).toBe('{"call_1":{"ok":true}}');
    expect(vaultSecret(KEY_B).openValue("approval_tool_results", out.approvalHandoff.childState.approvedToolResultsSealed)).toBe('{"call_2":{"ok":true}}');
    // Read from a JSON column (an object, not text): re-sealed in a copy, the row read is left as it was.
    const original = state.approvedToolResultsSealed;
    const asObject = reencryptRows("workflow_executions", [{ id: "run-1", state_json: state }], KEY_A_BYTES, KEY_B_BYTES);
    expect(asObject.touched).toBe(2);
    expect(state.approvedToolResultsSealed).toBe(original);
    const copied = asObject.rows[0]!.state_json as typeof state;
    expect(vaultSecret(KEY_B).openValue("approval_tool_results", copied.approvedToolResultsSealed)).toBe('{"call_1":{"ok":true}}');
  });

  it("names the table when the source key cannot open a value", () => {
    const secret = vaultSecret(KEY_A).sealValue("guard-token-vault", "x");
    expect(() => reencryptRows("guard_token_vault", [{ token: "t", value_sealed: secret }], KEY_B_BYTES, KEY_A_BYTES)).toThrow(
      /^guard_token_vault: cannot decrypt with --source-master-key \(wrong key\?\)$/
    );
    const state = JSON.stringify({ approvedToolResultsSealed: vaultSecret(KEY_A).sealValue("approval_tool_results", "{}") });
    expect(() => reencryptRows("workflow_executions", [{ id: "r", state_json: state }], KEY_B_BYTES, KEY_A_BYTES)).toThrow(/^workflow_executions: cannot decrypt/);
  });

  it("checks that the destination key opens the backup's first secrets and mfa_secrets rows", () => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", KEY_A_BYTES, iv);
    const ciphertext = Buffer.concat([cipher.update("v"), cipher.final()]);
    const row = { iv: iv.toString("base64"), auth_tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
    const mfa = { secret_iv: row.iv, secret_auth_tag: row.auth_tag, secret_ciphertext: row.ciphertext };
    expect(tablesTheKeyCannotOpen({ secrets: [row], mfa_secrets: [mfa] }, KEY_A_BYTES)).toEqual([]);
    expect(tablesTheKeyCannotOpen({ secrets: [row], mfa_secrets: [mfa] }, KEY_B_BYTES)).toEqual(["secrets", "mfa_secrets"]);
    expect(tablesTheKeyCannotOpen({ secrets: [{ iv: null, auth_tag: null, ciphertext: null }] }, KEY_B_BYTES)).toEqual([]);
  });

  it("uses the purposes the services seal with", () => {
    const guard = fs.readFileSync(path.join(API_ROOT, "src", "services", "guard-service.ts"), "utf8");
    expect(guard).toContain(`const VAULT_PURPOSE = "${SEALED_COLUMNS.guard_token_vault!.purpose}";`);
    const app = fs.readFileSync(path.join(API_ROOT, "src", "app.ts"), "utf8");
    expect(app).toContain(`const TOOL_RESULTS_PURPOSE = "${JSON_SEALED_FIELDS[0]!.purpose}";`);
    expect(app).toContain(`${JSON_SEALED_FIELDS[0]!.key}: secretService.sealValue(TOOL_RESULTS_PURPOSE`);
  });

  /**
   * Every place the API encrypts or seals with the master key, and what a backup does with it. A new call site fails
   * this test until it is added here: re-encrypted by db:import (ENCRYPTED_COLUMNS, SEALED_COLUMNS, JSON_SEALED_FIELDS),
   * or never in a backup (a table in NOT_EXPORTED_TABLES, a cookie, a message between instances).
   */
  const ENCRYPTION_SITES: Record<string, { calls: number; handling: string }> = {
    "services/secret-service.ts": { calls: 3, handling: "secrets (ENCRYPTED_COLUMNS); sealValue itself" },
    "services/mfa-service.ts": { calls: 1, handling: "mfa_secrets (ENCRYPTED_COLUMNS)" },
    "services/log-streaming-service.ts": { calls: 1, handling: "log_stream_destinations (ENCRYPTED_COLUMNS)" },
    "services/guard-service.ts": { calls: 1, handling: "guard_token_vault.value_sealed (SEALED_COLUMNS)" },
    "app.ts": { calls: 1, handling: "workflow_executions.state_json approvedToolResultsSealed (JSON_SEALED_FIELDS)" },
    "services/challenge-store.ts": { calls: 2, handling: "pending_challenges (NOT_EXPORTED_TABLES)" },
    "services/mcp-elicitation-service.ts": { calls: 1, handling: "an answer sent over the cluster bus, never stored" },
    "services/oidc-service.ts": { calls: 1, handling: "the OIDC flow cookie, never stored" },
    "services/saml-service.ts": { calls: 1, handling: "the SAML request cookie, never stored" }
  };

  it("knows every place that encrypts or seals with the master key", () => {
    const found: Record<string, number> = {};
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "scripts" && entry.name !== "test-support") walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.includes(".test-")) {
          const calls = fs.readFileSync(full, "utf8").match(/\bcreateCipheriv\(|\bsealValue\(/g)?.length ?? 0;
          if (calls > 0) found[path.relative(path.join(API_ROOT, "src"), full)] = calls;
        }
      }
    };
    walk(path.join(API_ROOT, "src"));
    expect(found, "a new encryption site: add it to ENCRYPTION_SITES and make db:import re-encrypt it, or say why it is never in a backup").toEqual(
      Object.fromEntries(Object.entries(ENCRYPTION_SITES).map(([file, { calls }]) => [file, calls]))
    );
    expect(Object.keys(ENCRYPTED_COLUMNS).every((table) => (EXPORTED_TABLES as readonly string[]).includes(table))).toBe(true);
    expect(Object.keys(SEALED_COLUMNS).every((table) => (EXPORTED_TABLES as readonly string[]).includes(table))).toBe(true);
    expect("pending_challenges" in NOT_EXPORTED_TABLES).toBe(true);
  });

  it("reads a key file's first line, warns when others can read it, and never echoes its content in an error", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-keyfile-"));
    try {
      const file = path.join(dir, "key");
      const warnings: string[] = [];
      fs.writeFileSync(file, `  ${KEY_A}  \nignored\n`, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      expect(readKeyFile(file, (line) => warnings.push(line))).toBe(KEY_A);
      expect(warnings).toEqual([]);
      fs.chmodSync(file, 0o644);
      readKeyFile(file, (line) => warnings.push(line));
      expect(warnings).toEqual([expect.stringMatching(/readable by its group or others \(mode 644\); restrict it with chmod 600/)]);
      expect(warnings.join("")).not.toContain(KEY_A);
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
