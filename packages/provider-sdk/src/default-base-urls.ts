import { destinationHostOfUrl, networkDestinationRef, type DestinationRef } from "@ai-orchestrator/shared";

/**
 * Phase 16 — the base URL each built-in provider adapter calls when a node
 * sets none. The adapters read these, and data destinations use their hosts
 * (shared `BUILTIN_DESTINATIONS` lists them as vendor). Azure OpenAI and the
 * OpenAI-compatible adapter have no default: they always need an endpoint.
 */
export const PROVIDER_DEFAULT_BASE_URLS: Readonly<Record<string, string>> = Object.freeze({
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  ollama: "http://localhost:11434/v1"
});

/** The base URL an adapter uses when the node sets none (Ollama honours OLLAMA_BASE_URL), or undefined when it has no default. */
export function providerDefaultBaseUrl(providerId: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (providerId === "ollama" && env.OLLAMA_BASE_URL) return env.OLLAMA_BASE_URL;
  return PROVIDER_DEFAULT_BASE_URLS[providerId];
}

/** Providers that send nothing over the network (the echo test provider): they are no destination. */
export const PROVIDERS_WITHOUT_NETWORK: ReadonlySet<string> = new Set(["echo"]);

/** Providers whose adapter always calls its default host and ignores a node's base URL. */
export const PROVIDERS_WITH_FIXED_HOST: ReadonlySet<string> = new Set(["gemini"]);

/** A URL's host, or undefined for a value that is not a plain URL (templated, malformed). */
function hostOfSetting(value: string): string | undefined {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.includes("{{")) return undefined;
  return destinationHostOfUrl(value);
}

function setting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Phase 16 — where a provider call goes: `null` for a provider that sends
 * nothing over the network, otherwise the host of the effective base URL (the
 * node's, else the adapter's default). Undefined when a base URL is set but
 * cannot be read (a template): the real host is unknown, so the default is
 * never assumed; callers turn undefined into an unknown host with shared
 * `networkDestinationRef`, which resolves as public.
 */
export function providerDestinationHost(
  providerId: string,
  provider: { baseUrl?: unknown; extra?: unknown },
  env: Record<string, string | undefined> = process.env
): string | undefined | null {
  if (PROVIDERS_WITHOUT_NETWORK.has(providerId)) return null;
  const fixed = PROVIDERS_WITH_FIXED_HOST.has(providerId) ? providerDefaultBaseUrl(providerId, env) : undefined;
  if (fixed) return hostOfSetting(fixed);
  const extra = provider.extra && typeof provider.extra === "object" && !Array.isArray(provider.extra) ? (provider.extra as Record<string, unknown>) : {};
  const configured = setting(provider.baseUrl) ?? (providerId === "azure_openai" ? setting(extra.endpoint) ?? setting(env.AZURE_OPENAI_ENDPOINT) : undefined);
  if (configured !== undefined) return hostOfSetting(configured);
  const fallback = providerDefaultBaseUrl(providerId, env);
  return fallback ? hostOfSetting(fallback) : undefined;
}

/** Phase 16 — the destination of a call to this provider, or null when it sends nothing over the network. */
export function providerDestinationRef(
  provider: { providerId: string; baseUrl?: unknown; extra?: unknown },
  env: Record<string, string | undefined> = process.env
): DestinationRef | null {
  const providerId = String(provider.providerId);
  const host = providerDestinationHost(providerId, provider, env);
  if (host === null) return null;
  return networkDestinationRef("model_provider", providerId, host);
}
