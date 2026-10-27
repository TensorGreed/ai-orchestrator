/**
 * Phase 13.1 — the cheaper SQLite audit read (audit-chain.ts readSqliteAuditChainRows / exactSqliteTextRows) against
 * the reader it replaces, which read every text column as bytes (`CAST(column AS BLOB)`) and decoded each with
 * storedSqliteAuditText. The new reader takes the driver's text and re-reads as bytes only rows whose text holds a
 * U+FFFD. Differential fuzz over valid UTF-8, generalized UTF-8 (WTF-8) lone surrogates, invalid bytes, NUL and BLOB
 * values: the fields, and so the verdicts, must be identical. Runs on whichever Node runs the suite (CI: 20; locally
 * also 24, where better-sqlite3 binds strings differently).
 */
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuditChainWalker,
  auditEntryHash,
  exactSqliteTextRows,
  GENESIS_HASH,
  iterateSqliteAuditChainRows,
  readSqliteAuditChainRows,
  SQLITE_AUDIT_TEXT_COLUMNS,
  storedSqliteAuditText,
  verifyAuditRows,
  verifySqliteAuditChain,
  type AuditCanonicalInput,
  type AuditChainRow
} from "./audit-chain.js";

/** The reader before the cheaper read (commit 996c8c3): every text column as bytes, decoded exactly. */
function readAllAsBytes(db: Database.Database): AuditChainRow[] {
  type Bytes = Uint8Array | null;
  const rows = db
    .prepare(
      `SELECT ${SQLITE_AUDIT_TEXT_COLUMNS.map((column) => `CAST(${column} AS BLOB) AS ${column}`).join(", ")}, prev_hash, entry_hash
         FROM audit_logs WHERE entry_hash IS NOT NULL ORDER BY rowid ASC`
    )
    .all() as Array<Record<(typeof SQLITE_AUDIT_TEXT_COLUMNS)[number], Bytes> & { prev_hash: string | null; entry_hash: string | null }>;
  const required = (value: Bytes) => storedSqliteAuditText(value) ?? "";
  return rows.map((row) => ({
    fields: {
      id: required(row.id),
      createdAt: required(row.created_at),
      eventType: required(row.event_type),
      category: required(row.category),
      action: required(row.action),
      outcome: required(row.outcome),
      actorUserId: storedSqliteAuditText(row.actor_user_id),
      actorEmail: storedSqliteAuditText(row.actor_email),
      actorType: required(row.actor_type),
      resourceType: storedSqliteAuditText(row.resource_type),
      resourceId: storedSqliteAuditText(row.resource_id),
      projectId: storedSqliteAuditText(row.project_id),
      ipAddress: storedSqliteAuditText(row.ip_address),
      userAgent: storedSqliteAuditText(row.user_agent),
      metadataJson: storedSqliteAuditText(row.metadata_json),
      message: storedSqliteAuditText(row.message)
    },
    prevHash: String(row.prev_hash ?? ""),
    entryHash: String(row.entry_hash ?? "")
  }));
}

const CREATE_AUDIT_LOGS = `CREATE TABLE audit_logs (
  ${SQLITE_AUDIT_TEXT_COLUMNS.map((column) => `${column} TEXT`).join(",\n  ")},
  prev_hash TEXT, entry_hash TEXT
)`;

/** A small deterministic generator, so a failure names a reproducible seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function utf8(text: string): number[] {
  return [...Buffer.from(text, "utf8")];
}

/** Generalized UTF-8 of one lone surrogate (ED A0–BF 80–BF). */
function wtf8Surrogate(unit: number): number[] {
  return [0xe0 | (unit >> 12), 0x80 | ((unit >> 6) & 0x3f), 0x80 | (unit & 0x3f)];
}

/** EF BB BF: U+FEFF, which a decoder without `ignoreBOM` drops when it leads the value. */
const BOM_BYTES = [0xef, 0xbb, 0xbf];

/**
 * Random bytes for a text column: valid text, WTF-8 surrogates, invalid sequences, NUL and U+FEFF, mixed. A quarter of
 * the values start with EF BB BF (the case a decoder that strips a BOM gets wrong).
 */
