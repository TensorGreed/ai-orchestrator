/**
 * pnpm --filter @ai-orchestrator/api db:export -- --out backup.json
 *
 * Reads from the configured DB (DB_TYPE=sqlite|postgres) and writes a JSON
 * backup. Encrypted columns (secrets, MFA secrets, log-stream destination
 * configs) are exported as ciphertext — db:import can re-encrypt with a
 * new master key by passing --source-master-key.
 *
 * Excludes pure cache/runtime tables (session_tool_cache, webhook replay
 * windows, leader leases, log_stream_events, external_secret_cache) — see
 * EXPORTED_TABLES in db-shared.ts for the full list.
 */

import fs from "node:fs";
import path from "node:path";
import {
  EXPORTED_TABLES,
  HISTORY_TABLES,
  openBackupAdapter
} from "./db-shared.js";

interface Args {
  out: string;
  excludeHistory: boolean;
}

function parseArgs(argv: string[]): Args {
  let out: string | null = null;
  let excludeHistory = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
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
    const schemaVersion = await adapter.schemaVersion();
    const tables: Record<string, Record<string, unknown>[]> = {};

    const targetTables = args.excludeHistory
      ? EXPORTED_TABLES.filter((t) => !(HISTORY_TABLES as readonly string[]).includes(t))
      : (EXPORTED_TABLES as readonly string[]);

    for (const table of targetTables) {
      try {
        const rows = await adapter.selectAll(table);
        tables[table] = rows;
        console.log(`  ${table}: ${rows.length} rows`);
      } catch (err) {
        // A table may be missing on an old schema where this build never
        // wrote it. Don't fail the whole export — record an empty list and
        // warn so the operator can investigate if it matters.
        console.warn(`  ${table}: skipped (${err instanceof Error ? err.message : String(err)})`);
        tables[table] = [];
      }
    }

    const dump = {
      format: "ai-orchestrator-backup",
      formatVersion: 1,
      schemaVersion,
      exportedAt: new Date().toISOString(),
      dbType: adapter.kind,
      tables
    };

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
