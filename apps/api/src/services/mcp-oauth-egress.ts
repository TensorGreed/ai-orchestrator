/**
 * Private-address blocking for the OAuth requests L2M makes on behalf of a remote MCP server (optional,
 * `MCP_OAUTH_BLOCK_PRIVATE_HOSTS`, off by default).
 *
 * Most OAuth URLs come from the MCP server, not from the admin: the `resource_metadata` URL in its 401, the
 * `authorization_servers` in its protected resource metadata, and the endpoints in the authorization server's
 * metadata. A hostile or compromised server could point them at the cloud metadata service or at internal hosts
 * (server-side request forgery). With the setting on, every such request is checked first:
 *
 *   - Cloud metadata, link-local, multicast, unspecified, reserved and documentation addresses are always refused,
 *     whatever the allow list says.
 *   - Private, carrier-grade NAT, unique-local (and site-local) and loopback addresses are refused unless the host
 *     or its addresses are on `MCP_OAUTH_PRIVATE_HOST_ALLOWLIST`, for identity providers on a private network.
 *   - The MCP server's own host and port (what the admin configured, and what L2M calls anyway) is allowed, and so
 *     is loopback when that endpoint is itself a loopback address (a local development setup).
 *   - IPv4-mapped, IPv4-translated, NAT64 and 6to4 IPv6 forms are judged by the IPv4 address they carry, and
 *     decimal, octal and hex IPv4 spellings by their value (the URL parser normalises them).
 *
 * DNS rebinding: the request goes through an undici dispatcher whose `lookup` resolves the name once at connect
 * time, checks every address and gives the socket only those, so a name cannot pass one check and connect
 * elsewhere. Redirects are never followed (`redirect: "error"`), so a redirect cannot lead to an internal host.
 */
import {
  OutboundUrlBlockedError,
  checkOutboundUrl,
  createPinnedDispatcher,
  nodeDnsResolver,
  type OutboundBlockReason,
  type OutboundGuardConfig
} from "@ai-orchestrator/workflow-engine";
import { parseIp, type DnsResolver } from "@ai-orchestrator/guard-sdk";
import { McpOAuthError, isLoopbackHost, type FetchLike } from "@ai-orchestrator/mcp-sdk";

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };
const LOOPBACK_ENTRIES = ["127.0.0.0/8", "::1/128", "localhost", "*.localhost"];

/** The guard policy for OAuth requests made for the MCP server at `endpoint`. */
export function mcpOAuthEgressPolicy(endpoint: string, allowlist: readonly string[]): OutboundGuardConfig {
  const entries = allowlist.map((entry) => entry.trim()).filter(Boolean);
  let url: URL | null = null;
  try {
    url = new URL(endpoint);
  } catch {
    url = null;
  }
  if (url && (url.protocol === "http:" || url.protocol === "https:")) {
    const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const literal = parseIp(host);
    // The configured endpoint itself: its exact address for a literal, else its name on its port.
    entries.push(literal ? `${host}/${literal.family === 4 ? 32 : 128}` : `${host}:${url.port || DEFAULT_PORTS[url.protocol]}`);
    if (isLoopbackHost(url.hostname)) entries.push(...LOOPBACK_ENTRIES);
  }
  return { denyPrivate: true, allowlist: entries };
}

function refusal(host: string | undefined, reason: OutboundBlockReason | undefined): McpOAuthError {
  const name = host ? `'${host}'` : "the host";
  let why: string;
  switch (reason) {
    case "host_blocked":
      why = "it names a cloud metadata service";
      break;
    case "resolver_error":
    case "unresolved":
      why = "it could not be resolved";
      break;
    case "scheme":
    case "unparseable":
      why = "the URL is not an http(s) URL";
      break;
    default:
      why = "it resolves to a private, loopback, link-local or other non-public address";
  }
  return new McpOAuthError(
    `L2M refused to contact ${name} for OAuth because ${why}. If it is a trusted identity provider on a private network, add it to MCP_OAUTH_PRIVATE_HOST_ALLOWLIST.`
  );
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * A `fetch` for the OAuth requests of the MCP server at `endpoint` that refuses blocked addresses, pins the
 * connection to the addresses it checked and never follows a redirect.
 */
export function createMcpOAuthEgressFetch(
  endpoint: string,
  options: { allowlist: readonly string[]; resolver?: DnsResolver }
): FetchLike {
  const policy = mcpOAuthEgressPolicy(endpoint, options.allowlist);
  const resolver = options.resolver ?? nodeDnsResolver;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    // Literal addresses never reach the dispatcher's lookup, so every URL is checked here first.
    const check = await checkOutboundUrl(url, policy, resolver);
    if (!check.ok) throw refusal(check.host, check.reason);
    const parsed = new URL(url);
    const dispatcher = createPinnedDispatcher(parsed.port || DEFAULT_PORTS[parsed.protocol] || "", policy, resolver);
    try {
      return await fetch(input instanceof Request ? input : url, { ...init, redirect: "error", dispatcher } as RequestInit);
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause;
      if (cause instanceof OutboundUrlBlockedError) throw refusal(cause.host, cause.reason);
      throw error;
    } finally {
      // Graceful: the agent closes once this request and its body have finished.
      void dispatcher.close().catch(() => undefined);
    }
  }) as FetchLike;
}
