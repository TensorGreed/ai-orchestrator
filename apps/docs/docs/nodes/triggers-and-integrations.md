---
title: "Triggers, integrations and model nodes at a glance"
description: "Which trigger nodes, Tier 1 integrations, chat model nodes and Azure and Qdrant nodes L2M ships, and what every connector and model node includes."
---

# Triggers, integrations and model nodes

A short map of what ships. Every node's config fields are in the [node reference](./reference/index.md).

## Tier 1 integrations

Exposed through `GET /api/integrations`:

- HTTP request, configured webhook input, and webhook response
- Slack send message and Slack Events API trigger
- SMTP send email and IMAP email trigger
- Google Sheets read, append and update, and a polling trigger
- PostgreSQL query and polling trigger
- MySQL query
- MongoDB find, insert, update and aggregate
- Redis commands and Redis trigger
- GitHub issue, pull request and repository actions, and a signed GitHub webhook trigger

## Trigger nodes

`schedule_trigger`, `manual_trigger`, `webhook_input`, `form_trigger`, `chat_trigger`, `file_trigger`, `rss_trigger`,
`sse_trigger`, `mcp_server_trigger`, `slack_trigger`, `github_webhook_trigger`, `google_sheets_trigger`,
`postgres_trigger`, `redis_trigger`, `imap_email_trigger` and `error_trigger`.

Message queue trigger nodes are registered for Kafka, RabbitMQ and MQTT with optional-dependency detection. Their
long-lived consumers are intentionally held back until the corresponding client dependency and deployment path are
configured.

To call a webhook, see [Secure webhooks](../security/secure-webhooks.md#calling-a-webhook).

## Chat model nodes

An Agent's `chat_model` attachment can use a dedicated provider node:

- `OpenAI Chat Model` (`openai_chat_model`)
- `Anthropic Chat Model` (`anthropic_chat_model`)
- `Ollama Chat Model` (`ollama_chat_model`)
- `OpenAI Compatible Chat Model` (`openai_compatible_chat_model`)
- `AI Gateway Chat Model` (`ai_gateway_chat_model`)
- `Azure OpenAI Chat Model` (`azure_openai_chat_model`)
- `Google Gemini Chat Model` (`google_gemini_chat_model`)
- The legacy generic `LLM Call` (`llm_call`)

## Azure node suite

- `Azure OpenAI Chat Model` (`azure_openai_chat_model`)
- `Embeddings Azure OpenAI` (`embeddings_azure_openai`)
- `Azure Storage` (`azure_storage`)
- `Azure Cosmos DB` (`azure_cosmos_db`)
- `Microsoft Azure Monitor` (`azure_monitor_http`)
- `Azure AI Search Vector Store` (`azure_ai_search_vector_store`)

Credentials and operations: [Azure nodes](./azure-nodes.md).

## Qdrant

`Qdrant Vector Store` (`qdrant_vector_store`) has the actions `get_ranked_documents`, `add_documents`,
`retrieve_for_chain_tool` and `retrieve_for_ai_agent_tool`. Qdrant is also available in `RAG Retrieve` with
`vectorStoreId = qdrant-vector-store`. For env-backed local defaults, set `QDRANT_ENDPOINT` and `QDRANT_API_KEY`. See
[Vector stores](./vector-stores.md).

## What the connector and model nodes include

- Structured config forms in the editor (no free-form JSON for normal use)
- Dedicated node icons on the canvas and in the node library
- Secret-backed credentials via `secretRef.secretId`
- A `Test Connection` action on connector nodes (`POST /api/connectors/test`)
- A `Test Connection` action on model nodes (`POST /api/providers/test`)
- Execution support in the workflow engine, including a demo fallback mode for local development
