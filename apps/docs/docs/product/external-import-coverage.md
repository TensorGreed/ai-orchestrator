<!-- DO NOT EDIT BY HAND. Generated from the external workflow import registration table by
     `pnpm --filter @ai-orchestrator/workflow-engine gen:import-coverage`. -->

### Triggers

| Source node type | L2M node | Notes |
|---|---|---|
| `manualTrigger` | `manual_trigger` | Direct mapping. |
| `webhook` | `webhook_input` | Header auth becomes bearer_token on the authorization header; other auth modes are dropped. |
| `scheduleTrigger` | `schedule_trigger` | Interval rules become cron; only the first rule is kept; second-level intervals become every minute. |
| `cron` | `schedule_trigger` | Legacy trigger times become cron; only the first entry is kept. |
| `interval` | `schedule_trigger` | Defaults to hourly when no interval can be read. |
| `langchain.chatTrigger` | `chat_trigger` | Direct mapping. |
| `errorTrigger` | `error_trigger` | Direct mapping. |
| `formTrigger` | `form_trigger` | File fields become text fields. |
| `rssFeedReadTrigger` | `rss_trigger` | Poll times become a poll interval in seconds. |
| `emailReadImap` | `imap_email_trigger` | Not supported yet: imported disabled, with its mailbox and credential kept. |

### Core nodes

| Source node type | L2M node | Notes |
|---|---|---|
| `httpRequest` | `http_request` | Query parameters are appended to the URL; binary responses become text; auth becomes a secretRef placeholder. |
| `code` | `code_node` | JavaScript is wrapped in a compatibility shim; Python is kept verbatim. |
| `function` | `code_node` | Legacy function code is wrapped in the same compatibility shim. |
| `set` | `set_node` | Field types are kept (string, number, boolean; arrays and objects as JSON). 'Keep only set fields' is not supported; other fields pass through. |
| `if` | `if_node` | Conditions compile to one expression; outputs 0 and 1 become the true and false handles. |
| `switch` | `switch_node` | Same-field equality rules become cases; other rule sets compile to a routing expression. |
| `merge` | `merge_node` | Combine-by-fields keeps the first match field; SQL and position combines become append. |
| `splitOut` | `split_out_node` | Only the first field to split out is kept. |
| `itemLists` | `split_out_node` | Legacy item list node treated as split out. |
| `aggregate` | `aggregate_node` | Collecting values into an array is approximated with the concatenate operation. |
| `filter` | `filter_node` | Maps to Pass or stop mode: an imported node's output is one item, which passes or is filtered out. Field-path conditions map directly; expression conditions need review. |
| `sort` | `sort_node` | Only the first sort field is kept; custom sort code needs review. |
| `limit` | `limit_node` | Direct mapping. |
| `wait` | `wait_node` | Timer, webhook and specific-time resumes are supported; form resume is approximated as a timer. |
| `noOp` | `noop_node` | Direct mapping. |
| `stopAndError` | `stop_and_error` | Error objects are reduced to message and errorCode. |
| `executeWorkflow` | `execute_workflow` | The workflow id refers to the source system and must be repointed; per-item mode becomes a single call. |
| `stickyNote` | `sticky_note` | Direct mapping. |

### AI nodes

