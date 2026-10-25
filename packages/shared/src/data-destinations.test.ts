import { describe, expect, it } from "vitest";
import {
  BUILTIN_DESTINATIONS,
  dataDestinationInputSchema,
  dataDestinationRowSchema,
  destinationHostOfUrl,
  destinationTierExceeds,
  findUnclassifiedDestinations,
  normalizeDataDestinationInput,
  normalizeDestinationHost,
  normalizeRegion,
  parseHostPattern,
  regionAllowed,
  resolveDestination,
  resolveRedirectChain,
  type DataDestinationRow
} from "./data-destinations";
import { GUARD_CHANNEL_VALUES, GUARD_PROFILE_CHANNEL_VALUES, PROTECTION_PROVIDER_IDS, guardProtectionNodeConfigSchema } from "./guard";
import { nodeDefinitions } from "./definitions";

let counter = 0;
function row(partial: Partial<DataDestinationRow> & Pick<DataDestinationRow, "kind" | "tier">): DataDestinationRow {
  counter += 1;
  return dataDestinationRowSchema.parse({ id: `dst_${counter}`, name: `Row ${counter}`, ...partial });
}

describe("hosts and patterns", () => {
  it("normalises hosts: case, trailing dot, port, brackets and IP spelling", () => {
    expect(normalizeDestinationHost("API.Example.COM.")).toBe("api.example.com");
    expect(normalizeDestinationHost("api.example.com:8443")).toBe("api.example.com");
    expect(normalizeDestinationHost("[::1]:8080")).toBe("::1");
    expect(normalizeDestinationHost("0:0:0:0:0:0:0:1")).toBe("::1");
    expect(normalizeDestinationHost("::ffff:10.1.2.3")).toBe("10.1.2.3");
    expect(normalizeDestinationHost("FE80::1")).toBe("fe80::1");
    expect(normalizeDestinationHost("2001:db8:0:0:1:0:0:1")).toBe("2001:db8::1:0:0:1");
    expect(normalizeDestinationHost("")).toBeUndefined();
    expect(normalizeDestinationHost("not a host")).toBeUndefined();
    expect(normalizeDestinationHost("010.0.0.1")).toBeUndefined();
    expect(normalizeDestinationHost("0x7f.1")).toBeUndefined();
    expect(normalizeDestinationHost("[::1]")).toBe("::1");
    expect(normalizeDestinationHost("localhost:65535")).toBe("localhost");
  });

  it("accepts host names only, refusing authority and URL spellings", () => {
    for (const bad of [
      "localhost:80@evil.com",
      "user@localhost",
      "[::1].evil.com",
      "[::1]evil",
      "[::1]:80x",
      "[::1]:123456",
      "[localhost]",
      "localhost:evil",
      "localhost:",
      "localhost:123456",
      "localhost/evil.com",
      "evil.com/localhost",
      "localhost\\evil.com",
      "localhost?x=1",
      "localhost#frag",
      "local host",
      "localhost\tevil",
      "http://localhost",
      "fe80::1%eth0"
    ]) {
      expect(normalizeDestinationHost(bad), bad).toBeUndefined();
      expect(resolveDestination({ kind: "http", host: bad }, []).tier, bad).toBe("public");
    }
    // Built from a URL, odd IP spellings are already canonical.
    expect(destinationHostOfUrl("http://0x7f.1/")).toBe("127.0.0.1");
  });

  it("reads the host of a URL", () => {
    expect(destinationHostOfUrl("https://API.openai.com/v1/chat")).toBe("api.openai.com");
    expect(destinationHostOfUrl("http://[::1]:11434/api")).toBe("::1");
    expect(destinationHostOfUrl("not a url")).toBeUndefined();
    expect(destinationHostOfUrl(undefined)).toBeUndefined();
  });

  it("parses exact hosts, wildcards and CIDR ranges and refuses the rest", () => {
    expect(parseHostPattern("api.example.com")).toEqual({ type: "exact", host: "api.example.com" });
    expect(parseHostPattern("*.Corp.Example")).toEqual({ type: "wildcard", suffix: "corp.example" });
    expect(parseHostPattern("10.20.0.0/16")).toMatchObject({ type: "cidr", family: 4, prefix: 16 });
    expect(parseHostPattern("fc00::/7")).toMatchObject({ type: "cidr", family: 6, prefix: 7 });
    expect(parseHostPattern("::ffff:10.0.0.0/104")).toMatchObject({ type: "cidr", family: 4, prefix: 8 });
    for (const bad of ["*", "*.", "*.10.0.0.1", "10.0.0.0/33", "::/129", "10.0.0/8", "a b", "https://x.example"]) {
      expect(parseHostPattern(bad), bad).toBeUndefined();
    }
  });
});

