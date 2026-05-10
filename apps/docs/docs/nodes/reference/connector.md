<!--
  Generated from packages/shared/src/definitions.ts.
  DO NOT EDIT BY HAND — run `pnpm --filter @ai-orchestrator/docs gen:nodes`
  (or `pnpm docs:build`) to regenerate.
-->

# Connector nodes

External system integrations — HTTP, SQL, NoSQL, cloud SDKs, SaaS APIs.

41 nodes.

---
### `airtable_create_record` — Airtable: Create Record

Create one or more records in an Airtable table (personal access token).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `secretRef` | `object` | no | — |
| `baseId` | `string` | yes | — |
| `table` | `string` | yes | — |
| `fieldsJson` | `string` | no | — |
| `typecast` | `boolean` | no | — |

**Example config**

```json
{
  "baseId": "appXXXXXXXXXXXXXX",
  "table": "Leads",
  "fieldsJson": "{\"Name\":\"{{user_prompt}}\"}",
  "typecast": true
}
```

---

### `airtable_list_records` — Airtable: List Records

List records from an Airtable table with optional formula + max page size.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `secretRef` | `object` | no | — |
| `baseId` | `string` | yes | — |
| `table` | `string` | yes | — |
| `filterByFormula` | `string` | no | — |
| `maxRecords` | `number` | no | — |
| `view` | `string` | no | — |

**Example config**

```json
{
  "baseId": "appXXXXXXXXXXXXXX",
  "table": "Leads",
  "maxRecords": 100
}
```

---

### `airtable_update_record` — Airtable: Update Record

Patch an Airtable record by ID.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `secretRef` | `object` | no | — |
| `baseId` | `string` | yes | — |
| `table` | `string` | yes | — |
| `recordId` | `string` | yes | — |
| `fieldsJson` | `string` | no | — |

**Example config**

```json
{
  "baseId": "appXXXXXXXXXXXXXX",
  "table": "Leads",
  "recordId": "recXXXXXXXXXXXXXX",
  "fieldsJson": "{\"Status\":\"Contacted\"}"
}
```

---

### `aws_s3_get_object` — AWS S3: Get Object

