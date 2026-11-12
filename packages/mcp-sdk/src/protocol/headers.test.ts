import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  McpHeaderValueError,
  analyzeMcpHeaderAnnotations,
  buildMcpParamHeaders,
  buildMcpStandardHeaders,
  decodeMcpHeaderValue,
  encodeMcpHeaderValue,
  headerLookupFrom,
  stripMcpHeaderAnnotations,
  verifyMcpRequestHeaders,
  type McpParamHeaderSpec
} from "./headers";
import { modernRequestMetaFor, withRequestMeta } from "./meta";

describe("header value encoding", () => {
  it("matches the spec's encoding table", () => {
    expect(encodeMcpHeaderValue("us-west1")).toBe("us-west1");
    expect(encodeMcpHeaderValue("Hello, 世界")).toBe("=?base64?SGVsbG8sIOS4lueVjA==?=");
    expect(encodeMcpHeaderValue(" padded ")).toBe("=?base64?IHBhZGRlZCA=?=");
    expect(encodeMcpHeaderValue("line1\nline2")).toBe("=?base64?bGluZTEKbGluZTI=?=");
    expect(encodeMcpHeaderValue("=?base64?literal?=")).toBe("=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
  });

  it("encodes control characters and tabs, keeps inner spaces", () => {
    expect(encodeMcpHeaderValue("a\tb")).toMatch(/^=\?base64\?/);
    expect(encodeMcpHeaderValue("a\rb")).toMatch(/^=\?base64\?/);
    expect(encodeMcpHeaderValue("a b")).toBe("a b");
    expect(encodeMcpHeaderValue("")).toBe("");
  });

  it("round-trips through decode and rejects bad input", () => {
    for (const value of ["us-west1", "Hello, 世界", " padded ", "line1\nline2", "=?base64?literal?=", "naïve\u0000"]) {
      const decoded = decodeMcpHeaderValue(encodeMcpHeaderValue(value));
      expect(decoded).toMatchObject({ ok: true, value });
    }
    expect(decodeMcpHeaderValue("=?base64?not base64!?=")).toEqual({ ok: false, reason: "is not valid Base64" });
    expect(decodeMcpHeaderValue("=?base64?/w==?=")).toEqual({ ok: false, reason: "is not valid UTF-8" });
    expect(decodeMcpHeaderValue("café").ok).toBe(false);
    expect(decodeMcpHeaderValue(" plain ")).toEqual({ ok: true, value: "plain", encoded: false });
  });
});

describe("standard headers", () => {
  it("adds Mcp-Name only for tools/call, resources/read and prompts/get", () => {
    expect(buildMcpStandardHeaders("2026-07-28", "tools/call", { name: "get_weather" })).toEqual({
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "get_weather"
    });
    expect(buildMcpStandardHeaders("2026-07-28", "resources/read", { uri: "file:///projects/myapp/config.json" })["Mcp-Name"]).toBe(
      "file:///projects/myapp/config.json"
    );
    expect(buildMcpStandardHeaders("2026-07-28", "prompts/get", { name: "résumé" })["Mcp-Name"]).toBe(encodeMcpHeaderValue("résumé"));
    expect(buildMcpStandardHeaders("2026-07-28", "tools/list", { name: "ignored" })).toEqual({
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list"
    });
  });
});

describe("x-mcp-header annotations", () => {
  it("collects valid annotations with their properties paths", () => {
    const analysis = analyzeMcpHeaderAnnotations({
      type: "object",
      properties: {
        region: { type: "string", "x-mcp-header": "Region" },
        query: { type: "string" },
        limits: {
          type: "object",
          properties: { max: { type: ["integer", "null"], "x-mcp-header": "Max-Rows" }, dry: { type: "boolean", "x-mcp-header": "Dry_Run" } }
        },
        // A property called x-mcp-header and data that mentions it are not annotations.
        "x-mcp-header": { type: "string", default: { "x-mcp-header": "Nope" }, enum: [{ "x-mcp-header": "Nope" }] }
      }
    });
    expect(analysis).toEqual({
      ok: true,
      headers: [
        { name: "Region", path: ["region"], type: "string" },
        { name: "Max-Rows", path: ["limits", "max"], type: "integer" },
        { name: "Dry_Run", path: ["limits", "dry"], type: "boolean" }
      ]
    });
    expect(analyzeMcpHeaderAnnotations({ type: "object", properties: { a: { type: "string" } } })).toEqual({ ok: true, headers: [] });
    expect(analyzeMcpHeaderAnnotations(undefined)).toEqual({ ok: true, headers: [] });
  });

  const invalid: Array<[string, unknown, RegExp]> = [
    ["number type", { properties: { a: { type: "number", "x-mcp-header": "A" } } }, /string, integer or boolean/],
    ["object type", { properties: { a: { type: "object", "x-mcp-header": "A" } } }, /string, integer or boolean/],
    ["no type", { properties: { a: { enum: ["x"], "x-mcp-header": "A" } } }, /string, integer or boolean/],
    ["two primitive types", { properties: { a: { type: ["string", "integer"], "x-mcp-header": "A" } } }, /string, integer or boolean/],
    ["empty value", { properties: { a: { type: "string", "x-mcp-header": "" } } }, /non-empty string/],
    ["non-string value", { properties: { a: { type: "string", "x-mcp-header": 5 } } }, /non-empty string/],
    ["space in token", { properties: { a: { type: "string", "x-mcp-header": "My Header" } } }, /token/],
    ["CRLF in token", { properties: { a: { type: "string", "x-mcp-header": "A\r\nX-Evil: 1" } } }, /token/],
    ["colon in token", { properties: { a: { type: "string", "x-mcp-header": "A:B" } } }, /token/],
    ["non-ASCII token", { properties: { a: { type: "string", "x-mcp-header": "Régión" } } }, /token/],
    [
      "duplicate ignoring case",
      { properties: { a: { type: "string", "x-mcp-header": "Region" }, b: { type: "string", "x-mcp-header": "REGION" } } },
      /repeats 'Region'/
    ],
    ["on the root", { type: "object", "x-mcp-header": "Root", properties: {} }, /reachable/],
    ["through items", { properties: { list: { type: "array", items: { type: "string", "x-mcp-header": "A" } } } }, /reachable/],
    [
      "through items.properties",
      { properties: { list: { type: "array", items: { type: "object", properties: { a: { type: "string", "x-mcp-header": "A" } } } } } },
      /reachable/
    ],
    ["through anyOf", { properties: { a: { anyOf: [{ type: "string", "x-mcp-header": "A" }] } } }, /reachable/],
    ["through oneOf", { oneOf: [{ properties: { a: { type: "string", "x-mcp-header": "A" } } }] }, /reachable/],
    ["through allOf", { allOf: [{ properties: { a: { type: "string", "x-mcp-header": "A" } } }] }, /reachable/],
    ["through not", { properties: { a: { type: "string", not: { type: "string", "x-mcp-header": "A" } } } }, /reachable/],
    ["through if/then", { if: { properties: { a: { type: "string" } } }, then: { properties: { a: { type: "string", "x-mcp-header": "A" } } } }, /reachable/],
    ["in $defs", { $defs: { R: { type: "string", "x-mcp-header": "A" } }, properties: { a: { $ref: "#/$defs/R" } } }, /reachable/],
    ["in additionalProperties", { additionalProperties: { type: "string", "x-mcp-header": "A" } }, /reachable/],
    ["in patternProperties", { patternProperties: { "^a": { type: "string", "x-mcp-header": "A" } } }, /reachable/]
  ];
  it.each(invalid)("rejects an annotation %s", (_label, schema, reason) => {
    const analysis = analyzeMcpHeaderAnnotations(schema);
    expect(analysis.ok).toBe(false);
    if (!analysis.ok) expect(analysis.reason).toMatch(reason);
  });

  it("strips annotations without touching property names or data", () => {
    const schema = {
      type: "object",
      properties: {
        region: { type: "string", "x-mcp-header": "Region" },
        "x-mcp-header": { type: "string", default: { "x-mcp-header": "kept" } },
        list: { type: "array", items: { type: "string", "x-mcp-header": "Bad" } }
      }
    };
    const stripped = stripMcpHeaderAnnotations(schema);
    expect(stripped).toEqual({
      type: "object",
      properties: {
        region: { type: "string" },
        "x-mcp-header": { type: "string", default: { "x-mcp-header": "kept" } },
        list: { type: "array", items: { type: "string" } }
      }
    });
    expect(schema.properties.region).toHaveProperty("x-mcp-header", "Region");
  });
});

describe("Mcp-Param headers", () => {
  const specs: McpParamHeaderSpec[] = [
    { name: "Region", path: ["region"], type: "string" },
    { name: "Max", path: ["limits", "max"], type: "integer" },
    { name: "Dry", path: ["dry"], type: "boolean" }
  ];

  it("mirrors values at their exact path and omits null or absent ones", () => {
    expect(buildMcpParamHeaders(specs, { region: "us-west1", limits: { max: 42 }, dry: false })).toEqual({
      "Mcp-Param-Region": "us-west1",
      "Mcp-Param-Max": "42",
      "Mcp-Param-Dry": "false"
    });
    expect(buildMcpParamHeaders(specs, { region: null, limits: {}, other: { max: 1 } })).toEqual({});
    expect(buildMcpParamHeaders(specs, { limits: "not an object" })).toEqual({});
    expect(buildMcpParamHeaders(specs, { region: "Hello, 世界", limits: { max: -7 } })).toEqual({
      "Mcp-Param-Region": "=?base64?SGVsbG8sIOS4lueVjA==?=",
      "Mcp-Param-Max": "-7"
    });
  });

  it("refuses values a header cannot carry", () => {
    expect(() => buildMcpParamHeaders(specs, { limits: { max: 2 ** 53 } })).toThrow(McpHeaderValueError);
    expect(() => buildMcpParamHeaders(specs, { limits: { max: Number.NaN } })).toThrow(/finite/);
    expect(() => buildMcpParamHeaders(specs, { region: { nested: true } })).toThrow(/string, integer or boolean/);
    expect(() => buildMcpParamHeaders(specs, { region: ["a"] })).toThrow(McpHeaderValueError);
  });
});

describe("verifyMcpRequestHeaders", () => {
  const meta = modernRequestMetaFor({}, "2026-07-28");
  const call = { method: "tools/call", params: withRequestMeta({ name: "execute_sql", arguments: { region: "us-west1", n: 42 } }, meta) };
  const specs: McpParamHeaderSpec[] = [
    { name: "Region", path: ["region"], type: "string" },
    { name: "N", path: ["n"], type: "integer" },
    { name: "Absent", path: ["absent"], type: "string" }
  ];
  const good = {
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": "tools/call",
    "mcp-name": "execute_sql",
    "mcp-param-region": "us-west1",
    "mcp-param-n": "42.0"
  };

  it("accepts matching headers, compares integers as numbers and names ignoring case", () => {
    expect(verifyMcpRequestHeaders(headerLookupFrom(good), call, specs)).toBeNull();
    expect(verifyMcpRequestHeaders(headerLookupFrom({ ...good, "MCP-NAME": undefined, "Mcp-Name": "=?base64?ZXhlY3V0ZV9zcWw=?=" }), call, specs)).toBeNull();
  });

  const failures: Array<[string, Record<string, string | string[] | undefined>, RegExp]> = [
    ["missing version", { ...good, "mcp-protocol-version": undefined }, /MCP-Protocol-Version header is required/],
    ["version differs from _meta", { ...good, "mcp-protocol-version": "2025-11-25" }, /does not match the protocol version/],
    ["missing method", { ...good, "mcp-method": undefined }, /Mcp-Method header is required/],
    ["method differs", { ...good, "mcp-method": "tools/list" }, /does not match the request method/],
    ["method differs in case", { ...good, "mcp-method": "Tools/Call" }, /does not match the request method/],
    ["missing name", { ...good, "mcp-name": undefined }, /Mcp-Name header is required/],
    ["name differs", { ...good, "mcp-name": "drop_table" }, /does not match params.name/],
    ["bad name encoding", { ...good, "mcp-name": "=?base64?***?=" }, /not valid Base64/],
    ["param missing while body has it", { ...good, "mcp-param-region": undefined }, /Mcp-Param-Region header is required/],
    ["param differs", { ...good, "mcp-param-region": "eu-west1" }, /Mcp-Param-Region header does not match/],
    ["integer differs", { ...good, "mcp-param-n": "43" }, /Mcp-Param-N header does not match/],
    ["param set without a body value", { ...good, "mcp-param-absent": "x" }, /Mcp-Param-Absent header is set/],
    ["repeated header", { ...good, "mcp-name": ["execute_sql", "x"] }, /contains characters/]
  ];
  it.each(failures)("rejects %s with -32020", (_label, headers, message) => {
    const result = verifyMcpRequestHeaders(headerLookupFrom(headers), call, specs);
    expect(result?.code).toBe(-32020);
    expect(result?.message).toMatch(message);
  });

  it("needs no Mcp-Name for methods without one", () => {
    const list = { method: "tools/list", params: withRequestMeta({}, meta) };
    expect(verifyMcpRequestHeaders(headerLookupFrom({ "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" }), list)).toBeNull();
  });

  it("survives a real HTTP round trip from the client builders to the server check", async () => {
    const args = { region: "Zürich ", n: 7 };
    const params = withRequestMeta({ name: "café_lookup", arguments: args }, meta);
    const analysis = analyzeMcpHeaderAnnotations({
      type: "object",
      properties: { region: { type: "string", "x-mcp-header": "Region" }, n: { type: "integer", "x-mcp-header": "N" } }
    });
    if (!analysis.ok) throw new Error(analysis.reason);
    let seen: ReturnType<typeof verifyMcpRequestHeaders> | "unset" = "unset";
    const server = createServer((request: IncomingMessage, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const message = JSON.parse(body) as { method: string; params: Record<string, unknown> };
        seen = verifyMcpRequestHeaders(headerLookupFrom(request.headers), message, analysis.headers);
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const headers = {
        "content-type": "application/json",
        ...buildMcpStandardHeaders("2026-07-28", "tools/call", params),
        ...buildMcpParamHeaders(analysis.headers, args)
      };
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params })
      });
      await response.text();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(seen).toBeNull();
  });
});
