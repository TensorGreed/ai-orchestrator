/**
 * Detect external dependencies declared by a workflow JSON, so the Template
 * Gallery can show "Requires: OpenAI key, Pinecone" pills BEFORE the user
 * clicks Use Template and trips a silent failure.
 *
 * Detection is intentionally pattern-based, not exhaustive — every popular
 * provider/vector-store/MCP/connector node is covered, but a community node
 * with a totally novel shape may not surface. That's an acceptable tradeoff:
 * the UI hides the pill row entirely when no deps are detected, so no
 * misleading info is ever displayed.
 */

export type TemplateDependencyKind =
  | "provider"
  | "vector_store"
  | "mcp_server"
  | "connector";

export interface TemplateDependency {
  kind: TemplateDependencyKind;
  label: string;
  envVar?: string;
}

const PROVIDER_DEPENDENCIES: Record<string, { label: string; envVar?: string } | null> = {
  echo: null, // built-in, no dep
  openai: { label: "OpenAI", envVar: "OPENAI_API_KEY" },
  anthropic: { label: "Anthropic", envVar: "ANTHROPIC_API_KEY" },
  gemini: { label: "Google Gemini", envVar: "GEMINI_API_KEY" },
  azure_openai: { label: "Azure OpenAI" },
  ollama: { label: "Ollama (local model server)" },
  openai_compatible: { label: "OpenAI-compatible endpoint" },
  ai_gateway: { label: "AI Gateway" }
};

/** The provider a dedicated chat model node calls (its type names it; it has no `config.provider`). */
const CHAT_MODEL_NODE_PROVIDERS: Record<string, string> = {
  openai_chat_model: "openai",
  anthropic_chat_model: "anthropic",
  ollama_chat_model: "ollama",
  openai_compatible_chat_model: "openai_compatible",
  ai_gateway_chat_model: "ai_gateway",
  azure_openai_chat_model: "azure_openai",
  google_gemini_chat_model: "gemini"
};

const VECTOR_STORE_DEPENDENCIES: Record<string, { label: string; envVar?: string } | null> = {
  "in-memory": null,
  "in-memory-vector-store": null,
  // A knowledge base is built in, but one has to be created and filled first.
  "knowledge-base": { label: "Knowledge base" },
  "pinecone-vector-store": { label: "Pinecone", envVar: "PINECONE_API_KEY" },
  "azure-ai-search-vector-store": { label: "Azure AI Search" },
  "qdrant-vector-store": { label: "Qdrant", envVar: "QDRANT_API_KEY" },
  "pgvector-store": { label: "PostgreSQL + pgvector" },
  "chroma-vector-store": { label: "Chroma" },
  "weaviate-vector-store": { label: "Weaviate" },
  "redis-vector-store": { label: "Redis Vector Search" }
};

/** Embedders a RAG node calls (`config.embedderId`); the token embedder is local. */
const EMBEDDER_DEPENDENCIES: Record<string, { label: string; envVar?: string } | null> = {
  "token-embedder": null,
  "openai-embedder": { label: "OpenAI", envVar: "OPENAI_API_KEY" },
  "azure-openai-embedder": { label: "Azure OpenAI" },
  "cohere-embedder": { label: "Cohere", envVar: "COHERE_API_KEY" },
  "mistral-embedder": { label: "Mistral", envVar: "MISTRAL_API_KEY" },
  "google-vertex-embedder": { label: "Google Gemini", envVar: "GEMINI_API_KEY" },
  "huggingface-embedder": { label: "HuggingFace", envVar: "HUGGINGFACE_API_KEY" }
};

const MCP_SERVER_DEPENDENCIES: Record<string, { label: string; envVar?: string } | null> = {
  "mock-mcp": null,
  http_mcp: { label: "Remote MCP server (HTTP)" },
  stdio_mcp: { label: "Local MCP server (stdio)" }
};

