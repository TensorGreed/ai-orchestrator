/**
 * pnpm --filter @ai-orchestrator/api db:import -- --in backup.json --yes \
 *     [--source-master-key <base64>]
 *
 * Restores a backup written by db:export into the configured DB. Default
 * mode is destructive: every exported table is TRUNCATEd before insert.
 * Use --merge to insert without truncating (best-effort; conflicts will
 * abort the import).
 *
 * Re-encryption: if the backup was made with a different
 * SECRET_MASTER_KEY_BASE64 than the current one, pass the original key as
 * --source-master-key. The importer will decrypt every encrypted blob with
 * the source key and re-encrypt with the current SECRET_MASTER_KEY_BASE64
 * before insert.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  EXPORTED_TABLES,
  ENCRYPTED_COLUMNS,
  openBackupAdapter
} from "./db-shared.js";

interface Args {
  in: string;
  yes: boolean;
  sourceMasterKey: string | null;
  merge: boolean;
}

interface DumpFile {
  format: string;
  formatVersion: number;
  schemaVersion: number;
  exportedAt: string;
  dbType: "sqlite" | "postgres";
  tables: Record<string, Record<string, unknown>[]>;
}

function parseArgs(argv: string[]): Args {
  let inPath: string | null = null;
  let yes = false;
  let sourceMasterKey: string | null = null;
  let merge = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--in" || arg === "-i") {
      const next = argv[++i];
      if (next === undefined) throw new Error("--in requires a path");
      inPath = next;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--source-master-key") {
      const next = argv[++i];
      if (next === undefined) throw new Error("--source-master-key requires a base64 key");
      sourceMasterKey = next;
    } else if (arg === "--merge") {
      merge = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!inPath) throw new Error("--in <file.json> is required");
  return { in: inPath, yes, sourceMasterKey, merge };
}

function printUsageAndExit(code: number): never {
  console.log(
    [
      "Usage: pnpm --filter @ai-orchestrator/api db:import -- --in <file.json> --yes \\",
      "         [--source-master-key <base64>] [--merge]",
      "",
      "Options:",
      "  --in, -i <file.json>       Backup file produced by db:export.",
      "  --yes, -y                  Confirm the operation. Required.",
      "  --source-master-key <b64>  Base64 master key the backup was encrypted with.",
      "                             Required when rotating SECRET_MASTER_KEY_BASE64.",
      "  --merge                    Insert without truncating (default: truncate first).",
      "  --help, -h                 Show this message.",
      "",
      "Default mode TRUNCATES every restored table before insert. The destination",
      "DB must be the same kind (sqlite or postgres) as the source — cross-store",
      "restore is not supported because column types differ."
    ].join("\n")
  );
  process.exit(code);
}

function loadKey(b64: string, label: string): Buffer {
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== 32) {
    throw new Error(`${label} must decode to 32 bytes (got ${buf.length})`);
  }
  return buf;
}

function reencryptBlob(
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

function reencryptRows(
  table: string,
  rows: Record<string, unknown>[],
  sourceKey: Buffer,
  destKey: Buffer
): { rows: Record<string, unknown>[]; touched: number } {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.yes) {
    console.error("Refusing to run without --yes. db:import is destructive by default.");
    process.exit(2);
  }

  const inPath = path.resolve(args.in);
  const raw = fs.readFileSync(inPath, "utf8");
  const dump = JSON.parse(raw) as DumpFile;

  if (dump.format !== "ai-orchestrator-backup") {
    throw new Error(`Unrecognized backup file (format=${dump.format})`);
  }
  if (dump.formatVersion !== 1) {
    throw new Error(`Unsupported backup formatVersion: ${dump.formatVersion}`);
  }

  const adapter = await openBackupAdapter();
  try {
    if (dump.dbType !== adapter.kind) {
      throw new Error(
        `Cross-store restore not supported: backup is ${dump.dbType}, destination is ${adapter.kind}. ` +
          `Boot a matching DB (DB_TYPE=${dump.dbType}) and re-run.`
      );
    }
    const destSchemaVersion = await adapter.schemaVersion();
    if (dump.schemaVersion > destSchemaVersion) {
      throw new Error(
        `Backup schema v${dump.schemaVersion} is newer than destination v${destSchemaVersion}. ` +
          `Upgrade the destination first.`
      );
    }

    const destKeyB64 = process.env.SECRET_MASTER_KEY_BASE64;
    if (!destKeyB64) {
      throw new Error("SECRET_MASTER_KEY_BASE64 is required to import (used to verify or re-encrypt secrets).");
    }
    const destKey = loadKey(destKeyB64, "SECRET_MASTER_KEY_BASE64");
    const sourceKey = args.sourceMasterKey ? loadKey(args.sourceMasterKey, "--source-master-key") : null;
    const willReencrypt = sourceKey !== null && Buffer.compare(sourceKey, destKey) !== 0;

    if (willReencrypt) {
      console.log("Re-encrypting secrets with the current SECRET_MASTER_KEY_BASE64...");
    } else if (sourceKey) {
      console.log("--source-master-key matches current SECRET_MASTER_KEY_BASE64; skipping re-encryption.");
    }

    if (!args.merge) {
      console.log("Truncating destination tables...");
      // Truncate in reverse so a later non-cascading SQLite delete doesn't
      // hit a parent before its children. CASCADE on Postgres makes this
      // moot, but the symmetry keeps both paths predictable.
      for (const table of [...EXPORTED_TABLES].reverse()) {
        try {
          await adapter.truncate(table);
        } catch (err) {
          console.warn(`  ${table}: truncate skipped (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }

    let totalInserted = 0;
    let totalReencrypted = 0;
    for (const table of EXPORTED_TABLES) {
      const rows = dump.tables[table];
      if (!rows || rows.length === 0) {
        console.log(`  ${table}: 0 rows`);
        continue;
      }
      const sourceForRe = sourceKey ?? destKey;
      const { rows: prepared, touched } = willReencrypt
        ? reencryptRows(table, rows, sourceForRe, destKey)
        : { rows, touched: 0 };
      try {
        await adapter.insertRows(table, prepared);
        totalInserted += prepared.length;
        totalReencrypted += touched;
        console.log(`  ${table}: ${prepared.length} rows${touched > 0 ? ` (${touched} re-encrypted)` : ""}`);
      } catch (err) {
        throw new Error(
          `Failed to insert into ${table}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    console.log(
      `\nRestored ${totalInserted} rows from ${inPath} ` +
        `(backup schema v${dump.schemaVersion} -> destination v${destSchemaVersion}, ${adapter.kind})` +
        (totalReencrypted > 0 ? `. Re-encrypted ${totalReencrypted} secrets.` : "")
    );
  } finally {
    await adapter.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
