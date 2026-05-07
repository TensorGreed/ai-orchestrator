<!--
  Generated from packages/shared/src/definitions.ts.
  DO NOT EDIT BY HAND — run `pnpm --filter @ai-orchestrator/docs gen:nodes`
  (or `pnpm docs:build`) to regenerate.
-->

# Input nodes

Workflow entry points: triggers (cron, webhook, manual, form, chat, MCP-server) and static-input helpers.

27 nodes.

---
### `chat_trigger` — Chat Trigger

Receive chat messages via POST /api/chat/:workflowId. Pairs naturally with agent_orchestrator.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `path` | `string` | no | — |
| `authMode` | `string` | no | `public` \| `session` \| `bearer` |
| `secretRef` | `object` | no | — |
| `persistMessages` | `boolean` | no | — |
| `sessionNamespace` | `string` | no | — |
| `welcomeMessage` | `string` | no | — |

**Example config**

```json
{
  "path": "support",
  "authMode": "session",
  "persistMessages": true,
  "sessionNamespace": "chat-support",
  "welcomeMessage": "How can I help today?"
}
```

---

### `discord_trigger` — Discord Trigger

Webhook-based trigger validated with Ed25519 signature (X-Signature-Ed25519 + X-Signature-Timestamp).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `path` | `string` | no | — |
| `publicKey` | `string` | yes | — |

**Example config**

```json
{
  "path": "discord-interactions",
  "publicKey": "<application public key (hex)>"
}
```

---

### `error_trigger` — Error Trigger

Fires when a designated production workflow fails. Configure target workflows in their Error Workflow setting.

**Config fields**

_No configurable fields._

**Example config**

```json
{}
```

---

### `file_trigger` — File Trigger

Watches a filesystem path (polling) and fires on created/modified/deleted files.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `watchPath` | `string` | yes | — |
| `events` | `array<string>` | no | — |
| `pattern` | `string` | no | — |
| `recursive` | `boolean` | no | — |
| `pollIntervalSeconds` | `number` | no | — |
| `active` | `boolean` | no | — |

**Example config**

```json
{
  "watchPath": "./data/inbox",
  "events": [
    "created",
    "modified"
  ],
  "pattern": "*.csv",
  "recursive": false,
  "pollIntervalSeconds": 30,
  "active": true
}
```

---

### `form_trigger` — Form Trigger

Public HTML form that starts a workflow. GET /api/forms/:path renders the form, POST submits.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `path` | `string` | yes | — |
| `title` | `string` | no | — |
| `description` | `string` | no | — |
| `submitLabel` | `string` | no | — |
| `authMode` | `string` | no | `public` \| `session` |
| `successMessage` | `string` | no | — |
| `fields` | `array<object>` | yes | — |

**Example config**

```json
{
  "path": "feedback",
  "title": "Submit feedback",
  "description": "Tell us what you think.",
  "submitLabel": "Send",
  "authMode": "public",
  "successMessage": "Thanks — your response was recorded.",
  "fields": [
    {
      "name": "name",
      "label": "Name",
      "type": "text",
      "required": true
    },
    {
      "name": "email",
      "label": "Email",
      "type": "email",
      "required": true
    },
    {
      "name": "message",
      "label": "Message",
      "type": "textarea",
      "required": true
    }
  ]
}
```

---

### `github_webhook_trigger` — GitHub Webhook Trigger

Webhook trigger that validates the X-Hub-Signature-256 header.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `path` | `string` | no | — |
| `secretRef` | `object` | no | — |

**Example config**

```json
{
  "path": "github-events"
}
```

---

### `google_drive_trigger` — Google Drive Trigger

Poll a Google Drive folder for new or modified files using an access token.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `secretRef` | `object` | no | — |
| `folderId` | `string` | yes | — |
| `query` | `string` | no | — |
| `pollIntervalSeconds` | `number` | no | — |

**Example config**

```json
{
  "folderId": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "pollIntervalSeconds": 60
}
```

---

### `google_sheets_trigger` — Google Sheets Trigger

Polling trigger that detects new rows since the last run.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `spreadsheetId` | `string` | yes | — |
| `range` | `string` | yes | — |
| `authType` | `string` | no | `accessToken` \| `apiKey` |
| `secretRef` | `object` | no | — |
| `pollIntervalSeconds` | `number` | no | — |

**Example config**

```json
{
  "spreadsheetId": "1abcDEF",
  "range": "Sheet1!A:Z",
  "authType": "accessToken",
  "pollIntervalSeconds": 60
}
```

---

### `imap_email_trigger` — IMAP Email Trigger

Poll an IMAP inbox for new messages (requires imapflow — stubbed if missing).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `host` | `string` | yes | — |
| `port` | `number` | yes | — |
| `secure` | `boolean` | no | — |
| `user` | `string` | yes | — |
| `secretRef` | `object` | no | — |
| `mailbox` | `string` | no | — |
| `pollIntervalSeconds` | `number` | no | — |

