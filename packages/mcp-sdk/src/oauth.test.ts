import { describe, expect, it } from "vitest";
import {
  McpOAuthError,
  assertSecureOAuthUrl,
  discoverAuthorizationServer,
  discoverMcpOAuth,
  discoverProtectedResource,
  isLoopbackHost,
  protectedResourceMetadataUrls,
  oauthApplicationType,
  readInsufficientScopeChallenge,
  registerOAuthClient,
  unionOAuthScopes,
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

  it("sends no second probe when the first got no answer at all", async () => {
    const posts: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const fetchImpl = server(() => {
      throw new TypeError("fetch failed");
    }, posts);
    const found = await discoverProtectedResource(endpoint, { fetchImpl });
    expect(found.resourceMetadataUrl).toBe("https://mcp.example.com/.well-known/oauth-protected-resource/mcp");
    expect(posts.map((post) => post.body.method)).toEqual(["initialize"]);
  });
});

/**
 * RFC 9728 section 3.3: "The resource value returned MUST be identical to the protected resource's resource identifier
 * value into which the well-known URI path suffix was inserted to create the URL used to retrieve the metadata", and,
 * for a URL from the WWW-Authenticate `resource_metadata` parameter, "identical to the URL that the client used to make
 * the request to the resource server". Otherwise "the data contained in the response MUST NOT be used". Section 6
 * compares code point by code point; section 7.3 says why (impersonation).
 */
