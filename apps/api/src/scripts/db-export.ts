/**
 * pnpm --filter @ai-orchestrator/api db:export -- --out backup.json
 *
 * Reads from the configured DB (DB_TYPE=sqlite|postgres) and writes a JSON
 * backup. Encrypted columns (secrets, MFA secrets, log-stream destination
 * configs) are exported as ciphertext — db:import can re-encrypt with a
 * new master key by passing --source-master-key.
 *
 * Exports every table a restored instance needs (EXPORTED_TABLES in
 * db-shared.ts) and excludes pure cache/runtime tables (session_tool_cache,
 * webhook replay windows, leader leases, log_stream_events,
 * external_secret_cache): NOT_EXPORTED_TABLES lists them with the reason.
 *
 * Reads one snapshot (one read transaction) and, when audit_logs is exported,
 * records the audit chain's verdict in the backup (`auditVerdict`), which
 * db:import compares the restored chain with.
 */

import fs from "node:fs";
import path from "node:path";
import { exportDump, openBackupAdapter } from "./db-shared.js";

interface Args {
  out: string;
  excludeHistory: boolean;
}

function parseArgs(argv: string[]): Args {
  let out: string | null = null;
  let excludeHistory = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // pnpm passes the `--` that separates its own options from the script's (pnpm --filter … db:export -- --out x).
    if (arg === "--") continue;
    if (arg === "--out" || arg === "-o") {
      const next = argv[++i];
      if (next === undefined) throw new Error("--out requires a path");
      out = next;
    } else if (arg === "--exclude-history") {
      excludeHistory = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!out) throw new Error("--out <file.json> is required");
  return { out, excludeHistory };
}

function printUsageAndExit(code: number): never {
  console.log(
    [
      "Usage: pnpm --filter @ai-orchestrator/api db:export -- --out <file.json> [--exclude-history]",
      "",
      "Options:",
      "  --out, -o <file.json>   Output path. Parent directories are created if missing.",
      "  --exclude-history       Skip execution_history + audit_logs (smaller backup).",
      "                          Otherwise the audit chain's verdict is recorded in the backup,",
      "                          and db:import checks the restored chain against it.",
      "  --help, -h              Show this message.",
      "",
      "Reads from DB_TYPE=sqlite (default, file at DB_SQLITE_PATH) or DB_TYPE=postgres",
      "(DB_POSTGRESDB_HOST/PORT/DATABASE/USER/PASSWORD/SSL).",
      "",
      "Encrypted columns are exported as ciphertext. To restore against a different",
      "SECRET_MASTER_KEY_BASE64, pass the original key to db:import via",
      "--source-master-key for transparent re-encryption."
    ].join("\n")
  );
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const adapter = await openBackupAdapter();

  try {
    const dump = await exportDump(adapter, {
      excludeHistory: args.excludeHistory,
      log: (line) => console.log(line),
      warn: (line) => console.warn(line)
    });
    const { tables, schemaVersion } = dump;

    const outPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(dump, null, 2));

    const totalRows = Object.values(tables).reduce((acc, t) => acc + t.length, 0);
    console.log(
      `\nWrote ${totalRows} rows across ${Object.keys(tables).length} tables to ${outPath} (schema v${schemaVersion}, ${adapter.kind})`
    );
  } finally {
    await adapter.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
