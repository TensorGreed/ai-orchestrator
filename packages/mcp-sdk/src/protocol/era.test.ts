import { describe, expect, it } from "vitest";
import { normalizeServerCapabilities } from "../client-features";
import { McpJsonRpcError, classifyMcpError } from "../errors";
import {
  McpEraCache,
  chooseMcpProtocolVersion,
  classifyHttpEraResponse,
  classifyStdioEraProbe,
  httpEraCacheKey,
  initializeRejectionIsModern,
  isSupportedModernVersion,
  parseDiscoverResult,
  parseMcpClientProtocolMode,
  parseMcpModernError,
  protocolEraOf,
  resolveMcpClientProtocolMode,
  stdioEraCacheKey
} from "./era";

const rpcError = (code: number, data?: unknown, message = "x") => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const unsupported = { supported: ["2026-07-28", "2025-11-25"], requested: "1900-01-01" };

describe("protocol mode", () => {
  it("reads a connection's protocolMode and falls back to the deployment default, then legacy", () => {
    expect(parseMcpClientProtocolMode(" Auto ")).toBe("auto");
    expect(parseMcpClientProtocolMode("stateless")).toBeUndefined();
    expect(parseMcpClientProtocolMode(1)).toBeUndefined();
    expect(resolveMcpClientProtocolMode({ protocolMode: "modern" }, "auto")).toBe("modern");
    expect(resolveMcpClientProtocolMode({ protocolMode: "junk" }, "auto")).toBe("auto");
    expect(resolveMcpClientProtocolMode({}, undefined)).toBe("legacy");
    expect(resolveMcpClientProtocolMode(undefined)).toBe("legacy");
  });
});

describe("versions", () => {
  it("assigns eras by date", () => {
    expect(protocolEraOf("2026-07-28")).toBe("modern");
    expect(protocolEraOf("2027-01-15")).toBe("modern");
    expect(protocolEraOf("2025-11-25")).toBe("legacy");
    expect(protocolEraOf("2024-11-05")).toBe("legacy");
    expect(protocolEraOf("draft")).toBeUndefined();
    expect(protocolEraOf(20260728)).toBeUndefined();
    expect(isSupportedModernVersion("2026-07-28")).toBe(true);
    expect(isSupportedModernVersion("2027-01-15")).toBe(false);
  });

  it("chooses the newest mutual modern version, else legacy when allowed", () => {
    expect(chooseMcpProtocolVersion(["2027-01-15", "2026-07-28", "2025-11-25"])).toEqual({ era: "modern", version: "2026-07-28" });
    expect(chooseMcpProtocolVersion(["2025-11-25"], { allowLegacy: true })).toEqual({ era: "legacy" });
    expect(chooseMcpProtocolVersion(["2025-11-25"])).toEqual({ era: "none" });
    expect(chooseMcpProtocolVersion(["2027-01-15", 7], { allowLegacy: true })).toEqual({ era: "none" });
  });
});

describe("modern error recognition", () => {
  it("recognises the three spec errors with their data", () => {
    expect(parseMcpModernError({ code: -32020, message: "Header mismatch" })).toEqual({ kind: "header_mismatch", code: -32020, message: "Header mismatch" });
    expect(parseMcpModernError({ code: -32021, message: "m", data: { requiredCapabilities: { elicitation: {} } } })).toEqual({
      kind: "missing_client_capability",
      code: -32021,
      message: "m",
      requiredCapabilities: { elicitation: {} }
    });
    expect(parseMcpModernError({ code: -32022, message: "Unsupported protocol version", data: unsupported })).toEqual({
      kind: "unsupported_version",
      code: -32022,
      message: "Unsupported protocol version",
      supported: ["2026-07-28", "2025-11-25"],
      requested: "1900-01-01"
    });
  });

  it("does not recognise -32022 without a supported list, or other codes", () => {
    expect(parseMcpModernError({ code: -32022, message: "x" })).toBeNull();
    expect(parseMcpModernError({ code: -32022, data: { supported: [1] } })).toBeNull();
    expect(parseMcpModernError({ code: -32000, message: "Mcp-Session-Id header is required" })).toBeNull();
    expect(parseMcpModernError({ code: -32602 })).toBeNull();
    expect(parseMcpModernError(null)).toBeNull();
  });

  it("keeps a JSON-RPC error's data for callers that act on it", () => {
    const error = new McpJsonRpcError("Unsupported protocol version", -32022, unsupported);
    expect(parseMcpModernError({ code: error.code, message: error.message, data: error.data })?.kind).toBe("unsupported_version");
    expect(classifyMcpError(error)).toBe("protocol");
    expect(new McpJsonRpcError("legacy", -32601).data).toBeUndefined();
  });
});

