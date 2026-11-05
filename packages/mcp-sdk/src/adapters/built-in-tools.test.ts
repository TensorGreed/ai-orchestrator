import { describe, expect, it } from "vitest";
import { BUILT_IN_TOOLS_ADAPTER_ID, mcpServerDestinationRef, type MCPServerConfig } from "@ai-orchestrator/shared";
import { BuiltInToolsMCPServerAdapter, builtInToolDefinitions, type BuiltInToolsFetch } from "./built-in-tools";
import { createDefaultMCPRegistry } from "../index";
import { createRecordingRegistry, McpCassetteRecorder } from "../cassette";
import { summarizeToolArguments } from "../tool-argument-summary";
import type { MCPExecutionContext } from "../types";

const SERP_KEY = "serp-live-key-7f3a9c2e41";
const WOLFRAM_APPID = "WOLF-APPID-55aa77";

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(handler: (url: URL) => { status?: number; body: unknown; text?: boolean }) {
  const calls: Call[] = [];
  const fetchImpl: BuiltInToolsFetch = async (url, init) => {
    calls.push({ url, init });
    const answer = handler(new URL(url));
    const body = answer.text ? String(answer.body) : JSON.stringify(answer.body);
    return new Response(body, { status: answer.status ?? 200, headers: { "content-type": answer.text ? "text/plain" : "application/json" } });
  };
  return { calls, fetchImpl };
}

function contextWith(secrets: Record<string, string> = {}): MCPExecutionContext {
  return { resolveSecret: async (ref) => (ref ? secrets[ref.secretId] : undefined) };
}

function config(provider: string, extra: Partial<MCPServerConfig> & { connection?: Record<string, unknown> } = {}): MCPServerConfig {
  const { connection, ...rest } = extra;
  return { serverId: BUILT_IN_TOOLS_ADAPTER_ID, connection: { provider, ...connection }, ...rest };
}

