# AI Orchestrator Documentation

Production-oriented documentation for the AI workflow builder and agent runtime.

## What this product is

AI Orchestrator is a low-code workflow automation platform for:

- Visual node-based workflow composition
- Agent orchestration with iterative tool calling
- MCP tool integration
- LLM provider abstraction
- RAG retrieval paths
- Connector-based integrations (including Azure node suite)
- Webhook-triggered execution with security controls

## Documentation map

- [Quickstart](/getting-started/quickstart)
- [Architecture overview](/architecture/overview)
- [Workflow editor](/product/workflow-editor)
- [Core nodes](/nodes/core-nodes)
- [Azure nodes and credentials](/nodes/azure-nodes)
- [Auth and RBAC](/security/auth-rbac)
- [Secrets handling](/security/secrets)
- [Secure webhooks](/security/secure-webhooks)
- [API endpoints](/api/endpoints)
- [Extension SDKs](/extensions/providers)

## Implementation status

This docs site tracks the current monorepo implementation (apps + packages) and includes the newly added Azure node suite:

- `azure_openai_chat_model`
- `embeddings_azure_openai`
- `azure_storage`
- `azure_cosmos_db`
- `azure_monitor_http`
- `azure_ai_search_vector_store`
