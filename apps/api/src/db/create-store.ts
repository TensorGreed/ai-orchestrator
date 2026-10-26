import { describePostgresSettings, isPostgresDbType, parsePostgresSettings, type PostgresSettings } from "../config.js";
import { SqliteStore } from "./database.js";
import { PostgresStore, type PostgresStoreConfig } from "./postgres-store.js";
import type { Store } from "./store.js";

/** Phase 13.1 — the PostgresStore config for validated settings (the db:* scripts share it, so TLS is handled once). */
export function postgresStoreConfig(settings: PostgresSettings, overrides: Partial<PostgresStoreConfig> = {}): PostgresStoreConfig {
  return {
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.user,
    password: settings.password,
    ssl: settings.ssl,
    maxConnections: settings.poolSize,
    ...overrides
  };
}

export async function createStore(config?: {
  dbFilePath?: string;
  env?: Record<string, string | undefined>;
  /** Where startup notes and warnings go (never containing the password). Defaults to the console. */
  log?: { info(message: string): void; warn(message: string): void };
}): Promise<Store> {
  const env = config?.env ?? process.env;
  const log = config?.log ?? {
    // eslint-disable-next-line no-console
    info: (message: string) => console.log(message),
    // eslint-disable-next-line no-console
    warn: (message: string) => console.warn(message)
  };

  if (isPostgresDbType(env.DB_TYPE)) {
    const settings = parsePostgresSettings(env);
    for (const warning of settings.warnings) log.warn(`Warning: ${warning}`);
    log.info(`Database: ${describePostgresSettings(settings)}`);
    return PostgresStore.create(postgresStoreConfig(settings));
  }

  // Default: SQLite
  const dbFilePath = config?.dbFilePath ?? env.DB_SQLITE_PATH ?? "./data/orchestrator.db";
  return SqliteStore.create(dbFilePath);
}