function fuzzBytes(random: () => number): number[] {
  const out: number[] = random() < 0.25 ? [...BOM_BYTES] : [];
  const parts = 1 + Math.floor(random() * 6);
  for (let p = 0; p < parts; p++) {
    const kind = Math.floor(random() * 10);
    if (kind === 0) out.push(...utf8("plain ascii text"));
    else if (kind === 1) out.push(...utf8(String.fromCodePoint(Math.floor(random() * 0xd7ff) + 1)));
    else if (kind === 2) out.push(...utf8(String.fromCodePoint(0x10000 + Math.floor(random() * 0xfffff))));
    else if (kind === 3) out.push(...utf8("�")); // a real U+FFFD
    else if (kind === 4) out.push(...wtf8Surrogate(0xd800 + Math.floor(random() * 0x800)));
    else if (kind === 5) out.push(0x00);
    else if (kind === 6) out.push(0x80 + Math.floor(random() * 0x80)); // a stray continuation or lead byte
    else if (kind === 7) out.push(...wtf8Surrogate(0xd800 + Math.floor(random() * 0x400)), ...wtf8Surrogate(0xdc00 + Math.floor(random() * 0x400))); // CESU-8 pair
    else if (kind === 8) out.push(...BOM_BYTES); // U+FEFF anywhere
    else out.push(...[...randomBytesFrom(random, 1 + Math.floor(random() * 4))]);
  }
  return out;
}

function randomBytesFrom(random: () => number, n: number): number[] {
  return Array.from({ length: n }, () => Math.floor(random() * 256));
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(CREATE_AUDIT_LOGS);
});

afterEach(() => {
  db.close();
});

/** Inserts one row whose text columns hold exactly `bytes[column]` (stored as TEXT, not validated), or NULL / a BLOB. */
function insertRaw(values: Partial<Record<(typeof SQLITE_AUDIT_TEXT_COLUMNS)[number] | "prev_hash" | "entry_hash", Buffer | string | null | { blob: Buffer }>>): void {
  const columns = Object.keys(values);
  const placeholders = columns.map((column) => {
    const value = values[column as keyof typeof values];
    return value instanceof Buffer ? "CAST(? AS TEXT)" : "?";
  });
  const params = columns.map((column) => {
    const value = values[column as keyof typeof values];
    return value !== null && typeof value === "object" && "blob" in value ? value.blob : value;
  });
  db.prepare(`INSERT INTO audit_logs (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`).run(...params);
}

describe("the driver's text and the exact bytes", () => {
  it("the driver reads every stored text value as TextDecoder's lenient reading of its bytes (the premise of the cheaper read)", () => {
    const random = rng(0x5eed1);
    // The driver keeps a leading U+FEFF, so the lenient reading it matches is the one that keeps it too.
    const lenient = new TextDecoder("utf-8", { ignoreBOM: true });
    db.exec(`CREATE TABLE t (x TEXT)`);
    const insert = db.prepare(`INSERT INTO t (x) VALUES (CAST(? AS TEXT))`);
    const samples: Buffer[] = [];
    for (let i = 0; i < 20_000; i++) samples.push(Buffer.from(fuzzBytes(random)));
    for (const sample of samples) insert.run(sample);
    const rows = db.prepare(`SELECT x, CAST(x AS BLOB) AS b FROM t ORDER BY rowid`).all() as Array<{ x: string; b: Buffer }>;
    let mismatches = 0;
    rows.forEach((row, i) => {
      expect(Buffer.compare(row.b, samples[i]!)).toBe(0);
      if (row.x !== lenient.decode(row.b)) mismatches += 1;
      // No U+FFFD in the driver's text means the bytes were valid UTF-8, so the exact reading is the same text.
      if (!row.x.includes("�")) expect(storedSqliteAuditText(row.b)).toBe(row.x);
    });
    expect(mismatches).toBe(0);
  });
});

