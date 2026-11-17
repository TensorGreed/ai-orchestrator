import { describe, expect, it } from "vitest";
import { contentRulesDocumentsSchema, documentHostAllowed, documentHostPatternSchema } from "./content-documents.js";

const at = (url: string) => new URL(url);

describe("document host allow-list", () => {
  it("matches a host without a port on the scheme's default port only", () => {
    expect(documentHostAllowed(at("https://docs.example.com/a"), ["docs.example.com"])).toBe(true);
    expect(documentHostAllowed(at("http://docs.example.com/a"), ["docs.example.com"])).toBe(true);
    expect(documentHostAllowed(at("https://docs.example.com:443/a"), ["docs.example.com"])).toBe(true);
    expect(documentHostAllowed(at("https://docs.example.com:8443/a"), ["docs.example.com"])).toBe(false);
    expect(documentHostAllowed(at("http://docs.example.com:443/a"), ["docs.example.com"])).toBe(false);
    expect(documentHostAllowed(at("https://docs.example.com:80/a"), ["docs.example.com"])).toBe(false);
  });

  it("matches an entry with a port on that port, for either scheme", () => {
    expect(documentHostAllowed(at("https://docs.example.com:8443/a"), ["docs.example.com:8443"])).toBe(true);
    expect(documentHostAllowed(at("http://docs.example.com:8443/a"), ["docs.example.com:8443"])).toBe(true);
    expect(documentHostAllowed(at("https://docs.example.com/a"), ["docs.example.com:8443"])).toBe(false);
    expect(documentHostAllowed(at("https://docs.example.com/a"), ["docs.example.com:443"])).toBe(true);
    expect(documentHostAllowed(at("http://docs.example.com/a"), ["docs.example.com:443"])).toBe(false);
  });

  it("matches subdomains of a wildcard entry, with the same port rule", () => {
    expect(documentHostAllowed(at("https://a.example.com/"), ["*.example.com"])).toBe(true);
    expect(documentHostAllowed(at("https://example.com/"), ["*.example.com"])).toBe(false);
    expect(documentHostAllowed(at("https://a.example.com:9000/"), ["*.example.com"])).toBe(false);
    expect(documentHostAllowed(at("https://a.example.com:9000/"), ["*.example.com:9000"])).toBe(true);
    expect(documentHostAllowed(at("https://a.badexample.com/"), ["*.example.com"])).toBe(false);
  });

  it("refuses other schemes and empty hosts", () => {
    expect(documentHostAllowed({ hostname: "docs.example.com", port: "", protocol: "ftp:" }, ["docs.example.com"])).toBe(false);
    expect(documentHostAllowed({ hostname: "", port: "", protocol: "https:" }, ["docs.example.com"])).toBe(false);
  });

  it("accepts host names with an optional port from 1 to 65535", () => {
    for (const ok of ["docs.example.com", "*.example.com", "docs.example.com:443", "*.example.com:8443", "127.0.0.1:65535", "DOCS.example.com:1"]) {
      expect(documentHostPatternSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["docs.example.com:0", "docs.example.com:65536", "docs.example.com:0443", "docs.example.com:", "http://docs.example.com", "docs.example.com/x", ":443"]) {
      expect(documentHostPatternSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(documentHostPatternSchema.parse(" Docs.Example.com:8443 ")).toBe("docs.example.com:8443");
    expect(contentRulesDocumentsSchema.parse({ enabled: true, allowUrls: true, allowedHosts: ["docs.example.com:8443"] }).allowedHosts).toEqual(["docs.example.com:8443"]);
  });
});
