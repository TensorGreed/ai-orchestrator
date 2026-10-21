import type {
  McpPrompt,
  McpPromptGetResult,
  McpResource,
  McpResourceReadResult,
  McpResourceTemplate,
  McpServerCapabilities,
  MCPServerConfig,
  MCPToolResult
} from "@ai-orchestrator/shared";
import type { MCPExecutionContext, MCPServerAdapter, McpReadResourceOptions } from "../types";
import { declinedElicitation, normalizeResourceReadResult, validateElicitationRequest } from "../client-features";

/** Resources the mock server exposes, so the playground and tests can read something. */
const MOCK_RESOURCES: Array<McpResource & { text?: string; blob?: string }> = [
  {
    uri: "mock://docs/readme",
    name: "readme",
    title: "Mock server README",
    description: "What the mock server is for.",
    mimeType: "text/markdown",
    text: "# Mock MCP server\n\nA local demo server with time, calculator and KB tools, two resources and one prompt."
  },
  {
    uri: "mock://kb/index.json",
    name: "kb-index",
    title: "Knowledge base index",
    description: "Topics the lookup_kb tool knows.",
    mimeType: "application/json",
    text: JSON.stringify({ topics: ["mcp", "rag", "ollama"] }, null, 2)
  },
  {
    uri: "mock://images/dot.png",
    name: "dot",
    title: "A one-pixel image",
    mimeType: "image/png",
    // 1x1 transparent PNG.
    blob: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  }
];

const MOCK_RESOURCE_TEMPLATES: McpResourceTemplate[] = [
  { uriTemplate: "mock://kb/{topic}", name: "kb-topic", title: "Knowledge base topic", description: "One KB entry as text.", mimeType: "text/plain" }
];

const MOCK_PROMPTS: McpPrompt[] = [
  {
    name: "explain_topic",
    title: "Explain a topic",
    description: "System prompt that asks the model to explain a KB topic for a given audience.",
    arguments: [
      { name: "topic", description: "Topic to explain (mcp, rag or ollama).", required: true },
      { name: "audience", description: "Who the explanation is for.", required: false }
    ]
  }
];

const KB: Record<string, string> = {
  mcp: "MCP is the Model Context Protocol for exposing tools and resources to AI clients.",
  rag: "RAG combines retrieval and generation by grounding LLM prompts with external context.",
  ollama: "Ollama runs local open-source models and provides an OpenAI-compatible API endpoint."
};

function safeEvaluate(expression: string): number {
  if (!/^[0-9+\-*/().\s]+$/.test(expression)) {
    throw new Error("Expression contains unsupported characters");
  }

  // eslint-disable-next-line no-new-func
  const result = Function(`"use strict"; return (${expression});`)();
  if (typeof result !== "number" || Number.isNaN(result) || !Number.isFinite(result)) {
    throw new Error("Expression did not resolve to a finite number");
  }
  return result;
}

export class MockMCPServerAdapter implements MCPServerAdapter {
  readonly definition = {
    id: "mock-mcp",
    label: "Mock MCP Server",
    description: "Local demo MCP adapter with time, calculator, and KB tools.",
    configSchema: {
      type: "object",
      properties: {
        kbOverrides: { type: "object", additionalProperties: { type: "string" } }
      }
    },
    authSchema: { type: "object", properties: {} }
  };

