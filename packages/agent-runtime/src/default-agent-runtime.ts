import type { AgentRunRequest, AgentRunState, ChatMessage, ToolDefinition } from "@ai-orchestrator/shared";
import type { AgentRuntimeAdapter, AgentRuntimeContext, AgentToolRuntime, InternalToolResult } from "./types";
import { createToolErrorResult } from "./types";

const MAX_MESSAGE_CHARS = 3000;
const MAX_SYSTEM_MESSAGE_CHARS = 8000;
const MAX_TOOL_MESSAGE_CHARS = 2500;
const MAX_TOOL_DESCRIPTION_CHARS = 280;
const MAX_TOOL_SCHEMA_PROPERTIES = 12;
const MAX_TOOL_SCHEMA_ENUM_VALUES = 20;
const MAX_TOOL_SCHEMA_DEPTH = 2;
const MAX_TOOL_COUNT = 64;

function normalizeMaxMessages(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return 20;
  }
  return Math.floor(value);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const hidden = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n...[truncated ${hidden} chars]`;
}

function normalizeMessageContent(value: unknown, maxChars: number): string {
  return truncateText(String(value ?? ""), maxChars);
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function simplifySchema(value: unknown, depth = 0): Record<string, unknown> {
  const schema = toRecord(value);
  if (!Object.keys(schema).length) {
    return { type: "object", additionalProperties: true };
  }

  const simplified: Record<string, unknown> = {};
  if (typeof schema.type === "string") {
    simplified.type = schema.type;
  }
  if (typeof schema.description === "string" && schema.description.trim()) {
    simplified.description = truncateText(schema.description, 120);
  }
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    simplified.required = schema.required.slice(0, MAX_TOOL_SCHEMA_PROPERTIES).map((item) => String(item));
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    simplified.enum = schema.enum.slice(0, MAX_TOOL_SCHEMA_ENUM_VALUES).map((item) => truncateText(String(item), 60));
  }

  if (depth < MAX_TOOL_SCHEMA_DEPTH) {
    const properties = toRecord(schema.properties);
    if (Object.keys(properties).length > 0) {
      const limitedProps = Object.entries(properties).slice(0, MAX_TOOL_SCHEMA_PROPERTIES);
      simplified.properties = Object.fromEntries(
        limitedProps.map(([key, property]) => [key, simplifySchema(property, depth + 1)])
      );
    }

    if (schema.items !== undefined) {
      simplified.items = simplifySchema(schema.items, depth + 1);
    }
  }

  if (!Object.keys(simplified).length) {
    return { type: "object", additionalProperties: true };
  }
  return simplified;
}

function dedupeToolsByName(input: ToolDefinition[]): ToolDefinition[] {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of input) {
    const normalizedName = String(tool.name ?? "").trim();
    if (!normalizedName || byName.has(normalizedName)) {
      continue;
    }
    byName.set(normalizedName, tool);
  }
  return [...byName.values()];
}

function scoreToolForPrompt(tool: ToolDefinition, prompt: string): number {
  const haystack = `${tool.name} ${tool.description}`.toLowerCase();
  const tokens = prompt
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((token) => token.length >= 4);

  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  return score;
}

function normalizeToolsForModel(input: ToolDefinition[], prompt: string): ToolDefinition[] {
  const deduped = dedupeToolsByName(input).map((tool) => ({
    name: truncateText(String(tool.name ?? ""), 120),
    description: truncateText(String(tool.description ?? ""), MAX_TOOL_DESCRIPTION_CHARS),
    inputSchema: simplifySchema(tool.inputSchema)
  }));

  if (deduped.length <= MAX_TOOL_COUNT) {
    return deduped;
  }

  const ranked = deduped
    .map((tool, index) => ({
      tool,
      index,
      score: scoreToolForPrompt(tool, prompt)
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.index - b.index;
    });

  return ranked.slice(0, MAX_TOOL_COUNT).map((entry) => entry.tool);
}

function serializeToolMessage(ok: boolean, payload: unknown): string {
  const raw = JSON.stringify(ok ? { ok: true, output: payload } : { ok: false, error: payload });
  if (raw.length <= MAX_TOOL_MESSAGE_CHARS) {
    return raw;
  }

  return JSON.stringify({
    ok,
    truncated: true,
    preview: raw.slice(0, MAX_TOOL_MESSAGE_CHARS)
  });
}

function normalizeStoredMessages(messages: ChatMessage[], maxMessages: number): ChatMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "tool")
    .map((message) => ({
      ...message,
      content:
        message.role === "tool"
          ? normalizeMessageContent(message.content, MAX_TOOL_MESSAGE_CHARS)
          : normalizeMessageContent(message.content, MAX_MESSAGE_CHARS)
    }))
    .slice(-maxMessages);
}

export class DefaultAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "default-agent-runtime";

  async run(request: AgentRunRequest, tools: AgentToolRuntime, context: AgentRuntimeContext): Promise<AgentRunState> {
    const providerAdapter = context.providerRegistry.get(request.provider.providerId);
    const memoryEnabled = Boolean(context.memoryStore && request.sessionId);
    const memoryNamespace = request.memory?.namespace?.trim() || "default";
    const memoryMaxMessages = normalizeMaxMessages(request.memory?.maxMessages);
    const persistToolMessages = request.memory?.persistToolMessages !== false;

    let memoryMessages: ChatMessage[] = [];
    if (memoryEnabled && request.sessionId) {
      const loaded = await context.memoryStore!.loadMessages(memoryNamespace, request.sessionId);
      memoryMessages = normalizeStoredMessages(loaded, memoryMaxMessages);
    }

    const messages: ChatMessage[] = [
      { role: "system", content: normalizeMessageContent(request.systemPrompt, MAX_SYSTEM_MESSAGE_CHARS) },
      ...memoryMessages,
      { role: "user", content: normalizeMessageContent(request.userPrompt, MAX_MESSAGE_CHARS) }
    ];
    const normalizedTools = normalizeToolsForModel(request.toolCallingEnabled ? tools.tools : [], request.userPrompt);

    const steps: AgentRunState["steps"] = [];
    let lastAssistantMessage = "";

    const persistConversation = async () => {
      if (!memoryEnabled || !request.sessionId || !context.memoryStore) {
        return;
      }

      const persistable = messages
        .filter((message, index) => !(index === 0 && message.role === "system"))
        .filter((message) => (persistToolMessages ? true : message.role !== "tool"))
        .slice(-memoryMaxMessages);

      await context.memoryStore.saveMessages(memoryNamespace, request.sessionId, persistable);
    };

    try {
      for (let iteration = 1; iteration <= request.maxIterations; iteration += 1) {
        const modelResponse = await providerAdapter.generate(
          {
            provider: request.provider,
            messages,
            tools: request.toolCallingEnabled ? normalizedTools : []
          },
          {
            resolveSecret: context.resolveSecret
          }
        );

        lastAssistantMessage = modelResponse.content;
        const requestedTools = request.toolCallingEnabled ? modelResponse.toolCalls : [];

        if (requestedTools.length > 0) {
          messages.push({
            role: "assistant",
            content: normalizeMessageContent(modelResponse.content, MAX_MESSAGE_CHARS),
            toolCalls: requestedTools
          });

          const toolResults: InternalToolResult[] = [];

          for (const call of requestedTools) {
            try {
              const output = await tools.invokeTool(call.name, call.arguments);
              toolResults.push({
                toolCallId: call.id,
                toolName: call.name,
                output
              });

              messages.push({
                role: "tool",
                content: serializeToolMessage(true, output),
                toolCallId: call.id,
                name: call.name
              });
            } catch (error) {
              const toolError = createToolErrorResult(call, error);
              toolResults.push(toolError);
              messages.push({
                role: "tool",
                content: serializeToolMessage(false, toolError.error),
                toolCallId: call.id,
                name: call.name
              });
            }
          }

          steps.push({
            iteration,
            modelOutput: modelResponse.content,
            requestedTools,
            toolResults
          });

          continue;
        }

        messages.push({ role: "assistant", content: normalizeMessageContent(modelResponse.content, MAX_MESSAGE_CHARS) });
        steps.push({
          iteration,
          modelOutput: modelResponse.content,
          requestedTools: [],
          toolResults: []
        });

        const result: AgentRunState = {
          finalAnswer: modelResponse.content,
          stopReason: "final_answer",
          iterations: iteration,
          messages,
          steps
        };
        await persistConversation();
        return result;
      }

      const result: AgentRunState = {
        finalAnswer: lastAssistantMessage || "Agent stopped after reaching iteration limit.",
        stopReason: "max_iterations",
        iterations: request.maxIterations,
        messages,
        steps
      };
      await persistConversation();
      return result;
    } catch (error) {
      const result: AgentRunState = {
        finalAnswer: error instanceof Error ? error.message : "Agent runtime failed",
        stopReason: "error",
        iterations: steps.length,
        messages,
        steps
      };
      await persistConversation();
      return result;
    }
  }
}
