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

/** The origin (scheme, host, port) of a URL, lower-cased with the default port dropped, or undefined if it cannot be read. */
function originOf(value: string | undefined): string | undefined {
  if (!value || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

/** A URL as origin plus path (no query, fragment or trailing slash), for prefix matching; undefined if unreadable. */
function originAndPath(value: string | undefined): { origin: string; path: string } | undefined {
  if (!value || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return { origin: url.origin.toLowerCase(), path: url.pathname.replace(/\/+$/, "") };
  } catch {
    return undefined;
  }
}

/** Provider ids that read a deployment env key, so a `PROVIDER_ENV_KEY_BASE_URLS` entry may name one. */
export const PROVIDERS_WITH_ENV_KEYS: readonly string[] = ["openai", "anthropic", "azure_openai", "gemini"];

export interface EnvKeyBaseUrlEntry {
  /** The provider the entry is for; undefined for an unprefixed entry, which any provider's env key may go to. */
  providerId?: string;
  url: string;
}

/**
 * Parses `PROVIDER_ENV_KEY_BASE_URLS`: comma-separated entries, each `<provider>=<base URL>` (that provider's env key
 * only) or a bare base URL (any provider's env key: less strict). Entries that cannot be read are reported in
 * `errors` and left out.
 */
export function parseEnvKeyBaseUrls(value: string | undefined): { entries: EnvKeyBaseUrlEntry[]; errors: string[] } {
  const entries: EnvKeyBaseUrlEntry[] = [];
  const errors: string[] = [];
  for (const raw of (value ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const prefixed = /^([a-z][a-z0-9_]*)=(.*)$/i.exec(entry);
    const providerId = prefixed ? prefixed[1]!.toLowerCase() : undefined;
    const url = (prefixed ? prefixed[2]! : entry).trim();
    if (providerId && !PROVIDERS_WITH_ENV_KEYS.includes(providerId)) {
      errors.push(`'${entry}': unknown provider '${providerId}' (one of ${PROVIDERS_WITH_ENV_KEYS.join(", ")})`);
      continue;
    }
    if (!originAndPath(url)) {
      errors.push(`'${entry}': not an http(s) URL`);
      continue;
    }
    entries.push(providerId ? { providerId, url } : { url });
  }
  // "openai=https://x,https://y" most likely meant both for OpenAI, but a bare entry would carry every provider's key:
  // mixing the two forms is refused rather than read the less strict way.
  if (entries.some((entry) => entry.providerId) && entries.some((entry) => !entry.providerId)) {
    errors.push("mixes provider=url entries with bare URLs: prefix every entry (a bare URL gets any provider's key)");
    return { entries: entries.filter((entry) => entry.providerId), errors };
  }
  return { entries, errors };
}

/**
 * Base URLs the operator allows `providerId`'s deployment env key to go to besides the provider's own default (for
 * example a corporate gateway): the `PROVIDER_ENV_KEY_BASE_URLS` entries for that provider or for any provider, and
 * `EVAL_JUDGE_BASE_URL` when `EVAL_JUDGE_ALLOW_ENV_CREDENTIALS` is on. A base URL matches an entry on the same origin
 * whose path starts with the entry's path at a segment boundary, so an entry on a shared multi-tenant host only covers
 * its own path.
 */
export function envKeyAllowedBaseUrls(providerId: string, env: Record<string, string | undefined> = process.env): string[] {
  const urls = parseEnvKeyBaseUrls(env.PROVIDER_ENV_KEY_BASE_URLS)
    .entries.filter((entry) => !entry.providerId || entry.providerId === providerId)
    .map((entry) => entry.url);
  // The judge's base URL carries only the judge provider's key (EVAL_JUDGE_PROVIDER_ID, default openai).
  const judgeProvider = (env.EVAL_JUDGE_PROVIDER_ID ?? "").trim() || "openai";
  if (/^(true|1|yes)$/i.test((env.EVAL_JUDGE_ALLOW_ENV_CREDENTIALS ?? "").trim()) && env.EVAL_JUDGE_BASE_URL && judgeProvider === providerId) {
    urls.push(env.EVAL_JUDGE_BASE_URL.trim());
  }
  return urls;
}

function underAllowedBaseUrl(target: { origin: string; path: string }, entry: string): boolean {
  const allowed = originAndPath(entry);
  if (!allowed || allowed.origin !== target.origin) return false;
  return allowed.path === "" || target.path === allowed.path || target.path.startsWith(`${allowed.path}/`);
}

/**
 * Whether a deployment env key (OPENAI_API_KEY, ANTHROPIC_API_KEY, AZURE_OPENAI_API_KEY, ...) may be sent to
 * `baseUrl` for `providerId`. Only to the provider's own default base URL (Azure: AZURE_OPENAI_ENDPOINT), to a URL in
 * `PROVIDER_ENV_KEY_BASE_URLS`, or when no base URL is set (the default is used). A base URL a node or a request
 * names anywhere else gets no env key: it must use a secret, or no key. Compared by origin, so a path on the same
 * host is fine and a look-alike host is not.
 */
export function envKeyMayGoTo(providerId: string, baseUrl: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  if (!baseUrl || !baseUrl.trim()) return true;
  const target = originOf(baseUrl);
  const targetPath = originAndPath(baseUrl);
  if (!target || !targetPath) return false;
  if (envKeyAllowedBaseUrls(providerId, env).some((entry) => underAllowedBaseUrl(targetPath, entry))) return true;
  const allowed = new Set<string>();
  const own = originOf(PROVIDER_DEFAULT_BASE_URLS[providerId]);
  if (own) allowed.add(own);
  if (providerId === "azure_openai") {
    const endpoint = originOf(env.AZURE_OPENAI_ENDPOINT);
    if (endpoint) allowed.add(endpoint);
  }
  return allowed.has(target);
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
  const url = providerEffectiveBaseUrl(providerId, provider, env);
  return url === null ? null : url === undefined ? undefined : hostOfSetting(url);
}

/**
 * The base URL a call to this provider goes to: the node's, else the adapter's default. `null` for a provider that
 * sends nothing over the network; undefined when none is known.
 */
function providerEffectiveBaseUrl(
  providerId: string,
  provider: { baseUrl?: unknown; extra?: unknown },
  env: Record<string, string | undefined>
): string | undefined | null {
  if (PROVIDERS_WITHOUT_NETWORK.has(providerId)) return null;
  const fixed = PROVIDERS_WITH_FIXED_HOST.has(providerId) ? providerDefaultBaseUrl(providerId, env) : undefined;
  if (fixed) return fixed;
  const extra = provider.extra && typeof provider.extra === "object" && !Array.isArray(provider.extra) ? (provider.extra as Record<string, unknown>) : {};
  const configured = setting(provider.baseUrl) ?? (providerId === "azure_openai" ? setting(extra.endpoint) ?? setting(env.AZURE_OPENAI_ENDPOINT) : undefined);
  if (configured !== undefined) return configured;
  return providerDefaultBaseUrl(providerId, env);
}

/**
 * Where a provider call goes, as trace attributes want it (`server.address`, `server.port`): the host and port only,
 * never a path, query or credentials. Undefined for a provider that sends nothing over the network or a base URL that
 * cannot be read (a template).
 */
export function providerServerEndpoint(
  providerId: string,
  provider: { baseUrl?: unknown; extra?: unknown },
  env: Record<string, string | undefined> = process.env
): { address: string; port: number } | undefined {
  const url = providerEffectiveBaseUrl(providerId, provider, env);
  if (!url || !/^https?:\/\//i.test(url) || url.includes("{{")) return undefined;
  try {
    const parsed = new URL(url);
    const address = parsed.hostname.replace(/^\[|\]$/g, "");
    if (!address) return undefined;
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    return { address, port };
  } catch {
    return undefined;
  }
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
