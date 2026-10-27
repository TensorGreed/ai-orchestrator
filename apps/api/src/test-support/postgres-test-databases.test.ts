/**
 * Phase 13.1 — clearing the databases a killed Postgres test run left behind. Postgres only (skipped without
 * TEST_POSTGRES_URL).
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adminPool, dropLeftoverTestDatabases } from "./postgres-test-databases.js";
import { createTestStore, noticePostgresSkipped, testPostgresRun, testPostgresUrl } from "./test-store.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("clearing leftover test databases");

run("dropLeftoverTestDatabases", () => {
  it("drops another run's test and template databases, and leaves this run's and other databases alone", async () => {
    const own = await createTestStore({ kind: "postgres" });
    const killedRun = `0${randomBytes(3).toString("hex")}`;
    const leftovers = [`t_${killedRun}_0001`, `l2m_tpl_${killedRun}`];
    const unrelated = `keep_${killedRun}`;
    const admin = adminPool();
    try {
      for (const name of [...leftovers, unrelated]) await admin.query(`CREATE DATABASE "${name}"`);
      const dropped = await dropLeftoverTestDatabases({ exceptRun: testPostgresRun() });
      expect(dropped).toEqual(expect.arrayContaining(leftovers));
      expect(dropped.filter((name) => name.includes(testPostgresRun()))).toEqual([]);
      const still = await admin.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname = ANY($1)`, [
        [...leftovers, unrelated, own.postgres!.database]
      ]);
      expect(still.rows.map((row) => row.datname).sort()).toEqual([own.postgres!.database, unrelated].sort());
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${unrelated}"`).catch(() => undefined);
      await admin.end();
      await own.cleanup();
    }
  }, 60_000);
});
