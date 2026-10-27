/**
 * Phase 13.1 — db:copy (SQLite → Postgres): arguments, refusals, dry run, audit text read exactly, seq order, the
 * next insert after a copy, rollback on failure. The SQLite-side refusals run always (they are refused before any
 * connection); everything that writes Postgres runs when TEST_POSTGRES_URL is set (skipped otherwise), each test in
 * its own fresh schema `t_<hex>` (dropped afterwards). The Store-level round trip is db-copy-roundtrip.test.ts.
 */
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePostgresSettings } from "../config.js";
import { postgresStoreConfig } from "../db/create-store.js";
import { SqliteStore } from "../db/database.js";
import { MIGRATIONS } from "../db/migrations.js";
import { PostgresStore, postgresPoolConfig, type PostgresStoreConfig } from "../db/postgres-store.js";
import { noticePostgresSkipped, testPostgresUrl } from "../test-support/test-store.js";
import { API_ROOT, CODE_SCHEMA_VERSION, DbCopyRefusal, parseDbCopyArgs, runDbCopy } from "./db-copy-core.js";
import { appendLegacySqliteAuditRow } from "./legacy-audit.test-helper.js";

const run = promisify(execFile);

let dir: string;
let sourcePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-db-copy-"));
  sourcePath = path.join(dir, "source.db");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fileHash(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** A config that can never connect: the SQLite-side refusals must come before any connection. */
const UNREACHABLE: PostgresStoreConfig = { host: "127.0.0.1", port: 1, database: "none", user: "none", password: "none" };

async function sqliteSource(seed?: (store: SqliteStore) => Promise<void>): Promise<void> {
  const store = await SqliteStore.create(sourcePath);
  try {
    await seed?.(store);
  } finally {
    await store.close();
  }
}

describe("parseDbCopyArgs", () => {
  it("reads sqlite:<path>, --to postgres and one of --yes / --dry-run", () => {
    expect(parseDbCopyArgs(["--from", "sqlite:/tmp/a.db", "--to", "postgres", "--yes"])).toEqual({ from: "/tmp/a.db", yes: true, dryRun: false, help: false });
    expect(parseDbCopyArgs(["--", "--from=sqlite:/tmp/a.db", "--to=postgresql", "--dry-run"])).toMatchObject({ from: "/tmp/a.db", dryRun: true });
    expect(parseDbCopyArgs(["--from", "sqlite:rel/a.db", "--to", "postgres", "-y"]).from).toBe(path.resolve("rel/a.db"));
    expect(parseDbCopyArgs(["--from", "sqlite:///abs/a.db", "--to", "postgres", "-y"]).from).toBe("/abs/a.db");
  });

  it("`--from sqlite` is the API's own file: DB_SQLITE_PATH, else apps/api/data/orchestrator.db", () => {
    expect(parseDbCopyArgs(["--from", "sqlite", "--to", "postgres", "--yes"], { DB_SQLITE_PATH: "/srv/l2m.db" }).from).toBe("/srv/l2m.db");
    expect(parseDbCopyArgs(["--from", "sqlite", "--to", "postgres", "--yes"], {}).from).toBe(path.join(API_ROOT, "data", "orchestrator.db"));
  });

  it("refuses a bad --from, a missing or other --to, an unknown flag, and a run with neither or both of --yes / --dry-run", () => {
    const refused = (argv: string[]) => {
      try {
        parseDbCopyArgs(argv, {});
      } catch (error) {
        expect(error).toBeInstanceOf(DbCopyRefusal);
        return (error as Error).message.split("\n")[0];
      }
      throw new Error(`not refused: ${argv.join(" ")}`);
    };
    expect(refused(["--to", "postgres", "--yes"])).toMatch(/--from sqlite:<path> is required/);
    expect(refused(["--from", "mysql://x", "--to", "postgres", "--yes"])).toMatch(/--from must be sqlite:<path>/);
    expect(refused(["--from", "sqlite:", "--to", "postgres", "--yes"])).toMatch(/--from must be sqlite:<path>/);
    expect(refused(["--from", "sqlite:/a.db", "--yes"])).toMatch(/--to postgres is required/);
    expect(refused(["--from", "sqlite:/a.db", "--to", "sqlite", "--yes"])).toMatch(/--to must be postgres/);
    expect(refused(["--from", "sqlite:/a.db", "--to", "postgres"])).toMatch(/without --yes/);
    expect(refused(["--from", "sqlite:/a.db", "--to", "postgres", "--yes", "--dry-run"])).toMatch(/choose one/);
    expect(refused(["--from", "sqlite:/a.db", "--to", "postgres", "--yes", "--force"])).toMatch(/Unknown argument: --force/);
    expect(refused(["--from"])).toMatch(/--from needs a value/);
  });
});

describe("source refusals (before any connection)", () => {
  async function refusal(config: PostgresStoreConfig = UNREACHABLE): Promise<string> {
    const error = await runDbCopy({ sqlitePath: sourcePath, postgres: config, dryRun: true }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(DbCopyRefusal);
    return (error as Error).message;
  }

  it("a missing file, a file that is not SQLite, and an empty SQLite database", async () => {
    expect(await refusal()).toMatch(/no SQLite file at/);
    fs.writeFileSync(sourcePath, "this is not a database, just text that is long enough to have a header ".repeat(4));
    expect(await refusal()).toMatch(/is not a readable SQLite database/);
    fs.rmSync(sourcePath);
    new Database(sourcePath).close();
    expect(await refusal()).toMatch(/holds no tables/);
  });

  it("a source older than this build (a table or column missing): start this build once against it", async () => {
    await sqliteSource();
    const raw = new Database(sourcePath);
    raw.exec(`DROP TABLE budget_alerts; ALTER TABLE audit_logs DROP COLUMN entry_hash;`);
    raw.close();
    const message = await refusal();
    expect(message).toMatch(/older than this build/);
    expect(message).toContain("budget_alerts");
    expect(message).toContain("audit_logs.entry_hash");
    expect(message).toContain(`DB_SQLITE_PATH=${sourcePath} pnpm --filter @ai-orchestrator/api start`);
  });

  it("a source newer than this build (a table or column this build does not know): copy from that build", async () => {
    await sqliteSource();
    const raw = new Database(sourcePath);
    raw.exec(`CREATE TABLE future_feature (id TEXT PRIMARY KEY); ALTER TABLE workflows ADD COLUMN future_column TEXT;`);
    raw.close();
    const message = await refusal();
    expect(message).toMatch(/written by a newer build/);
    expect(message).toContain("future_feature");
    expect(message).toContain("workflows.future_column");
  });

  it("opens the source read-only: its bytes are unchanged, also after a refusal", async () => {
    await sqliteSource(async (store) => {
      await store.writeAuditLog({ id: "a1", eventType: "auth.login", category: "auth", action: "login", outcome: "success" });
    });
    const before = fileHash(sourcePath);
    const raw = new Database(sourcePath);
    raw.exec(`CREATE TABLE future_feature (id TEXT PRIMARY KEY)`);
    raw.close();
    const withExtra = fileHash(sourcePath);
    expect(withExtra).not.toBe(before);
    await refusal();
    expect(fileHash(sourcePath)).toBe(withExtra);
  });
});

describe("the CLI process", () => {
  const tsx = path.join(API_ROOT, "node_modules", ".bin", "tsx");
  const cli = path.join(API_ROOT, "src", "scripts", "db-copy.ts");

  async function cliRun(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
    try {
      const { stdout, stderr } = await run(tsx, [cli, ...args], { env: { ...process.env, ...env }, cwd: dir, timeout: 60_000 });
      return { code: 0, out: stdout + stderr };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  it("exits 0 for --help, 2 for a refusal, and never prints the password", async () => {
    const env = { DB_POSTGRESDB_URL: "postgres://copier:s3cret-pass-word@127.0.0.1:1/none", DB_POSTGRESDB_PASSWORD: "" };
    expect((await cliRun(["--help"], env)).code).toBe(0);
    const badArgs = await cliRun(["--from", "mysql:x", "--to", "postgres", "--yes"], env);
    expect(badArgs.code).toBe(2);
    expect(badArgs.out).toContain("--from must be sqlite:<path>");
    const missing = await cliRun(["--from", "sqlite:./missing.db", "--to", "postgres", "--yes"], env);
    expect(missing.code).toBe(2);
    expect(missing.out).toContain(`Refused: --from: no SQLite file at ${path.join(fs.realpathSync(dir), "missing.db")}`);
    expect(missing.out).toContain("Postgres: postgres copier@127.0.0.1:1/none (no TLS)");
    const invalid = await cliRun(["--from", "sqlite:./missing.db", "--to", "postgres", "--yes"], { DB_POSTGRESDB_URL: "mysql://copier:s3cret-pass-word@h/db" });
    expect(invalid.code).toBe(1);
    expect(invalid.out).toContain("DB_POSTGRESDB_URL must start with postgres://");
    for (const result of [badArgs, missing, invalid]) expect(result.out).not.toContain("s3cret-pass-word");
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------
// Postgres

const postgresUrl = testPostgresUrl();
if (!postgresUrl) noticePostgresSkipped("db:copy");

describe.skipIf(!postgresUrl)("db:copy into Postgres", () => {
  let schema: string;
  let config: PostgresStoreConfig;
  let admin: Pool;
  const opened: Array<{ close(): Promise<void> }> = [];

  beforeEach(() => {
    schema = `t_${randomBytes(6).toString("hex")}`;
    config = postgresStoreConfig(parsePostgresSettings({ DB_POSTGRESDB_URL: postgresUrl }), { schema, maxConnections: 2 });
    admin = new Pool(postgresPoolConfig(config, { max: 1, options: undefined }));
  });

  afterEach(async () => {
    for (const store of opened.splice(0)) await store.close().catch(() => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }, 60_000);

  const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await admin.query(sql.replaceAll("$S", `"${schema}"`), params)).rows as T[];

  async function targetStore(): Promise<PostgresStore> {
    const store = await PostgresStore.create(config);
    opened.push(store);
    return store;
  }

  async function copy(options: { dryRun?: boolean } = {}) {
    const lines: string[] = [];
    const report = await runDbCopy({ sqlitePath: sourcePath, postgres: config, dryRun: options.dryRun, log: (line) => lines.push(line) });
    return { report, lines };
  }

  async function refusalOf(): Promise<string> {
    const error = await copy().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(DbCopyRefusal);
    return (error as Error).message;
  }

  /** Every user table of the target schema with its row count. */
  async function targetCounts(): Promise<Record<string, number>> {
    const tables = await q<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [schema]);
    const counts: Record<string, number> = {};
    for (const { table_name } of tables) {
      counts[table_name] = Number((await q<{ n: string }>(`SELECT COUNT(*)::text AS n FROM $S."${table_name}"`))[0]!.n);
    }
    return counts;
  }

  it("copies into an empty, unmigrated database: migrates it to this build's version, then copies and verifies", async () => {
    await sqliteSource(async (store) => {
      await store.upsertWorkflow({ id: "wf-1", name: "Hello", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);
      await store.writeAuditLog({ id: "a1", eventType: "auth.login", category: "auth", action: "login", outcome: "success" });
    });
    const { report, lines } = await copy();
    expect(report).toMatchObject({ dryRun: false, migratedTarget: true, schemaVersion: CODE_SCHEMA_VERSION });
    expect(CODE_SCHEMA_VERSION).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
    expect(report.tables.find((t) => t.table === "workflows")?.rows).toBe(1);
    expect(report.audit.target).toEqual({ ok: true, rowsChecked: 1 });
    expect(lines.join("\n")).toContain("Start the API on Postgres with the same SECRET_MASTER_KEY_BASE64");
    const store = await targetStore();
    expect((await store.getWorkflow("wf-1"))?.name).toBe("Hello");
    expect(await store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 1 });
  }, 120_000);

  it("--dry-run reports counts and writes nothing: the unmigrated target stays empty, the source unchanged", async () => {
    await sqliteSource(async (store) => {
      await store.upsertWorkflow({ id: "wf-1", name: "Hello", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);
    });
    const before = fileHash(sourcePath);
    const { report, lines } = await copy({ dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.migratedTarget).toBe(true);
    expect(report.tables.find((t) => t.table === "workflows")?.rows).toBe(1);
    expect(lines.join("\n")).toContain("Dry run: nothing was written.");
    expect(await q(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [schema])).toEqual([]);
    expect(fileHash(sourcePath)).toBe(before);

    // On a migrated, empty target too: every table holds what it held before.
    await (await targetStore()).close();
    const counts = await targetCounts();
    const { report: again } = await copy({ dryRun: true });
    expect(again.migratedTarget).toBe(false);
    expect(await targetCounts()).toEqual(counts);
    expect(counts.workflows).toBe(0);
  }, 120_000);

  it("refuses a non-empty target (a user, a workflow, or a row no migration put there) and writes nothing", async () => {
    await sqliteSource();
    const store = await targetStore();
    await store.saveUser({ id: "u1", email: "a@example.com", passwordHash: "x", role: "admin" });
    expect(await refusalOf()).toMatch(/not empty \(users: 1 row/);
    await store.deleteUser("u1");
    await store.upsertWorkflow({ id: "wf-x", name: "X", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);
    expect(await refusalOf()).toMatch(/not empty \(workflows: 1 row/);
    await store.deleteWorkflow("wf-x");
    await q(`INSERT INTO $S.schema_markers (name, created_at) VALUES ('not-from-sqlite', now())`);
    expect(await refusalOf()).toMatch(/schema_markers: 1 row\(s\) not in the source/);
  }, 120_000);

  it("refuses a target at another schema version, newer or older, and a database holding other tables", async () => {
    await sqliteSource();
    await (await targetStore()).close();
    await q(`INSERT INTO $S.schema_migrations (version) VALUES ($1)`, [CODE_SCHEMA_VERSION + 1]);
    expect(await refusalOf()).toMatch(new RegExp(`at schema v${CODE_SCHEMA_VERSION + 1}, newer than this build \\(v${CODE_SCHEMA_VERSION}\\)`));
    await q(`DELETE FROM $S.schema_migrations WHERE version >= $1`, [CODE_SCHEMA_VERSION]);
    expect(await refusalOf()).toMatch(new RegExp(`at schema v${CODE_SCHEMA_VERSION - 1}, this build is at v${CODE_SCHEMA_VERSION}`));

    await q(`DROP SCHEMA $S CASCADE`);
    await q(`CREATE SCHEMA $S`);
    await q(`CREATE TABLE $S.someone_elses (id TEXT)`);
    expect(await refusalOf()).toMatch(/holds 1 table\(s\) \(someone_elses\) but no applied L2M migrations/);
  }, 120_000);

  it("audit text read exactly: Node-20 surrogate rows, NUL rows and ordinary rows verify after the copy; rows Postgres cannot keep are named", async () => {
    await sqliteSource(async (store) => {
      await store.writeAuditLog({ id: "a1", eventType: "auth.login", category: "auth", action: "login", outcome: "success" });
    });
    const raw = new Database(sourcePath);
    appendLegacySqliteAuditRow(raw, "surrogate", { message: "tag \ud800 here" });
    appendLegacySqliteAuditRow(raw, "nul", { userAgent: "agent\u0000x" });
    appendLegacySqliteAuditRow(raw, "two-nul", { message: "a\u0000b\u0000c" });
    appendLegacySqliteAuditRow(raw, "two-surrogates", { message: "\udbff and \udc00" });
    expect((raw.prepare(`SELECT hex(message) AS h FROM audit_logs WHERE id = 'surrogate'`).get() as { h: string }).h).toContain("EDA080");
    raw.close();
    await sqliteSource(async (store) => {
      await store.writeAuditLog({ id: "a2", eventType: "auth.logout", category: "auth", action: "logout", outcome: "success" });
      // SQLite kept every character exactly, so its chain is intact.
      expect(await store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 6 });
    });

    const { report, lines } = await copy();
    expect(report.audit.source).toEqual({ ok: true, rowsChecked: 6 });
    expect(report.audit.becameUnverifiable).toEqual(["two-nul", "two-surrogates"]);
    expect(lines.join("\n")).toContain("2 audit row(s) verified on SQLite cannot be verified on Postgres (two-nul, two-surrogates)");
    const store = await targetStore();
    const verdict = await store.verifyAuditChain();
    expect(verdict).toMatchObject({ ok: false, rowsChecked: 4 });
    expect(verdict.firstBrokenAt).toBeUndefined();
    expect(verdict.unverifiable?.map((row) => row.id)).toEqual(["two-nul", "two-surrogates"]);
    expect(report.audit.target).toEqual(verdict);

    // The next write chains onto the copied rows, with the next seq.
    await store.writeAuditLog({ id: "a3", eventType: "auth.login", category: "auth", action: "login", outcome: "success" });
    expect(await store.verifyAuditChain()).toMatchObject({ ok: false, rowsChecked: 5, unverifiable: [{ id: "two-nul" }, { id: "two-surrogates" }] });
    const seqs = await q<{ id: string; seq: string }>(`SELECT id, seq::text AS seq FROM $S.audit_logs ORDER BY seq`);
    expect(seqs.map((row) => row.id)).toEqual(["a1", "surrogate", "nul", "two-nul", "two-surrogates", "a2", "a3"]);
    expect(seqs.map((row) => Number(row.seq))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  }, 120_000);

  it("seq order is SQLite rowid order (not id or time order), and inserts after the copy continue it", async () => {
    await sqliteSource(async (store) => {
      // Ids sort opposite to insertion, every row at the same time.
      for (const id of ["z", "y", "x", "w"]) {
        await store.writeAuditLog({ id: `audit-${id}`, eventType: "e", category: "c", action: "a", outcome: "success", createdAt: "2026-10-20T10:00:00.000Z" });
      }
      await store.createKnowledgeBase({ id: "kb1", name: "KB", embedderId: "test", dimensions: 2 });
      await store.addKnowledgeBaseChunks({
        knowledgeBaseId: "kb1",
        chunks: ["zeta refund policy", "yankee shipping", "xray returns", "whiskey warranty"].map((content, i) => ({
          id: `chunk-${"zyxw"[i]}`, chunkIndex: i, content, vector: [i, 1]
        }))
      });
    });
    const raw = new Database(sourcePath);
    const rowids = raw.prepare(`SELECT id FROM audit_logs ORDER BY rowid`).all() as Array<{ id: string }>;
    raw.close();
    expect(rowids.map((row) => row.id)).toEqual(["audit-z", "audit-y", "audit-x", "audit-w"]);

    await copy();
    const audit = await q<{ id: string }>(`SELECT id FROM $S.audit_logs ORDER BY seq`);
    expect(audit.map((row) => row.id)).toEqual(["audit-z", "audit-y", "audit-x", "audit-w"]);
    const chunks = await q<{ id: string }>(`SELECT id FROM $S.knowledge_base_chunks ORDER BY seq`);
    expect(chunks.map((row) => row.id)).toEqual(["chunk-z", "chunk-y", "chunk-x", "chunk-w"]);

    const store = await targetStore();
    expect((await store.listKnowledgeBaseChunks("kb1")).map((chunk) => chunk.id)).toEqual(["chunk-z", "chunk-y", "chunk-x", "chunk-w"]);
    // content_tsv is computed by Postgres for the copied rows: keyword search works.
    expect((await store.bm25SearchKnowledgeBase({ knowledgeBaseId: "kb1", query: "warranty", topK: 3 })).map((hit) => hit.id)).toEqual(["chunk-w"]);
    await store.addKnowledgeBaseChunks({ knowledgeBaseId: "kb1", chunks: [{ id: "chunk-a", chunkIndex: 4, content: "alpha", vector: [4, 1] }] });
    expect((await store.listKnowledgeBaseChunks("kb1")).map((chunk) => chunk.id).at(-1)).toBe("chunk-a");
    await store.writeAuditLog({ id: "audit-a", eventType: "e", category: "c", action: "a", outcome: "success" });
    const after = await q<{ id: string; seq: string }>(`SELECT id, seq::text AS seq FROM $S.audit_logs ORDER BY seq DESC LIMIT 1`);
    expect(after).toEqual([{ id: "audit-a", seq: "5" }]);
    expect(await store.verifyAuditChain()).toEqual({ ok: true, rowsChecked: 5 });
  }, 120_000);

  it("a failure rolls the whole copy back: the target is left migrated and empty, and a re-run after the fix succeeds", async () => {
    await sqliteSource(async (store) => {
      await store.saveUser({ id: "u1", email: "a@example.com", passwordHash: "x", role: "admin" });
      await store.upsertWorkflow({ id: "wf-1", name: "Hello", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);
    });
    const raw = new Database(sourcePath);
    raw.prepare(`UPDATE workflows SET updated_at = 'not a time' WHERE id = 'wf-1'`).run();
    raw.close();
    await expect(copy()).rejects.toThrow(/Copying workflows failed in the batch from SQLite rowid 1 to 1: .*not a time/);
    const counts = await targetCounts();
    expect(counts.users).toBe(0);
    expect(counts.workflows).toBe(0);
    expect(counts.schema_migrations).toBeGreaterThan(0);

    const fix = new Database(sourcePath);
    fix.prepare(`UPDATE workflows SET updated_at = created_at WHERE id = 'wf-1'`).run();
    fix.close();
    const { report } = await copy();
    expect(report.migratedTarget).toBe(false);
    expect((await targetCounts()).users).toBe(1);
  }, 120_000);

  it("converts values as the Postgres store writes them: '' timestamps to NULL, fractional integers rounded (reported), NUL in text to U+FFFD", async () => {
    await sqliteSource(async (store) => {
      await store.upsertWorkflow({ id: "wf-1", name: "nul\u0000name", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);
      await store.saveUser({ id: "u1", email: "a@example.com", passwordHash: "x", role: "admin" });
    });
    const raw = new Database(sourcePath);
    raw.prepare(`UPDATE workflows SET workflow_version = 2.5 WHERE id = 'wf-1'`).run();
    raw.prepare(`INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at, revoked_at) VALUES ('s1', 'u1', ?, ?, ?, '')`).run(
      "2026-12-01T00:00:00.000Z", "2026-10-20 10:00:00", "2026-10-20T10:00:00.000Z"
    );
    raw.close();
    const { report } = await copy();
    expect(report.tables.find((t) => t.table === "workflows")?.rounded).toEqual({ workflow_version: 1 });
    const [workflow] = await q<{ name: string; workflow_version: number }>(`SELECT name, workflow_version FROM $S.workflows`);
    expect(workflow).toEqual({ name: "nul�name", workflow_version: 3 });
    // A naive SQLite datetime('now') value is UTC; '' is NULL, as the SQLite store already reads it.
    const [session] = await q<{ created_at: string; revoked_at: string | null }>(`SELECT created_at, revoked_at FROM $S.sessions`);
    expect(session).toEqual({ created_at: "2026-10-20T10:00:00.000Z", revoked_at: null });
  }, 120_000);
});
