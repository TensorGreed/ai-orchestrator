/**
 * 13.2 — the pure parts of network controls: the scope classifier (every route family), address matching (IPv4,
 * IPv6, IPv4-mapped, zone ids), the settings validation that refuses to start, verdicts with break-glass, and
 * forwarded client certificates.
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NetworkScope } from "@ai-orchestrator/shared";
import { parseConfig, resolveNetworkSettings } from "./config.js";
import {
  AddressList,
  KeySampler,
  NetworkControls,
  classifyNetworkScope,
  hasCookie,
  normalizeClientAddress,
  type ScopeRequest
} from "./network-controls.js";
import { certificateAccepted, describeCertificate, parseForwardedCertificate, readClientCertificate, subjectPinMatches } from "./client-certificate.js";
import { CLIENT_CERT_A_PEM, CLIENT_CERT_B_PEM } from "./test-support/client-certs.js";

const BASE_ENV = { SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64") };

function scopes(url: string, credential: "none" | "cookie" | "bearer" | "both" = "none", method = "GET"): NetworkScope[] {
  const input: ScopeRequest = {
    method,
    url,
    hasSessionCookie: credential === "cookie" || credential === "both",
    hasBearer: credential === "bearer" || credential === "both"
  };
  return classifyNetworkScope(input);
}

describe("classifyNetworkScope: every route family", () => {
  // [url, credential, expected scopes]; one row per route family in the inventory, plus the edges.
  const table: Array<[string, "none" | "cookie" | "bearer" | "both", NetworkScope[]]> = [
    // Probes and SAML metadata: always exempt.
    ["/health", "none", []],
    ["/ready", "bearer", []],
    ["/api/auth/saml/metadata", "none", []],
    ["/health?verbose=1", "none", []],
    // Studio + REST by credential.
    ["/api/workflows", "cookie", ["ui"]],
    ["/api/workflows", "bearer", ["api"]],
    ["/api/workflows", "both", ["ui", "api"]],
    ["/api/workflows", "none", ["ui"]],
    // Auth, SSO and the MCP OAuth callback come from the user's browser.
    ["/api/auth/login", "none", ["ui"]],
    ["/api/auth/login/mfa", "none", ["ui"]],
    ["/api/auth/me", "cookie", ["ui"]],
    ["/api/auth/saml/login", "none", ["ui"]],
    ["/api/auth/saml/callback", "none", ["ui"]],
    ["/api/auth/ldap/login", "none", ["ui"]],
    ["/api/auth/oidc/metadata", "none", ["ui"]],
    ["/api/auth/oidc/callback?code=abc&state=xyz", "none", ["ui"]],
    ["/api/mcp/oauth/callback?code=1", "cookie", ["ui"]],
    // Configured webhooks, provider webhooks, workflow-as-MCP.
    ["/webhook/orders", "none", ["webhook"]],
    ["/webhook-test/orders", "bearer", ["webhook"]],
    ["/api/webhooks/slack/wf_1", "none", ["webhook"]],
    ["/api/webhooks/github/wf_1", "none", ["webhook"]],
    ["/api/webhooks/stripe/wf_1", "none", ["webhook"]],
    ["/api/webhooks/telegram/wf_1", "none", ["webhook"]],
    ["/api/webhooks/discord/wf_1", "none", ["webhook"]],
    ["/api/mcp-server/tools/manifest", "none", ["webhook"]],
    ["/api/mcp-server/tools/invoke", "bearer", ["webhook"]],
    // Compat execute and manual triggers need a studio or API credential.
    ["/api/webhooks/execute", "bearer", ["api"]],
    ["/api/webhooks/execute/stream", "cookie", ["ui"]],
    ["/api/triggers/manual/wf_1", "bearer", ["api"]],
    // Public forms, chat, widget, helper.
    ["/api/forms/contact", "none", ["public"]],
    ["/api/forms/contact", "cookie", ["public"]],
    ["/api/chat/wf_1", "bearer", ["public"]],
    ["/widget.js", "none", ["public"]],
    ["/helper-chat", "none", ["public"]],
    // The MCP gateway.
    ["/mcp/support", "bearer", ["mcp_gateway"]],
    ["/mcp", "none", ["mcp_gateway"]],
    // Metrics and API docs.
    ["/metrics", "none", ["metrics"]],
    ["/api/docs", "none", ["metrics"]],
    ["/api/docs/static/index.js", "none", ["metrics"]],
    ["/api/openapi.json", "none", ["metrics"]],
    // Look-alikes stay in the default family.
    ["/webhooks", "none", ["ui"]],
    ["/mcpx/support", "bearer", ["api"]],
    ["/api/formsx", "none", ["ui"]],
    ["/healthz", "none", ["ui"]],
    ["/", "none", ["ui"]],
    // Percent-encoding is read the way the router reads it.
    ["/%6dcp/support", "bearer", ["mcp_gateway"]],
    ["/%68ealth", "none", []]
  ];

  it.each(table)("%s with %s → %j", (url, credential, expected) => {
    expect(scopes(url, credential)).toEqual(expected);
  });

  it("does not depend on the method", () => {
    for (const method of ["GET", "POST", "PUT", "DELETE", "OPTIONS"]) {
      expect(scopes("/mcp/x", "bearer", method)).toEqual(["mcp_gateway"]);
      expect(scopes("/api/workflows", "cookie", method)).toEqual(["ui"]);
    }
  });

  it("reads the session cookie by name, with a value", () => {
    expect(hasCookie("a=1; ao_session=sess_x", "ao_session")).toBe(true);
    expect(hasCookie("ao_session=", "ao_session")).toBe(false);
    expect(hasCookie("xao_session=1", "ao_session")).toBe(false);
    expect(hasCookie(undefined, "ao_session")).toBe(false);
  });
});

describe("address matching", () => {
  it("normalises IPv4-mapped IPv6, zone ids and brackets", () => {
    expect(normalizeClientAddress("::ffff:10.0.0.1")).toEqual({ address: "10.0.0.1", family: "ipv4" });
    expect(normalizeClientAddress("::ffff:a00:1")).toEqual({ address: "10.0.0.1", family: "ipv4" });
    expect(normalizeClientAddress("fe80::1%eth0")).toEqual({ address: "fe80::1", family: "ipv6" });
    expect(normalizeClientAddress("[2001:db8::1]")).toEqual({ address: "2001:db8::1", family: "ipv6" });
    expect(normalizeClientAddress("not-an-ip")).toBeNull();
    expect(normalizeClientAddress(undefined)).toBeNull();
  });

  it("matches IPv4 and IPv6 ranges, a mapped address against an IPv4 range, and keeps families apart", () => {
    const list = new AddressList(["10.0.0.0/8", "192.168.1.5/32", "2001:db8::/32"]);
    expect(list.has("10.20.30.40")).toBe(true);
    expect(list.has("::ffff:10.20.30.40")).toBe(true);
    expect(list.has("192.168.1.5")).toBe(true);
    expect(list.has("192.168.1.6")).toBe(false);
    expect(list.has("2001:db8:1::5")).toBe(true);
    expect(list.has("2001:db9::1")).toBe(false);
    expect(list.has("::a14:1e28")).toBe(false);
    expect(list.has("garbage")).toBe(false);
    expect(new AddressList([]).has("10.0.0.1")).toBe(false);
  });

  it("samples one record per key per window", () => {
    const sampler = new KeySampler(60_000);
    expect(sampler.take("a", 0)).toBe(true);
    expect(sampler.take("a", 59_999)).toBe(false);
    expect(sampler.take("b", 1)).toBe(true);
    expect(sampler.take("a", 60_000)).toBe(true);
  });
});

describe("network settings (startup validation)", () => {
  it("leaves every scope open and break-glass on loopback when nothing is set", () => {
    const settings = resolveNetworkSettings(parseConfig(BASE_ENV));
    expect(settings).toEqual({ mode: "enforce", scopes: {}, breakGlass: ["127.0.0.0/8", "::1/128"], clientCertHeader: null, clientCertProxies: [] });
  });

  it("reads each scope's list canonical, IPv6 included", () => {
    const settings = resolveNetworkSettings(
      parseConfig({
        ...BASE_ENV,
        NETWORK_ALLOW_UI: "10.1.2.3/8, 192.168.0.7",
        NETWORK_ALLOW_API: "2001:DB8::1/32 ::ffff:172.16.0.0/108",
        NETWORK_ALLOW_METRICS: "",
        NETWORK_ALLOWLIST_MODE: "Report",
        NETWORK_BREAK_GLASS_CIDRS: "none"
      })
    );
    expect(settings.scopes).toEqual({ ui: ["10.0.0.0/8", "192.168.0.7/32"], api: ["2001:db8::/32", "172.16.0.0/12"] });
    expect(settings.mode).toBe("report");
    expect(settings.breakGlass).toEqual([]);
  });

  it("refuses to start on a bad entry, naming the setting and the entry", () => {
    expect(() => parseConfig({ ...BASE_ENV, NETWORK_ALLOW_API: "10.0.0.0/8,10.0.0.300/8" })).toThrow(
      'NETWORK_ALLOW_API entry "10.0.0.300/8" is not an IP address or CIDR range'
    );
    expect(() => parseConfig({ ...BASE_ENV, NETWORK_ALLOW_UI: "10.0.0.0/33" })).toThrow('NETWORK_ALLOW_UI entry "10.0.0.0/33"');
    expect(() => parseConfig({ ...BASE_ENV, NETWORK_ALLOW_WEBHOOK: "example.com" })).toThrow('NETWORK_ALLOW_WEBHOOK entry "example.com"');
    expect(() => parseConfig({ ...BASE_ENV, NETWORK_ALLOW_MCP_GATEWAY: "2001:db8::/129" })).toThrow("NETWORK_ALLOW_MCP_GATEWAY");
    expect(() => parseConfig({ ...BASE_ENV, NETWORK_BREAK_GLASS_CIDRS: "loopback" })).toThrow('NETWORK_BREAK_GLASS_CIDRS entry "loopback"');
    expect(() => parseConfig({ ...BASE_ENV, NETWORK_ALLOWLIST_MODE: "audit" })).toThrow("NETWORK_ALLOWLIST_MODE");
  });

  it("refuses allowlists with TRUST_PROXY=true, and accepts a hop count or a proxy list", () => {
    expect(() => parseConfig({ ...BASE_ENV, TRUST_PROXY: "true", NETWORK_ALLOW_UI: "10.0.0.0/8" })).toThrow(
      "NETWORK_ALLOW_UI cannot be used with TRUST_PROXY=true"
    );
    expect(() => parseConfig({ ...BASE_ENV, TRUST_PROXY: "true" })).not.toThrow();
    expect(() => parseConfig({ ...BASE_ENV, TRUST_PROXY: "1", NETWORK_ALLOW_UI: "10.0.0.0/8" })).not.toThrow();
    expect(() => parseConfig({ ...BASE_ENV, TRUST_PROXY: "10.0.0.5", NETWORK_ALLOW_API: "10.0.0.0/8" })).not.toThrow();
  });

  it("needs trusted proxy addresses for the forwarded certificate header", () => {
    expect(() => parseConfig({ ...BASE_ENV, MCP_GATEWAY_CLIENT_CERT_HEADER: "x-ssl-client-cert" })).toThrow("set MCP_GATEWAY_CLIENT_CERT_PROXIES");
    expect(() => parseConfig({ ...BASE_ENV, MCP_GATEWAY_CLIENT_CERT_HEADER: "x-ssl-client-cert", TRUST_PROXY: "1" })).toThrow(
      "set MCP_GATEWAY_CLIENT_CERT_PROXIES"
    );
    expect(() => parseConfig({ ...BASE_ENV, MCP_GATEWAY_CLIENT_CERT_HEADER: "authorization", MCP_GATEWAY_CLIENT_CERT_PROXIES: "10.0.0.5" })).toThrow(
      "MCP_GATEWAY_CLIENT_CERT_HEADER"
    );
    const explicit = resolveNetworkSettings(
      parseConfig({ ...BASE_ENV, MCP_GATEWAY_CLIENT_CERT_HEADER: "X-SSL-Client-Cert", MCP_GATEWAY_CLIENT_CERT_PROXIES: "10.0.0.5" })
    );
    expect(explicit).toMatchObject({ clientCertHeader: "x-ssl-client-cert", clientCertProxies: ["10.0.0.5/32"] });
    const fromTrustProxy = resolveNetworkSettings(
      parseConfig({ ...BASE_ENV, MCP_GATEWAY_CLIENT_CERT_HEADER: "x-ssl-client-cert", TRUST_PROXY: "loopback,10.0.0.0/8" })
    );
    expect(fromTrustProxy.clientCertProxies).toEqual(["127.0.0.0/8", "::1/128", "10.0.0.0/8"]);
  });
});

function controls(env: Record<string, string>) {
  const config = parseConfig({ ...BASE_ENV, ...env });
  return new NetworkControls({
    settings: resolveNetworkSettings(config),
    config,
    audit: async () => undefined,
    notify: async () => undefined,
    metrics: { recordNetworkDecision: () => undefined },
    log: { warn: () => undefined }
  });
}

describe("verdicts", () => {
  it("admits everyone on scopes without a list and is inactive with no list", () => {
    const open = controls({});
    expect(open.active).toBe(false);
    expect(open.evaluate("203.0.113.9", ["ui", "api", "webhook"])).toEqual({ kind: "allowed" });
  });

  it("denies outside a scope's list, admits break-glass on ui and api only", () => {
    const strict = controls({ NETWORK_ALLOW_UI: "10.0.0.0/8", NETWORK_ALLOW_API: "10.0.0.0/8", NETWORK_ALLOW_MCP_GATEWAY: "10.0.0.0/8" });
    expect(strict.active).toBe(true);
    expect(strict.evaluate("10.1.1.1", ["ui"])).toEqual({ kind: "allowed" });
    expect(strict.evaluate("203.0.113.9", ["ui"])).toEqual({ kind: "denied", scope: "ui" });
    expect(strict.evaluate("127.0.0.1", ["api"])).toEqual({ kind: "break_glass", scope: "api" });
    expect(strict.evaluate("::1", ["ui"])).toEqual({ kind: "break_glass", scope: "ui" });
    expect(strict.evaluate("127.0.0.1", ["mcp_gateway"])).toEqual({ kind: "denied", scope: "mcp_gateway" });
    // A request on both scopes needs both.
    const split = controls({ NETWORK_ALLOW_UI: "10.0.0.0/8", NETWORK_ALLOW_API: "192.168.0.0/16" });
    expect(split.evaluate("10.1.1.1", ["ui", "api"])).toEqual({ kind: "denied", scope: "api" });
    expect(controls({ NETWORK_ALLOW_UI: "10.0.0.0/8", NETWORK_BREAK_GLASS_CIDRS: "none" }).evaluate("127.0.0.1", ["ui"])).toEqual({
      kind: "denied",
      scope: "ui"
    });
  });
});

describe("forwarded client certificates", () => {
  const fingerprintA = new crypto.X509Certificate(CLIENT_CERT_A_PEM).fingerprint256.replace(/:/g, "").toLowerCase();
  const fingerprintB = new crypto.X509Certificate(CLIENT_CERT_B_PEM).fingerprint256.replace(/:/g, "").toLowerCase();
  const proxies = new AddressList(["10.0.0.5/32"]);
  const settings = { header: "x-ssl-client-cert", proxies };
  const request = (value: string | undefined, remoteAddress: string) =>
    ({ headers: value === undefined ? {} : { "x-ssl-client-cert": value }, socket: { remoteAddress } }) as never;

  it("reads URL-encoded PEM, one-line PEM, an XFCC element and base64 DER", () => {
    const der = new crypto.X509Certificate(CLIENT_CERT_A_PEM).raw.toString("base64");
    const forms = [
      encodeURIComponent(CLIENT_CERT_A_PEM),
      CLIENT_CERT_A_PEM.replace(/\n/g, " "),
      CLIENT_CERT_A_PEM.replace(/\n/g, "\t"),
      `By=spiffe://l2m/gw;Hash=abc;Cert="${encodeURIComponent(CLIENT_CERT_A_PEM)}";Subject="CN=agent-a.example.com"`,
      der
    ];
    for (const form of forms) {
      const parsed = parseForwardedCertificate(form);
      expect(parsed, form.slice(0, 40)).not.toBeNull();
      expect(describeCertificate(parsed!).fingerprint256).toBe(fingerprintA);
    }
    expect(parseForwardedCertificate("not a certificate")).toBeNull();
    expect(parseForwardedCertificate("")).toBeNull();
  });

  it("describes the subject, CN and alternative names", () => {
    const described = describeCertificate(parseForwardedCertificate(CLIENT_CERT_A_PEM)!);
    expect(described.commonName).toBe("agent-a.example.com");
    expect(described.subjectAltNames).toEqual(["DNS:agent-a.example.com", "URI:spiffe://l2m.test/agent-a"]);
    expect(subjectPinMatches("agent-a.example.com", described)).toBe(true);
    expect(subjectPinMatches("spiffe://l2m.test/agent-a", described)).toBe(true);
    expect(subjectPinMatches("URI:spiffe://l2m.test/agent-a", described)).toBe(true);
    expect(subjectPinMatches("agent-b.example.com", described)).toBe(false);
  });

  it("honours the header only from a trusted proxy address", () => {
    const value = encodeURIComponent(CLIENT_CERT_A_PEM);
    expect(readClientCertificate(request(value, "10.0.0.5"), settings).status).toBe("ok");
    expect(readClientCertificate(request(value, "::ffff:10.0.0.5"), settings).status).toBe("ok");
    expect(readClientCertificate(request(value, "10.0.0.6"), settings).status).toBe("untrusted");
    expect(readClientCertificate(request(undefined, "10.0.0.5"), settings).status).toBe("none");
    expect(readClientCertificate(request("garbage", "10.0.0.5"), settings).status).toBe("invalid");
    expect(readClientCertificate(request(value, "10.0.0.5"), { header: null, proxies }).status).toBe("none");
    expect(readClientCertificate(request(value, "10.0.0.5"), settings, new Date("2200-01-01T00:00:00Z")).status).toBe("expired");
  });

  it("accepts a listed fingerprint (any of several during a rotation) and applies the subject pin", () => {
    const a = describeCertificate(parseForwardedCertificate(CLIENT_CERT_A_PEM)!);
    const b = describeCertificate(parseForwardedCertificate(CLIENT_CERT_B_PEM)!);
    expect(certificateAccepted({ certFingerprints: [fingerprintA], certSubject: null }, a)).toBe(true);
    expect(certificateAccepted({ certFingerprints: [fingerprintA], certSubject: null }, b)).toBe(false);
    expect(certificateAccepted({ certFingerprints: [fingerprintA, fingerprintB], certSubject: null }, b)).toBe(true);
    expect(certificateAccepted({ certFingerprints: [fingerprintA, fingerprintB], certSubject: "agent-a.example.com" }, b)).toBe(false);
    expect(certificateAccepted({ certFingerprints: [fingerprintA], certSubject: "spiffe://l2m.test/agent-a" }, a)).toBe(true);
  });
});
