import type { AgentRunRequest, AgentRunState, ChatMessage, DataLabels, NodeActivity, ToolCall, ToolDefinition } from "@ai-orchestrator/shared";
import type { ProviderExecutionContext, ProviderRegistry } from "@ai-orchestrator/provider-sdk";

export interface AgentToolRuntime {
  tools: ToolDefinition[];
  /**
   * `invocation` (Phase 16): `labels` is what the agent's model context holds
   * at the call (a delegated worker starts from them); `toolCallId` names the
   * call, so `resultLabels` can tell two calls of one tool apart.
   */
  invokeTool: (toolName: string, args: Record<string, unknown>, invocation?: { labels?: DataLabels; toolCallId?: string }) => Promise<unknown>;
  /**
   * Phase 16 — the labels of this call's result (a worker's labels).
   * Undefined: the result came from outside, `untrusted_external`.
   */
  resultLabels?: (toolName: string, toolCallId?: string) => DataLabels | undefined;
  /**
   * Phase 10.2 — explains why a requested tool is not in `tools` (for
   * example, an MCP tool policy hid it). The text becomes the tool error the
   * model sees instead of the generic "does not exist" message.
   */
  describeUnavailableTool?: (toolName: string) => string | undefined;
}

/** What the loop reports while it runs: model calls, retries, steps and tool calls. */
export type AgentRuntimeEvent =
  | Extract<NodeActivity, { kind: "llm_call" | "agent_step" | "tool_call" }>
  | (Extract<NodeActivity, { kind: "retry" }> & { scope: "agent_llm" });

export interface AgentRuntimeContext {
  providerRegistry: ProviderRegistry;
  resolveSecret: (secretRef?: { secretId: string }) => Promise<string | undefined>;
  /** Phase 15.3 — the node running the agent; each model call adds its iteration (the model tape's call site). */
  callSite?: { nodeId?: string };
  memoryStore?: AgentSessionMemoryStore;
  toolDataStore?: AgentSessionToolDataStore;
  /** Phase 12.1 — guard hooks run inside the loop when the agent is guarded. */
  guard?: AgentGuardHooks;
  /**
   * Phase 16 — data labels. `input`: everything the agent node read except
   * its user prompt; `prompt`: what the user prompt read (a guard rewrite of
   * the prompt declassifies these alone). The loop accumulates what its
   * model context holds (memory, each tool result) and returns it on the run
   * state. `persist`: the run tracks labels — memory labels are read, and
   * labels are written with session memory and the tool cache. `scan`: finds
   * data classes in tool results (tracked runs only).
   */
  dataLabels?: { input: DataLabels; prompt?: DataLabels; persist: boolean; scan?: (value: unknown) => string[] };
  /**
   * The run's abort signal. It is passed to every model call and ends retry
   * waits early; once it aborts, `run()` throws instead of returning an
   * `error` stop reason, so the caller can tell a stop or a timeout apart
   * from a model failure.
   */
  signal?: AbortSignal;
  /** Called before each provider retry backoff wait. */
  onProviderRetry?: ProviderExecutionContext["onRetry"];
  /** Fire-and-forget progress events; a throwing listener never affects the run. */
  onEvent?: (event: AgentRuntimeEvent) => void;
}

/**
 * Phase 12.1 — the narrow hook interface the agent loop calls at each trust
 * boundary. The runtime knows nothing about detectors or profiles: the
 * caller (the workflow engine) evaluates the content and answers with a
 * decision. Hook points:
 * - `prompt`: before each model call, for user input added since the last call;
 * - `tool_arguments`: before each external tool call, with the tool's schema;
 * - `tool_result`: after each external tool result, before the model sees it
 *   (labelled `untrusted_external`; `spotlight` then marks the text);
 * - `final_output`: before the final answer is returned.
 */
export type AgentGuardChannel = "prompt" | "tool_arguments" | "tool_result" | "final_output";
export type AgentGuardLabel = "trusted" | "user" | "untrusted_external" | "sensitive";

