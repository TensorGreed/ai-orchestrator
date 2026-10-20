import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { McpToolPolicyRule } from "@ai-orchestrator/shared";
import { diffToolSnapshots, hashToolSnapshot, normalizeToolSnapshot } from "./schema-diff";
import {
  classifyMcpTool,
  evaluateMcpToolAccess,
  evaluateMcpToolPolicy,
  isStrictlyNarrower,
  matchesToolPattern,
  type McpToolPolicyRequest
} from "./tool-policy";

function rule(partial: Partial<McpToolPolicyRule> & Pick<McpToolPolicyRule, "id" | "effect">): McpToolPolicyRule {
  return {
    name: null,
    description: null,
    projectId: null,
    roles: [],
    serverId: null,
    toolPattern: "*",
    enabled: true,
    ...partial
  };
}

const request = (partial: Partial<McpToolPolicyRequest> = {}): McpToolPolicyRequest => ({
  projectId: "default",
  role: "viewer",
  adapterId: "http_mcp",
  registryServerId: "mcp_github",
  toolName: "create_issue",
  ...partial
});

describe("matchesToolPattern", () => {
  it("matches exact names and globs", () => {
    expect(matchesToolPattern("create_issue", "create_issue")).toBe(true);
    expect(matchesToolPattern("create_issue", "create_issues")).toBe(false);
    expect(matchesToolPattern("*", "anything")).toBe(true);
    expect(matchesToolPattern("create_*", "create_issue")).toBe(true);
    expect(matchesToolPattern("*_issue", "delete_issue")).toBe(true);
    expect(matchesToolPattern("*issue*", "list_issues_v2")).toBe(true);
    expect(matchesToolPattern("create_*", "list_issue")).toBe(false);
  });

  it("treats regex characters in names literally", () => {
    expect(matchesToolPattern("fs.read", "fs.read")).toBe(true);
    expect(matchesToolPattern("fs.read", "fsxread")).toBe(false);
    expect(matchesToolPattern("fs.*", "fs.write")).toBe(true);
  });
});