describe("protected resource metadata: the resource must be identical (RFC 9728 section 3.3)", () => {
  /**
   * An MCP server at `endpoint`: its POSTs answer 401 (with `challenge` when given) or 400, and `documents` maps
   * metadata URLs to their bodies (others 404). `seen` records every GET.
   */
  function prmServer(input: { endpoint: string; documents: Record<string, unknown>; challenge?: string; seen?: string[] }): FetchLike {
    return (async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (init?.method === "POST") {
        return input.challenge ? new Response("", { status: 401, headers: { "www-authenticate": input.challenge } }) : jsonResponse(400, {});
      }
      input.seen?.push(url);
      if (url in input.documents) return jsonResponse(200, input.documents[url]);
      return jsonResponse(404, {});
    }) as FetchLike;
  }
  const prm = (resource: unknown) => ({ ...(resource === undefined ? {} : { resource }), authorization_servers: [ISSUER] });
  const PATH_WK = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
  const ROOT_WK = "https://mcp.example.com/.well-known/oauth-protected-resource";

  async function resourceFor(endpoint: string, documents: Record<string, unknown>, challenge?: string) {
    return (await discoverProtectedResource(endpoint, { fetchImpl: prmServer({ endpoint, documents, challenge }) })).metadata.resource;
  }

  it("accepts a resource identical to the MCP server URL, and discovery sends exactly that value", async () => {
    const endpoint = "https://mcp.example.com/mcp";
    expect(await resourceFor(endpoint, { [PATH_WK]: prm(endpoint) })).toBe(endpoint);
    const fetchImpl = (async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (init?.method === "POST") return jsonResponse(400, {});
      if (url === PATH_WK) return jsonResponse(200, prm(endpoint));
      if (url === "https://as.example.com/.well-known/oauth-authorization-server/tenant1") return jsonResponse(200, metadataFor(ISSUER));
      return jsonResponse(404, {});
    }) as FetchLike;
    expect((await discoverMcpOAuth(endpoint, { fetchImpl })).resource).toBe(endpoint);
  });

  it("refuses a resource that is only on the same origin (the check was same-origin before)", async () => {
    await expect(resourceFor("https://mcp.example.com/mcp", { [PATH_WK]: prm("https://mcp.example.com") })).rejects.toThrow(
      /names the resource "https:\/\/mcp\.example\.com", not "https:\/\/mcp\.example\.com\/mcp".*RFC 9728 section 3\.3/
    );
    await expect(resourceFor("https://mcp.example.com/mcp", { [PATH_WK]: prm("https://mcp.example.com/other") })).rejects.toThrow(McpOAuthError);
  });

  it("refuses metadata with no resource (RFC 9728 section 2: REQUIRED), or one that is not a URL or has a fragment", async () => {
    await expect(resourceFor("https://mcp.example.com/mcp", { [PATH_WK]: prm(undefined) })).rejects.toThrow(/names no resource/);
    await expect(resourceFor("https://mcp.example.com/mcp", { [PATH_WK]: prm("") })).rejects.toThrow(/names no resource/);
    await expect(resourceFor("https://mcp.example.com/mcp", { [PATH_WK]: prm(42) })).rejects.toThrow(/names no resource/);
    await expect(resourceFor("https://mcp.example.com/mcp", { [PATH_WK]: prm("https://mcp.example.com/mcp#x") })).rejects.toThrow(/fragment/);
    await expect(resourceFor("https://mcp.example.com/mcp", { [PATH_WK]: prm("/mcp") })).rejects.toThrow(McpOAuthError);
  });

  it("treats a trailing slash on a path as significant", async () => {
    await expect(resourceFor("https://mcp.example.com/mcp", { [PATH_WK]: prm("https://mcp.example.com/mcp/") })).rejects.toThrow(McpOAuthError);
    // An endpoint ending in a slash: its well-known URL keeps the slash (RFC 9728 section 3.1 removes only a slash right after the host).
    const slashed = "https://mcp.example.com/mcp/";
    const seen: string[] = [];
    const fetchImpl = prmServer({ endpoint: slashed, documents: { [`${PATH_WK}/`]: prm(slashed) }, seen });
    expect((await discoverProtectedResource(slashed, { fetchImpl })).metadata.resource).toBe(slashed);
    expect(seen[0]).toBe(`${PATH_WK}/`);
    await expect(resourceFor(slashed, { [`${PATH_WK}/`]: prm("https://mcp.example.com/mcp") })).rejects.toThrow(McpOAuthError);
  });

  it("accepts either form for a server at the root, where both build the same well-known URL", async () => {
    expect(await resourceFor("https://mcp.example.com", { [ROOT_WK]: prm("https://mcp.example.com") })).toBe("https://mcp.example.com");
    expect(await resourceFor("https://mcp.example.com/", { [ROOT_WK]: prm("https://mcp.example.com") })).toBe("https://mcp.example.com");
    expect(await resourceFor("https://mcp.example.com", { [ROOT_WK]: prm("https://mcp.example.com/") })).toBe("https://mcp.example.com/");
  });

  it("compares ports exactly, apart from the default port the URL used for the request leaves out", async () => {
    const custom = "https://mcp.example.com:8443/mcp";
    const customWk = "https://mcp.example.com:8443/.well-known/oauth-protected-resource/mcp";
    expect(await resourceFor(custom, { [customWk]: prm(custom) })).toBe(custom);
    await expect(resourceFor(custom, { [customWk]: prm("https://mcp.example.com/mcp") })).rejects.toThrow(McpOAuthError);
    await expect(resourceFor(custom, { [customWk]: prm("https://mcp.example.com:9443/mcp") })).rejects.toThrow(McpOAuthError);
    // A resource naming the default port is not the URL used for the request (which has none)...
    await expect(resourceFor("https://mcp.example.com/mcp", { [PATH_WK]: prm("https://mcp.example.com:443/mcp") })).rejects.toThrow(McpOAuthError);
    // ...unless the server was configured with it: then both the configured and the requested form match.
    expect(await resourceFor("https://mcp.example.com:443/mcp", { [PATH_WK]: prm("https://mcp.example.com:443/mcp") })).toBe("https://mcp.example.com:443/mcp");
    expect(await resourceFor("https://mcp.example.com:443/mcp", { [PATH_WK]: prm("https://mcp.example.com/mcp") })).toBe("https://mcp.example.com/mcp");
  });

  it("compares the path code point by code point: case, prefixes and percent-encoding all count", async () => {
    for (const resource of ["https://mcp.example.com/MCP", "https://mcp.example.com/mcp/sub", "https://mcp.example.com/mc", "https://mcp.example.com/%6Dcp"]) {
      await expect(resourceFor("https://mcp.example.com/mcp", { [PATH_WK]: prm(resource) }), resource).rejects.toThrow(McpOAuthError);
    }
  });

  it("accepts an upper-case scheme or host (MCP 2026-07-28, Canonical Server URI: SHOULD accept them)", async () => {
    expect(await resourceFor("https://mcp.example.com/mcp", { [PATH_WK]: prm("HTTPS://MCP.Example.COM/mcp") })).toBe("HTTPS://MCP.Example.COM/mcp");
  });

  it("keeps a query in the well-known URL and in the comparison", async () => {
    const endpoint = "https://mcp.example.com/mcp?tenant=a";
    const wk = `${PATH_WK}?tenant=a`;
    expect(protectedResourceMetadataUrls(endpoint)).toEqual([wk, ROOT_WK]);
    expect(await resourceFor(endpoint, { [wk]: prm(endpoint) })).toBe(endpoint);
    await expect(resourceFor(endpoint, { [wk]: prm("https://mcp.example.com/mcp") })).rejects.toThrow(McpOAuthError);
  });

  it("at the root fallback, accepts the root identifier or the server URL, and nothing else", async () => {
    // MCP 2026-07-28 Authorization Server Discovery: path-specific well-known URL first, then the root one.
    expect(await resourceFor("https://mcp.example.com/mcp", { [ROOT_WK]: prm("https://mcp.example.com") })).toBe("https://mcp.example.com");
    expect(await resourceFor("https://mcp.example.com/mcp", { [ROOT_WK]: prm("https://mcp.example.com/mcp") })).toBe("https://mcp.example.com/mcp");
    await expect(resourceFor("https://mcp.example.com/mcp", { [ROOT_WK]: prm("https://mcp.example.com/other") })).rejects.toThrow(McpOAuthError);
  });

  it("does not move on to the root URL when the path-specific document names another resource", async () => {
    const seen: string[] = [];
    const fetchImpl = prmServer({
      endpoint: "https://mcp.example.com/mcp",
      documents: { [PATH_WK]: prm("https://evil.example.com/mcp"), [ROOT_WK]: prm("https://mcp.example.com/mcp") },
      seen
    });
    await expect(discoverProtectedResource("https://mcp.example.com/mcp", { fetchImpl })).rejects.toThrow(McpOAuthError);
    expect(seen).toEqual([PATH_WK]);
  });

  it("with a URL from WWW-Authenticate, requires the URL the request went to, even for a root document", async () => {
    const challenge = `Bearer resource_metadata="${ROOT_WK}"`;
    expect(await resourceFor("https://mcp.example.com/mcp", { [ROOT_WK]: prm("https://mcp.example.com/mcp") }, challenge)).toBe("https://mcp.example.com/mcp");
    await expect(resourceFor("https://mcp.example.com/mcp", { [ROOT_WK]: prm("https://mcp.example.com") }, challenge)).rejects.toThrow(McpOAuthError);
  });

  it("builds the well-known URLs as RFC 9728 section 3.1 does", () => {
    expect(protectedResourceMetadataUrls("https://mcp.example.com/mcp")).toEqual([PATH_WK, ROOT_WK]);
    expect(protectedResourceMetadataUrls("https://mcp.example.com/mcp/")).toEqual([`${PATH_WK}/`, ROOT_WK]);
    expect(protectedResourceMetadataUrls("https://mcp.example.com/")).toEqual([ROOT_WK]);
    expect(protectedResourceMetadataUrls("https://mcp.example.com")).toEqual([ROOT_WK]);
    expect(protectedResourceMetadataUrls("https://mcp.example.com/mcp#frag")).toEqual([PATH_WK, ROOT_WK]);
  });
});

