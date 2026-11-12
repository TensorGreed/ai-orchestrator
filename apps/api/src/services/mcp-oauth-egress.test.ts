import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkOutboundUrl } from "@ai-orchestrator/workflow-engine";
import type { DnsResolver } from "@ai-orchestrator/guard-sdk";
import { discoverAuthorizationServer } from "@ai-orchestrator/mcp-sdk";
import { createMcpOAuthEgressFetch, mcpOAuthEgressPolicy } from "./mcp-oauth-egress.js";

/** A local server standing in for hosts the tests name; it records every request it gets. */
let server: Server;
let port = 0;
const received: Array<{ host: string; path: string }> = [];
let respond: (request: IncomingMessage) => { status: number; headers?: Record<string, string>; body?: string } = () => ({ status: 200, body: "{}" });

beforeAll(async () => {
  server = createServer((request, response) => {
    received.push({ host: request.headers.host ?? "", path: request.url ?? "" });
    const answer = respond(request);
    response.writeHead(answer.status, { "content-type": "application/json", ...(answer.headers ?? {}) });
    response.end(answer.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
  respond = () => ({ status: 200, body: "{}" });
});

/** A resolver from a fixed table; unknown names do not resolve. */
function table(entries: Record<string, string[]>): DnsResolver {
  return async (host) => entries[host] ?? [];
}

const PUBLIC_ENDPOINT = "https://mcp.example.com/mcp";

describe("mcpOAuthEgressPolicy verdicts", () => {
  const resolver = table({
    "as.example.com": ["93.184.216.34"],
    "idp.corp.example": ["10.1.2.3"],
    "dual.example.com": ["93.184.216.34", "10.0.0.7"],
    "v6.example.com": ["fd00::5"],
    "mapped.example.com": ["::ffff:192.168.1.10"],
    "mcp.corp.example": ["10.9.9.9"],
    "loop.example.com": ["127.0.0.1"],
    localhost: ["127.0.0.1", "::1"]
  });
  const verdict = async (url: string, endpoint = PUBLIC_ENDPOINT, allowlist: string[] = []) =>
    (await checkOutboundUrl(url, mcpOAuthEgressPolicy(endpoint, allowlist), resolver)).ok;

  it("allows public hosts", async () => {
    expect(await verdict("https://as.example.com/.well-known/oauth-authorization-server")).toBe(true);
  });

  it("refuses private, loopback, link-local, metadata and unique-local addresses", async () => {
    for (const url of [
      "https://10.0.0.1/token",
      "https://172.16.5.5/token",
      "https://192.168.0.1/token",
      "https://100.64.1.1/token",
      "https://127.0.0.1/token",
      "https://0x7f000001/token",
      "https://2130706433/token",
      "https://0177.0.0.1/token",
      "https://169.254.169.254/latest/meta-data/",
      "https://169.254.10.10/token",
      "https://[::1]/token",
      "https://[fe80::1]/token",
      "https://[fd12:3456::1]/token",
      "https://[fec0::1]/token",
      "https://[fd00:ec2::254]/token",
      "https://0.0.0.0/token",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://idp.corp.example/token",
      "https://loop.example.com/token"
    ]) {
      expect(await verdict(url), url).toBe(false);
    }
  });

  it("judges IPv4-mapped, IPv4-translated, NAT64 and 6to4 IPv6 addresses by the IPv4 address they carry", async () => {
    for (const url of [
      "https://[::ffff:10.0.0.1]/token",
      "https://[::ffff:a00:1]/token",
      "https://[::ffff:127.0.0.1]/token",
      "https://[::ffff:169.254.169.254]/token",
      "https://[::ffff:0:10.0.0.1]/token",
      "https://[64:ff9b::a9fe:a9fe]/token",
      "https://[2002:a00:1::1]/token",
      "https://mapped.example.com/token",
      "https://v6.example.com/token"
    ]) {
      expect(await verdict(url), url).toBe(false);
    }
  });

  it("refuses a name when any one of its addresses is private", async () => {
    expect(await verdict("https://dual.example.com/token")).toBe(false);
  });

  it("allows a private identity provider on the allow list, by name or by range", async () => {
    expect(await verdict("https://idp.corp.example/token", PUBLIC_ENDPOINT, ["idp.corp.example"])).toBe(true);
    expect(await verdict("https://idp.corp.example/token", PUBLIC_ENDPOINT, ["*.corp.example"])).toBe(true);
    expect(await verdict("https://idp.corp.example/token", PUBLIC_ENDPOINT, ["10.0.0.0/8"])).toBe(true);
    expect(await verdict("https://idp.corp.example:8443/token", PUBLIC_ENDPOINT, ["idp.corp.example:443"])).toBe(false);
    expect(await verdict("https://idp.corp.example/token", PUBLIC_ENDPOINT, ["192.168.0.0/16"])).toBe(false);
  });

  it("never lets the allow list open metadata or link-local addresses", async () => {
    expect(await verdict("https://169.254.169.254/latest/", PUBLIC_ENDPOINT, ["169.254.0.0/16", "169.254.169.254"])).toBe(false);
    expect(await verdict("https://[fe80::1]/token", PUBLIC_ENDPOINT, ["fe80::/10"])).toBe(false);
  });

  it("allows the configured MCP server's own host and port, and only that port", async () => {
    const endpoint = "https://mcp.corp.example/mcp";
    expect(await verdict("https://mcp.corp.example/.well-known/oauth-protected-resource/mcp", endpoint)).toBe(true);
    expect(await verdict("https://mcp.corp.example:8443/token", endpoint)).toBe(false);
    expect(await verdict("https://10.9.9.9/token", endpoint)).toBe(false);
  });

  it("allows a literal-address MCP server's own port only", async () => {
    expect(await verdict("http://10.0.0.5:8080/.well-known/oauth-protected-resource", "http://10.0.0.5:8080/mcp")).toBe(true);
    expect(await verdict("http://10.0.0.5:2375/containers/json", "http://10.0.0.5:8080/mcp")).toBe(false);
    expect(await verdict("http://[fd00::5]:8080/.well-known/oauth-protected-resource", "http://[fd00::5]:8080/mcp")).toBe(true);
    expect(await verdict("http://[fd00::5]:2375/x", "http://[fd00::5]:8080/mcp")).toBe(false);
  });

  it("does not treat a name that starts with 127. as loopback", async () => {
    expect(await verdict("http://127.0.0.1:6379/x", "https://127.evil.example/mcp")).toBe(false);
  });

  it("allows loopback only when the MCP server itself is on loopback", async () => {
    expect(await verdict("http://127.0.0.1:9000/token", "http://127.0.0.1:4000/mcp")).toBe(true);
    expect(await verdict("http://localhost:9000/token", "http://localhost:4000/mcp")).toBe(true);
    expect(await verdict("http://127.0.0.1:9000/token", PUBLIC_ENDPOINT)).toBe(false);
    // Loopback is not a door to private ranges.
    expect(await verdict("https://10.0.0.1/token", "http://127.0.0.1:4000/mcp")).toBe(false);
  });
});

describe("createMcpOAuthEgressFetch", () => {
  it("connects a name to exactly the address it checked (pinned), keeping the Host header", async () => {
    const fetchImpl = createMcpOAuthEgressFetch(PUBLIC_ENDPOINT, { allowlist: ["idp.localhost"], resolver: table({ "idp.localhost": ["127.0.0.1"] }) });
    const response = await fetchImpl(`http://idp.localhost:${port}/token`);
    expect(response.status).toBe(200);
    await response.text();
    expect(received).toEqual([{ host: `idp.localhost:${port}`, path: "/token" }]);
  });

  it("refuses a loopback identity provider that is not on the allow list, without connecting", async () => {
    const fetchImpl = createMcpOAuthEgressFetch(PUBLIC_ENDPOINT, { allowlist: [], resolver: table({ "idp.localhost": ["127.0.0.1"] }) });
    await expect(fetchImpl(`http://idp.localhost:${port}/token`)).rejects.toThrow(/refused to contact 'idp\.localhost'.*MCP_OAUTH_PRIVATE_HOST_ALLOWLIST/);
    await expect(fetchImpl(`http://127.0.0.1:${port}/token`)).rejects.toThrow(/refused to contact '127\.0\.0\.1'/);
    expect(received).toEqual([]);
  });

  it("refuses a name that rebinds to a private address between the check and the connection", async () => {
    let calls = 0;
    const rebinding: DnsResolver = async (host) => {
      if (host !== "rebind.localhost") return [];
      calls += 1;
      // First answer passes the up-front check; the connect-time answer points inside.
      return calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
    };
    const fetchImpl = createMcpOAuthEgressFetch(PUBLIC_ENDPOINT, { allowlist: [], resolver: rebinding });
    await expect(fetchImpl(`http://rebind.localhost:${port}/token`)).rejects.toThrow(/refused to contact 'rebind\.localhost'/);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(received).toEqual([]);
  });

  it("never follows a redirect, even to an allowed host", async () => {
    respond = (request) =>
      request.url === "/start"
        ? { status: 302, headers: { location: `http://127.0.0.1:${port}/internal` } }
        : { status: 200, body: "{}" };
    const fetchImpl = createMcpOAuthEgressFetch("http://127.0.0.1:4000/mcp", { allowlist: [] });
    await expect(fetchImpl(`http://127.0.0.1:${port}/start`, { redirect: "follow" })).rejects.toThrow();
    expect(received.map((entry) => entry.path)).toEqual(["/start"]);
  });

  it("stops discovery when authorization server metadata redirects to a private address", async () => {
    respond = () => ({ status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    const fetchImpl = createMcpOAuthEgressFetch(PUBLIC_ENDPOINT, { allowlist: ["as.localhost"], resolver: table({ "as.localhost": ["127.0.0.1"] }) });
    await expect(discoverAuthorizationServer(`http://as.localhost:${port}`, { fetchImpl })).rejects.toThrow(/failed/);
    expect(received).toHaveLength(1);
  });

  it("stops discovery that names a metadata address as the authorization server", async () => {
    const fetchImpl = createMcpOAuthEgressFetch(PUBLIC_ENDPOINT, { allowlist: ["169.254.169.254"] });
    await expect(discoverAuthorizationServer("https://169.254.169.254", { fetchImpl })).rejects.toThrow(/refused to contact '169\.254\.169\.254'/);
  });
});