describe("regions", () => {
  it("normalises tags", () => {
    expect(normalizeRegion(" EU West_1 ")).toBe("eu-west-1");
    expect(normalizeRegion("")).toBe("unknown");
    expect(normalizeRegion(null)).toBe("unknown");
    expect(normalizeRegion("us--east")).toBe("us-east");
  });

  it("allows by prefix on word boundaries", () => {
    expect(regionAllowed("eu-west-1", ["eu"])).toBe(true);
    expect(regionAllowed("eu", ["eu"])).toBe(true);
    expect(regionAllowed("europe", ["eu"])).toBe(false);
    expect(regionAllowed("us-east-1", ["eu", "uk"])).toBe(false);
    expect(regionAllowed("unknown", ["eu"])).toBe(false);
    expect(regionAllowed("unknown", ["unknown"])).toBe(true);
    expect(regionAllowed("EU-West-1", ["eu-west"])).toBe(true);
  });

  it("orders tiers", () => {
    expect(destinationTierExceeds("public", "vendor")).toBe(true);
    expect(destinationTierExceeds("private", "private")).toBe(false);
    expect(destinationTierExceeds("local", "private")).toBe(false);
  });
});

describe("built-in destinations", () => {
  it("every built-in row has a valid host pattern and is read-only http", () => {
    for (const builtIn of BUILTIN_DESTINATIONS) {
      expect(builtIn.builtIn).toBe(true);
      expect(builtIn.kind).toBe("http");
      expect(parseHostPattern(builtIn.host), builtIn.id).toBeDefined();
      expect(builtIn.region).toBe("unknown");
    }
  });

  it.each([
    ["localhost", "local"],
    ["api.localhost", "local"],
    ["127.0.0.1", "local"],
    ["127.255.1.9", "local"],
    ["::1", "local"],
    ["10.4.5.6", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "private"],
    ["fd12:3456::1", "private"],
    ["fe80::1", "private"],
    ["::ffff:192.168.0.10", "private"],
    ["db.internal", "private"],
    ["printer.local", "private"],
    ["api.openai.com", "vendor"],
    ["api.anthropic.com", "vendor"],
    ["generativelanguage.googleapis.com", "vendor"],
    ["myres.openai.azure.com", "vendor"],
    ["example.com", "public"],
    ["8.8.8.8", "public"],
    ["2001:4860::8888", "public"]
  ])("classifies %s as %s", (host, tier) => {
    expect(resolveDestination({ kind: "http", host }, []).tier).toBe(tier);
  });

  it("applies built-ins to every kind, by host", () => {
    expect(resolveDestination({ kind: "model_provider", id: "openai", host: "api.openai.com" }, [])).toMatchObject({ tier: "vendor", matchedBy: "builtin", rowId: "builtin:openai", region: "unknown" });
    expect(resolveDestination({ kind: "mcp_server", id: "fs", host: "localhost" }, []).tier).toBe("local");
    // A provider pointed at a local proxy is local, not the vendor its id names.
    expect(resolveDestination({ kind: "model_provider", id: "openai", host: "127.0.0.1" }, []).tier).toBe("local");
  });

  it("treats unmatched destinations and refs without id or host as public", () => {
    expect(resolveDestination({ kind: "http", host: "example.org" }, [])).toEqual({ tier: "public", region: "unknown", holdsDataClasses: [], matchedBy: "unmatched" });
    expect(resolveDestination({ kind: "mcp_server" }, []).matchedBy).toBe("unmatched");
    expect(resolveDestination({ kind: "http", host: "%%%" }, []).tier).toBe("public");
  });
});

