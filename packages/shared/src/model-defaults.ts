/**
 * The model a new model node starts on. A deployment with a model key (an API server env var, or a saved secret for a
 * hosted provider) gets that provider; anything else gets the built-in Echo provider, which needs no key, no network
 * and no local model server, so a new workflow runs on the first try. A local Ollama is never picked on its own: its
 * base URL is set in most installs by default, so it says nothing about whether a model server is really there.
 */

/** A provider config a node can store in `config.provider`. */
export interface DefaultModelProvider {
  providerId: string;
  model: string;
  secretRef?: { secretId: string };
}

/** The built-in, keyless demo provider. */
export const ECHO_MODEL_PROVIDER: Readonly<DefaultModelProvider> = Object.freeze({ providerId: "echo", model: "echo" });

/** The providers a model node's Provider picker offers, in order. Echo comes first: it always works. */
export const MODEL_PROVIDER_CHOICES: ReadonlyArray<{ value: string; label: string }> = Object.freeze([
  { value: "echo", label: "Echo (built-in demo, no key)" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Gemini" },
  { value: "azure_openai", label: "Azure OpenAI" },
  { value: "openai_compatible", label: "OpenAI Compatible" },
  { value: "ollama", label: "Ollama" }
]);

/**
 * Node types whose model lives in `config.provider` (the LLM Call node and the AI chain nodes). The dedicated chat
 * model nodes (OpenAI Chat Model and the rest) name their provider in their type and are not in this set.
 */
export const PROVIDER_CONFIG_NODE_TYPES: ReadonlySet<string> = new Set([
  "llm_call",
  "basic_llm_chain",
  "qa_chain",
  "summarization_chain",
  "information_extractor",
  "text_classifier",
  "sentiment_analysis",
  "ai_transform"
]);

/**
 * Node types a NEW node of which starts on the default model. Only LLM Call: the chain nodes start without a provider
 * on purpose, so they use the model of an upstream model node (the engine reads `config.provider` first).
 */
export const DEFAULT_MODEL_NODE_TYPES: ReadonlySet<string> = new Set(["llm_call"]);

/** Hosted providers a key makes usable, in the order a default is picked, with the model a new node starts on. */
export const HOSTED_MODEL_DEFAULTS: ReadonlyArray<{ providerId: string; model: string; envVar: string }> = Object.freeze([
  { providerId: "openai", model: "gpt-4o-mini", envVar: "OPENAI_API_KEY" },
  { providerId: "anthropic", model: "claude-sonnet-5-5", envVar: "ANTHROPIC_API_KEY" },
  { providerId: "gemini", model: "gemini-2.5-flash", envVar: "GEMINI_API_KEY" }
]);

/** The hosted providers whose API key the server's environment sets (by provider id). */
export function envModelProviders(env: Record<string, string | undefined>): string[] {
  return HOSTED_MODEL_DEFAULTS.filter((entry) => typeof env[entry.envVar] === "string" && env[entry.envVar]!.trim().length > 0).map(
    (entry) => entry.providerId
  );
}

/**
 * The provider a new model node starts on: a hosted provider whose key the server's environment sets, else one the
 * user has saved a secret for (that secret is referenced), else Echo. Secrets are tried in the order given.
 */
export function pickDefaultModelProvider(input: {
  envProviders?: readonly string[];
  secrets?: ReadonlyArray<{ id: string; provider: string }>;
}): DefaultModelProvider {
  const fromEnv = new Set(input.envProviders ?? []);
  for (const entry of HOSTED_MODEL_DEFAULTS) {
    if (fromEnv.has(entry.providerId)) return { providerId: entry.providerId, model: entry.model };
  }
  for (const entry of HOSTED_MODEL_DEFAULTS) {
    const secret = (input.secrets ?? []).find((candidate) => candidate.provider.trim().toLowerCase() === entry.providerId);
    if (secret) return { providerId: entry.providerId, model: entry.model, secretRef: { secretId: secret.id } };
  }
  return { ...ECHO_MODEL_PROVIDER };
}

/**
 * A NEW node's config with the default model in place of the catalog's sample one, for LLM Call
 * (`DEFAULT_MODEL_NODE_TYPES`). Only for nodes being created: a saved node keeps the provider it has.
 */
export function withDefaultModelProvider(
  nodeType: string,
  config: Record<string, unknown>,
  provider: DefaultModelProvider
): Record<string, unknown> {
  if (!DEFAULT_MODEL_NODE_TYPES.has(nodeType)) return config;
  return { ...config, provider: { ...provider, ...(provider.secretRef ? { secretRef: { ...provider.secretRef } } : {}) } };
}
