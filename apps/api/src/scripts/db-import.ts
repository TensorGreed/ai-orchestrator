/**
 * pnpm --filter @ai-orchestrator/api db:import -- --in backup.json --yes \
 *     [--source-master-key <base64> | --source-master-key-file <path>]
 *
 * Restores a backup written by db:export into the configured DB. By default
 * the destination must hold no exported row (an empty database, or one the
 * API never started on); a database that holds data is refused. --replace
 * empties every exported table first, including ones the backup does not
 * hold, so the result is exactly the backup. --merge inserts without
 * emptying anything (best-effort; conflicts will abort the import). Each
 * table is logged as restored, emptied (not in the backup) or untouched.
 * --replace is refused while the destination has active legal holds (13.3);
 * --allow-replace-held goes ahead anyway.
 *
 * Without --source-master-key, the backup's first secrets and mfa_secrets
 * rows must open with SECRET_MASTER_KEY_BASE64, or the import is refused
 * (--allow-key-mismatch restores anyway; neither key is ever printed).
 * A backup holding neither is not checked against the key.
 *
 * Re-encryption: if the backup was made with a different
 * SECRET_MASTER_KEY_BASE64 than the current one, pass the original key as
 * --source-master-key. The importer will decrypt every encrypted blob with
 * the source key and re-encrypt with the current SECRET_MASTER_KEY_BASE64
 * before insert. --source-master-key-file reads the key from a file instead
 * (the first line, trimmed), so it never appears in the process list or the
 * shell history.
 *
 * 13.3 — erasures: after loading, every erasure tombstone is re-applied (the backup's, the destination's own from
 * before a --replace, and those of --erasures-from <newer-backup.json>), so rows a data-subject deletion removed after
 * the backup was written are deleted again; it prints "re-applied N erasures". Tombstones that name agent memory or a
 * staff member need the subject key, opened with SECRET_MASTER_KEY_BASE64. --skip-erasures restores without re-applying
 * them, only together with --i-understand, and the next API start audits it.
 *
 * The whole restore is one transaction. When the backup records its audit
 * chain's verdict (db:export writes it), the restored chain is verified
 * before committing and must give the same verdict, except rows that become
 * unverifiable because this store cannot keep a character they hold (two or
 * more U+FFFD once U+0000 and lone surrogates become U+FFFD); otherwise the
 * restore rolls back (--allow-audit-change restores anyway, printing both verdicts and a final WARNING). With --merge
 * the verdict is compared only when audit_logs was empty before; otherwise a note says it was not. An older backup without the verdict restores as
 * before, with a printed note.
 */

import fs from "node:fs";
import path from "node:path";
import { ImportRefusal, importDump, openBackupAdapter, type BackupDump } from "./db-shared.js";
import { readKeyFile, reencryptRows, tablesTheKeyCannotOpen } from "./db-reencrypt.js";
import { ErasureKeyMissing } from "./erasure-restore.js";

interface Args {
  in: string;
  yes: boolean;
  sourceMasterKey: string | null;
  merge: boolean;
  replace: boolean;
  allowAuditChange: boolean;
  allowKeyMismatch: boolean;
  allowReplaceHeld: boolean;
  skipErasures: boolean;
  iUnderstand: boolean;
  erasuresFrom: string | null;
}

type DumpFile = Omit<BackupDump, "format" | "formatVersion"> & { format: string; formatVersion: number };

