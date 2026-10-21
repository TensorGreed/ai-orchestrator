import { excerptEvidence } from "../masking";
import type { DetectorContext, GuardDetector, GuardFinding, GuardInput } from "../types";
import { locateValue } from "./path-guard";

export const EGRESS_GUARD_DETECTOR_ID = "tool.egress";

/**
 * Phase 12.3 — egress guard. URLs are checked against a host allowlist, then
 * every address the hostname resolves to (through an injectable resolver, so
 * nothing here touches the network on its own) is classified. Private
 * ranges, loopback, link-local, cloud metadata and other non-public
 * addresses are blocked for IPv4 and IPv6, including IPv4-mapped IPv6 and
 * decimal, octal and hex IPv4 spellings. A redirect chain is checked hop by
 * hop.
 */

export type DnsResolver = (hostname: string) => Promise<string[]>;

export type IpClass =
  | "public"
  | "loopback"
  | "private"
  | "link_local"
  | "metadata"
  | "unspecified"
  | "multicast"
  | "reserved"
  | "carrier_nat"
  | "unique_local"
  | "documentation";

export interface ParsedIp {
  family: 4 | 6;
  /** 4 or 16 bytes. */
  bytes: number[];
  /** Original spelling was not canonical dotted-decimal (decimal, octal, hex or short form). */
  obfuscated: boolean;
}

/** The resolver that never resolves: for air-gapped installs and tests that only need literal addresses. */
export const noDnsResolver: DnsResolver = async () => [];

function parseIpv4Part(part: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part, 16);
  if (/^0[0-7]+$/.test(part)) return parseInt(part, 8);
  if (/^\d+$/.test(part)) return Number(part);
  return null;
}

/** IPv4 in any of the forms `inet_aton` accepts: a.b.c.d, a.b.c, a.b, a, with decimal, octal (leading 0) or hex (0x) parts. */
export function parseIpv4(text: string): ParsedIp | null {
  const parts = text.split(".");
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => p === "")) return null;
  const values = parts.map(parseIpv4Part);
  if (values.some((v) => v === null)) return null;
  const nums = values as number[];
  const canonical = parts.length === 4 && parts.every((p) => /^(?:0|[1-9]\d{0,2})$/.test(p)) && nums.every((n) => n <= 255);
  let value: number;
  if (parts.length === 4) {
    if (nums.some((n) => n > 255)) return null;
    value = ((nums[0]! << 24) >>> 0) + (nums[1]! << 16) + (nums[2]! << 8) + nums[3]!;
  } else if (parts.length === 3) {
    if (nums[0]! > 255 || nums[1]! > 255 || nums[2]! > 0xffff) return null;
    value = ((nums[0]! << 24) >>> 0) + (nums[1]! << 16) + nums[2]!;
  } else if (parts.length === 2) {
    if (nums[0]! > 255 || nums[1]! > 0xffffff) return null;
    value = ((nums[0]! << 24) >>> 0) + nums[1]!;
  } else {
    if (nums[0]! > 0xffffffff) return null;
    value = nums[0]!;
  }
  return { family: 4, bytes: [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255], obfuscated: !canonical };
}

