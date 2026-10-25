/**
 * Outbound URL guard for nodes that fetch a user-supplied URL (HTTP Request,
 * Web Browse, the Chart node's `data.url`, and the HTML-render PDF path).
 *
 * Policy (user decision, 2026-10-23):
 *   - Only `http:` and `https:` are fetchable. `file:`, `data:`, `javascript:`
 *     and everything else are refused, so a URL can never read the local disk
 *     or run inline script through one of these nodes.
 *   - Cloud metadata endpoints (169.254.169.254, fd00:ec2::254,
 *     metadata.google.internal and the like) and link-local addresses are
 *     always blocked, as are multicast, unspecified, reserved and
 *     documentation ranges — none is ever a real fetch target.
 *   - Private ranges and localhost are ALLOWED by default. An admin can turn
 *     on `denyPrivate` to block them, and then widen it again with an
 *     allowlist of hosts or CIDRs.
 *
 * DNS rebinding: the host is resolved and every returned address is
 * classified, so a name that resolves to a blocked address is refused.
 * `guardedFetch` also pins the connection: its undici dispatcher's `lookup` resolves
 * the name once at connect time, checks every address and hands the socket
 * only those, so a name cannot pass the check with one address and connect to
 * another. The URL keeps its hostname, so TLS SNI, certificate checks and the
 * Host header are unchanged. Redirects are re-checked hop by hop. The
 * Playwright guard checks each request at route time; Chromium resolves the
 * name again itself, so that path is not pinned (see the security docs).
 */
import dns from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { Agent } from "undici";
import { classifyIp, parseIp, type DnsResolver, type IpClass } from "@ai-orchestrator/guard-sdk";

export interface OutboundGuardConfig {
  /** Block private ranges, loopback, carrier-grade NAT and unique-local addresses. Default false. */
  denyPrivate: boolean;
  /** Hosts or CIDRs allowed through even when `denyPrivate` is on. Entries: `host`, `*.example.com`, `host:port`, or a CIDR like `10.0.0.0/8`. */
  allowlist: string[];
}

export const DEFAULT_OUTBOUND_GUARD: OutboundGuardConfig = { denyPrivate: false, allowlist: [] };

/** Metadata and local service names that are blocked whatever they resolve to. Localhost is NOT here (it is allowed unless denyPrivate). */
const BLOCKED_METADATA_HOSTNAMES: readonly RegExp[] = [
  /^metadata(?:\.google\.internal)?\.?$/i,
  /^metadata\.goog\.?$/i,
  /^instance-data(?:\.ec2\.internal)?\.?$/i
];

/** Address classes blocked no matter what. */
const ALWAYS_BLOCKED: ReadonlySet<IpClass> = new Set<IpClass>(["metadata", "link_local", "multicast", "unspecified", "reserved", "documentation"]);
/** Address classes blocked only under denyPrivate (unless allowlisted). */
const PRIVATE_CLASSES: ReadonlySet<IpClass> = new Set<IpClass>(["private", "loopback", "carrier_nat", "unique_local"]);

export type OutboundBlockReason =
  | "scheme"
  | "unparseable"
  | "host_blocked"
  | "resolver_error"
  | "unresolved"
  | "address_blocked";

export interface OutboundCheck {
  ok: boolean;
  url: string;
  host?: string;
  addresses: Array<{ address: string; class: IpClass }>;
  reason?: OutboundBlockReason;
  message?: string;
}

/** A thrown block, so a node handler can `catch` it or let it surface as a node failure. */
export class OutboundUrlBlockedError extends Error {
  readonly reason: OutboundBlockReason;
  readonly host?: string;
  constructor(check: OutboundCheck) {
    super(check.message ?? "Outbound request blocked");
    this.name = "OutboundUrlBlockedError";
    this.reason = check.reason ?? "address_blocked";
    this.host = check.host;
  }
}

/** The real DNS resolver (A and AAAA). Injectable so tests and air-gapped installs can swap it. */
export const nodeDnsResolver: DnsResolver = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

function parseCidr(entry: string): { bytes: number[]; prefix: number } | null {
  const slash = entry.lastIndexOf("/");
  if (slash < 0) return null;
  const ip = parseIp(entry.slice(0, slash));
  const prefix = Number(entry.slice(slash + 1));
  if (!ip || !Number.isInteger(prefix) || prefix < 0 || prefix > ip.bytes.length * 8) return null;
  return { bytes: ip.bytes, prefix };
}