function parseArgs(argv: string[]): Args {
  let inPath: string | null = null;
  let yes = false;
  let sourceMasterKey: string | null = null;
  let merge = false;
  let replace = false;
  let allowAuditChange = false;
  let allowKeyMismatch = false;
  let allowReplaceHeld = false;
  let skipErasures = false;
  let iUnderstand = false;
  let erasuresFrom: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // pnpm passes the `--` that separates its own options from the script's (pnpm --filter … db:export -- --out x).
    if (arg === "--") continue;
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
    } else if (arg === "--source-master-key-file") {
      const next = argv[++i];
      if (next === undefined) throw new Error("--source-master-key-file requires a path");
      sourceMasterKey = readKeyFile(next, (line) => console.warn(line));
    } else if (arg === "--merge") {
      merge = true;
    } else if (arg === "--replace") {
      replace = true;
    } else if (arg === "--allow-audit-change") {
      allowAuditChange = true;
    } else if (arg === "--allow-key-mismatch") {
      allowKeyMismatch = true;
    } else if (arg === "--allow-replace-held") {
      allowReplaceHeld = true;
    } else if (arg === "--skip-erasures") {
      skipErasures = true;
    } else if (arg === "--i-understand") {
      iUnderstand = true;
    } else if (arg === "--erasures-from") {
      const next = argv[++i];
      if (next === undefined) throw new Error("--erasures-from requires a backup file");
      erasuresFrom = next;
    } else if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!inPath) throw new Error("--in <file.json> is required");
  if (merge && replace) throw new Error("--merge and --replace together: choose one.");
  if (skipErasures && !iUnderstand) {
    throw new ImportRefusal(
      "--skip-erasures restores data that data-subject deletions removed after the backup was written. Pass --i-understand " +
        "with it to go ahead (the next API start records it in the audit log). Nothing was changed."
    );
  }
  if (skipErasures && erasuresFrom) throw new Error("--skip-erasures and --erasures-from together: choose one.");
  return { in: inPath, yes, sourceMasterKey, merge, replace, allowAuditChange, allowKeyMismatch, allowReplaceHeld, skipErasures, iUnderstand, erasuresFrom };
}

function printUsageAndExit(code: number): never {
  console.log(
    [
      "Usage: pnpm --filter @ai-orchestrator/api db:import -- --in <file.json> --yes \\",
      "         [--source-master-key <base64> | --source-master-key-file <path>] [--replace | --merge]",
      "         [--allow-audit-change] [--allow-key-mismatch] [--allow-replace-held]",
      "",
      "Options:",
      "  --in, -i <file.json>       Backup file produced by db:export.",
      "  --yes, -y                  Confirm the operation. Required.",
      "  --source-master-key <b64>  Base64 master key the backup was encrypted with.",
      "                             Required when rotating SECRET_MASTER_KEY_BASE64.",
      "  --source-master-key-file <path>",
      "                             The same, read from a file (first line), so the key stays off the",
      "                             command line.",
      "  --replace                  Replace everything the destination holds: every exported table is",
      "                             emptied first, including ones the backup does not hold.",
      "  --merge                    Add the backup's rows without emptying anything (best-effort).",
      "  --allow-audit-change       Restore even if the restored audit chain's verdict differs from the",
      "                             one the backup recorded (both are printed, then a WARNING).",
      "  --allow-replace-held       With --replace, go ahead although the destination has active legal holds",
      "                             (their data and the holds are deleted). Keep a copy of the destination first.",
      "  --erasures-from <file.json> Also re-apply the erasure tombstones of another (newer) backup, for a",
      "                             restore into an empty database of a backup older than the last erasures.",
      "  --skip-erasures            Do not re-apply erasures (data-subject deletions made after the backup was",
      "                             written come back). Refused without --i-understand; audited at the next start.",
      "  --i-understand             Confirms --skip-erasures.",
      "  --allow-key-mismatch       Restore even though SECRET_MASTER_KEY_BASE64 cannot open the backup's",
      "                             secrets (without --source-master-key); they stay unreadable.",
      "                             The check opens the backup's first secrets and mfa_secrets rows only:",
      "                             a backup with neither is not checked against the key.",
      "  --help, -h                 Show this message.",
      "",
      "By default the destination must be empty (no exported row); one that holds data is",
      "refused, and --replace replaces it with exactly the backup. Erasure tombstones are re-applied",
      "after the load (\"re-applied N erasures\"). The restore is one",
      "transaction: it rolls back if any table fails, or if the restored audit chain",
      "does not give the verdict the backup recorded. Exit codes: 0 restored, 2 refused",
      "(nothing written), 1 failed (rolled back). The destination",
      "DB must be the same kind (sqlite or postgres) as the source — cross-store",
      "restore is not supported because column types differ."
    ].join("\n")
  );
  process.exit(code);
}

