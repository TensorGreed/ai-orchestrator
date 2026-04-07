# Vector Store Nodes

Implemented vector-store nodes:

- `azure_ai_search_vector_store`
- `qdrant_vector_store`

## Qdrant Vector Store

Node id: `qdrant_vector_store`

Supported actions:

- `get_ranked_documents`
- `add_documents`
- `retrieve_for_chain_tool`
- `retrieve_for_ai_agent_tool`

Common config:

- `endpoint` (for example `http://localhost:6333`)
- `collectionName`
- `secretRef.secretId` (API key secret, optional for local unsecured Qdrant)
- `apiKeyHeaderName` (default `api-key`)
- `useDemoFallback`

Retrieval config:

- `queryText` and/or `queryVectorJson`
- `filterJson` (optional)
- `topK`
- `contentField` / `metadataField`

Mutation config:

- `documentsJson` (JSON array of documents/points)

## RAG Retrieve integration

`RAG Retrieve` supports Qdrant via:

- `vectorStoreId = qdrant-vector-store`
- credentials via `embeddingSecretRef.secretId` (or `QDRANT_API_KEY`)
- connection config in `vectorStoreConfig`:
  - `endpoint`
  - `collectionName`
  - `apiKeyHeaderName`
  - `contentField`
  - `metadataField`
  - `filter` or `filterJson`