**Example config**

```json
{
  "host": "imap.example.com",
  "port": 993,
  "secure": true,
  "user": "user@example.com",
  "mailbox": "INBOX",
  "pollIntervalSeconds": 60
}
```

---

### `kafka_trigger` — Kafka Trigger

Consume messages from a Kafka topic (requires 'kafkajs' — emits NOT_IMPLEMENTED if missing).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `brokers` | `array<string>` | yes | — |
| `topic` | `string` | yes | — |
| `groupId` | `string` | yes | — |
| `fromBeginning` | `boolean` | no | — |
| `secretRef` | `object` | no | — |
| `active` | `boolean` | no | — |

**Example config**

```json
{
  "brokers": [
    "localhost:9092"
  ],
  "topic": "events",
  "groupId": "ai-orchestrator",
  "fromBeginning": false,
  "active": true
}
```

---

### `manual_trigger` — Manual Trigger

Start the workflow manually from the editor or via POST /api/triggers/manual/:workflowId.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `testData` | `any` | no | — |
| `label` | `string` | no | — |

**Example config**

```json
{
  "label": "Run manually",
  "testData": {
    "user_prompt": "Hello"
  }
}
```

---

### `mcp_server_trigger` — Expose as MCP Tool

Turn this workflow into an MCP tool that other agents (including other L2M agents) can invoke. Serves a manifest at GET /api/mcp-server/:path/manifest and accepts calls at POST /api/mcp-server/:path/invoke. Downstream nodes receive the tool arguments as input.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `path` | `string` | yes | — |
| `toolName` | `string` | yes | — |
| `toolDescription` | `string` | no | — |
| `inputSchema` | `object` | no | — |
| `authMode` | `string` | no | `public` \| `bearer` |
| `secretRef` | `object` | no | — |

**Example config**

```json
{
  "path": "helper",
  "toolName": "query_knowledge_base",
  "toolDescription": "Answer a question using the knowledge base.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "question": {
        "type": "string"
      }
    },
    "required": [
      "question"
    ]
  },
  "authMode": "public"
}
```

---

### `mqtt_trigger` — MQTT Trigger

Subscribe to an MQTT topic (requires 'mqtt' — emits NOT_IMPLEMENTED if missing).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `brokerUrl` | `string` | yes | — |
| `topic` | `string` | yes | — |
| `qos` | `number` | no | — |
| `clientId` | `string` | no | — |
| `secretRef` | `object` | no | — |
| `active` | `boolean` | no | — |

**Example config**

```json
{
  "brokerUrl": "mqtt://localhost:1883",
  "topic": "sensors/+/data",
  "qos": 1,
  "active": true
}
```

---

### `postgres_trigger` — PostgreSQL Trigger

Polling trigger: execute a SELECT periodically and emit new rows.

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
| `pollIntervalSeconds` | `number` | no | — |

**Example config**

```json
{
  "host": "localhost",
  "port": 5432,
  "database": "postgres",
  "user": "postgres",
  "query": "SELECT * FROM events WHERE created_at > NOW() - interval '1 minute'",
  "pollIntervalSeconds": 60
}
```

---

### `rabbitmq_trigger` — RabbitMQ Trigger

Consume messages from a RabbitMQ queue (requires 'amqplib' — emits NOT_IMPLEMENTED if missing).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `url` | `string` | yes | — |
| `queue` | `string` | yes | — |
| `prefetch` | `number` | no | — |
| `secretRef` | `object` | no | — |
| `active` | `boolean` | no | — |

**Example config**

```json
{
  "url": "amqp://localhost",
  "queue": "events",
  "prefetch": 1,
  "active": true
}
```

---

### `redis_trigger` — Redis Trigger

Subscribe / blocking-pop trigger (polling fallback with BLPOP).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `url` | `string` | no | — |
| `secretRef` | `object` | no | — |
| `mode` | `string` | yes | `subscribe` \| `blpop` |
| `channel` | `string` | no | — |
| `key` | `string` | no | — |
| `timeoutSeconds` | `number` | no | — |

**Example config**

```json
{
  "url": "redis://localhost:6379",
  "mode": "subscribe",
  "channel": "events"
}
```

---

### `rss_trigger` — RSS / Atom Trigger

Poll an RSS or Atom feed and fire the workflow for new items (deduplicated by GUID).

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `feedUrl` | `string` | yes | — |
| `pollIntervalSeconds` | `number` | no | — |
| `maxItemsPerTick` | `number` | no | — |
| `headers` | `object` | no | — |
| `active` | `boolean` | no | — |

**Example config**

