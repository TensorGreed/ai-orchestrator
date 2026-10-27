/**
 * Phase 8.4 / 13.1 — the audit-log hash chain, shared by SqliteStore and PostgresStore so both hash and verify the
 * same way.
 *
 * entry_hash = SHA-256(prev_hash || canonical JSON of the row); the first row's prev_hash is 64 zeros. The canonical
 * form is unchanged since Phase 8.4 (audit export consumers recompute it), so nothing here may alter it.
 *
 * ## Text the database cannot store as given (lone surrogates, U+0000)
 *
 * A JS string can hold a lone UTF-16 surrogate. JSON.stringify escapes it as the ASCII text `\ud800`, but the drivers
 * store text as UTF-8, which has no form for it. pg turns it into U+FFFD on every Node version; better-sqlite3 does so
 * on Node 24, while on Node 20 (the runtime image, and CI) it writes the surrogate's 3-byte generalized UTF-8 form
 * (WTF-8: ED A0 80 for U+D800), which reads back through the driver as three U+FFFD. Before this fix the writer hashed
 * the escaped surrogate and stored one of those, so verification could never match that row again and stopped there,
 * leaving every later row unchecked. One builder request (`POST /api/tags {"name":"\ud800"}`) was enough. Postgres
 * also refuses U+0000 in text.
 *
 * Writes now pass every text field through `wellFormedAuditText` (lone surrogate → U+FFFD, as
 * String.prototype.toWellFormed does; U+0000 → U+FFFD, as the Postgres parameter mapping does) **before** hashing and
 * storing, so the hash covers exactly what is stored, on both stores.
 *
 * ## Verifying rows written before the fix (the rule)
 *
 * The stored values are the stored bytes decoded exactly: SqliteStore reads text columns as bytes and decodes them with
 * `storedSqliteAuditText`, so a lone surrogate kept as generalized UTF-8 comes back as that surrogate, whichever Node
 * version wrote the row or verifies it. (The driver's own reading would give three U+FFFD for it.) Postgres text is
 * always valid UTF-8, so its driver's reading is exact.
 *
 * For each row, in insertion order:
 *  1. Its stored prev_hash must equal the previous row's stored entry_hash (64 zeros for the first). Otherwise the
 *     chain is broken at this row.
 *  2. Its hash recomputed over the stored values must equal its stored entry_hash. If so, the row is verified.
 *     Otherwise, if any stored value holds a lone surrogate, the store kept the row's text exactly (no writer stores
 *     one surrogate exactly and replaces another), so nothing was lost that could explain the mismatch. Broken.
 *  3. Otherwise count the U+FFFD characters `k` in the row's free-text fields (LEGACY_TEXT_FIELDS: everything except
 *     id, created_at, outcome, actor_type and metadata_json; metadata was always JSON.stringify'd before storing, so a
 *     lone surrogate there was stored as ASCII `\ud800` and any U+FFFD in it is a real one). Each U+FFFD is either a
 *     real U+FFFD or one of the 2049 characters a store replaced: the 2048 lone surrogates U+D800–U+DFFF (both drivers)
 *     or U+0000 (SQLite stored and hashed it as is; the Postgres parameter mapping stores it as U+FFFD, so a SQLite row
 *     copied to Postgres holds U+FFFD where its hash saw U+0000).
 *     - k = 0: nothing can explain the mismatch. Broken.
 *     - k = 1: every explanation is tried (the 2049 candidates at that position). The canonical text before the
 *       U+FFFD is hashed once and copied per candidate, so the cost is 2049 hashes of the text after it: a few ms
 *       for an ordinary row or a 100 KB row whose U+FFFD is near its end, about 100 ms when a 100 KB text follows it.
 *       Only rows written before the fix (or edited) reach this step. A match proves the row is exactly what was written: it is
 *       verified, like any other row. No match: broken.
 *     - k ≥ 2: the 2049^k explanations cannot all be tried, so tampering cannot be ruled out, and neither can an
 *       honest old row. The row goes into `unverifiable` with the reason; the chain continues from its stored
 *       entry_hash (pinned by the next row's prev_hash), so every later row is still verified. `ok` is false while
 *       any row is unverifiable: the verdict never says "intact" about a row whose content it could not check.
 *
 * What this keeps. A row edited without U+FFFD fails at step 3 (k = 0). A row given one U+FFFD (written after the fix
 * or not) fails, because the full search finds no match. A row given two or more U+FFFD is named in `unverifiable`
 * and the result is `ok: false`, so it is visible, never hidden. Deleting, inserting or reordering rows breaks the
 * prev_hash link at step 1 exactly as before, for unverifiable rows too.
 *
 * What it cannot tell. An unverifiable row is either an honest old row or an edit; nothing stored can say which (a
 * marker on the row would be as unauthenticated as the row). So the report never assumes the benign cause: it names
 * the row by its chain position (walk index, its prev_hash, which the previous row pins, and its entry_hash, which
 * the next row pins) and shows id and created_at as stored, unverified. Compare the row with a backup or an export.
 */
