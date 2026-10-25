import type { MCPExecutionContext, MCPRegistry, McpServerRequestOrigin, McpToolAccessSubjectTool } from "@ai-orchestrator/mcp-sdk";
import { promptMessagesToText, requestedSamplingModels } from "@ai-orchestrator/mcp-sdk";
import type { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type {
  ChatMessage,
  ChatMessageImage,
  LLMProviderConfig,
  LLMUsage,
  MCPServerConfig,
  McpElicitationRequest,
  McpElicitationResult,
  McpElicitationTraceEntry,
  McpResourceReadResult,
  McpSamplingRequest,
  McpSamplingResult,
  McpSamplingSettings,
  McpSamplingTraceEntry,
  McpServerPromptBinding,
  SecretReference
} from "@ai-orchestrator/shared";
import { DEFAULT_MCP_SAMPLING_SETTINGS } from "@ai-orchestrator/shared";

/**
 * Phase 10.5 — engine-side pieces of MCP resources, prompts, elicitation
 * and sampling: the sampling handler that fulfils `sampling/createMessage`
 * with a chat model under the server's limits and the tool policy, the
 * elicitation handler that records every request on the node trace, server
 * prompts resolved into node prompts, and resource reads.
 */

const MAX_TRACE_TEXT_CHARS = 2000;
/** Entries kept per node output for `_mcpSampling` and `_mcpElicitations`. */
const MAX_TRACE_ENTRIES = 50;

function truncate(text: string, max = MAX_TRACE_TEXT_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class McpSamplingRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSamplingRefusedError";
  }
}

export type McpPolicyEvaluator = (subject: McpToolAccessSubjectTool) => { allowed: boolean; message?: string };

export interface McpSamplingHandlerOptions {
  providerRegistry: ProviderRegistry;
  resolveSecret: (secretRef?: SecretReference) => Promise<string | undefined>;
  /** The attached chat model; absent for direct MCP Tool nodes and gateway calls. */
  provider?: LLMProviderConfig;
  /** The server configs in play, so each request finds its server's sampling settings. */
  serverConfigs: MCPServerConfig[];
  /** Tool policy for kind `sampling`; absent means no rules apply. */
  evaluatePolicy?: McpPolicyEvaluator;
  /** Receives every request's outcome; the node output keeps them under `_mcpSampling`. */
  trace: McpSamplingTraceEntry[];
  signal?: AbortSignal;
  /** Phase 15.3 — the node whose MCP call asked for the sample (the model tape's call site). */
  nodeId?: string;
  /**
   * Phase 16 — destination rules on the sampling request before it is sent:
   * returns the messages to send (rewritten or as they were); throwing
   * refuses the request.
   */
  checkModelCall?: McpSamplingCheck;
}

/** Phase 16 — judges a sampling request's messages against the provider that would answer it. */
export type McpSamplingCheck = (provider: LLMProviderConfig, messages: ChatMessage[]) => Promise<ChatMessage[]>;

export interface McpSamplingHandler {
  onSampling: NonNullable<MCPExecutionContext["onSampling"]>;
  /** Resets the per-call request budget for a tool; the agent loop calls it before each tool call. */
  beginCall: (toolName: string) => void;
  /** Tokens the model used answering sampling requests so far. */
  usage: () => LLMUsage;
  requestCount: () => number;
}

function findServerConfig(configs: MCPServerConfig[], origin: McpServerRequestOrigin): MCPServerConfig | undefined {
  if (origin.registryServerId) {
    const byRegistry = configs.find((config) => config.registryServerId === origin.registryServerId);
    if (byRegistry) return byRegistry;
  }
  return configs.find((config) => config.serverId === origin.serverId && !config.registryServerId) ?? configs.find((config) => config.serverId === origin.serverId);
}

/** The settings a server's sampling requests run under; inline servers have none, so sampling is off. */
export function samplingSettingsFor(config: MCPServerConfig | undefined): McpSamplingSettings {
  return { ...DEFAULT_MCP_SAMPLING_SETTINGS, ...(config?.sampling ?? {}) };
}

/**
 * Pick the model for a sampling request: the first hinted model that is in
 * the server's allowed list (on the attached model's provider), otherwise the
 * attached model itself. Hints outside the list are ignored, never honoured.
 */
export function chooseSamplingModel(
  provider: LLMProviderConfig,
  settings: McpSamplingSettings,
  requested: string[]
): { model: string; honouredHint: boolean } {
  const allowed = new Set(settings.allowedModels.map((model) => model.trim()).filter(Boolean));
  for (const hint of requested) {
    if (allowed.has(hint)) return { model: hint, honouredHint: true };
    // A hint can name a model family ("claude-3") that an allowed model matches.
    const match = [...allowed].find((model) => model.includes(hint) || hint.includes(model));
    if (match) return { model: match, honouredHint: true };
  }
  return { model: provider.model, honouredHint: false };
}

