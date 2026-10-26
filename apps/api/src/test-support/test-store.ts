/**
 * Phase 13.1 — test store factory and the store contract harness.
 *
 *   const { store, cleanup } = await createTestStore();          // TEST_STORE, else SQLite
 *   const { store, cleanup } = await createTestStore({ kind: "postgres" });
 *
 * SQLite: a fresh file in a temp directory (removed by cleanup). Postgres: a fresh schema `t_<random>` in the database
 * TEST_POSTGRES_URL names, migrated through the MIGRATIONS chain and dropped by cleanup, so test files never share
 * rows and can run in parallel against one server.
 *
 * Contract files (`apps/api/src/db/contract/<domain>.contract.test.ts`) call `describeStoreContract(name, fn)`: `fn`
 * runs once against SQLite, always, and once against Postgres when TEST_POSTGRES_URL is set (skipped otherwise, with
 * a one-line notice). Each test gets its own fresh store.
 *
 * A run that is killed before cleanup leaves its `t_*` schemas behind (harmless; CI throws the server away). To clear
 * them on a local server, with no test run in progress:
 *
 *   psql "$TEST_POSTGRES_URL" -Atc "SELECT format('DROP SCHEMA %I CASCADE;', nspname) FROM pg_namespace
 *     WHERE nspname ~ '^t_[0-9a-f]+$'" | psql "$TEST_POSTGRES_URL"
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, it } from "vitest";
import { parsePostgresSettings, type PostgresSettings } from "../config.js";
import { postgresStoreConfig } from "../db/create-store.js";
import { SqliteStore } from "../db/database.js";
import { PostgresStore, postgresPoolConfig } from "../db/postgres-store.js";
import type { Store } from "../db/store.js";

export type TestStoreKind = "sqlite" | "postgres";

export interface TestStore {
  /** The store under test, through the shared interface only, so a contract test runs unchanged on both stores. */
  store: Store;
  kind: TestStoreKind;
  /** The Postgres schema this store lives in (Postgres only). */
  schema?: string;
  /** SQLite file path (SQLite only). */
  file?: string;
  /** Closes the store and removes its data (temp directory / schema). Safe to call twice. */
  cleanup(): Promise<void>;
}

/** The Postgres URL contract and parity tests run against, or undefined (they skip). */
export function testPostgresUrl(): string | undefined {
  const url = process.env.TEST_POSTGRES_URL?.trim();
  return url ? url : undefined;
}

function defaultKind(): TestStoreKind {
  const value = process.env.TEST_STORE?.trim().toLowerCase();
  if (!value || value === "sqlite") return "sqlite";
  if (value === "postgres" || value === "postgresql") return "postgres";
  throw new Error(`TEST_STORE must be sqlite or postgres, got '${value}'.`);
}

/** Validated connection settings for TEST_POSTGRES_URL (throws when it is unset). */
export function testPostgresSettings(): PostgresSettings {
  const url = testPostgresUrl();
  if (!url) throw new Error("A Postgres test store needs TEST_POSTGRES_URL (for example postgres://postgres:l2m@127.0.0.1:55432/postgres).");
  return parsePostgresSettings({ DB_POSTGRESDB_URL: url });
}

/** A fresh, unused schema name. */
export function randomTestSchema(): string {
  return `t_${randomBytes(6).toString("hex")}`;
}

/** A small pool on TEST_POSTGRES_URL, optionally with `search_path` set to `schema` (the caller ends it). */
export function testPostgresPool(schema?: string): Pool {
  return new Pool(postgresPoolConfig(postgresStoreConfig(testPostgresSettings(), schema ? { schema } : {}), { max: 2 }));
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

export async function createTestStore(options: { kind?: TestStoreKind } = {}): Promise<TestStore> {
  const kind = options.kind ?? defaultKind();
  if (kind === "postgres") {
    const schema = randomTestSchema();
    let store: PostgresStore;
    try {
      store = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 4 }));
    } catch (error) {
      await dropTestSchema(schema).catch(() => undefined);
      throw error;
    }
    let done = false;
    return {
      store,
      kind,
      schema,
      async cleanup() {
        if (done) return;
        done = true;
        await store.close().catch(() => undefined);
        await dropTestSchema(schema);
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
