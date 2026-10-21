import { describe, expect, it } from "vitest";
import type { GuardFinding } from "../types";
import { checkEgressChain, checkEgressUrl, classifyIp, createEgressGuardDetector, hostMatches, parseIp, parseIpv4, type DnsResolver } from "./egress-guard";

const publicDns: DnsResolver = async (host) => (host === "api.example.com" ? ["93.184.216.34"] : host === "dual.example.com" ? ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] : []);

describe("ip parsing and classification", () => {
  it.each([
    ["127.0.0.1", "loopback", false],
    ["2130706433", "loopback", true],
    ["0x7f000001", "loopback", true],
    ["0177.0.0.1", "loopback", true],
    ["127.1", "loopback", true],
    ["0x7f.1", "loopback", true],
    ["10.0.0.5", "private", false],
    ["172.16.4.4", "private", false],
    ["172.32.0.1", "public", false],
    ["192.168.1.1", "private", false],
    ["169.254.169.254", "metadata", false],
    ["2852039166", "metadata", true],
    ["169.254.1.1", "link_local", false],
    ["100.64.0.1", "carrier_nat", false],
    ["0.0.0.0", "unspecified", false],
    ["224.0.0.1", "multicast", false],
    ["8.8.8.8", "public", false],
    ["::1", "loopback", false],
    ["::", "unspecified", false],
    ["::ffff:127.0.0.1", "loopback", false],
    ["::ffff:7f00:1", "loopback", false],
    ["::ffff:10.1.2.3", "private", false],
    ["::ffff:169.254.169.254", "metadata", false],
    ["64:ff9b::a9fe:a9fe", "metadata", false],
    ["fe80::1", "link_local", false],
    ["fd12:3456::1", "unique_local", false],
    ["fd00:ec2::254", "metadata", false],
    ["ff02::1", "multicast", false],
    ["2001:db8::1", "documentation", false],
    ["2002:7f00:0001::1", "loopback", false],
    ["2606:2800:220:1:248:1893:25c8:1946", "public", false],
    ["[::1]", "loopback", false]
  ])("classifies %s as %s", (text, expected, obfuscated) => {
    const parsed = parseIp(text);
    expect(parsed, text).not.toBeNull();
    expect(classifyIp(parsed!)).toBe(expected);
    expect(parsed!.obfuscated).toBe(obfuscated);
  });

  it("rejects malformed addresses", () => {
    expect(parseIpv4("256.1.1.1")).toBeNull();
    expect(parseIpv4("1.2.3.4.5")).toBeNull();
    expect(parseIpv4("example.com")).toBeNull();
    expect(parseIp("::ffff:999.1.1.1")).toBeNull();
    expect(parseIp("1::2::3")).toBeNull();
  });
});

describe("egress checks", () => {
  it("blocks literal non-public addresses in every encoding", async () => {
    for (const url of ["http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/", "http://[::ffff:127.0.0.1]/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://[fd00:ec2::254]/"]) {
      const result = await checkEgressUrl(url);
      expect(result.ok, url).toBe(false);
      expect(result.reason, url).toBe("address_blocked");
    }
  });

  it("blocks local and metadata hostnames and credentials in URLs", async () => {
    expect((await checkEgressUrl("http://localhost:4000/")).reason).toBe("host_blocked");
    expect((await checkEgressUrl("http://metadata.google.internal/computeMetadata/v1/")).reason).toBe("host_blocked");
    expect((await checkEgressUrl("http://db.internal/")).reason).toBe("host_blocked");
    expect((await checkEgressUrl("https://user:pw@api.example.com/")).reason).toBe("credentials_in_url");
    expect((await checkEgressUrl("file:///etc/passwd")).reason).toBe("scheme");
    expect((await checkEgressUrl("gopher://api.example.com/")).reason).toBe("scheme");
  });

  it("resolves hostnames through the injected resolver and blocks DNS rebinding to private space", async () => {
    const rebinding: DnsResolver = async () => ["10.0.0.9"];
    const result = await checkEgressUrl("https://api.example.com/v1", { resolver: rebinding });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("address_blocked");
    expect(result.message).toContain("private");
    const mixed: DnsResolver = async () => ["93.184.216.34", "127.0.0.1"];
    expect((await checkEgressUrl("https://api.example.com/v1", { resolver: mixed })).ok).toBe(false);
    expect((await checkEgressUrl("https://api.example.com/v1", { resolver: publicDns })).ok).toBe(true);
    expect((await checkEgressUrl("https://dual.example.com/v1", { resolver: publicDns })).addresses).toHaveLength(2);
  });

  it("fails closed when the host does not resolve or the resolver errors", async () => {
    expect((await checkEgressUrl("https://nowhere.example/")).reason).toBe("unresolved");
    const failing: DnsResolver = async () => {
      throw new Error("SERVFAIL");
    };
    expect((await checkEgressUrl("https://api.example.com/", { resolver: failing })).reason).toBe("resolver_error");
  });

  it("applies host allowlists with wildcards and ports", async () => {
    expect(hostMatches("api.example.com", "443", "*.example.com")).toBe(true);
    expect(hostMatches("example.com", "443", "*.example.com")).toBe(true);
    expect(hostMatches("evil-example.com", "443", "*.example.com")).toBe(false);
    expect(hostMatches("api.example.com", "8443", "api.example.com:443")).toBe(false);
    const result = await checkEgressUrl("https://other.example.org/", { allowedHosts: ["*.example.com"], resolver: publicDns });
    expect(result.reason).toBe("host_not_allowed");
    expect((await checkEgressUrl("https://api.example.com:8443/", { allowedPorts: [443] })).reason).toBe("port");
  });

  it("checks every hop of a redirect chain", async () => {
    const chain = ["https://api.example.com/go", "https://api.example.com/next", "http://169.254.169.254/latest/"];
    const result = await checkEgressChain(chain, { resolver: publicDns });
    expect(result.ok).toBe(false);
    expect(result.url).toBe(chain[2]);
    expect((await checkEgressChain(chain.slice(0, 2), { resolver: publicDns })).ok).toBe(true);
  });

  it("detector reports blocked URLs in arguments and redirect chains", async () => {
    const detector = createEgressGuardDetector({ resolver: publicDns });
    const content = { url: "http://127.0.0.1:8080/admin", other: "https://api.example.com/v1" };
    const text = JSON.stringify(content);
    const findings = (await detector.detect({ channel: "tool_arguments", content }, { text, options: {}, now: () => 0 })) as GuardFinding[];
    expect(findings).toHaveLength(1);
    expect(findings[0]!.metadata).toMatchObject({ reason: "address_blocked" });
    expect(text.slice(findings[0]!.spans[0]!.start, findings[0]!.spans[0]!.end)).toBe("http://127.0.0.1:8080/admin");
    const redirected = (await detector.detect(
      { channel: "tool_arguments", content: { url: "https://api.example.com/go" }, redirectChain: ["https://api.example.com/go", "http://10.0.0.1/"] },
      { text: JSON.stringify({ url: "https://api.example.com/go" }), options: {}, now: () => 0 }
    )) as GuardFinding[];
    expect(redirected).toHaveLength(1);
    expect(redirected[0]!.message).toContain("after redirect");
  });
});