| Source node type | L2M node | Notes |
|---|---|---|
| `langchain.lmChatOpenAi` | `openai_chat_model` | Direct mapping. |
| `langchain.lmOpenAi` | `openai_chat_model` | Completion model approximated as a chat model. |
| `langchain.lmChatAnthropic` | `anthropic_chat_model` | Direct mapping. |
| `langchain.lmChatGoogleGemini` | `google_gemini_chat_model` | Direct mapping. |
| `langchain.lmChatOllama` | `ollama_chat_model` | Base URL defaults to the local Ollama endpoint. |
| `langchain.lmOllama` | `ollama_chat_model` | Base URL defaults to the local Ollama endpoint. |
| `langchain.lmChatAzureOpenAi` | `azure_openai_chat_model` | The endpoint lives in the credential and must be set after import. |
| `langchain.lmChatOpenRouter` | `openai_compatible_chat_model` | OpenAI-compatible endpoint with the provider's public base URL. |
| `langchain.lmChatGroq` | `openai_compatible_chat_model` | OpenAI-compatible endpoint with the provider's public base URL. |
| `langchain.lmChatMistralCloud` | `openai_compatible_chat_model` | OpenAI-compatible endpoint with the provider's public base URL. |
| `langchain.lmChatDeepSeek` | `openai_compatible_chat_model` | OpenAI-compatible endpoint with the provider's public base URL. |
| `langchain.lmChatXAiGrok` | `openai_compatible_chat_model` | OpenAI-compatible endpoint with the provider's public base URL. |
| `langchain.agent` | `agent_orchestrator` | Model, memory and tool sub-nodes become attachment edges; an attached output parser becomes the next step. |
| `langchain.memoryBufferWindow` | `local_memory` | Direct mapping. |
| `langchain.memoryPostgresChat` | `local_memory` | External memory stores are approximated with the local Simple Memory store. |
| `langchain.memoryRedisChat` | `local_memory` | External memory stores are approximated with the local Simple Memory store. |
| `langchain.memoryMongoDbChat` | `local_memory` | External memory stores are approximated with the local Simple Memory store. |
| `langchain.memoryZep` | `local_memory` | External memory stores are approximated with the local Simple Memory store. |
| `langchain.memoryMotorhead` | `local_memory` | External memory stores are approximated with the local Simple Memory store. |
| `langchain.memoryXata` | `local_memory` | External memory stores are approximated with the local Simple Memory store. |
| `langchain.mcpClientTool` | `mcp_tool` | SSE transport becomes HTTP streamable; tool exclusion lists are not supported. |
| `langchain.outputParserStructured` | `output_parser` | Runs as a step after the agent; schemas are inferred from example output when no manual schema is given. |
| `langchain.lmChat*` | `openai_compatible_chat_model` | Any other chat model type is approximated as an OpenAI-compatible endpoint with a placeholder base URL. |

### App nodes

| Source node type | L2M node | Notes |
|---|---|---|
| `slack` | `slack_send_message` | Message posting maps to a bot-token send; attachments and most message options are dropped; other resources and operations become placeholders. |
| `slackTrigger` | `slack_trigger` | Event and channel filters are not supported; the signing secret becomes a placeholder. |
| `telegram` | `telegram_send_message` | Text messages map directly; keyboards and most options are dropped; other resources and operations become placeholders. |
| `telegramTrigger` | `telegram_trigger` | Update filters are not supported; the webhook secret token becomes a placeholder. |
| `discord` | `discord_send_message` | Webhook sends map with content, username and embeds; bot-token sends and other operations become placeholders. |
| `discordTrigger` | `discord_trigger` | Event filters are not supported; the application public key must be set after import. |
| `github` | `github_action` | Issue create/comment/close, file get/create/edit and repository issue listing map to github_action operations; labels, assignees and filters are dropped; other operations become placeholders. |
| `githubTrigger` | `github_webhook_trigger` | Event filters are not supported; the webhook must be created on the repository by hand. |
| `jira` | `jira_create_issue` | Issue creation and JQL search map; the site URL and email live in the credential; other operations become placeholders. |
| `notion` | `notion_create_page` | Database page creation and querying map; simple property types are translated, manual filters and content blocks are dropped; other operations become placeholders. |
| `googleSheets` | `google_sheets_read` | Read, append, append-or-update and update map to the Sheets nodes; row filters and header matching are dropped; sheets picked by gid need the range set; other operations become placeholders. |
| `googleSheetsTrigger` | `google_sheets_trigger` | Polls the sheet for new rows; row-update events are approximated. |
| `postgres` | `postgres_query` | Execute-query and select map to a query; the connection details live in the credential; insert, update, upsert and delete become placeholders. |
| `postgresTrigger` | `postgres_trigger` | Table and LISTEN triggers are approximated as a polling query. |
| `airtable` | `airtable_list_records` | Search, create and update map to the Airtable nodes; auto-mapped fields are dropped; get, upsert and delete become placeholders. |
| `awsS3` | `aws_s3_get_object` | File download, upload and listing map to the S3 nodes; the region lives in the credential; binary uploads need the body set; bucket and folder operations become placeholders. |
| `hubspot` | `hubspot_create_contact` | Contact create-or-update becomes a create and contact get maps directly; other resources and operations become placeholders. |
| `salesforce` | `salesforce_create_record` | Record creation and SOQL search map; list operations become SOQL; the instance URL lives in the credential; other operations become placeholders. |
| `stripe` | `stripe_create_customer` | Customer and charge creation map with metadata; addresses, shipping and payment sources are dropped; other resources and operations become placeholders. |
| `stripeTrigger` | `stripe_webhook_trigger` | Event filters are not supported; the signing secret becomes a placeholder. |

Any other source node type is imported as a disabled `noop_node` placeholder that keeps the original parameters, so the workflow still loads and validates.
