import { describe, expect, it } from "vitest";
import {
  MCP_CLIENT_LEGACY_PROTOCOL_VERSION,
  MCP_CLIENT_MODERN_PROTOCOL_VERSION,
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_CLIENT_INFO,
  MCP_META_PROTOCOL_VERSION,
  isMcpLegacyImplementationErrorCode,
  isMcpSpecReservedErrorCode,
  isMrtrMethod
} from "./constants";
import { buildModernRequestMeta, inspectRequestMeta, isReservedMetaKey, isValidMetaKey, modernRequestMetaFor, withRequestMeta } from "./meta";

const sampler = async () => ({ role: "assistant" as const, content: { type: "text" as const, text: "" }, model: "m" });

describe("protocol constants", () => {
  it("keeps the legacy offer unchanged and speaks 2026-07-28 as modern", () => {
    expect(MCP_CLIENT_LEGACY_PROTOCOL_VERSION).toBe("2025-06-18");
    expect(MCP_CLIENT_MODERN_PROTOCOL_VERSION).toBe("2026-07-28");
  });

  it("partitions the implementation-defined error range as the spec does", () => {
    expect(isMcpSpecReservedErrorCode(-32020)).toBe(true);
    expect(isMcpSpecReservedErrorCode(-32029)).toBe(true);
    expect(isMcpSpecReservedErrorCode(-32099)).toBe(true);
    expect(isMcpSpecReservedErrorCode(-32019)).toBe(false);
    expect(isMcpSpecReservedErrorCode(-32100)).toBe(false);
    expect(isMcpSpecReservedErrorCode(-31029)).toBe(false);
    expect(isMcpLegacyImplementationErrorCode(-32000)).toBe(true);
    expect(isMcpLegacyImplementationErrorCode(-32019)).toBe(true);
    expect(isMcpLegacyImplementationErrorCode(-32020)).toBe(false);
  });

  it("knows the three methods that may answer input_required", () => {
    expect(["tools/call", "resources/read", "prompts/get"].every(isMrtrMethod)).toBe(true);
    expect(isMrtrMethod("tools/list")).toBe(false);
    expect(isMrtrMethod("server/discover")).toBe(false);
  });
});

describe("request _meta", () => {
  it("builds the required modern keys plus L2M's client info", () => {
    expect(buildModernRequestMeta({ protocolVersion: "2026-07-28", clientCapabilities: {} })).toEqual({
      [MCP_META_PROTOCOL_VERSION]: "2026-07-28",
      [MCP_META_CLIENT_CAPABILITIES]: {},
      [MCP_META_CLIENT_INFO]: { name: "ai-orchestrator", version: "0.1.0" }
    });
    expect(buildModernRequestMeta({ protocolVersion: "2026-07-28", clientCapabilities: {}, clientInfo: false })).not.toHaveProperty(MCP_META_CLIENT_INFO);
  });

  it("declares sampling only when the context has a handler, as initialize does", () => {
    expect(modernRequestMetaFor({}, "2026-07-28")[MCP_META_CLIENT_CAPABILITIES]).toEqual({ elicitation: {} });
    expect(modernRequestMetaFor({ onSampling: sampler }, "2026-07-28")[MCP_META_CLIENT_CAPABILITIES]).toEqual({ elicitation: {}, sampling: {} });
  });

  it("merges into existing _meta without dropping the progress token, trace context or vendor keys", () => {
    const params = {
      name: "lookup",
      arguments: { q: "x" },
      _meta: { progressToken: "p-1", traceparent: "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01", "com.example/k": 1 }
    };
    const merged = withRequestMeta(params, modernRequestMetaFor({}, "2026-07-28"));
    expect(merged._meta).toEqual({
      progressToken: "p-1",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01",
      "com.example/k": 1,
      [MCP_META_PROTOCOL_VERSION]: "2026-07-28",
      [MCP_META_CLIENT_CAPABILITIES]: { elicitation: {} },
      [MCP_META_CLIENT_INFO]: { name: "ai-orchestrator", version: "0.1.0" }
    });
    expect(merged.arguments).toBe(params.arguments);
    // Neither input is modified.
    expect(params._meta).toEqual({ progressToken: "p-1", traceparent: "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01", "com.example/k": 1 });
  });

  it("lets a later writer add its keys and skips undefined values", () => {
    const first = withRequestMeta({ uri: "file:///a" }, { [MCP_META_PROTOCOL_VERSION]: "2026-07-28" });
    const second = withRequestMeta(first, { traceparent: "t", tracestate: undefined });
    expect(second._meta).toEqual({ [MCP_META_PROTOCOL_VERSION]: "2026-07-28", traceparent: "t" });
    expect(withRequestMeta(undefined, { a: 1 })).toEqual({ _meta: { a: 1 } });
    expect(withRequestMeta({ _meta: "junk" } as Record<string, unknown>, { a: 1 })._meta).toEqual({ a: 1 });
  });

  it("checks _meta key format and reserved prefixes", () => {
    expect(isValidMetaKey("io.modelcontextprotocol/protocolVersion")).toBe(true);
    expect(isValidMetaKey("traceparent")).toBe(true);
    expect(isValidMetaKey("com.example-co/my_key.v2")).toBe(true);
    expect(isValidMetaKey("1io/x")).toBe(false);
    expect(isValidMetaKey("io./x")).toBe(false);
    expect(isValidMetaKey("io.example/-bad")).toBe(false);
    expect(isReservedMetaKey("io.modelcontextprotocol/anything")).toBe(true);
    expect(isReservedMetaKey("dev.mcp/x")).toBe(true);
    expect(isReservedMetaKey("com.example.mcp/x")).toBe(false);
    expect(isReservedMetaKey("traceparent")).toBe(true);
  });
});

describe("inspectRequestMeta (server side)", () => {
  it("treats requests without the protocol version key as legacy, whatever else _meta holds", () => {
    expect(inspectRequestMeta(undefined)).toEqual({ era: "legacy" });
    expect(inspectRequestMeta({ protocolVersion: "2025-11-25", capabilities: {} })).toEqual({ era: "legacy" });
    expect(inspectRequestMeta({ _meta: { progressToken: 1 } })).toEqual({ era: "legacy" });
    expect(inspectRequestMeta({ _meta: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01" } })).toEqual({ era: "legacy" });
  });

  it("reads a modern request and lists missing required keys", () => {
    const full = inspectRequestMeta({ _meta: modernRequestMetaFor({}, "2026-07-28") });
    expect(full).toEqual({
      era: "modern",
      protocolVersion: "2026-07-28",
      clientCapabilities: { elicitation: {} },
      clientInfo: { name: "ai-orchestrator", version: "0.1.0" },
      missing: []
    });
    expect(inspectRequestMeta({ _meta: { [MCP_META_PROTOCOL_VERSION]: "2026-07-28" } })).toEqual({
      era: "modern",
      protocolVersion: "2026-07-28",
      missing: [MCP_META_CLIENT_CAPABILITIES]
    });
    expect(inspectRequestMeta({ _meta: { [MCP_META_PROTOCOL_VERSION]: 7, [MCP_META_CLIENT_CAPABILITIES]: [], [MCP_META_CLIENT_INFO]: { name: 1 } } })).toEqual({
      era: "modern",
      missing: [MCP_META_PROTOCOL_VERSION, MCP_META_CLIENT_CAPABILITIES]
    });
  });
});