import { createHash } from "node:crypto";

export const GENESIS_HASH = "0".repeat(64);

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const lenientUtf8 = new TextDecoder("utf-8");

/**
 * A SQLite text value from its stored bytes (read with `CAST(column AS BLOB)`), decoded the same on every Node version.
 * Valid UTF-8 decodes as such. Generalized UTF-8 (WTF-8), where a lone surrogate is its own 3-byte sequence, as
 * better-sqlite3 on Node 20 stores it, decodes to that surrogate, so the text is exactly what the writer hashed. Any
 * other bytes decode with U+FFFD for each invalid sequence (TextDecoder's WHATWG rule, as the drivers read them).
 */
export function storedSqliteAuditText(bytes: Uint8Array | null): string | null {
  if (bytes === null) return null;
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return decodeGeneralizedUtf8(bytes) ?? lenientUtf8.decode(bytes);
  }
}

/** WTF-8: UTF-8 that also encodes lone surrogates (ED A0–BF 80–BF). Undefined for anything else, a CESU-8 pair included. */
function decodeGeneralizedUtf8(bytes: Uint8Array): string | undefined {
  const units: number[] = [];
  const continuation = (at: number) => at < bytes.length && (bytes[at]! & 0xc0) === 0x80;
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let code: number;
    if (b0 < 0x80) {
      code = b0;
      i += 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf && continuation(i + 1)) {
      code = ((b0 & 0x1f) << 6) | (bytes[i + 1]! & 0x3f);
      i += 2;
    } else if (b0 >= 0xe0 && b0 <= 0xef && continuation(i + 1) && continuation(i + 2) && (b0 !== 0xe0 || bytes[i + 1]! >= 0xa0)) {
      code = ((b0 & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f);
      i += 3;
    } else if (
      b0 >= 0xf0 && b0 <= 0xf4 && continuation(i + 1) && continuation(i + 2) && continuation(i + 3) &&
      (b0 !== 0xf0 || bytes[i + 1]! >= 0x90) && (b0 !== 0xf4 || bytes[i + 1]! <= 0x8f)
    ) {
      code = ((b0 & 0x07) << 18) | ((bytes[i + 1]! & 0x3f) << 12) | ((bytes[i + 2]! & 0x3f) << 6) | (bytes[i + 3]! & 0x3f);
      i += 4;
    } else {
      return undefined;
    }
    if (code >= 0x10000) {
      units.push(0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff));
      continue;
    }
    // A high then a low surrogate, each in 3 bytes, is CESU-8: a writer encodes that pair in 4 bytes. (A last unit that
    // is a high surrogate came from 3 bytes: a 4-byte sequence ends in a low one.)
    const previous = units[units.length - 1];
    if (code >= 0xdc00 && code <= 0xdfff && previous !== undefined && previous >= 0xd800 && previous <= 0xdbff) {
      return undefined;
    }
    units.push(code);
  }
  let out = "";
  for (let at = 0; at < units.length; at += 0x2000) out += String.fromCharCode(...units.slice(at, at + 0x2000));
  return out;
}

