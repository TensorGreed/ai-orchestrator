import { ONE_PENDING_APPROVAL_INDEX } from "./migrations.js";

export { ONE_PENDING_APPROVAL_INDEX };

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
 * A write refers to a user or project that no longer exists: Postgres refused it with a foreign-key violation
 * (23503). Routes check that the user or project exists first, so this is a race with a delete. The API answers 409
 * with this message, never the database's text (which names constraints).
 */
export class StoreReferenceMissingError extends Error {
  readonly statusCode = 409;

  constructor() {
    super("The user or project this change refers to no longer exists.");
    this.name = "StoreReferenceMissingError";
  }
}

/** Whether `error` is a foreign-key violation on either store (SQLite SQLITE_CONSTRAINT_FOREIGNKEY, Postgres 23503). */
export function isForeignKeyViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code } = error as { code?: unknown };
  return code === "23503" || code === "SQLITE_CONSTRAINT_FOREIGNKEY";
}

/** Runs a write, turning a foreign-key violation into StoreReferenceMissingError. */
export async function withReferenceCheck<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isForeignKeyViolation(error)) throw new StoreReferenceMissingError();
    throw error;
  }
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

/**
 * Whether `error` is the v41 one-pending-approval index refusing an insert, on either store, and only that index:
 * SQLite reports SQLITE_CONSTRAINT_UNIQUE on `approval_requests.execution_id` (the only unique index on that column),
 * Postgres 23505 naming the index as its constraint.
 */
export function isOnePendingApprovalViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, constraint, message } = error as { code?: unknown; constraint?: unknown; message?: unknown };
  if (code === "SQLITE_CONSTRAINT_UNIQUE") return typeof message === "string" && /\bapproval_requests\.execution_id\b/.test(message);
  if (code === "23505") return constraint === ONE_PENDING_APPROVAL_INDEX;
  return false;
}

/** `unpublishWorkflowVersion` found the release gate on and enforced for a caller who may not unpublish then. */
export class UnpublishGateEnforcedError extends Error {
  constructor() {
    super("The release gate is enforced: only an admin can unpublish");
    this.name = "UnpublishGateEnforcedError";
  }
}
