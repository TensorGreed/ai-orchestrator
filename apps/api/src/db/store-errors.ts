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
