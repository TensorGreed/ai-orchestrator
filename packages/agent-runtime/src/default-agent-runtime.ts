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
const DEFAULT_TOOL_MESSAGE_MAX_CHARS = 6000;
const MAX_TOOL_DESCRIPTION_CHARS = 280;
const MAX_TOOL_SCHEMA_PROPERTIES = 8;
const MAX_TOOL_SCHEMA_ENUM_VALUES = 10;
const MAX_TOOL_SCHEMA_DEPTH = 1;
const MAX_TOOL_COUNT = 12;
const MAX_TOOLS_WITH_MATCH = 6;
const MAX_TOOLS_NO_MATCH = 8;
const MAX_TOOL_PROMPT_BUDGET_CHARS = 18000;
const STRONG_MATCH_SCORE = 2;
const DEFAULT_TOOL_PAYLOAD_MAX_DEPTH = 8;
const DEFAULT_TOOL_PAYLOAD_MAX_OBJECT_KEYS = 64;
const DEFAULT_TOOL_PAYLOAD_MAX_ARRAY_ITEMS = 64;
const DEFAULT_TOOL_PAYLOAD_MAX_STRING_CHARS = 1024;
const SESSION_CACHE_LIST_TOOL_NAME = "session_cache_list";
const SESSION_CACHE_GET_TOOL_NAME = "session_cache_get";
const SESSION_CACHE_DEFAULT_LIST_LIMIT = 10;
const SESSION_CACHE_MAX_LIST_LIMIT = 50;
const SESSION_CACHE_SUMMARY_LIMITS: NormalizedToolOutputLimits = {
  messageMaxChars: 20_000,
  payloadMaxDepth: 3,
  payloadMaxObjectKeys: 16,
  payloadMaxArrayItems: 16,
  payloadMaxStringChars: 240
};

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

interface RuntimeInternalTool {
  definition: ToolDefinition;
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
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

function toOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
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
}

function parsePathTokens(path: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  const matcher = /[^.[\]]+|\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(path))) {
    if (match[1] !== undefined) {
      tokens.push(Number(match[1]));
    } else {
      tokens.push(match[0]);
    }
  }
  return tokens;
}

function getValueAtPath(root: unknown, rawPath: string): unknown {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return root;
  }
  const tokens = parsePathTokens(trimmed);
  if (!tokens.length) {
    return undefined;
  }

  let current: unknown = root;
  for (const token of tokens) {
    if (typeof token === "number") {
      if (!Array.isArray(current) || token < 0 || token >= current.length) {
        return undefined;
      }
      current = current[token];
      continue;
    }

    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[token];
  }

  return current;
}

function buildToolOutputSummary(args: Record<string, unknown>, output: unknown, error?: string): Record<string, unknown> {
  return {
    args: compactToolPayload(args, SESSION_CACHE_SUMMARY_LIMITS),
    output: compactToolPayload(output, SESSION_CACHE_SUMMARY_LIMITS),
    ...(error ? { error: truncateText(error, 500) } : {})
  };
}

