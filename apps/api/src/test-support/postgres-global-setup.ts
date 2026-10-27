/**
 * Phase 13.1 — vitest global setup (vitest.config.ts): with TEST_POSTGRES_URL set, migrates one template database
 * for the run and hands its name to the workers (`inject("l2mPostgresTemplate")`), so every Postgres test store is a
 * quick `CREATE DATABASE … TEMPLATE` clone. The teardown drops every database of the run still there (each file drops
 * its own after its last test; this catches the rest) and the template. Without TEST_POSTGRES_URL it does nothing.
 */
import { randomBytes } from "node:crypto";
import type { TestProject } from "vitest/node";
import { createMigratedTemplate, dropTestDatabases, listRunDatabases, testPostgresUrl } from "./postgres-test-databases.js";

export default async function setup(project: TestProject): Promise<(() => Promise<void>) | undefined> {
  if (!testPostgresUrl()) return undefined;
  const run = randomBytes(4).toString("hex");
  const template = `l2m_tpl_${run}`;
  await createMigratedTemplate(template);
  project.provide("l2mPostgresTemplate", template);
  project.provide("l2mPostgresRun", run);
  return async () => {
    await dropTestDatabases(await listRunDatabases(run));
  };
}