describe("resolveDestination precedence", () => {
  it("an id row with a host beats an exact host row", () => {
    const rows = [row({ kind: "model_provider", targetId: "corp-llm", host: "llm.example.com", tier: "private" }), row({ kind: "http", host: "llm.example.com", tier: "public" })];
    expect(resolveDestination({ kind: "model_provider", id: "corp-llm", host: "llm.example.com" }, rows).tier).toBe("private");
  });

  it("an id row with a host constraint needs both and beats an id-only row", () => {
    const rows = [row({ kind: "mcp_server", targetId: "gh", tier: "vendor" }), row({ kind: "mcp_server", targetId: "gh", host: "gh.internal.example", tier: "private" })];
    expect(resolveDestination({ kind: "mcp_server", id: "gh", host: "gh.internal.example" }, rows).tier).toBe("private");
    // The id-only row cannot loosen what api.github.com resolves to (public).
    expect(resolveDestination({ kind: "mcp_server", id: "gh", host: "api.github.com" }, rows)).toMatchObject({ tier: "public", matchedBy: "unmatched" });
    // Without a host, the id-only row applies.
    expect(resolveDestination({ kind: "mcp_server", id: "gh" }, rows).tier).toBe("vendor");
  });

  it("id rows only match their kind", () => {
    const rows = [row({ kind: "connector", targetId: "openai", tier: "private" })];
    expect(resolveDestination({ kind: "model_provider", id: "openai", host: "api.openai.com" }, rows).matchedBy).toBe("builtin");
  });

  it("exact host beats wildcard, longer wildcard beats shorter, wildcard beats CIDR", () => {
    const rows = [
      row({ kind: "http", host: "*.example.com", tier: "public" }),
      row({ kind: "http", host: "*.corp.example.com", tier: "private" }),
      row({ kind: "http", host: "vault.corp.example.com", tier: "local" })
    ];
    expect(resolveDestination({ kind: "http", host: "vault.corp.example.com" }, rows).tier).toBe("local");
    expect(resolveDestination({ kind: "http", host: "wiki.corp.example.com" }, rows).tier).toBe("private");
    expect(resolveDestination({ kind: "http", host: "www.example.com" }, rows).tier).toBe("public");
    // A wildcard covers subdomains, not the bare suffix.
    expect(resolveDestination({ kind: "http", host: "example.com" }, rows).matchedBy).toBe("unmatched");
  });

  it("the narrowest CIDR wins and wildcards never match IP literals", () => {
    const rows = [row({ kind: "http", host: "10.0.0.0/8", tier: "vendor" }), row({ kind: "http", host: "10.20.0.0/16", tier: "local" }), row({ kind: "http", host: "*.0.0.1", tier: "public" })];
    expect(resolveDestination({ kind: "http", host: "10.20.3.4" }, rows).tier).toBe("local");
    expect(resolveDestination({ kind: "http", host: "10.21.3.4" }, rows).tier).toBe("vendor");
  });

  it("an admin row overrides an equally specific built-in, in either direction", () => {
    const looser = [row({ kind: "http", host: "10.0.0.0/8", tier: "local", region: "eu-west-1" })];
    expect(resolveDestination({ kind: "http", host: "10.1.1.1" }, looser)).toMatchObject({ tier: "local", matchedBy: "row", region: "eu-west-1" });
    const stricter = [row({ kind: "http", host: "api.openai.com", tier: "public" })];
    expect(resolveDestination({ kind: "http", host: "api.openai.com" }, stricter)).toMatchObject({ tier: "public", matchedBy: "row" });
    // A broad admin range does not override a narrower built-in.
    const broad = [row({ kind: "http", host: "0.0.0.0/0", tier: "private" })];
    expect(resolveDestination({ kind: "http", host: "127.0.0.1" }, broad).tier).toBe("local");
    expect(resolveDestination({ kind: "http", host: "8.8.8.8" }, broad).tier).toBe("private");
  });

  it("among equally specific rows the stricter tier wins", () => {
    const rows = [row({ kind: "http", host: "api.example.com", tier: "private" }), row({ kind: "http", host: "API.example.com", tier: "vendor" })];
    expect(resolveDestination({ kind: "http", host: "api.example.com" }, rows).tier).toBe("vendor");
    expect(resolveDestination({ kind: "http", host: "api.example.com" }, [...rows].reverse()).tier).toBe("vendor");
  });

  it("returns region, approved classes and the matching row", () => {
    const r = row({ kind: "http", host: "crm.example.com", tier: "vendor", region: "EU West 1", holdsDataClasses: ["email"] });
    expect(resolveDestination({ kind: "connector", id: "crm", host: "crm.example.com:443" }, [r])).toEqual({
      tier: "vendor",
      region: "eu-west-1",
      holdsDataClasses: ["email"],
      matchedBy: "row",
      rowId: r.id,
      name: r.name
    });
  });

  it("ignores built-in rows passed in again", () => {
    expect(resolveDestination({ kind: "http", host: "localhost" }, [...BUILTIN_DESTINATIONS]).rowId).toBe("builtin:localhost");
  });
});

