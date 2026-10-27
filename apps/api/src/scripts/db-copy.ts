/**
 * pnpm --filter @ai-orchestrator/api db:copy -- --from sqlite:<path> --to postgres [--yes] [--dry-run] [--allow-broken-audit]
 *
 * Optional: moves a SQLite database into an empty Postgres database (see db-copy-core.ts for what is copied, how
 * it is verified and what is refused). Settings are loaded exactly as the API loads them (env-files.ts: the repo
 * root's .env, then apps/api/.env overriding the environment), so `--from sqlite` and the Postgres target are the
 * ones the API would use. The resolved source file and target (never the password) are printed before anything else.
 *
 * Exit codes: 0 copied (or dry run done), 2 refused (nothing written), 1 failed (rolled back; nothing committed).
 */
import { API_ROOT, runDbCopyCli } from "./db-copy-core.js";

runDbCopyCli(process.argv.slice(2), { apiRoot: API_ROOT }).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
);
