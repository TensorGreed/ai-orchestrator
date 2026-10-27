/**
 * pnpm --filter @ai-orchestrator/api db:copy -- --from sqlite:<path> --to postgres [--yes] [--dry-run]
 *
 * Optional: moves a SQLite database into an empty Postgres database (see db-copy-core.ts for what is copied, how
 * it is verified and what is refused). The target comes from the normal DB_POSTGRESDB_URL / DB_POSTGRESDB_* settings
 * (validated as the API validates them; the password is never printed), read from the environment and from the
 * repo's .env / apps/api/.env files, the environment winning.
 *
 * Exit codes: 0 copied (or dry run done), 2 refused (nothing written), 1 failed (rolled back; nothing committed).
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { describePostgresSettings, parsePostgresSettings } from "../config.js";
import { postgresStoreConfig } from "../db/create-store.js";
import { API_ROOT, DbCopyRefusal, parseDbCopyArgs, runDbCopy, USAGE, type DbCopyArgs } from "./db-copy-core.js";

/** .env values the environment does not already set (the repo root's, then apps/api's). */
function loadEnvFiles(): void {
  const merged: Record<string, string> = {};
  for (const file of [path.resolve(API_ROOT, "..", "..", ".env"), path.resolve(API_ROOT, ".env")]) {
    if (fs.existsSync(file)) Object.assign(merged, dotenv.parse(fs.readFileSync(file)));
  }
  for (const [key, value] of Object.entries(merged)) if (process.env[key] === undefined) process.env[key] = value;
}

async function main(): Promise<number> {
  let args: DbCopyArgs;
  try {
    args = parseDbCopyArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  loadEnvFiles();
  try {
    const settings = parsePostgresSettings(process.env);
    for (const warning of settings.warnings) console.warn(`Warning: ${warning}`);
    console.log(`Postgres: ${describePostgresSettings(settings)}`);
    await runDbCopy({
      sqlitePath: args.from,
      postgres: postgresStoreConfig(settings, { maxConnections: 1 }),
      dryRun: args.dryRun,
      allowBrokenAudit: args.allowBrokenAudit,
      log: (line) => console.log(line)
    });
    return 0;
  } catch (error) {
    if (error instanceof DbCopyRefusal) {
      console.error(`Refused: ${error.message}`);
      return 2;
    }
    // Config errors name the variable, never its value; pg errors never carry the password.
    console.error(`db:copy failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
);
