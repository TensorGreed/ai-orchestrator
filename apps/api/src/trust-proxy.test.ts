import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { parseTrustProxy, toFastifyTrustProxy } from "./config.js";

/**
 * What request.ip resolves to for each TRUST_PROXY value and X-Forwarded-For chain. The expected values are the
 * behaviour of Fastify 5.8 (before the hop-count change in 5.12), written out by hand, so a Fastify upgrade that
 * changes client-address handling fails here.
 */
interface Row {
  trust: string | undefined;
  socket: string;
  xff?: string;
  ip: string;
}

const CLIENT = "203.0.113.7";
const rows: Row[] = [
  // Off: the connecting address always counts; the header is ignored.
  { trust: undefined, socket: "10.0.0.5", xff: CLIENT, ip: "10.0.0.5" },
  { trust: "", socket: "10.0.0.5", xff: CLIENT, ip: "10.0.0.5" },
  { trust: "false", socket: "10.0.0.5", xff: CLIENT, ip: "10.0.0.5" },
  { trust: "FALSE", socket: "10.0.0.5", xff: CLIENT, ip: "10.0.0.5" },
  { trust: "0", socket: "10.0.0.5", xff: CLIENT, ip: "10.0.0.5" },
  // true: every hop is trusted, so the left-most entry wins.
  { trust: "true", socket: "10.0.0.5", ip: "10.0.0.5" },
  { trust: "true", socket: "10.0.0.5", xff: CLIENT, ip: CLIENT },
  { trust: "true", socket: "10.0.0.5", xff: `198.51.100.9, ${CLIENT}`, ip: "198.51.100.9" },
  { trust: "TRUE", socket: "10.0.0.5", xff: CLIENT, ip: CLIENT },
  // Hop count: the socket plus N-1 header entries from the right are trusted.
  { trust: "1", socket: "10.0.0.5", ip: "10.0.0.5" },
  { trust: "1", socket: "10.0.0.5", xff: CLIENT, ip: CLIENT },
  { trust: "1", socket: "10.0.0.5", xff: `198.51.100.9, ${CLIENT}`, ip: CLIENT },
  { trust: "1", socket: "10.0.0.5", xff: `6.6.6.6, 198.51.100.9, ${CLIENT}`, ip: CLIENT },
  { trust: "2", socket: "10.0.0.5", xff: CLIENT, ip: CLIENT },
  { trust: "2", socket: "10.0.0.5", xff: `198.51.100.9, ${CLIENT}`, ip: "198.51.100.9" },
  { trust: "2", socket: "10.0.0.5", xff: `6.6.6.6, 198.51.100.9, ${CLIENT}`, ip: "198.51.100.9" },
  { trust: "3", socket: "10.0.0.5", xff: `6.6.6.6, 198.51.100.9, ${CLIENT}`, ip: "6.6.6.6" },
  { trust: "5", socket: "10.0.0.5", xff: `198.51.100.9, ${CLIENT}`, ip: "198.51.100.9" },
  { trust: "1", socket: "127.0.0.1", xff: CLIENT, ip: CLIENT },
  // A single address or CIDR: the header counts only when the socket is inside it.
  { trust: "10.0.0.5", socket: "10.0.0.5", xff: CLIENT, ip: CLIENT },
  { trust: "10.0.0.5", socket: "10.0.0.6", xff: CLIENT, ip: "10.0.0.6" },
  { trust: "10.0.0.0/8", socket: "10.9.9.9", xff: CLIENT, ip: CLIENT },
  { trust: "10.0.0.0/8", socket: "192.0.2.1", xff: CLIENT, ip: "192.0.2.1" },
  { trust: "10.0.0.0/8", socket: "10.9.9.9", xff: `198.51.100.9, ${CLIENT}`, ip: CLIENT },
  // Every proxy in the chain listed: the walk continues to the first untrusted address.
  { trust: "10.0.0.0/8, 198.51.100.9", socket: "10.9.9.9", xff: `${CLIENT}, 198.51.100.9`, ip: CLIENT },
  { trust: "10.0.0.0/8", socket: "10.9.9.9", xff: `${CLIENT}, 198.51.100.9`, ip: "198.51.100.9" },
  // A client cannot prepend itself into trust: entries to the left of an untrusted address are not read.
  { trust: "10.0.0.0/8", socket: "10.9.9.9", xff: `10.1.1.1, ${CLIENT}`, ip: CLIENT },
  { trust: "10.0.0.0/8", socket: "192.0.2.1", xff: "10.1.1.1", ip: "192.0.2.1" },
  // Named ranges and comma lists with several entries.
  { trust: "loopback", socket: "127.0.0.1", xff: CLIENT, ip: CLIENT },
  { trust: "loopback", socket: "::1", xff: CLIENT, ip: CLIENT },
  { trust: "loopback", socket: "10.0.0.5", xff: CLIENT, ip: "10.0.0.5" },
  { trust: "uniquelocal", socket: "10.0.0.5", xff: CLIENT, ip: CLIENT },
  { trust: "uniquelocal", socket: "fd00::1", xff: CLIENT, ip: CLIENT },
  { trust: "linklocal", socket: "169.254.1.1", xff: CLIENT, ip: CLIENT },
  { trust: "linklocal", socket: "10.0.0.5", xff: CLIENT, ip: "10.0.0.5" },
  { trust: "loopback, 10.0.0.0/8", socket: "10.0.0.5", xff: CLIENT, ip: CLIENT },
  { trust: "loopback,10.0.0.0/8", socket: "127.0.0.1", xff: CLIENT, ip: CLIENT },
  { trust: "loopback,10.0.0.0/8", socket: "192.0.2.1", xff: CLIENT, ip: "192.0.2.1" },
  // IPv6 addresses and ranges.
  { trust: "fd00::/8", socket: "fd00::5", xff: "2001:db8::1", ip: "2001:db8::1" },
  { trust: "fd00::/8", socket: "2001:db8::9", xff: CLIENT, ip: "2001:db8::9" },
  { trust: "::1", socket: "::1", xff: CLIENT, ip: CLIENT },
  // IPv4-mapped socket address against an IPv4 range.
  { trust: "10.0.0.0/8", socket: "::ffff:10.0.0.5", xff: CLIENT, ip: CLIENT }
];

