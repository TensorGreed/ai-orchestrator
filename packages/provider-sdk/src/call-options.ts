import type { ProviderCallOptions } from "./types";

/**
 * 12.6b — which request parameters each built-in adapter honours. A caller that must not drop one silently (the
 * /v1 AI gateway) refuses a request that sets a parameter its provider does not honour.
 */
export interface ProviderCallOptionSupport {
  /** The adapter streams for real (`generateStream`); otherwise a stream is one buffered answer. */
  streaming: boolean;
  /** `stream_options.include_usage` is understood. */
  streamUsage: boolean;
  topP: boolean;
  stop: boolean;
  seed: boolean;
  penalties: boolean;
  /** `json_object` / `json_schema` answers. */
  responseFormat: boolean;
  /** `tool_choice` other than `auto`. */
  toolChoice: boolean;
  parallelToolCalls: boolean;
  user: boolean;
  /** Images in user messages (data URLs). */
  images: boolean;
  tools: boolean;
}

const OPENAI_FAMILY: ProviderCallOptionSupport = {
  streaming: true,
  streamUsage: true,
  topP: true,
  stop: true,
  seed: true,
  penalties: true,
  responseFormat: true,
  toolChoice: true,
  parallelToolCalls: true,
  user: true,
  images: true,
  tools: true
};

const SUPPORT: Readonly<Record<string, ProviderCallOptionSupport>> = Object.freeze({
  openai: OPENAI_FAMILY,
  openai_compatible: OPENAI_FAMILY,
  ollama: OPENAI_FAMILY,
  azure_openai: OPENAI_FAMILY,
  anthropic: {
    streaming: false,
    streamUsage: false,
    topP: true,
    stop: true,
    seed: false,
    penalties: false,
    responseFormat: false,
    toolChoice: true,
    parallelToolCalls: true,
    user: true,
    images: false,
    tools: true
  },
  gemini: {
    streaming: false,
    streamUsage: false,
    topP: true,
    stop: true,
    seed: true,
    penalties: true,
    responseFormat: true,
    toolChoice: true,
    parallelToolCalls: false,
    user: false,
    images: true,
    tools: true
  }
});

const NONE: ProviderCallOptionSupport = {
  streaming: false,
  streamUsage: false,
  topP: false,
  stop: false,
  seed: false,
  penalties: false,
  responseFormat: false,
  toolChoice: false,
  parallelToolCalls: false,
  user: false,
  images: false,
  tools: false
};

// The echo test provider accepts tools (and never calls one) and nothing else.
const ECHO: ProviderCallOptionSupport = { ...NONE, tools: true };

/** The OpenAI-family providers: their wire format is the chat-completions one. */
export const OPENAI_FAMILY_PROVIDER_IDS: ReadonlySet<string> = new Set(["openai", "openai_compatible", "ollama", "azure_openai"]);

/** What a provider honours; an adapter this table does not know (a community adapter) honours none of them. */
export function providerCallOptionSupport(providerId: string): ProviderCallOptionSupport {
  if (providerId === "echo") return ECHO;
  return SUPPORT[providerId] ?? NONE;
}

/**
 * The request parameters (OpenAI names) a provider would drop: the ones `options` sets that its adapter does not
 * honour. `user` is advisory and never listed; a `text` response format and an `auto` tool choice are the defaults.
 */
export function unsupportedCallOptions(
  providerId: string,
  options: ProviderCallOptions,
  request: { hasImages?: boolean; hasTools?: boolean } = {}
): string[] {
  const support = providerCallOptionSupport(providerId);
  const out: string[] = [];
  if (options.topP !== undefined && !support.topP) out.push("top_p");
  if (options.stop?.length && !support.stop) out.push("stop");
  if (options.seed !== undefined && !support.seed) out.push("seed");
  if (options.presencePenalty !== undefined && !support.penalties) out.push("presence_penalty");
  if (options.frequencyPenalty !== undefined && !support.penalties) out.push("frequency_penalty");
  if (options.responseFormat && options.responseFormat.type !== "text" && !support.responseFormat) out.push("response_format");
  if (options.toolChoice && options.toolChoice !== "auto" && !support.toolChoice) out.push("tool_choice");
  if (options.parallelToolCalls !== undefined && !support.parallelToolCalls) out.push("parallel_tool_calls");
  if (request.hasImages && !support.images) out.push("image_url");
  if (request.hasTools && !support.tools) out.push("tools");
  return out;
}
