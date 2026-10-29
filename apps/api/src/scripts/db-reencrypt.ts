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
import { ENCRYPTED_COLUMNS, SEALED_COLUMNS } from "./db-shared.js";

/** The first line of `file`, trimmed: a key file as `echo "$KEY" > file` writes it. Never echoes the content. */
export function readKeyFile(file: string): string {
  let content: string;
  try {
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

export function reencryptRows(
  table: string,
  rows: Record<string, unknown>[],
  sourceKey: Buffer,
  destKey: Buffer
): { rows: Record<string, unknown>[]; touched: number } {
  const sealed = SEALED_COLUMNS[table];
  if (sealed) {
    let resealed = 0;
    const out = rows.map((row) => {
      const value = row[sealed.column];
      if (typeof value !== "string" || value === "") return row;
      resealed++;
      return { ...row, [sealed.column]: resealValue(value, sealed.purpose, sourceKey, destKey) };
    });
    return { rows: out, touched: resealed };
  }
  const cols = ENCRYPTED_COLUMNS[table];
  if (!cols) return { rows, touched: 0 };
  let touched = 0;
  const out = rows.map((row) => {
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
    const fresh = reencryptBlob(String(iv), String(authTag), String(ciphertext), sourceKey, destKey);
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
