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
