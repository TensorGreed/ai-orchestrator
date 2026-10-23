/**
 * Outbound URL guard: scheme blocking, metadata and link-local always
 * blocked, private allowed by default and blockable with an allowlist
 * exception, DNS-resolution checks, redirect re-checks and the Playwright
 * route handler.
 */
import http from "node:http";
import tls from "node:tls";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OUTBOUND_GUARD,
  OutboundUrlBlockedError,
  checkOutboundUrl,
  assertOutboundUrlAllowed,
  guardedFetch,
  pinnedLookup,
  playwrightOutboundGuard,
  playwrightWebSocketGuard,
  type OutboundGuardConfig
} from "./outbound-url-guard";

/** A resolver that answers from a fixed map; unknown hosts throw like a real NXDOMAIN. */
const resolverFor = (map: Record<string, string[]>) => async (host: string) => {
  if (host in map) return map[host]!;
  throw new Error(`ENOTFOUND ${host}`);
};

const allow: OutboundGuardConfig = { denyPrivate: false, allowlist: [] };

describe("checkOutboundUrl — schemes", () => {
  it("refuses everything except http and https", async () => {
    for (const url of ["file:///etc/passwd", "data:text/html,<script>1</script>", "javascript:alert(1)", "ftp://host/x", "gopher://host"]) {
      const check = await checkOutboundUrl(url, allow);
      expect(check.ok, url).toBe(false);
      expect(check.reason, url).toBe("scheme");
    }
  });

  it("allows http and https to a public host", async () => {
    const resolver = resolverFor({ "example.com": ["93.184.216.34"] });
    expect((await checkOutboundUrl("https://example.com/x", allow, resolver)).ok).toBe(true);
    expect((await checkOutboundUrl("http://example.com/x", allow, resolver)).ok).toBe(true);
  });
});

describe("checkOutboundUrl — always-blocked ranges", () => {
  const resolver = resolverFor({
    "rebind.evil": ["169.254.169.254"],
    "gcp.evil": ["metadata.google.internal"],
    "ll.evil": ["169.254.1.2"],
    "v6meta.evil": ["fd00:ec2::254"]
  });

  it("blocks the cloud metadata IP whatever the host name", async () => {
    const check = await checkOutboundUrl("http://rebind.evil/latest/meta-data/", allow, resolver);
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/metadata/);
  });

  it("blocks the metadata hostname even before resolving", async () => {
    const check = await checkOutboundUrl("http://metadata.google.internal/computeMetadata/v1/", allow);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("host_blocked");
  });

  it("blocks link-local and the IPv6 metadata address", async () => {
    expect((await checkOutboundUrl("http://ll.evil/", allow, resolver)).ok).toBe(false);
    expect((await checkOutboundUrl("http://v6meta.evil/", allow, resolver)).ok).toBe(false);
    expect((await checkOutboundUrl("http://[fd00:ec2::254]/", allow)).ok).toBe(false);
  });

  it("blocks obfuscated spellings of the metadata address", async () => {
    // 169.254.169.254 as a single decimal integer.
    expect((await checkOutboundUrl("http://2852039166/", allow)).ok).toBe(false);
  });
});

describe("checkOutboundUrl — private ranges", () => {
  const resolver = resolverFor({ "internal.svc": ["10.1.2.3"], "home.box": ["127.0.0.1"] });

  it("allows private and loopback by default", async () => {
    expect((await checkOutboundUrl("http://internal.svc/", allow, resolver)).ok).toBe(true);
    expect((await checkOutboundUrl("http://home.box/", allow, resolver)).ok).toBe(true);
    expect((await checkOutboundUrl("http://127.0.0.1:5432/", allow)).ok).toBe(true);
  });

  it("blocks private and loopback when denyPrivate is on", async () => {
    const deny: OutboundGuardConfig = { denyPrivate: true, allowlist: [] };
    expect((await checkOutboundUrl("http://internal.svc/", deny, resolver)).ok).toBe(false);
    expect((await checkOutboundUrl("http://127.0.0.1/", deny)).ok).toBe(false);
  });

  it("lets an allowlisted host or CIDR through under denyPrivate", async () => {
    const byHost: OutboundGuardConfig = { denyPrivate: true, allowlist: ["internal.svc"] };
    expect((await checkOutboundUrl("http://internal.svc/", byHost, resolver)).ok).toBe(true);
    const byCidr: OutboundGuardConfig = { denyPrivate: true, allowlist: ["10.0.0.0/8"] };
    expect((await checkOutboundUrl("http://internal.svc/", byCidr, resolver)).ok).toBe(true);
    // A loopback host not covered by the 10/8 allowlist stays blocked.
    expect((await checkOutboundUrl("http://127.0.0.1/", byCidr)).ok).toBe(false);
  });

  it("an allowlist never overrides a metadata address", async () => {
    const wide: OutboundGuardConfig = { denyPrivate: true, allowlist: ["0.0.0.0/0", "rebind.evil"] };
    expect((await checkOutboundUrl("http://rebind.evil/", wide, resolver)).ok).toBe(false);
  });
});