describe("built-in tools adapter", () => {
  it("is registered in the default registry and lists each provider's read-only, open-world tools", async () => {
    const adapter = createDefaultMCPRegistry().get(BUILT_IN_TOOLS_ADAPTER_ID);
    const wikipedia = await adapter.discoverTools(config("wikipedia"), contextWith());
    expect(wikipedia.map((tool) => tool.name)).toEqual(["wikipedia_search", "wikipedia_page"]);
    for (const provider of ["searxng", "serpapi", "wolfram"]) {
      const tools = await adapter.discoverTools(config(provider), contextWith());
      expect(tools.length).toBe(1);
      expect(tools[0]!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    }
    await expect(adapter.discoverTools({ serverId: BUILT_IN_TOOLS_ADAPTER_ID, connection: {} }, contextWith())).rejects.toThrow(/provider/);
    // Definitions are copies: a caller cannot change what the next run sees.
    builtInToolDefinitions("wikipedia")[0]!.annotations!.readOnlyHint = false;
    expect(builtInToolDefinitions("wikipedia")[0]!.annotations!.readOnlyHint).toBe(true);
  });

  it("searches Wikipedia in the configured language edition and reads a page summary", async () => {
    const { calls, fetchImpl } = mockFetch((url) =>
      url.pathname === "/w/api.php"
        ? { body: { query: { search: [{ title: "Model Context Protocol", snippet: 'An <span class="searchmatch">open</span> protocol &amp; more' }] } } }
        : { body: { title: "Model Context Protocol", description: "protocol", extract: "MCP is a protocol.", content_urls: { desktop: { page: "https://de.wikipedia.org/wiki/MCP" } } } }
    );
    const adapter = new BuiltInToolsMCPServerAdapter({ fetch: fetchImpl });
    const search = await adapter.invokeTool("wikipedia_search", { query: "mcp", limit: 3 }, config("wikipedia", { connection: { language: "de" } }), contextWith());
    expect(search).toMatchObject({
      ok: true,
      output: { query: "mcp", results: [{ title: "Model Context Protocol", snippet: "An open protocol & more", url: "https://de.wikipedia.org/wiki/Model_Context_Protocol" }] }
    });
    const searchUrl = new URL(calls[0]!.url);
    expect(searchUrl.origin).toBe("https://de.wikipedia.org");
    expect(searchUrl.searchParams.get("srsearch")).toBe("mcp");
    expect(searchUrl.searchParams.get("srlimit")).toBe("3");
    expect(new Headers(calls[0]!.init.headers).get("user-agent")).toMatch(/L2M/);

    const page = await adapter.invokeTool("wikipedia_page", { title: "Model Context Protocol" }, config("wikipedia", { connection: { language: "de" } }), contextWith());
    expect(page).toMatchObject({ ok: true, output: { found: true, extract: "MCP is a protocol.", url: "https://de.wikipedia.org/wiki/MCP" } });
    expect(new URL(calls[1]!.url).pathname).toBe("/api/rest_v1/page/summary/Model_Context_Protocol");
  });

  it("reports a missing Wikipedia page as not found, and refuses calls without the required argument", async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 404, body: { type: "not_found" } }));
    const adapter = new BuiltInToolsMCPServerAdapter({ fetch: fetchImpl });
    expect(await adapter.invokeTool("wikipedia_page", { title: "Nope" }, config("wikipedia"), contextWith())).toMatchObject({ ok: true, output: { found: false } });
    expect(await adapter.invokeTool("wikipedia_search", {}, config("wikipedia"), contextWith())).toMatchObject({ ok: false, errorKind: "invalid_arguments" });
    expect(await adapter.invokeTool("searxng_search", { query: "x" }, config("wikipedia"), contextWith())).toMatchObject({ ok: false, errorKind: "invalid_arguments" });
  });

  it("searches a SearXNG instance with format=json and an optional bearer token", async () => {
    const { calls, fetchImpl } = mockFetch(() => ({
      body: { results: [{ title: "L2M", url: "https://lsquarem.com", content: "Agent ops", engine: "duckduckgo" }], answers: ["42"] }
    }));
    const adapter = new BuiltInToolsMCPServerAdapter({ fetch: fetchImpl });
    const missing = await adapter.invokeTool("searxng_search", { query: "l2m" }, config("searxng"), contextWith());
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/endpoint/) });
    expect(calls).toHaveLength(0);

    const result = await adapter.invokeTool(
      "searxng_search",
      { query: "l2m", categories: "general" },
      config("searxng", { connection: { endpoint: "https://search.example.org/" }, secretRef: { secretId: "sx" } }),
      contextWith({ sx: "searx-token-1234" })
    );
    expect(result).toMatchObject({ ok: true, output: { results: [{ title: "L2M", url: "https://lsquarem.com", snippet: "Agent ops" }], answers: ["42"] } });
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://search.example.org/search");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("categories")).toBe("general");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer searx-token-1234");
    expect(JSON.stringify(result)).not.toContain("searx-token-1234");
  });

  it("calls SerpAPI with the key from the secret, never from the arguments, and keeps it out of results and errors", async () => {
    let status = 200;
    const { calls, fetchImpl } = mockFetch(() =>
      status === 200
        ? { body: { organic_results: [{ title: "Result", link: "https://example.com", snippet: "Snippet" }], answer_box: { answer: "Yes" } } }
        : { status, body: { error: `Invalid API key ${SERP_KEY}` } }
    );
    const adapter = new BuiltInToolsMCPServerAdapter({ fetch: fetchImpl });
    const withoutKey = await adapter.invokeTool("serpapi_search", { query: "x" }, config("serpapi"), contextWith());
    expect(withoutKey).toMatchObject({ ok: false, errorKind: "credentials" });
    expect(calls).toHaveLength(0);

    const serp = config("serpapi", { secretRef: { secretId: "serp" } });
    const result = await adapter.invokeTool("serpapi_search", { query: "is l2m self hosted", location: "Austin, Texas", api_key: "from-the-model" }, serp, contextWith({ serp: SERP_KEY }));
    expect(result).toMatchObject({ ok: true, output: { results: [{ title: "Result", url: "https://example.com", snippet: "Snippet" }], answer: "Yes" } });
    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe("https://serpapi.com");
    expect(url.searchParams.get("api_key")).toBe(SERP_KEY);
    expect(url.searchParams.getAll("api_key")).toHaveLength(1);
    expect(url.searchParams.get("location")).toBe("Austin, Texas");
    expect(JSON.stringify(result)).not.toContain(SERP_KEY);

    status = 401;
    const failed = await adapter.invokeTool("serpapi_search", { query: "x" }, serp, contextWith({ serp: SERP_KEY }));
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("[REDACTED]");
    expect(JSON.stringify(failed)).not.toContain(SERP_KEY);
  });

  it("scrubs the key from a transport error that quotes the request URL", async () => {
    const adapter = new BuiltInToolsMCPServerAdapter({
      fetch: async (url) => {
        throw new TypeError(`fetch failed for ${url}`);
      }
    });
    const result = await adapter.invokeTool("wolfram_alpha", { input: "2+2" }, config("wolfram", { secretRef: { secretId: "w" } }), contextWith({ w: WOLFRAM_APPID }));
    expect(result).toMatchObject({ ok: false, errorKind: "transport" });
    expect(result.error).not.toContain(WOLFRAM_APPID);
  });

  it("scrubs a key with characters a query string encodes its own way", async () => {
    const oddKey = "WOLF key+(!)~'*";
    const adapter = new BuiltInToolsMCPServerAdapter({
      fetch: async (url) => {
        throw new TypeError(`fetch failed for ${url}`);
      }
    });
    const result = await adapter.invokeTool("wolfram_alpha", { input: "2+2" }, config("wolfram", { secretRef: { secretId: "w" } }), contextWith({ w: oddKey }));
    expect(result).toMatchObject({ ok: false, errorKind: "transport" });
    const queryEncoded = new URLSearchParams({ k: oddKey }).toString().slice(2);
    expect(queryEncoded).not.toBe(encodeURIComponent(oddKey));
    expect(result.error).not.toContain(queryEncoded);
    expect(result.error).toContain("[REDACTED]");
  });

  it("asks the Wolfram Alpha LLM API with the AppID and reports a query it cannot interpret", async () => {
    let status = 200;
    const { calls, fetchImpl } = mockFetch(() => ({ status, body: status === 200 ? "Result: 4" : "Wolfram|Alpha did not understand your input", text: true }));
    const adapter = new BuiltInToolsMCPServerAdapter({ fetch: fetchImpl });
    const wolfram = config("wolfram", { secretRef: { secretId: "w" } });
    expect(await adapter.invokeTool("wolfram_alpha", { input: "2+2" }, wolfram, contextWith({ w: WOLFRAM_APPID }))).toMatchObject({ ok: true, output: { answered: true, answer: "Result: 4" } });
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://www.wolframalpha.com/api/v1/llm-api");
    expect(url.searchParams.get("appid")).toBe(WOLFRAM_APPID);
    status = 501;
    expect(await adapter.invokeTool("wolfram_alpha", { input: "blorp" }, wolfram, contextWith({ w: WOLFRAM_APPID }))).toMatchObject({ ok: true, output: { answered: false } });
    status = 403;
    const denied = await adapter.invokeTool("wolfram_alpha", { input: "2+2" }, wolfram, contextWith({ w: WOLFRAM_APPID }));
    expect(denied).toMatchObject({ ok: false, error: expect.stringMatching(/AppID/) });
  });

  it("refuses an answer larger than the response cap", async () => {
    const { fetchImpl } = mockFetch(() => ({ body: { results: [{ title: "x".repeat(5_000) }] } }));
    const adapter = new BuiltInToolsMCPServerAdapter({ fetch: fetchImpl, maxResponseBytes: 1_000 });
    const result = await adapter.invokeTool("searxng_search", { query: "x" }, config("searxng", { connection: { endpoint: "https://s.example.org" } }), contextWith());
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/larger than/) });
  });

  it("stops reading a streamed answer with no content-length once it passes the cap", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode("x".repeat(512));
    const adapter = new BuiltInToolsMCPServerAdapter({
      maxResponseBytes: 2_000,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              // An endless chunked body: only the cap ends the read.
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    });
    const result = await adapter.invokeTool("searxng_search", { query: "x" }, config("searxng", { connection: { endpoint: "https://s.example.org" } }), contextWith());
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/larger than 2000 bytes/) });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it("never records the key in a cassette or an argument summary", async () => {
    const { fetchImpl } = mockFetch(() => ({ body: { organic_results: [{ title: "Result", link: "https://example.com", snippet: `echo ${SERP_KEY}` }] } }));
    const recorder = new McpCassetteRecorder();
    const registry = createRecordingRegistry(createDefaultMCPRegistry({ builtInTools: { fetch: fetchImpl } }), recorder);
    const serp = config("serpapi", { secretRef: { secretId: "serp" } });
    const context = contextWith({ serp: SERP_KEY });
    const adapter = registry.get(BUILT_IN_TOOLS_ADAPTER_ID);
    await adapter.discoverTools(serp, context);
    const result = await adapter.invokeTool("serpapi_search", { query: "weather" }, serp, context);
    expect(result.ok).toBe(true);
    const cassette = JSON.stringify(recorder.toCassette());
    expect(cassette).toContain("serpapi_search");
    expect(cassette).not.toContain(SERP_KEY);

    const summary = summarizeToolArguments({ query: "weather" }, { detect: () => [], hashKey: new Uint8Array(32).fill(7) });
    expect(JSON.stringify(summary)).not.toContain(SERP_KEY);
  });

  it("gives destination rules the provider's real endpoint", () => {
    expect(mcpServerDestinationRef({ serverId: BUILT_IN_TOOLS_ADAPTER_ID, connection: { provider: "wikipedia", language: "fr" } })).toMatchObject({ host: "fr.wikipedia.org" });
    expect(mcpServerDestinationRef({ serverId: BUILT_IN_TOOLS_ADAPTER_ID, connection: { provider: "serpapi" } })).toMatchObject({ host: "serpapi.com" });
    expect(mcpServerDestinationRef({ serverId: BUILT_IN_TOOLS_ADAPTER_ID, connection: { provider: "searxng", endpoint: "http://10.0.0.5:8080" } })).toMatchObject({ host: "10.0.0.5" });
  });
});
