/**
 * Phase 13.1 — the Postgres side of the test store factory that runs outside a test file too (the global setup):
 * the TEST_POSTGRES_URL settings, the run's migrated template database and dropping test databases. No vitest
 * imports here, so the global setup can load it.
 */
import { Pool } from "pg";
import { parsePostgresSettings, type PostgresSettings } from "../config.js";
import { postgresStoreConfig } from "../db/create-store.js";
import { PostgresStore, postgresPoolConfig } from "../db/postgres-store.js";

export const TEST_DATABASE = /^t_[0-9a-f]+_[0-9a-f]+$/;
export const TEMPLATE_DATABASE = /^l2m_tpl_[0-9a-f]+$/;

/** The Postgres URL contract and parity tests run against, or undefined (they skip). */
export function testPostgresUrl(): string | undefined {
  const url = process.env.TEST_POSTGRES_URL?.trim();
  return url ? url : undefined;
}

/** Validated connection settings for TEST_POSTGRES_URL (throws when it is unset). */
export function testPostgresSettings(): PostgresSettings {
  const url = testPostgresUrl();
  if (!url) throw new Error("A Postgres test store needs TEST_POSTGRES_URL (for example postgres://postgres:l2m@127.0.0.1:55432/postgres).");
  return parsePostgresSettings({ DB_POSTGRESDB_URL: url });
}

/** An admin pool on the TEST_POSTGRES_URL database (no search_path), for CREATE / DROP DATABASE. */
export function adminPool(): Pool {
  return new Pool(postgresPoolConfig(postgresStoreConfig(testPostgresSettings()), { max: 2 }));
}

export function quoteDatabase(name: string): string {
  if (!TEST_DATABASE.test(name) && !TEMPLATE_DATABASE.test(name)) throw new Error(`Refusing '${name}': not a test database name.`);
  return `"${name}"`;
}

/** Creates `name` and migrates it through the MIGRATIONS chain (the template). */
export async function createMigratedTemplate(name: string): Promise<void> {
  const admin = adminPool();
  try {
    await admin.query(`CREATE DATABASE ${quoteDatabase(name)}`);
  } finally {
    await admin.end();
  }
  const store = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { database: name, maxConnections: 2 }));
  await store.close();
}

/** Drops `names` (FORCE ends any connection a test left open). Errors are collected, not thrown one by one. */
export async function dropTestDatabases(names: Iterable<string>): Promise<void> {
  const list = [...names];
  if (list.length === 0) return;
  const admin = adminPool();
  const failures: string[] = [];
  try {
    for (const name of list) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteDatabase(name)} WITH (FORCE)`);
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await admin.end();
  }
  if (failures.length > 0) throw new Error(`Could not drop test databases: ${failures.join("; ")}`);
}

/** Every database of `run` still on the server (test databases first, the template last). */
export async function listRunDatabases(run: string): Promise<string[]> {
  const admin = adminPool();
  try {
    const result = await admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE $1 OR datname = $2 ORDER BY (datname = $2), datname`,
      [`t\\_${run}\\_%`, `l2m_tpl_${run}`]
    );
    return result.rows.map((row) => row.datname).filter((name) => TEST_DATABASE.test(name) || TEMPLATE_DATABASE.test(name));
  } finally {
    await admin.end();
  }
}
