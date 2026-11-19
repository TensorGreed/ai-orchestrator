import type { DnsResolver } from "@ai-orchestrator/guard-sdk";
import { parseEnvKeyBaseUrls, type ProviderExecutionContext, type ProviderFetch } from "@ai-orchestrator/provider-sdk";
import { checkOutboundUrl, guardedFetch, nodeDnsResolver, OutboundUrlBlockedError, type OutboundGuardConfig } from "@ai-orchestrator/workflow-engine";

/**
 * Where model and embedding calls may connect.
 *
 * A base URL or endpoint a model node, a provider test, a `/v1` route or an embedding call names goes through the
 * outbound URL checks before the call (metadata and link-local addresses always, private ones under
 * OUTBOUND_DENY_PRIVATE, and a name that does not resolve), and the call is then sent through a fetch pinned to the
 * addresses that were checked: the connection goes to exactly what was vetted, so a name that answers differently on
 * a second lookup (DNS rebinding) cannot move it. The URL keeps its host name, so TLS SNI, certificate checks and the
 * Host header are the name's, not the address's. Model calls never follow redirects.
 *
 * A provider's own default endpoint (no base URL set) and the operator's environment endpoints are not checked or
 * pinned: the operator chose them.
 */
export interface ModelEgressOptions {
  guard: OutboundGuardConfig;
  resolver?: DnsResolver;
  env?: Record<string, string | undefined>;
}

export interface ModelEgress {
  /** The context a call with `provider` runs with (pinned `fetch` for a node-chosen URL), or a thrown block. */
  contextFor<C extends ProviderExecutionContext | undefined>(provider: { baseUrl?: unknown; extra?: unknown }, context: C): Promise<C | ProviderExecutionContext>;
  /** The pinned, checked fetch (no redirects) for a URL a node or request chose. */
  fetch: ProviderFetch;
  /** Whether `url` is on an endpoint the operator set in the environment. */
  isOperatorUrl(url: string): boolean;
}

function originOf(value: string | undefined): string {
  if (!value || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    // Only http(s) URLs have an origin to match ("null" for anything else would match every such URL).
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin.toLowerCase() : "";
  } catch {
    return "";
  }
}

export class ModelRedirectRefusedError extends Error {
  constructor() {
    super("The model server answered with a redirect, which model calls do not follow: set the final URL as the base URL.");
    this.name = "ModelRedirectRefusedError";
  }
}

export function createModelEgress(options: ModelEgressOptions): ModelEgress {
  const resolver = options.resolver ?? nodeDnsResolver;
  const env = () => options.env ?? process.env;
  const operatorOrigins = (): Set<string> => {
    const values = env();
    return new Set(
      [values.OLLAMA_BASE_URL, values.AZURE_OPENAI_ENDPOINT, values.EVAL_JUDGE_BASE_URL, ...parseEnvKeyBaseUrls(values.PROVIDER_ENV_KEY_BASE_URLS).entries.map((entry) => entry.url)]
        .map((value) => originOf(value))
        .filter(Boolean)
    );
  };
  const isOperatorUrl = (url: string): boolean => {
    const origin = originOf(url);
    return Boolean(origin) && operatorOrigins().has(origin);
  };
  const pinnedFetch: ProviderFetch = async (url, init) =>
    await guardedFetch(url, init, {
      config: options.guard,
      resolver,
      onRedirect: async () => {
        throw new ModelRedirectRefusedError();
      }
    });

  return {
    fetch: pinnedFetch,
    isOperatorUrl,
    async contextFor(provider, context) {
      const extra = provider.extra && typeof provider.extra === "object" ? (provider.extra as Record<string, unknown>) : {};
      const targets = [provider.baseUrl, extra.endpoint]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
        .filter((value) => !isOperatorUrl(value));
      if (targets.length === 0) return context;
      // Base URLs are never templated, so "{{" is literal text and is checked like any other URL. Checked here so a
      // block fails before any request (with the policy's message); the pinned fetch checks every request again.
      for (const target of targets) {
        const check = await checkOutboundUrl(target, options.guard, resolver);
        if (!check.ok) throw new OutboundUrlBlockedError(check);
      }
      return { ...(context ?? { resolveSecret: async () => undefined }), fetch: pinnedFetch };
    }
  };
}
