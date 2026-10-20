import { describe, expect, it } from "vitest";
import { assignServerSlugs, dedupeToolNames, gatewayToolName, slugifyServerName } from "./gateway-naming";

describe("gateway tool naming", () => {
  it("slugs server names to lowercase words joined by underscores", () => {
    expect(slugifyServerName("GitHub Tools (prod)")).toBe("github_tools_prod");
    expect(slugifyServerName("  Café  Search ")).toBe("cafe_search");
    expect(slugifyServerName("***")).toBe("server");
    expect(slugifyServerName("a".repeat(50))).toHaveLength(32);
  });

  it("numbers colliding slugs by creation order, so the oldest server keeps the plain slug", () => {
    const slugs = assignServerSlugs([
      { id: "b", name: "Docs", createdAt: "2026-02-01T00:00:00.000Z" },
      { id: "a", name: "docs!", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "c", name: "DOCS", createdAt: "2026-03-01T00:00:00.000Z" },
      { id: "d", name: "Search", createdAt: "2026-01-01T00:00:00.000Z" }
    ]);
    expect(slugs.get("a")).toBe("docs");
    expect(slugs.get("b")).toBe("docs_2");
    expect(slugs.get("c")).toBe("docs_3");
    expect(slugs.get("d")).toBe("search");
  });

  it("is stable when a newer colliding server is added", () => {
    const before = assignServerSlugs([{ id: "a", name: "Docs", createdAt: "2026-01-01T00:00:00.000Z" }]);
    const after = assignServerSlugs([
      { id: "z", name: "Docs", createdAt: "2026-05-01T00:00:00.000Z" },
      { id: "a", name: "Docs", createdAt: "2026-01-01T00:00:00.000Z" }
    ]);
    expect(after.get("a")).toBe(before.get("a"));
    expect(after.get("z")).toBe("docs_2");
  });

  it("joins slug and tool with a double underscore", () => {
    expect(gatewayToolName("docs", "search")).toBe("docs__search");
  });

  it("dedupes tool names in order and around reserved names", () => {
    expect(dedupeToolNames(["ask", "ask", "other", "ask"], ["other"])).toEqual(["ask", "ask_2", "other_2", "ask_3"]);
  });
});