Download an object from S3. Returns text for text/* and application/json, otherwise base64.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `region` | `string` | yes | — |
| `bucket` | `string` | yes | — |
| `key` | `string` | yes | — |
| `secretRef` | `object` | no | — |

**Example config**

```json
{
  "region": "us-east-1",
  "bucket": "my-bucket",
  "key": "reports/input.json"
}
```

---

### `aws_s3_list_objects` — AWS S3: List Objects

List objects under a prefix via S3 ListObjectsV2.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `region` | `string` | yes | — |
| `bucket` | `string` | yes | — |
| `prefix` | `string` | no | — |
| `maxKeys` | `number` | no | — |
| `secretRef` | `object` | no | — |

**Example config**

```json
{
  "region": "us-east-1",
  "bucket": "my-bucket",
  "prefix": "reports/",
  "maxKeys": 100
}
```

---

### `aws_s3_put_object` — AWS S3: Put Object

Upload an object to S3 via SigV4. Credentials secret stores JSON {accessKeyId, secretAccessKey, sessionToken?}.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `region` | `string` | yes | — |
| `bucket` | `string` | yes | — |
| `key` | `string` | yes | — |
| `body` | `string` | no | — |
| `contentType` | `string` | no | — |
| `secretRef` | `object` | no | — |

**Example config**

```json
{
  "region": "us-east-1",
  "bucket": "my-bucket",
  "key": "reports/{{result}}.json",
  "body": "{{result}}",
  "contentType": "application/json"
}
```

---

### `azure_ai_search_vector_store` — Azure AI Search Vector Store

Runs vector and document operations against Azure AI Search indexes.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `operation` | `string` | yes | `vector_search` \| `upsert_documents` \| `delete_documents` |
| `endpoint` | `string` | no | — |
| `indexName` | `string` | no | — |
| `apiVersion` | `string` | no | — |
| `vectorField` | `string` | no | — |
| `contentField` | `string` | no | — |
| `idField` | `string` | no | — |
| `metadataField` | `string` | no | — |
| `queryText` | `string` | no | — |
| `queryVectorJson` | `string` | no | — |
| `topK` | `number` | no | — |
| `documentsJson` | `string` | no | — |
| `secretRef` | `object` | no | — |
| `useDemoFallback` | `boolean` | no | — |

**Example config**

```json
{
  "operation": "vector_search",
  "endpoint": "https://my-search.search.windows.net",
  "indexName": "documents",
  "apiVersion": "2024-07-01",
  "vectorField": "embedding",
  "contentField": "content",
  "idField": "id",
  "metadataField": "metadata",
  "queryText": "{{user_prompt}}",
  "topK": 5,
  "useDemoFallback": true
}
```

---

### `azure_cosmos_db` — Azure Cosmos DB

Queries and mutates documents in Azure Cosmos DB containers.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `operation` | `string` | yes | `query_items` \| `read_item` \| `create_item` \| `upsert_item` \| `delete_item` |
| `endpoint` | `string` | no | — |
| `databaseId` | `string` | no | — |
| `containerId` | `string` | no | — |
| `queryText` | `string` | no | — |
| `itemId` | `string` | no | — |
| `partitionKey` | `string` | no | — |
| `itemJson` | `string` | no | — |
| `maxItems` | `number` | no | — |
| `secretRef` | `object` | no | — |
| `useDemoFallback` | `boolean` | no | — |

**Example config**

```json
{
  "operation": "query_items",
  "endpoint": "https://example.documents.azure.com:443/",
  "databaseId": "",
  "containerId": "",
  "queryText": "SELECT TOP 10 * FROM c",
  "maxItems": 25,
  "useDemoFallback": true
}
```

---

### `azure_monitor_http` — Microsoft Azure Monitor

Queries Azure Monitor logs/metrics or executes authenticated monitor API requests.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `operation` | `string` | yes | `query_logs` \| `query_metrics` \| `custom_request` |
| `workspaceId` | `string` | no | — |
| `resourceId` | `string` | no | — |
| `queryText` | `string` | no | — |
| `timespan` | `string` | no | — |
| `metricNames` | `string` | no | — |
| `method` | `string` | no | — |
| `path` | `string` | no | — |
| `bodyTemplate` | `string` | no | — |
| `maxRows` | `number` | no | — |
| `secretRef` | `object` | no | — |
| `useDemoFallback` | `boolean` | no | — |

**Example config**

```json
{
  "operation": "query_logs",
  "workspaceId": "",
  "queryText": "Heartbeat | take 5",
  "maxRows": 50,
  "useDemoFallback": true
}
```

---

### `azure_storage` — Azure Storage

Reads/writes Azure Blob Storage containers and blobs.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `operation` | `string` | yes | `list_containers` \| `list_blobs` \| `get_blob_text` \| `put_blob_text` \| `delete_blob` |
| `accountName` | `string` | no | — |
| `endpoint` | `string` | no | — |
| `containerName` | `string` | no | — |
| `blobName` | `string` | no | — |
| `blobContentTemplate` | `string` | no | — |
| `prefix` | `string` | no | — |
| `maxResults` | `number` | no | — |
| `secretRef` | `object` | no | — |
| `useDemoFallback` | `boolean` | no | — |

**Example config**

```json
{
  "operation": "list_blobs",
  "accountName": "",
  "endpoint": "",
  "containerName": "",
  "prefix": "",
  "maxResults": 50,
  "useDemoFallback": true
}
```

---

### `connector_source` — Connector Source

Fetches documents from a connector adapter.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `connectorId` | `string` | yes | — |
| `connectorConfig` | `object` | no | — |
| `authSecretRef` | `object` | no | — |

**Example config**

```json
{
  "connectorId": "google-drive",
  "connectorConfig": {
    "folderId": "sample-folder",
    "includeNative": true
  }
}
```

---

### `discord_send_message` — Discord: Send Message

Send a message via a Discord webhook URL (or bot token).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `webhookUrl` | `string` | no | — |
| `secretRef` | `object` | no | — |
| `content` | `string` | no | — |
| `username` | `string` | no | — |
| `embedsJson` | `string` | no | — |

**Example config**

```json
{
  "webhookUrl": "https://discord.com/api/webhooks/.../.../",
  "content": "Notification from ai-orchestrator: {{user_prompt}}",
  "username": "orchestrator-bot"
}
```

---

### `github_action` — GitHub: Action

Execute a GitHub REST API operation (issues, PRs, files, commits).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `secretRef` | `object` | no | — |
| `owner` | `string` | yes | — |
| `repo` | `string` | yes | — |
| `operation` | `string` | yes | `createIssue` \| `commentIssue` \| `closeIssue` \| `createPr` \| `listIssues` \| `getFile` \| `createOrUpdateFile` \| `listCommits` |
| `issueNumber` | `number` | no | — |
| `title` | `string` | no | — |
| `body` | `string` | no | — |
| `head` | `string` | no | — |
| `base` | `string` | no | — |
| `path` | `string` | no | — |
| `content` | `string` | no | — |
| `sha` | `string` | no | — |
| `commitMessage` | `string` | no | — |
| `branch` | `string` | no | — |

**Example config**

```json
{
  "owner": "octocat",
  "repo": "hello-world",
  "operation": "listIssues"
}
```

---

### `google_calendar_create_event` — Google Calendar: Create Event

Create a calendar event using an OAuth access token stored as a secret.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `secretRef` | `object` | no | — |
| `calendarId` | `string` | yes | — |
| `summary` | `string` | yes | — |
| `description` | `string` | no | — |
| `start` | `string` | yes | — |
| `end` | `string` | yes | — |
| `timeZone` | `string` | no | — |
| `attendeesCsv` | `string` | no | — |

**Example config**

```json
{
  "calendarId": "primary",
  "summary": "Kick-off — {{user_prompt}}",
  "start": "2026-05-01T10:00:00",
  "end": "2026-05-01T11:00:00",
  "timeZone": "America/New_York"
}
```

---

### `google_calendar_list_events` — Google Calendar: List Events

List upcoming events from a Google Calendar.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `secretRef` | `object` | no | — |
| `calendarId` | `string` | yes | — |
| `timeMin` | `string` | no | — |
| `timeMax` | `string` | no | — |
| `maxResults` | `number` | no | — |
| `q` | `string` | no | — |

**Example config**

```json
{
  "calendarId": "primary",
  "maxResults": 25
}
```

---

### `google_drive_source` — Google Drive Source

Fetches Google Drive files as documents for RAG retrieval.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `folderId` | `string` | no | — |
| `fileIds` | `array<string>` | no | — |
| `query` | `string` | no | — |
| `maxFiles` | `number` | no | — |
| `includeSharedDrives` | `boolean` | no | — |
| `includeNativeGoogleDocs` | `boolean` | no | — |
| `useDemoFallback` | `boolean` | no | — |
| `secretRef` | `object` | no | — |

**Example config**

```json
{
  "folderId": "",
  "fileIds": [],
  "query": "",
  "maxFiles": 10,
  "includeSharedDrives": true,
  "includeNativeGoogleDocs": true,
  "useDemoFallback": true
}
```

---

### `google_sheets_append` — Google Sheets: Append

Append rows to a Google Sheet.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `spreadsheetId` | `string` | yes | — |
| `range` | `string` | yes | — |
| `values` | `any` | no | — |
| `valueInputOption` | `string` | no | `RAW` \| `USER_ENTERED` |
| `secretRef` | `object` | no | — |

**Example config**

```json
{
  "spreadsheetId": "1abcDEF",
  "range": "Sheet1!A1",
  "values": [
    [
      "a",
      "b"
    ]
  ],
  "valueInputOption": "USER_ENTERED"
}
```

---

### `google_sheets_read` — Google Sheets: Read

Read a range from a Google Sheet (OAuth access token or API key).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `spreadsheetId` | `string` | yes | — |
| `range` | `string` | yes | — |
| `authType` | `string` | yes | `accessToken` \| `apiKey` |
| `secretRef` | `object` | no | — |

**Example config**

```json
{
  "spreadsheetId": "1abcDEF",
  "range": "Sheet1!A1:D100",
  "authType": "accessToken"
}
```

---

### `google_sheets_update` — Google Sheets: Update

Update values in a Google Sheet range.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `spreadsheetId` | `string` | yes | — |
| `range` | `string` | yes | — |
| `values` | `any` | no | — |
| `valueInputOption` | `string` | no | `RAW` \| `USER_ENTERED` |
| `secretRef` | `object` | no | — |

**Example config**

```json
{
  "spreadsheetId": "1abcDEF",
  "range": "Sheet1!A1:B1",
  "values": [
    [
      "a",
      "b"
    ]
  ],
  "valueInputOption": "USER_ENTERED"
}
```

---

### `http_request` — HTTP Request

Performs a configurable HTTP request with templated URL, headers, and body.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `method` | `string` | yes | `GET` \| `POST` \| `PUT` \| `PATCH` \| `DELETE` |
| `urlTemplate` | `string` | yes | — |
| `headersTemplate` | `string` | no | — |
| `bodyTemplate` | `string` | no | — |
| `responseType` | `string` | no | `json` \| `text` |
| `secretRef` | `object` | no | — |
| `timeoutMs` | `number` | no | — |

**Example config**

```json
{
  "method": "GET",
  "urlTemplate": "https://api.example.com/v1/users/{{user_id}}",
  "headersTemplate": "{\n  \"Accept\": \"application/json\"\n}",
  "bodyTemplate": "{}",
  "responseType": "json",
  "timeoutMs": 15000
}
```

---

### `hubspot_create_contact` — HubSpot: Create Contact

Create a HubSpot contact using a private app access token.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `secretRef` | `object` | no | — |
| `propertiesJson` | `string` | no | — |

**Example config**

```json
{
  "propertiesJson": "{\"email\":\"{{user_prompt}}\",\"firstname\":\"Jane\"}"
}
```

---

### `hubspot_get_contact` — HubSpot: Get Contact

Fetch a HubSpot contact by ID or email.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `secretRef` | `object` | no | — |
| `identifier` | `string` | yes | — |
| `idProperty` | `string` | no | — |

**Example config**

```json
{
  "identifier": "someone@example.com",
  "idProperty": "email"
}
```

---

### `jira_create_issue` — Jira: Create Issue

Create a Jira Cloud issue. Auth via Atlassian API token (email:token basic auth stored in the secret).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `baseUrl` | `string` | yes | — |
| `secretRef` | `object` | no | — |
| `email` | `string` | no | — |
| `projectKey` | `string` | yes | — |
| `issueType` | `string` | yes | — |
| `summary` | `string` | yes | — |
| `description` | `string` | no | — |
| `fieldsJson` | `string` | no | — |

**Example config**

```json
{
  "baseUrl": "https://your-domain.atlassian.net",
  "email": "you@example.com",
  "projectKey": "ENG",
  "issueType": "Task",
  "summary": "New ticket from {{user_prompt}}"
}
```

---

### `jira_search_issues` — Jira: Search Issues

Run a JQL search against Jira Cloud.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `baseUrl` | `string` | yes | — |
| `secretRef` | `object` | no | — |
| `email` | `string` | no | — |
| `jql` | `string` | yes | — |
| `maxResults` | `number` | no | — |

**Example config**

```json
{
  "baseUrl": "https://your-domain.atlassian.net",
  "email": "you@example.com",
  "jql": "project = ENG AND status = \"To Do\"",
  "maxResults": 50
}
```

---

### `mongo_operation` — MongoDB: Operation

Perform find / insert / update / aggregate on MongoDB.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `uri` | `string` | no | — |
| `database` | `string` | yes | — |
| `collection` | `string` | yes | — |
| `operation` | `string` | yes | `find` \| `insert` \| `update` \| `aggregate` |
| `query` | `any` | no | — |
| `document` | `any` | no | — |
| `update` | `any` | no | — |
| `pipeline` | `any` | no | — |
| `secretRef` | `object` | no | — |

**Example config**

```json
{
  "uri": "mongodb://localhost:27017",
  "database": "app",
  "collection": "users",
  "operation": "find",
  "query": {
    "active": true
  }
}
```

---

### `mysql_query` — MySQL: Query

Execute a SQL query against MySQL.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `host` | `string` | yes | — |
| `port` | `number` | no | — |
| `database` | `string` | yes | — |
| `user` | `string` | yes | — |
| `secretRef` | `object` | no | — |
| `ssl` | `boolean` | no | — |
| `query` | `string` | yes | — |
| `params` | `array<any>` | no | — |

**Example config**

```json
{
  "host": "localhost",
  "port": 3306,
  "database": "app",
  "user": "root",
  "query": "SELECT * FROM users WHERE id = ?",
  "params": [
    1
  ]
}
```

---

### `notion_create_page` — Notion: Create Page

Create a page in a Notion database using an integration token.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `secretRef` | `object` | no | — |
| `databaseId` | `string` | yes | — |
| `titleProperty` | `string` | no | — |
| `title` | `string` | no | — |
| `propertiesJson` | `string` | no | — |
| `contentMarkdown` | `string` | no | — |

**Example config**

```json
{
  "databaseId": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "titleProperty": "Name",
  "title": "New entry from {{user_prompt}}",
  "propertiesJson": "{}"
}
```

---

### `notion_query_database` — Notion: Query Database

Query a Notion database with optional filter/sort JSON.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `secretRef` | `object` | no | — |
| `databaseId` | `string` | yes | — |
| `filterJson` | `string` | no | — |
| `sortsJson` | `string` | no | — |
| `pageSize` | `number` | no | — |

**Example config**

```json
{
  "databaseId": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "pageSize": 50
}
```

---

### `postgres_query` — PostgreSQL: Query

Execute a SQL query against PostgreSQL and return rows.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `host` | `string` | yes | — |
| `port` | `number` | no | — |
| `database` | `string` | yes | — |
| `user` | `string` | yes | — |
| `secretRef` | `object` | no | — |
| `ssl` | `boolean` | no | — |
| `query` | `string` | yes | — |
| `params` | `array<any>` | no | — |

**Example config**

```json
{
  "host": "localhost",
  "port": 5432,
  "database": "postgres",
  "user": "postgres",
  "ssl": false,
  "query": "SELECT * FROM users WHERE id = $1",
  "params": [
    1
  ]
}
```

---

### `qdrant_vector_store` — Qdrant Vector Store

Runs vector retrieval and document upsert operations against a Qdrant collection.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `operation` | `string` | yes | `get_ranked_documents` \| `add_documents` \| `retrieve_for_chain_tool` \| `retrieve_for_ai_agent_tool` |
| `endpoint` | `string` | no | — |
| `collectionName` | `string` | no | — |
| `apiKeyHeaderName` | `string` | no | — |
| `queryText` | `string` | no | — |
| `queryVectorJson` | `string` | no | — |
| `filterJson` | `string` | no | — |
| `documentsJson` | `string` | no | — |
| `topK` | `number` | no | — |
| `contentField` | `string` | no | — |
| `metadataField` | `string` | no | — |
| `secretRef` | `object` | no | — |
| `useDemoFallback` | `boolean` | no | — |

**Example config**

```json
{
  "operation": "get_ranked_documents",
  "endpoint": "http://localhost:6333",
  "collectionName": "documents",
  "apiKeyHeaderName": "api-key",
  "queryText": "{{user_prompt}}",
  "topK": 5,
  "contentField": "content",
  "metadataField": "metadata",
  "useDemoFallback": true
}
```

---

### `redis_command` — Redis: Command

Execute a Redis command (GET/SET/DEL/PUBLISH/LPUSH/RPUSH/HSET/HGET/EXPIRE).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `url` | `string` | no | — |
| `secretRef` | `object` | no | — |
| `command` | `string` | yes | `GET` \| `SET` \| `DEL` \| `PUBLISH` \| `LPUSH` \| `RPUSH` \| `HSET` \| `HGET` \| `EXPIRE` \| `INCR` \| `DECR` |
| `args` | `array<any>` | no | — |

**Example config**

```json
{
  "url": "redis://localhost:6379",
  "command": "SET",
  "args": [
    "greeting",
    "hello"
  ]
}
```

---

### `salesforce_create_record` — Salesforce: Create Record

Create a record on a Salesforce sObject. Auth via OAuth access token stored as a secret.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `instanceUrl` | `string` | yes | — |
| `apiVersion` | `string` | no | — |
| `secretRef` | `object` | no | — |
| `sobject` | `string` | yes | — |
| `fieldsJson` | `string` | no | — |

**Example config**

```json
{
  "instanceUrl": "https://your-instance.my.salesforce.com",
  "apiVersion": "v58.0",
  "sobject": "Lead",
  "fieldsJson": "{\"LastName\":\"Smith\",\"Company\":\"Acme\"}"
}
```

---

### `salesforce_query` — Salesforce: SOQL Query

Run a SOQL query against Salesforce.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `instanceUrl` | `string` | yes | — |
| `apiVersion` | `string` | no | — |
| `secretRef` | `object` | no | — |
| `soql` | `string` | yes | — |

**Example config**

```json
{
  "instanceUrl": "https://your-instance.my.salesforce.com",
  "apiVersion": "v58.0",
  "soql": "SELECT Id, Name FROM Account LIMIT 10"
}
```

---

### `slack_send_message` — Slack: Send Message

Post a message to a Slack channel via webhook or bot token.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `authType` | `string` | yes | `webhook` \| `bot` |
| `webhookUrl` | `string` | no | — |
| `secretRef` | `object` | no | — |
| `channel` | `string` | no | — |
| `text` | `string` | no | — |
| `blocks` | `string` | no | — |
| `threadTs` | `string` | no | — |

**Example config**

```json
{
  "authType": "webhook",
  "webhookUrl": "https://hooks.slack.com/services/T000/B000/XXX",
  "channel": "#general",
  "text": "Hello from ai-orchestrator {{user_prompt}}"
}
```

---

### `smtp_send_email` — SMTP: Send Email

Send email via SMTP (nodemailer).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `host` | `string` | yes | — |
| `port` | `number` | yes | — |
| `secure` | `boolean` | no | — |
| `user` | `string` | no | — |
| `secretRef` | `object` | no | — |
| `from` | `string` | yes | — |
| `to` | `string` | yes | — |
| `subject` | `string` | yes | — |
| `text` | `string` | no | — |
| `html` | `string` | no | — |

**Example config**

```json
{
  "host": "smtp.example.com",
  "port": 587,
  "secure": false,
  "user": "no-reply@example.com",
  "from": "no-reply@example.com",
  "to": "user@example.com",
  "subject": "Hello",
  "text": "{{user_prompt}}"
}
```

---

### `stripe_create_charge` — Stripe: Create PaymentIntent

Create a Stripe PaymentIntent (the modern replacement for Charges).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `secretRef` | `object` | no | — |
| `amount` | `number` | yes | — |
| `currency` | `string` | yes | — |
| `customerId` | `string` | no | — |
| `description` | `string` | no | — |
| `metadataJson` | `string` | no | — |

**Example config**

```json
{
  "amount": 1000,
  "currency": "usd",
  "description": "Charge from ai-orchestrator"
}
```

---

### `stripe_create_customer` — Stripe: Create Customer

Create a Stripe customer. Secret must contain a restricted/private API key.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `secretRef` | `object` | no | — |
| `email` | `string` | no | — |
| `name` | `string` | no | — |
| `description` | `string` | no | — |
| `metadataJson` | `string` | no | — |

**Example config**

```json
{
  "email": "{{user_prompt}}",
  "name": "Customer from ai-orchestrator"
}
```

---

### `teams_send_message` — Microsoft Teams: Send Message

Post a card or text message to a Microsoft Teams channel via an incoming webhook.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `webhookUrl` | `string` | no | — |
| `secretRef` | `object` | no | — |
| `text` | `string` | no | — |
| `title` | `string` | no | — |
| `themeColor` | `string` | no | — |
| `cardJson` | `string` | no | — |

**Example config**

```json
{
  "webhookUrl": "https://outlook.office.com/webhook/...",
  "text": "Hello from ai-orchestrator {{user_prompt}}",
  "title": "Notification",
  "themeColor": "0078D4"
}
```

---

### `telegram_send_message` — Telegram: Send Message

Send a Telegram message via the Bot API. Secret stores the bot token.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `secretRef` | `object` | no | — |
| `chatId` | `string` | yes | — |
| `text` | `string` | yes | — |
| `parseMode` | `string` | no | `` \| `Markdown` \| `MarkdownV2` \| `HTML` |
| `disableWebPagePreview` | `boolean` | no | — |

**Example config**

```json
{
  "chatId": "@my_channel",
  "text": "Hello from ai-orchestrator {{user_prompt}}",
  "parseMode": "Markdown"
}
```

---

### `twilio_send_sms` — Twilio: Send SMS

Send an SMS via Twilio. Secret stores the auth token paired with the Account SID in config.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `accountSid` | `string` | yes | — |
| `secretRef` | `object` | no | — |
| `from` | `string` | yes | — |
| `to` | `string` | yes | — |
| `body` | `string` | yes | — |

**Example config**

```json
{
  "accountSid": "AC...",
  "from": "+15551234567",
  "to": "+15557654321",
  "body": "Alert: {{user_prompt}}"
}
```

---

### `web_browse` — Web Browse

Drives a headless Chromium to fetch a URL, wait for JS, and extract structured page data: rendered HTML, page text, screenshot, title, meta tags, links, and images. Use when http_request can't see the page (SPAs, JS-rendered content) or when an LLM needs to reason about a page's actual look.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `url` | `string` | no | — |
| `urlTemplate` | `string` | no | — |
| `waitUntil` | `string` | no | `load` \| `domcontentloaded` \| `networkidle` \| `commit` |
| `timeoutMs` | `number` | no | — |
| `userAgent` | `string` | no | — |
| `viewportWidth` | `number` | no | — |
| `viewportHeight` | `number` | no | — |
| `extraHeadersJson` | `string` | no | — |
| `screenshot` | `any` | no | — |
| `extractText` | `boolean` | no | — |
| `extractLinks` | `boolean` | no | — |
| `extractImages` | `boolean` | no | — |
| `waitForSelector` | `string` | no | — |
| `outputKey` | `string` | no | — |

**Example config**

```json
{
  "url": "https://example.com",
  "waitUntil": "domcontentloaded",
  "timeoutMs": 30000,
  "screenshot": true,
  "extractText": true,
  "extractLinks": true,
  "extractImages": true
}
```
