/**
 * Re-encryption for db:import --source-master-key / --source-master-key-file: the encrypted columns
 * (ENCRYPTED_COLUMNS: iv / auth tag / ciphertext, AES-256-GCM) and sealed values (SEALED_COLUMNS:
 * SecretService.sealValue's `v1.<iv>.<tag>.<ciphertext>` with the purpose as AAD) are opened with the key the
 * backup was written with and encrypted again with the destination's SECRET_MASTER_KEY_BASE64. No value is ever
 * logged.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ENCRYPTED_COLUMNS, JSON_SEALED_FIELDS, SEALED_COLUMNS } from "./db-shared.js";

/**
 * The first line of `file`, trimmed: a key file as `echo "$KEY" > file` writes it. Never echoes the content. Warns
 * (through `warn`) when the file is readable by its group or by others.
 */
export function readKeyFile(file: string, warn: (line: string) => void = () => undefined): string {
  let content: string;
  try {
    const mode = fs.statSync(path.resolve(file)).mode;
    if (process.platform !== "win32" && (mode & 0o077) !== 0) {
      warn(`Warning: ${file} is readable by its group or others (mode ${(mode & 0o777).toString(8)}); restrict it with chmod 600.`);
    }
    content = fs.readFileSync(path.resolve(file), "utf8");
  } catch (error) {
    throw new Error(`--source-master-key-file: cannot read ${file} (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
  const key = content.split(/\r?\n/)[0]?.trim() ?? "";
  if (!key) throw new Error(`--source-master-key-file: ${file} is empty`);
  return key;
}

export function reencryptBlob(
  iv: string,
  authTag: string,
  ciphertext: string,
  sourceKey: Buffer,
  destKey: Buffer
): { iv: string; authTag: string; ciphertext: string } {
  const decipher = crypto.createDecipheriv("aes-256-gcm", sourceKey, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final()
  ]);

  const newIv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", destKey, newIv);
  const newCiphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const newAuthTag = cipher.getAuthTag();
  return {
    iv: newIv.toString("base64"),
    authTag: newAuthTag.toString("base64"),
    ciphertext: newCiphertext.toString("base64")
  };
}

/** A SecretService.sealValue value (`v1.<iv>.<tag>.<ciphertext>`, purpose as AAD) opened with one key, sealed with another. */
export function resealValue(sealed: string, purpose: string, sourceKey: Buffer, destKey: Buffer): string {
  const [format, iv, authTag, ciphertext] = sealed.split(".");
  if (format !== "v1" || !iv || !authTag || ciphertext === undefined) throw new Error("Sealed value has an unknown format");
  const aad = Buffer.from(`l2m:${purpose}`, "utf8");
  const decipher = crypto.createDecipheriv("aes-256-gcm", sourceKey, Buffer.from(iv, "base64"));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
  const newIv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", destKey, newIv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ["v1", newIv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

/** Calls `fn`, turning a decryption failure into one that names the table (never a key or value). */
function opening<T>(table: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof Error && /unknown format/.test(error.message)) throw new Error(`${table}: ${error.message}`);
    throw new Error(`${table}: cannot decrypt with --source-master-key (wrong key?)`);
  }
}

/** Re-seals every `key` string inside a parsed JSON value (nested objects and arrays too); returns how many. */
function resealJson(value: unknown, key: string, purpose: string, sourceKey: Buffer, destKey: Buffer): number {
  if (Array.isArray(value)) return value.reduce((n: number, item) => n + resealJson(item, key, purpose, sourceKey, destKey), 0);
  if (!value || typeof value !== "object") return 0;
  let count = 0;
  const record = value as Record<string, unknown>;
  for (const [field, inner] of Object.entries(record)) {
    if (field === key && typeof inner === "string" && inner !== "") {
      record[field] = resealValue(inner, purpose, sourceKey, destKey);
      count++;
    } else {
      count += resealJson(inner, key, purpose, sourceKey, destKey);
    }
  }
  return count;
}

/**
 * Rows of `table` with every value encrypted under `sourceKey` (ENCRYPTED_COLUMNS, SEALED_COLUMNS and the sealed
 * fields inside JSON columns, JSON_SEALED_FIELDS) encrypted again under `destKey`. Returns the rows and how many values
 * were re-encrypted. A value the source key cannot open fails with the table's name.
 */
export function reencryptRows(
  table: string,
  rows: Record<string, unknown>[],
  sourceKey: Buffer,
  destKey: Buffer
): { rows: Record<string, unknown>[]; touched: number } {
  let touched = 0;
  let out = rows;
  const sealed = SEALED_COLUMNS[table];
  if (sealed) {
    out = out.map((row) => {
      const value = row[sealed.column];
      if (typeof value !== "string" || value === "") return row;
      touched++;
      return { ...row, [sealed.column]: opening(table, () => resealValue(value, sealed.purpose, sourceKey, destKey)) };
    });
  }
  for (const field of JSON_SEALED_FIELDS.filter((entry) => entry.table === table)) {
    out = out.map((row) => {
      const raw = row[field.column];
      if (raw === null || raw === undefined) return row;
      // The column holds JSON text (SQLite, and Postgres TEXT) or, read from a JSON column, the parsed value.
      const parsed: unknown = typeof raw === "string" ? (raw.includes(field.key) ? JSON.parse(raw) : undefined) : structuredClone(raw);
      if (parsed === undefined) return row;
      const count = opening(table, () => resealJson(parsed, field.key, field.purpose, sourceKey, destKey));
      if (count === 0) return row;
      touched += count;
      return { ...row, [field.column]: typeof raw === "string" ? JSON.stringify(parsed) : parsed };
    });
  }
  const cols = ENCRYPTED_COLUMNS[table];
  if (!cols) return { rows: out, touched };
  out = out.map((row) => {
    const iv = row[cols.iv];
    const authTag = row[cols.authTag];
    const ciphertext = row[cols.ciphertext];
    // Skip rows where the encrypted columns are null (e.g. log_stream_destinations
    // can be configured without the optional config blob).
    if (
      iv === null || iv === undefined || iv === "" ||
      authTag === null || authTag === undefined || authTag === "" ||
      ciphertext === null || ciphertext === undefined || ciphertext === ""
    ) {
      if (cols.required) {
        throw new Error(
          `${table}: row missing required encrypted blob (iv/authTag/ciphertext)`
        );
      }
      return row;
    }
    const fresh = opening(table, () => reencryptBlob(String(iv), String(authTag), String(ciphertext), sourceKey, destKey));
    touched++;
    return {
      ...row,
      [cols.iv]: fresh.iv,
      [cols.authTag]: fresh.authTag,
      [cols.ciphertext]: fresh.ciphertext
    };
  });
  return { rows: out, touched };
}

/**
 * Without --source-master-key, whether the destination's key opens the backup: the first encrypted row of `secrets`
 * and of `mfa_secrets` that the backup holds. Returns the tables it cannot open (empty when it opens them, or when the
 * backup holds none). Names no key.
 */
export function tablesTheKeyCannotOpen(tables: Record<string, Record<string, unknown>[] | undefined>, key: Buffer): string[] {
  const failing: string[] = [];
  for (const table of ["secrets", "mfa_secrets"]) {
    const cols = ENCRYPTED_COLUMNS[table]!;
    const row = (tables[table] ?? []).find((candidate) => candidate[cols.iv] && candidate[cols.authTag] && candidate[cols.ciphertext]);
    if (!row) continue;
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(String(row[cols.iv]), "base64"));
      decipher.setAuthTag(Buffer.from(String(row[cols.authTag]), "base64"));
      decipher.update(Buffer.from(String(row[cols.ciphertext]), "base64"));
      decipher.final();
    } catch {
      failing.push(table);
    }
  }
  return failing;
}