function createSessionCacheTools(input: {
  sessionId: string | undefined;
  namespace: string;
  context: AgentRuntimeContext;
}): RuntimeInternalTool[] {
  if (!input.sessionId || !input.context.toolDataStore) {
    return [];
  }

  const listTool: RuntimeInternalTool = {
    definition: {
      name: SESSION_CACHE_LIST_TOOL_NAME,
      description:
        "List cached MCP tool results from this session. Use this before repeating expensive MCP calls in follow-up prompts.",
      inputSchema: {
        type: "object",
        properties: {
          tool_name: {
            type: "string",
            description: "Optional exact tool name filter."
          },
          limit: {
            type: "number",
            description: "Maximum records to return. Default 10, maximum 50."
          }
        }
      }
    },
    invoke: async (args: Record<string, unknown>) => {
      const toolName = toOptionalNonEmptyString(args.tool_name);
      const limit = toBoundedInteger(
        args.limit,
        SESSION_CACHE_DEFAULT_LIST_LIMIT,
        1,
        SESSION_CACHE_MAX_LIST_LIMIT
      );
      const records = await input.context.toolDataStore!.listToolCalls({
        namespace: input.namespace,
        sessionId: input.sessionId!,
        toolName,
        limit
      });
      return {
        session_id: input.sessionId,
        namespace: input.namespace,
        matched: records.length,
        records: records.map((record) => ({
          record_id: record.id,
          tool_name: record.toolName,
          tool_call_id: record.toolCallId ?? null,
          created_at: record.createdAt,
          args: record.args,
          summary: record.summary ?? null,
          error: record.error ?? null
        }))
      };
    }
  };

  const getTool: RuntimeInternalTool = {
    definition: {
      name: SESSION_CACHE_GET_TOOL_NAME,
      description:
        "Retrieve a cached MCP tool result by record_id, with optional output_path like 'resources[0].name'.",
      inputSchema: {
        type: "object",
        properties: {
          record_id: {
            type: "string",
            description: "Record id returned by session_cache_list."
          },
          output_path: {
            type: "string",
            description: "Optional path into output JSON (e.g., resources[0].name)."
          }
        },
        required: ["record_id"]
      }
    },
    invoke: async (args: Record<string, unknown>) => {
      const recordId = toOptionalNonEmptyString(args.record_id);
      if (!recordId) {
        throw new Error("record_id is required for session_cache_get.");
      }

      const record = await input.context.toolDataStore!.getToolCall({
        namespace: input.namespace,
        sessionId: input.sessionId!,
        id: recordId
      });

      if (!record) {
        return {
          found: false,
          record_id: recordId,
          message: "No cached record found for this session."
        };
      }

      const outputPath = toOptionalNonEmptyString(args.output_path);
      const selectedOutput = outputPath ? getValueAtPath(record.output, outputPath) : record.output;
      return {
        found: selectedOutput !== undefined,
        record: {
          record_id: record.id,
          tool_name: record.toolName,
          tool_call_id: record.toolCallId ?? null,
          created_at: record.createdAt,
          args: record.args,
          summary: record.summary ?? null,
          error: record.error ?? null
        },
        output_path: outputPath ?? null,
        output: selectedOutput === undefined ? null : selectedOutput
      };
    }
  };

  return [listTool, getTool];
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

function estimateToolPromptCost(tool: ToolDefinition): number {
  try {
    return JSON.stringify({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }).length;
  } catch {
    return 1024;
  }
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
  const candidates =
    strongestScore >= STRONG_MATCH_SCORE
      ? ranked.filter((entry) => entry.score === strongestScore).slice(0, Math.min(MAX_TOOLS_WITH_MATCH, MAX_TOOL_COUNT))
      : ranked.filter((entry) => entry.score > 0).length > 0
        ? ranked.filter((entry) => entry.score > 0).slice(0, Math.min(MAX_TOOLS_WITH_MATCH, MAX_TOOL_COUNT))
        : ranked.slice(0, Math.min(MAX_TOOLS_NO_MATCH, MAX_TOOL_COUNT));

  const selected: ToolDefinition[] = [];
  let usedBudget = 0;
  for (const candidate of candidates) {
    const estimatedCost = estimateToolPromptCost(candidate.tool);
    if (selected.length > 0 && usedBudget + estimatedCost > MAX_TOOL_PROMPT_BUDGET_CHARS) {
      break;
    }
    selected.push(candidate.tool);
    usedBudget += estimatedCost;
  }

  if (selected.length > 0) {
    return selected;
  }

  return candidates.length > 0 ? [candidates[0].tool] : [];
}

function hasProvidedRequiredArg(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}

function validateRequiredToolArguments(schema: unknown, args: Record<string, unknown>): string[] {
  const schemaRecord = toRecord(schema);
  const required = Array.isArray(schemaRecord.required)
    ? schemaRecord.required
        .map((field) => String(field ?? "").trim())
        .filter((field) => field.length > 0)
    : [];

  if (!required.length) {
    return [];
  }

  return required.filter((field) => !hasProvidedRequiredArg(args[field]));
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
    const persistToolMessages = request.memory?.persistToolMessages === true;
    const toolOutputLimits = normalizeToolOutputLimits(request.toolOutputLimits);
    const sessionCacheTools = createSessionCacheTools({
      sessionId: request.sessionId,
      namespace: memoryNamespace,
      context
    });
    const sessionCacheToolNames = new Set(sessionCacheTools.map((tool) => tool.definition.name));
    const sessionCacheHint =
      sessionCacheTools.length > 0
        ? `\n\nSession cache tools are available for this session:\n- ${SESSION_CACHE_LIST_TOOL_NAME}: list cached prior MCP outputs\n- ${SESSION_CACHE_GET_TOOL_NAME}: fetch one cached output by record_id\nUse these tools first for follow-up questions to avoid repeating expensive MCP calls.`
        : "";

    let memoryMessages: ChatMessage[] = [];
    if (memoryEnabled && request.sessionId) {
      const loaded = await context.memoryStore!.loadMessages(memoryNamespace, request.sessionId);
      memoryMessages = normalizeStoredMessages(loaded, memoryMaxMessages, toolOutputLimits.messageMaxChars);
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: normalizeMessageContent(`${request.systemPrompt}${sessionCacheHint}`, MAX_SYSTEM_MESSAGE_CHARS)
      },
      ...memoryMessages,
      { role: "user", content: normalizeMessageContent(request.userPrompt, MAX_MESSAGE_CHARS) }
    ];
    const externalToolDefinitions = tools.tools;
    const internalToolDefinitions = sessionCacheTools.map((tool) => tool.definition);
    const allToolDefinitions = [...externalToolDefinitions, ...internalToolDefinitions];
    const toolDefinitionByName = new Map<string, ToolDefinition>(allToolDefinitions.map((tool) => [tool.name, tool]));
    const internalToolsByName = new Map<string, RuntimeInternalTool>(
      sessionCacheTools.map((tool) => [tool.definition.name, tool])
    );

    const normalizedExternalTools = normalizeToolsForModel(
      request.toolCallingEnabled ? externalToolDefinitions : [],
      request.userPrompt
    );
    const normalizedTools = request.toolCallingEnabled
      ? dedupeToolsByName([...internalToolDefinitions, ...normalizedExternalTools])
      : [];

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

    const LLM_RETRY_MAX = 2;
    const LLM_RETRY_BASE_DELAY_MS = 2000;
    const TOOL_DISABLE_THRESHOLD = 2;
    const disabledTools = new Set<string>();
    const toolFailureCounts = new Map<string, number>();

    try {
      for (let iteration = 1; iteration <= request.maxIterations; iteration += 1) {
        // --- LLM call with per-iteration retry ---
        let modelResponse: Awaited<ReturnType<typeof providerAdapter.generate>> | undefined;
        let llmError: Error | undefined;

        for (let llmAttempt = 0; llmAttempt <= LLM_RETRY_MAX; llmAttempt += 1) {
          try {
            // Filter out disabled tools for this iteration
            const activeTools = normalizedTools.filter(
              (tool) => !disabledTools.has(tool.name)
            );

            modelResponse = await providerAdapter.generate(
              {
                provider: request.provider,
                messages,
                tools: request.toolCallingEnabled ? activeTools : []
              },
              {
                resolveSecret: context.resolveSecret
              }
            );
            llmError = undefined;
            break;
          } catch (error) {
            llmError = error instanceof Error ? error : new Error(String(error));
            if (llmAttempt < LLM_RETRY_MAX) {
              const delay = LLM_RETRY_BASE_DELAY_MS * Math.pow(2, llmAttempt);
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
          }
        }

        if (!modelResponse) {
          // All LLM retries exhausted
          if (steps.length > 0 && lastAssistantMessage) {
            // We have a prior successful iteration — return gracefully
            const result: AgentRunState = {
              finalAnswer: lastAssistantMessage,
              stopReason: "error",
              iterations: iteration - 1,
              messages,
              steps
            };
            await persistConversation();
            return result;
          }
          // No prior success — re-throw
          throw llmError ?? new Error("LLM call failed after retries");
        }

        // --- Empty/garbage response handling ---
        const hasContent = modelResponse.content.trim().length > 0;
        const hasToolCalls = request.toolCallingEnabled && modelResponse.toolCalls.length > 0;

        if (!hasContent && !hasToolCalls) {
          // Empty response — prompt the model to try again instead of accepting garbage
          if (iteration < request.maxIterations) {
            messages.push({ role: "assistant", content: "" });
            messages.push({
              role: "user",
              content: normalizeMessageContent(
                "Your response was empty. Please provide a substantive answer or call a tool to help answer the question.",
                MAX_MESSAGE_CHARS
              )
            });
            steps.push({
              iteration,
              modelOutput: "",
              requestedTools: [],
              toolResults: []
            });
            continue;
          }
          // Last iteration — fall through to return what we have
        }

        lastAssistantMessage = modelResponse.content;
        const requestedTools = request.toolCallingEnabled ? modelResponse.toolCalls : [];

        if (requestedTools.length > 0) {
          messages.push({
            role: "assistant",
            content: normalizeMessageContent(modelResponse.content, MAX_MESSAGE_CHARS),
            toolCalls: requestedTools
          });

          const toolResults: InternalToolResult[] = [];
          let failedToolCount = 0;

          for (const call of requestedTools) {
            try {
              // --- Check if tool exists before invoking ---
              const toolDefinition = toolDefinitionByName.get(call.name);
              const internalTool = internalToolsByName.get(call.name);

              if (!toolDefinition && !internalTool) {
                // Tool doesn't exist — send error back so LLM can self-correct
                const availableToolNames = [...toolDefinitionByName.keys()]
                  .filter((name) => !disabledTools.has(name))
                  .slice(0, 20)
                  .join(", ");
                const errorMsg = `Tool '${call.name}' does not exist. Available tools: ${availableToolNames || "none"}`;
                toolResults.push({
                  toolCallId: call.id,
                  toolName: call.name,
                  output: null,
                  error: errorMsg
                });
                messages.push({
                  role: "tool",
                  content: serializeToolMessage(false, errorMsg, toolOutputLimits),
                  toolCallId: call.id,
                  name: call.name
                });
                failedToolCount += 1;
                continue;
              }

              // --- Check if tool is disabled ---
              if (disabledTools.has(call.name)) {
                const errorMsg = `Tool '${call.name}' has been disabled due to repeated failures.`;
                toolResults.push({
                  toolCallId: call.id,
                  toolName: call.name,
                  output: null,
                  error: errorMsg
                });
                messages.push({
                  role: "tool",
                  content: serializeToolMessage(false, errorMsg, toolOutputLimits),
                  toolCallId: call.id,
                  name: call.name
                });
                failedToolCount += 1;
                continue;
              }

              // --- Validate required args, but give the LLM a chance to self-correct ---
              const missingRequiredArgs = validateRequiredToolArguments(toolDefinition?.inputSchema, call.arguments);
              if (missingRequiredArgs.length > 0) {
                const providedKeys = Object.keys(call.arguments);
                const errorMsg =
                  `Tool call '${call.name}' is missing required arguments: ${missingRequiredArgs.join(", ")}.` +
                  (providedKeys.length ? ` Provided keys: ${providedKeys.join(", ")}.` : " No arguments were provided.") +
                  " Please call this tool again with all required fields.";

                toolResults.push({
                  toolCallId: call.id,
                  toolName: call.name,
                  output: null,
                  error: errorMsg
                });
                messages.push({
                  role: "tool",
                  content: serializeToolMessage(false, errorMsg, toolOutputLimits),
                  toolCallId: call.id,
                  name: call.name
                });

                // Track failure for potential disabling
                const priorFails = toolFailureCounts.get(call.name) ?? 0;
                toolFailureCounts.set(call.name, priorFails + 1);
                if (priorFails + 1 >= TOOL_DISABLE_THRESHOLD) {
                  disabledTools.add(call.name);
                }
                failedToolCount += 1;
                continue;
              }

              const output = internalTool
                ? await internalTool.invoke(call.arguments)
                : await tools.invokeTool(call.name, call.arguments);
              toolResults.push({
                toolCallId: call.id,
                toolName: call.name,
                output
              });

              // Reset failure count on success
              toolFailureCounts.delete(call.name);

              if (!sessionCacheToolNames.has(call.name) && context.toolDataStore && request.sessionId) {
                try {
                  await context.toolDataStore.saveToolCall({
                    namespace: memoryNamespace,
                    sessionId: request.sessionId,
                    toolName: call.name,
                    toolCallId: call.id,
                    args: call.arguments,
                    output,
                    summary: buildToolOutputSummary(call.arguments, output)
                  });
                } catch {
                  // Cache persistence must never break agent execution.
                }
              }

              messages.push({
                role: "tool",
                content: serializeToolMessage(true, output, toolOutputLimits),
                toolCallId: call.id,
                name: call.name
              });
            } catch (error) {
              const toolError = createToolErrorResult(call, error);
              toolResults.push(toolError);
              failedToolCount += 1;

              // Track failure for potential disabling
              const priorFails = toolFailureCounts.get(call.name) ?? 0;
              toolFailureCounts.set(call.name, priorFails + 1);
              if (priorFails + 1 >= TOOL_DISABLE_THRESHOLD) {
                disabledTools.add(call.name);
              }

              if (!sessionCacheToolNames.has(call.name) && context.toolDataStore && request.sessionId) {
                try {
                  await context.toolDataStore.saveToolCall({
                    namespace: memoryNamespace,
                    sessionId: request.sessionId,
                    toolName: call.name,
                    toolCallId: call.id,
                    args: call.arguments,
                    output: null,
                    error: toolError.error,
                    summary: buildToolOutputSummary(call.arguments, null, toolError.error)
                  });
                } catch {
                  // Cache persistence must never break agent execution.
                }
              }

              messages.push({
                role: "tool",
                content: serializeToolMessage(false, toolError.error, toolOutputLimits),
                toolCallId: call.id,
                name: call.name
              });
            }
          }

          // --- All tool calls failed hint ---
          if (failedToolCount > 0 && failedToolCount === requestedTools.length) {
            messages.push({
              role: "user",
              content: normalizeMessageContent(
                "All tool calls in this iteration failed. Please reconsider your approach, verify tool names and arguments, or provide a final answer without tools.",
                MAX_MESSAGE_CHARS
              )
            });
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
