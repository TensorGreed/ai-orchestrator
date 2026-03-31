import type { NodeDefinition } from "./types";

export const nodeDefinitions: NodeDefinition[] = [
  {
    type: "webhook_input",
    label: "Webhook Input",
    category: "Input",
    description: "Injects webhook payload into workflow context.",
    configSchema: {
      type: "object",
      properties: { passThroughFields: { type: "array", items: { type: "string" } } }
    },
    sampleConfig: { passThroughFields: ["system_prompt", "user_prompt", "session_id"] }
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
        provider: { type: "object" },
        systemPromptTemplate: { type: "string" },
        userPromptTemplate: { type: "string" },
        sessionIdTemplate: { type: "string" },
        maxIterations: { type: "number" },
        toolCallingEnabled: { type: "boolean" },
        mcpServers: { type: "array", items: { type: "object" } }
      },
      required: ["provider", "maxIterations"]
    },
    sampleConfig: {
      provider: { providerId: "ollama", model: "qwen2.5:7b", baseUrl: "http://localhost:11434/v1" },
      systemPromptTemplate: "{{system_prompt}}",
      userPromptTemplate: "{{user_prompt}}",
      sessionIdTemplate: "{{session_id}}",
      maxIterations: 6,
      toolCallingEnabled: true,
      mcpServers: [{ serverId: "mock-mcp" }]
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
    description: "Retrieves context chunks from provided documents.",
    configSchema: {
      type: "object",
      properties: {
        queryTemplate: { type: "string" },
        topK: { type: "number" },
        documents: { type: "array", items: { type: "string" } }
      }
    },
    sampleConfig: { queryTemplate: "{{user_prompt}}", topK: 3 }
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
    type: "output",
    label: "Output",
    category: "Output",
    description: "Formats final workflow output payload.",
    configSchema: {
      type: "object",
      properties: { responseTemplate: { type: "string" }, outputKey: { type: "string" } }
    },
    sampleConfig: { responseTemplate: "{{answer}}", outputKey: "result" }
  }
];

export function getNodeDefinition(type: string): NodeDefinition | undefined {
  return nodeDefinitions.find((node) => node.type === type);
}
