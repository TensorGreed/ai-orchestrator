/**
 * Phase 13.1 — drops the `t_*` / `l2m_tpl_*` databases a killed Postgres test run left behind. Run it with no test
 * run in progress against the same server:
 *
 *   TEST_POSTGRES_URL=postgres://postgres:l2m@127.0.0.1:55432/postgres \
 *     pnpm --filter @ai-orchestrator/api exec tsx src/test-support/drop-leftover-test-databases.ts
 */
import { dropLeftoverTestDatabases, testPostgresUrl } from "./postgres-test-databases.js";

if (!testPostgresUrl()) {
  console.error("Set TEST_POSTGRES_URL to the server the test run used.");
  process.exit(1);
}
const dropped = await dropLeftoverTestDatabases();
console.log(dropped.length === 0 ? "No leftover test databases." : `Dropped ${dropped.length} leftover test database(s): ${dropped.join(", ")}`);
