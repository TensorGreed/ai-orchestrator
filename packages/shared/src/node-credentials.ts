import type { NodeCredentialSpec, NodeDefinition } from "./types";

const secretRef = (
  provider: string,
  label: string,
  hint: string,
  required = true,
  key = "secretRef"
): NodeCredentialSpec => ({ key, provider, label, hint, required });

/**
 * Credentials each node's runtime handler reads. The node editor renders a
 * secret picker for every entry (when the node has no bespoke editor), marks
 * required ones, and shows `hint` so users know what the stored secret holds.
 * Only `secretRef.secretId` is ever written to a node config.
 */
export const NODE_CREDENTIAL_SPECS: Readonly<Record<string, readonly NodeCredentialSpec[]>> = {
  teams_send_message: [
    secretRef("teams", "Webhook URL Secret", "Secret whose value is the Teams incoming webhook URL. Only needed when Webhook URL is blank.", false)
  ],
  notion_create_page: [secretRef("notion", "Notion Token Secret", "Notion internal integration token (secret_...).")],
  notion_query_database: [secretRef("notion", "Notion Token Secret", "Notion internal integration token (secret_...).")],
  airtable_create_record: [secretRef("airtable", "Airtable Token Secret", "Airtable personal access token.")],
  airtable_list_records: [secretRef("airtable", "Airtable Token Secret", "Airtable personal access token.")],
  airtable_update_record: [secretRef("airtable", "Airtable Token Secret", "Airtable personal access token.")],
  jira_create_issue: [secretRef("jira", "Jira API Token Secret", "Atlassian API token, paired with the Email field for basic auth.")],
  jira_search_issues: [secretRef("jira", "Jira API Token Secret", "Atlassian API token, paired with the Email field for basic auth.")],
  salesforce_create_record: [secretRef("salesforce", "Salesforce Token Secret", "Salesforce OAuth access token.")],
  salesforce_query: [secretRef("salesforce", "Salesforce Token Secret", "Salesforce OAuth access token.")],
  hubspot_create_contact: [secretRef("hubspot", "HubSpot Token Secret", "HubSpot private app access token.")],
  hubspot_get_contact: [secretRef("hubspot", "HubSpot Token Secret", "HubSpot private app access token.")],
  stripe_create_customer: [secretRef("stripe", "Stripe API Key Secret", "Stripe restricted or secret API key.")],
  stripe_create_charge: [secretRef("stripe", "Stripe API Key Secret", "Stripe restricted or secret API key.")],
  stripe_webhook_trigger: [
    secretRef("stripe", "Webhook Signing Secret", "Stripe webhook signing secret (whsec_...) used to verify incoming events.", false, "signingSecretRef")
  ],
  aws_s3_put_object: [secretRef("aws", "AWS Credentials Secret", "AWS credentials as JSON {accessKeyId, secretAccessKey, sessionToken?} or 'accessKeyId:secretAccessKey'.")],
  aws_s3_get_object: [secretRef("aws", "AWS Credentials Secret", "AWS credentials as JSON {accessKeyId, secretAccessKey, sessionToken?} or 'accessKeyId:secretAccessKey'.")],
  aws_s3_list_objects: [secretRef("aws", "AWS Credentials Secret", "AWS credentials as JSON {accessKeyId, secretAccessKey, sessionToken?} or 'accessKeyId:secretAccessKey'.")],
  telegram_send_message: [secretRef("telegram", "Bot Token Secret", "Telegram bot token from BotFather.")],
  telegram_trigger: [
    secretRef("telegram", "Webhook Secret Token", "Value sent in X-Telegram-Bot-Api-Secret-Token; incoming requests are verified against it.", false, "signingSecretRef")
  ],
  discord_send_message: [
    secretRef("discord", "Webhook URL Secret", "Secret whose value is the Discord webhook URL. Only needed when Webhook URL is blank.", false)
  ],
  google_drive_trigger: [secretRef("google", "Google Access Token Secret", "Google OAuth access token with Drive read scope.")],
  google_calendar_create_event: [secretRef("google", "Google Access Token Secret", "Google OAuth access token with the Calendar events scope.")],
  google_calendar_list_events: [secretRef("google", "Google Access Token Secret", "Google OAuth access token with Calendar read scope.")],
  twilio_send_sms: [secretRef("twilio", "Twilio Auth Token Secret", "Twilio auth token that pairs with the Account SID field.")],
  rerank: [
    secretRef("custom", "Reranker API Key Secret", "Cohere, Jina or Voyage API key matching the provider. Optional when the server sets the provider's API key environment variable.", false)
  ]
};

/**
 * Node types whose editors are bespoke and already render their own secret
 * picker for every `*SecretRef` property in their schema. Anything with a
 * secret property must be listed here or in NODE_CREDENTIAL_SPECS, which a
 * test enforces so new nodes cannot ship without a credential field.
 */
export const BESPOKE_CREDENTIAL_EDITOR_TYPES: ReadonlySet<string> = new Set([
  "webhook_input",
  "openai_chat_model",
  "anthropic_chat_model",
  "openai_compatible_chat_model",
  "ai_gateway_chat_model",
  "azure_openai_chat_model",
  "google_gemini_chat_model",
  "embeddings_azure_openai",
  "rag_retrieve",
  "http_request",
  "mcp_tool",
  "connector_source",
  "google_drive_source",
  "azure_storage",
  "azure_cosmos_db",
  "azure_monitor_http",
  "azure_ai_search_vector_store",
  "qdrant_vector_store",
  "guard_protection",
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
  "github_action",
  "github_webhook_trigger",
  "redis_command",
  "redis_trigger",
  "kafka_trigger",
  "rabbitmq_trigger",
  "mqtt_trigger",
  "chat_trigger",
  "sse_trigger",
  "mcp_server_trigger"
]);

/** Attaches the credential specs to definitions and keeps `required` honest. */
export function withCredentialSpecs(definitions: NodeDefinition[]): NodeDefinition[] {
  return definitions.map((definition) => {
    const specs = NODE_CREDENTIAL_SPECS[definition.type];
    if (!specs || specs.length === 0) return definition;
    const schema = definition.configSchema as { properties?: Record<string, unknown>; required?: string[] };
    const requiredKeys = specs.filter((spec) => spec.required).map((spec) => spec.key);
    const required = [...new Set([...requiredKeys, ...(schema.required ?? [])])];
    return {
      ...definition,
      credentials: specs.map((spec) => ({ ...spec })),
      configSchema: { ...definition.configSchema, ...(required.length > 0 ? { required } : {}) }
    };
  });
}
