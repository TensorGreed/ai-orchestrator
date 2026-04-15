/**
 * Dispatcher for Phase 3.2 Tier 2 connector nodes.
 */
import type { SecretReference, WorkflowNode, WorkflowNodeType } from "@ai-orchestrator/shared";
import {
  executeAirtableCreateRecord,
  executeAirtableListRecords,
  executeAirtableUpdateRecord,
  executeAwsS3GetObject,
  executeAwsS3ListObjects,
  executeAwsS3PutObject,
  executeDiscordSendMessage,
  executeDiscordTrigger,
  executeGoogleCalendarCreateEvent,
  executeGoogleCalendarListEvents,
  executeGoogleDriveTrigger,
  executeHubspotCreateContact,
  executeHubspotGetContact,
  executeJiraCreateIssue,
  executeJiraSearchIssues,
  executeNotionCreatePage,
  executeNotionQueryDatabase,
  executeSalesforceCreateRecord,
  executeSalesforceQuery,
  executeStripeCreateCharge,
  executeStripeCreateCustomer,
  executeStripeWebhookTrigger,
  executeTeamsSendMessage,
  executeTelegramSendMessage,
  executeTelegramTrigger,
  executeTwilioSendSms,
  type Tier2Context
} from "./tier2";

export const TIER2_NODE_TYPES: ReadonlySet<WorkflowNodeType> = new Set<WorkflowNodeType>([
  "teams_send_message",
  "notion_create_page",
  "notion_query_database",
  "airtable_create_record",
  "airtable_list_records",
  "airtable_update_record",
  "jira_create_issue",
  "jira_search_issues",
  "salesforce_create_record",
  "salesforce_query",
  "hubspot_create_contact",
  "hubspot_get_contact",
  "stripe_create_customer",
  "stripe_create_charge",
  "stripe_webhook_trigger",
  "aws_s3_put_object",
  "aws_s3_get_object",
  "aws_s3_list_objects",
  "telegram_send_message",
  "telegram_trigger",
  "discord_send_message",
  "discord_trigger",
  "google_drive_trigger",
  "google_calendar_create_event",
  "google_calendar_list_events",
  "twilio_send_sms"
]);

export function isTier2Node(type: string): boolean {
  return TIER2_NODE_TYPES.has(type as WorkflowNodeType);
}

export interface Tier2DispatchContext {
  templateData: Record<string, unknown>;
  resolveSecret: (ref?: SecretReference) => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

export async function executeTier2Node(
  node: WorkflowNode,
  config: Record<string, unknown>,
  ctx: Tier2DispatchContext
): Promise<unknown> {
  const tier2Ctx: Tier2Context = {
    templateData: ctx.templateData,
    resolveSecret: ctx.resolveSecret,
    fetchImpl: ctx.fetchImpl,
    nowMs: ctx.nowMs
  };

  switch (node.type) {
    case "teams_send_message":
      return executeTeamsSendMessage(config, tier2Ctx);
    case "notion_create_page":
      return executeNotionCreatePage(config, tier2Ctx);
    case "notion_query_database":
      return executeNotionQueryDatabase(config, tier2Ctx);
    case "airtable_create_record":
      return executeAirtableCreateRecord(config, tier2Ctx);
    case "airtable_list_records":
      return executeAirtableListRecords(config, tier2Ctx);
    case "airtable_update_record":
      return executeAirtableUpdateRecord(config, tier2Ctx);
    case "jira_create_issue":
      return executeJiraCreateIssue(config, tier2Ctx);
    case "jira_search_issues":
      return executeJiraSearchIssues(config, tier2Ctx);
    case "salesforce_create_record":
      return executeSalesforceCreateRecord(config, tier2Ctx);
    case "salesforce_query":
      return executeSalesforceQuery(config, tier2Ctx);
    case "hubspot_create_contact":
      return executeHubspotCreateContact(config, tier2Ctx);
    case "hubspot_get_contact":
      return executeHubspotGetContact(config, tier2Ctx);
    case "stripe_create_customer":
      return executeStripeCreateCustomer(config, tier2Ctx);
    case "stripe_create_charge":
      return executeStripeCreateCharge(config, tier2Ctx);
    case "stripe_webhook_trigger":
      return executeStripeWebhookTrigger(config);
    case "aws_s3_put_object":
      return executeAwsS3PutObject(config, tier2Ctx);
    case "aws_s3_get_object":
      return executeAwsS3GetObject(config, tier2Ctx);
    case "aws_s3_list_objects":
      return executeAwsS3ListObjects(config, tier2Ctx);
    case "telegram_send_message":
      return executeTelegramSendMessage(config, tier2Ctx);
    case "telegram_trigger":
      return executeTelegramTrigger(config);
    case "discord_send_message":
      return executeDiscordSendMessage(config, tier2Ctx);
    case "discord_trigger":
      return executeDiscordTrigger(config);
    case "google_drive_trigger":
      return executeGoogleDriveTrigger(config, tier2Ctx);
    case "google_calendar_create_event":
      return executeGoogleCalendarCreateEvent(config, tier2Ctx);
    case "google_calendar_list_events":
      return executeGoogleCalendarListEvents(config, tier2Ctx);
    case "twilio_send_sms":
      return executeTwilioSendSms(config, tier2Ctx);
    default:
      throw new Error(`tier2-dispatch: unhandled node type '${node.type}'`);
  }
}
