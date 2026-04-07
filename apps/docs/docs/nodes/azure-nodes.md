# Azure Nodes

Implemented Azure node suite:

- `azure_openai_chat_model`
- `embeddings_azure_openai`
- `azure_storage`
- `azure_cosmos_db`
- `azure_monitor_http`
- `azure_ai_search_vector_store`

Each node uses `secretRef.secretId` to resolve credentials server-side.

## Credential setup in UI

1. Open node config
2. In secret dropdown click `Create credential`
3. Choose provider preset (Azure OpenAI, Azure Storage, Azure Cosmos DB, Azure Monitor, Azure AI Search)
4. Paste credential value (raw string or JSON blob)
5. Save and select created secret
6. Click `Test Connection`

## Supported credential value formats

### Azure OpenAI

Raw API key:

```text
<azure-openai-api-key>
```

JSON:

```json
{
  "apiKey": "<azure-openai-api-key>"
}
```

Bearer token also accepted:

```json
{
  "accessToken": "eyJ..."
}
```

### Azure Storage

Shared key JSON (recommended):

```json
{
  "accountName": "mystorageacct",
  "accountKey": "<base64-account-key>",
  "endpoint": "https://mystorageacct.blob.core.windows.net"
}
```

SAS token:

```text
sv=...&ss=...&srt=...&sp=...&se=...&sig=...
```

Bearer token:

```text
Bearer eyJ...
```

### Azure Cosmos DB

Master key JSON:

```json
{
  "masterKey": "<cosmos-base64-key>"
}
```

or bearer token JSON:

```json
{
  "accessToken": "eyJ..."
}
```

### Azure Monitor

Bearer token JSON:

```json
{
  "accessToken": "eyJ..."
}
```

### Azure AI Search

Raw API key:

```text
<search-api-key>
```

JSON:

```json
{
  "apiKey": "<search-api-key>"
}
```

## Node-level operations

### Azure Storage

- `list_containers`
- `list_blobs`
- `get_blob_text`
- `put_blob_text`
- `delete_blob`

### Azure Cosmos DB

- `query_items`
- `read_item`
- `create_item`
- `upsert_item`
- `delete_item`

### Azure Monitor

- `query_logs`
- `query_metrics`
- `custom_request`

### Azure AI Search Vector Store

- `vector_search`
- `upsert_documents`
- `delete_documents`

## Demo fallback

Most Azure connectors support `useDemoFallback=true`.
If credential/config is missing, the node can return a deterministic demo response instead of hard failing.
