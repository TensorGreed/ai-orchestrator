import type {
  AgentRunRequest,
  AgentRunState,
  AgentToolOutputLimits,
  ChatMessage,
  ToolDefinition
} from "@ai-orchestrator/shared";
import type { AgentRuntimeAdapter, AgentRuntimeContext, AgentToolRuntime, InternalToolResult } from "./types";
import { createToolErrorResult } from "./types";

const MAX_MESSAGE_CHARS = 3000;
const MAX_SYSTEM_MESSAGE_CHARS = 8000;
const DEFAULT_TOOL_MESSAGE_MAX_CHARS = 45000;
const MAX_TOOL_DESCRIPTION_CHARS = 280;
const MAX_TOOL_SCHEMA_PROPERTIES = 12;
const MAX_TOOL_SCHEMA_ENUM_VALUES = 20;
const MAX_TOOL_SCHEMA_DEPTH = 2;
const MAX_TOOL_COUNT = 24;
const MAX_TOOLS_WITH_MATCH = 8;
const MAX_TOOLS_NO_MATCH = 12;
const STRONG_MATCH_SCORE = 2;
const DEFAULT_TOOL_PAYLOAD_MAX_DEPTH = 8;
const DEFAULT_TOOL_PAYLOAD_MAX_OBJECT_KEYS = 256;
const DEFAULT_TOOL_PAYLOAD_MAX_ARRAY_ITEMS = 256;
const DEFAULT_TOOL_PAYLOAD_MAX_STRING_CHARS = 2048;

function normalizeMaxMessages(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return 20;
  }
  return Math.floor(value);
}

interface NormalizedToolOutputLimits {
  messageMaxChars: number;
  payloadMaxDepth: number;
  payloadMaxObjectKeys: number;
  payloadMaxArrayItems: number;
  payloadMaxStringChars: number;
}

function normalizeToolOutputLimits(input: AgentToolOutputLimits | undefined): NormalizedToolOutputLimits {
  const normalize = (value: unknown, fallback: number, min: number, max: number) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    const rounded = Math.floor(parsed);
    if (rounded < min) {
      return min;
    }
    if (rounded > max) {
      return max;
    }
    return rounded;
  };

  return {
    messageMaxChars: normalize(input?.messageMaxChars, DEFAULT_TOOL_MESSAGE_MAX_CHARS, 500, 1_000_000),
    payloadMaxDepth: normalize(input?.payloadMaxDepth, DEFAULT_TOOL_PAYLOAD_MAX_DEPTH, 1, 16),
    payloadMaxObjectKeys: normalize(input?.payloadMaxObjectKeys, DEFAULT_TOOL_PAYLOAD_MAX_OBJECT_KEYS, 1, 5000),
    payloadMaxArrayItems: normalize(input?.payloadMaxArrayItems, DEFAULT_TOOL_PAYLOAD_MAX_ARRAY_ITEMS, 1, 5000),
    payloadMaxStringChars: normalize(input?.payloadMaxStringChars, DEFAULT_TOOL_PAYLOAD_MAX_STRING_CHARS, 100, 1_000_000)
  };
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

function compactToolPayload(value: unknown, limits: NormalizedToolOutputLimits, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (typeof value === "string") {
    return truncateText(value, limits.payloadMaxStringChars);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (depth >= limits.payloadMaxDepth) {
    if (Array.isArray(value)) {
      return `[array depth ${limits.payloadMaxDepth} truncated; length=${value.length}]`;
    }
    if (typeof value === "object") {
      const keys = Object.keys(toRecord(value)).length;
      return `[object depth ${limits.payloadMaxDepth} truncated; keys=${keys}]`;
    }
    return String(value);
  }

  if (Array.isArray(value)) {
    const limited = value.slice(0, limits.payloadMaxArrayItems).map((item) => compactToolPayload(item, limits, depth + 1));
    if (value.length > limits.payloadMaxArrayItems) {
      limited.push({
        _truncatedItems: value.length - limits.payloadMaxArrayItems
      });
    }
    return limited;
  }

  if (typeof value === "object") {
    const entries = Object.entries(toRecord(value));
    const limitedEntries = entries.slice(0, limits.payloadMaxObjectKeys);
    const compacted = Object.fromEntries(
      limitedEntries.map(([key, nested]) => [key, compactToolPayload(nested, limits, depth + 1)])
    ) as Record<string, unknown>;
    if (entries.length > limits.payloadMaxObjectKeys) {
      compacted._truncatedKeys = entries.length - limits.payloadMaxObjectKeys;
    }
    return compacted;
  }

  return String(value);
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

  const strongestScore = ranked[0]?.score ?? 0;
  if (strongestScore >= STRONG_MATCH_SCORE) {
    const strongest = ranked.filter((entry) => entry.score === strongestScore);
    return strongest.slice(0, Math.min(MAX_TOOLS_WITH_MATCH, MAX_TOOL_COUNT)).map((entry) => entry.tool);
  }

  const positive = ranked.filter((entry) => entry.score > 0);
  if (positive.length > 0) {
    return positive.slice(0, Math.min(MAX_TOOLS_WITH_MATCH, MAX_TOOL_COUNT)).map((entry) => entry.tool);
  }

  return ranked.slice(0, Math.min(MAX_TOOLS_NO_MATCH, MAX_TOOL_COUNT)).map((entry) => entry.tool);
}

function serializeToolMessage(ok: boolean, payload: unknown, limits: NormalizedToolOutputLimits): string {
  const wrapped = ok ? { ok: true, output: payload } : { ok: false, error: payload };
  const raw = JSON.stringify(wrapped);
  if (raw.length <= limits.messageMaxChars) {
    return raw;
  }

  const compactedWrapped = ok
    ? {
        ok: true,
        output: compactToolPayload(payload, limits),
        _meta: {
          truncated: true,
          originalChars: raw.length
        }
      }
    : {
        ok: false,
        error: compactToolPayload(payload, limits),
        _meta: {
          truncated: true,
          originalChars: raw.length
        }
      };
  const compactedRaw = JSON.stringify(compactedWrapped);
  if (compactedRaw.length <= limits.messageMaxChars) {
    return compactedRaw;
  }

  const previewChars = Math.max(500, limits.messageMaxChars - 250);
  return JSON.stringify({
    ok,
    truncated: true,
    originalChars: raw.length,
    preview: raw.slice(0, previewChars)
  });
}

function normalizeStoredMessages(
  messages: ChatMessage[],
  maxMessages: number,
  toolMessageMaxChars: number
): ChatMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "tool")
    .map((message) => ({
      ...message,
      content:
        message.role === "tool"
          ? normalizeMessageContent(message.content, toolMessageMaxChars)
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
    const toolOutputLimits = normalizeToolOutputLimits(request.toolOutputLimits);

    let memoryMessages: ChatMessage[] = [];
    if (memoryEnabled && request.sessionId) {
      const loaded = await context.memoryStore!.loadMessages(memoryNamespace, request.sessionId);
      memoryMessages = normalizeStoredMessages(loaded, memoryMaxMessages, toolOutputLimits.messageMaxChars);
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
                content: serializeToolMessage(true, output, toolOutputLimits),
                toolCallId: call.id,
                name: call.name
              });
            } catch (error) {
              const toolError = createToolErrorResult(call, error);
              toolResults.push(toolError);
              messages.push({
                role: "tool",
                content: serializeToolMessage(false, toolError.error, toolOutputLimits),
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