describe("evaluateMcpToolPolicy", () => {
  it("allows by default when no rule matches", () => {
    const decision = evaluateMcpToolPolicy([], request());
    expect(decision).toMatchObject({ allowed: true, decidedBy: "default", matchedRules: [] });
  });

  it("denies when a deny rule matches", () => {
    const deny = rule({ id: "r1", effect: "deny", toolPattern: "create_*" });
    const decision = evaluateMcpToolPolicy([deny], request());
    expect(decision.allowed).toBe(false);
    expect(decision.rule?.id).toBe("r1");
  });

  it("lets deny win over an equally broad allow", () => {
    const allow = rule({ id: "allow", effect: "allow", serverId: "mcp_github" });
    const deny = rule({ id: "deny", effect: "deny", serverId: "mcp_github" });
    expect(evaluateMcpToolPolicy([allow, deny], request()).allowed).toBe(false);
    expect(evaluateMcpToolPolicy([deny, allow], request()).allowed).toBe(false);
  });

  it("lets deny win over an allow that is broader in some field", () => {
    // The allow names the tool but covers every role, so it is not inside a viewer-only deny.
    const deny = rule({ id: "deny", effect: "deny", roles: ["viewer"], serverId: "mcp_github" });
    const allow = rule({ id: "allow", effect: "allow", serverId: "mcp_github", toolPattern: "create_issue" });
    expect(evaluateMcpToolPolicy([deny, allow], request()).allowed).toBe(false);
  });

  it("lets a strictly narrower allow carve an exception out of a deny", () => {
    const deny = rule({ id: "deny", effect: "deny", roles: ["viewer"], serverId: "mcp_github" });
    const allow = rule({ id: "allow", effect: "allow", roles: ["viewer"], serverId: "mcp_github", toolPattern: "search" });
    const searched = evaluateMcpToolPolicy([deny, allow], request({ toolName: "search" }));
    expect(searched.allowed).toBe(true);
    expect(searched.rule?.id).toBe("allow");
    expect(searched.overriddenDenies).toEqual([{ deny, by: allow }]);
    expect(evaluateMcpToolPolicy([deny, allow], request({ toolName: "create_issue" })).allowed).toBe(false);
  });

  it("still denies when a second deny is not covered by the carve-out", () => {
    const serverDeny = rule({ id: "server", effect: "deny", roles: ["viewer"], serverId: "mcp_github" });
    // Project-scoped, so the all-projects allow does not sit inside it.
    const globalDeny = rule({ id: "global", effect: "deny", projectId: "default", toolPattern: "search" });
    const allow = rule({ id: "allow", effect: "allow", roles: ["viewer"], serverId: "mcp_github", toolPattern: "search" });
    const decision = evaluateMcpToolPolicy([serverDeny, globalDeny, allow], request({ toolName: "search" }));
    expect(decision.allowed).toBe(false);
    expect(decision.rule?.id).toBe("global");
  });

  it("scopes by project", () => {
    const deny = rule({ id: "r", effect: "deny", projectId: "finance" });
    expect(evaluateMcpToolPolicy([deny], request({ projectId: "finance" })).allowed).toBe(false);
    expect(evaluateMcpToolPolicy([deny], request({ projectId: "default" })).allowed).toBe(true);
    expect(evaluateMcpToolPolicy([deny], request({ projectId: null })).allowed).toBe(true);
  });

  it("scopes by role", () => {
    const deny = rule({ id: "r", effect: "deny", roles: ["viewer", "operator"] });
    expect(evaluateMcpToolPolicy([deny], request({ role: "operator" })).allowed).toBe(false);
    expect(evaluateMcpToolPolicy([deny], request({ role: "builder" })).allowed).toBe(true);
  });

  it("scopes by registry server, and by adapter id only for inline servers", () => {
    const registryDeny = rule({ id: "registry", effect: "deny", serverId: "mcp_github" });
    expect(evaluateMcpToolPolicy([registryDeny], request()).allowed).toBe(false);
    expect(evaluateMcpToolPolicy([registryDeny], request({ registryServerId: "mcp_other" })).allowed).toBe(true);

    const adapterDeny = rule({ id: "adapter", effect: "deny", serverId: "http_mcp" });
    expect(evaluateMcpToolPolicy([adapterDeny], request({ registryServerId: undefined })).allowed).toBe(false);
    expect(evaluateMcpToolPolicy([adapterDeny], request()).allowed).toBe(true);
  });

  it("ignores disabled rules", () => {
    const deny = rule({ id: "r", effect: "deny", enabled: false });
    expect(evaluateMcpToolPolicy([deny], request())).toMatchObject({ allowed: true, decidedBy: "default" });
  });

  it("reports a lone matching allow as the deciding rule", () => {
    const allow = rule({ id: "allow", effect: "allow", toolPattern: "create_issue" });
    expect(evaluateMcpToolPolicy([allow], request())).toMatchObject({ allowed: true, decidedBy: "rule", rule: allow });
  });
});

describe("isStrictlyNarrower", () => {
  it("compares every scope field", () => {
    const broad = rule({ id: "b", effect: "deny" });
    const toolOnly = rule({ id: "t", effect: "allow", toolPattern: "search" });
    expect(isStrictlyNarrower(toolOnly, broad)).toBe(true);
    expect(isStrictlyNarrower(broad, toolOnly)).toBe(false);
    expect(isStrictlyNarrower(broad, broad)).toBe(false);
    expect(isStrictlyNarrower(rule({ id: "g", effect: "allow", toolPattern: "search_*" }), rule({ id: "h", effect: "deny", toolPattern: "s*" }))).toBe(false);
    expect(isStrictlyNarrower(rule({ id: "e", effect: "allow", toolPattern: "search_all" }), rule({ id: "h", effect: "deny", toolPattern: "search_*" }))).toBe(true);
    expect(isStrictlyNarrower(rule({ id: "r", effect: "allow", roles: ["viewer"] }), broad)).toBe(true);
    expect(isStrictlyNarrower(rule({ id: "p", effect: "allow", projectId: "x" }), broad)).toBe(true);
  });
});

describe("classifyMcpTool", () => {
  it("prefers a manual override in both directions", () => {
    expect(classifyMcpTool({ manualReadOnly: true, annotations: { readOnlyHint: false } })).toEqual({ readOnly: true, source: "manual" });
    expect(classifyMcpTool({ manualReadOnly: false, annotations: { readOnlyHint: true } })).toEqual({ readOnly: false, source: "manual" });
  });

  it("falls back to the readOnlyHint annotation", () => {
    expect(classifyMcpTool({ annotations: { readOnlyHint: true } })).toEqual({ readOnly: true, source: "annotation" });
    expect(classifyMcpTool({ annotations: { readOnlyHint: false } })).toEqual({ readOnly: false, source: "annotation" });
  });

  it("treats a tool with no signal as a write tool", () => {
    expect(classifyMcpTool({})).toEqual({ readOnly: false, source: "unknown" });
    expect(classifyMcpTool({ annotations: { destructiveHint: false } })).toEqual({ readOnly: false, source: "unknown" });
    expect(classifyMcpTool({ manualReadOnly: null })).toEqual({ readOnly: false, source: "unknown" });
  });
});

