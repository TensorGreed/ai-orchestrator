<!-- DO NOT EDIT BY HAND. Generated from the external workflow import registration table by
     `pnpm --filter @ai-orchestrator/workflow-engine gen:import-coverage`. -->

### Triggers

| Source node type | L2M node | Notes |
|---|---|---|
| `n8n-nodes-base.manualTrigger` | `manual_trigger` | Direct mapping. |
| `n8n-nodes-base.webhook` | `webhook_input` | Header auth becomes bearer_token on the authorization header; other auth modes are dropped. |
| `n8n-nodes-base.scheduleTrigger` | `schedule_trigger` | Interval rules become cron; only the first rule is kept; second-level intervals become every minute. |
| `n8n-nodes-base.cron` | `schedule_trigger` | Legacy trigger times become cron; only the first entry is kept. |
| `n8n-nodes-base.interval` | `schedule_trigger` | Defaults to hourly when no interval can be read. |
| `@n8n/n8n-nodes-langchain.chatTrigger` | `chat_trigger` | Direct mapping. |
| `n8n-nodes-base.errorTrigger` | `error_trigger` | Direct mapping. |
| `n8n-nodes-base.formTrigger` | `form_trigger` | File fields become text fields. |
| `n8n-nodes-base.rssFeedReadTrigger` | `rss_trigger` | Poll times become a poll interval in seconds. |
| `n8n-nodes-base.emailReadImap` | `imap_email_trigger` | Host, port and user live in the credential and must be filled in after import. |

### Core nodes

| Source node type | L2M node | Notes |
|---|---|---|
| `n8n-nodes-base.httpRequest` | `http_request` | Query parameters are appended to the URL; binary responses become text; auth becomes a secretRef placeholder. |
| `n8n-nodes-base.code` | `code_node` | JavaScript is wrapped in a compatibility shim; Python is kept verbatim. |
| `n8n-nodes-base.function` | `code_node` | Legacy function code is wrapped in the same compatibility shim. |
| `n8n-nodes-base.set` | `set_node` | 'Keep only set fields' is not supported; other fields pass through. |
| `n8n-nodes-base.if` | `if_node` | Conditions compile to one expression; outputs 0 and 1 become the true and false handles. |
| `n8n-nodes-base.switch` | `switch_node` | Same-field equality rules become cases; other rule sets compile to a routing expression. |
| `n8n-nodes-base.merge` | `merge_node` | Combine-by-fields keeps the first match field; SQL and position combines become append. |
| `n8n-nodes-base.splitOut` | `split_out_node` | Only the first field to split out is kept. |
| `n8n-nodes-base.itemLists` | `split_out_node` | Legacy item list node treated as split out. |
| `n8n-nodes-base.aggregate` | `aggregate_node` | Collecting values into an array is approximated with the concatenate operation. |
| `n8n-nodes-base.filter` | `filter_node` | Field-path conditions map directly; expression conditions need review. |
| `n8n-nodes-base.sort` | `sort_node` | Only the first sort field is kept; custom sort code needs review. |
| `n8n-nodes-base.limit` | `limit_node` | Direct mapping. |
| `n8n-nodes-base.wait` | `wait_node` | Timer, webhook and specific-time resumes are supported; form resume is approximated as a timer. |
| `n8n-nodes-base.noOp` | `noop_node` | Direct mapping. |
| `n8n-nodes-base.stopAndError` | `stop_and_error` | Error objects are reduced to message and errorCode. |
| `n8n-nodes-base.executeWorkflow` | `execute_workflow` | The workflow id refers to the source system and must be repointed; per-item mode becomes a single call. |
| `n8n-nodes-base.stickyNote` | `sticky_note` | Direct mapping. |

### AI nodes

