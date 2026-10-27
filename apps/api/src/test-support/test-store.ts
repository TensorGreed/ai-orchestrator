/**
 * Phase 13.1 — test store factory and the store contract harness.
 *
 *   const { store, cleanup } = await createTestStore();          // TEST_STORE, else SQLite
 *   const { store, cleanup } = await createTestStore({ kind: "postgres" });
 *
 * SQLite: a fresh file in a temp directory (removed by cleanup).
 *
 * Postgres: a fresh database `t_<run>_<random>` on the server TEST_POSTGRES_URL names, cloned from a template the
 * run migrated once (`CREATE DATABASE … TEMPLATE`, a few tens of milliseconds instead of running the chain per store),
 * so test files never share rows and can run in parallel against one server. The template comes from the global
 * setup (test-support/postgres-global-setup.ts) through `inject`; outside it, each process migrates its own template
 * the first time. cleanup closes the store at once and defers the DROP DATABASE: a file's databases are dropped
 * after its last test (test-support/postgres-file-setup.ts), and the global teardown drops anything of the run still
 * there, the template included. A killed run can leave `t_*` / `l2m_tpl_*` databases behind (harmless; CI throws the
 * server away). To clear them on a local server, with no test run in progress:
 *
 *   TEST_POSTGRES_URL=… pnpm --filter @ai-orchestrator/api exec tsx src/test-support/drop-leftover-test-databases.ts
 *
 * or with psql only:
 *
 *   psql "$TEST_POSTGRES_URL" -Atc "SELECT format('DROP DATABASE %I WITH (FORCE);', datname) FROM pg_database
 *     WHERE datname ~ '^(t_[0-9a-f]+_[0-9a-f]+|l2m_tpl_[0-9a-f]+)$'" | psql "$TEST_POSTGRES_URL"
 *
 * Schema-level tests (schema parity, the rollback walk) still use a schema `t_<random>` in the TEST_POSTGRES_URL
 * database through randomTestSchema / testPostgresPool / dropTestSchema.
 *
 * Contract files (`apps/api/src/db/contract/<domain>.contract.test.ts`) call `describeStoreContract(name, fn)`: `fn`
 * runs once against SQLite, always, and once against Postgres when TEST_POSTGRES_URL is set (skipped otherwise, with
 * a one-line notice). Each test gets its own fresh store.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, inject, it } from "vitest";
import { postgresStoreConfig } from "../db/create-store.js";
import { SqliteStore } from "../db/database.js";
import { PostgresStore, postgresPoolConfig, type PostgresStoreConfig } from "../db/postgres-store.js";
import { createPostgresPool } from "../db/postgres/pool.js";
import {
  adminPool,
  createMigratedTemplate,
  dropLeftoverTestDatabases,
  dropTestDatabases,
  quoteDatabase,
  TEMPLATE_DATABASE,
  testPostgresSettings,
  testPostgresUrl
} from "./postgres-test-databases.js";

import type { Store } from "../db/store.js";

export { createMigratedTemplate, dropLeftoverTestDatabases, dropTestDatabases, testPostgresSettings, testPostgresUrl };

export type TestStoreKind = "sqlite" | "postgres";

export interface TestStore {
  /** The store under test, through the shared interface only, so a contract test runs unchanged on both stores. */
  store: Store;
  kind: TestStoreKind;
  /** The database this store lives in and the config it was opened with (Postgres only). */
  postgres?: { database: string; config: PostgresStoreConfig };
  /** SQLite file path (SQLite only). */
  file?: string;
  /**
   * Closes the store and removes its data: the temp directory (SQLite), or the database, dropped once the file's
   * tests are done (Postgres). Safe to call twice.
   */
  cleanup(): Promise<void>;
}

function defaultKind(): TestStoreKind {
  const value = process.env.TEST_STORE?.trim().toLowerCase();
  if (!value || value === "sqlite") return "sqlite";
  if (value === "postgres" || value === "postgresql") return "postgres";
  throw new Error(`TEST_STORE must be sqlite or postgres, got '${value}'.`);
}

/** A fresh, unused schema name. */
export function randomTestSchema(): string {
  return `t_${randomBytes(6).toString("hex")}`;
}