/** The erasure tombstones of another backup file (--erasures-from) and the subject key they are keyed with; nothing else. */
function readTombstonesFrom(file: string): { tombstones: Array<Record<string, unknown>>; keys: Array<Record<string, unknown>> } {
  const other = JSON.parse(fs.readFileSync(file, "utf8")) as { format?: string; tables?: Record<string, unknown> };
  if (other.format !== "ai-orchestrator-backup") throw new Error(`--erasures-from: ${file} is not a backup written by db:export`);
  const rows = other.tables?.erasure_tombstones;
  const keys = other.tables?.subject_ref_keys;
  return {
    tombstones: Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [],
    keys: Array.isArray(keys) ? (keys as Array<Record<string, unknown>>) : []
  };
}

function loadKey(b64: string, label: string): Buffer {
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== 32) {
    throw new Error(`${label} must decode to 32 bytes (got ${buf.length})`);
  }
  return buf;
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

  const destKeyB64 = process.env.SECRET_MASTER_KEY_BASE64;
  if (!destKeyB64) {
    throw new Error("SECRET_MASTER_KEY_BASE64 is required to import (used to verify or re-encrypt secrets).");
  }
  const destKey = loadKey(destKeyB64, "SECRET_MASTER_KEY_BASE64");
  const sourceKey = args.sourceMasterKey ? loadKey(args.sourceMasterKey, "--source-master-key") : null;
  const willReencrypt = sourceKey !== null && Buffer.compare(sourceKey, destKey) !== 0;
  // Before anything is written: the key the rows will be read with must open them.
  const unopened = tablesTheKeyCannotOpen(dump.tables, willReencrypt ? sourceKey! : destKey);
  if (unopened.length > 0) {
    const tables = unopened.join(" and ");
    if (willReencrypt) {
      throw new ImportRefusal(`--source-master-key cannot open the backup's ${tables}: pass the key the backup was written with. Nothing was changed.`);
    }
    if (!args.allowKeyMismatch) {
      throw new ImportRefusal(
        `SECRET_MASTER_KEY_BASE64 cannot open the backup's ${tables}: the backup was written with another master key. ` +
          `Pass that key with --source-master-key-file (it is re-encrypted with SECRET_MASTER_KEY_BASE64), or ` +
          `--allow-key-mismatch to restore with secrets and MFA enrolments that cannot be read. Nothing was changed.`
      );
    }
    console.warn(`WARNING: SECRET_MASTER_KEY_BASE64 cannot open the backup's ${tables} (--allow-key-mismatch): they cannot be read after the restore.`);
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

    if (willReencrypt) {
      console.log("Re-encrypting secrets with the current SECRET_MASTER_KEY_BASE64...");
    } else if (sourceKey) {
      console.log("--source-master-key matches current SECRET_MASTER_KEY_BASE64; skipping re-encryption.");
    }

    const other = args.erasuresFrom ? readTombstonesFrom(path.resolve(args.erasuresFrom)) : { tombstones: [], keys: [] };
    const report = await importDump(adapter, dump as BackupDump, {
      erasures: { skip: args.skipErasures, masterKey: destKey, carry: other.tombstones, carryKeys: other.keys },
      merge: args.merge,
      replace: args.replace,
      allowAuditChange: args.allowAuditChange,
      allowReplaceHeld: args.allowReplaceHeld,
      prepare: (table, rows) => (willReencrypt ? reencryptRows(table, rows, sourceKey ?? destKey, destKey) : { rows, touched: 0 }),
      log: (line) => console.log(line),
      warn: (line) => console.warn(line)
    });

    const { totalInserted, totalTouched: totalReencrypted } = report;
    console.log(
      `\nRestored ${totalInserted} rows from ${inPath} ` +
        `(backup schema v${dump.schemaVersion} -> destination v${destSchemaVersion}, ${adapter.kind})` +
        (totalReencrypted > 0 ? `. Re-encrypted ${totalReencrypted} secrets.` : "")
    );
    if (report.audit?.changedWarning) console.log(report.audit.changedWarning);
  } finally {
    await adapter.close();
  }
}

main().catch((err) => {
  if (err instanceof ImportRefusal || err instanceof ErasureKeyMissing) {
    console.error(`Refused: ${err.message}`);
    process.exit(2);
  }
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
