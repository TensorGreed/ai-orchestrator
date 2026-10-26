/**
 * Phase 8.4 / 13.1 — the audit-log hash chain, shared by SqliteStore and PostgresStore so both hash and verify the
 * same way.
 *
 * entry_hash = SHA-256(prev_hash || canonical JSON of the row); the first row's prev_hash is 64 zeros. The canonical
 * form is unchanged since Phase 8.4 (audit export consumers recompute it), so nothing here may alter it.
 *
 * ## Text the database cannot store as given (lone surrogates, U+0000)
 *
 * A JS string can hold a lone UTF-16 surrogate. JSON.stringify escapes it as the ASCII text `\ud800`, but both drivers
 * store text as UTF-8, which turns it into U+FFFD. Before this fix the writer hashed the escaped surrogate and stored
 * U+FFFD, so verification could never match that row again and stopped there, leaving every later row unchecked. One
 * builder request (`POST /api/tags {"name":"\ud800"}`) was enough. Postgres also refuses U+0000 in text.
 *
 * Writes now pass every text field through `wellFormedAuditText` (lone surrogate → U+FFFD, as
 * String.prototype.toWellFormed does; U+0000 → U+FFFD, as the Postgres parameter mapping does) **before** hashing and
 * storing, so the hash covers exactly what is stored, on both stores.
 *
 * ## Verifying rows written before the fix (the rule)
 *
 * For each row, in insertion order:
 *  1. Its stored prev_hash must equal the previous row's stored entry_hash (64 zeros for the first). Otherwise the
 *     chain is broken at this row.
 *  2. Its hash recomputed over the stored values must equal its stored entry_hash. If so, the row is verified.
 *  3. Otherwise count the U+FFFD characters `k` in the row's free-text fields (LEGACY_TEXT_FIELDS: everything except
 *     id, created_at, outcome, actor_type and metadata_json; metadata was always JSON.stringify'd before storing, so a
 *     lone surrogate there was stored as ASCII `\ud800` and any U+FFFD in it is a real one). Each U+FFFD is either a
 *     real U+FFFD or one of the 2048 lone surrogates U+D800–U+DFFF that the driver replaced.
 *     - k = 0: nothing can explain the mismatch. Broken.
 *     - k = 1: every explanation is tried (the 2048 surrogates at that position, about 2 ms). A match proves the row
 *       is exactly what was written: it is verified, like any other row. No match: broken.
 *     - k ≥ 2: the 2049^k explanations cannot all be tried, so tampering cannot be ruled out, and neither can an
 *       honest old row. The row goes into `unverifiable` with the reason; the chain continues from its stored
 *       entry_hash (pinned by the next row's prev_hash), so every later row is still verified. `ok` is false while
 *       any row is unverifiable: the verdict never says "intact" about a row whose content it could not check.
 *
 * What this keeps. A row edited without U+FFFD fails at step 3 (k = 0). A row given one U+FFFD (written after the fix
 * or not) fails, because the full search finds no match. A row given two or more U+FFFD is named in `unverifiable`
 * and the result is `ok: false`, so it is visible, never hidden. Deleting, inserting or reordering rows breaks the
 * prev_hash link at step 1 exactly as before, for unverifiable rows too.
 */
import { createHash } from "node:crypto";

export const GENESIS_HASH = "0".repeat(64);

const REPLACEMENT = "�";
const LONE_SURROGATE_OR_NUL = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u0000/g;

/** `value` as both drivers store it: lone surrogates and U+0000 become U+FFFD (String.prototype.toWellFormed + NUL). */
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
  /** The hashed fields as stored (optional text: NULL → null, "" stays ""). */
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
  id: string;
  createdAt: string;
  reason: string;
}

export interface AuditChainResult {
  ok: boolean;
  rowsChecked: number;
  firstBrokenAt?: { id: string; createdAt: string; expected: string; stored: string };
  /** Rows whose content could not be checked (see the rule above). Present only when not empty. */
  unverifiable?: AuditUnverifiableRow[];
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
  for (let code = 0xd800; code <= 0xdfff; code += 1) {
    const candidate = { ...row.fields, [only.field]: before + String.fromCharCode(code) + after };
    if (auditEntryHash(prev, candidate) === row.entryHash) return { outcome: "verified", replacements };
  }
  return { outcome: "broken", replacements };
}

/** Walks `rows` (insertion order, entry_hash IS NOT NULL) by the rule above. */
export function verifyAuditRows(rows: Iterable<AuditChainRow>): AuditChainResult {
  let prev = GENESIS_HASH;
  let checked = 0;
  const unverifiable: AuditUnverifiableRow[] = [];
  const finish = (result: AuditChainResult): AuditChainResult =>
    unverifiable.length > 0 ? { ...result, ok: false, unverifiable } : result;
  for (const row of rows) {
    const { id, createdAt } = row.fields;
    if (row.prevHash !== prev) {
      return finish({ ok: false, rowsChecked: checked, firstBrokenAt: { id, createdAt, expected: prev, stored: row.prevHash } });
    }
    const expected = auditEntryHash(prev, row.fields);
    if (row.createdAtHasSubMillisecond) {
      return finish({ ok: false, rowsChecked: checked, firstBrokenAt: { id, createdAt, expected, stored: row.entryHash } });
    }
    if (expected !== row.entryHash) {
      const legacy = legacyReplacementCheck(prev, row);
      if (legacy.outcome === "broken") {
        return finish({ ok: false, rowsChecked: checked, firstBrokenAt: { id, createdAt, expected, stored: row.entryHash } });
      }
      if (legacy.outcome === "unverifiable") {
        unverifiable.push({
          id,
          createdAt,
          reason:
            `The hash does not match the stored text, which holds ${legacy.replacements} U+FFFD characters. A row ` +
            `written before audit text was normalised could have had lone surrogates there, and there are too many ` +
            `combinations to check, so this row's content cannot be verified. The chain continues from its stored hash.`
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