const REPLACEMENT = "�";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATE_OR_NUL = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u0000/g;

/**
 * `value` as every store keeps it on every Node version: lone surrogates and U+0000 become U+FFFD
 * (String.prototype.toWellFormed + NUL), as pg stores them.
 */
export function wellFormedAuditText(value: string): string;
export function wellFormedAuditText(value: string | null): string | null;
export function wellFormedAuditText(value: string | null | undefined): string | null | undefined;
export function wellFormedAuditText(value: string | null | undefined): string | null | undefined {
  return typeof value === "string" ? value.replace(LONE_SURROGATE_OR_NUL, REPLACEMENT) : value;
}

/** A stored audit entry's text fields through wellFormedAuditText; metadata and the rest unchanged. */
export function wellFormedAuditEntry<T extends Record<string, unknown>>(entry: T): T {
  const out: Record<string, unknown> = { ...entry };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "string") out[key] = wellFormedAuditText(value);
  }
  return out as T;
}

export interface AuditCanonicalInput {
  id: string;
  createdAt: string;
  eventType: string;
  category: string;
  action: string;
  outcome: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorType: string;
  resourceType: string | null;
  resourceId: string | null;
  projectId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadataJson: string | null;
  message: string | null;
}

/**
 * Stable JSON of the hashed fields. Explicit field order — do NOT sort, so adding fields in future versions doesn't
 * silently break the chain. New fields go at the end.
 */
