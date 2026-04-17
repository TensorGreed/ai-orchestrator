import type { NodeDefinition } from "./types";

export const nodeDefinitions: NodeDefinition[] = [
  {
    type: "schedule_trigger",
    label: "Schedule Trigger",
    category: "Input",
    description: "Triggers workflow execution automatically from a cron schedule.",
    configSchema: {
      type: "object",
      properties: {
        cronExpression: { type: "string" },
        timezone: { type: "string" },
        active: { type: "boolean" }
      },
      required: ["cronExpression", "timezone", "active"]
    },
    sampleConfig: {
      cronExpression: "0 9 * * *",
      timezone: "America/Toronto",
      active: true
    }
  },
  {
    type: "webhook_input",
    label: "Webhook Input",
    category: "Input",
    description: "Injects webhook payload into workflow context.",
    configSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        method: { type: "string", enum: ["POST", "GET", "PUT", "PATCH", "DELETE"] },
        passThroughFields: { type: "array", items: { type: "string" } },
        authMode: { type: "string", enum: ["none", "bearer_token", "hmac_sha256"] },
        authHeaderName: { type: "string" },
        signatureHeaderName: { type: "string" },
        timestampHeaderName: { type: "string" },
        secretRef: { type: "object" },
        replayToleranceSeconds: { type: "number" },
        idempotencyEnabled: { type: "boolean" },
        idempotencyHeaderName: { type: "string" },
        responseMode: { type: "string", enum: ["onReceived", "lastNode", "responseNode"] },
        responseCode: { type: "number" },
        responseHeaders: { type: "object" },
        responseBody: { type: "string" }
      }
    },
    sampleConfig: {
      path: "agent-demo",
      method: "POST",
      passThroughFields: ["system_prompt", "user_prompt", "session_id", "variables"],
      authMode: "none",
      authHeaderName: "authorization",
      signatureHeaderName: "x-webhook-signature",
      timestampHeaderName: "x-webhook-timestamp",
      replayToleranceSeconds: 300,
      idempotencyEnabled: false,
      idempotencyHeaderName: "idempotency-key",
      responseMode: "lastNode",
      responseCode: 200
    }
  },
  {
    type: "text_input",
    label: "Text Input",
    category: "Input",
    description: "Provides static input text for a workflow run.",
    configSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    sampleConfig: { text: "What is the latest release?" }
  },
  {
    type: "system_prompt",
    label: "System Prompt",
    category: "Input",
    description: "Static system prompt node.",
    configSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    sampleConfig: { text: "You are an assistant that answers with concise factual output." }
  },
  {
    type: "user_prompt",
    label: "User Prompt",
    category: "Input",
    description: "Static user prompt node.",
    configSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    sampleConfig: { text: "Summarize this context." }
  },
  {
    type: "loop_node",
    label: "Loop / ForEach",
    category: "Utility",
    description: "Iterates over an input array and executes direct downstream nodes once per item.",
    configSchema: {
      type: "object",
      properties: {
        inputKey: { type: "string" },
        itemVariable: { type: "string" },
        maxIterations: { type: "number" }
      },
      required: ["inputKey", "itemVariable"]
    },
    sampleConfig: {
      inputKey: "documents",
      itemVariable: "item",
      maxIterations: 100
    }
  },
  {
    type: "http_request",
    label: "HTTP Request",
    category: "Connector",
    description: "Performs a configurable HTTP request with templated URL, headers, and body.",
    configSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        urlTemplate: { type: "string" },
        headersTemplate: { type: "string" },
        bodyTemplate: { type: "string" },
        responseType: { type: "string", enum: ["json", "text"] },
        secretRef: { type: "object" },
        timeoutMs: { type: "number" }
      },
      required: ["method", "urlTemplate"]
    },
    sampleConfig: {
      method: "GET",
      urlTemplate: "https://api.example.com/v1/users/{{user_id}}",
      headersTemplate: "{\n  \"Accept\": \"application/json\"\n}",
      bodyTemplate: "{}",
      responseType: "json",
      timeoutMs: 15000
    }
  },
  {
    type: "merge_node",
    label: "Merge / Join",
    category: "Utility",
    description: "Merges outputs from multiple parent branches after fan-in.",
    configSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["append", "combine_by_key", "choose_branch"] },
        combineKey: { type: "string" }
      },
      required: ["mode"]
    },
    sampleConfig: {
      mode: "append",
      combineKey: "id"
    }
  },
  {
    type: "execute_workflow",
    label: "Execute Workflow",
    category: "Utility",
    description: "Executes another workflow as a reusable sub-workflow.",
    configSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string" },
        inputMapping: {
          type: "object",
          additionalProperties: { type: "string" }
        },
        mode: { type: "string", enum: ["sync", "async"] },
        outputMapping: {
          type: "object",
          additionalProperties: { type: "string" }
        }
      },
      required: ["workflowId"]
    },
    sampleConfig: {
      workflowId: "",
      inputMapping: {
        user_prompt: "user_prompt",
        session_id: "session_id"
      },
      mode: "sync",
      outputMapping: {}
    }
  },
  {
    type: "wait_node",
    label: "Wait / Delay",
    category: "Utility",
    description: "Pauses execution for a bounded amount of time before continuing.",
    configSchema: {
      type: "object",
      properties: {
        delayMs: { type: "number" },
        maxDelayMs: { type: "number" },
        resumeMode: { type: "string", enum: ["timer", "webhook", "datetime"] },
        resumeWebhookPath: { type: "string" },
        resumeAt: { type: "string", description: "ISO 8601 datetime string for datetime resume mode" }
      }
    },
    sampleConfig: {
      delayMs: 1000,
      maxDelayMs: 30000,
      resumeMode: "timer"
    }
  },
  {
    type: "set_node",
    label: "Set / Transform",
    category: "Utility",
    description: "Builds a structured output object from key/template assignments.",
    configSchema: {
      type: "object",
      properties: {
        assignments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              valueTemplate: { type: "string" }
            },
            required: ["key", "valueTemplate"]
          }
        }
      }
    },
    sampleConfig: {
      assignments: [
        { key: "customerId", valueTemplate: "{{webhook.customer.id}}" },
        { key: "status", valueTemplate: "active" },
        { key: "metadata", valueTemplate: "{\"source\":\"workflow\",\"index\":{{_loop_index}}}" }
      ]
    }
  },
  {
    type: "code_node",
    label: "Code Node",
    category: "Utility",
    description: "Runs custom JavaScript transformation logic in a sandboxed VM context.",
    configSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        timeout: { type: "number" }
      },
      required: ["code"]
    },
    sampleConfig: {
      timeout: 1500,
      code: "const name = String(input.user_prompt ?? 'World');\nconst upper = name.toUpperCase();\nconsole.log('Transformed prompt to uppercase');\nreturn { transformed: upper, length: upper.length };"
    }
  },
  {
    type: "prompt_template",
    label: "Prompt Template",
    category: "Utility",
    description: "Builds a prompt using handlebars-style placeholders.",
    configSchema: {
      type: "object",
      properties: { template: { type: "string" }, outputKey: { type: "string" } },
      required: ["template"]
    },
    sampleConfig: { template: "Context: {{context}}\n\nQuestion: {{user_prompt}}", outputKey: "prompt" }
  },
  {
    type: "llm_call",
    label: "LLM Call",
    category: "LLM",
    description: "Executes a model completion call.",
    configSchema: {
      type: "object",
      properties: {
        provider: { type: "object" },
        promptKey: { type: "string" },
        systemPromptKey: { type: "string" }
      },
      required: ["provider"]
    },
    sampleConfig: {
      provider: { providerId: "ollama", model: "llama3.1", baseUrl: "http://localhost:11434/v1" },
      promptKey: "prompt",
      systemPromptKey: "system_prompt"
    }
  },
  {
    type: "azure_openai_chat_model",
    label: "Azure OpenAI Chat Model",
    category: "LLM",
    description: "Calls Azure OpenAI chat/completions using deployment + API version.",
    configSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string" },
        deployment: { type: "string" },
        apiVersion: { type: "string" },
        secretRef: { type: "object" },
        temperature: { type: "number" },
        maxTokens: { type: "number" },
        promptKey: { type: "string" },
        systemPromptKey: { type: "string" }
      },
      required: ["endpoint", "deployment", "secretRef"]
    },
    sampleConfig: {
      endpoint: "https://my-azure-openai.openai.azure.com",
      deployment: "gpt-4o-mini",
      apiVersion: "2024-10-21",
      temperature: 0.2,
      maxTokens: 1024,
      promptKey: "prompt",
      systemPromptKey: "system_prompt"
    }
  },
  {
    type: "google_gemini_chat_model",
    label: "Google Gemini Chat Model",
    category: "LLM",
    description: "Calls Google Gemini chat completions using an API key.",
    configSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        secretRef: { type: "object" },
        temperature: { type: "number" },
        maxTokens: { type: "number" },
        promptKey: { type: "string" },
        systemPromptKey: { type: "string" }
      },
      required: ["model"]
    },
    sampleConfig: {
      model: "gemini-2.0-flash",
      temperature: 0.2,
      maxTokens: 1024,
      promptKey: "prompt",
      systemPromptKey: "system_prompt"
    }
  },
  {
    type: "embeddings_azure_openai",
    label: "Embeddings Azure OpenAI",
    category: "RAG",
    description: "Generates embedding vectors using Azure OpenAI embedding deployments.",
    configSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string" },
        deployment: { type: "string" },
        apiVersion: { type: "string" },
        secretRef: { type: "object" },
        inputKey: { type: "string" },
        outputKey: { type: "string" }
      },
      required: ["endpoint", "deployment", "secretRef"]
    },
    sampleConfig: {
      endpoint: "https://my-azure-openai.openai.azure.com",
      deployment: "text-embedding-3-large",
      apiVersion: "2024-10-21",
      inputKey: "user_prompt",
      outputKey: "embedding"
    }
  },
  {
    type: "agent_orchestrator",
    label: "Agent Orchestrator",
    category: "Agent",
    description: "Runs iterative tool-aware agent loop.",
    configSchema: {
      type: "object",
      properties: {
        systemPromptTemplate: { type: "string" },
        userPromptTemplate: { type: "string" },
        sessionIdTemplate: { type: "string" },
        maxIterations: { type: "number" },
        toolCallingEnabled: { type: "boolean" },
        toolMessageMaxChars: { type: "number" },
        toolPayloadMaxDepth: { type: "number" },
        toolPayloadMaxObjectKeys: { type: "number" },
        toolPayloadMaxArrayItems: { type: "number" },
        toolPayloadMaxStringChars: { type: "number" }
      },
      required: ["maxIterations"]
    },
    sampleConfig: {
      systemPromptTemplate: "{{system_prompt}}",
      userPromptTemplate: "{{user_prompt}}",
      sessionIdTemplate: "{{session_id}}",
      maxIterations: 6,
      toolCallingEnabled: true,
      toolMessageMaxChars: 6000,
      toolPayloadMaxDepth: 4,
      toolPayloadMaxObjectKeys: 32,
      toolPayloadMaxArrayItems: 8,
      toolPayloadMaxStringChars: 400
    }
  },
  {
    type: "supervisor_node",
    label: "Supervisor Node",
    category: "Agent",
    description: "Swarm Supervisor that coordinates attached Worker nodes.",
    configSchema: {
      type: "object",
      properties: {
        systemPromptTemplate: { type: "string" },
        userPromptTemplate: { type: "string" },
        sessionIdTemplate: { type: "string" },
        maxIterations: { type: "number" },
        toolMessageMaxChars: { type: "number" },
        toolPayloadMaxDepth: { type: "number" },
        toolPayloadMaxObjectKeys: { type: "number" },
        toolPayloadMaxArrayItems: { type: "number" },
        toolPayloadMaxStringChars: { type: "number" }
      },
      required: ["maxIterations"]
    },
    sampleConfig: {
      systemPromptTemplate: "{{system_prompt}}",
      userPromptTemplate: "{{user_prompt}}",
      sessionIdTemplate: "{{session_id}}",
      maxIterations: 10,
      toolMessageMaxChars: 6000,
      toolPayloadMaxDepth: 4,
      toolPayloadMaxObjectKeys: 32,
      toolPayloadMaxArrayItems: 8,
      toolPayloadMaxStringChars: 400
    }
  },
  {
    type: "local_memory",
    label: "Simple Memory",
    category: "Utility",
    description: "SQLite-backed session memory that can be attached to an Agent Orchestrator node.",
    configSchema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        sessionIdTemplate: { type: "string" },
        maxMessages: { type: "number" },
        persistToolMessages: { type: "boolean" }
      }
    },
    sampleConfig: {
      namespace: "default",
      sessionIdTemplate: "{{session_id}}",
      maxMessages: 20,
      persistToolMessages: false
    }
  },
  {
    type: "mcp_tool",
    label: "MCP Tool",
    category: "MCP",
    description: "Directly invokes an MCP tool outside the agent loop.",
    configSchema: {
      type: "object",
      properties: {
        serverId: { type: "string" },
        toolName: { type: "string" },
        argsTemplate: { type: "string" },
        connection: {
          type: "object",
          properties: {
            endpoint: { type: "string" },
            transport: { type: "string" },
            timeoutMs: { type: "number" },
            authType: { type: "string" },
            username: { type: "string" }
          }
        }
      },
      required: ["serverId", "toolName"]
    },
    sampleConfig: {
      serverId: "mock-mcp",
      toolName: "get_current_time",
      argsTemplate: "{\"tz\":\"UTC\"}",
      connection: {
        endpoint: "http://127.0.0.1:7001/mcp",
        transport: "http_streamable",
        timeoutMs: 120000,
        authType: "none"
      }
    }
  },
  {
    type: "rag_retrieve",
    label: "RAG Retrieve",
    category: "RAG",
    description: "Retrieves context chunks from provided documents or vector store.",
    configSchema: {
      type: "object",
      properties: {
        queryTemplate: { type: "string" },
        topK: { type: "number" },
        documents: { type: "array", items: { type: "string" } },
        embedderId: { type: "string" },
        vectorStoreId: { type: "string" },
        vectorStoreConfig: { type: "object" },
        embeddingSecretRef: { type: "object" }
      }
    },
    sampleConfig: { queryTemplate: "{{user_prompt}}", topK: 3, embedderId: "token-embedder", vectorStoreId: "in-memory-vector-store" }
  },
  {
    type: "document_chunker",
    label: "Document Chunker",
    category: "RAG",
    description: "Splits documents into smaller chunks for embeddings.",
    configSchema: {
      type: "object",
      properties: {
        chunkSize: { type: "number" },
        chunkOverlap: { type: "number" },
        separator: { type: "string" }
      }
    },
    sampleConfig: { chunkSize: 500, chunkOverlap: 50, separator: "\\n\\n" }
  },
  {
    type: "connector_source",
    label: "Connector Source",
    category: "Connector",
    description: "Fetches documents from a connector adapter.",
    configSchema: {
      type: "object",
      properties: {
        connectorId: { type: "string" },
        connectorConfig: { type: "object" },
        authSecretRef: { type: "object" }
      },
      required: ["connectorId"]
    },
    sampleConfig: {
      connectorId: "google-drive",
      connectorConfig: { folderId: "sample-folder", includeNative: true }
    }
  },
  {
    type: "google_drive_source",
    label: "Google Drive Source",
    category: "Connector",
    description: "Fetches Google Drive files as documents for RAG retrieval.",
    configSchema: {
      type: "object",
      properties: {
        folderId: { type: "string" },
        fileIds: { type: "array", items: { type: "string" } },
        query: { type: "string" },
        maxFiles: { type: "number" },
        includeSharedDrives: { type: "boolean" },
        includeNativeGoogleDocs: { type: "boolean" },
        useDemoFallback: { type: "boolean" },
        secretRef: { type: "object" }
      }
    },
    sampleConfig: {
      folderId: "",
      fileIds: [],
      query: "",
      maxFiles: 10,
      includeSharedDrives: true,
      includeNativeGoogleDocs: true,
      useDemoFallback: true
    }
  },
  {
    type: "azure_storage",
    label: "Azure Storage",
    category: "Connector",
    description: "Reads/writes Azure Blob Storage containers and blobs.",
    configSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list_containers", "list_blobs", "get_blob_text", "put_blob_text", "delete_blob"]
        },
        accountName: { type: "string" },
        endpoint: { type: "string" },
        containerName: { type: "string" },
        blobName: { type: "string" },
        blobContentTemplate: { type: "string" },
        prefix: { type: "string" },
        maxResults: { type: "number" },
        secretRef: { type: "object" },
        useDemoFallback: { type: "boolean" }
      },
      required: ["operation"]
    },
    sampleConfig: {
      operation: "list_blobs",
      accountName: "",
      endpoint: "",
      containerName: "",
      prefix: "",
      maxResults: 50,
      useDemoFallback: true
    }
  },
  {
    type: "azure_cosmos_db",
    label: "Azure Cosmos DB",
    category: "Connector",
    description: "Queries and mutates documents in Azure Cosmos DB containers.",
    configSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["query_items", "read_item", "create_item", "upsert_item", "delete_item"]
        },
        endpoint: { type: "string" },
        databaseId: { type: "string" },
        containerId: { type: "string" },
        queryText: { type: "string" },
        itemId: { type: "string" },
        partitionKey: { type: "string" },
        itemJson: { type: "string" },
        maxItems: { type: "number" },
        secretRef: { type: "object" },
        useDemoFallback: { type: "boolean" }
      },
      required: ["operation"]
    },
    sampleConfig: {
      operation: "query_items",
      endpoint: "https://example.documents.azure.com:443/",
      databaseId: "",
      containerId: "",
      queryText: "SELECT TOP 10 * FROM c",
      maxItems: 25,
      useDemoFallback: true
    }
  },
  {
    type: "azure_monitor_http",
    label: "Microsoft Azure Monitor",
    category: "Connector",
    description: "Queries Azure Monitor logs/metrics or executes authenticated monitor API requests.",
    configSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["query_logs", "query_metrics", "custom_request"] },
        workspaceId: { type: "string" },
        resourceId: { type: "string" },
        queryText: { type: "string" },
        timespan: { type: "string" },
        metricNames: { type: "string" },
        method: { type: "string" },
        path: { type: "string" },
        bodyTemplate: { type: "string" },
        maxRows: { type: "number" },
        secretRef: { type: "object" },
        useDemoFallback: { type: "boolean" }
      },
      required: ["operation"]
    },
    sampleConfig: {
      operation: "query_logs",
      workspaceId: "",
      queryText: "Heartbeat | take 5",
      maxRows: 50,
      useDemoFallback: true
    }
  },
  {
    type: "azure_ai_search_vector_store",
    label: "Azure AI Search Vector Store",
    category: "Connector",
    description: "Runs vector and document operations against Azure AI Search indexes.",
    configSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["vector_search", "upsert_documents", "delete_documents"] },
        endpoint: { type: "string" },
        indexName: { type: "string" },
        apiVersion: { type: "string" },
        vectorField: { type: "string" },
        contentField: { type: "string" },
        idField: { type: "string" },
        metadataField: { type: "string" },
        queryText: { type: "string" },
        queryVectorJson: { type: "string" },
        topK: { type: "number" },
        documentsJson: { type: "string" },
        secretRef: { type: "object" },
        useDemoFallback: { type: "boolean" }
      },
      required: ["operation"]
    },
    sampleConfig: {
      operation: "vector_search",
      endpoint: "https://my-search.search.windows.net",
      indexName: "documents",
      apiVersion: "2024-07-01",
      vectorField: "embedding",
      contentField: "content",
      idField: "id",
      metadataField: "metadata",
      queryText: "{{user_prompt}}",
      topK: 5,
      useDemoFallback: true
    }
  },
  {
    type: "qdrant_vector_store",
    label: "Qdrant Vector Store",
    category: "Connector",
    description: "Runs vector retrieval and document upsert operations against a Qdrant collection.",
    configSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "get_ranked_documents",
            "add_documents",
            "retrieve_for_chain_tool",
            "retrieve_for_ai_agent_tool"
          ]
        },
        endpoint: { type: "string" },
        collectionName: { type: "string" },
        apiKeyHeaderName: { type: "string" },
        queryText: { type: "string" },
        queryVectorJson: { type: "string" },
        filterJson: { type: "string" },
        documentsJson: { type: "string" },
        topK: { type: "number" },
        contentField: { type: "string" },
        metadataField: { type: "string" },
        secretRef: { type: "object" },
        useDemoFallback: { type: "boolean" }
      },
      required: ["operation"]
    },
    sampleConfig: {
      operation: "get_ranked_documents",
      endpoint: "http://localhost:6333",
      collectionName: "documents",
      apiKeyHeaderName: "api-key",
      queryText: "{{user_prompt}}",
      topK: 5,
      contentField: "content",
      metadataField: "metadata",
      useDemoFallback: true
    }
  },
  {
    type: "output_parser",
    label: "Output Parser",
    category: "Utility",
    description:
      "Validates and transforms LLM output into structured data using JSON Schema, item list parsing, or auto-fix retry.",
    configSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["json_schema", "item_list", "auto_fix"] },
        parsingMode: { type: "string", enum: ["strict", "lenient", "anything_goes"] },
        jsonSchema: { type: "string" },
        itemSeparator: { type: "string" },
        maxRetries: { type: "number" },
        inputKey: { type: "string" }
      },
      required: ["mode"]
    },
    sampleConfig: {
      mode: "json_schema",
      parsingMode: "strict",
      jsonSchema: "{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"},\"sentiment\":{\"type\":\"string\",\"enum\":[\"positive\",\"negative\",\"neutral\"]}},\"required\":[\"name\",\"sentiment\"]}",
      maxRetries: 2,
      inputKey: "answer"
    }
  },
  {
    type: "human_approval",
    label: "Human Approval",
    category: "Utility",
    description: "Pauses execution and waits for a human approve/reject action before resuming.",
    configSchema: {
      type: "object",
      properties: {
        approvalMessage: { type: "string" },
        timeoutMinutes: { type: "number" }
      },
      required: ["approvalMessage", "timeoutMinutes"]
    },
    sampleConfig: {
      approvalMessage: "Approve before sending this response to the customer?",
      timeoutMinutes: 60
    }
  },
  {
    type: "input_validator",
    label: "Input Validator",
    category: "Utility",
    description: "Validates input fields against deterministic rules before downstream execution.",
    configSchema: {
      type: "object",
      properties: {
        rules: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              check: { type: "string", enum: ["required", "max_length", "regex"] },
              value: { type: "string" }
            },
            required: ["field", "check"]
          }
        },
        onFail: { type: "string", enum: ["error", "branch"] }
      },
      required: ["rules", "onFail"]
    },
    sampleConfig: {
      rules: [
        { field: "email", check: "required", value: "" },
        { field: "message", check: "max_length", value: "1200" }
      ],
      onFail: "branch"
    }
  },
  {
    type: "output_guardrail",
    label: "Output Guardrail",
    category: "Utility",
    description: "Validates and optionally retries model output when guardrail checks fail.",
    configSchema: {
      type: "object",
      properties: {
        checks: {
          type: "array",
          items: {
            type: "string",
            enum: ["no_pii", "no_profanity", "must_contain_json"]
          }
        },
        onFail: { type: "string", enum: ["retry", "error"] },
        inputKey: { type: "string" }
      },
      required: ["checks", "onFail"]
    },
    sampleConfig: {
      checks: ["no_pii", "must_contain_json"],
      onFail: "retry",
      inputKey: "answer"
    }
  },
  {
    type: "if_node",
    label: "IF",
    category: "Utility",
    description: "Evaluates a condition and routes execution to the true or false branch.",
    configSchema: {
      type: "object",
      properties: {
        condition: { type: "string" },
        trueLabel: { type: "string" },
        falseLabel: { type: "string" }
      },
      required: ["condition"]
    },
    sampleConfig: {
      condition: "{{answer}}",
      trueLabel: "True",
      falseLabel: "False"
    }
  },
  {
    type: "switch_node",
    label: "Switch",
    category: "Utility",
    description: "Routes execution to one of several branches based on a matched value.",
    configSchema: {
      type: "object",
      properties: {
        switchValue: { type: "string" },
        cases: { type: "array", items: { type: "object", properties: { value: { type: "string" }, label: { type: "string" } } } },
        defaultLabel: { type: "string" }
      },
      required: ["switchValue", "cases"]
    },
    sampleConfig: {
      switchValue: "{{sentiment}}",
      cases: [
        { value: "positive", label: "positive" },
        { value: "negative", label: "negative" }
      ],
      defaultLabel: "default"
    }
  },
  {
    type: "try_catch",
    label: "Try / Catch",
    category: "Utility",
    description: "Wraps downstream execution in a try/catch block. Routes to an error branch on failure.",
    configSchema: {
      type: "object",
      properties: {}
    },
    sampleConfig: {}
  },
  {
    type: "pdf_output",
    label: "PDF Output",
    category: "Output",
    description: "Generates a downloadable PDF link from upstream content (plain text or HTML rendering).",
    configSchema: {
      type: "object",
      properties: {
        renderMode: { type: "string", enum: ["text", "html"] },
        inputKey: { type: "string" },
        textTemplate: { type: "string" },
        htmlTemplate: { type: "string" },
        pageFormat: { type: "string", enum: ["A4", "Letter", "Legal", "A3", "A5"] },
        printBackground: { type: "boolean" },
        htmlRenderTimeoutMs: { type: "number" },
        filenameTemplate: { type: "string" },
        outputKey: { type: "string" }
      }
    },
    sampleConfig: {
      renderMode: "text",
      inputKey: "answer",
      textTemplate: "",
      htmlTemplate: "<html><body><h1>{{title}}</h1><div>{{answer}}</div></body></html>",
      pageFormat: "A4",
      printBackground: true,
      htmlRenderTimeoutMs: 45000,
      filenameTemplate: "workflow-output-{{session_id}}.pdf",
      outputKey: "pdf"
    }
  },
  {
    type: "output",
    label: "Output",
    category: "Output",
    description: "Formats final workflow output payload.",
    configSchema: {
      type: "object",
      properties: { responseTemplate: { type: "string" }, outputKey: { type: "string" } }
    },
    sampleConfig: { responseTemplate: "{{answer}}", outputKey: "result" }
  },
  {
    type: "sub_workflow_trigger",
    label: "Sub-Workflow Trigger",
    category: "Input",
    description: "Entry point for workflows invoked as sub-workflows via Execute Workflow node.",
    configSchema: {
      type: "object",
      properties: {
        description: { type: "string" },
        inputSchema: { type: "object" }
      }
    },
    sampleConfig: {
      description: "Sub-workflow entry point"
    }
  },
  {
    type: "error_trigger",
    label: "Error Trigger",
    category: "Input",
    description: "Fires when a designated production workflow fails. Configure target workflows in their Error Workflow setting.",
    configSchema: {
      type: "object",
      properties: {}
    },
    sampleConfig: {}
  },
  {
    type: "filter_node",
    label: "Filter",
    category: "Utility",
    description: "Evaluates conditions against context data and routes to pass or filtered branches.",
    configSchema: {
      type: "object",
      properties: {
        conditions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              operator: {
                type: "string",
                enum: [
                  "eq", "neq", "gt", "gte", "lt", "lte",
                  "contains", "not_contains", "starts_with", "ends_with",
                  "is_empty", "is_not_empty", "regex"
                ]
              },
              value: { type: "string" }
            },
            required: ["field", "operator"]
          }
        },
        combineWith: { type: "string", enum: ["AND", "OR"] },
        passMode: { type: "string", enum: ["pass", "reject"] }
      }
    },
    sampleConfig: {
      conditions: [{ field: "status", operator: "eq", value: "active" }],
      combineWith: "AND",
      passMode: "pass"
    }
  },
  {
    type: "stop_and_error",
    label: "Stop and Error",
    category: "Utility",
    description: "Immediately stops the workflow with a custom error message and code.",
    configSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        errorCode: { type: "string" }
      }
    },
    sampleConfig: {
      message: "Validation failed: {{error_message}}",
      errorCode: "VALIDATION_ERROR"
    }
  },
  {
    type: "noop_node",
    label: "No Operation",
    category: "Utility",
    description: "Pass-through node that performs no operation. Useful as a placeholder or visual marker.",
    configSchema: {
      type: "object",
      properties: {
        label: { type: "string" }
      }
    },
    sampleConfig: {
      label: "Placeholder"
    }
  },
  // ---------------------------------------------------------------------------
  // Phase 2 — Data Transformation Nodes
  // ---------------------------------------------------------------------------
  {
    type: "aggregate_node",
    label: "Aggregate",
    category: "Utility",
    description: "Groups items and aggregates a numeric/text field (sum, avg, min, max, count, concatenate).",
    configSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["sum", "avg", "min", "max", "count", "concatenate"] },
        field: { type: "string" },
        groupBy: { type: "string" },
        inputKey: { type: "string" },
        separator: { type: "string" }
      },
      required: ["operation"]
    },
    sampleConfig: { operation: "sum", field: "amount", inputKey: "items" }
  },
  {
    type: "split_out_node",
    label: "Split Out",
    category: "Utility",
    description: "Splits an array field into multiple items.",
    configSchema: {
      type: "object",
      properties: {
        field: { type: "string" },
        destinationField: { type: "string" },
        inputKey: { type: "string" }
      },
      required: ["field"]
    },
    sampleConfig: { field: "items", destinationField: "item" }
  },
  {
    type: "sort_node",
    label: "Sort",
    category: "Utility",
    description: "Sorts items ascending, descending, randomly, or by custom expression.",
    configSchema: {
      type: "object",
      properties: {
        field: { type: "string" },
        order: { type: "string", enum: ["asc", "desc", "random"] },
        expression: { type: "string" },
        inputKey: { type: "string" }
      }
    },
    sampleConfig: { field: "name", order: "asc", inputKey: "items" }
  },
  {
    type: "limit_node",
    label: "Limit",
    category: "Utility",
    description: "Caps an array of items to N entries from the start or end.",
    configSchema: {
      type: "object",
      properties: {
        maxItems: { type: "number" },
        keep: { type: "string", enum: ["first", "last"] },
        inputKey: { type: "string" }
      },
      required: ["maxItems"]
    },
    sampleConfig: { maxItems: 10, keep: "first", inputKey: "items" }
  },
  {
    type: "remove_duplicates_node",
    label: "Remove Duplicates",
    category: "Utility",
    description: "Removes duplicate items by all or specified fields.",
    configSchema: {
      type: "object",
      properties: {
        fields: { type: "array", items: { type: "string" } },
        inputKey: { type: "string" }
      }
    },
    sampleConfig: { fields: ["id"], inputKey: "items" }
  },
  {
    type: "summarize_node",
    label: "Summarize",
    category: "Utility",
    description: "Multi-field aggregate (pivot-like). Supports group-by and multiple aggregations per group.",
    configSchema: {
      type: "object",
      properties: {
        fieldsToSummarize: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              aggregation: { type: "string", enum: ["sum", "avg", "min", "max", "count", "concatenate"] }
            },
            required: ["field", "aggregation"]
          }
        },
        fieldsToGroupBy: { type: "array", items: { type: "string" } },
        inputKey: { type: "string" }
      },
      required: ["fieldsToSummarize"]
    },
    sampleConfig: {
      fieldsToSummarize: [{ field: "amount", aggregation: "sum" }],
      fieldsToGroupBy: ["region"],
      inputKey: "items"
    }
  },
  {
    type: "compare_datasets_node",
    label: "Compare Datasets",
    category: "Utility",
    description: "Diffs two datasets by a key field and reports added/removed/changed/same items.",
    configSchema: {
      type: "object",
      properties: {
        inputA: { type: "string" },
        inputB: { type: "string" },
        keyField: { type: "string" }
      },
      required: ["inputA", "inputB", "keyField"]
    },
    sampleConfig: { inputA: "datasetA", inputB: "datasetB", keyField: "id" }
  },
  {
    type: "rename_keys_node",
    label: "Rename Keys",
    category: "Utility",
    description: "Renames keys on items in an array (or single object).",
    configSchema: {
      type: "object",
      properties: {
        renames: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" }
            },
            required: ["from", "to"]
          }
        },
        inputKey: { type: "string" }
      },
      required: ["renames"]
    },
    sampleConfig: { renames: [{ from: "old", to: "new" }], inputKey: "items" }
  },
  {
    type: "edit_fields_node",
    label: "Edit Fields",
    category: "Utility",
    description: "Adds, modifies, removes or renames fields on items.",
    configSchema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["set", "remove", "rename"] },
              field: { type: "string" },
              value: {},
              newName: { type: "string" }
            },
            required: ["op", "field"]
          }
        },
        inputKey: { type: "string" }
      },
      required: ["operations"]
    },
    sampleConfig: {
      operations: [
        { op: "set", field: "active", value: true },
        { op: "remove", field: "tmp" }
      ]
    }
  },
  {
    type: "date_time_node",
    label: "Date & Time",
    category: "Utility",
    description: "Format, parse, add/subtract or compare dates using built-in Date and Intl.",
    configSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["format", "parse", "add", "subtract", "compare", "now"] },
        value: { type: "string" },
        format: { type: "string" },
        unit: { type: "string", enum: ["ms", "second", "minute", "hour", "day", "week", "month", "year"] },
        amount: { type: "number" },
        compareTo: { type: "string" },
        timezone: { type: "string" }
      },
      required: ["operation"]
    },
    sampleConfig: { operation: "format", value: "{{now}}", format: "iso" }
  },
  {
    type: "crypto_node",
    label: "Crypto",
    category: "Utility",
    description: "Hash, HMAC, encrypt, decrypt, sign, verify using node:crypto.",
    configSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["hash", "hmac", "encrypt", "decrypt", "sign", "verify", "random"] },
        algorithm: { type: "string" },
        key: { type: "string" },
        iv: { type: "string" },
        data: { type: "string" },
        encoding: { type: "string", enum: ["hex", "base64", "utf8"] },
        signature: { type: "string" },
        bytes: { type: "number" }
      },
      required: ["operation"]
    },
    sampleConfig: { operation: "hash", algorithm: "sha256", data: "hello", encoding: "hex" }
  },
  {
    type: "jwt_node",
    label: "JWT",
    category: "Utility",
    description: "Sign, decode, verify JWTs (HS256/HS384/HS512). HMAC-only, no external library.",
    configSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["sign", "decode", "verify"] },
        secret: { type: "string" },
        payload: { type: "object" },
        token: { type: "string" },
        algorithm: { type: "string", enum: ["HS256", "HS384", "HS512"] },
        expiresInSeconds: { type: "number" }
      },
      required: ["operation"]
    },
    sampleConfig: { operation: "sign", secret: "shh", algorithm: "HS256", payload: { sub: "user1" } }
  },
  {
    type: "xml_node",
    label: "XML",
    category: "Utility",
    description: "Convert XML to JSON or JSON to XML using a built-in lightweight parser.",
    configSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["toJson", "toXml"] },
        data: {}
      },
      required: ["operation"]
    },
    sampleConfig: { operation: "toJson", data: "<root><item>1</item></root>" }
  },
  {
    type: "html_node",
    label: "HTML",
    category: "Utility",
    description: "Extract data from HTML via simple CSS-like selectors, or generate HTML.",
    configSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["extract", "generate"] },
        html: { type: "string" },
        selectors: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              selector: { type: "string" },
              attribute: { type: "string" },
              all: { type: "boolean" }
            },
            required: ["key", "selector"]
          }
        },
        template: { type: "string" }
      },
      required: ["operation"]
    },
    sampleConfig: {
      operation: "extract",
      html: "<div class='title'>Hi</div>",
      selectors: [{ key: "title", selector: ".title" }]
    }
  },
  {
    type: "convert_to_file_node",
    label: "Convert to File",
    category: "Utility",
    description: "Convert data to CSV, JSON, HTML, or text file output.",
    configSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["csv", "json", "html", "text"] },
        filename: { type: "string" },
        inputKey: { type: "string" },
        data: {}
      },
      required: ["format"]
    },
    sampleConfig: { format: "json", filename: "out.json", inputKey: "items" }
  },
  {
    type: "extract_from_file_node",
    label: "Extract from File",
    category: "Utility",
    description: "Parse CSV, JSON, or XML strings/base64 into structured data.",
    configSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["csv", "json", "xml", "pdf", "excel"] },
        data: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"] },
        inputKey: { type: "string" }
      },
      required: ["format"]
    },
    sampleConfig: { format: "csv", data: "a,b\n1,2", encoding: "utf8" }
  },
  {
    type: "compression_node",
    label: "Compression",
    category: "Utility",
    description: "Gzip / gunzip data using node:zlib. Zip/unzip not yet supported.",
    configSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["gzip", "gunzip", "zip", "unzip"] },
        data: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"] }
      },
      required: ["operation"]
    },
    sampleConfig: { operation: "gzip", data: "hello", encoding: "utf8" }
  },
  {
    type: "edit_image_node",
    label: "Edit Image",
    category: "Utility",
    description: "Image editing (resize/crop/rotate/text/watermark). Requires optional native dependency — currently not implemented in core.",
    configSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["resize", "crop", "rotate", "text", "watermark"] },
        data: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
        rotateDegrees: { type: "number" },
        text: { type: "string" }
      },
      required: ["operation"]
    },
    sampleConfig: { operation: "resize", width: 100, height: 100 }
  },
  {
    type: "webhook_response",
    label: "Webhook Response",
    category: "Output",
    description: "Overrides the outgoing webhook HTTP response (status, headers, and body).",
    configSchema: {
      type: "object",
      properties: {
        statusCode: { type: "number" },
        headersTemplate: { type: "string" },
        bodyTemplate: { type: "string" }
      }
    },
    sampleConfig: {
      statusCode: 200,
      headersTemplate: "{\n  \"content-type\": \"application/json\"\n}",
      bodyTemplate: "{\"ok\":true,\"result\":\"{{result}}\"}"
    }
  },
  {
    type: "slack_send_message",
    label: "Slack: Send Message",
    category: "Connector",
    description: "Post a message to a Slack channel via webhook or bot token.",
    configSchema: {
      type: "object",
      properties: {
        authType: { type: "string", enum: ["webhook", "bot"] },
        webhookUrl: { type: "string" },
        secretRef: { type: "object" },
        channel: { type: "string" },
        text: { type: "string" },
        blocks: { type: "string" },
        threadTs: { type: "string" }
      },
      required: ["authType"]
    },
    sampleConfig: {
      authType: "webhook",
      webhookUrl: "https://hooks.slack.com/services/T000/B000/XXX",
      channel: "#general",
      text: "Hello from ai-orchestrator {{user_prompt}}"
    }
  },
  {
    type: "slack_trigger",
    label: "Slack Trigger",
    category: "Input",
    description: "Webhook-based trigger that validates Slack signing secret. Point Slack Events at /api/webhooks/slack/:workflowId.",
    configSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        signingSecretRef: { type: "object" },
        replayToleranceSeconds: { type: "number" }
      }
    },
    sampleConfig: {
      path: "slack-events",
      replayToleranceSeconds: 300
    }
  },
  {
    type: "smtp_send_email",
    label: "SMTP: Send Email",
    category: "Connector",
    description: "Send email via SMTP (nodemailer).",
    configSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        port: { type: "number" },
        secure: { type: "boolean" },
        user: { type: "string" },
        secretRef: { type: "object" },
        from: { type: "string" },
        to: { type: "string" },
        subject: { type: "string" },
        text: { type: "string" },
        html: { type: "string" }
      },
      required: ["host", "port", "from", "to", "subject"]
    },
    sampleConfig: {
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "no-reply@example.com",
      from: "no-reply@example.com",
      to: "user@example.com",
      subject: "Hello",
      text: "{{user_prompt}}"
    }
  },
  {
    type: "imap_email_trigger",
    label: "IMAP Email Trigger",
    category: "Input",
    description: "Poll an IMAP inbox for new messages (requires imapflow — stubbed if missing).",
    configSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        port: { type: "number" },
        secure: { type: "boolean" },
        user: { type: "string" },
        secretRef: { type: "object" },
        mailbox: { type: "string" },
        pollIntervalSeconds: { type: "number" }
      },
      required: ["host", "port", "user"]
    },
    sampleConfig: {
      host: "imap.example.com",
      port: 993,
      secure: true,
      user: "user@example.com",
      mailbox: "INBOX",
      pollIntervalSeconds: 60
    }
  },
  {
    type: "google_sheets_read",
    label: "Google Sheets: Read",
    category: "Connector",
    description: "Read a range from a Google Sheet (OAuth access token or API key).",
    configSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string" },
        range: { type: "string" },
        authType: { type: "string", enum: ["accessToken", "apiKey"] },
        secretRef: { type: "object" }
      },
      required: ["spreadsheetId", "range", "authType"]
    },
    sampleConfig: {
      spreadsheetId: "1abcDEF",
      range: "Sheet1!A1:D100",
      authType: "accessToken"
    }
  },
  {
    type: "google_sheets_append",
    label: "Google Sheets: Append",
    category: "Connector",
    description: "Append rows to a Google Sheet.",
    configSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string" },
        range: { type: "string" },
        values: {},
        valueInputOption: { type: "string", enum: ["RAW", "USER_ENTERED"] },
        secretRef: { type: "object" }
      },
      required: ["spreadsheetId", "range"]
    },
    sampleConfig: {
      spreadsheetId: "1abcDEF",
      range: "Sheet1!A1",
      values: [["a", "b"]],
      valueInputOption: "USER_ENTERED"
    }
  },
  {
    type: "google_sheets_update",
    label: "Google Sheets: Update",
    category: "Connector",
    description: "Update values in a Google Sheet range.",
    configSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string" },
        range: { type: "string" },
        values: {},
        valueInputOption: { type: "string", enum: ["RAW", "USER_ENTERED"] },
        secretRef: { type: "object" }
      },
      required: ["spreadsheetId", "range"]
    },
    sampleConfig: {
      spreadsheetId: "1abcDEF",
      range: "Sheet1!A1:B1",
      values: [["a", "b"]],
      valueInputOption: "USER_ENTERED"
    }
  },
  {
    type: "google_sheets_trigger",
    label: "Google Sheets Trigger",
    category: "Input",
    description: "Polling trigger that detects new rows since the last run.",
    configSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string" },
        range: { type: "string" },
        authType: { type: "string", enum: ["accessToken", "apiKey"] },
        secretRef: { type: "object" },
        pollIntervalSeconds: { type: "number" }
      },
      required: ["spreadsheetId", "range"]
    },
    sampleConfig: {
      spreadsheetId: "1abcDEF",
      range: "Sheet1!A:Z",
      authType: "accessToken",
      pollIntervalSeconds: 60
    }
  },
  {
    type: "postgres_query",
    label: "PostgreSQL: Query",
    category: "Connector",
    description: "Execute a SQL query against PostgreSQL and return rows.",
    configSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        port: { type: "number" },
        database: { type: "string" },
        user: { type: "string" },
        secretRef: { type: "object" },
        ssl: { type: "boolean" },
        query: { type: "string" },
        params: { type: "array" }
      },
      required: ["host", "database", "user", "query"]
    },
    sampleConfig: {
      host: "localhost",
      port: 5432,
      database: "postgres",
      user: "postgres",
      ssl: false,
      query: "SELECT * FROM users WHERE id = $1",
      params: [1]
    }
  },
  {
    type: "postgres_trigger",
    label: "PostgreSQL Trigger",
    category: "Input",
    description: "Polling trigger: execute a SELECT periodically and emit new rows.",
    configSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        port: { type: "number" },
        database: { type: "string" },
        user: { type: "string" },
        secretRef: { type: "object" },
        ssl: { type: "boolean" },
        query: { type: "string" },
        pollIntervalSeconds: { type: "number" }
      },
      required: ["host", "database", "user", "query"]
    },
    sampleConfig: {
      host: "localhost",
      port: 5432,
      database: "postgres",
      user: "postgres",
      query: "SELECT * FROM events WHERE created_at > NOW() - interval '1 minute'",
      pollIntervalSeconds: 60
    }
  },
  {
    type: "mysql_query",
    label: "MySQL: Query",
    category: "Connector",
    description: "Execute a SQL query against MySQL.",
    configSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        port: { type: "number" },
        database: { type: "string" },
        user: { type: "string" },
        secretRef: { type: "object" },
        ssl: { type: "boolean" },
        query: { type: "string" },
        params: { type: "array" }
      },
      required: ["host", "database", "user", "query"]
    },
    sampleConfig: {
      host: "localhost",
      port: 3306,
      database: "app",
      user: "root",
      query: "SELECT * FROM users WHERE id = ?",
      params: [1]
    }
  },
  {
    type: "mongo_operation",
    label: "MongoDB: Operation",
    category: "Connector",
    description: "Perform find / insert / update / aggregate on MongoDB.",
    configSchema: {
      type: "object",
      properties: {
        uri: { type: "string" },
        database: { type: "string" },
        collection: { type: "string" },
        operation: { type: "string", enum: ["find", "insert", "update", "aggregate"] },
        query: {},
        document: {},
        update: {},
        pipeline: {},
        secretRef: { type: "object" }
      },
      required: ["database", "collection", "operation"]
    },
    sampleConfig: {
      uri: "mongodb://localhost:27017",
      database: "app",
      collection: "users",
      operation: "find",
      query: { active: true }
    }
  },
  {
    type: "redis_command",
    label: "Redis: Command",
    category: "Connector",
    description: "Execute a Redis command (GET/SET/DEL/PUBLISH/LPUSH/RPUSH/HSET/HGET/EXPIRE).",
    configSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        secretRef: { type: "object" },
        command: {
          type: "string",
          enum: ["GET", "SET", "DEL", "PUBLISH", "LPUSH", "RPUSH", "HSET", "HGET", "EXPIRE", "INCR", "DECR"]
        },
        args: { type: "array" }
      },
      required: ["command"]
    },
    sampleConfig: {
      url: "redis://localhost:6379",
      command: "SET",
      args: ["greeting", "hello"]
    }
  },
  {
    type: "redis_trigger",
    label: "Redis Trigger",
    category: "Input",
    description: "Subscribe / blocking-pop trigger (polling fallback with BLPOP).",
    configSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        secretRef: { type: "object" },
        mode: { type: "string", enum: ["subscribe", "blpop"] },
        channel: { type: "string" },
        key: { type: "string" },
        timeoutSeconds: { type: "number" }
      },
      required: ["mode"]
    },
    sampleConfig: {
      url: "redis://localhost:6379",
      mode: "subscribe",
      channel: "events"
    }
  },
  {
    type: "github_action",
    label: "GitHub: Action",
    category: "Connector",
    description: "Execute a GitHub REST API operation (issues, PRs, files, commits).",
    configSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object" },
        owner: { type: "string" },
        repo: { type: "string" },
        operation: {
          type: "string",
          enum: [
            "createIssue",
            "commentIssue",
            "closeIssue",
            "createPr",
            "listIssues",
            "getFile",
            "createOrUpdateFile",
            "listCommits"
          ]
        },
        issueNumber: { type: "number" },
        title: { type: "string" },
        body: { type: "string" },
        head: { type: "string" },
        base: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
        sha: { type: "string" },
        commitMessage: { type: "string" },
        branch: { type: "string" }
      },
      required: ["owner", "repo", "operation"]
    },
    sampleConfig: {
      owner: "octocat",
      repo: "hello-world",
      operation: "listIssues"
    }
  },
  {
    type: "github_webhook_trigger",
    label: "GitHub Webhook Trigger",
    category: "Input",
    description: "Webhook trigger that validates the X-Hub-Signature-256 header.",
    configSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        secretRef: { type: "object" }
      }
    },
    sampleConfig: {
      path: "github-events"
    }
  },
  // ---------------------------------------------------------------------------
  // Phase 3.5 — Trigger System Expansion
  // ---------------------------------------------------------------------------
  {
    type: "manual_trigger",
    label: "Manual Trigger",
    category: "Input",
    description: "Start the workflow manually from the editor or via POST /api/triggers/manual/:workflowId.",
    configSchema: {
      type: "object",
      properties: {
        testData: {},
        label: { type: "string" }
      }
    },
    sampleConfig: {
      label: "Run manually",
      testData: { user_prompt: "Hello" }
    }
  },
  {
    type: "form_trigger",
    label: "Form Trigger",
    category: "Input",
    description: "Public HTML form that starts a workflow. GET /api/forms/:path renders the form, POST submits.",
    configSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        submitLabel: { type: "string" },
        authMode: { type: "string", enum: ["public", "session"] },
        successMessage: { type: "string" },
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              label: { type: "string" },
              type: { type: "string", enum: ["text", "textarea", "email", "number", "select", "checkbox"] },
              required: { type: "boolean" },
              placeholder: { type: "string" },
              options: { type: "array", items: { type: "string" } }
            },
            required: ["name", "type"]
          }
        }
      },
      required: ["path", "fields"]
    },
    sampleConfig: {
      path: "feedback",
      title: "Submit feedback",
      description: "Tell us what you think.",
      submitLabel: "Send",
      authMode: "public",
      successMessage: "Thanks — your response was recorded.",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "email", label: "Email", type: "email", required: true },
        { name: "message", label: "Message", type: "textarea", required: true }
      ]
    }
  },
  {
    type: "chat_trigger",
    label: "Chat Trigger",
    category: "Input",
    description: "Receive chat messages via POST /api/chat/:workflowId. Pairs naturally with agent_orchestrator.",
    configSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        authMode: { type: "string", enum: ["public", "session", "bearer"] },
        secretRef: { type: "object" },
        persistMessages: { type: "boolean" },
        sessionNamespace: { type: "string" },
        welcomeMessage: { type: "string" }
      }
    },
    sampleConfig: {
      path: "support",
      authMode: "session",
      persistMessages: true,
      sessionNamespace: "chat-support",
      welcomeMessage: "How can I help today?"
    }
  },
  {
    type: "file_trigger",
    label: "File Trigger",
    category: "Input",
    description: "Watches a filesystem path (polling) and fires on created/modified/deleted files.",
    configSchema: {
      type: "object",
      properties: {
        watchPath: { type: "string" },
        events: { type: "array", items: { type: "string", enum: ["created", "modified", "deleted"] } },
        pattern: { type: "string" },
        recursive: { type: "boolean" },
        pollIntervalSeconds: { type: "number", minimum: 1 },
        active: { type: "boolean" }
      },
      required: ["watchPath"]
    },
    sampleConfig: {
      watchPath: "./data/inbox",
      events: ["created", "modified"],
      pattern: "*.csv",
      recursive: false,
      pollIntervalSeconds: 30,
      active: true
    }
  },
  {
    type: "rss_trigger",
    label: "RSS / Atom Trigger",
    category: "Input",
    description: "Poll an RSS or Atom feed and fire the workflow for new items (deduplicated by GUID).",
    configSchema: {
      type: "object",
      properties: {
        feedUrl: { type: "string" },
        pollIntervalSeconds: { type: "number", minimum: 30 },
        maxItemsPerTick: { type: "number" },
        headers: { type: "object" },
        active: { type: "boolean" }
      },
      required: ["feedUrl"]
    },
    sampleConfig: {
      feedUrl: "https://example.com/feed.xml",
      pollIntervalSeconds: 300,
      maxItemsPerTick: 20,
      active: true
    }
  },
  {
    type: "sse_trigger",
    label: "SSE Trigger",
    category: "Input",
    description: "Connects to a Server-Sent Events URL and fires the workflow for each event.",
    configSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        eventName: { type: "string" },
        authMode: { type: "string", enum: ["none", "bearer"] },
        secretRef: { type: "object" },
        reconnectDelaySeconds: { type: "number" },
        maxEventsPerMinute: { type: "number" },
        active: { type: "boolean" }
      },
      required: ["url"]
    },
    sampleConfig: {
      url: "https://example.com/sse",
      authMode: "none",
      reconnectDelaySeconds: 5,
      maxEventsPerMinute: 60,
      active: true
    }
  },
  {
    type: "mcp_server_trigger",
    label: "MCP Server Trigger",
    category: "Input",
    description: "Exposes this workflow as an MCP tool at POST /api/mcp-server/:path/invoke. Downstream nodes see the tool arguments.",
    configSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        toolName: { type: "string" },
        toolDescription: { type: "string" },
        inputSchema: { type: "object" },
        authMode: { type: "string", enum: ["public", "bearer"] },
        secretRef: { type: "object" }
      },
      required: ["path", "toolName"]
    },
    sampleConfig: {
      path: "helper",
      toolName: "query_knowledge_base",
      toolDescription: "Answer a question using the knowledge base.",
      inputSchema: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"]
      },
      authMode: "public"
    }
  },
  {
    type: "kafka_trigger",
    label: "Kafka Trigger",
    category: "Input",
    description: "Consume messages from a Kafka topic (requires 'kafkajs' — emits NOT_IMPLEMENTED if missing).",
    configSchema: {
      type: "object",
      properties: {
        brokers: { type: "array", items: { type: "string" } },
        topic: { type: "string" },
        groupId: { type: "string" },
        fromBeginning: { type: "boolean" },
        secretRef: { type: "object" },
        active: { type: "boolean" }
      },
      required: ["brokers", "topic", "groupId"]
    },
    sampleConfig: {
      brokers: ["localhost:9092"],
      topic: "events",
      groupId: "ai-orchestrator",
      fromBeginning: false,
      active: true
    }
  },
  {
    type: "rabbitmq_trigger",
    label: "RabbitMQ Trigger",
    category: "Input",
    description: "Consume messages from a RabbitMQ queue (requires 'amqplib' — emits NOT_IMPLEMENTED if missing).",
    configSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        queue: { type: "string" },
        prefetch: { type: "number" },
        secretRef: { type: "object" },
        active: { type: "boolean" }
      },
      required: ["url", "queue"]
    },
    sampleConfig: {
      url: "amqp://localhost",
      queue: "events",
      prefetch: 1,
      active: true
    }
  },
  {
    type: "sticky_note",
    label: "Sticky Note",
    category: "Utility",
    description: "A visual-only annotation on the canvas (markdown supported). Not executed by the runtime.",
    configSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        color: { type: "string", enum: ["yellow", "blue", "green", "pink", "purple", "gray"] },
        fontSize: { type: "number" }
      }
    },
    sampleConfig: {
      content: "## Note\nExplain what this section of the workflow does.",
      color: "yellow",
      fontSize: 14
    }
  },
  {
    type: "mqtt_trigger",
    label: "MQTT Trigger",
    category: "Input",
    description: "Subscribe to an MQTT topic (requires 'mqtt' — emits NOT_IMPLEMENTED if missing).",
    configSchema: {
      type: "object",
      properties: {
        brokerUrl: { type: "string" },
        topic: { type: "string" },
        qos: { type: "number", enum: [0, 1, 2] },
        clientId: { type: "string" },
        secretRef: { type: "object" },
        active: { type: "boolean" }
      },
      required: ["brokerUrl", "topic"]
    },
    sampleConfig: {
      brokerUrl: "mqtt://localhost:1883",
      topic: "sensors/+/data",
      qos: 1,
      active: true
    }
  },
  // ---------------------------------------------------------------------------
  // Phase 3.2 — Tier 2 integrations (Teams, Notion, Airtable, Jira, Salesforce,
  // HubSpot, Stripe, AWS S3, Telegram, Discord, Google Drive trigger,
  // Google Calendar, Twilio)
  // ---------------------------------------------------------------------------
  {
    type: "teams_send_message",
    label: "Microsoft Teams: Send Message",
    category: "Connector",
    description: "Post a card or text message to a Microsoft Teams channel via an incoming webhook.",
    configSchema: {
      type: "object",
      properties: {
        webhookUrl: { type: "string" },
        secretRef: { type: "object" },
        text: { type: "string" },
        title: { type: "string" },
        themeColor: { type: "string" },
        cardJson: { type: "string" }
      }
    },
    sampleConfig: {
      webhookUrl: "https://outlook.office.com/webhook/...",
      text: "Hello from ai-orchestrator {{user_prompt}}",
      title: "Notification",
      themeColor: "0078D4"
    }
  },
  {
    type: "notion_create_page",
    label: "Notion: Create Page",
    category: "Connector",
    description: "Create a page in a Notion database using an integration token.",
    configSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object" },
        databaseId: { type: "string" },
        titleProperty: { type: "string" },
        title: { type: "string" },
        propertiesJson: { type: "string" },
        contentMarkdown: { type: "string" }
      },
      required: ["databaseId"]
    },
    sampleConfig: {
      databaseId: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      titleProperty: "Name",
      title: "New entry from {{user_prompt}}",
      propertiesJson: "{}"
    }
  },
  {
    type: "notion_query_database",
    label: "Notion: Query Database",
    category: "Connector",
    description: "Query a Notion database with optional filter/sort JSON.",
    configSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object" },
        databaseId: { type: "string" },
        filterJson: { type: "string" },
        sortsJson: { type: "string" },
        pageSize: { type: "number" }
      },
      required: ["databaseId"]
    },
    sampleConfig: {
      databaseId: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      pageSize: 50
    }
  },
  {
    type: "airtable_create_record",
    label: "Airtable: Create Record",
    category: "Connector",
    description: "Create one or more records in an Airtable table (personal access token).",
    configSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object" },
        baseId: { type: "string" },
        table: { type: "string" },
        fieldsJson: { type: "string" },
        typecast: { type: "boolean" }
      },
      required: ["baseId", "table"]
    },
    sampleConfig: {
      baseId: "appXXXXXXXXXXXXXX",
      table: "Leads",
      fieldsJson: "{\"Name\":\"{{user_prompt}}\"}",
      typecast: true
    }
  },
  {
    type: "airtable_list_records",
    label: "Airtable: List Records",
    category: "Connector",
    description: "List records from an Airtable table with optional formula + max page size.",
    configSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object" },
        baseId: { type: "string" },
        table: { type: "string" },
        filterByFormula: { type: "string" },
        maxRecords: { type: "number" },
        view: { type: "string" }
      },
      required: ["baseId", "table"]
    },
    sampleConfig: {
      baseId: "appXXXXXXXXXXXXXX",
      table: "Leads",
      maxRecords: 100
    }
  },
  {
    type: "airtable_update_record",
    label: "Airtable: Update Record",
    category: "Connector",
    description: "Patch an Airtable record by ID.",
    configSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object" },
        baseId: { type: "string" },
        table: { type: "string" },
        recordId: { type: "string" },
        fieldsJson: { type: "string" }
      },
      required: ["baseId", "table", "recordId"]
    },
    sampleConfig: {
      baseId: "appXXXXXXXXXXXXXX",
      table: "Leads",
      recordId: "recXXXXXXXXXXXXXX",
      fieldsJson: "{\"Status\":\"Contacted\"}"
    }
  },
  {
    type: "jira_create_issue",
    label: "Jira: Create Issue",
    category: "Connector",
    description: "Create a Jira Cloud issue. Auth via Atlassian API token (email:token basic auth stored in the secret).",
    configSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string" },
        secretRef: { type: "object" },
        email: { type: "string" },
        projectKey: { type: "string" },
        issueType: { type: "string" },
        summary: { type: "string" },
        description: { type: "string" },
        fieldsJson: { type: "string" }
      },
      required: ["baseUrl", "projectKey", "issueType", "summary"]
    },
    sampleConfig: {
      baseUrl: "https://your-domain.atlassian.net",
      email: "you@example.com",
      projectKey: "ENG",
      issueType: "Task",
      summary: "New ticket from {{user_prompt}}"
    }
  },
  {
    type: "jira_search_issues",
    label: "Jira: Search Issues",
    category: "Connector",
    description: "Run a JQL search against Jira Cloud.",
    configSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string" },
        secretRef: { type: "object" },
        email: { type: "string" },
        jql: { type: "string" },
        maxResults: { type: "number" }
      },
      required: ["baseUrl", "jql"]
    },
    sampleConfig: {
      baseUrl: "https://your-domain.atlassian.net",
      email: "you@example.com",
      jql: "project = ENG AND status = \"To Do\"",
      maxResults: 50
    }
  },
  {
    type: "salesforce_create_record",
    label: "Salesforce: Create Record",
    category: "Connector",
    description: "Create a record on a Salesforce sObject. Auth via OAuth access token stored as a secret.",
    configSchema: {
      type: "object",
      properties: {
        instanceUrl: { type: "string" },
        apiVersion: { type: "string" },
        secretRef: { type: "object" },
        sobject: { type: "string" },
        fieldsJson: { type: "string" }
      },
      required: ["instanceUrl", "sobject"]
    },
    sampleConfig: {
      instanceUrl: "https://your-instance.my.salesforce.com",
      apiVersion: "v58.0",
      sobject: "Lead",
      fieldsJson: "{\"LastName\":\"Smith\",\"Company\":\"Acme\"}"
    }
  },
  {
    type: "salesforce_query",
    label: "Salesforce: SOQL Query",
    category: "Connector",
    description: "Run a SOQL query against Salesforce.",
    configSchema: {
      type: "object",
      properties: {
        instanceUrl: { type: "string" },
        apiVersion: { type: "string" },
        secretRef: { type: "object" },
        soql: { type: "string" }
      },
      required: ["instanceUrl", "soql"]
    },
    sampleConfig: {
      instanceUrl: "https://your-instance.my.salesforce.com",
      apiVersion: "v58.0",
      soql: "SELECT Id, Name FROM Account LIMIT 10"
    }
  },
  {
    type: "hubspot_create_contact",
    label: "HubSpot: Create Contact",
    category: "Connector",
    description: "Create a HubSpot contact using a private app access token.",
    configSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object" },
        propertiesJson: { type: "string" }
      }
    },
    sampleConfig: {
      propertiesJson: "{\"email\":\"{{user_prompt}}\",\"firstname\":\"Jane\"}"
    }
  },
  {
    type: "hubspot_get_contact",
    label: "HubSpot: Get Contact",
    category: "Connector",
    description: "Fetch a HubSpot contact by ID or email.",
    configSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object" },
        identifier: { type: "string" },
        idProperty: { type: "string" }
      },
      required: ["identifier"]
    },
    sampleConfig: {
      identifier: "someone@example.com",
      idProperty: "email"
    }
  },
  {
    type: "stripe_create_customer",
    label: "Stripe: Create Customer",
    category: "Connector",
    description: "Create a Stripe customer. Secret must contain a restricted/private API key.",
    configSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object" },
        email: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        metadataJson: { type: "string" }
      }
    },
    sampleConfig: {
      email: "{{user_prompt}}",
      name: "Customer from ai-orchestrator"
    }
  },
  {
    type: "stripe_create_charge",
    label: "Stripe: Create PaymentIntent",
    category: "Connector",
    description: "Create a Stripe PaymentIntent (the modern replacement for Charges).",
    configSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object" },
        amount: { type: "number" },
        currency: { type: "string" },
        customerId: { type: "string" },
        description: { type: "string" },
        metadataJson: { type: "string" }
      },
      required: ["amount", "currency"]
    },
    sampleConfig: {
      amount: 1000,
      currency: "usd",
      description: "Charge from ai-orchestrator"
    }
  },
  {
    type: "stripe_webhook_trigger",
    label: "Stripe Webhook Trigger",
    category: "Input",
    description: "Webhook-based trigger that validates Stripe signatures. Point Stripe at /api/webhooks/stripe/:workflowId.",
    configSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        signingSecretRef: { type: "object" },
        replayToleranceSeconds: { type: "number" }
      }
    },
    sampleConfig: {
      path: "stripe-events",
      replayToleranceSeconds: 300
    }
  },
  {
    type: "aws_s3_put_object",
    label: "AWS S3: Put Object",
    category: "Connector",
    description: "Upload an object to S3 via SigV4. Credentials secret stores JSON {accessKeyId, secretAccessKey, sessionToken?}.",
    configSchema: {
      type: "object",
      properties: {
        region: { type: "string" },
        bucket: { type: "string" },
        key: { type: "string" },
        body: { type: "string" },
        contentType: { type: "string" },
        secretRef: { type: "object" }
      },
      required: ["region", "bucket", "key"]
    },
    sampleConfig: {
      region: "us-east-1",
      bucket: "my-bucket",
      key: "reports/{{result}}.json",
      body: "{{result}}",
      contentType: "application/json"
    }
  },
  {
    type: "aws_s3_get_object",
    label: "AWS S3: Get Object",
    category: "Connector",
    description: "Download an object from S3. Returns text for text/* and application/json, otherwise base64.",
    configSchema: {
      type: "object",
      properties: {
        region: { type: "string" },
        bucket: { type: "string" },
        key: { type: "string" },
        secretRef: { type: "object" }
      },
      required: ["region", "bucket", "key"]
    },
    sampleConfig: {
      region: "us-east-1",
      bucket: "my-bucket",
      key: "reports/input.json"
    }
  },
  {
    type: "aws_s3_list_objects",
    label: "AWS S3: List Objects",
    category: "Connector",
    description: "List objects under a prefix via S3 ListObjectsV2.",
    configSchema: {
      type: "object",
      properties: {
        region: { type: "string" },
        bucket: { type: "string" },
        prefix: { type: "string" },
        maxKeys: { type: "number" },
        secretRef: { type: "object" }
      },
      required: ["region", "bucket"]
    },
    sampleConfig: {
      region: "us-east-1",
      bucket: "my-bucket",
      prefix: "reports/",
      maxKeys: 100
    }
  },
  {
    type: "telegram_send_message",
    label: "Telegram: Send Message",
    category: "Connector",
    description: "Send a Telegram message via the Bot API. Secret stores the bot token.",
    configSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object" },
        chatId: { type: "string" },
        text: { type: "string" },
        parseMode: { type: "string", enum: ["", "Markdown", "MarkdownV2", "HTML"] },
        disableWebPagePreview: { type: "boolean" }
      },
      required: ["chatId", "text"]
    },
    sampleConfig: {
      chatId: "@my_channel",
      text: "Hello from ai-orchestrator {{user_prompt}}",
      parseMode: "Markdown"
    }
  },
  {
    type: "telegram_trigger",
    label: "Telegram Trigger",
    category: "Input",
    description: "Webhook-based trigger validated by X-Telegram-Bot-Api-Secret-Token. Point setWebhook at /api/webhooks/telegram/:workflowId.",
    configSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        signingSecretRef: { type: "object" }
      }
    },
    sampleConfig: {
      path: "telegram-events"
    }
  },
  {
    type: "discord_send_message",
    label: "Discord: Send Message",
    category: "Connector",
    description: "Send a message via a Discord webhook URL (or bot token).",
    configSchema: {
      type: "object",
      properties: {
        webhookUrl: { type: "string" },
        secretRef: { type: "object" },
        content: { type: "string" },
        username: { type: "string" },
        embedsJson: { type: "string" }
      }
    },
    sampleConfig: {
      webhookUrl: "https://discord.com/api/webhooks/.../.../",
      content: "Notification from ai-orchestrator: {{user_prompt}}",
      username: "orchestrator-bot"
    }
  },
  {
    type: "discord_trigger",
    label: "Discord Trigger",
    category: "Input",
    description: "Webhook-based trigger validated with Ed25519 signature (X-Signature-Ed25519 + X-Signature-Timestamp).",
    configSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        publicKey: { type: "string" }
      },
      required: ["publicKey"]
    },
    sampleConfig: {
      path: "discord-interactions",
      publicKey: "<application public key (hex)>"
    }
  },
  {
    type: "google_drive_trigger",
    label: "Google Drive Trigger",
    category: "Input",
    description: "Poll a Google Drive folder for new or modified files using an access token.",
    configSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object" },
        folderId: { type: "string" },
        query: { type: "string" },
        pollIntervalSeconds: { type: "number" }
      },
      required: ["folderId"]
    },
    sampleConfig: {
      folderId: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      pollIntervalSeconds: 60
    }
  },
  {
    type: "google_calendar_create_event",
    label: "Google Calendar: Create Event",
    category: "Connector",
    description: "Create a calendar event using an OAuth access token stored as a secret.",
    configSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object" },
        calendarId: { type: "string" },
        summary: { type: "string" },
        description: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        timeZone: { type: "string" },
        attendeesCsv: { type: "string" }
      },
      required: ["calendarId", "summary", "start", "end"]
    },
    sampleConfig: {
      calendarId: "primary",
      summary: "Kick-off — {{user_prompt}}",
      start: "2026-05-01T10:00:00",
      end: "2026-05-01T11:00:00",
      timeZone: "America/New_York"
    }
  },
  {
    type: "google_calendar_list_events",
    label: "Google Calendar: List Events",
    category: "Connector",
    description: "List upcoming events from a Google Calendar.",
    configSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object" },
        calendarId: { type: "string" },
        timeMin: { type: "string" },
        timeMax: { type: "string" },
        maxResults: { type: "number" },
        q: { type: "string" }
      },
      required: ["calendarId"]
    },
    sampleConfig: {
      calendarId: "primary",
      maxResults: 25
    }
  },
  {
    type: "twilio_send_sms",
    label: "Twilio: Send SMS",
    category: "Connector",
    description: "Send an SMS via Twilio. Secret stores the auth token paired with the Account SID in config.",
    configSchema: {
      type: "object",
      properties: {
        accountSid: { type: "string" },
        secretRef: { type: "object" },
        from: { type: "string" },
        to: { type: "string" },
        body: { type: "string" }
      },
      required: ["accountSid", "from", "to", "body"]
    },
    sampleConfig: {
      accountSid: "AC...",
      from: "+15551234567",
      to: "+15557654321",
      body: "Alert: {{user_prompt}}"
    }
  }
];

export function getNodeDefinition(type: string): NodeDefinition | undefined {
  return nodeDefinitions.find((node) => node.type === type);
}
