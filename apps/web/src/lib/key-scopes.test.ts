import { describe, expect, it } from "vitest";
import { describeKeyScopes, parseKeyScopes, rolesUpTo } from "./key-scopes";

describe("key scopes (web)", () => {
  it("parses roles, projects and legacy strings like the server", () => {
    expect(parseKeyScopes(["role:builder", "role:viewer", "project:a", "project:a", "read", "role:root"])).toEqual({
      role: "viewer",
      projects: ["a"],
      legacy: ["read", "role:root"]
    });
  });

  it("describes what a key may do", () => {
    expect(describeKeyScopes([])).toBe("owner's role, all projects");
    expect(describeKeyScopes(["role:operator"])).toBe("up to operator");
    expect(describeKeyScopes(["project:alpha"], (id) => id.toUpperCase())).toBe("up to builder · projects: ALPHA");
    expect(describeKeyScopes(["role:viewer", "project:alpha"])).toBe("up to viewer · projects: alpha");
    expect(describeKeyScopes(["read"])).toBe("owner's role, all projects · legacy (not enforced): read");
  });

  it("offers ceilings up to the owner's role", () => {
    expect(rolesUpTo("operator")).toEqual(["viewer", "operator"]);
  });
});