function ipInCidr(addressBytes: number[], cidr: { bytes: number[]; prefix: number }): boolean {
  if (addressBytes.length !== cidr.bytes.length) return false;
  let remaining = cidr.prefix;
  for (let i = 0; i < addressBytes.length && remaining > 0; i += 1) {
    const take = Math.min(8, remaining);
    const mask = take === 0 ? 0 : (0xff << (8 - take)) & 0xff;
    if ((addressBytes[i]! & mask) !== (cidr.bytes[i]! & mask)) return false;
    remaining -= take;
  }
  return true;
}

function hostMatchesPattern(host: string, port: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  const [hostPart, portPart] = p.includes(":") && !p.startsWith("[") ? [p.slice(0, p.lastIndexOf(":")), p.slice(p.lastIndexOf(":") + 1)] : [p, ""];
  if (portPart && portPart !== port) return false;
  const h = host.toLowerCase().replace(/\.$/, "");
  if (hostPart.startsWith("*.")) return h === hostPart.slice(2) || h.endsWith(hostPart.slice(1));
  return h === hostPart;
}

/** True when the host or every resolved address is allowlisted (a host pattern, or a CIDR all addresses fall in). */
function isAllowlisted(host: string, port: string, addresses: string[], allowlist: string[]): boolean {
  const entries = allowlist.map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return false;
  const cidrs = entries.map(parseCidr);
  const hostPatterns = entries.filter((_, index) => cidrs[index] === null);
  if (hostPatterns.some((pattern) => hostMatchesPattern(host, port, pattern))) return true;
  const activeCidrs = cidrs.filter((c): c is { bytes: number[]; prefix: number } => c !== null);
  if (activeCidrs.length === 0 || addresses.length === 0) return false;
  return addresses.every((address) => {
    const parsed = parseIp(address);
    return parsed !== null && activeCidrs.some((cidr) => ipInCidr(parsed.bytes, cidr));
  });
}

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/** Checks one URL against the policy. Does not throw; returns the verdict. */
export async function checkOutboundUrl(rawUrl: string, config: OutboundGuardConfig, resolver: DnsResolver = nodeDnsResolver): Promise<OutboundCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, url: rawUrl, addresses: [], reason: "unparseable", message: "URL could not be parsed" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, url: rawUrl, addresses: [], reason: "scheme", message: `Scheme '${url.protocol.replace(":", "")}' is not allowed; only http and https may be fetched` };
  }
  const host = url.hostname.replace(/\.$/, "").replace(/^\[|\]$/g, "");
  const port = url.port || DEFAULT_PORTS[url.protocol] || "";
  return { ...(await checkOutboundHost(host, port, config, resolver)), url: rawUrl };
}

