import { describe, expect, it } from "vitest";
import {
  McpOAuthError,
  assertSecureOAuthUrl,
  discoverAuthorizationServer,
  discoverProtectedResource,
  isLoopbackHost,
  oauthApplicationType,
  registerOAuthClient,
  validateAuthorizationResponseIssuer,
  type FetchLike
} from "./oauth";

const ISSUER = "https://as.example.com/tenant1";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function metadataFor(issuer: unknown): Record<string, unknown> {
  return {
    ...(issuer === undefined ? {} : { issuer }),
    authorization_endpoint: "https://as.example.com/tenant1/authorize",
    token_endpoint: "https://as.example.com/tenant1/token",
    code_challenge_methods_supported: ["S256"]
  };
}

/** A fetch that answers every URL with the given metadata document and records what was asked. */
function metadataFetch(body: Record<string, unknown>, seen: string[] = []): FetchLike {
  return (async (input: string | URL | Request) => {
    seen.push(String(input));
    return jsonResponse(200, body);
  }) as FetchLike;
}

describe("validateAuthorizationResponseIssuer (RFC 9207 as MCP 2026-07-28 applies it)", () => {
  const recordedIssuer = "https://as.example.com";

  it("advertised and present: accepts the exact issuer", () => {
    expect(validateAuthorizationResponseIssuer({ recordedIssuer, issParameterSupported: true, iss: recordedIssuer })).toEqual({ ok: true });
  });

  it("advertised and present: rejects a different issuer", () => {
    const check = validateAuthorizationResponseIssuer({ recordedIssuer, issParameterSupported: true, iss: "https://evil.example.com" });
    expect(check).toMatchObject({ ok: false, reason: "mismatch" });
  });

  it("advertised and absent: rejects the response", () => {
    expect(validateAuthorizationResponseIssuer({ recordedIssuer, issParameterSupported: true, iss: undefined })).toMatchObject({
      ok: false,
      reason: "missing"
    });
  });

  it("not advertised and present: still compares (the MCP local-policy row)", () => {
    expect(validateAuthorizationResponseIssuer({ recordedIssuer, issParameterSupported: false, iss: recordedIssuer })).toEqual({ ok: true });
    expect(validateAuthorizationResponseIssuer({ recordedIssuer, issParameterSupported: false, iss: "https://other.example.com" })).toMatchObject({
      ok: false,
      reason: "mismatch"
    });
  });

  it("not advertised and absent: proceeds", () => {
    expect(validateAuthorizationResponseIssuer({ recordedIssuer, issParameterSupported: false, iss: undefined })).toEqual({ ok: true });
  });

  it("compares without normalisation: case, trailing slash, default port and percent-encoding all count as different", () => {
    for (const variant of [
      "https://AS.example.com",
      "HTTPS://as.example.com",
      "https://as.example.com/",
      "https://as.example.com:443",
      "https://as.%65xample.com",
      ""
    ]) {
      expect(validateAuthorizationResponseIssuer({ recordedIssuer, issParameterSupported: false, iss: variant }), variant).toMatchObject({
        ok: false,
        reason: "mismatch"
      });
    }
  });

  it("rejects a repeated iss parameter", () => {
    expect(
      validateAuthorizationResponseIssuer({ recordedIssuer, issParameterSupported: false, iss: [recordedIssuer, recordedIssuer] })
    ).toMatchObject({ ok: false, reason: "malformed" });
  });
});

describe("discoverAuthorizationServer: issuer equality (RFC 8414 section 3.3)", () => {
  it("uses metadata whose issuer is exactly the one it was fetched for", async () => {
    const seen: string[] = [];
    const metadata = await discoverAuthorizationServer(ISSUER, { fetchImpl: metadataFetch(metadataFor(ISSUER), seen) });
    expect(metadata.issuer).toBe(ISSUER);
    expect(seen[0]).toBe("https://as.example.com/.well-known/oauth-authorization-server/tenant1");
  });

  it("refuses metadata that names another issuer", async () => {
    await expect(
      discoverAuthorizationServer(ISSUER, { fetchImpl: metadataFetch(metadataFor("https://honest.example.com")) })
    ).rejects.toThrow(/names the issuer "https:\/\/honest\.example\.com", not "https:\/\/as\.example\.com\/tenant1"/);
  });

  it("refuses metadata that differs only by a trailing slash", async () => {
    await expect(discoverAuthorizationServer(ISSUER, { fetchImpl: metadataFetch(metadataFor(`${ISSUER}/`)) })).rejects.toBeInstanceOf(McpOAuthError);
  });

  it("refuses metadata without an issuer instead of assuming one", async () => {
    await expect(discoverAuthorizationServer(ISSUER, { fetchImpl: metadataFetch(metadataFor(undefined)) })).rejects.toThrow(/names no issuer/);
  });

  it("keeps the iss and Client ID Metadata Document flags from the document", async () => {
    const metadata = await discoverAuthorizationServer(ISSUER, {
      fetchImpl: metadataFetch({ ...metadataFor(ISSUER), authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: true })
    });
    expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
    expect(metadata.client_id_metadata_document_supported).toBe(true);
  });
});

