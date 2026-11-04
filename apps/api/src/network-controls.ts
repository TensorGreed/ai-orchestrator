/**
 * Phase 13.2 — network controls: deployment-wide address allowlists per scope (NETWORK_ALLOW_*), the break-glass
 * ranges, and the per-object lists (MCP gateway clients, webhook triggers). One `onRequest` hook classifies each
 * request into its scope(s) with `classifyNetworkScope` (a pure function) and checks `request.ip`, which honours
 * TRUST_PROXY. With no list set the hook is not installed and the per-object checks see empty lists: behaviour is
 * the same as before.
 */
import net from "node:net";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  NETWORK_DENIED_MESSAGE,
  NETWORK_SCOPES,
  NETWORK_SCOPE_ENV,
  canonicalIpRange,
  type NetworkScope,
  type NetworkSettingsView
} from "@ai-orchestrator/shared";
import { parseTrustProxy, type AppConfig, type NetworkSettings } from "./config.js";
import type { AuditEventInput } from "./services/audit-service.js";
import type { NotificationEvent } from "./services/notification-service.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * A client address as the family and text BlockList matches: zone ids (`fe80::1%eth0`) and brackets dropped, and an
 * IPv4-mapped IPv6 address (`::ffff:10.0.0.1`, what a dual-stack listener reports) read as the IPv4 address. Null
 * when the text is not an IP address.
 */
export function normalizeClientAddress(raw: string | null | undefined): { address: string; family: "ipv4" | "ipv6" } | null {
  let text = String(raw ?? "").trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const canonical = canonicalIpRange(text);
  if (!canonical) return null;
  const address = canonical.slice(0, canonical.lastIndexOf("/"));
  return { address, family: net.isIPv4(address) ? "ipv4" : "ipv6" };
}

/** A set of canonical ranges matched with Node's BlockList (IPv4 and IPv6 kept apart, mapped addresses normalised). */
export class AddressList {
  private readonly list = new net.BlockList();
  readonly ranges: readonly string[];

  constructor(ranges: readonly string[]) {
    this.ranges = [...ranges];
    for (const range of ranges) {
      const slash = range.lastIndexOf("/");
      const address = range.slice(0, slash);
      const prefix = Number(range.slice(slash + 1));
      this.list.addSubnet(address, prefix, net.isIPv4(address) ? "ipv4" : "ipv6");
    }
  }

  get size(): number {
    return this.ranges.length;
  }

  has(ip: string | null | undefined): boolean {
    if (this.ranges.length === 0) return false;
    const normalized = normalizeClientAddress(ip);
    return normalized ? this.list.check(normalized.address, normalized.family) : false;
  }
}

// ---------------------------------------------------------------------------
// Scope classifier
// ---------------------------------------------------------------------------

export interface ScopeRequest {
  method: string;
  /** The raw request URL (path and query). */
  url: string;
  /** A session cookie is present (its value is not checked here). */
  hasSessionCookie: boolean;
  /** An Authorization header is present (a bearer token or API key). */
  hasBearer: boolean;
}

const EXEMPT_PATHS = new Set(["/health", "/ready", "/api/auth/saml/metadata"]);
const METRICS_PATHS = new Set(["/metrics", "/api/docs", "/api/openapi.json"]);
const PUBLIC_PATHS = new Set(["/widget.js", "/helper-chat"]);

