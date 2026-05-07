/**
 * pnpm --filter @ai-orchestrator/api db:rollback -- --to <version> --yes
 *
 * Walks a Postgres deployment back to `targetVersion` by running each
 * migration's `down` SQL in reverse order. DESTRUCTIVE — drops tables and
 * data created by the rolled-back migrations.
 *
 * Designed for botched-deploy recovery: roll back to last-known-good schema,
 * restore data from backup, re-deploy. Not a normal-operations command.
 *
 * SQLite is not supported (its store has its own embedded schema in
 * apps/api/src/db/database.ts that doesn't go through MIGRATIONS). For
 * SQLite, the recovery path is:
 *   rm apps/api/data/orchestrator.db && restart
 */

import { Pool } from "pg";
import { MIGRATIONS, rollbackMigrations } from "../db/migrations.js";

interface Args {
  to: number;
  yes: boolean;
}

function parseArgs(argv: string[]): Args {
  let to: number | null = null;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--to" || arg === "-t") {
      const next = argv[++i];
      if (next === undefined) throw new Error("--to requires a version number");
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`--to must be a non-negative integer, got '${next}'`);
      }
      to = parsed;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (to === null) throw new Error("--to <version> is required");
  return { to, yes };
}

function printUsageAndExit(code: number): never {
  const max = MIGRATIONS.reduce((acc, m) => Math.max(acc, m.version), 0);
  console.log(
    [
      "Usage: pnpm --filter @ai-orchestrator/api db:rollback -- --to <version> --yes",
      "",
      "Options:",
      "  --to, -t <version>   Schema version to roll back to (0 = drop everything).",
      "  --yes, -y            Confirm the destructive operation. Required.",
      "  --help, -h           Show this message.",
      "",
      `Highest migration version available: v${max}`,
      "",
      "Required env (Postgres only):",
      "  DB_TYPE=postgres",
      "  DB_POSTGRESDB_HOST, DB_POSTGRESDB_PORT, DB_POSTGRESDB_DATABASE,",
      "  DB_POSTGRESDB_USER, DB_POSTGRESDB_PASSWORD, DB_POSTGRESDB_SSL"
    ].join("\n")
  );
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const dbType = process.env.DB_TYPE?.toLowerCase();
  if (dbType !== "postgres" && dbType !== "postgresql") {
    console.error(
      "db:rollback requires DB_TYPE=postgres. SQLite is not supported — see the script header for the SQLite recovery recipe."
    );
    process.exit(2);
  }

  if (!args.yes) {
    console.error(
      "Refusing to run without --yes. This operation drops tables and the data they hold."
    );
    process.exit(2);
  }

  const pool = new Pool({
    host: process.env.DB_POSTGRESDB_HOST ?? "localhost",
    port: Number(process.env.DB_POSTGRESDB_PORT) || 5432,
    database: process.env.DB_POSTGRESDB_DATABASE ?? "ai_orchestrator",
    user: process.env.DB_POSTGRESDB_USER ?? "postgres",
    password: process.env.DB_POSTGRESDB_PASSWORD ?? "",
    ssl: process.env.DB_POSTGRESDB_SSL === "true" ? { rejectUnauthorized: false } : false,
    max: 2
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const result = await rollbackMigrations(
      async (sql) => { await pool.query(sql); },
      async () => {
        const r = await pool.query<{ version: string | number | null }>(
          `SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations`
        );
        const v = r.rows[0]?.version;
        return typeof v === "number" ? v : Number(v ?? 0);
      },
      async (newVersion) => {
        await pool.query(`DELETE FROM schema_migrations WHERE version > $1`, [newVersion]);
      },
      args.to
    );

    if (result.rolledBack.length === 0) {
      console.log(`No-op: schema already at v${result.from} (target v${args.to}).`);
    } else {
      console.log(
        `Rolled back v${result.from} -> v${result.to}. Reversed migrations: ${result.rolledBack.join(", ")}`
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
