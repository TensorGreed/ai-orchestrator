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
        idempotencyHeaderName: { type: "string" }
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
      idempotencyHeaderName: "idempotency-key"
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
        }
      },
      required: ["workflowId"]
    },
    sampleConfig: {
      workflowId: "",
      inputMapping: {
        user_prompt: "user_prompt",
        session_id: "session_id"
      }
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
        maxDelayMs: { type: "number" }
      }
    },
    sampleConfig: {
      delayMs: 1000,
      maxDelayMs: 30000
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
        toolCallingEnabled: { type: "boolean" }
      },
      required: ["maxIterations"]
    },
    sampleConfig: {
      systemPromptTemplate: "{{system_prompt}}",
      userPromptTemplate: "{{user_prompt}}",
      sessionIdTemplate: "{{session_id}}",
      maxIterations: 6,
      toolCallingEnabled: true
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
        argsTemplate: { type: "string" }
      },
      required: ["serverId", "toolName"]
    },
    sampleConfig: { serverId: "mock-mcp", toolName: "get_current_time", argsTemplate: "{\"tz\":\"UTC\"}" }
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
    type: "output_parser",
    label: "Output Parser",
    category: "Utility",
    description: "Validates and transforms LLM output into structured data using JSON Schema, item list parsing, or auto-fix retry.",
    configSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["json_schema", "item_list", "auto_fix"] },
        jsonSchema: { type: "string" },
        itemSeparator: { type: "string" },
        maxRetries: { type: "number" },
        inputKey: { type: "string" }
      },
      required: ["mode"]
    },
    sampleConfig: {
      mode: "json_schema",
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
    description: "Generates a downloadable PDF link from upstream content.",
    configSchema: {
      type: "object",
      properties: {
        inputKey: { type: "string" },
        textTemplate: { type: "string" },
        filenameTemplate: { type: "string" },
        outputKey: { type: "string" }
      }
    },
    sampleConfig: {
      inputKey: "answer",
      textTemplate: "",
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
  }
];

export function getNodeDefinition(type: string): NodeDefinition | undefined {
  return nodeDefinitions.find((node) => node.type === type);
}