describe("a leading U+FEFF is kept", () => {
  it("by storedSqliteAuditText on each of its paths (valid UTF-8, generalized UTF-8, invalid bytes), as the driver keeps it", () => {
    const cases: Array<[number[], string]> = [
      [[...BOM_BYTES], "\ufeff"],
      [[...BOM_BYTES, ...utf8("wf-1")], "\ufeffwf-1"],
      [[...BOM_BYTES, ...BOM_BYTES, 0x61], "\ufeff\ufeffa"],
      [[...BOM_BYTES, 0x61, ...wtf8Surrogate(0xd800), 0x62], "\ufeffa\ud800b"],
      [[...BOM_BYTES, 0x61, 0xff, 0x62], "\ufeffa\ufffdb"]
    ];
    db.exec(`CREATE TABLE t (x TEXT)`);
    for (const [bytes, text] of cases) {
      expect(storedSqliteAuditText(Uint8Array.from(bytes))).toBe(text);
      db.prepare(`DELETE FROM t`).run();
      db.prepare(`INSERT INTO t (x) VALUES (CAST(? AS TEXT))`).run(Buffer.from(bytes));
      const { x } = db.prepare(`SELECT x FROM t`).get() as { x: string };
      expect(x.startsWith("\ufeff")).toBe(true);
    }
  });

  it("in every text column, through readSqliteAuditChainRows, with and without a U+FFFD in the row", () => {
    for (const [i, extra] of [[0, []], [1, [0xef, 0xbf, 0xbd]], [2, [0xff]], [3, wtf8Surrogate(0xdabc)]] as Array<[number, number[]]>) {
      const values: Parameters<typeof insertRaw>[0] = { prev_hash: "p", entry_hash: `e${i}` };
      for (const column of SQLITE_AUDIT_TEXT_COLUMNS) values[column] = Buffer.from([...BOM_BYTES, ...utf8(`${column}-${i}`), ...(column === "message" ? extra : [])]);
      insertRaw(values);
    }
    const rows = readSqliteAuditChainRows(db);
    expect(rows).toEqual(readAllAsBytes(db));
    for (const row of rows) {
      for (const value of Object.values(row.fields)) expect(value?.startsWith("\ufeff")).toBe(true);
    }
  });
});

describe("readSqliteAuditChainRows equals the all-bytes reader", () => {
  it("on 5,000 fuzzed rows (every text column fuzzed, NULLs and BLOB values included)", () => {
    const random = rng(0xa0d17);
    for (let i = 0; i < 5_000; i++) {
      const values: Parameters<typeof insertRaw>[0] = { prev_hash: "p", entry_hash: `e${i}` };
      for (const column of SQLITE_AUDIT_TEXT_COLUMNS) {
        const pick = random();
        values[column] = pick < 0.1 ? null : pick < 0.13 ? { blob: Buffer.from(fuzzBytes(random)) } : pick < 0.5 ? Buffer.from(utf8(`ok-${i}-${column}`)) : Buffer.from(fuzzBytes(random));
      }
      insertRaw(values);
    }
    expect(readSqliteAuditChainRows(db)).toEqual(readAllAsBytes(db));
  });

  it("on rows written as each Node version's better-sqlite3 binds lone surrogates and NUL (strings, not raw bytes)", () => {
    const strings = ["a\ud800b", "\udfff", "x😀y", "nul\u0000here", "� real", "", "plain", "𐀀\ud800"];
    for (const [i, text] of strings.entries()) {
      db.prepare(`INSERT INTO audit_logs (id, message, user_agent, prev_hash, entry_hash) VALUES (?, ?, ?, 'p', ?)`).run(`s${i}`, text, text, `e${i}`);
    }
    expect(readSqliteAuditChainRows(db)).toEqual(readAllAsBytes(db));
  });

  it("an integer in a text column (TEXT affinity stores it as text) and a NULL vs empty string read the same", () => {
    db.prepare(`INSERT INTO audit_logs (id, message, actor_email, prev_hash, entry_hash) VALUES (?, ?, ?, 'p', 'e')`).run("n1", 42, "");
    db.prepare(`INSERT INTO audit_logs (id, message, actor_email, prev_hash, entry_hash) VALUES (?, ?, ?, 'p', 'f')`).run("n2", 1.5, null);
    const rows = readSqliteAuditChainRows(db);
    expect(rows).toEqual(readAllAsBytes(db));
    expect(rows.map((row) => [row.fields.message, row.fields.actorEmail])).toEqual([["42.0", ""], ["1.5", null]]);
  });

  it("only rows whose text reads with a U+FFFD are read again as bytes", () => {
    db.prepare(`INSERT INTO audit_logs (id, message, prev_hash, entry_hash) VALUES ('plain', 'hello', 'p', 'e1')`).run();
    db.prepare(`INSERT INTO audit_logs (id, message, prev_hash, entry_hash) VALUES ('legacy', CAST(? AS TEXT), 'p', 'e2')`).run(Buffer.from([0x61, ...wtf8Surrogate(0xd800), 0x62]));
    const reads: string[] = [];
    const spy = { prepare: (sql: string) => { reads.push(sql); return db.prepare(sql); } };
    const rows = readSqliteAuditChainRows(spy);
    expect(rows.map((row) => row.fields.message)).toEqual(["hello", "a\ud800b"]);
    expect(reads).toHaveLength(2);
    expect(reads[1]).toMatch(/CAST\("id" AS BLOB\)/);
  });

  it("iterateSqliteAuditChainRows reads the same rows in rowid batches (rows without entry_hash skipped, any batch size)", () => {
    const random = rng(0xba7c4);
    for (let i = 0; i < 1_000; i++) {
      const values: Parameters<typeof insertRaw>[0] = { prev_hash: "p", entry_hash: i % 97 === 0 ? null : `e${i}` };
      for (const column of SQLITE_AUDIT_TEXT_COLUMNS) values[column] = random() < 0.5 ? Buffer.from(fuzzBytes(random)) : Buffer.from(utf8(`ok-${i}`));
      insertRaw(values);
    }
    const all = readSqliteAuditChainRows(db);
    for (const batch of [1, 7, 333, 990, 1_000, 5_000]) expect([...iterateSqliteAuditChainRows(db, batch)]).toEqual(all);
    const reads: string[] = [];
    let batches = 0;
    const spy = {
      prepare: (sql: string) => {
        reads.push(sql);
        const statement = db.prepare(sql);
        return { all: (...params: unknown[]) => ((batches += sql.includes("LIMIT") ? 1 : 0), statement.all(...params)) };
      }
    };
    expect([...iterateSqliteAuditChainRows(spy, 100)]).toHaveLength(all.length);
    expect(batches).toBe(Math.ceil(all.length / 100) + (all.length % 100 === 0 ? 1 : 0));
  });

  it("exactSqliteTextRows leaves rows without a U+FFFD untouched and makes no second read", () => {
    db.prepare(`INSERT INTO audit_logs (id, message) VALUES ('a', 'x')`).run();
    const rows = db.prepare(`SELECT rowid AS r, id, message FROM audit_logs`).all() as Array<Record<string, unknown>>;
    const reads: string[] = [];
    exactSqliteTextRows({ prepare: (sql: string) => { reads.push(sql); return db.prepare(sql); } }, "audit_logs", rows, ["id", "message"], "r");
    expect(reads).toEqual([]);
    expect(rows).toEqual([{ r: 1, id: "a", message: "x" }]);
  });
});