describe("checkOutboundUrl — resolution failures", () => {
  it("refuses a host that does not resolve", async () => {
    const check = await checkOutboundUrl("http://nope.invalid/", allow, resolverFor({}));
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("resolver_error");
  });
});

describe("assertOutboundUrlAllowed", () => {
  it("throws an OutboundUrlBlockedError on a blocked URL", async () => {
    await expect(assertOutboundUrlAllowed("file:///etc/passwd", allow)).rejects.toBeInstanceOf(OutboundUrlBlockedError);
  });
});

describe("guardedFetch — redirects", () => {
  const resolver = resolverFor({ "public.example": ["93.184.216.34"], "evil.example": ["169.254.169.254"] });

  it("re-checks each redirect hop and blocks a redirect to metadata", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://public.example/start") {
        return new Response(null, { status: 302, headers: { location: "http://evil.example/latest/" } });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      guardedFetch("https://public.example/start", {}, { config: allow, resolver, fetchImpl })
    ).rejects.toBeInstanceOf(OutboundUrlBlockedError);
    // The second hop was never actually fetched.
    expect((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0])).toEqual(["https://public.example/start"]);
  });

  it("follows an allowed redirect to completion", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://public.example/a") {
        return new Response(null, { status: 301, headers: { location: "https://public.example/b" } });
      }
      return new Response("done", { status: 200 });
    }) as unknown as typeof fetch;
    const response = await guardedFetch("https://public.example/a", {}, { config: allow, resolver, fetchImpl });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("done");
  });

  it("refuses the first URL before any fetch when it is blocked", async () => {
    const fetchImpl = vi.fn(async () => new Response("x")) as unknown as typeof fetch;
    await expect(guardedFetch("file:///etc/passwd", {}, { config: allow, resolver, fetchImpl })).rejects.toBeInstanceOf(OutboundUrlBlockedError);
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });
});

describe("playwrightOutboundGuard", () => {
  const resolver = resolverFor({ "cdn.example": ["93.184.216.34"], "meta.evil": ["169.254.169.254"] });

  const fakeRoute = (url: string) => {
    const calls: string[] = [];
    return {
      calls,
      request: () => ({ url: () => url }),
      continue: async () => { calls.push("continue"); },
      abort: async (code?: string) => { calls.push(`abort:${code ?? ""}`); }
    };
  };

  it("continues a data: URL without a network check", async () => {
    const guard = playwrightOutboundGuard(allow, resolver);
    const route = fakeRoute("data:image/png;base64,AAAA");
    await guard(route);
    expect(route.calls).toEqual(["continue"]);
  });

  it("continues an allowed host and aborts a metadata host", async () => {
    const guard = playwrightOutboundGuard(allow, resolver);
    const ok = fakeRoute("https://cdn.example/app.js");
    await guard(ok);
    expect(ok.calls).toEqual(["continue"]);
    const blocked = fakeRoute("http://meta.evil/latest/");
    await guard(blocked);
    expect(blocked.calls[0]).toMatch(/^abort:/);
  });
});

describe("DEFAULT_OUTBOUND_GUARD", () => {
  it("allows private and does not deny by default", () => {
    expect(DEFAULT_OUTBOUND_GUARD).toEqual({ denyPrivate: false, allowlist: [] });
  });
});