describe("HTTP era detection", () => {
  it("treats 2xx and recognised modern errors as modern", () => {
    expect(classifyHttpEraResponse(200, "")).toEqual({ era: "modern" });
    expect(classifyHttpEraResponse(400, rpcError(-32022, unsupported))).toMatchObject({ era: "modern", error: { kind: "unsupported_version" } });
    expect(classifyHttpEraResponse(400, rpcError(-32020))).toMatchObject({ era: "modern", error: { kind: "header_mismatch" } });
    expect(classifyHttpEraResponse(400, rpcError(-32021, { requiredCapabilities: { sampling: {} } }))).toMatchObject({
      era: "modern",
      error: { kind: "missing_client_capability" }
    });
    expect(classifyHttpEraResponse(404, rpcError(-32601))).toEqual({ era: "modern", methodNotFound: true });
  });

  it("falls back to legacy on other 4xx answers, including today's gateway and session errors", () => {
    expect(classifyHttpEraResponse(400, "")).toEqual({ era: "legacy" });
    expect(classifyHttpEraResponse(400, rpcError(-32000, undefined, "Mcp-Session-Id header is required; send initialize first."))).toEqual({ era: "legacy" });
    expect(classifyHttpEraResponse(400, rpcError(-32602))).toEqual({ era: "legacy" });
    expect(classifyHttpEraResponse(400, "Bad Request: No valid session ID provided")).toEqual({ era: "legacy" });
    expect(classifyHttpEraResponse(404, "<html>Not Found</html>")).toEqual({ era: "legacy" });
    expect(classifyHttpEraResponse(404, rpcError(-32001))).toEqual({ era: "legacy" });
    expect(classifyHttpEraResponse(405, "")).toEqual({ era: "legacy" });
    expect(classifyHttpEraResponse(406, rpcError(-32022, unsupported))).toEqual({ era: "legacy" });
  });

  it("does not decide the era from credential, rate-limit or server errors", () => {
    for (const status of [401, 403, 407, 408, 429, 500, 502, 503, 302]) {
      expect(classifyHttpEraResponse(status, rpcError(-32022, unsupported))).toEqual({ era: "unknown" });
    }
  });

  it("switches a legacy-mode client forward only on a modern rejection of initialize", () => {
    expect(initializeRejectionIsModern({ transport: "http", status: 400, bodyText: rpcError(-32022, { supported: ["2026-07-28"] }) })).toBe(true);
    expect(initializeRejectionIsModern({ transport: "http", status: 400, bodyText: rpcError(-32020) })).toBe(true);
    expect(initializeRejectionIsModern({ transport: "http", status: 400, bodyText: rpcError(-32602) })).toBe(false);
    expect(initializeRejectionIsModern({ transport: "http", status: 404, bodyText: rpcError(-32601) })).toBe(false);
    expect(initializeRejectionIsModern({ transport: "http", status: 500, bodyText: rpcError(-32022, { supported: ["2026-07-28"] }) })).toBe(false);
    expect(initializeRejectionIsModern({ transport: "stdio", error: { code: -32601, message: "x", data: { supported: ["2026-07-28"] } } })).toBe(true);
    expect(initializeRejectionIsModern({ transport: "stdio", error: { code: -32602, data: { supported: ["2025-06-18"] } } })).toBe(false);
    expect(initializeRejectionIsModern({ transport: "stdio", error: { code: -32601, message: "Method not found" } })).toBe(false);
  });
});

