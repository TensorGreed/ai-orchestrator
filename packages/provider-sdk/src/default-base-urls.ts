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
