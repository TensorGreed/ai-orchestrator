import { describe, expect, it } from "vitest";
import { headerLookupFrom } from "@ai-orchestrator/mcp-sdk";
import {
  gatewayCorsAllowedHeaders,
  gatewayDiscoverResult,
  gatewaySupportedVersions,
  isModernGatewayMessage,
  modernGatewayErrorCode,
  modernizeGatewayResponse,
  sortToolsByName,
  stripDescriptorHeaderAnnotations,
  validateModernGatewayMessage
} from "./mcp-gateway-modern.js";
import { JSON_RPC_ERRORS, rpcError, rpcResult } from "./mcp-gateway-protocol.js";
import crypto from "node:crypto";
import { parseConfig, resolveNetworkSettings } from "../config.js";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "c", version: "1" }
};
const HEADERS = { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" };
const SERVER_INFO = { name: "l2m-x", version: "0.1.0" };

describe("isModernGatewayMessage", () => {
  it("is modern only for a single non-initialize message with the protocol version key in _meta", () => {
    expect(isModernGatewayMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } })).toBe(true);
    // A malformed value still makes it modern (answered with -32602, not with the session error).
    expect(isModernGatewayMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": 5 } } })).toBe(true);
    expect(isModernGatewayMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: { _meta: META } })).toBe(true);
    expect(isModernGatewayMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { _meta: META } })).toBe(false);
    expect(isModernGatewayMessage([{ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } }])).toBe(false);
    expect(isModernGatewayMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe(false);
    expect(isModernGatewayMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01" } } })).toBe(false);
    expect(isModernGatewayMessage({ jsonrpc: "2.0", id: 1, result: {} })).toBe(false);
    expect(isModernGatewayMessage("text")).toBe(false);
  });
});

describe("validateModernGatewayMessage", () => {
  const validate = (message: unknown, headers: Record<string, string> = HEADERS) => validateModernGatewayMessage(message, headerLookupFrom(headers), "on");

  it("accepts a well-formed request and returns its version and truncated client info", () => {
    const longName = "n".repeat(300);
    const outcome = validate({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { ...META, "io.modelcontextprotocol/clientInfo": { name: longName, version: "1" } } } });
    expect(outcome).toMatchObject({ ok: true, kind: "request", protocolVersion: "2026-07-28", clientInfo: { name: "n".repeat(200), version: "1" } });
  });

  it("checks the version before the headers, the headers before the other _meta keys", () => {
    // Unsupported version with wrong headers: -32022 wins.
    const future = validate({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2030-01-01" } } }, {});
    expect(future).toMatchObject({ ok: false, status: 400, response: { error: { code: -32022, data: { requested: "2030-01-01", supported: gatewaySupportedVersions("on") } } } });
    // Good version, missing capabilities and wrong headers: -32020 wins.
    const headers = validate({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }, {});
    expect(headers).toMatchObject({ ok: false, status: 400, response: { error: { code: -32020 } } });
    // Headers right, capabilities missing: -32602.
    const capabilities = validate({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } });
    expect(capabilities).toMatchObject({ ok: false, status: 400, response: { error: { code: -32602, data: { missing: ["io.modelcontextprotocol/clientCapabilities"] } } } });
    // A version key of the wrong type: -32602 before anything else.
    const wrongType = validate({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": 7 } } }, {});
    expect(wrongType).toMatchObject({ ok: false, status: 400, response: { error: { code: -32602 } } });
  });

  it("rejects invalid JSON-RPC and accepts notifications without further checks", () => {
    expect(validate({ jsonrpc: "1.0", id: 1, method: "tools/list", params: { _meta: META } })).toMatchObject({ ok: false, status: 400, response: { error: { code: -32600 } } });
    expect(validate({ jsonrpc: "2.0", method: "notifications/x", params: { _meta: META } }, {})).toMatchObject({ ok: true, kind: "notification" });
  });

  it("checks Mcp-Name, decoded, for tools/call", () => {
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "réponse", arguments: {}, _meta: META } };
    const base = { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call" };
    expect(validate(call, base)).toMatchObject({ ok: false, response: { error: { code: -32020 } } });
    expect(validate(call, { ...base, "Mcp-Name": `=?base64?${Buffer.from("réponse").toString("base64")}?=` })).toMatchObject({ ok: true });
    expect(validate(call, { ...base, "Mcp-Name": "reponse" })).toMatchObject({ ok: false, response: { error: { code: -32020 } } });
  });

  it("does not validate or require trace context in _meta", () => {
    const outcome = validate({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { ...META, traceparent: "not-w3c", tracestate: 5, baggage: null } } });
    expect(outcome).toMatchObject({ ok: true });
  });
});