| Source node type | L2M node | Notes |
|---|---|---|
| `@n8n/n8n-nodes-langchain.lmChatOpenAi` | `openai_chat_model` | Direct mapping. |
| `@n8n/n8n-nodes-langchain.lmOpenAi` | `openai_chat_model` | Completion model approximated as a chat model. |
| `@n8n/n8n-nodes-langchain.lmChatAnthropic` | `anthropic_chat_model` | Direct mapping. |
| `@n8n/n8n-nodes-langchain.lmChatGoogleGemini` | `google_gemini_chat_model` | Direct mapping. |
| `@n8n/n8n-nodes-langchain.lmChatOllama` | `ollama_chat_model` | Base URL defaults to the local Ollama endpoint. |
| `@n8n/n8n-nodes-langchain.lmOllama` | `ollama_chat_model` | Base URL defaults to the local Ollama endpoint. |
| `@n8n/n8n-nodes-langchain.lmChatAzureOpenAi` | `azure_openai_chat_model` | The endpoint lives in the credential and must be set after import. |
| `@n8n/n8n-nodes-langchain.lmChatOpenRouter` | `openai_compatible_chat_model` | OpenAI-compatible endpoint with the provider's public base URL. |
| `@n8n/n8n-nodes-langchain.lmChatGroq` | `openai_compatible_chat_model` | OpenAI-compatible endpoint with the provider's public base URL. |
| `@n8n/n8n-nodes-langchain.lmChatMistralCloud` | `openai_compatible_chat_model` | OpenAI-compatible endpoint with the provider's public base URL. |
| `@n8n/n8n-nodes-langchain.lmChatDeepSeek` | `openai_compatible_chat_model` | OpenAI-compatible endpoint with the provider's public base URL. |
| `@n8n/n8n-nodes-langchain.lmChatXAiGrok` | `openai_compatible_chat_model` | OpenAI-compatible endpoint with the provider's public base URL. |
| `@n8n/n8n-nodes-langchain.agent` | `agent_orchestrator` | Model, memory and tool sub-nodes become attachment edges; an attached output parser becomes the next step. |
| `@n8n/n8n-nodes-langchain.memoryBufferWindow` | `local_memory` | Direct mapping. |
| `@n8n/n8n-nodes-langchain.memoryPostgresChat` | `local_memory` | External memory stores are approximated with the local Simple Memory store. |
| `@n8n/n8n-nodes-langchain.memoryRedisChat` | `local_memory` | External memory stores are approximated with the local Simple Memory store. |
| `@n8n/n8n-nodes-langchain.memoryMongoDbChat` | `local_memory` | External memory stores are approximated with the local Simple Memory store. |
| `@n8n/n8n-nodes-langchain.memoryZep` | `local_memory` | External memory stores are approximated with the local Simple Memory store. |
| `@n8n/n8n-nodes-langchain.memoryMotorhead` | `local_memory` | External memory stores are approximated with the local Simple Memory store. |
| `@n8n/n8n-nodes-langchain.memoryXata` | `local_memory` | External memory stores are approximated with the local Simple Memory store. |
| `@n8n/n8n-nodes-langchain.mcpClientTool` | `mcp_tool` | SSE transport becomes HTTP streamable; tool exclusion lists are not supported. |
| `@n8n/n8n-nodes-langchain.outputParserStructured` | `output_parser` | Runs as a step after the agent; schemas are inferred from example output when no manual schema is given. |
| `@n8n/n8n-nodes-langchain.lmChat*` | `openai_compatible_chat_model` | Any other chat model type is approximated as an OpenAI-compatible endpoint with a placeholder base URL. |

### App nodes

| Source node type | L2M node | Notes |
|---|---|---|
| `n8n-nodes-base.slack` | `slack_send_message` | Message posting maps to a bot-token send; attachments and most message options are dropped; other resources and operations become placeholders. |
| `n8n-nodes-base.slackTrigger` | `slack_trigger` | Event and channel filters are not supported; the signing secret becomes a placeholder. |
| `n8n-nodes-base.telegram` | `telegram_send_message` | Text messages map directly; keyboards and most options are dropped; other resources and operations become placeholders. |
| `n8n-nodes-base.telegramTrigger` | `telegram_trigger` | Update filters are not supported; the webhook secret token becomes a placeholder. |
| `n8n-nodes-base.discord` | `discord_send_message` | Webhook sends map with content, username and embeds; bot-token sends and other operations become placeholders. |
| `n8n-nodes-base.discordTrigger` | `discord_trigger` | Event filters are not supported; the application public key must be set after import. |
| `n8n-nodes-base.github` | `github_action` | Issue create/comment/close, file get/create/edit and repository issue listing map to github_action operations; labels, assignees and filters are dropped; other operations become placeholders. |
| `n8n-nodes-base.githubTrigger` | `github_webhook_trigger` | Event filters are not supported; the webhook must be created on the repository by hand. |
| `n8n-nodes-base.jira` | `jira_create_issue` | Issue creation and JQL search map; the site URL and email live in the credential; other operations become placeholders. |
| `n8n-nodes-base.notion` | `notion_create_page` | Database page creation and querying map; simple property types are translated, manual filters and content blocks are dropped; other operations become placeholders. |
| `n8n-nodes-base.googleSheets` | `google_sheets_read` | Read, append, append-or-update and update map to the Sheets nodes; row filters and header matching are dropped; sheets picked by gid need the range set; other operations become placeholders. |
| `n8n-nodes-base.googleSheetsTrigger` | `google_sheets_trigger` | Polls the sheet for new rows; row-update events are approximated. |
| `n8n-nodes-base.postgres` | `postgres_query` | Execute-query and select map to a query; the connection details live in the credential; insert, update, upsert and delete become placeholders. |
| `n8n-nodes-base.postgresTrigger` | `postgres_trigger` | Table and LISTEN triggers are approximated as a polling query. |
| `n8n-nodes-base.airtable` | `airtable_list_records` | Search, create and update map to the Airtable nodes; auto-mapped fields are dropped; get, upsert and delete become placeholders. |
| `n8n-nodes-base.awsS3` | `aws_s3_get_object` | File download, upload and listing map to the S3 nodes; the region lives in the credential; binary uploads need the body set; bucket and folder operations become placeholders. |
| `n8n-nodes-base.hubspot` | `hubspot_create_contact` | Contact create-or-update becomes a create and contact get maps directly; other resources and operations become placeholders. |
| `n8n-nodes-base.salesforce` | `salesforce_create_record` | Record creation and SOQL search map; list operations become SOQL; the instance URL lives in the credential; other operations become placeholders. |
| `n8n-nodes-base.stripe` | `stripe_create_customer` | Customer and charge creation map with metadata; addresses, shipping and payment sources are dropped; other resources and operations become placeholders. |
| `n8n-nodes-base.stripeTrigger` | `stripe_webhook_trigger` | Event filters are not supported; the signing secret becomes a placeholder. |

Any other source node type is imported as a disabled `noop_node` placeholder that keeps the original parameters, so the workflow still loads and validates.
