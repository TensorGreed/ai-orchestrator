/**
 * A project still owns workflows or secrets. Deleting it would hand them to
 * the default project, where other users could reach them, so the delete is
 * refused until they are moved or deleted.
 */
export class ProjectNotEmptyError extends Error {
  readonly statusCode = 409;

  constructor(readonly counts: { workflows: number; secrets: number }) {
    super("Move or delete this project's workflows and secrets first.");
    this.name = "ProjectNotEmptyError";
  }
}