/** Checks one host (and the port, for port-specific allowlist entries) against the policy. */
async function checkOutboundHost(host: string, port: string, config: OutboundGuardConfig, resolver: DnsResolver): Promise<OutboundCheck> {
  const rawUrl = host;
  if (BLOCKED_METADATA_HOSTNAMES.some((pattern) => pattern.test(host))) {
    return { ok: false, url: rawUrl, host, addresses: [], reason: "host_blocked", message: `Host '${host}' names a cloud metadata service` };
  }
  const literal = parseIp(host);
  let addresses: string[];
  if (literal) {
    addresses = [host];
  } else {
    try {
      addresses = await resolver(host);
    } catch (error) {
      return { ok: false, url: rawUrl, host, addresses: [], reason: "resolver_error", message: `Could not resolve '${host}': ${(error as Error).message}` };
    }
    if (addresses.length === 0) {
      return { ok: false, url: rawUrl, host, addresses: [], reason: "unresolved", message: `Host '${host}' did not resolve to any address` };
    }
  }
  const classified = addresses.map((address) => {
    const parsed = parseIp(address);
    return { address, class: parsed ? classifyIp(parsed) : ("reserved" as IpClass) };
  });
  // Metadata, link-local and other never-valid ranges are blocked before the allowlist, which cannot override them.
  const hardBlocked = classified.find((entry) => ALWAYS_BLOCKED.has(entry.class));
  if (hardBlocked) {
    return { ok: false, url: rawUrl, host, addresses: classified, reason: "address_blocked", message: `Host '${host}' resolves to a ${hardBlocked.class.replace("_", " ")} address` };
  }
  if (config.denyPrivate) {
    const privateHit = classified.find((entry) => PRIVATE_CLASSES.has(entry.class));
    if (privateHit && !isAllowlisted(host, port, addresses, config.allowlist)) {
      return {
        ok: false,
        url: rawUrl,
        host,
        addresses: classified,
        reason: "address_blocked",
        message: `Host '${host}' resolves to a ${privateHit.class.replace("_", " ")} address, which is blocked (OUTBOUND_DENY_PRIVATE); add it to OUTBOUND_ALLOWLIST to permit it`
      };
    }
  }
  return { ok: true, url: rawUrl, host, addresses: classified };
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A connect-time `lookup` for one request: resolves the name once, checks
 * every address against the policy and returns only those addresses, so the
 * socket connects to exactly what was checked. Exported for tests.
 */
export function pinnedLookup(port: string, config: OutboundGuardConfig, resolver: DnsResolver = nodeDnsResolver) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    checkOutboundHost(hostname.replace(/\.$/, ""), port, config, resolver).then(
      (check) => {
        if (!check.ok) {
          callback(Object.assign(new OutboundUrlBlockedError(check), { code: "EOUTBOUNDBLOCKED" }), []);
          return;
        }
        let vetted: LookupAddress[] = check.addresses.map((entry) => ({ address: entry.address, family: entry.address.includes(":") ? 6 : 4 }));
        if (options.family === 4 || options.family === 6) vetted = vetted.filter((entry) => entry.family === options.family);
        if (vetted.length === 0) {
          callback(Object.assign(new Error(`Host '${hostname}' has no address of the requested family`), { code: "ENOTFOUND" }), []);
          return;
        }
        if (options.all) callback(null, vetted);
        else callback(null, vetted[0]!.address, vetted[0]!.family);
      },
      (error: unknown) => callback(error as NodeJS.ErrnoException, [])
    );
  };
}

/** A dispatcher whose connections go only to addresses the policy has vetted for this host and port. */
export function createPinnedDispatcher(port: string, config: OutboundGuardConfig, resolver: DnsResolver = nodeDnsResolver): Agent {
  return new Agent({ connect: { lookup: pinnedLookup(port, config, resolver) as never } });
}

/** Checks a URL and throws `OutboundUrlBlockedError` if the policy blocks it. */
export async function assertOutboundUrlAllowed(rawUrl: string, config: OutboundGuardConfig, resolver: DnsResolver = nodeDnsResolver): Promise<void> {
  const check = await checkOutboundUrl(rawUrl, config, resolver);
  if (!check.ok) throw new OutboundUrlBlockedError(check);
}

export interface GuardedFetchOptions {
  config: OutboundGuardConfig;
  resolver?: DnsResolver;
  /** Max redirects to follow; each hop is re-checked. Default 5. */
  maxRedirects?: number;
  /** Replaces the pinned fetch (tests). When set, the connection is not pinned. */
  fetchImpl?: typeof fetch;
  /**
   * Phase 16 — called before a redirect is followed, with the next URL;
   * throwing stops the request there (the destination check of the chain).
   */
  onRedirect?: (url: string) => Promise<void>;
}

/** Credential headers dropped when a redirect leaves the original origin. */
export const CROSS_ORIGIN_STRIPPED_HEADERS = ["authorization", "proxy-authorization", "cookie", "api-key", "x-api-key"] as const;

/**
 * Like `fetch`, but every URL — the original and each redirect — is checked
 * against the policy first. Redirects are followed manually (`redirect:
 * "manual"`) so a 3xx to a blocked host is refused instead of being followed
 * by the runtime before we can see it.
 */
