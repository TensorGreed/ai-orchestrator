import type { MCPServerConfig, MCPToolResult } from "@ai-orchestrator/shared";
import type { MCPExecutionContext, MCPServerAdapter } from "../types";

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
        }
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
        name: "lookup_kb",
        description: "Lookup a short knowledge-base snippet by topic.",
        inputSchema: {
          type: "object",
          properties: { topic: { type: "string" } },
          required: ["topic"]
        }
      }
    ];
  }

  async invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    config: MCPServerConfig,
    _context: MCPExecutionContext
  ): Promise<MCPToolResult> {
    try {
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