describe("rows matched by id alone never loosen the host", () => {
  it("an id-only private row for openai-compatible does not make a public host private", () => {
    const rows = [row({ kind: "model_provider", targetId: "openai-compatible", tier: "private" })];
    expect(resolveDestination({ kind: "model_provider", id: "openai-compatible", host: "api.together.xyz" }, rows)).toMatchObject({ tier: "public", matchedBy: "unmatched" });
    // Pointed at the in-house server on a private address, it stays private.
    expect(resolveDestination({ kind: "model_provider", id: "openai-compatible", host: "10.1.2.3" }, rows).tier).toBe("private");
    // A provider with no network host (no host on the call) takes the row.
    expect(resolveDestination({ kind: "model_provider", id: "openai-compatible" }, rows)).toMatchObject({ tier: "private", matchedBy: "row" });
  });

  it("openai with a custom base URL resolves by that host, whatever an id-only row says", () => {
    const rows = [row({ kind: "model_provider", targetId: "openai", tier: "private", region: "eu", holdsDataClasses: ["email"] })];
    expect(resolveDestination({ kind: "model_provider", id: "openai", host: "proxy.example.net" }, rows).tier).toBe("public");
    // On the default host the built-in vendor row stands (a tie keeps the host's own resolution, so no region or classes are added).
    expect(resolveDestination({ kind: "model_provider", id: "openai", host: "api.openai.com" }, rows)).toMatchObject({ tier: "vendor", matchedBy: "builtin", region: "unknown", holdsDataClasses: [] });
    // At localhost the stricter id row wins.
    expect(resolveDestination({ kind: "model_provider", id: "openai", host: "localhost" }, rows)).toMatchObject({ tier: "private", matchedBy: "row" });
  });

  it("an id-only row can make a call stricter", () => {
    const rows = [row({ kind: "model_provider", targetId: "openai", tier: "public" })];
    expect(resolveDestination({ kind: "model_provider", id: "openai", host: "api.openai.com" }, rows)).toMatchObject({ tier: "public", matchedBy: "row" });
  });

  it("connector rows with only a type never loosen the database host", () => {
    const rows = [row({ kind: "connector", targetId: "sql", tier: "private" })];
    expect(resolveDestination({ kind: "connector", id: "sql", host: "db.public-cloud.example" }, rows).tier).toBe("public");
    expect(resolveDestination({ kind: "connector", id: "sql", host: "db.corp.internal" }, rows).tier).toBe("private");
    // A type + host row is authoritative for that host.
    const withHost = [...rows, row({ kind: "connector", targetId: "sql", host: "db.public-cloud.example", tier: "vendor" })];
    expect(resolveDestination({ kind: "connector", id: "sql", host: "db.public-cloud.example" }, withHost).tier).toBe("vendor");
  });

  it("a host that is given but is not a plain host name resolves as public, even with an id-only row", () => {
    const rows = [row({ kind: "model_provider", targetId: "corp", tier: "local" })];
    for (const host of ["localhost:80@evil.com", "[::1].evil.com", "localhost:evil", "localhost/x"]) {
      expect(resolveDestination({ kind: "model_provider", id: "corp", host }, rows).tier, host).toBe("public");
    }
  });
});

describe("resolveRedirectChain", () => {
  const rows = () => [
    row({ kind: "http", host: "eu.example.com", tier: "vendor", region: "eu-west-1", holdsDataClasses: ["email", "phone"] }),
    row({ kind: "http", host: "us.example.com", tier: "vendor", region: "us-east-1", holdsDataClasses: ["email"] })
  ];

  it("takes the strictest hop", () => {
    const chain = resolveRedirectChain([{ kind: "http", host: "localhost" }, { kind: "http", host: "evil.example.net" }, { kind: "http", host: "10.0.0.1" }], rows());
    expect(chain.tier).toBe("public");
    expect(chain.hopIndex).toBe(1);
    expect(chain.hops.map((hop) => hop.tier)).toEqual(["local", "public", "private"]);
  });

  it("keeps only classes every hop holds and an agreed region", () => {
    const chain = resolveRedirectChain([{ kind: "http", host: "eu.example.com" }, { kind: "http", host: "us.example.com" }], rows());
    expect(chain.tier).toBe("vendor");
    expect(chain.holdsDataClasses).toEqual(["email"]);
    expect(chain.region).toBe("unknown");
    const single = resolveRedirectChain([{ kind: "http", host: "eu.example.com" }], rows());
    expect(single.region).toBe("eu-west-1");
    expect(single.holdsDataClasses).toEqual(["email", "phone"]);
  });

  it("an empty chain is public", () => {
    expect(resolveRedirectChain([], [])).toMatchObject({ tier: "public", matchedBy: "unmatched", hops: [], hopIndex: -1 });
  });
});