export async function guardedFetch(url: string, init: RequestInit, options: GuardedFetchOptions): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 5;
  const resolver = options.resolver ?? nodeDnsResolver;
  let currentUrl = url;
  let currentInit: RequestInit = { ...init, redirect: "manual" };
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertOutboundUrlAllowed(currentUrl, options.config, resolver);
    const response = await pinnedFetch(currentUrl, currentInit, options, resolver);
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    const next = new URL(location, currentUrl).toString();
    // The redirect's own body is never read; release it so this hop's connection (and pinned Agent) can close.
    await response.body?.cancel().catch(() => undefined);
    if (options.onRedirect) await options.onRedirect(next);
    // A cross-origin redirect drops credentials: Authorization (as fetch does) and the API-key and cookie headers vendors use.
    const nextHeaders = new Headers(currentInit.headers);
    if (new URL(next).origin !== new URL(currentUrl).origin) {
      for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) nextHeaders.delete(name);
    }
    currentUrl = next;
    // 303, or 301/302 on POST, becomes a GET without a body, as browsers do.
    const method = (currentInit.method ?? "GET").toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      currentInit = { ...currentInit, method: "GET", body: undefined, headers: nextHeaders };
    } else {
      currentInit = { ...currentInit, headers: nextHeaders };
    }
  }
  throw new OutboundUrlBlockedError({ ok: false, url: currentUrl, addresses: [], reason: "address_blocked", message: `Too many redirects (more than ${maxRedirects})` });
}

/** One request through a dispatcher pinned to the vetted addresses (or through `fetchImpl` in tests). */
async function pinnedFetch(url: string, init: RequestInit, options: GuardedFetchOptions, resolver: DnsResolver): Promise<Response> {
  if (options.fetchImpl) return options.fetchImpl(url, init);
  const parsed = new URL(url);
  const dispatcher = createPinnedDispatcher(parsed.port || DEFAULT_PORTS[parsed.protocol] || "", options.config, resolver);
  try {
    // The runtime's fetch takes an undici dispatcher; the pinned Agent decides which address the socket reaches.
    return await fetch(url, { ...init, dispatcher } as RequestInit);
  } catch (error) {
    // Surface a block from the pinned lookup as the guard's own error, not a generic "fetch failed".
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof OutboundUrlBlockedError) throw cause;
    throw error;
  } finally {
    // Graceful: the agent closes once this request (and its body) has finished.
    void dispatcher.close().catch(() => undefined);
  }
}

/** Minimal shape of a Playwright `Route`, so this module needs no Playwright types. */
export interface PlaywrightRouteLike {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

/**
 * A Playwright route handler that lets `data:`/`blob:`/`about:` through (inert,
 * no network) and checks every http(s) request against the policy, aborting a
 * blocked one. Register it for all requests (`context.route` with a match-all pattern) so every
 * sub-resource the page loads — not just the top document — is checked.
 */
export function playwrightOutboundGuard(config: OutboundGuardConfig, resolver: DnsResolver = nodeDnsResolver): (route: PlaywrightRouteLike) => Promise<void> {
  return async (route) => {
    const url = route.request().url();
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) {
      await route.continue();
      return;
    }
    const check = await checkOutboundUrl(url, config, resolver);
    if (check.ok) await route.continue();
    else await route.abort("blockedbyclient");
  };
}

/** Minimal shape of a Playwright `WebSocketRoute`. */
export interface PlaywrightWebSocketRouteLike {
  url(): string;
  connectToServer(): unknown;
  close(options?: { code?: number; reason?: string }): Promise<void>;
}

/**
 * A Playwright `routeWebSocket` handler: a page's `new WebSocket(url)` is
 * connected only when the URL's host passes the same policy as http(s)
 * requests (`ws:`/`wss:` are checked as `http:`/`https:`); otherwise the
 * socket is closed before any connection is made. `context.route` does not
 * see WebSockets, so the browser-based nodes install both.
 */
export function playwrightWebSocketGuard(config: OutboundGuardConfig, resolver: DnsResolver = nodeDnsResolver): (ws: PlaywrightWebSocketRouteLike) => Promise<void> {
  return async (ws) => {
    const url = ws.url();
    const asHttp = url.replace(/^ws(s?):/i, "http$1:");
    const check = /^wss?:/i.test(url) ? await checkOutboundUrl(asHttp, config, resolver) : { ok: false };
    if (check.ok) ws.connectToServer();
    else await ws.close({ code: 1008, reason: "Blocked by the outbound URL guard" });
  };
}