/** A small pool on TEST_POSTGRES_URL, optionally with `search_path` set to `schema` (the caller ends it). */
export function testPostgresPool(schema?: string): Pool {
  return createPostgresPool(postgresPoolConfig(postgresStoreConfig(testPostgresSettings(), schema ? { schema } : {}), { max: 2 }), { label: "test" });
}

export async function dropTestSchema(schema: string): Promise<void> {
  if (!/^t_[a-z0-9_]+$/.test(schema)) throw new Error(`Refusing to drop '${schema}': not a test schema.`);
  const pool = testPostgresPool();
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Postgres: one migrated template per run, a database cloned from it per store
// ---------------------------------------------------------------------------

/** Provided by the global setup (postgres-global-setup.ts) when TEST_POSTGRES_URL is set. */
declare module "vitest" {
  export interface ProvidedContext {
    l2mPostgresTemplate: string | undefined;
    l2mPostgresRun: string | undefined;
  }
}

function provided<K extends "l2mPostgresTemplate" | "l2mPostgresRun">(key: K): string | undefined {
  try {
    return inject(key);
  } catch {
    // Not inside a vitest worker with the global setup (a script importing the factory): fall back below.
    return undefined;
  }
}

let localRun: string | undefined;
/** This run's id: from the global setup, or one per process. Every test database of the run starts with it. */
export function testPostgresRun(): string {
  const fromSetup = provided("l2mPostgresRun");
  if (fromSetup) return fromSetup;
  localRun ??= randomBytes(4).toString("hex");
  return localRun;
}

let localTemplate: Promise<string> | undefined;
/** The migrated template to clone: the global setup's, or (outside it) one this process migrates once. */
function templateDatabase(): Promise<string> {
  const fromSetup = provided("l2mPostgresTemplate");
  if (fromSetup) return Promise.resolve(fromSetup);
  // promise-ok: kept so every caller in this process waits for the same template; returned below
  localTemplate ??= (async () => {
    const name = `l2m_tpl_${testPostgresRun()}`;
    await createMigratedTemplate(name);
    pendingDrops.add(name);
    return name;
  })();
  return localTemplate;
}

/** Databases closed by cleanup, dropped by dropPendingTestDatabases (after the file, and at the end of the run). */
const pendingDrops = new Set<string>();

/** Drops the databases this process's cleanups deferred (the template it made itself last). */
export async function dropPendingTestDatabases(): Promise<void> {
  if (pendingDrops.size === 0) return;
  for (const [file, database] of databasesByFile) if (pendingDrops.has(database)) databasesByFile.delete(file);
  const names = [...pendingDrops].sort((a, b) => Number(TEMPLATE_DATABASE.test(a)) - Number(TEMPLATE_DATABASE.test(b)));
  pendingDrops.clear();
  if (names.some((name) => TEMPLATE_DATABASE.test(name))) localTemplate = undefined;
  await dropTestDatabases(names);
}

/** A fresh database cloned from the template; its name. */
async function cloneTestDatabase(): Promise<string> {
  const template = await templateDatabase();
  const name = `t_${testPostgresRun()}_${randomBytes(6).toString("hex")}`;
  const admin = adminPool();
  try {
    await admin.query(`CREATE DATABASE ${quoteDatabase(name)} TEMPLATE ${quoteDatabase(template)}`);
  } finally {
    await admin.end();
  }
  return name;
}

/** Another PostgresStore on the same database as `test` (a second API instance in a two-instance test). */
export async function openTestStoreTwin(test: TestStore, options: { maxConnections?: number } = {}): Promise<PostgresStore> {
  if (!test.postgres) throw new Error("openTestStoreTwin needs a Postgres test store.");
  return await PostgresStore.create({ ...test.postgres.config, maxConnections: options.maxConnections ?? 4 });
}

/** A small pg pool on the same database as `test`, for SQL a test runs beside the store (the caller ends it). */
export function testStorePool(test: TestStore, options: { max?: number } = {}): Pool {
  if (!test.postgres) throw new Error("testStorePool needs a Postgres test store.");
  return createPostgresPool(postgresPoolConfig(test.postgres.config, { max: options.max ?? 2 }), { label: "test" });
}

export async function createTestStore(options: { kind?: TestStoreKind; maxConnections?: number } = {}): Promise<TestStore> {
  const kind = options.kind ?? defaultKind();
  if (kind === "postgres") {
    const database = await cloneTestDatabase();
    const config = postgresStoreConfig(testPostgresSettings(), { database, maxConnections: options.maxConnections ?? 4 });
    let store: PostgresStore;
    try {
      store = await PostgresStore.create(config);
    } catch (error) {
      pendingDrops.add(database);
      throw error;
    }
    let done = false;
    return {
      store,
      kind,
      postgres: { database, config },
      async cleanup() {
        if (done) return;
        done = true;
        try {
          await store.close();
        } finally {
          pendingDrops.add(database);
        }
      }
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-test-store-"));
  const file = path.join(dir, "orchestrator.db");
  const store = await SqliteStore.create(file);
  let done = false;
  return {
    store,
    kind,
    file,
    async cleanup() {
      if (done) return;
      done = true;
      try {
        await store.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  };
}

/** Postgres databases openTestStore made, by the SQLite path they stand in for (a reopen finds the same rows). */
const databasesByFile = new Map<string, string>();

/**
 * The store an API test opens at `file`, on the kind TEST_STORE names. SQLite: `SqliteStore.create(file)`, exactly as
 * before (the test removes its temp directory as it always did). Postgres: a database cloned from the template, the
 * same one again when the test opens `file` a second time (a restart keeps its rows); `close()` closes it and
 * defers the drop to the end of the file. Either way the caller only closes the store.
 */
export async function openTestStore(file: string, options: { kind?: TestStoreKind; maxConnections?: number } = {}): Promise<Store> {
  const kind = options.kind ?? defaultKind();
  if (kind === "sqlite") return await SqliteStore.create(file);
  let database = databasesByFile.get(file);
  if (!database) {
    database = await cloneTestDatabase();
    databasesByFile.set(file, database);
  }
  const store = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { database, maxConnections: options.maxConnections ?? 4 }));
  const name = database;
  const close = store.close.bind(store);
  store.close = async () => {
    try {
      await close();
    } finally {
      pendingDrops.add(name);
    }
  };
  return store;
}

/** The Postgres database an openTestStore store lives in (undefined on SQLite), for SQL a test runs beside it. */
export function testStoreDatabase(file: string): string | undefined {
  return databasesByFile.get(file);
}

/** Which store kind this run's API tests use (TEST_STORE). */
export function testStoreKind(): TestStoreKind {
  return defaultKind();
}

let skipNoticeShown = false;

/** Prints, once per test file, that the Postgres half is skipped. */
export function noticePostgresSkipped(what: string): void {
  // CI's Postgres job sets this so a lost TEST_POSTGRES_URL fails the job instead of silently skipping.
  if (process.env.REQUIRE_TEST_POSTGRES === "true") {
    throw new Error(`${what}: REQUIRE_TEST_POSTGRES=true but TEST_POSTGRES_URL is not set.`);
  }
  if (skipNoticeShown) return;
  skipNoticeShown = true;
  // eslint-disable-next-line no-console
  console.info(`[store tests] ${what}: Postgres skipped (set TEST_POSTGRES_URL to run it).`);
}

export interface StoreContractContext {
  kind: TestStoreKind;
  /** This test's fresh store (valid inside a test, after beforeEach). */
  store(): Store;
}

/**
 * Declares the same contract against SQLite, always, and Postgres when TEST_POSTGRES_URL is set. `fn` registers tests
 * with `it(...)`, reading the store through `ctx.store()`; every test gets a fresh store, cleaned up afterwards.
 */
export function describeStoreContract(name: string, fn: (ctx: StoreContractContext) => void): void {
  const kinds: TestStoreKind[] = testPostgresUrl() ? ["sqlite", "postgres"] : ["sqlite"];
  if (!testPostgresUrl()) noticePostgresSkipped(name);
  for (const kind of kinds) {
    describe(`${name} [${kind}]`, () => {
      let current: TestStore | undefined;
      beforeEach(async () => {
        current = await createTestStore({ kind });
      }, 60_000);
      afterEach(async () => {
        const toClean = current;
        current = undefined;
        await toClean?.cleanup();
      }, 60_000);
      fn({
        kind,
        store() {
          if (!current) throw new Error("ctx.store() is only available inside a test.");
          return current.store;
        }
      });
    });
  }
  if (kinds.length === 1) {
    describe.skip(`${name} [postgres] (TEST_POSTGRES_URL not set)`, () => {
      it("runs the same contract on Postgres", () => undefined);
    });
  }
}
