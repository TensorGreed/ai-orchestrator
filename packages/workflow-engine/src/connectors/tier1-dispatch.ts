/**
 * Dispatcher for Phase 3.1 Tier 1 connector nodes.
 * Keeps the main executor switch small by routing to the tier1 module.
 */
import type { WorkflowNode, WorkflowNodeType, SecretReference } from "@ai-orchestrator/shared";
import {
  executeGitHubAction,
  executeGitHubWebhookTrigger,
  executeGoogleSheetsAppend,
  executeGoogleSheetsRead,
  executeGoogleSheetsTrigger,
  executeGoogleSheetsUpdate,
  executeImapEmailTrigger,
  executeMongoOperation,
  executeMysqlQuery,
  executePostgresQuery,
  executePostgresTrigger,
  executeRedisCommand,
  executeRedisTrigger,
  executeSlackSendMessage,
  executeSlackTrigger,
  executeSmtpSendEmail,
  type Tier1ClientFactories,
  type Tier1Context
} from "./tier1";

export const TIER1_NODE_TYPES: ReadonlySet<WorkflowNodeType> = new Set<WorkflowNodeType>([
  "slack_send_message",
  "slack_trigger",
  "smtp_send_email",
  "imap_email_trigger",
  "google_sheets_read",
  "google_sheets_append",
  "google_sheets_update",
  "google_sheets_trigger",
  "postgres_query",
  "postgres_trigger",
  "mysql_query",
  "mongo_operation",
  "redis_command",
  "redis_trigger",
  "github_action",
  "github_webhook_trigger"
]);

export function isTier1Node(type: string): boolean {
  return TIER1_NODE_TYPES.has(type as WorkflowNodeType);
}

export interface Tier1DispatchContext {
  templateData: Record<string, unknown>;
  resolveSecret: (ref?: SecretReference) => Promise<string | undefined>;
  clients?: Tier1ClientFactories;
  fetchImpl?: typeof fetch;
}

export async function executeTier1Node(
  node: WorkflowNode,
  config: Record<string, unknown>,
  ctx: Tier1DispatchContext
): Promise<unknown> {
  const tier1Ctx: Tier1Context = {
    templateData: ctx.templateData,
    resolveSecret: ctx.resolveSecret,
    clients: ctx.clients,
    fetchImpl: ctx.fetchImpl
  };

  switch (node.type) {
    case "slack_send_message":
      return executeSlackSendMessage(config, tier1Ctx);
    case "slack_trigger":
      return executeSlackTrigger(config);
    case "smtp_send_email":
      return executeSmtpSendEmail(config, tier1Ctx);
    case "imap_email_trigger":
      return executeImapEmailTrigger(config, tier1Ctx);
    case "google_sheets_read":
      return executeGoogleSheetsRead(config, tier1Ctx);
    case "google_sheets_append":
      return executeGoogleSheetsAppend(config, tier1Ctx);
    case "google_sheets_update":
      return executeGoogleSheetsUpdate(config, tier1Ctx);
    case "google_sheets_trigger":
      return executeGoogleSheetsTrigger(config, tier1Ctx);
    case "postgres_query":
      return executePostgresQuery(config, tier1Ctx);
    case "postgres_trigger":
      return executePostgresTrigger(config, tier1Ctx);
    case "mysql_query":
      return executeMysqlQuery(config, tier1Ctx);
    case "mongo_operation":
      return executeMongoOperation(config, tier1Ctx);
    case "redis_command":
      return executeRedisCommand(config, tier1Ctx);
    case "redis_trigger":
      return executeRedisTrigger(config, tier1Ctx);
    case "github_action":
      return executeGitHubAction(config, tier1Ctx);
    case "github_webhook_trigger":
      return executeGitHubWebhookTrigger(config);
    default:
      throw new Error(`tier1-dispatch: unhandled node type '${node.type}'`);
  }
}