const CONNECTOR_NODE_DEPENDENCIES: Record<string, { label: string; envVar?: string }> = {
  postgres_query: { label: "PostgreSQL" },
  postgres_trigger: { label: "PostgreSQL" },
  mysql_query: { label: "MySQL" },
  mongo_operation: { label: "MongoDB" },
  redis_command: { label: "Redis" },
  redis_trigger: { label: "Redis" },
  google_sheets_read: { label: "Google Sheets" },
  google_sheets_append: { label: "Google Sheets" },
  google_sheets_update: { label: "Google Sheets" },
  google_sheets_trigger: { label: "Google Sheets" },
  google_drive_source: { label: "Google Drive" },
  google_drive_trigger: { label: "Google Drive" },
  google_calendar_create_event: { label: "Google Calendar" },
  google_calendar_list_events: { label: "Google Calendar" },
  azure_storage: { label: "Azure Storage" },
  azure_cosmos_db: { label: "Azure Cosmos DB" },
  azure_monitor_http: { label: "Azure Monitor" },
  azure_ai_search_vector_store: { label: "Azure AI Search" },
  qdrant_vector_store: { label: "Qdrant", envVar: "QDRANT_API_KEY" },
  smtp_send_email: { label: "SMTP server" },
  imap_email_trigger: { label: "IMAP mailbox" },
  github_action: { label: "GitHub" },
  github_webhook_trigger: { label: "GitHub" },
  slack_send_message: { label: "Slack" },
  slack_trigger: { label: "Slack" },
  teams_send_message: { label: "Microsoft Teams" },
  notion_create_page: { label: "Notion" },
  notion_query_database: { label: "Notion" },
  airtable_create_record: { label: "Airtable" },
  airtable_list_records: { label: "Airtable" },
  airtable_update_record: { label: "Airtable" },
  jira_create_issue: { label: "Jira" },
  jira_search_issues: { label: "Jira" },
  salesforce_create_record: { label: "Salesforce" },
  salesforce_query: { label: "Salesforce" },
  hubspot_create_contact: { label: "HubSpot" },
  hubspot_get_contact: { label: "HubSpot" },
  stripe_create_customer: { label: "Stripe" },
  stripe_create_charge: { label: "Stripe" },
  stripe_webhook_trigger: { label: "Stripe" },
  aws_s3_put_object: { label: "AWS S3" },
  aws_s3_get_object: { label: "AWS S3" },
  aws_s3_list_objects: { label: "AWS S3" },
  telegram_send_message: { label: "Telegram" },
  telegram_trigger: { label: "Telegram" },
  discord_send_message: { label: "Discord" },
  discord_trigger: { label: "Discord" },
  twilio_send_sms: { label: "Twilio" }
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function unwrapWorkflow(raw: unknown): Record<string, unknown> {
  const root = asRecord(raw);
  // Handle the standard export wrapper shape: { schemaVersion, workflow: { ... } }.
  if (root.workflow && typeof root.workflow === "object") {
    return asRecord(root.workflow);
  }
  return root;
}

/** The nodes of a template's workflow and of the companion workflows it brings (template-companions.ts). */
function templateNodes(rawWorkflow: unknown): unknown[] {
  const workflow = unwrapWorkflow(rawWorkflow);
  const nodes = Array.isArray(workflow.nodes) ? [...workflow.nodes] : [];
  const companions = asRecord(rawWorkflow).companions;
  if (Array.isArray(companions)) {
    for (const companion of companions) {
      const companionWorkflow = unwrapWorkflow(companion);
      if (Array.isArray(companionWorkflow.nodes)) nodes.push(...companionWorkflow.nodes);
    }
  }
  return nodes;
}

export function computeTemplateDependencies(rawWorkflow: unknown): TemplateDependency[] {
  const nodes = templateNodes(rawWorkflow);
  const seen = new Map<string, TemplateDependency>();
  const add = (kind: TemplateDependencyKind, label: string, envVar?: string) => {
    const key = `${kind}:${label}`;
    if (!seen.has(key)) seen.set(key, { kind, label, envVar });
  };

  for (const nodeRaw of nodes) {
    const node = asRecord(nodeRaw);
    const type = String(node.type ?? "");
    const config = asRecord(node.config);

    // 1. Provider on llm_call and the AI chain nodes lives at config.provider.providerId; a dedicated chat model
    // node (OpenAI Chat Model and the rest) names it in its type.
    const provider = asRecord(config.provider);
    const chatModelProvider = CHAT_MODEL_NODE_PROVIDERS[type];
    if (Object.keys(provider).length > 0 || chatModelProvider) {
      const providerId = chatModelProvider ?? String(provider.providerId ?? "").trim();
      if (providerId in PROVIDER_DEPENDENCIES) {
        const dep = PROVIDER_DEPENDENCIES[providerId];
        if (dep) add("provider", dep.label, dep.envVar);
      } else if (providerId) {
        add("provider", providerId);
      }
    }

    // 2. RAG retrieve vector store
    if (type === "rag_retrieve") {
      const vsId = String(config.vectorStoreId ?? "").trim();
      if (vsId in VECTOR_STORE_DEPENDENCIES) {
        const dep = VECTOR_STORE_DEPENDENCIES[vsId];
        if (dep) add("vector_store", dep.label, dep.envVar);
      } else if (vsId) {
        add("vector_store", vsId);
      }
    }

    // 2b. The embedder of a RAG node (absent: the local token embedder).
    if (type === "rag_retrieve") {
      const embedderId = String(config.embedderId ?? "").trim();
      if (embedderId in EMBEDDER_DEPENDENCIES) {
        const dep = EMBEDDER_DEPENDENCIES[embedderId];
        if (dep) add("provider", dep.label, dep.envVar);
      } else if (embedderId) {
        add("provider", embedderId);
      }
    }

    // 2c. HTML-rendered PDFs need a Chromium for Playwright on the API host.
    if (type === "pdf_output" && config.renderMode === "html") {
      add("connector", "Chromium for PDF rendering", "PDF_CHROMIUM_EXECUTABLE_PATH");
    }

    // 3. MCP server adapter on mcp_tool nodes
    if (type === "mcp_tool") {
      const serverId = String(config.serverId ?? "").trim();
      if (serverId in MCP_SERVER_DEPENDENCIES) {
        const dep = MCP_SERVER_DEPENDENCIES[serverId];
        if (dep) add("mcp_server", dep.label, dep.envVar);
      } else if (serverId) {
        add("mcp_server", serverId);
      }
    }

    // 4. Connector / integration nodes — keyed by node type
    const connectorDep = CONNECTOR_NODE_DEPENDENCIES[type];
    if (connectorDep) {
      add("connector", connectorDep.label, connectorDep.envVar);
    }
  }

  // Stable order: provider > vector_store > mcp_server > connector, then alpha by label.
  const order: Record<TemplateDependencyKind, number> = {
    provider: 0,
    vector_store: 1,
    mcp_server: 2,
    connector: 3
  };
  return [...seen.values()].sort((a, b) => {
    const kindDelta = order[a.kind] - order[b.kind];
    if (kindDelta !== 0) return kindDelta;
    return a.label.localeCompare(b.label);
  });
}