describe("modern error codes (D7)", () => {
  it("moves the gateway's own reserved-range codes out of the JSON-RPC range and keeps everything else", () => {
    expect(modernGatewayErrorCode(JSON_RPC_ERRORS.retryLater)).toBe(-31029);
    expect(modernGatewayErrorCode(JSON_RPC_ERRORS.approvalPending)).toBe(-31030);
    expect(modernGatewayErrorCode(JSON_RPC_ERRORS.approvalRejected)).toBe(-31031);
    expect(modernGatewayErrorCode(JSON_RPC_ERRORS.budgetExceeded)).toBe(-31032);
    for (const kept of [-32020, -32021, -32022, -32600, -32601, -32602, -32603, -32700, -32800, -32000, -32001]) {
      expect(modernGatewayErrorCode(kept)).toBe(kept);
    }
    for (const code of [JSON_RPC_ERRORS.retryLater, JSON_RPC_ERRORS.approvalPending, JSON_RPC_ERRORS.approvalRejected, JSON_RPC_ERRORS.budgetExceeded]) {
      const mapped = modernGatewayErrorCode(code);
      expect(mapped < -32768 || mapped > -32000).toBe(true);
    }
  });

  it("modernizes results and errors without changing message or data", () => {
    const error = modernizeGatewayResponse(rpcError(3, JSON_RPC_ERRORS.approvalPending, "Approval pending: x", { approvalRequestId: "mga_1" }), SERVER_INFO);
    expect(error).toEqual({ jsonrpc: "2.0", id: 3, error: { code: -31030, message: "Approval pending: x", data: { approvalRequestId: "mga_1" } } });
    const result = modernizeGatewayResponse(rpcResult(4, { content: [], _meta: { executionId: "e1" } }), SERVER_INFO);
    expect(result).toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: { content: [], resultType: "complete", _meta: { executionId: "e1", "io.modelcontextprotocol/serverInfo": SERVER_INFO } }
    });
  });
});