export interface AgentGuardCheck {
  channel: AgentGuardChannel;
  content: unknown;
  /** The checkpoint's fixed labels (a prompt is user input, a tool result is external). */
  labels: AgentGuardLabel[];
  /** Phase 16 — the propagated labels of this content, when the caller tracks them; profiles that ask for them use these instead. */
  dataLabels?: DataLabels;
  iteration: number;
  tool?: { name: string; inputSchema?: Record<string, unknown>; toolCallId?: string };
}

export type AgentGuardDecision =
  | { outcome: "allow" }
  /** Content was redacted, masked, protected or transformed: continue with this instead. */
  | { outcome: "rewrite"; content: unknown; declassified?: string[] }
  /** Tool calls become tool errors, tool results become a notice, prompts and final answers stop the node. */
  | { outcome: "block"; message: string }
  /** A person must decide: the node pauses through the approval hand-off. */
  | { outcome: "pause"; message: string };

export interface AgentGuardHooks {
  /** Text placed at the start of the system prompt: hardening, spotlighting instructions, a canary line. */
  systemPromptAddition?(): string | undefined;
  check(input: AgentGuardCheck): Promise<AgentGuardDecision>;
  /** Mark a serialized untrusted tool result before the model sees it. */
  spotlight?(text: string, context: { toolName: string; iteration: number }): string;
}

/**
 * Thrown out of `run()` when a guard decision stops the agent: a block on the
 * prompt or the final answer, or a pause for approval on any channel. Unlike
 * other failures it is not turned into an `error` stop reason.
 */
export class AgentGuardInterrupt extends Error {
  readonly reason: "blocked" | "approval_required";
  readonly channel: AgentGuardChannel;
  readonly iteration: number;
  constructor(reason: "blocked" | "approval_required", channel: AgentGuardChannel, iteration: number, message: string) {
    super(message);
    this.name = "AgentGuardInterrupt";
    this.reason = reason;
    this.channel = channel;
    this.iteration = iteration;
  }
}

export function isAgentGuardInterrupt(error: unknown): error is AgentGuardInterrupt {
  return error instanceof AgentGuardInterrupt || (error instanceof Error && error.name === "AgentGuardInterrupt" && "reason" in error);
}

export interface AgentRuntimeAdapter {
  id: string;
  run(request: AgentRunRequest, tools: AgentToolRuntime, context: AgentRuntimeContext): Promise<AgentRunState>;
}

export interface InternalToolResult {
  toolCallId: string;
  toolName: string;
  output: unknown;
  error?: string;
  startedAt?: string;
  durationMs?: number;
}

export interface AgentSessionMemoryStore {
  loadMessages(namespace: string, sessionId: string): Promise<ChatMessage[]>;
  /** `options.labels` (Phase 16): stored with the messages; given only while the run tracks labels. */
  saveMessages(namespace: string, sessionId: string, messages: ChatMessage[], options?: { labels?: DataLabels }): Promise<void>;
  /** Phase 16 — the labels stored with this memory; null when none were recorded (older rows). */
  loadLabels?(namespace: string, sessionId: string): Promise<DataLabels | null>;
}

export interface AgentSessionToolRecord {
  id: string;
  namespace: string;
  sessionId: string;
  toolName: string;
  toolCallId?: string;
  args: Record<string, unknown>;
  output: unknown;
  error?: string;
  summary?: unknown;
  /** Phase 16 — labels of the cached result; absent on rows written while labels were not tracked. */
  labels?: DataLabels | null;
  createdAt: string;
}

export interface AgentSessionToolDataStore {
  saveToolCall(input: {
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    output: unknown;
    error?: string;
    summary?: unknown;
    /** Phase 16 — given only while the run tracks labels. */
    labels?: DataLabels;
  }): Promise<AgentSessionToolRecord>;
  listToolCalls(input: {
    namespace: string;
    sessionId: string;
    toolName?: string;
    limit?: number;
  }): Promise<Array<Omit<AgentSessionToolRecord, "output">>>;
  getToolCall(input: {
    namespace: string;
    sessionId: string;
    id: string;
  }): Promise<AgentSessionToolRecord | null>;
}

export function createToolErrorResult(call: ToolCall, error: unknown): InternalToolResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    output: null,
    error: error instanceof Error ? error.message : typeof error === "string" && error ? error : "Tool call failed"
  };
}