export function parseIpv6(text: string): ParsedIp | null {
  let value = text.trim();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (!value.includes(":")) return null;
  // Embedded IPv4 tail (::ffff:127.0.0.1, ::127.0.0.1).
  const lastColon = value.lastIndexOf(":");
  const tail = value.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const hex = `${((v4.bytes[0]! << 8) | v4.bytes[1]!).toString(16)}:${((v4.bytes[2]! << 8) | v4.bytes[3]!).toString(16)}`;
    value = `${value.slice(0, lastColon + 1)}${hex}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + rest.length > 7) return null;
  const groups = [...head, ...Array(8 - head.length - rest.length).fill("0"), ...rest];
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const n = parseInt(group, 16);
    bytes.push(n >> 8, n & 255);
  }
  return { family: 6, bytes, obfuscated: false };
}

export function parseIp(text: string): ParsedIp | null {
  return parseIpv6(text) ?? parseIpv4(text);
}

function inV4Range(bytes: number[], base: number[], prefix: number): boolean {
  const value = ((bytes[0]! << 24) >>> 0) + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!;
  const baseValue = ((base[0]! << 24) >>> 0) + (base[1]! << 16) + (base[2]! << 8) + base[3]!;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((value & mask) >>> 0) === ((baseValue & mask) >>> 0);
}

export function classifyIpv4(bytes: number[]): IpClass {
  if (inV4Range(bytes, [169, 254, 169, 254], 32)) return "metadata";
  if (inV4Range(bytes, [0, 0, 0, 0], 8)) return "unspecified";
  if (inV4Range(bytes, [127, 0, 0, 0], 8)) return "loopback";
  if (inV4Range(bytes, [10, 0, 0, 0], 8) || inV4Range(bytes, [172, 16, 0, 0], 12) || inV4Range(bytes, [192, 168, 0, 0], 16)) return "private";
  if (inV4Range(bytes, [169, 254, 0, 0], 16)) return "link_local";
  if (inV4Range(bytes, [100, 64, 0, 0], 10)) return "carrier_nat";
  if (inV4Range(bytes, [192, 0, 2, 0], 24) || inV4Range(bytes, [198, 51, 100, 0], 24) || inV4Range(bytes, [203, 0, 113, 0], 24)) return "documentation";
  if (inV4Range(bytes, [224, 0, 0, 0], 4)) return "multicast";
  if (inV4Range(bytes, [240, 0, 0, 0], 4) || inV4Range(bytes, [192, 0, 0, 0], 24) || inV4Range(bytes, [198, 18, 0, 0], 15)) return "reserved";
  return "public";
}

export function classifyIp(ip: ParsedIp): IpClass {
  if (ip.family === 4) return classifyIpv4(ip.bytes);
  const b = ip.bytes;
  const allZeroPrefix = b.slice(0, 10).every((x) => x === 0);
  if (allZeroPrefix && b[10] === 0xff && b[11] === 0xff) return classifyIpv4(b.slice(12));
  if (allZeroPrefix && b[10] === 0 && b[11] === 0) {
    const tail = b.slice(12);
    if (tail.every((x) => x === 0)) return "unspecified";
    if (tail[0] === 0 && tail[1] === 0 && tail[2] === 0 && tail[3] === 1) return "loopback";
    // Deprecated IPv4-compatible form ::a.b.c.d.
    return classifyIpv4(tail);
  }
  // 64:ff9b::/96 (NAT64) carries an IPv4 address in its tail.
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return classifyIpv4(b.slice(12));
  if (b[0] === 0xfd && b[1] === 0x00 && b[2] === 0x0e && b[3] === 0xc2) return "metadata";
  if ((b[0]! & 0xfe) === 0xfc) return "unique_local";
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return "link_local";
  if (b[0] === 0xff) return "multicast";
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "documentation";
  if (b[0] === 0x20 && b[1] === 0x02) {
    // 6to4: embedded IPv4 in bytes 2..5.
    return classifyIpv4(b.slice(2, 6));
  }
  return "public";
}

/** Hostnames that always mean a metadata or local service, whatever they resolve to. */
export const BLOCKED_HOSTNAMES: readonly RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /^metadata(?:\.google\.internal)?\.?$/i,
  /^instance-data\.?$/i,
  /\.internal\.?$/i,
  /\.local\.?$/i,
  /^kubernetes\.default(?:\.svc.*)?$/i
];

export interface EgressOptions {
  /** Host patterns: exact host, `*.example.com`, or `example.com:443`. Empty means any public host. */
  allowedHosts?: string[];
  resolver?: DnsResolver;
  /** Only these schemes are allowed (default http, https). */
  allowedSchemes?: string[];
  /** Ports allowed in addition to the scheme's default; empty means any. */
  allowedPorts?: number[];
}

export interface EgressCheck {
  ok: boolean;
  url: string;
  host?: string;
  addresses: Array<{ address: string; class: IpClass }>;
  reason?: "unparseable" | "scheme" | "host_blocked" | "host_not_allowed" | "address_blocked" | "port" | "resolver_error" | "unresolved" | "credentials_in_url";
  message?: string;
}

export function hostMatches(host: string, port: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  const [hostPart, portPart] = p.includes(":") && !p.startsWith("[") ? [p.slice(0, p.lastIndexOf(":")), p.slice(p.lastIndexOf(":") + 1)] : [p, ""];
  if (portPart && portPart !== port) return false;
  const h = host.toLowerCase().replace(/\.$/, "");
  if (hostPart.startsWith("*.")) return h === hostPart.slice(2) || h.endsWith(hostPart.slice(1));
  return h === hostPart;
}

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

export async function checkEgressUrl(rawUrl: string, options: EgressOptions = {}): Promise<EgressCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, url: rawUrl, addresses: [], reason: "unparseable", message: "URL could not be parsed" };
  }
  const schemes = (options.allowedSchemes ?? ["http", "https"]).map((s) => `${s.replace(/:$/, "")}:`);
  if (!schemes.includes(url.protocol)) {
    return { ok: false, url: rawUrl, addresses: [], reason: "scheme", message: `Scheme '${url.protocol.replace(":", "")}' is not allowed` };
  }
  if (url.username || url.password) {
    return { ok: false, url: rawUrl, host: url.hostname, addresses: [], reason: "credentials_in_url", message: "URL carries credentials" };
  }
  const host = url.hostname.replace(/\.$/, "");
  const port = url.port || DEFAULT_PORTS[url.protocol] || "";
  if (options.allowedPorts && options.allowedPorts.length > 0 && port && !options.allowedPorts.includes(Number(port))) {
    return { ok: false, url: rawUrl, host, addresses: [], reason: "port", message: `Port ${port} is not allowed` };
  }
  if (BLOCKED_HOSTNAMES.some((pattern) => pattern.test(host))) {
    return { ok: false, url: rawUrl, host, addresses: [], reason: "host_blocked", message: `Host '${host}' names a local or metadata service` };
  }
  const allowed = (options.allowedHosts ?? []).filter(Boolean);
  if (allowed.length > 0 && !allowed.some((pattern) => hostMatches(host, port, pattern))) {
    return { ok: false, url: rawUrl, host, addresses: [], reason: "host_not_allowed", message: `Host '${host}' is not in the allowlist` };
  }
  const literal = parseIp(host);
  let addresses: string[];
  if (literal) {
    addresses = [host];
  } else {
    try {
      addresses = await (options.resolver ?? noDnsResolver)(host);
    } catch (error) {
      return { ok: false, url: rawUrl, host, addresses: [], reason: "resolver_error", message: `Could not resolve '${host}': ${(error as Error).message}` };
    }
    if (addresses.length === 0) {
      return { ok: false, url: rawUrl, host, addresses: [], reason: "unresolved", message: `Host '${host}' did not resolve to any address` };
    }
  }
  const classified = addresses.map((address) => {
    const parsed = parseIp(address);
    return { address, class: parsed ? classifyIp(parsed) : ("reserved" as IpClass) };
  });
  const blocked = classified.find((entry) => entry.class !== "public");
  if (blocked) {
    return {
      ok: false,
      url: rawUrl,
      host,
      addresses: classified,
      reason: "address_blocked",
      message: `Host '${host}' resolves to a ${blocked.class.replace("_", " ")} address${literal?.obfuscated ? " (written in a non-canonical form)" : ""}`
    };
  }
  return { ok: true, url: rawUrl, host, addresses: classified };
}

/** Check a request and every redirect it followed; the first blocked hop decides. */
export async function checkEgressChain(urls: readonly string[], options: EgressOptions = {}): Promise<EgressCheck> {
  let last: EgressCheck = { ok: false, url: "", addresses: [], reason: "unparseable", message: "Empty redirect chain" };
  for (const url of urls) {
    last = await checkEgressUrl(url, options);
    if (!last.ok) return last;
  }
  return last;
}

const URL_IN_TEXT = /\b(?:https?|ftp|file|gopher|dict|ldap):\/\/[^\s<>"'`)\]}]+/gi;