describe("step-up: insufficient_scope challenges and the scope union", () => {
  it("reads a 403 insufficient_scope Bearer challenge and nothing else", () => {
    const header = 'Bearer error="insufficient_scope", scope="files:write files:read", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"';
    expect(readInsufficientScopeChallenge(403, header)).toEqual({
      scope: "files:write files:read",
      resourceMetadata: "https://mcp.example.com/.well-known/oauth-protected-resource"
    });
    expect(readInsufficientScopeChallenge(403, 'Bearer error="insufficient_scope"')).toEqual({});
    expect(readInsufficientScopeChallenge(401, header)).toBeNull();
    expect(readInsufficientScopeChallenge(403, 'Bearer error="invalid_token", scope="x"')).toBeNull();
    expect(readInsufficientScopeChallenge(403, null)).toBeNull();
    expect(readInsufficientScopeChallenge(403, 'Basic realm="x"')).toBeNull();
  });

  it("unions scopes in first-seen order, drops malformed tokens and caps the count", () => {
    expect(unionOAuthScopes("mcp:basic", "mcp:write mcp:basic", undefined, null)).toBe("mcp:basic mcp:write");
    expect(unionOAuthScopes(undefined, "  ")).toBeUndefined();
    expect(unionOAuthScopes('a "b" c\\d e')).toBe("a e");
    const many = Array.from({ length: 100 }, (_, index) => `s${index}`).join(" ");
    expect(unionOAuthScopes(many)!.split(" ")).toHaveLength(64);
  });
});