export function canonicalAuditPayload(input: AuditCanonicalInput): string {
  return JSON.stringify([
    input.id,
    input.createdAt,
    input.eventType,
    input.category,
    input.action,
    input.outcome,
    input.actorUserId,
    input.actorEmail,
    input.actorType,
    input.resourceType,
    input.resourceId,
    input.projectId,
    input.ipAddress,
    input.userAgent,
    input.metadataJson,
    input.message
  ]);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** entry_hash for a row whose fields are already as stored. */
export function auditEntryHash(prevHash: string, input: AuditCanonicalInput): string {
  return sha256Hex(prevHash + canonicalAuditPayload(input));
}

/**
 * What a single U+FFFD in a legacy row may stand for: the 2048 lone surrogates U+D800–U+DFFF, which both drivers store
 * as U+FFFD, and U+0000, which SQLite stored and hashed as is and the Postgres parameter mapping stores as U+FFFD (a
 * SQLite row copied to Postgres).
 */
const SINGLE_CANDIDATES: readonly number[] = [
  ...Array.from({ length: 0xdfff - 0xd800 + 1 }, (_, i) => 0xd800 + i),
  0x0000
];

/** Free-text fields a lone surrogate could have reached before the fix (see the rule above). */
const LEGACY_TEXT_FIELDS = [
  "eventType",
  "category",
  "action",
  "actorUserId",
  "actorEmail",
  "resourceType",
  "resourceId",
  "projectId",
  "ipAddress",
  "userAgent",
  "message"
] as const satisfies ReadonlyArray<keyof AuditCanonicalInput>;

export interface AuditChainRow {
  /**
   * The hashed fields as stored, decoded exactly (optional text: NULL → null, "" stays ""). On SQLite they may hold a
   * lone surrogate (see storedSqliteAuditText).
   */
  fields: AuditCanonicalInput;
  prevHash: string;
  entryHash: string;
  /**
   * Postgres: the stored created_at has a sub-millisecond part. Writes truncate to milliseconds (the hash covers the
   * millisecond string), so such a value was edited after the write: broken.
   */
  createdAtHasSubMillisecond?: boolean;
}

export interface AuditUnverifiableRow {
  /** As stored, and not checked: the row's content (id and createdAt included) is exactly what could not be verified. */
  id: string;
  /** As stored (unverified), like `id`. */
  createdAt: string;
  /** 1-based position of the row in the walk (insertion order, hashed rows only). */
  position: number;
  /** The row's stored prev_hash, which equals the previous row's entry_hash (checked). */
  prevHash: string;
  /** The row's stored entry_hash; the next row's prev_hash must equal it, or the chain is broken there. */
  entryHash: string;
  reason: string;
}

export interface AuditChainResult {
  ok: boolean;
  rowsChecked: number;
  firstBrokenAt?: { id: string; createdAt: string; expected: string; stored: string };
  /** Rows whose content could not be checked (see the rule above). Present only when not empty. */
  unverifiable?: AuditUnverifiableRow[];
}

/** Step 2 of the rule: whether the store kept this row's text exactly (a lone surrogate in any stored value). */
function holdsLoneSurrogate(fields: AuditCanonicalInput): boolean {
  return Object.values(fields).some((value) => typeof value === "string" && LONE_SURROGATE.test(value));
}

type LegacyOutcome = "verified" | "broken" | "unverifiable";

/** Step 3 of the rule. */
function legacyReplacementCheck(prev: string, row: AuditChainRow): { outcome: LegacyOutcome; replacements: number } {
  let replacements = 0;
  let only: { field: (typeof LEGACY_TEXT_FIELDS)[number]; index: number } | undefined;
  for (const field of LEGACY_TEXT_FIELDS) {
    const value = row.fields[field];
    if (typeof value !== "string") continue;
    for (let index = value.indexOf(REPLACEMENT); index !== -1; index = value.indexOf(REPLACEMENT, index + 1)) {
      replacements += 1;
      only = { field, index };
    }
  }
  if (replacements === 0 || !only) return { outcome: "broken", replacements };
  if (replacements > 1) return { outcome: "unverifiable", replacements };
  const text = row.fields[only.field] as string;
  const before = text.slice(0, only.index);
  const after = text.slice(only.index + 1);
  const withCandidate = (code: number) => ({ ...row.fields, [only.field]: before + String.fromCharCode(code) + after });
  // A neighbour that could pair with a candidate (never in well-formed stored text) would change its escape: then
  // every candidate is built in full.
  const mayPair = /[\uD800-\uDBFF]$/.test(before) || /^[\uDC00-\uDFFF]/.test(after);
  const split = mayPair
    ? undefined
    : splitAtCandidate(canonicalAuditPayload(withCandidate(SINGLE_CANDIDATES[0]!)), canonicalAuditPayload(withCandidate(SINGLE_CANDIDATES[1]!)));
  if (split) {
    // The canonical text is prefix + `\uXXXX` + suffix for every candidate: hash the prefix once, copy it per candidate.
    const head = createHash("sha256").update(prev + split.prefix, "utf8");
    for (const code of SINGLE_CANDIDATES) {
      const digest = head.copy().update(`\\u${code.toString(16).padStart(4, "0")}${split.suffix}`, "utf8").digest("hex");
      if (digest === row.entryHash) return { outcome: "verified", replacements };
    }
    return { outcome: "broken", replacements };
  }
  for (const code of SINGLE_CANDIDATES) {
    if (auditEntryHash(prev, withCandidate(code)) === row.entryHash) return { outcome: "verified", replacements };
  }
  return { outcome: "broken", replacements };
}

/**
 * The canonical texts for the first two candidates split as prefix + 6-character escape + suffix. JSON.stringify writes
 * every lone surrogate and U+0000 as a lowercase `\uXXXX` escape, so the split holds for every candidate; when the two
 * texts do not have that shape, the caller falls back to building each candidate.
 */
function splitAtCandidate(first: string, second: string): { prefix: string; suffix: string } | undefined {
  if (first.length !== second.length) return undefined;
  let start = 0;
  while (start < first.length && first[start] === second[start]) start += 1;
  const at = first.lastIndexOf("\\u", start);
  if (at === -1 || at + 6 > first.length) return undefined;
  if (first.slice(at + 6) !== second.slice(at + 6) || first.slice(0, at) !== second.slice(0, at)) return undefined;
  const escape = (code: number) => `\\u${code.toString(16).padStart(4, "0")}`;
  if (first.slice(at, at + 6) !== escape(SINGLE_CANDIDATES[0]!) || second.slice(at, at + 6) !== escape(SINGLE_CANDIDATES[1]!)) return undefined;
  return { prefix: first.slice(0, at), suffix: first.slice(at + 6) };
}

/** Walks `rows` (insertion order, entry_hash IS NOT NULL) by the rule above. */
export function verifyAuditRows(rows: Iterable<AuditChainRow>): AuditChainResult {
  let prev = GENESIS_HASH;
  let checked = 0;
  let position = 0;
  const unverifiable: AuditUnverifiableRow[] = [];
  const finish = (result: AuditChainResult): AuditChainResult =>
    unverifiable.length > 0 ? { ...result, ok: false, unverifiable } : result;
  for (const row of rows) {
    const { id, createdAt } = row.fields;
    position += 1;
    if (row.prevHash !== prev) {
      return finish({ ok: false, rowsChecked: checked, firstBrokenAt: { id, createdAt, expected: prev, stored: row.prevHash } });
    }
    const expected = auditEntryHash(prev, row.fields);
    if (row.createdAtHasSubMillisecond) {
      return finish({ ok: false, rowsChecked: checked, firstBrokenAt: { id, createdAt, expected, stored: row.entryHash } });
    }
    if (expected !== row.entryHash) {
      if (holdsLoneSurrogate(row.fields)) {
        return finish({ ok: false, rowsChecked: checked, firstBrokenAt: { id, createdAt, expected, stored: row.entryHash } });
      }
      const legacy = legacyReplacementCheck(prev, row);
      if (legacy.outcome === "broken") {
        return finish({ ok: false, rowsChecked: checked, firstBrokenAt: { id, createdAt, expected, stored: row.entryHash } });
      }
      if (legacy.outcome === "unverifiable") {
        unverifiable.push({
          id,
          createdAt,
          position,
          prevHash: row.prevHash,
          entryHash: row.entryHash,
          reason:
            `Content cannot be verified: either a row written before audit text was normalised, or an edit. Compare it ` +
            `with a backup or export. Its hash does not match the stored text, which holds ${legacy.replacements} U+FFFD ` +
            `characters, too many combinations to check. Its id and created_at are as stored (unverified); the row is ` +
            `pinned by its chain position. The chain continues from its stored hash.`
        });
        prev = row.entryHash;
        continue;
      }
    }
    prev = row.entryHash;
    checked += 1;
  }
  return finish({ ok: true, rowsChecked: checked });
}

/**
 * Phase 13.1 — reading SQLite audit text exactly, for verify, db:export and db:copy.
 *
 * The driver reads a stored text value with TextDecoder's lenient rule (U+FFFD for every invalid sequence, a lone
 * surrogate's generalized UTF-8 included), which is what storedSqliteAuditText gives for any value without a U+FFFD:
 * such a value was valid UTF-8, and valid UTF-8 decodes the same both ways (the differential test in
 * sqlite-audit-read.test.ts compares the two readers over valid text, generalized UTF-8 surrogates, invalid bytes and
 * NUL, on Node 20 and 24). So the text is read through the driver, and only rows where a text column reads with a
 * U+FFFD (or as anything but a string or NULL) are read again as bytes (`CAST(column AS BLOB)`) and decoded by
 * storedSqliteAuditText. On a chain of ordinary rows that is one plain read, instead of one Buffer per value.
 */

/** The audit_logs text columns the canonical payload hashes. */
export const SQLITE_AUDIT_TEXT_COLUMNS = [
  "id", "event_type", "category", "action", "outcome", "actor_user_id", "actor_email", "actor_type", "resource_type",
  "resource_id", "project_id", "ip_address", "user_agent", "metadata_json", "message", "created_at"
] as const;

/** What these helpers use of a better-sqlite3 Database (structural, so this module does not load the driver). */
export interface SqliteAuditReader {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

const SQLITE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function sqliteIdentifier(name: string): string {
  if (!SQLITE_IDENTIFIER.test(name)) throw new Error(`Refusing to quote suspicious identifier: ${name}`);
  return `"${name}"`;
}

/** Whether the driver's reading of a text column may differ from its stored bytes decoded exactly. */
function driverTextMayDiffer(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return typeof value !== "string" || value.includes(REPLACEMENT);
}

/**
 * `rows` (read through the driver from `table`, each with its rowid under `rowidKey`) with every column in
 * `textColumns` exactly as stored: rows whose text may differ from the stored bytes are read again as bytes and
 * decoded by storedSqliteAuditText. Other columns, and the rows' order, are unchanged. Rows are changed in place and
 * returned.
 */
export function exactSqliteTextRows<R extends Record<string, unknown>>(
  db: SqliteAuditReader,
  table: string,
  rows: R[],
  textColumns: readonly string[],
  rowidKey: string
): R[] {
  const pending = rows.filter((row) => textColumns.some((column) => driverTextMayDiffer(row[column])));
  if (pending.length === 0) return rows;
  const select = textColumns.map((column) => `CAST(${sqliteIdentifier(column)} AS BLOB) AS ${sqliteIdentifier(column)}`).join(", ");
  const CHUNK = 500;
  for (let at = 0; at < pending.length; at += CHUNK) {
    const chunk = pending.slice(at, at + CHUNK);
    const byRowid = new Map(chunk.map((row) => [Number(row[rowidKey]), row]));
    const bytes = db
      .prepare(`SELECT rowid AS __exact_rowid, ${select} FROM ${sqliteIdentifier(table)} WHERE rowid IN (${chunk.map(() => "?").join(", ")})`)
      .all(...chunk.map((row) => row[rowidKey])) as Array<Record<string, Uint8Array | null> & { __exact_rowid: number | bigint }>;
    for (const stored of bytes) {
      const row = byRowid.get(Number(stored.__exact_rowid));
      if (!row) continue;
      for (const column of textColumns) (row as Record<string, unknown>)[column] = storedSqliteAuditText(stored[column] ?? null);
    }
  }
  return rows;
}

type SqliteAuditTextRow = Record<(typeof SQLITE_AUDIT_TEXT_COLUMNS)[number], string | null> & {
  __rowid: number;
  prev_hash: string | null;
  entry_hash: string | null;
};

/**
 * The hashed audit_logs rows of a SQLite database (entry_hash IS NOT NULL, rowid order), their text exact. An optional
 * field keeps NULL as null and "" as "" (the writer hashes `value ?? null`).
 */
export function readSqliteAuditChainRows(db: SqliteAuditReader): AuditChainRow[] {
  const rows = db
    .prepare(
      `SELECT rowid AS __rowid, ${SQLITE_AUDIT_TEXT_COLUMNS.join(", ")}, prev_hash, entry_hash
         FROM audit_logs WHERE entry_hash IS NOT NULL ORDER BY rowid ASC`
    )
    .all() as SqliteAuditTextRow[];
  exactSqliteTextRows(db, "audit_logs", rows, SQLITE_AUDIT_TEXT_COLUMNS, "__rowid");
  const required = (value: string | null) => value ?? "";
  const text = (value: unknown) => (typeof value === "string" ? value : String(value ?? ""));
  return rows.map((row) => ({
    fields: {
      id: required(row.id),
      createdAt: required(row.created_at),
      eventType: required(row.event_type),
      category: required(row.category),
      action: required(row.action),
      outcome: required(row.outcome),
      actorUserId: row.actor_user_id,
      actorEmail: row.actor_email,
      actorType: required(row.actor_type),
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      projectId: row.project_id,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      metadataJson: row.metadata_json,
      message: row.message
    },
    prevHash: text(row.prev_hash),
    entryHash: text(row.entry_hash)
  }));
}

/** verifyAuditRows over a SQLite database's chain, read by readSqliteAuditChainRows. */
export function verifySqliteAuditChain(db: SqliteAuditReader): AuditChainResult {
  return verifyAuditRows(readSqliteAuditChainRows(db));
}
