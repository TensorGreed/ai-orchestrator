/**
 * pnpm --filter @ai-orchestrator/api db:import -- --in backup.json --yes \
 *     [--source-master-key <base64> | --source-master-key-file <path>]
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
 * before insert. --source-master-key-file reads the key from a file instead
 * (the first line, trimmed), so it never appears in the process list or the
 * shell history.
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
import { importDump, openBackupAdapter, type BackupDump } from "./db-shared.js";
import { readKeyFile, reencryptRows } from "./db-reencrypt.js";

interface Args {
  in: string;
  yes: boolean;
  sourceMasterKey: string | null;
  merge: boolean;
  allowAuditChange: boolean;
}

type DumpFile = Omit<BackupDump, "format" | "formatVersion"> & { format: string; formatVersion: number };

function parseArgs(argv: string[]): Args {
  let inPath: string | null = null;
  let yes = false;
  let sourceMasterKey: string | null = null;
  let merge = false;
  let allowAuditChange = false;
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
      sourceMasterKey = readKeyFile(next);
    } else if (arg === "--merge") {
      merge = true;
    } else if (arg === "--allow-audit-change") {
      allowAuditChange = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!inPath) throw new Error("--in <file.json> is required");
  return { in: inPath, yes, sourceMasterKey, merge, allowAuditChange };
}

function printUsageAndExit(code: number): never {
  console.log(
    [
      "Usage: pnpm --filter @ai-orchestrator/api db:import -- --in <file.json> --yes \\",
      "         [--source-master-key <base64> | --source-master-key-file <path>] [--merge] [--allow-audit-change]",
      "",
      "Options:",
      "  --in, -i <file.json>       Backup file produced by db:export.",
      "  --yes, -y                  Confirm the operation. Required.",
      "  --source-master-key <b64>  Base64 master key the backup was encrypted with.",
      "                             Required when rotating SECRET_MASTER_KEY_BASE64.",
      "  --source-master-key-file <path>",
      "                             The same, read from a file (first line), so the key stays off the",
      "                             command line.",
      "  --merge                    Insert without truncating (default: truncate first).",
      "  --allow-audit-change       Restore even if the restored audit chain's verdict differs from the",
      "                             one the backup recorded (both are printed, then a WARNING).",
      "  --help, -h                 Show this message.",
      "",
      "Default mode TRUNCATES every restored table before insert. The restore is one",
      "transaction: it rolls back if any table fails, or if the restored audit chain",
      "does not give the verdict the backup recorded. The destination",
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

    const report = await importDump(adapter, dump as BackupDump, {
      merge: args.merge,
      allowAuditChange: args.allowAuditChange,
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
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
