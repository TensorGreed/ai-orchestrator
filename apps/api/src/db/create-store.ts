import { SqliteStore } from "./database.js";
import { PostgresStore } from "./postgres-store.js";

export type AnyStore = SqliteStore | PostgresStore;

export async function createStore(config?: { dbFilePath?: string }): Promise<AnyStore> {
  const dbType = process.env.DB_TYPE?.toLowerCase();

  if (dbType === "postgres" || dbType === "postgresql") {
    return PostgresStore.create({
      host: process.env.DB_POSTGRESDB_HOST ?? "localhost",
      port: Number(process.env.DB_POSTGRESDB_PORT) || 5432,
      database: process.env.DB_POSTGRESDB_DATABASE ?? "ai_orchestrator",
      user: process.env.DB_POSTGRESDB_USER ?? "postgres",
      password: process.env.DB_POSTGRESDB_PASSWORD ?? "",
      ssl: process.env.DB_POSTGRESDB_SSL === "true",
      maxConnections: Number(process.env.DB_POSTGRESDB_POOL_SIZE) || 10
    });
  }

  // Default: SQLite
  const dbFilePath = config?.dbFilePath ?? process.env.DB_SQLITE_PATH ?? "./data/orchestrator.db";
  return SqliteStore.create(dbFilePath);
}