```json
{
  "feedUrl": "https://example.com/feed.xml",
  "pollIntervalSeconds": 300,
  "maxItemsPerTick": 20,
  "active": true
}
```

---

### `schedule_trigger` — Schedule Trigger

Triggers workflow execution automatically from a cron schedule.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `cronExpression` | `string` | yes | — |
| `timezone` | `string` | yes | — |
| `active` | `boolean` | yes | — |

**Example config**

```json
{
  "cronExpression": "0 9 * * *",
  "timezone": "America/Toronto",
  "active": true
}
```

---

### `slack_trigger` — Slack Trigger

Webhook-based trigger that validates Slack signing secret. Point Slack Events at /api/webhooks/slack/:workflowId.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `path` | `string` | no | — |
| `signingSecretRef` | `object` | no | — |
| `replayToleranceSeconds` | `number` | no | — |

**Example config**

```json
{
  "path": "slack-events",
  "replayToleranceSeconds": 300
}
```

---

### `sse_trigger` — SSE Trigger

Connects to a Server-Sent Events URL and fires the workflow for each event.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `url` | `string` | yes | — |
| `eventName` | `string` | no | — |
| `authMode` | `string` | no | `none` \| `bearer` |
| `secretRef` | `object` | no | — |
| `reconnectDelaySeconds` | `number` | no | — |
| `maxEventsPerMinute` | `number` | no | — |
| `active` | `boolean` | no | — |

**Example config**

```json
{
  "url": "https://example.com/sse",
  "authMode": "none",
  "reconnectDelaySeconds": 5,
  "maxEventsPerMinute": 60,
  "active": true
}
```

---

### `stripe_webhook_trigger` — Stripe Webhook Trigger

Webhook-based trigger that validates Stripe signatures. Point Stripe at /api/webhooks/stripe/:workflowId.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `path` | `string` | no | — |
| `signingSecretRef` | `object` | no | — |
| `replayToleranceSeconds` | `number` | no | — |

**Example config**

```json
{
  "path": "stripe-events",
  "replayToleranceSeconds": 300
}
```

---

### `sub_workflow_trigger` — Sub-Workflow Trigger

Entry point for workflows invoked as sub-workflows via Execute Workflow node.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `description` | `string` | no | — |
| `inputSchema` | `object` | no | — |

**Example config**

```json
{
  "description": "Sub-workflow entry point"
}
```

---

### `system_prompt` — System Prompt

Static system prompt node.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `text` | `string` | yes | — |

**Example config**

```json
{
  "text": "You are an assistant that answers with concise factual output."
}
```

---

### `telegram_trigger` — Telegram Trigger

Webhook-based trigger validated by X-Telegram-Bot-Api-Secret-Token. Point setWebhook at /api/webhooks/telegram/:workflowId.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `path` | `string` | no | — |
| `signingSecretRef` | `object` | no | — |

**Example config**

```json
{
  "path": "telegram-events"
}
```

---

### `text_input` — Text Input

Provides static input text for a workflow run.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `text` | `string` | yes | — |

**Example config**

```json
{
  "text": "What is the latest release?"
}
```

---

### `user_prompt` — User Prompt

Static user prompt node.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `text` | `string` | yes | — |

**Example config**

```json
{
  "text": "Summarize this context."
}
```

---

### `webhook_input` — Webhook Input

Injects webhook payload into workflow context.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `path` | `string` | no | — |
| `method` | `string` | no | `POST` \| `GET` \| `PUT` \| `PATCH` \| `DELETE` |
| `passThroughFields` | `array<string>` | no | — |
| `authMode` | `string` | no | `none` \| `bearer_token` \| `hmac_sha256` |
| `authHeaderName` | `string` | no | — |
| `signatureHeaderName` | `string` | no | — |
| `timestampHeaderName` | `string` | no | — |
| `secretRef` | `object` | no | — |
| `replayToleranceSeconds` | `number` | no | — |
| `idempotencyEnabled` | `boolean` | no | — |
| `idempotencyHeaderName` | `string` | no | — |
| `responseMode` | `string` | no | `onReceived` \| `lastNode` \| `responseNode` |
| `responseCode` | `number` | no | — |
| `responseHeaders` | `object` | no | — |
| `responseBody` | `string` | no | — |

**Example config**

```json
{
  "path": "agent-demo",
  "method": "POST",
  "passThroughFields": [
    "system_prompt",
    "user_prompt",
    "session_id",
    "variables"
  ],
  "authMode": "none",
  "authHeaderName": "authorization",
  "signatureHeaderName": "x-webhook-signature",
  "timestampHeaderName": "x-webhook-timestamp",
  "replayToleranceSeconds": 300,
  "idempotencyEnabled": false,
  "idempotencyHeaderName": "idempotency-key",
  "responseMode": "lastNode",
  "responseCode": 200
}
```