export function createEgressGuardDetector(defaults: { resolver?: DnsResolver } = {}): GuardDetector {
  return {
    id: EGRESS_GUARD_DETECTOR_ID,
    tier: "rule",
    description: "Checks URL arguments against an allowlist after DNS resolution; blocks private, loopback, link-local and metadata addresses and redirects to them.",
    channels: ["tool_arguments"],
    categories: ["egress"],
    async detect(input: GuardInput, context: DetectorContext) {
      const options: EgressOptions = {
        allowedHosts: Array.isArray(context.options.allowedHosts) ? (context.options.allowedHosts as string[]) : undefined,
        allowedSchemes: Array.isArray(context.options.allowedSchemes) ? (context.options.allowedSchemes as string[]) : undefined,
        allowedPorts: Array.isArray(context.options.allowedPorts) ? (context.options.allowedPorts as number[]) : undefined,
        resolver: defaults.resolver
      };
      const urls = new Set<string>();
      for (const match of context.text.matchAll(URL_IN_TEXT)) urls.add(match[0].replace(/\\$/, ""));
      const findings: GuardFinding[] = [];
      for (const url of urls) {
        const chain = input.redirectChain && input.redirectChain.length > 0 && input.redirectChain[0] === url ? input.redirectChain : [url, ...(input.redirectChain ?? [])];
        const check = await checkEgressChain(chain, options);
        if (check.ok) continue;
        const span = locateValue(context.text, url);
        findings.push({
          detectorId: EGRESS_GUARD_DETECTOR_ID,
          category: "egress",
          score: check.reason === "unresolved" || check.reason === "resolver_error" ? 0.7 : 1,
          spans: [span],
          evidence: excerptEvidence(context.text, span, 60),
          message: check.url !== url ? `${check.message} (after redirect to another host)` : check.message ?? "Outbound URL not allowed",
          metadata: { reason: check.reason, host: check.host, addresses: check.addresses, hop: check.url === url ? 0 : chain.indexOf(check.url) }
        });
      }
      return findings;
    }
  };
}
