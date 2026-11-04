import { describe, expect, it } from "vitest";
import {
  canonicalIpRange,
  ipAllowlistSchema,
  mcpClientNetworkUpdateSchema,
  normalizeCertFingerprint,
  parseIpAllowlist,
  readStoredIpAllowlist,
  splitIpAllowlist
} from "./index";

describe("13.2 — address allowlists", () => {
  it("reads IP addresses and CIDR ranges canonical, IPv6 and IPv4-mapped included", () => {
    expect(canonicalIpRange("10.1.2.3/8")).toBe("10.0.0.0/8");
    expect(canonicalIpRange("192.168.0.7")).toBe("192.168.0.7/32");
    expect(canonicalIpRange("2001:DB8::1/32")).toBe("2001:db8::/32");
    expect(canonicalIpRange("::1")).toBe("::1/128");
    expect(canonicalIpRange("::ffff:10.0.0.1")).toBe("10.0.0.1/32");
    expect(canonicalIpRange("::ffff:10.0.0.0/104")).toBe("10.0.0.0/8");
    for (const bad of ["", "10.0.0.256", "10.0.0.0/33", "2001:db8::/129", "example.com", "*.example.com", "10.0.0.0/8/1", "010.0.0.1"]) {
      expect(canonicalIpRange(bad), bad).toBeUndefined();
    }
  });

  it("splits lists, drops duplicates and reports bad entries as given", () => {
    expect(splitIpAllowlist(" 10.0.0.0/8, 10.1.0.0/16\n2001:db8::/32 ")).toEqual(["10.0.0.0/8", "10.1.0.0/16", "2001:db8::/32"]);
    expect(parseIpAllowlist(["10.0.0.1/8", "10.0.0.0/8", "nope"])).toEqual({ ranges: ["10.0.0.0/8"], invalid: ["nope"] });
    expect(ipAllowlistSchema.parse(["10.0.0.1/8", "10.0.0.0/8"])).toEqual(["10.0.0.0/8"]);
    expect(ipAllowlistSchema.safeParse(["nope"]).error?.issues[0]?.message).toBe("'nope' is not an IP address or CIDR range");
  });

  it("treats a stored list with only bad entries as restricted (admits nobody)", () => {
    expect(readStoredIpAllowlist(undefined)).toEqual({ restricted: false, ranges: [], invalid: [] });
    expect(readStoredIpAllowlist([])).toEqual({ restricted: false, ranges: [], invalid: [] });
    expect(readStoredIpAllowlist(["nonsense"])).toEqual({ restricted: true, ranges: [], invalid: ["nonsense"] });
    expect(readStoredIpAllowlist("10.0.0.0/8, 192.168.1.1")).toMatchObject({ restricted: true, ranges: ["10.0.0.0/8", "192.168.1.1/32"] });
  });
});

describe("13.2 — certificate fingerprints and the client network update", () => {
  const hex = "1b50219ee0272a0d26c7d09b2b293bd5b52c2fbcd7473c52d3ef982bfc293f58";
  it("normalises the colon form and a sha256 prefix", () => {
    expect(normalizeCertFingerprint(hex.toUpperCase().match(/../g)!.join(":"))).toBe(hex);
    expect(normalizeCertFingerprint(`sha256:${hex}`)).toBe(hex);
    expect(normalizeCertFingerprint("abc")).toBeUndefined();
  });

  it("parses partial updates, clears an empty subject and refuses unknown fields or an empty payload", () => {
    expect(mcpClientNetworkUpdateSchema.parse({ allowedIps: ["10.0.0.1"] })).toEqual({ allowedIps: ["10.0.0.1/32"] });
    expect(mcpClientNetworkUpdateSchema.parse({ certFingerprints: [hex, hex.toUpperCase()], certSubject: "" })).toEqual({ certFingerprints: [hex], certSubject: null });
    expect(mcpClientNetworkUpdateSchema.safeParse({}).success).toBe(false);
    expect(mcpClientNetworkUpdateSchema.safeParse({ allowedIps: [], role: "admin" }).success).toBe(false);
  });
});
