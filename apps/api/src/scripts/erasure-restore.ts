/**
 * 13.3 — re-applying data-subject erasures after a restore (db:import, db:copy). A backup written before an erasure
 * still holds the erased rows; the tombstones (erasure_tombstones) say what was erased, and are re-applied inside the
 * restore's transaction, after the rows are loaded: "re-applied N erasures". Tombstones that name an agent memory
 * session or a staff member by a keyed hash need the subject key, opened with SECRET_MASTER_KEY_BASE64; without it the
 * restore is refused (rolled back).
 *
 * An operator may skip this with --skip-erasures --i-understand (refused without the second flag). The restore then
 * leaves a marker the next API start audits (data_subject.erasures_skipped_on_restore) and removes.
 */
import crypto from "node:crypto";
import { RESTORE_SKIPPED_KIND, reapplyErasures, type ErasureExecutor, type ReapplyReport } from "../db/erasure.js";

/** The purpose the subject key is sealed with (SubjectRequestService SUBJECT_KEY_PURPOSE). */
const SUBJECT_KEY_PURPOSE = "subject-ref";

/** Thrown when tombstones need the subject key and it cannot be opened: the restore is refused. */
export class ErasureKeyMissing extends Error {
  constructor(
    readonly tombstones: number,
    readonly noKeyRow = false
  ) {
    super(
      `${tombstones} erasure tombstone(s) name agent memory or a staff member by a keyed hash and cannot be re-applied: ` +
        (noKeyRow
          ? `neither the backup nor the destination holds a subject key (the key they were made with is gone). `
          : `the subject key cannot be opened with SECRET_MASTER_KEY_BASE64. Set it to the master key the database was ` +
            `written with, or give the backup's with --source-master-key-file. `) +
        `Passing --skip-erasures --i-understand restores without re-applying any erasure (audited at the next start). ` +
        `Nothing was changed.`
    );
    this.name = "ErasureKeyMissing";
  }
}

/** Opens a SecretService.sealValue value (`v1.<iv>.<tag>.<ciphertext>`, purpose as AAD) with `key`; null when it cannot. */
export function openSealed(sealed: string, purpose: string, key: Buffer): string | null {
  const [format, iv, authTag, ciphertext] = sealed.split(".");
  if (format !== "v1" || !iv || !authTag || ciphertext === undefined) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(`l2m:${purpose}`, "utf8"));
    decipher.setAuthTag(Buffer.from(authTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** A sealed subject key opened with the master key; null when it cannot be. */
export function openSubjectKey(sealed: string, masterKey: Buffer): Buffer | null {
  const opened = openSealed(sealed, SUBJECT_KEY_PURPOSE, masterKey);
  if (opened === null) return null;
  const key = Buffer.from(opened, "base64");
  return key.length === 32 ? key : null;
}

/** The restored database's sealed subject key, or null when it holds none. */
async function restoredSealedKey(exec: ErasureExecutor): Promise<string | null> {
  const row = (await exec.all("SELECT key_sealed FROM subject_ref_keys WHERE id = 'default'", []))[0];
  return row && typeof row.key_sealed === "string" ? row.key_sealed : null;
}

/** The restored database's subject key, opened with the master key; null when there is none or it cannot be opened. */
export async function restoredSubjectKey(exec: ErasureExecutor, masterKey: Buffer | null): Promise<Buffer | null> {
  if (!masterKey) return null;
  const sealed = await restoredSealedKey(exec);
  return sealed ? openSubjectKey(sealed, masterKey) : null;
}

export interface RestoreErasuresOptions {
  /** --skip-erasures --i-understand: re-apply nothing, leave a marker the next start audits. */
  skip?: boolean;
  /** SECRET_MASTER_KEY_BASE64 of the restored database (opens the subject key). */
  masterKey?: Buffer | null;
  /** Other sealed subject keys carried tombstones may be keyed with (the destination's before a replace). */
  extraSealedKeys?: readonly string[];
  log?: (line: string) => void;
  warn?: (line: string) => void;
  now?: () => Date;
}

export interface RestoreErasuresReport extends ReapplyReport {
  skipped: boolean;
}

/** Re-applies the restored database's tombstones, or (skip) records that a restore skipped them. */
export async function reapplyAfterRestore(exec: ErasureExecutor, options: RestoreErasuresOptions = {}): Promise<RestoreErasuresReport> {
  const log = options.log ?? (() => undefined);
  const warn = options.warn ?? log;
  const now = (options.now ?? (() => new Date()))();
  if (options.skip) {
    await exec.run("INSERT INTO erasure_tombstones (kind, row_id, request_id, erased_at) VALUES (?, ?, NULL, ?)", [
      RESTORE_SKIPPED_KIND,
      `restore-${crypto.randomUUID()}`,
      now.toISOString()
    ]);
    warn(
      "WARNING: erasures were NOT re-applied (--skip-erasures --i-understand): data erased by data-subject requests after this " +
        "backup was written may be back. The next API start records this in the audit log."
    );
    return { erasures: 0, rowsChanged: 0, needKey: 0, rowsKept: 0, skipped: true };
  }
  const masterKey = options.masterKey ?? null;
  const sealed = await restoredSealedKey(exec);
  const sealedKeys = [...new Set([...(sealed ? [sealed] : []), ...(options.extraSealedKeys ?? [])])];
  const keys: Buffer[] = [];
  for (const candidate of sealedKeys) {
    const key = masterKey ? openSubjectKey(candidate, masterKey) : null;
    if (key && !keys.some((known) => known.equals(key))) keys.push(key);
  }
  // The first key re-applies every tombstone; another key (the destination's before a replace) re-applies the keyed
  // ones made with it (an id-named tombstone applied twice changes nothing the second time).
  let report = await reapplyErasures(exec, keys[0] ?? null);
  for (const key of keys.slice(1)) {
    const more = await reapplyErasures(exec, key);
    report = { erasures: report.erasures, rowsChanged: report.rowsChanged + more.rowsChanged, needKey: 0, rowsKept: report.rowsKept + more.rowsKept };
  }
  if (report.needKey > 0) throw new ErasureKeyMissing(report.needKey, sealedKeys.length === 0);
  log(
    `Erasures: re-applied ${report.erasures} erasure${report.erasures === 1 ? "" : "s"}` +
      (report.rowsChanged > 0 ? ` (${report.rowsChanged} row(s) the backup brought back were deleted or pseudonymised again)` : "") +
      (report.rowsKept > 0
        ? `; ${report.rowsKept} row(s) left: created after their erasure (a session id or email used again), kept by a legal hold, or the only admin.`
        : ".")
  );
  return { ...report, skipped: false };
}

/** The four tombstone columns of `rows`, each (kind, row_id) once. */
export function tombstoneRows(rows: ReadonlyArray<Record<string, unknown>>): Array<{ kind: string; row_id: string; request_id: string | null; erased_at: unknown }> {
  const seen = new Set<string>();
  const out: Array<{ kind: string; row_id: string; request_id: string | null; erased_at: unknown }> = [];
  for (const row of rows) {
    if (typeof row.kind !== "string" || typeof row.row_id !== "string" || row.kind === RESTORE_SKIPPED_KIND) continue;
    const key = `${row.kind}\u0000${row.row_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: row.kind,
      row_id: row.row_id,
      request_id: typeof row.request_id === "string" ? row.request_id : null,
      erased_at: row.erased_at instanceof Date ? row.erased_at.toISOString() : String(row.erased_at ?? new Date().toISOString())
    });
  }
  return out;
}