  async discoverTools(_config: MCPServerConfig, _context: MCPExecutionContext) {
    return [
      {
        serverId: this.definition.id,
        serverLabel: this.definition.label,
        name: "get_current_time",
        description: "Get current ISO timestamp and localized display for an optional IANA timezone.",
        inputSchema: {
          type: "object",
          properties: { tz: { type: "string", description: "IANA timezone, for example America/Toronto" } }
        },
        annotations: { readOnlyHint: true }
      },
      {
        serverId: this.definition.id,
        serverLabel: this.definition.label,
        name: "calculator",
        description: "Evaluate a basic math expression containing numbers and + - * / operators.",
        inputSchema: {
          type: "object",
          properties: { expression: { type: "string" } },
          required: ["expression"]
        }
      },
      {
        serverId: this.definition.id,
        serverLabel: this.definition.label,
        name: "ask_user",
        description:
          "Demo of MCP elicitation: asks the person running the workflow a question through the client and returns their answer.",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string", description: "What to ask." },
            choices: { type: "array", items: { type: "string" }, description: "Optional fixed answers." }
          },
          required: ["question"]
        },
        annotations: { readOnlyHint: true }
      },
      {
        serverId: this.definition.id,
        serverLabel: this.definition.label,
        name: "summarize_with_model",
        description: "Demo of MCP sampling: asks the client's model to summarize the given text and returns the summary.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to summarize." },
            model: { type: "string", description: "Optional model name hint." }
          },
          required: ["text"]
        },
        annotations: { readOnlyHint: true }
      },
      {
        serverId: this.definition.id,
        serverLabel: this.definition.label,
        name: "lookup_kb",
        description: "Lookup a short knowledge-base snippet by topic.",
        inputSchema: {
          type: "object",
          properties: { topic: { type: "string" } },
          required: ["topic"]
        },
        annotations: { readOnlyHint: true }
      }
    ];
  }

  async describeServer(): Promise<McpServerCapabilities> {
    return { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } };
  }

  async listResources(): Promise<McpResource[]> {
    return MOCK_RESOURCES.map(({ text: _text, blob: _blob, ...resource }) => resource);
  }

  async listResourceTemplates(): Promise<McpResourceTemplate[]> {
    return MOCK_RESOURCE_TEMPLATES;
  }

  async readResource(
    uri: string,
    config: MCPServerConfig,
    _context: MCPExecutionContext,
    options: McpReadResourceOptions = {}
  ): Promise<McpResourceReadResult> {
    const known = MOCK_RESOURCES.find((resource) => resource.uri === uri);
    if (known) {
      const content = known.blob !== undefined ? { uri, mimeType: known.mimeType, blob: known.blob } : { uri, mimeType: known.mimeType, text: known.text ?? "" };
      return normalizeResourceReadResult(uri, { contents: [content] }, options.maxBytes);
    }
    const topicMatch = /^mock:\/\/kb\/([^/]+)$/.exec(uri);
    if (topicMatch) {
      const topic = decodeURIComponent(topicMatch[1]).toLowerCase();
      const overrides = (config.connection?.kbOverrides as Record<string, string> | undefined) ?? {};
      const content = overrides[topic] ?? KB[topic];
      if (!content) throw new Error(`Resource not found: ${uri}`);
      return normalizeResourceReadResult(uri, { contents: [{ uri, mimeType: "text/plain", text: content }] }, options.maxBytes);
    }
    throw new Error(`Resource not found: ${uri}`);
  }

  async listPrompts(): Promise<McpPrompt[]> {
    return MOCK_PROMPTS;
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<McpPromptGetResult> {
    if (name !== "explain_topic") throw new Error(`Prompt not found: ${name}`);
    const topic = String(args.topic ?? "").trim();
    if (!topic) throw new Error("Prompt 'explain_topic' requires the 'topic' argument.");
    const audience = String(args.audience ?? "").trim() || "a new team member";
    return {
      name,
      description: MOCK_PROMPTS[0].description,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are a patient technical writer. Explain ${topic} to ${audience} in three short paragraphs. Use the knowledge base entry when one exists: ${KB[topic.toLowerCase()] ?? "(no entry)"}`
          }
        }
      ]
    };
  }

  async invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    config: MCPServerConfig,
    context: MCPExecutionContext
  ): Promise<MCPToolResult> {
    try {
      if (toolName === "ask_user") {
        const question = String(args.question ?? "").trim();
        if (!question) throw new Error("question is required");
        const choices = Array.isArray(args.choices) ? args.choices.map(String).filter(Boolean) : [];
        const request = validateElicitationRequest({
          message: question,
          requestedSchema: {
            type: "object",
            properties: {
              answer: { type: "string", title: "Answer", ...(choices.length > 0 ? { enum: choices } : {}) }
            },
            required: ["answer"]
          }
        });
        const origin = { serverId: config.serverId, ...(config.registryServerId ? { registryServerId: config.registryServerId } : {}), toolName };
        const result = context.onElicitation ? await context.onElicitation(request, origin) : declinedElicitation();
        return {
          ok: true,
          output: {
            question,
            action: result.action,
            ...(result.action === "accept" ? { answer: result.content?.answer ?? null } : {})
          }
        };
      }

      if (toolName === "summarize_with_model") {
        const text = String(args.text ?? "").trim();
        if (!text) throw new Error("text is required");
        const hint = typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined;
        if (!context.onSampling) {
          return { ok: false, output: null, error: "Sampling is not available for this call: no model is attached to it." };
        }
        const origin = { serverId: config.serverId, ...(config.registryServerId ? { registryServerId: config.registryServerId } : {}), toolName };
        const result = await context.onSampling(
          {
            messages: [{ role: "user", content: { type: "text", text: `Summarize in one sentence:\n\n${text}` } }],
            ...(hint ? { modelPreferences: { hints: [{ name: hint }] } } : {}),
            maxTokens: 200
          },
          origin
        );
        return { ok: true, output: { summary: result.content.text, model: result.model } };
      }

      if (toolName === "get_current_time") {
        const tz = typeof args.tz === "string" && args.tz ? args.tz : "UTC";
        const now = new Date();
        return {
          ok: true,
          output: {
            timezone: tz,
            iso: now.toISOString(),
            localized: new Intl.DateTimeFormat("en-US", {
              dateStyle: "full",
              timeStyle: "long",
              timeZone: tz
            }).format(now)
          }
        };
      }

      if (toolName === "calculator") {
        const expression = String(args.expression ?? "").trim();
        if (!expression) {
          throw new Error("expression is required");
        }

        return {
          ok: true,
          output: {
            expression,
            result: safeEvaluate(expression)
          }
        };
      }

      if (toolName === "lookup_kb") {
        const topic = String(args.topic ?? "").trim().toLowerCase();
        const overrides = (config.connection?.kbOverrides as Record<string, string> | undefined) ?? {};
        const content = overrides[topic] ?? KB[topic];

        if (!content) {
          return {
            ok: true,
            output: {
              topic,
              found: false,
              content: `No KB entry for topic '${topic}'.`
            }
          };
        }

        return {
          ok: true,
          output: {
            topic,
            found: true,
            content
          }
        };
      }

      return {
        ok: false,
        output: null,
        error: `Unknown tool '${toolName}'`
      };
    } catch (error) {
      return {
        ok: false,
        output: null,
        error: error instanceof Error ? error.message : "Tool invocation failed"
      };
    }
  }
}