describe("row input validation", () => {
  const ok = (input: unknown) => dataDestinationInputSchema.safeParse(input);
  const messages = (input: unknown) => {
    const result = ok(input);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };

  it("accepts each kind with what it needs", () => {
    expect(ok({ name: "Corp", kind: "http", host: "*.corp.example", tier: "private" }).success).toBe(true);
    expect(ok({ name: "Lab", kind: "http", host: "10.20.0.0/16", tier: "private" }).success).toBe(true);
    expect(ok({ name: "OpenAI EU", kind: "model_provider", targetId: "openai", host: "eu.api.openai.com", tier: "vendor", region: "eu" }).success).toBe(true);
    expect(ok({ name: "GitHub", kind: "mcp_server", host: "api.githubcopilot.com", tier: "vendor" }).success).toBe(true);
    expect(ok({ name: "Drive", kind: "connector", targetId: "google_drive", tier: "vendor" }).success).toBe(true);
  });

  it("explains what is wrong in plain language", () => {
    expect(messages({ name: "", kind: "http", host: "x.example", tier: "public" })).toContain("Give the destination a name");
    expect(messages({ name: "x", kind: "http", tier: "public" })).toContain("A web address needs a host, a wildcard or an IP range");
    expect(messages({ name: "x", kind: "http", host: "bad host", tier: "public" })[0]).toMatch(/Enter a host name/);
    for (const host of ["localhost:80@evil.com", "[::1].evil.com", "localhost:evil", "a.example/path", "a.example\\x", "a.example?x"]) {
      expect(messages({ name: "x", kind: "http", host, tier: "public" })[0], host).toMatch(/Enter a host name/);
      expect(messages({ name: "x", kind: "model_provider", targetId: "openai", host, tier: "public" })[0], host).toMatch(/Enter a host name/);
    }
    expect(messages({ name: "x", kind: "http", host: "a.example", targetId: "x", tier: "public" })).toContain("A web address is matched by its host only");
    expect(messages({ name: "x", kind: "model_provider", tier: "vendor" })[0]).toMatch(/Choose the model provider/);
    expect(messages({ name: "x", kind: "connector", host: "a.example", tier: "vendor" })[0]).toMatch(/connector type/);
    expect(messages({ name: "x", kind: "mcp_server", tier: "vendor" })[0]).toMatch(/MCP server/);
    expect(messages({ name: "x", kind: "mcp_server", host: "*.example.com", tier: "vendor" })[0]).toMatch(/Wildcards and IP ranges are for web addresses/);
    expect(ok({ name: "x", kind: "http", host: "a.example", tier: "nearby" }).success).toBe(false);
    expect(ok({ name: "x", kind: "http", host: "a.example", tier: "public", holdsDataClasses: ["bad class!"] }).success).toBe(false);
  });

  it("normalises the stored form", () => {
    const parsed = dataDestinationInputSchema.parse({ name: " Corp ", kind: "http", host: "API.Corp.Example.", tier: "private", region: "EU West", holdsDataClasses: ["phone", "email", "email"], note: "  " });
    expect(normalizeDataDestinationInput(parsed)).toEqual({
      name: "Corp",
      kind: "http",
      targetId: null,
      host: "api.corp.example",
      tier: "private",
      region: "eu-west",
      holdsDataClasses: ["email", "phone"],
      note: null
    });
    expect(normalizeDataDestinationInput(dataDestinationInputSchema.parse({ name: "W", kind: "http", host: "*.Corp.Example", tier: "private" })).host).toBe("*.corp.example");
    expect(normalizeDataDestinationInput(dataDestinationInputSchema.parse({ name: "C", kind: "http", host: "10.0.0.0/8", tier: "private" })).region).toBe("unknown");
  });

  it("stores a CIDR range as its network address", () => {
    const store = (host: string) => normalizeDataDestinationInput(dataDestinationInputSchema.parse({ name: "C", kind: "http", host, tier: "private" })).host;
    expect(store("10.0.0.1/8")).toBe("10.0.0.0/8");
    expect(store("10.0.0.0/8")).toBe("10.0.0.0/8");
    expect(store("192.168.17.200/20")).toBe("192.168.16.0/20");
    expect(store("172.16.0.1/32")).toBe("172.16.0.1/32");
    expect(store("FD12:3456::1/16")).toBe("fd12::/16");
    expect(store("::ffff:10.9.9.9/104")).toBe("10.0.0.0/8");
    expect(store("0.0.0.0/0")).toBe("0.0.0.0/0");
  });
});