function toChatMessages(request: McpSamplingRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (request.systemPrompt) messages.push({ role: "system", content: request.systemPrompt });
  for (const message of request.messages) {
    if (message.content.type === "text") {
      messages.push({ role: message.role, content: message.content.text });
    } else if (message.content.type === "image") {
      const image: ChatMessageImage = { data: message.content.data, mimeType: message.content.mimeType };
      messages.push({ role: message.role, content: "", images: [image] });
    } else {
      messages.push({ role: message.role, content: `[audio ${message.content.mimeType}]` });
    }
  }
  return messages;
}

function describePrompt(request: McpSamplingRequest): string {
  const text = request.messages
    .map((message) => `${message.role}: ${message.content.type === "text" ? message.content.text : `[${message.content.type}]`}`)
    .join("\n");
  return truncate(request.systemPrompt ? `system: ${request.systemPrompt}\n${text}` : text);
}

function addUsage(total: LLMUsage, usage: LLMUsage | undefined): LLMUsage {
  if (!usage) return total;
  return {
    inputTokens: (total.inputTokens ?? 0) + (usage.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (usage.outputTokens ?? 0),
    totalTokens: (total.totalTokens ?? 0) + (usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
    cachedInputTokens: (total.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0)
  };
}

/**
 * Build the `sampling/createMessage` handler for one node (or one gateway
 * session). Every request is checked against the server's `allowSampling`,
 * its per-call budget and the tool policy (kind `sampling`, matched on the
 * model name), then answered by the chat model with `maxTokens` clamped to
 * the server's limit. Refusals go back to the server as JSON-RPC errors and
 * every outcome lands on the trace.
 */
export function createMcpSamplingHandler(options: McpSamplingHandlerOptions): McpSamplingHandler {
  const budget = new Map<string, number>();
  const callSequence = new Map<string, number>();
  let usage: LLMUsage = {};
  let requests = 0;

  const record = (entry: McpSamplingTraceEntry) => {
    options.trace.push(entry);
    if (options.trace.length > MAX_TRACE_ENTRIES) options.trace.shift();
  };

  const onSampling: McpSamplingHandler["onSampling"] = async (request, origin) => {
    const startedAt = nowIso();
    const started = Date.now();
    const serverConfig = findServerConfig(options.serverConfigs, origin);
    const settings = samplingSettingsFor(serverConfig);
    const requested = requestedSamplingModels(request);
    const toolName = origin.toolName ?? "(unknown tool)";
    const base = {
      toolName,
      call: callSequence.get(toolName) ?? 1,
      serverId: origin.serverId,
      ...(origin.registryServerId ? { registryServerId: origin.registryServerId } : {}),
      requestedModels: requested,
      prompt: describePrompt(request),
      maxTokens: Math.min(request.maxTokens, settings.maxTokens),
      at: startedAt
    };
    const refuse = (message: string): never => {
      record({ ...base, model: null, ok: false, error: message, durationMs: Date.now() - started });
      throw new McpSamplingRefusedError(message);
    };

    if (!settings.allow) {
      refuse(
        serverConfig?.registryServerId
          ? `Sampling is off for MCP server '${serverConfig.label ?? serverConfig.registryServerId}'. An admin can enable it on the MCP servers page.`
          : "Sampling is only available for servers in the MCP server registry with sampling enabled."
      );
    }
    const provider: LLMProviderConfig | undefined =
      options.provider ??
      (settings.defaultModel
        ? { providerId: settings.defaultModel.providerId as LLMProviderConfig["providerId"], model: settings.defaultModel.model }
        : undefined);
    if (!provider) {
      refuse("Sampling is not available for this call: no chat model is attached and the server has no default sampling model.");
    }
    const used = budget.get(toolName) ?? 0;
    if (used >= settings.maxRequestsPerCall) {
      refuse(`Sampling budget exhausted: at most ${settings.maxRequestsPerCall} request(s) per tool call for this server.`);
    }
    budget.set(toolName, used + 1);

    const chosen = chooseSamplingModel(provider!, settings, requested);
    if (options.evaluatePolicy) {
      const decision = options.evaluatePolicy({
        adapterId: origin.serverId,
        ...(origin.registryServerId ? { registryServerId: origin.registryServerId } : {}),
        toolName: chosen.model,
        kind: "sampling"
      });
      if (!decision.allowed) refuse(decision.message ?? `Sampling with model '${chosen.model}' is blocked by policy.`);
    }
    if (options.signal?.aborted) refuse("Workflow execution canceled.");

    const samplingProvider: LLMProviderConfig = {
      ...provider!,
      model: chosen.model,
      maxTokens: base.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {})
    };
    let messages = toChatMessages(request);
    if (options.checkModelCall) {
      try {
        messages = await options.checkModelCall(samplingProvider, messages);
      } catch (error) {
        refuse(`The sampling request was not sent: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      const adapter = options.providerRegistry.get(samplingProvider.providerId);
      const response = await adapter.generate(
        { provider: samplingProvider, messages },
        { resolveSecret: options.resolveSecret, ...(options.signal ? { signal: options.signal } : {}), ...(options.nodeId ? { callSite: { nodeId: options.nodeId } } : {}) }
      );
      requests += 1;
      usage = addUsage(usage, response.usage);
      const text = response.content ?? "";
      const stoppedByLimit = Boolean(response.usage?.outputTokens && response.usage.outputTokens >= base.maxTokens);
      record({
        ...base,
        model: chosen.model,
        providerId: samplingProvider.providerId,
        ok: true,
        response: truncate(text),
        ...(response.usage?.inputTokens !== undefined ? { inputTokens: response.usage.inputTokens } : {}),
        ...(response.usage?.outputTokens !== undefined ? { outputTokens: response.usage.outputTokens } : {}),
        durationMs: Date.now() - started
      });
      const result: McpSamplingResult = {
        role: "assistant",
        content: { type: "text", text },
        model: chosen.model,
        stopReason: stoppedByLimit ? "maxTokens" : "endTurn"
      };
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record({ ...base, model: chosen.model, providerId: samplingProvider.providerId, ok: false, error: truncate(message, 500), durationMs: Date.now() - started });
      throw new McpSamplingRefusedError(`The sampling model call failed: ${truncate(message, 500)}`);
    }
  };

  return {
    onSampling,
    beginCall: (toolName) => {
      budget.delete(toolName);
      callSequence.set(toolName, (callSequence.get(toolName) ?? 0) + 1);
    },
    usage: () => usage,
    requestCount: () => requests
  };
}

export interface McpElicitationHandlerOptions {
  nodeId: string;
  /** The run's elicitation sink (the API pauses the run and asks a person); absent means every request is declined. */
  onElicitation?: (
    request: McpElicitationRequest & { nodeId: string; serverId: string; registryServerId?: string; toolName: string }
  ) => Promise<McpElicitationResult & { source?: McpElicitationTraceEntry["source"]; note?: string; id?: string }>;
  trace: McpElicitationTraceEntry[];
}

/** Build the `elicitation/create` handler for one node; every request lands on `_mcpElicitations`. */
export function createMcpElicitationHandler(options: McpElicitationHandlerOptions): NonNullable<MCPExecutionContext["onElicitation"]> {
  return async (request, origin) => {
    const at = nowIso();
    const toolName = origin.toolName ?? "(unknown tool)";
    const base = {
      toolName,
      serverId: origin.serverId,
      ...(origin.registryServerId ? { registryServerId: origin.registryServerId } : {}),
      message: request.message,
      requestedSchema: request.requestedSchema,
      at
    };
    const record = (entry: McpElicitationTraceEntry) => {
      options.trace.push(entry);
      if (options.trace.length > MAX_TRACE_ENTRIES) options.trace.shift();
    };
    if (!options.onElicitation) {
      record({ ...base, action: "decline", source: "unavailable", note: "No one can answer elicitation requests in this runtime; declined.", settledAt: nowIso() });
      return { action: "decline" };
    }
    const answer = await options.onElicitation({
      ...request,
      nodeId: options.nodeId,
      serverId: origin.serverId,
      ...(origin.registryServerId ? { registryServerId: origin.registryServerId } : {}),
      toolName
    });
    record({
      ...(answer.id ? { id: answer.id } : {}),
      ...base,
      action: answer.action,
      source: answer.source ?? "user",
      ...(answer.note ? { note: answer.note } : {}),
      settledAt: nowIso()
    });
    return { action: answer.action, ...(answer.action === "accept" ? { content: answer.content ?? {} } : {}) };
  };
}

// Server prompts ------------------------------------------------------------

export interface ResolvedServerPrompt {
  binding: McpServerPromptBinding;
  target: "system" | "user";
  text: string;
  description?: string;
  messageCount: number;
}

/** What a node output records about the server prompt it used (`_serverPrompt`). */
export interface ServerPromptTrace {
  registryServerId: string;
  name: string;
  target: "system" | "user";
  arguments: Record<string, string>;
  chars: number;
  messageCount: number;
}

export function readServerPromptBinding(value: unknown): McpServerPromptBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const registryServerId = typeof record.registryServerId === "string" ? record.registryServerId.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!registryServerId || !name) return undefined;
  const args: Record<string, string> = {};
  if (record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)) {
    for (const [key, entry] of Object.entries(record.arguments as Record<string, unknown>)) {
      if (typeof entry === "string") args[key] = entry;
      else if (entry !== undefined && entry !== null) args[key] = String(entry);
    }
  }
  return { registryServerId, name, arguments: args, target: record.target === "user" ? "user" : "system" };
}

/**
 * Fetch a server prompt with `prompts/get`, after rendering its argument
 * templates and checking the tool policy (kind `prompt`). Returns the text
 * to use as the node's system or user prompt.
 */
export async function resolveServerPrompt(input: {
  binding: McpServerPromptBinding;
  renderArgument: (template: string) => string;
  serverConfig: MCPServerConfig;
  registry: MCPRegistry;
  context: MCPExecutionContext;
  evaluatePolicy?: McpPolicyEvaluator;
}): Promise<ResolvedServerPrompt> {
  const { binding, serverConfig } = input;
  if (input.evaluatePolicy) {
    const decision = input.evaluatePolicy({
      adapterId: serverConfig.serverId,
      registryServerId: binding.registryServerId,
      toolName: binding.name,
      kind: "prompt"
    });
    if (!decision.allowed) throw new Error(decision.message ?? `MCP prompt '${binding.name}' is blocked by policy.`);
  }
  const adapter = input.registry.get(serverConfig.serverId);
  if (!adapter.getPrompt) {
    throw new Error(`MCP adapter '${serverConfig.serverId}' does not support prompts.`);
  }
  const args: Record<string, string> = {};
  for (const [key, template] of Object.entries(binding.arguments ?? {})) args[key] = input.renderArgument(template);
  const result = await adapter.getPrompt(binding.name, args, serverConfig, input.context);
  const text = promptMessagesToText(result.messages);
  if (!text.trim()) {
    throw new Error(`MCP prompt '${binding.name}' on server '${serverConfig.label ?? binding.registryServerId}' returned no text.`);
  }
  return {
    binding: { ...binding, arguments: args },
    target: binding.target ?? "system",
    text,
    ...(result.description ? { description: result.description } : {}),
    messageCount: result.messages.length
  };
}

export function serverPromptTrace(resolved: ResolvedServerPrompt): ServerPromptTrace {
  return {
    registryServerId: resolved.binding.registryServerId,
    name: resolved.binding.name,
    target: resolved.target,
    arguments: resolved.binding.arguments ?? {},
    chars: resolved.text.length,
    messageCount: resolved.messageCount
  };
}

// Resources -----------------------------------------------------------------

/** The output of an MCP Tool node in `read_resource` mode. */
export interface ResourceReadOutput {
  invocation_request: { server_id: string; registry_server_id?: string; operation: "read_resource"; uri: string };
  uri: string;
  resource: { uri: string; mimeType?: string; text?: string; blob?: string; bytes: number };
  contents: McpResourceReadResult["contents"];
  /** Every text content item joined, for templates ({{results.<node>.text}}). */
  text: string;
}

export async function readMcpResource(input: {
  uri: string;
  serverConfig: MCPServerConfig;
  registry: MCPRegistry;
  context: MCPExecutionContext;
  maxBytes?: number;
  evaluatePolicy?: McpPolicyEvaluator;
}): Promise<ResourceReadOutput> {
  const { serverConfig } = input;
  if (input.evaluatePolicy) {
    const decision = input.evaluatePolicy({
      adapterId: serverConfig.serverId,
      ...(serverConfig.registryServerId ? { registryServerId: serverConfig.registryServerId } : {}),
      toolName: input.uri,
      kind: "resource"
    });
    if (!decision.allowed) throw new Error(decision.message ?? `MCP resource '${input.uri}' is blocked by policy.`);
  }
  const adapter = input.registry.get(serverConfig.serverId);
  if (!adapter.readResource) throw new Error(`MCP adapter '${serverConfig.serverId}' does not support resources.`);
  const result = await adapter.readResource(input.uri, serverConfig, input.context, input.maxBytes ? { maxBytes: input.maxBytes } : undefined);
  const first = result.contents[0];
  const text = result.contents.map((content) => ("text" in content ? content.text : "")).filter(Boolean).join("\n");
  return {
    invocation_request: {
      server_id: serverConfig.serverId,
      ...(serverConfig.registryServerId ? { registry_server_id: serverConfig.registryServerId } : {}),
      operation: "read_resource",
      uri: input.uri
    },
    uri: input.uri,
    resource: {
      uri: first?.uri ?? input.uri,
      ...(first?.mimeType ? { mimeType: first.mimeType } : {}),
      ...(first && "text" in first ? { text: first.text } : {}),
      ...(first && "blob" in first ? { blob: first.blob } : {}),
      bytes: result.bytes
    },
    contents: result.contents,
    text
  };
}