describe("guardedFetch — the connection is pinned to the vetted address (DNS rebinding)", () => {
  async function localServer(): Promise<{ port: number; hosts: string[]; close: () => Promise<void> }> {
    const hosts: string[] = [];
    const server = http.createServer((request, response) => {
      hosts.push(String(request.headers.host));
      response.end("pinned-ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: (server.address() as AddressInfo).port, hosts, close: () => new Promise((resolve) => server.close(() => resolve())) };
  }

  it("refuses a name that answers a public address to the check and the metadata address at connect", async () => {
    const server = await localServer();
    try {
      let calls = 0;
      // First answer (the pre-check): public. Second answer (the socket's own lookup): metadata.
      const rebinding = async () => (++calls === 1 ? ["93.184.216.34"] : ["169.254.169.254"]);
      await expect(guardedFetch(`http://rebind.test:${server.port}/`, {}, { config: allow, resolver: rebinding })).rejects.toBeInstanceOf(OutboundUrlBlockedError);
      expect(calls).toBe(2);
      expect(server.hosts).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("connects to the address the guard vetted, keeping the hostname for Host", async () => {
    const server = await localServer();
    try {
      // The system resolver knows nothing of pinned.test; only the guard's resolver does.
      const resolver = resolverFor({ "pinned.test": ["127.0.0.1"] });
      const response = await guardedFetch(`http://pinned.test:${server.port}/path`, {}, { config: allow, resolver });
      expect(await response.text()).toBe("pinned-ok");
      expect(server.hosts).toEqual([`pinned.test:${server.port}`]);
    } finally {
      await server.close();
    }
  });

  it("keeps the hostname as the TLS server name (SNI) while connecting to the vetted address", async () => {
    const seen: string[] = [];
    const server = tls.createServer({
      SNICallback: (servername, callback) => {
        seen.push(servername);
        callback(new Error("no certificate in this test"));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const resolver = resolverFor({ "pinned.test": ["127.0.0.1"] });
      await expect(guardedFetch(`https://pinned.test:${port}/`, {}, { config: allow, resolver })).rejects.toThrow();
      expect(seen).toEqual(["pinned.test"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("pinnedLookup refuses when any address is blocked, and honours the family filter", async () => {
    const lookup = (config: OutboundGuardConfig, addresses: string[], options: { all?: boolean; family?: number }) =>
      new Promise<{ error: Error | null; result: unknown }>((resolve) => {
        pinnedLookup("443", config, async () => addresses)("h.test", options as never, (error, address, family) => resolve({ error, result: options.all ? address : [address, family] }));
      });
    const mixed = await lookup(allow, ["93.184.216.34", "169.254.169.254"], { all: true });
    expect(mixed.error).toBeInstanceOf(OutboundUrlBlockedError);
    const privateDenied = await lookup({ denyPrivate: true, allowlist: [] }, ["10.0.0.5"], { all: true });
    expect(privateDenied.error).toBeInstanceOf(OutboundUrlBlockedError);
    const portAllowlisted = await lookup({ denyPrivate: true, allowlist: ["h.test:443"] }, ["10.0.0.5"], { all: true });
    expect(portAllowlisted.result).toEqual([{ address: "10.0.0.5", family: 4 }]);
    const v6Only = await lookup(allow, ["93.184.216.34", "2606:2800:220:1::1"], { family: 6 });
    expect(v6Only.result).toEqual(["2606:2800:220:1::1", 6]);
  });
});

describe("playwrightWebSocketGuard", () => {
  const fakeSocket = (url: string) => {
    const calls: string[] = [];
    return {
      calls,
      url: () => url,
      connectToServer: () => { calls.push("connect"); },
      close: async (options?: { code?: number }) => { calls.push(`close:${options?.code ?? ""}`); }
    };
  };
  const resolver = resolverFor({ "chat.example": ["93.184.216.34"], "rebind.example": ["169.254.169.254"] });

  it("connects an allowed ws/wss URL and closes a blocked one before any connection", async () => {
    const guard = playwrightWebSocketGuard(allow, resolver);
    const ok = fakeSocket("wss://chat.example/socket");
    await guard(ok);
    expect(ok.calls).toEqual(["connect"]);
    for (const blocked of ["ws://169.254.169.254/", "ws://rebind.example/", "ws://[fd00:ec2::254]/"]) {
      const socket = fakeSocket(blocked);
      await guard(socket);
      expect(socket.calls, blocked).toEqual(["close:1008"]);
    }
  });

  it("applies OUTBOUND_DENY_PRIVATE to WebSockets too", async () => {
    const socket = fakeSocket("ws://10.0.0.8:9000/");
    await playwrightWebSocketGuard({ denyPrivate: true, allowlist: [] }, resolver)(socket);
    expect(socket.calls).toEqual(["close:1008"]);
  });
});