describe("verdicts are identical", () => {
  /** A chain hashed over `written[i]`'s text and stored as `stored[i]` (raw bytes per field), as old builds left it. */
  function writeChain(rows: Array<{ written: Partial<AuditCanonicalInput>; stored?: Partial<Record<keyof AuditCanonicalInput, Buffer>> }>): void {
    let prev = GENESIS_HASH;
    rows.forEach(({ written, stored }, i) => {
      const fields: AuditCanonicalInput = {
        id: `r${i}`, createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`, eventType: "tag.create", category: "workflow",
        action: "create", outcome: "success", actorUserId: null, actorEmail: null, actorType: "user", resourceType: "tag",
        resourceId: null, projectId: null, ipAddress: null, userAgent: null, metadataJson: null, message: null, ...written
      };
      const entryHash = auditEntryHash(prev, fields);
      const column: Record<keyof AuditCanonicalInput, (typeof SQLITE_AUDIT_TEXT_COLUMNS)[number]> = {
        id: "id", createdAt: "created_at", eventType: "event_type", category: "category", action: "action", outcome: "outcome",
        actorUserId: "actor_user_id", actorEmail: "actor_email", actorType: "actor_type", resourceType: "resource_type",
        resourceId: "resource_id", projectId: "project_id", ipAddress: "ip_address", userAgent: "user_agent",
        metadataJson: "metadata_json", message: "message"
      };
      const values: Parameters<typeof insertRaw>[0] = { prev_hash: prev, entry_hash: entryHash };
      for (const key of Object.keys(fields) as Array<keyof AuditCanonicalInput>) {
        const value = fields[key];
        values[column[key]] = stored?.[key] ?? (value === null ? null : Buffer.from(value, "utf8"));
      }
      insertRaw(values);
      prev = entryHash;
    });
  }

  it("over legacy rows (Node 20 WTF-8, Node 24 U+FFFD, NUL), tampered rows and 2,000 fuzzed rows", () => {
    const random = rng(0xc0ffee);
    const rows: Parameters<typeof writeChain>[0] = [
      { written: { message: "ordinary" } },
      { written: { message: "a\ud800b" }, stored: { message: Buffer.from([0x61, ...wtf8Surrogate(0xd800), 0x62]) } },
      { written: { message: "a\udbffb" }, stored: { message: Buffer.from(utf8("a�b")) } },
      { written: { userAgent: "x\u0000y" } },
      { written: { message: "\ud800 two \udc00" }, stored: { message: Buffer.from(utf8("� two �")) } }
    ];
    for (let i = 0; i < 2_000; i++) {
      const bytes = Buffer.from(fuzzBytes(random));
      rows.push({ written: { message: storedSqliteAuditText(bytes) }, stored: random() < 0.7 ? { message: bytes } : undefined });
    }
    // Legitimate rows whose every free-text field starts with U+FEFF, alone and beside a U+FFFD the exact reader
    // must take from the bytes (a real one, and a Node-20 lone surrogate).
    const bomFields = (suffix: string): Partial<AuditCanonicalInput> => ({
      eventType: `\ufefftag.create${suffix}`, category: "\ufeffworkflow", action: "\ufeffcreate", actorUserId: "\ufeffu-1",
      actorEmail: "\ufeffa@example.com", resourceType: "\ufefftag", resourceId: "\ufeffwf-1", projectId: "\ufeffdefault",
      ipAddress: "\ufeff127.0.0.1", userAgent: "\ufeffagent", metadataJson: "\ufeff{}"
    });
    rows.push({ written: { ...bomFields(""), message: "\ufeffplain" } });
    rows.push({ written: { ...bomFields(""), message: "\ufeffreal \ufffd" } });
    rows.push({ written: { ...bomFields(""), message: "\ufeffa\ud800b" }, stored: { message: Buffer.from([...BOM_BYTES, 0x61, ...wtf8Surrogate(0xd800), 0x62]) } });
    rows.push({ written: { message: "honest" }, stored: { message: Buffer.from(utf8("hones\ufffd")) } });
    writeChain(rows);
    const expected = verifyAuditRows(readAllAsBytes(db));
    expect(verifySqliteAuditChain(db)).toEqual(expected);
    // Every row before the tampered last one is walked: the 2-U+FFFD row is unverifiable, the edit is broken.
    expect(expected.unverifiable?.map((row) => row.id)).toContain("r4");
    // The three U+FEFF rows (just before the edited last one) are verified, not unverifiable.
    const unverifiable = new Set(expected.unverifiable?.map((row) => row.id));
    for (const back of [4, 3, 2]) expect(unverifiable.has(`r${rows.length - back}`)).toBe(false);
    expect(expected.firstBrokenAt?.id).toBe(`r${rows.length - 1}`);
  });

  it("AuditChainWalker fed row by row gives verifyAuditRows' verdict, and stops at the break", () => {
    const random = rng(0xfeed);
    const rows: Parameters<typeof writeChain>[0] = [];
    for (let i = 0; i < 300; i++) {
      const bytes = Buffer.from(fuzzBytes(random));
      rows.push({ written: { message: storedSqliteAuditText(bytes) }, stored: random() < 0.7 ? { message: bytes } : undefined });
    }
    rows.push({ written: { message: "honest" }, stored: { message: Buffer.from(utf8("edited")) } });
    rows.push({ written: { message: "after the break" } });
    writeChain(rows);
    const chain = readSqliteAuditChainRows(db);
    const walker = new AuditChainWalker();
    let walked = 0;
    for (const row of chain) {
      walked += 1;
      if (!walker.push(row)) break;
    }
    expect(walker.result()).toEqual(verifyAuditRows(chain));
    expect(walker.result().firstBrokenAt?.id).toBe(`r${rows.length - 2}`);
    expect(walked).toBe(rows.length - 1);
    expect(walker.push(chain.at(-1)!)).toBe(false);
  });

  it("on a clean legacy chain both readers say ok", () => {
    writeChain([
      { written: { resourceId: "\ufeffwf-1", message: "x \ufffd" } },
      { written: { resourceId: "\ufeffwf-2", message: "a\ud800b" }, stored: { message: Buffer.from([0x61, ...wtf8Surrogate(0xd800), 0x62]) } },
      { written: { message: "a\ud800b" }, stored: { message: Buffer.from([0x61, ...wtf8Surrogate(0xd800), 0x62]) } },
      { written: { message: "\ud800\ud800" }, stored: { message: Buffer.from([...wtf8Surrogate(0xd800), ...wtf8Surrogate(0xd800)]) } },
      { written: { message: `random ${randomBytes(4).toString("hex")}` } }
    ]);
    expect(verifySqliteAuditChain(db)).toEqual({ ok: true, rowsChecked: 5 });
    expect(verifyAuditRows(readAllAsBytes(db))).toEqual({ ok: true, rowsChecked: 5 });
  });
});