function startsWithSegment(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The request path as the router matches it: no query, percent-decoding applied where it is valid. */
function routePath(url: string): string {
  const raw = (url.split("?")[0] ?? "").split("#")[0] ?? "";
  let path = raw;
  try {
    path = decodeURI(raw);
  } catch {
    // An undecodable path is matched as given; the router refuses it too.
  }
  return path || "/";
}

/**
 * The scope(s) a request must be admitted on, from its route family and credential. Empty = always exempt (probes
 * and the SAML metadata an IdP fetches). Studio and REST routes under `/api/*` (and any path not in another family)
 * are `ui` with a session cookie or no credential, `api` with a bearer token or API key, and both when the request
 * carries both (the auth layer would accept either). `/api/webhooks/execute` (and its stream) needs a studio or API
 * credential, so it is not in the webhook family.
 */
export function classifyNetworkScope(input: ScopeRequest): NetworkScope[] {
  const path = routePath(input.url);
  if (EXEMPT_PATHS.has(path)) return [];
  if (METRICS_PATHS.has(path) || path.startsWith("/api/docs/")) return ["metrics"];
  if (startsWithSegment(path, "/mcp")) return ["mcp_gateway"];
  if (
    startsWithSegment(path, "/webhook") ||
    startsWithSegment(path, "/webhook-test") ||
    startsWithSegment(path, "/api/mcp-server") ||
    (startsWithSegment(path, "/api/webhooks") && !startsWithSegment(path, "/api/webhooks/execute"))
  ) {
    return ["webhook"];
  }
  if (PUBLIC_PATHS.has(path) || startsWithSegment(path, "/api/forms") || startsWithSegment(path, "/api/chat")) return ["public"];
  if (input.hasBearer && input.hasSessionCookie) return ["ui", "api"];
  return input.hasBearer ? ["api"] : ["ui"];
}

/** True when the Cookie header names the session cookie with a value. */
export function hasCookie(header: string | string[] | undefined, name: string): boolean {
  const text = Array.isArray(header) ? header.join(";") : (header ?? "");
  if (!text) return false;
  return text.split(";").some((part) => {
    const trimmed = part.trim();
    return trimmed.startsWith(`${name}=`) && trimmed.length > name.length + 1;
  });
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type NetworkVerdict =
  | { kind: "allowed" }
  | { kind: "break_glass"; scope: NetworkScope }
  | { kind: "denied"; scope: NetworkScope };

/** Scopes break-glass ranges are admitted on. */
const BREAK_GLASS_SCOPES = new Set<NetworkScope>(["ui", "api"]);

/** How long one address and scope is audited at most once (denials, would-be denials, break-glass admits). */
export const NETWORK_AUDIT_SAMPLE_MS = 60_000;
/** How long one address raises at most one break-glass alert. */
export const BREAK_GLASS_ALERT_SAMPLE_MS = 10 * 60_000;
const SAMPLER_MAX_KEYS = 10_000;

/** Remembers when each key was last let through, so a flood from one address is recorded once per window. */
export class KeySampler {
  private readonly last = new Map<string, number>();

  constructor(private readonly windowMs: number) {}

  take(key: string, now: number = Date.now()): boolean {
    const previous = this.last.get(key);
    if (previous !== undefined && now - previous < this.windowMs) return false;
    if (this.last.size >= SAMPLER_MAX_KEYS) {
      for (const [entry, at] of this.last) if (now - at >= this.windowMs) this.last.delete(entry);
      if (this.last.size >= SAMPLER_MAX_KEYS) this.last.clear();
    }
    this.last.set(key, now);
    return true;
  }
}

export interface NetworkControlsDeps {
  settings: NetworkSettings;
  config: Pick<AppConfig, "TRUST_PROXY" | "SESSION_COOKIE_NAME">;
  audit: (event: AuditEventInput) => Promise<void>;
  notify: (event: NotificationEvent) => Promise<void>;
  metrics: { recordNetworkDecision: (scope: string, outcome: "denied" | "would_deny" | "break_glass") => void };
  log: { warn: (fields: Record<string, unknown>, message: string) => void };
}

/** Where a per-object list lives, for audit and logs. */
export type ObjectListRef =
  | { list: "mcp_client"; clientId: string; clientName: string }
  | { list: "webhook"; workflowId: string; nodeId: string };

function requestFacts(request: FastifyRequest): { ip: string; method: string; path: string; userAgent: string | null } {
  const ua = request.headers["user-agent"];
  return {
    ip: request.ip,
    method: request.method,
    // Never the query: it can carry one-time codes or tokens.
    path: (request.url.split("?")[0] ?? "").slice(0, 512),
    userAgent: typeof ua === "string" ? ua.slice(0, 512) : null
  };
}

export class NetworkControls {
  readonly settings: NetworkSettings;
  private readonly scopeLists = new Map<NetworkScope, AddressList>();
  readonly breakGlass: AddressList;
  readonly clientCertProxies: AddressList;
  private readonly auditSampler = new KeySampler(NETWORK_AUDIT_SAMPLE_MS);
  private readonly alertSampler = new KeySampler(BREAK_GLASS_ALERT_SAMPLE_MS);

  constructor(private readonly deps: NetworkControlsDeps) {
    this.settings = deps.settings;
    for (const scope of NETWORK_SCOPES) {
      const ranges = deps.settings.scopes[scope];
      if (ranges && ranges.length > 0) this.scopeLists.set(scope, new AddressList(ranges));
    }
    this.breakGlass = new AddressList(deps.settings.breakGlass);
    this.clientCertProxies = new AddressList(deps.settings.clientCertProxies);
  }

  /** True when at least one scope has a list (the request hook is installed only then). */
  get active(): boolean {
    return this.scopeLists.size > 0;
  }

  get reportOnly(): boolean {
    return this.settings.mode === "report";
  }

  /** The verdict for an address on the given scopes; scopes without a list admit everyone. */
  evaluate(ip: string, scopes: readonly NetworkScope[]): NetworkVerdict {
    let breakGlassScope: NetworkScope | null = null;
    for (const scope of scopes) {
      const list = this.scopeLists.get(scope);
      if (!list || list.has(ip)) continue;
      if (BREAK_GLASS_SCOPES.has(scope) && this.breakGlass.has(ip)) {
        breakGlassScope ??= scope;
        continue;
      }
      return { kind: "denied", scope };
    }
    return breakGlassScope ? { kind: "break_glass", scope: breakGlassScope } : { kind: "allowed" };
  }

  /** The request hook's check: true when the request may go on (the reply is sent otherwise). */
  async checkRequest(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const scopes = classifyNetworkScope({
      method: request.method,
      url: request.url,
      hasSessionCookie: hasCookie(request.headers.cookie, this.deps.config.SESSION_COOKIE_NAME),
      hasBearer: Boolean(request.headers.authorization)
    });
    if (scopes.length === 0) return true;
    const verdict = this.evaluate(request.ip, scopes);
    if (verdict.kind === "allowed") return true;
    const facts = requestFacts(request);
    if (verdict.kind === "break_glass") {
      await this.recordBreakGlass(facts, verdict.scope);
      return true;
    }
    await this.recordRefusal(facts, { scope: verdict.scope });
    if (this.reportOnly) return true;
    sendDenied(reply, scopes.includes("mcp_gateway"));
    return false;
  }

  /**
   * A per-object list (an MCP client's or a webhook trigger's): true when the address may go on. `restricted` with
   * no valid range admits nobody. Report mode admits and records what would have been refused.
   */
  async checkObjectList(request: FastifyRequest, list: { restricted: boolean; ranges: readonly string[] }, ref: ObjectListRef): Promise<boolean> {
    if (!list.restricted) return true;
    if (list.ranges.length > 0 && new AddressList(list.ranges).has(request.ip)) return true;
    await this.recordRefusal(requestFacts(request), { scope: ref.list === "mcp_client" ? "mcp_gateway" : "webhook", ref });
    return this.reportOnly;
  }

  private async recordRefusal(
    facts: ReturnType<typeof requestFacts>,
    input: { scope: NetworkScope; ref?: ObjectListRef }
  ): Promise<void> {
    const report = this.reportOnly;
    this.deps.metrics.recordNetworkDecision(input.scope, report ? "would_deny" : "denied");
    const key = `${report ? "r" : "d"}|${facts.ip}|${input.scope}|${input.ref ? (input.ref.list === "mcp_client" ? input.ref.clientId : `${input.ref.workflowId}:${input.ref.nodeId}`) : ""}`;
    if (!this.auditSampler.take(key)) return;
    const metadata = {
      scope: input.scope,
      mode: this.settings.mode,
      method: facts.method,
      path: facts.path,
      list: input.ref?.list ?? "deployment",
      ...(input.ref?.list === "mcp_client" ? { clientId: input.ref.clientId, clientName: input.ref.clientName } : {}),
      ...(input.ref?.list === "webhook" ? { workflowId: input.ref.workflowId, nodeId: input.ref.nodeId } : {}),
      sampleWindowSeconds: NETWORK_AUDIT_SAMPLE_MS / 1000
    };
    this.deps.log.warn(
      { ip: facts.ip, ...metadata },
      report ? "Network allowlist would refuse this request (report mode)" : "Network allowlist refused a request"
    );
    await this.safeAudit({
      category: "system",
      eventType: report ? "network.request_would_be_denied" : "network.request_denied",
      action: "access",
      outcome: report ? "success" : "denied",
      actor: { type: "system", ipAddress: facts.ip, userAgent: facts.userAgent },
      metadata
    });
  }

  private async recordBreakGlass(facts: ReturnType<typeof requestFacts>, scope: NetworkScope): Promise<void> {
    this.deps.metrics.recordNetworkDecision(scope, "break_glass");
    if (this.auditSampler.take(`b|${facts.ip}|${scope}`)) {
      this.deps.log.warn({ ip: facts.ip, scope, method: facts.method, path: facts.path }, "Break-glass address admitted outside the allowlist");
      await this.safeAudit({
        category: "system",
        eventType: "network.break_glass_used",
        action: "access",
        outcome: "success",
        actor: { type: "system", ipAddress: facts.ip, userAgent: facts.userAgent },
        metadata: { scope, method: facts.method, path: facts.path, sampleWindowSeconds: NETWORK_AUDIT_SAMPLE_MS / 1000 }
      });
    }
    if (this.alertSampler.take(facts.ip)) {
      this.deps
        .notify({
          type: "network.break_glass_used",
          workflowId: "",
          workflowName: "",
          timestamp: new Date().toISOString(),
          network: { ip: facts.ip, scope, method: facts.method, path: facts.path }
        })
        .catch((error: unknown) => this.deps.log.warn({ error: error instanceof Error ? error.message : String(error) }, "Break-glass alert failed to send"));
    }
  }

  private async safeAudit(event: AuditEventInput): Promise<void> {
    try {
      await this.deps.audit(event);
    } catch (error) {
      this.deps.log.warn({ error: error instanceof Error ? error.message : String(error) }, "Failed to record a network audit event");
    }
  }

  /** The read-only view for Settings > Access control > Network. */
  view(request: FastifyRequest): NetworkSettingsView {
    const ip = request.ip;
    const scopes = NETWORK_SCOPES.map((scope) => {
      const list = this.scopeLists.get(scope);
      return { scope, env: NETWORK_SCOPE_ENV[scope], ranges: list ? [...list.ranges] : [], matched: list ? list.has(ip) : null };
    });
    const trustProxy = parseTrustProxy(this.deps.config.TRUST_PROXY);
    const warnings: string[] = [];
    if (this.reportOnly && this.active) {
      warnings.push("Report mode: nothing is refused. Would-be refusals are logged and audited as network.request_would_be_denied.");
    }
    if (this.active && trustProxy === false && request.headers["x-forwarded-for"] !== undefined) {
      warnings.push(
        "This request came through a proxy but TRUST_PROXY is off, so every request is checked as the proxy's address. Set TRUST_PROXY to the proxy's address or hop count."
      );
    }
    if (trustProxy === true) {
      warnings.push("TRUST_PROXY=true trusts every hop, so per-client and per-webhook address lists are checked against an address any client can choose.");
    }
    if (this.active && this.breakGlass.size === 0) {
      warnings.push("No break-glass ranges (NETWORK_BREAK_GLASS_CIDRS=none): a wrong list can only be fixed by changing the environment and restarting.");
    }
    return {
      mode: this.settings.mode,
      active: this.active,
      scopes,
      breakGlass: { ranges: [...this.breakGlass.ranges], matched: this.breakGlass.has(ip) },
      trustProxy: { configured: trustProxy !== false, summary: describeTrustProxy(trustProxy) },
      clientCertificate: { header: this.settings.clientCertHeader, proxies: [...this.clientCertProxies.ranges] },
      yourIp: ip,
      matchedScopes: scopes.filter((entry) => entry.matched === true).map((entry) => entry.scope),
      warnings
    };
  }
}

function describeTrustProxy(value: boolean | number | string[]): string {
  if (value === false) return "Off: the connecting address counts";
  if (value === true) return "Every hop is trusted";
  if (typeof value === "number") return `${value} hop${value === 1 ? "" : "s"} trusted`;
  return `Trusted proxies: ${value.join(", ")}`;
}

/** 403 with a fixed body; a JSON-RPC error on the MCP endpoint. The lists and the address are never echoed. */
export function sendDenied(reply: FastifyReply, jsonRpc: boolean): void {
  reply.code(403).header("content-type", "application/json; charset=utf-8");
  if (jsonRpc) {
    reply.send({ jsonrpc: "2.0", id: null, error: { code: -32001, message: NETWORK_DENIED_MESSAGE } });
  } else {
    reply.send({ error: NETWORK_DENIED_MESSAGE });
  }
}

/** Installs the request hook (only when a scope has a list). Call before CORS and rate limiting so a refusal is cheap. */
export function installNetworkHook(app: FastifyInstance, controls: NetworkControls): void {
  if (!controls.active) return;
  app.addHook("onRequest", async (request, reply) => {
    if (!(await controls.checkRequest(request, reply))) return reply;
    return undefined;
  });
}

export function registerNetworkSettingsRoute(
  app: FastifyInstance,
  deps: {
    controls: NetworkControls;
    requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  }
): void {
  app.get("/api/settings/network", async (request, reply) => {
    const user = await deps.requireRole(request, reply, ["admin"]);
    if (!user) return reply;
    return deps.controls.view(request);
  });
}
