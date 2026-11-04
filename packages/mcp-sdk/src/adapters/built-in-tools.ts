import {
  BUILT_IN_TOOL_ANNOTATIONS,
  BUILT_IN_TOOL_PROVIDER_INFO,
  BUILT_IN_TOOLS_ADAPTER_ID,
  builtInToolProviderOf,
  builtInToolsEndpoint,
  type BuiltInToolProvider,
  type MCPServerConfig,
  type MCPToolDefinition,
  type MCPToolResult,
  type McpToolErrorKind
} from "@ai-orchestrator/shared";
import type { MCPExecutionContext, MCPServerAdapter } from "../types";

/**
 * Phase 6.4 — the built-in `l2m-tools` adapter: Wikipedia, SearXNG, SerpAPI
 * and Wolfram Alpha as MCP tools, served in this process.
 *
 * Every request goes through the injected `fetch`; the API hands it the
 * outbound URL guard (OUTBOUND_DENY_PRIVATE, OUTBOUND_ALLOWLIST, DNS
 * pinning, redirect re-checks), so a SearXNG instance on a private host is
 * refused when private destinations are denied. Keys come from the node's
 * secret and are added to the request here, after the run's egress checks
 * have judged the call: they are never in the tool arguments, and they are
 * scrubbed from every error, so no result, cassette, argument summary or
 * telemetry row can carry them.
 */

export type BuiltInToolsFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface BuiltInToolsAdapterOptions {
  /** Every request goes through this. Default: the runtime's fetch with no outbound policy (tests and SDK users). */
  fetch?: BuiltInToolsFetch;
  /** Default 20 s per request; the run's abort signal and a shorter call timeout still apply. */
  timeoutMs?: number;
  /** Responses larger than this are refused. Default 2 MiB. */
  maxResponseBytes?: number;
  /** Sent with every request (Wikimedia asks every client to identify itself). */
  userAgent?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_USER_AGENT = "L2M-built-in-tools/1.0 (+https://lsquarem.com)";
const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 5;
const MAX_QUERY_CHARS = 1_000;
const MAX_TEXT_CHARS = 4_000;

const limitProperty = {
  type: "integer",
  minimum: 1,
  maximum: MAX_RESULTS,
  description: `How many results to return (default ${DEFAULT_RESULTS}, at most ${MAX_RESULTS}).`
};

function tool(name: string, description: string, inputSchema: Record<string, unknown>, title: string): MCPToolDefinition {
  return {
    serverId: BUILT_IN_TOOLS_ADAPTER_ID,
    serverLabel: "L2M built-in tools",
    name,
    description,
    inputSchema,
    annotations: { ...BUILT_IN_TOOL_ANNOTATIONS, title }
  };
}

const TOOLS: Record<BuiltInToolProvider, MCPToolDefinition[]> = {
  wikipedia: [
    tool(
      "wikipedia_search",
      "Search Wikipedia. Returns matching article titles with a short snippet and a link. Use wikipedia_page to read one.",
      {
        type: "object",
        properties: { query: { type: "string", description: "What to search for." }, limit: limitProperty },
        required: ["query"]
      },
      "Search Wikipedia"
    ),
    tool(
      "wikipedia_page",
      "Read the summary of one Wikipedia article by its exact title (as wikipedia_search returns it).",
      {
        type: "object",
        properties: { title: { type: "string", description: "The article title, for example 'Model Context Protocol'." } },
        required: ["title"]
      },
      "Read a Wikipedia article"
    )
  ],
  searxng: [
    tool(
      "searxng_search",
      "Search the web. Returns result titles, links and snippets.",
      {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for." },
          limit: limitProperty,
          language: { type: "string", description: "Optional language code, for example 'en'." },
          categories: { type: "string", description: "Optional comma-separated SearXNG categories, for example 'general,news'." }
        },
        required: ["query"]
      },
      "Search the web"
    )
  ],
  serpapi: [
    tool(
      "serpapi_search",
      "Search the web with Google results. Returns result titles, links and snippets, and a direct answer when Google shows one.",
      {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for." },
          limit: limitProperty,
          location: { type: "string", description: "Optional place to search from, for example 'Austin, Texas'." }
        },
        required: ["query"]
      },
      "Search the web"
    )
  ],
  wolfram: [
    tool(
      "wolfram_alpha",
      "Ask Wolfram Alpha a question it can compute: math, unit conversions, science, dates, statistics and facts. Use a short, precise English query.",
      {
        type: "object",
        properties: { input: { type: "string", description: "The query, for example 'integrate x^2 sin x' or '10 miles in km'." } },
        required: ["input"]
      },
      "Ask Wolfram Alpha"
    )
  ]
};