describe("stdio era detection", () => {
  const discover = {
    resultType: "complete",
    supportedVersions: ["2026-07-28"],
    capabilities: { tools: { listChanged: true }, extensions: { "io.modelcontextprotocol/tasks": {} } },
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "Example", version: "1.0.0" } },
    instructions: "Weather tools.",
    ttlMs: 3600000,
    cacheScope: "public"
  };

  it("is modern on a discover result or a recognised modern error", () => {
    expect(classifyStdioEraProbe({ result: discover })).toEqual({
      era: "modern",
      discover: {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: { listChanged: true }, extensions: { "io.modelcontextprotocol/tasks": {} } },
        instructions: "Weather tools.",
        serverInfo: { name: "Example", version: "1.0.0" },
        ttlMs: 3600000,
        cacheScope: "public"
      }
    });
    expect(classifyStdioEraProbe({ error: { code: -32022, message: "x", data: unsupported } })).toMatchObject({ era: "modern", error: { kind: "unsupported_version" } });
  });

  it("is legacy on any other error, on a non-discover answer and on a timeout (never keyed to one code)", () => {
    expect(classifyStdioEraProbe({ error: { code: -32601, message: "Method not found" } })).toEqual({ era: "legacy" });
    expect(classifyStdioEraProbe({ error: { code: -32602, message: "Server not initialized" } })).toEqual({ era: "legacy" });
    expect(classifyStdioEraProbe({ error: { code: -32000, message: "x" } })).toEqual({ era: "legacy" });
    expect(classifyStdioEraProbe({ result: {} })).toEqual({ era: "legacy" });
    expect(classifyStdioEraProbe({ result: { supportedVersions: ["2026-07-28"], resultType: "input_required" } })).toEqual({ era: "legacy" });
    expect(classifyStdioEraProbe({ timedOut: true })).toEqual({ era: "legacy" });
  });

  it("parses discover results defensively", () => {
    expect(parseDiscoverResult({ supportedVersions: ["2026-07-28", 3], capabilities: "x", ttlMs: -1, cacheScope: "shared", _meta: { "io.modelcontextprotocol/serverInfo": { name: "n" } } })).toEqual({
      supportedVersions: ["2026-07-28"],
      capabilities: {}
    });
    expect(parseDiscoverResult(null)).toBeNull();
  });
});

describe("server capabilities", () => {
  it("keeps declared extensions and drops malformed ones; servers without them are unchanged", () => {
    expect(normalizeServerCapabilities({ tools: {}, extensions: { "io.modelcontextprotocol/tasks": {}, "com.example/x": { a: 1 }, bad: true } })).toEqual({
      tools: {},
      extensions: { "io.modelcontextprotocol/tasks": {}, "com.example/x": { a: 1 } }
    });
    expect(normalizeServerCapabilities({ tools: {}, extensions: { bad: 1 } })).toEqual({ tools: {} });
    expect(normalizeServerCapabilities({ tools: {}, extensions: [] })).toEqual({ tools: {} });
  });
});

describe("era cache", () => {
  it("expires entries, keeps the newest within its bound and can be invalidated", () => {
    let now = 0;
    const cache = new McpEraCache({ ttlMs: 1000, maxEntries: 2, now: () => now });
    cache.set("a", "modern", "2026-07-28");
    expect(cache.get("a")).toEqual({ era: "modern", version: "2026-07-28", observedAt: 0 });
    now = 999;
    expect(cache.get("a")?.era).toBe("modern");
    now = 1000;
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", "legacy");
    cache.set("b", "legacy");
    cache.set("c", "modern");
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    cache.invalidate("b");
    expect(cache.get("b")).toBeUndefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("keys HTTP servers by origin and path, stdio servers by a hash of the launch plan", () => {
    expect(httpEraCacheKey("https://Example.com:443/mcp?token=abc#x")).toBe("http:https://example.com/mcp");
    expect(httpEraCacheKey("https://example.com/other")).not.toBe(httpEraCacheKey("https://example.com/mcp"));
    const plan = { command: "npx", args: ["server"], env: { API_KEY: "s3cret" } };
    const key = stdioEraCacheKey(plan);
    expect(key).toMatch(/^stdio:[0-9a-f]{64}$/);
    expect(key).not.toContain("s3cret");
    expect(stdioEraCacheKey({ env: { API_KEY: "s3cret" }, args: ["server"], command: "npx" })).toBe(key);
    expect(stdioEraCacheKey({ ...plan, args: ["other"] })).not.toBe(key);
  });
});