describe("findUnclassifiedDestinations", () => {
  it("lists configured destinations nothing covers, grouped, with a suggestion", () => {
    const covered = row({ kind: "mcp_server", targetId: "github", host: "api.githubcopilot.com", tier: "vendor" });
    const list = findUnclassifiedDestinations(
      [
        { ref: { kind: "model_provider", id: "openai", host: "api.openai.com" }, seenIn: "Workflow A" },
        { ref: { kind: "model_provider", id: "openai_compatible", host: "llm.example.net" }, seenIn: "Workflow A" },
        { ref: { kind: "model_provider", id: "openai_compatible", host: "LLM.example.net" }, seenIn: "Workflow B" },
        { ref: { kind: "mcp_server", id: "github", host: "api.githubcopilot.com" }, seenIn: "MCP server github" },
        { ref: { kind: "mcp_server", id: "files", host: "localhost" }, seenIn: "MCP server files" },
        { ref: { kind: "http", host: "hooks.example.org" }, seenIn: "Workflow C" },
        { ref: { kind: "connector", id: "postgres", host: "db.example.org" }, seenIn: "Workflow D" },
        { ref: { kind: "http" }, seenIn: "nothing" }
      ],
      [covered]
    );
    expect(list.map((entry) => [entry.kind, entry.targetId ?? null, entry.host ?? null])).toEqual([
      ["model_provider", "openai_compatible", "llm.example.net"],
      ["connector", "postgres", "db.example.org"],
      ["http", null, "hooks.example.org"]
    ]);
    expect(list[0]!.seenIn).toEqual(["Workflow A", "Workflow B"]);
    expect(list[0]!.current.tier).toBe("public");
    expect(list[0]!.suggestion).toEqual({ name: "llm.example.net", kind: "model_provider", targetId: "openai_compatible", host: "llm.example.net", tier: "public" });
    expect(list[1]!.suggestion).toEqual({ name: "db.example.org", kind: "connector", targetId: "postgres", host: "db.example.org", tier: "public" });
    expect(list[2]!.suggestion).toMatchObject({ kind: "http", targetId: null, tier: "public" });
  });

  it("each suggestion is a valid row input", () => {
    const list = findUnclassifiedDestinations(
      [
        { ref: { kind: "model_provider", id: "anthropic", host: "proxy.example.net" }, seenIn: "a" },
        { ref: { kind: "mcp_server", host: "mcp.example.net" }, seenIn: "b" },
        { ref: { kind: "connector", id: "sql", host: "db.example.net" }, seenIn: "c" },
        { ref: { kind: "http", host: "x.example.net" }, seenIn: "d" }
      ],
      []
    );
    expect(list).toHaveLength(4);
    for (const entry of list) expect(dataDestinationInputSchema.safeParse(entry.suggestion).success, JSON.stringify(entry.suggestion)).toBe(true);
  });
});

describe("guard contract additions", () => {
  it("adds egress to profile channels only, never to the Guard node", () => {
    expect(GUARD_PROFILE_CHANNEL_VALUES).toContain("egress");
    expect(GUARD_CHANNEL_VALUES as readonly string[]).not.toContain("egress");
    expect(GUARD_PROFILE_CHANNEL_VALUES.slice(0, GUARD_CHANNEL_VALUES.length)).toEqual([...GUARD_CHANNEL_VALUES]);
  });

  it("offers surrogate on the Protection Provider node without a key secret", () => {
    expect(PROTECTION_PROVIDER_IDS).toContain("surrogate");
    expect(guardProtectionNodeConfigSchema.safeParse({ providerId: "surrogate", dataClasses: ["email"] }).success).toBe(true);
    const definition = nodeDefinitions.find((entry) => entry.type === "guard_protection");
    const providerEnum = (definition?.configSchema as { properties: { providerId: { enum: string[] } } }).properties.providerId.enum;
    expect(providerEnum).toEqual([...PROTECTION_PROVIDER_IDS]);
  });
});
