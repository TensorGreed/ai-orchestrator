/**
 * Outbound URL guard: scheme blocking, metadata and link-local always
 * blocked, private allowed by default and blockable with an allowlist
 * exception, DNS-resolution checks, redirect re-checks and the Playwright
 * route handler.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OUTBOUND_GUARD,
  OutboundUrlBlockedError,
  checkOutboundUrl,
  assertOutboundUrlAllowed,
  guardedFetch,
  playwrightOutboundGuard,
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