describe("dynamic client registration: application_type", () => {
  it("is web for a non-loopback redirect URL and native for loopback ones", () => {
    expect(oauthApplicationType("https://l2m.example.com/api/mcp/oauth/callback")).toBe("web");
    expect(oauthApplicationType("http://intranet.example.com/api/mcp/oauth/callback")).toBe("web");
    expect(oauthApplicationType("http://localhost:4000/api/mcp/oauth/callback")).toBe("native");
    expect(oauthApplicationType("http://127.0.0.1:4000/api/mcp/oauth/callback")).toBe("native");
    expect(oauthApplicationType("http://[::1]:4000/api/mcp/oauth/callback")).toBe("native");
    expect(oauthApplicationType("http://studio.localhost:5173/api/mcp/oauth/callback")).toBe("native");
    expect(oauthApplicationType("https://127.evil.example/api/mcp/oauth/callback")).toBe("web");
  });

  it("does not treat names that start with 127. as loopback", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.255.0.9")).toBe(true);
    expect(isLoopbackHost("127.evil.example")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.example")).toBe(false);
    expect(() => assertSecureOAuthUrl("http://127.evil.example/token", "Token endpoint")).toThrow(/must use https/);
    expect(assertSecureOAuthUrl("http://127.0.0.1:9000/token", "Token endpoint").hostname).toBe("127.0.0.1");
  });

  it("is sent in every registration request", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse(201, { client_id: "c-1" });
    }) as FetchLike;
    await registerOAuthClient("https://as.example.com/register", { redirectUri: "https://l2m.example.com/api/mcp/oauth/callback" }, { fetchImpl });
    await registerOAuthClient("https://as.example.com/register", { redirectUri: "http://localhost:4000/api/mcp/oauth/callback" }, { fetchImpl });
    expect(bodies.map((body) => body.application_type)).toEqual(["web", "native"]);
  });

  it("surfaces a refused registration with the server's reason", async () => {
    const fetchImpl = (async () => jsonResponse(400, { error: "invalid_redirect_uri", error_description: "native clients need loopback redirects" })) as FetchLike;
    await expect(
      registerOAuthClient("https://as.example.com/register", { redirectUri: "https://l2m.example.com/cb" }, { fetchImpl })
    ).rejects.toThrow(/Dynamic client registration failed: native clients need loopback redirects/);
  });
});

describe("discoverProtectedResource: the 401 challenge probe", () => {
  const endpoint = "https://mcp.example.com/mcp";
  const prm = { resource: endpoint, authorization_servers: [ISSUER], scopes_supported: ["profile"] };
  const challenge = `Bearer scope="mcp:basic", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"`;

  /** A server whose MCP endpoint answers each probe with `answer(body, headers)`; metadata is served at its URL. */
  function server(answer: (body: Record<string, unknown>, headers: Record<string, string>) => Response, posts: Array<{ body: Record<string, unknown>; headers: Record<string, string> }>): FetchLike {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === endpoint && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
        posts.push({ body, headers });
        return answer(body, headers);
      }
      if (url.includes("/.well-known/oauth-protected-resource")) return jsonResponse(200, prm);
      return jsonResponse(404, {});
    }) as FetchLike;
  }

  it("keeps the legacy initialize probe alone when it is challenged", async () => {
    const posts: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const fetchImpl = server(() => new Response("", { status: 401, headers: { "www-authenticate": challenge } }), posts);
    const found = await discoverProtectedResource(endpoint, { fetchImpl });
    expect(found.scopeHint).toBe("mcp:basic");
    expect(posts.map((post) => post.body.method)).toEqual(["initialize"]);
    expect(posts[0]!.headers["mcp-protocol-version"]).toBeUndefined();
  });

  it("asks with a modern server/discover when a modern-only server answers initialize with 400", async () => {
    const posts: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const fetchImpl = server(
      (body) =>
        body.method === "initialize"
          ? jsonResponse(400, { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Invalid params: _meta is missing" } })
          : new Response("", { status: 401, headers: { "www-authenticate": challenge } }),
      posts
    );
    const found = await discoverProtectedResource(endpoint, { fetchImpl, headers: { "x-tenant": "t1" } });
    expect(found.scopeHint).toBe("mcp:basic");
    expect(found.resourceMetadataUrl).toBe("https://mcp.example.com/.well-known/oauth-protected-resource/mcp");
    expect(posts.map((post) => post.body.method)).toEqual(["initialize", "server/discover"]);
    const discover = posts[1]!;
    expect(discover.headers).toMatchObject({ "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover", "x-tenant": "t1" });
    expect((discover.body.params as { _meta: Record<string, unknown> })._meta).toMatchObject({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {}
    });
  });

  it("asks with server/discover when initialize is let through without a token", async () => {
    const posts: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const fetchImpl = server(
      (body) => (body.method === "initialize" ? jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: {} }) : new Response("", { status: 401, headers: { "www-authenticate": challenge } })),
      posts
    );
    expect((await discoverProtectedResource(endpoint, { fetchImpl })).scopeHint).toBe("mcp:basic");
  });

  it("falls back to the well-known URLs when neither probe is challenged", async () => {
    const posts: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const fetchImpl = server(() => jsonResponse(400, {}), posts);
    const found = await discoverProtectedResource(endpoint, { fetchImpl });
    expect(found.scopeHint).toBeUndefined();
    expect(found.resourceMetadataUrl).toBe("https://mcp.example.com/.well-known/oauth-protected-resource/mcp");
    expect(posts).toHaveLength(2);
  });
});
