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

Any other source node type is imported as a disabled `noop_node` placeholder that keeps the original parameters, so the workflow still loads and validates.