describe("discover, lists and CORS", () => {
  it("lists modern and legacy versions only when modern mode is on", () => {
    expect(gatewaySupportedVersions("off")).toEqual(["2025-11-25", "2025-06-18", "2025-03-26"]);
    expect(gatewaySupportedVersions("on")).toEqual(["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]);
  });

  it("builds server/discover with private cache hints and instructions only when the toolset has a description", () => {
    expect(gatewayDiscoverResult({ toolset: { slug: "s", name: "S", description: "Use me" }, mode: "on", ttlMs: 1000 })).toEqual({
      supportedVersions: gatewaySupportedVersions("on"),
      capabilities: { tools: { listChanged: false } },
      instructions: "Use me",
      ttlMs: 1000,
      cacheScope: "private"
    });
    expect(gatewayDiscoverResult({ toolset: { slug: "s", name: "S", description: null }, mode: "on", ttlMs: 0 })).not.toHaveProperty("instructions");
  });

  it("sorts tools by name and strips x-mcp-header annotations, leaving properties of that name", () => {
    expect(sortToolsByName([{ name: "b" }, { name: "a_2" }, { name: "a_10" }]).map((tool) => tool.name)).toEqual(["a_10", "a_2", "b"]);
    const stripped = stripDescriptorHeaderAnnotations({
      name: "t",
      inputSchema: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" }, "x-mcp-header": { type: "string" } } }
    });
    expect(stripped).toEqual({ name: "t", inputSchema: { type: "object", properties: { region: { type: "string" }, "x-mcp-header": { type: "string" } } } });
    let deep: Record<string, unknown> = { type: "string", "x-mcp-header": "Deep" };
    for (let index = 0; index < 80; index += 1) deep = { type: "object", properties: { next: deep } };
    expect(stripDescriptorHeaderAnnotations({ name: "deep", inputSchema: deep })).toBeNull();
  });

  it("reflects only well-formed Mcp-Param-* headers, and nothing new with modern mode off", () => {
    expect(gatewayCorsAllowedHeaders("off", "mcp-method, mcp-param-a")).toEqual(["Authorization", "Content-Type", "Accept", "Mcp-Session-Id", "MCP-Protocol-Version", "Last-Event-ID"]);
    const on = gatewayCorsAllowedHeaders("on", ["Mcp-Param-Region, x-other", "mcp-param-bad name, mcp-param-, mcp-param-ok"]);
    expect(on).toEqual([
      "Authorization",
      "Content-Type",
      "Accept",
      "Mcp-Session-Id",
      "MCP-Protocol-Version",
      "Last-Event-ID",
      "Mcp-Method",
      "Mcp-Name",
      "mcp-param-region",
      "mcp-param-ok"
    ]);
    expect(gatewayCorsAllowedHeaders("on", `mcp-param-${"a".repeat(200)}`)).not.toContain(`mcp-param-${"a".repeat(200)}`);
  });
});

describe("configuration", () => {
  const BASE_ENV = { SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64") };

  it("keeps modern mode off and the list TTL unset unless configured; empty values mean the defaults", () => {
    const plain = parseConfig(BASE_ENV);
    expect(plain.MCP_GATEWAY_MODERN_PROTOCOL).toBeUndefined();
    expect(plain.MCP_GATEWAY_LIST_TTL_MS).toBeUndefined();
    const empty = parseConfig({ ...BASE_ENV, MCP_GATEWAY_MODERN_PROTOCOL: " ", MCP_GATEWAY_LIST_TTL_MS: "" });
    expect(empty.MCP_GATEWAY_MODERN_PROTOCOL).toBeUndefined();
    expect(empty.MCP_GATEWAY_LIST_TTL_MS).toBeUndefined();
    const set = parseConfig({ ...BASE_ENV, MCP_GATEWAY_MODERN_PROTOCOL: "ON", MCP_GATEWAY_LIST_TTL_MS: "0" });
    expect(set.MCP_GATEWAY_MODERN_PROTOCOL).toBe("on");
    expect(set.MCP_GATEWAY_LIST_TTL_MS).toBe(0);
    expect(() => parseConfig({ ...BASE_ENV, MCP_GATEWAY_MODERN_PROTOCOL: "auto" })).toThrow("MCP_GATEWAY_MODERN_PROTOCOL");
    expect(() => parseConfig({ ...BASE_ENV, MCP_GATEWAY_LIST_TTL_MS: "-1" })).toThrow("MCP_GATEWAY_LIST_TTL_MS");
  });

  it("never reads a client certificate from an MCP request metadata header", () => {
    for (const header of ["mcp-protocol-version", "mcp-method", "mcp-name", "mcp-param-region", "Mcp-Session-Id"]) {
      expect(() => resolveNetworkSettings(parseConfig({ ...BASE_ENV, MCP_GATEWAY_CLIENT_CERT_HEADER: header, MCP_GATEWAY_CLIENT_CERT_PROXIES: "10.0.0.5" })), header).toThrow(
        "MCP_GATEWAY_CLIENT_CERT_HEADER"
      );
    }
  });
});

describe("subscriptions/listen helpers", () => {
  it("checks the shape of the notifications filter only", async () => {
    const { listenFilterError } = await import("./mcp-gateway-modern.js");
    expect(listenFilterError(undefined)).toBeNull();
    expect(listenFilterError({})).toBeNull();
    expect(listenFilterError({ notifications: {} })).toBeNull();
    expect(listenFilterError({ notifications: { toolsListChanged: true, promptsListChanged: false, resourceSubscriptions: ["file:///a"], extra: 1 } })).toBeNull();
    expect(listenFilterError({ notifications: "all" })).toMatch(/object/);
    expect(listenFilterError({ notifications: { resourcesListChanged: 1 } })).toMatch(/resourcesListChanged/);
    expect(listenFilterError({ notifications: { resourceSubscriptions: "file:///a" } })).toMatch(/array of strings/);
  });

  it("builds the acknowledgment and the graceful end with the subscription id", async () => {
    const { subscriptionsAcknowledged, subscriptionsComplete } = await import("./mcp-gateway-modern.js");
    expect(subscriptionsAcknowledged("a")).toEqual({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: { _meta: { "io.modelcontextprotocol/subscriptionId": "a" }, notifications: {} }
    });
    expect(subscriptionsComplete(3, { name: "l2m-x", version: "1" })).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: {
        resultType: "complete",
        _meta: { "io.modelcontextprotocol/subscriptionId": 3, "io.modelcontextprotocol/serverInfo": { name: "l2m-x", version: "1" } }
      }
    });
  });
});