/** The tools a built-in provider exposes. */
export function builtInToolDefinitions(provider: BuiltInToolProvider): MCPToolDefinition[] {
  return TOOLS[provider].map((entry) => ({ ...entry, annotations: { ...entry.annotations } }));
}

class BuiltInToolError extends Error {}

function readText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  if (!text) throw new BuiltInToolError(`'${key}' is required.`);
  if (text.length > MAX_QUERY_CHARS) throw new BuiltInToolError(`'${key}' is longer than ${MAX_QUERY_CHARS} characters.`);
  return text;
}

function readOptionalText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().slice(0, 200);
}

function readLimit(args: Record<string, unknown>): number {
  const value = Number(args.limit);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_RESULTS;
  return Math.min(MAX_RESULTS, Math.floor(value));
}

function clip(value: unknown, max = MAX_TEXT_CHARS): string {
  const text = typeof value === "string" ? value : "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stripHtml(value: unknown): string {
  return clip(
    (typeof value === "string" ? value : "")
      .replace(/<[^>]*>/g, "")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Replaces every occurrence of the secret (raw and URL-encoded) in a message. */
function scrub(message: string, secret: string | undefined): string {
  if (!secret) return message;
  let out = message;
  for (const variant of new Set([secret, encodeURIComponent(secret)])) {
    if (variant) out = out.split(variant).join("[REDACTED]");
  }
  return out;
}

function errorKindOf(error: unknown): McpToolErrorKind {
  if (error instanceof BuiltInToolError) return "invalid_arguments";
  if (!(error instanceof Error)) return "tool";
  if (error.name === "TimeoutError") return "timeout";
  if (error.name === "AbortError") return "canceled";
  // A refused destination is the deployment's policy, not a failing service: it never trips the breaker.
  if (error.name === "OutboundUrlBlockedError") return "tool";
  return error instanceof TypeError ? "transport" : "tool";
}

export class BuiltInToolsMCPServerAdapter implements MCPServerAdapter {
  readonly definition = {
    id: BUILT_IN_TOOLS_ADAPTER_ID,
    label: "L2M built-in tools",
    description: "Wikipedia, SearXNG and SerpAPI web search, and Wolfram Alpha, served by L2M itself.",
    configSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: Object.keys(BUILT_IN_TOOL_PROVIDER_INFO) },
        endpoint: { type: "string" },
        language: { type: "string" }
      },
      required: ["provider"]
    },
    authSchema: { type: "object", properties: { secretRef: { type: "object" } } }
  };

  private readonly fetchImpl: BuiltInToolsFetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly userAgent: string;

  constructor(options: BuiltInToolsAdapterOptions = {}) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  async discoverTools(config: MCPServerConfig): Promise<MCPToolDefinition[]> {
    const provider = builtInToolProviderOf(config.connection);
    if (!provider) throw new Error(`Built-in tools need a provider: one of ${Object.keys(BUILT_IN_TOOL_PROVIDER_INFO).join(", ")}.`);
    return builtInToolDefinitions(provider);
  }

  async invokeTool(toolName: string, args: Record<string, unknown>, config: MCPServerConfig, context: MCPExecutionContext): Promise<MCPToolResult> {
    const provider = builtInToolProviderOf(config.connection);
    if (!provider) return { ok: false, output: null, error: "Built-in tools need a provider.", errorKind: "tool" };
    if (!TOOLS[provider].some((entry) => entry.name === toolName)) {
      return { ok: false, output: null, error: `The ${BUILT_IN_TOOL_PROVIDER_INFO[provider].label} tools have no tool '${toolName}'.`, errorKind: "invalid_arguments" };
    }
    const endpoint = builtInToolsEndpoint(config.connection);
    if (!endpoint) {
      return { ok: false, output: null, error: `${BUILT_IN_TOOL_PROVIDER_INFO[provider].label} needs an http(s) endpoint (the base URL of your instance).`, errorKind: "tool" };
    }
    let secret: string | undefined;
    if (BUILT_IN_TOOL_PROVIDER_INFO[provider].secret !== "none" && config.secretRef) {
      secret = (await context.resolveSecret(config.secretRef))?.trim() || undefined;
    }
    if (BUILT_IN_TOOL_PROVIDER_INFO[provider].secret === "required" && !secret) {
      return { ok: false, output: null, error: `${BUILT_IN_TOOL_PROVIDER_INFO[provider].label} needs a key: pick a secret on the tool node.`, errorKind: "credentials" };
    }
    try {
      const output = await this.run(provider, toolName, args ?? {}, endpoint, secret, context);
      return { ok: true, output, structured: output };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = scrub(raw, secret);
      return { ok: false, output: null, error: `${BUILT_IN_TOOL_PROVIDER_INFO[provider].label}: ${message}`, errorKind: errorKindOf(error) };
    }
  }

  private async run(
    provider: BuiltInToolProvider,
    toolName: string,
    args: Record<string, unknown>,
    endpoint: string,
    secret: string | undefined,
    context: MCPExecutionContext
  ): Promise<Record<string, unknown>> {
    switch (provider) {
      case "wikipedia":
        return toolName === "wikipedia_page" ? this.wikipediaPage(args, endpoint, context) : this.wikipediaSearch(args, endpoint, context);
      case "searxng":
        return this.searxng(args, endpoint, secret, context);
      case "serpapi":
        return this.serpapi(args, endpoint, secret!, context);
      case "wolfram":
        return this.wolfram(args, endpoint, secret!, context);
    }
  }

  private async request(url: URL, context: MCPExecutionContext, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
    const timeoutMs = Math.min(this.timeoutMs, context.callTimeoutMs ?? this.timeoutMs);
    const signals = [AbortSignal.timeout(timeoutMs), ...(context.signal ? [context.signal] : [])];
    const response = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "application/json, text/plain;q=0.9", "user-agent": this.userAgent, ...headers },
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0]
    });
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`the response is larger than ${this.maxResponseBytes} bytes.`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > this.maxResponseBytes) throw new Error(`the response is larger than ${this.maxResponseBytes} bytes.`);
    return { status: response.status, text: new TextDecoder().decode(buffer) };
  }

  private async requestJson(url: URL, context: MCPExecutionContext, headers?: Record<string, string>): Promise<Record<string, unknown>> {
    const { status, text } = await this.request(url, context, headers);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(status >= 400 ? `the service answered HTTP ${status}.` : "the service did not answer with JSON.");
    }
    const record = asRecord(body);
    if (status >= 400) {
      const detail = typeof record.error === "string" ? record.error : typeof asRecord(record.error).info === "string" ? String(asRecord(record.error).info) : "";
      throw new Error(`the service answered HTTP ${status}${detail ? `: ${clip(detail, 300)}` : "."}`);
    }
    return record;
  }

  private async wikipediaSearch(args: Record<string, unknown>, endpoint: string, context: MCPExecutionContext) {
    const query = readText(args, "query");
    const limit = readLimit(args);
    const url = new URL(`${endpoint}/w/api.php`);
    url.search = new URLSearchParams({ action: "query", list: "search", srsearch: query, srlimit: String(limit), format: "json", formatversion: "2", utf8: "1" }).toString();
    const body = await this.requestJson(url, context);
    const site = new URL(endpoint).origin;
    const results = asArray(asRecord(body.query).search).slice(0, limit).map((entry) => {
      const item = asRecord(entry);
      const title = typeof item.title === "string" ? item.title : "";
      return { title, snippet: stripHtml(item.snippet), url: `${site}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}` };
    });
    return { query, results };
  }

  private async wikipediaPage(args: Record<string, unknown>, endpoint: string, context: MCPExecutionContext) {
    const title = readText(args, "title");
    const url = new URL(`${endpoint}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`);
    const { status, text } = await this.request(url, context);
    if (status === 404) return { title, found: false, extract: "", url: "" };
    let body: Record<string, unknown>;
    try {
      body = asRecord(JSON.parse(text));
    } catch {
      throw new Error(status >= 400 ? `the service answered HTTP ${status}.` : "the service did not answer with JSON.");
    }
    if (status >= 400) throw new Error(`the service answered HTTP ${status}.`);
    const page = asRecord(asRecord(body.content_urls).desktop).page;
    return {
      title: typeof body.title === "string" ? body.title : title,
      found: true,
      description: clip(body.description, 300),
      extract: clip(body.extract),
      url: typeof page === "string" ? page : ""
    };
  }

  private async searxng(args: Record<string, unknown>, endpoint: string, secret: string | undefined, context: MCPExecutionContext) {
    const query = readText(args, "query");
    const limit = readLimit(args);
    const url = new URL(`${endpoint}/search`);
    const params = new URLSearchParams({ q: query, format: "json" });
    const language = readOptionalText(args, "language");
    const categories = readOptionalText(args, "categories");
    if (language) params.set("language", language);
    if (categories) params.set("categories", categories);
    url.search = params.toString();
    const body = await this.requestJson(url, context, secret ? { authorization: `Bearer ${secret}` } : {});
    const results = asArray(body.results).slice(0, limit).map((entry) => {
      const item = asRecord(entry);
      return { title: clip(item.title, 300), url: typeof item.url === "string" ? item.url : "", snippet: clip(item.content, 1_000), engine: typeof item.engine === "string" ? item.engine : undefined };
    });
    const answers = asArray(body.answers).filter((answer): answer is string => typeof answer === "string").slice(0, 3).map((answer) => clip(answer, 1_000));
    return { query, results, ...(answers.length > 0 ? { answers } : {}) };
  }

  private async serpapi(args: Record<string, unknown>, endpoint: string, key: string, context: MCPExecutionContext) {
    const query = readText(args, "query");
    const limit = readLimit(args);
    const url = new URL(`${endpoint}/search.json`);
    const params = new URLSearchParams({ engine: "google", q: query, num: String(limit) });
    const location = readOptionalText(args, "location");
    if (location) params.set("location", location);
    // The key is added last, after the run's egress checks judged the call; it never leaves this function.
    params.set("api_key", key);
    url.search = params.toString();
    const body = await this.requestJson(url, context);
    if (typeof body.error === "string" && body.error) throw new Error(clip(body.error, 300));
    const results = asArray(body.organic_results).slice(0, limit).map((entry) => {
      const item = asRecord(entry);
      return { title: clip(item.title, 300), url: typeof item.link === "string" ? item.link : "", snippet: clip(item.snippet, 1_000) };
    });
    const box = asRecord(body.answer_box);
    const answer = clip(typeof box.answer === "string" ? box.answer : typeof box.snippet === "string" ? box.snippet : "", 1_000);
    return { query, results, ...(answer ? { answer } : {}) };
  }

  private async wolfram(args: Record<string, unknown>, endpoint: string, appId: string, context: MCPExecutionContext) {
    const input = readText(args, "input");
    const url = new URL(`${endpoint}/api/v1/llm-api`);
    url.search = new URLSearchParams({ input, maxchars: String(MAX_TEXT_CHARS), appid: appId }).toString();
    const { status, text } = await this.request(url, context);
    if (status === 501) return { input, answered: false, answer: clip(text, 1_000) || "Wolfram Alpha could not interpret the query. Rephrase it." };
    if (status >= 400) throw new Error(`the service answered HTTP ${status}${status === 403 ? " (check the AppID)" : ""}.`);
    return { input, answered: true, answer: clip(text) };
  }
}