async function resolve(row: Row): Promise<string> {
  const app = Fastify({ trustProxy: toFastifyTrustProxy(parseTrustProxy(row.trust)) });
  app.get("/ip", async (request) => ({ ip: request.ip }));
  try {
    const response = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: row.socket,
      headers: row.xff === undefined ? {} : { "x-forwarded-for": row.xff }
    });
    return (response.json() as { ip: string }).ip;
  } finally {
    await app.close();
  }
}

interface ForwardedRow {
  trust: string | undefined;
  socket: string;
  protocol: string;
  hostname: string;
}

/** X-Forwarded-Proto and X-Forwarded-Host are honoured only when the connecting socket is a trusted hop. */
const forwardedRows: ForwardedRow[] = [
  { trust: undefined, socket: "10.0.0.5", protocol: "http", hostname: "api.internal" },
  { trust: "false", socket: "10.0.0.5", protocol: "http", hostname: "api.internal" },
  { trust: "1", socket: "10.0.0.5", protocol: "https", hostname: "app.example.com" },
  { trust: "2", socket: "10.0.0.5", protocol: "https", hostname: "app.example.com" },
  { trust: "true", socket: "10.0.0.5", protocol: "https", hostname: "app.example.com" },
  { trust: "10.0.0.0/8", socket: "10.0.0.5", protocol: "https", hostname: "app.example.com" },
  { trust: "10.0.0.0/8", socket: "192.0.2.1", protocol: "http", hostname: "api.internal" }
];

describe("TRUST_PROXY resolves request.protocol and request.hostname", () => {
  for (const row of forwardedRows) {
    it(`TRUST_PROXY=${JSON.stringify(row.trust)} socket ${row.socket} -> ${row.protocol} ${row.hostname}`, async () => {
      const app = Fastify({ trustProxy: toFastifyTrustProxy(parseTrustProxy(row.trust)) });
      app.get("/p", async (request) => ({ protocol: request.protocol, hostname: request.hostname }));
      try {
        const response = await app.inject({
          method: "GET",
          url: "/p",
          remoteAddress: row.socket,
          headers: { host: "api.internal", "x-forwarded-proto": "https", "x-forwarded-host": "app.example.com" }
        });
        expect(response.json()).toEqual({ protocol: row.protocol, hostname: row.hostname });
      } finally {
        await app.close();
      }
    });
  }
});

describe("TRUST_PROXY resolves request.ip", () => {
  for (const row of rows) {
    const label = `TRUST_PROXY=${JSON.stringify(row.trust)} socket ${row.socket} X-Forwarded-For ${row.xff ?? "(none)"} -> ${row.ip}`;
    it(label, async () => {
      expect(await resolve(row)).toBe(row.ip);
    });
  }

  it("keeps a hop count working as a hop count (not as an untrusted peer)", () => {
    const trust = toFastifyTrustProxy(parseTrustProxy("1"));
    expect(typeof trust).toBe("function");
    expect((trust as (a: string, h: number) => boolean)("10.0.0.5", 0)).toBe(true);
    expect((trust as (a: string, h: number) => boolean)("10.0.0.5", 1)).toBe(false);
  });

  it("passes booleans and lists through unchanged", () => {
    expect(toFastifyTrustProxy(false)).toBe(false);
    expect(toFastifyTrustProxy(true)).toBe(true);
    expect(toFastifyTrustProxy(["10.0.0.0/8"])).toEqual(["10.0.0.0/8"]);
    expect(toFastifyTrustProxy(0)).toBe(false);
  });
});
