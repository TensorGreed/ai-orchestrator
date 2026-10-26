/**
 * A project still owns workflows, secrets, knowledge bases, MCP servers or eval datasets. Deleting it would hand them to
 * the default project, where other users could reach them, so the delete is
 * refused until they are moved or deleted.
 */
export class ProjectNotEmptyError extends Error {
  readonly statusCode = 409;

  constructor(readonly counts: { workflows: number; secrets: number; knowledgeBases: number; mcpServers: number; evalDatasets: number }) {
    super("Move or delete this project's workflows, secrets, knowledge bases, MCP servers and eval datasets first.");
    this.name = "ProjectNotEmptyError";
  }
}

/**
 * A store method this store does not implement yet (the Postgres store, until it reaches parity with SQLite).
 * The API answers 501, as the routes that check for the SQLite store already do.
 */
export class StoreNotImplementedError extends Error {
  readonly statusCode = 501;

  constructor(readonly method: string) {
    super(`${method} is not available on this store in this release.`);
    this.name = "StoreNotImplementedError";
  }
}

/**
 * For a route's own catch that turns any error into a 4xx/5xx: lets StoreNotImplementedError through to the
 * error handler, so a feature the store cannot serve answers 501 everywhere rather than a misleading 400 or 409.
 */
export function rethrowStoreNotImplemented(error: unknown): void {
  if (error instanceof StoreNotImplementedError) throw error;
}

/** Phase 13.1 — the v39 partial unique index that allows one running guard simulation per deployment. */
export const ONE_RUNNING_SIMULATION_INDEX = "idx_guard_simulations_one_running";

/**
 * Whether `error` is the one-running-simulation index refusing an insert, on either store, and only that index:
 * SQLite reports SQLITE_CONSTRAINT_UNIQUE on `guard_simulations.status` (the only unique index on that column),
 * Postgres 23505 naming the index as its constraint. A duplicate id or any other violation is not it.
 */
export function isOneRunningSimulationViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, constraint, message } = error as { code?: unknown; constraint?: unknown; message?: unknown };
  if (code === "SQLITE_CONSTRAINT_UNIQUE") return typeof message === "string" && /\bguard_simulations\.status\b/.test(message);
  if (code === "23505") return constraint === ONE_RUNNING_SIMULATION_INDEX;
  return false;
}