describe("evaluateMcpToolAccess", () => {
  it("reports the policy before the no-write switch", () => {
    const deny = rule({ id: "r", name: "No GitHub writes", effect: "deny", serverId: "mcp_github" });
    const decision = evaluateMcpToolAccess({ ...request(), rules: [deny], noWriteTools: true });
    expect(decision).toMatchObject({ allowed: false, reason: "policy", ruleId: "r", ruleName: "No GitHub writes" });
    expect(decision.message).toContain("blocked by policy 'No GitHub writes' (r) for role viewer");
  });

  it("blocks unknown tools when the workflow allows no write tools", () => {
    const decision = evaluateMcpToolAccess({ ...request(), rules: [], noWriteTools: true });
    expect(decision).toMatchObject({ allowed: false, reason: "no_write_tools", classification: { source: "unknown" } });
    expect(decision.message).toContain("no read-only annotation");
  });

  it("allows read-only tools when the workflow allows no write tools", () => {
    expect(evaluateMcpToolAccess({ ...request(), rules: [], noWriteTools: true, annotations: { readOnlyHint: true } }).allowed).toBe(true);
    expect(evaluateMcpToolAccess({ ...request(), rules: [], noWriteTools: true, manualReadOnly: true }).allowed).toBe(true);
  });

  it("ignores classification when write tools are allowed", () => {
    expect(evaluateMcpToolAccess({ ...request(), rules: [] }).allowed).toBe(true);
  });

  it("names the server by its label when one is given, else by id", () => {
    const deny = rule({ id: "r", name: "No GitHub writes", effect: "deny", serverId: "mcp_github" });
    expect(evaluateMcpToolAccess({ ...request(), rules: [deny], serverLabel: "GitHub tools" }).message).toContain(
      "on server 'GitHub tools'"
    );
    expect(evaluateMcpToolAccess({ ...request(), rules: [deny] }).message).toContain("on server 'mcp_github'");
  });
});

describe("snapshot annotations", () => {
  const tools = [
    { name: "b", description: "B", inputSchema: { type: "object", properties: { x: { type: "string" } } } },
    { name: "a", description: "A", inputSchema: { type: "object" } }
  ];

  it("leaves the hash of a server without annotations unchanged", () => {
    // The hash as computed before annotations existed: name, description, canonical schema, sorted by name.
    const legacy = createHash("sha256")
      .update(
        JSON.stringify([
          { name: "a", description: "A", inputSchema: { type: "object" } },
          { name: "b", description: "B", inputSchema: { properties: { x: { type: "string" } }, type: "object" } }
        ])
      )
      .digest("hex");
    expect(hashToolSnapshot(normalizeToolSnapshot(tools))).toBe(legacy);
    expect(normalizeToolSnapshot(tools).every((tool) => !("annotations" in tool))).toBe(true);
  });

  it("keeps annotations in the snapshot and changes the hash when they change", () => {
    const annotated = normalizeToolSnapshot([{ ...tools[1], annotations: { readOnlyHint: true, junk: 1 } }]);
    expect(annotated[0].annotations).toEqual({ readOnlyHint: true });
    expect(hashToolSnapshot(annotated)).not.toBe(hashToolSnapshot(normalizeToolSnapshot([tools[1]])));
  });

  it("records annotation changes as non-breaking", () => {
    const before = normalizeToolSnapshot([{ ...tools[1], annotations: { readOnlyHint: true } }]);
    const after = normalizeToolSnapshot([{ ...tools[1], annotations: { readOnlyHint: false, destructiveHint: true } }]);
    const diff = diffToolSnapshots(before, after);
    expect(diff.breaking).toBe(false);
    expect(diff.changes).toEqual([expect.objectContaining({ tool: "a", kind: "annotations_changed", breaking: false })]);

    const added = diffToolSnapshots(normalizeToolSnapshot([tools[1]]), before);
    expect(added).toMatchObject({ breaking: false, changes: [{ kind: "annotations_changed", breaking: false }] });
  });
});
