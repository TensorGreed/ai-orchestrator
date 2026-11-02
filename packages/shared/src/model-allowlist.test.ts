import { describe, expect, it } from "vitest";
import {
  effectiveModelName,
  evaluateModelAllowlist,
  modelAllowlistEntryCreateSchema,
  modelGlobMatches,
  type ModelAllowlistEntry
} from "./model-allowlist";
import { ErrorCategory, remediationForCategory } from "./errors";

function entry(scope: "deployment" | "project", providerId: string, modelGlob: string, projectId: string | null = null): ModelAllowlistEntry {
  return { id: `${scope}-${projectId}-${providerId}-${modelGlob}`, scope, projectId, providerId, modelGlob, note: null, createdAt: "2026-11-02T00:00:00.000Z", createdBy: null };
}

describe("modelGlobMatches", () => {
  it("matches * and ? and literals, ignoring case and surrounding space", () => {
    expect(modelGlobMatches("*", "anything")).toBe(true);
    expect(modelGlobMatches("*", "")).toBe(true);
    expect(modelGlobMatches("gpt-4o*", "gpt-4o-mini")).toBe(true);
    expect(modelGlobMatches("gpt-4o*", "gpt-4o")).toBe(true);
    expect(modelGlobMatches("gpt-4o*", "gpt-4.1")).toBe(false);
    expect(modelGlobMatches("claude-?-sonnet", "claude-3-sonnet")).toBe(true);
    expect(modelGlobMatches("claude-?-sonnet", "claude-35-sonnet")).toBe(false);
    expect(modelGlobMatches("GPT-4O", " gpt-4o ")).toBe(true);
    expect(modelGlobMatches("*mini", "gpt-4o-mini")).toBe(true);
    expect(modelGlobMatches("a*b*c", "axxbyyc")).toBe(true);
    expect(modelGlobMatches("a*b*c", "axxbyy")).toBe(false);
    // Regex characters are literal.
    expect(modelGlobMatches("gpt.4", "gpt-4")).toBe(false);
    expect(modelGlobMatches("llama3.1", "llama3.1")).toBe(true);
  });

  it("stays fast on a pattern built to backtrack", () => {
    const started = Date.now();
    expect(modelGlobMatches("*a".repeat(100) + "b", "a".repeat(200))).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("effectiveModelName", () => {
  it("is the deployment name for Azure OpenAI and the model otherwise", () => {
    expect(effectiveModelName({ providerId: "azure_openai", model: "x", extra: { deployment: "prod-gpt4o" } })).toBe("prod-gpt4o");
    expect(effectiveModelName({ providerId: "azure_openai", model: "prod-gpt4o" })).toBe("prod-gpt4o");
    expect(effectiveModelName({ providerId: "openai_compatible", model: " qwen2 ", extra: { deployment: "ignored" } })).toBe("qwen2");
  });
});

describe("evaluateModelAllowlist", () => {
  const call = (providerId: string, model: string, projectId: string | null = "p1") => ({ providerId, model, projectId });

  it("allows everything with no entries", () => {
    expect(evaluateModelAllowlist([], call("echo", "echo-1"))).toMatchObject({ allowed: true, reason: "no_lists" });
    expect(evaluateModelAllowlist([], call("openai", "gpt-5", null))).toMatchObject({ allowed: true });
  });

  it("applies the deployment list to every project and to calls without one", () => {
    const entries = [entry("deployment", "openai", "gpt-4o*"), entry("deployment", "*", "llama*")];
    expect(evaluateModelAllowlist(entries, call("openai", "gpt-4o-mini")).allowed).toBe(true);
    expect(evaluateModelAllowlist(entries, call("ollama", "llama3.1")).allowed).toBe(true);
    const denied = evaluateModelAllowlist(entries, call("anthropic", "claude-sonnet-5-5", null));
    expect(denied).toMatchObject({ allowed: false, reason: "deployment" });
    expect(denied.allowed ? "" : denied.message).toContain("not on this deployment's model allowlist");
    // The provider id is exact: the same model name on another provider is not allowed.
    expect(evaluateModelAllowlist(entries, call("azure_openai", "gpt-4o")).allowed).toBe(false);
  });

  it("lets a project narrow the deployment list", () => {
    const entries = [entry("deployment", "openai", "*"), entry("project", "openai", "gpt-4o-mini", "p1")];
    expect(evaluateModelAllowlist(entries, call("openai", "gpt-4o-mini")).allowed).toBe(true);
    expect(evaluateModelAllowlist(entries, call("openai", "gpt-5"))).toMatchObject({ allowed: false, reason: "project" });
    // Another project is not narrowed.
    expect(evaluateModelAllowlist(entries, call("openai", "gpt-5", "p2")).allowed).toBe(true);
  });

  it("never lets a project widen the deployment list", () => {
    const entries = [entry("deployment", "openai", "gpt-4o*"), entry("project", "anthropic", "*", "p1")];
    expect(evaluateModelAllowlist(entries, call("anthropic", "claude-sonnet-5-5"))).toMatchObject({ allowed: false, reason: "deployment" });
  });

  it("applies a project list alone when the deployment has none", () => {
    const entries = [entry("project", "echo", "*", "p1")];
    expect(evaluateModelAllowlist(entries, call("echo", "echo-1")).allowed).toBe(true);
    expect(evaluateModelAllowlist(entries, call("openai", "gpt-4o"))).toMatchObject({ allowed: false, reason: "project" });
    expect(evaluateModelAllowlist(entries, call("openai", "gpt-4o", null)).allowed).toBe(true);
  });
});

describe("modelAllowlistEntryCreateSchema", () => {
  it("needs a project for project entries and none for deployment entries", () => {
    expect(modelAllowlistEntryCreateSchema.safeParse({ scope: "deployment", providerId: "openai", modelGlob: "gpt-4o*" }).success).toBe(true);
    expect(modelAllowlistEntryCreateSchema.safeParse({ scope: "project", providerId: "openai", modelGlob: "gpt-4o*" }).success).toBe(false);
    expect(modelAllowlistEntryCreateSchema.safeParse({ scope: "deployment", projectId: "p1", providerId: "openai", modelGlob: "*" }).success).toBe(false);
    expect(modelAllowlistEntryCreateSchema.safeParse({ scope: "deployment", providerId: "open ai", modelGlob: "*" }).success).toBe(false);
    expect(modelAllowlistEntryCreateSchema.safeParse({ scope: "deployment", providerId: "*", modelGlob: " " }).success).toBe(false);
    expect(modelAllowlistEntryCreateSchema.safeParse({ scope: "deployment", providerId: "*", modelGlob: "*", extra: 1 }).success).toBe(false);
  });
});

describe("provider id and pattern case", () => {
  it("stores both lower case and matches a provider id whatever its case", () => {
    const parsed = modelAllowlistEntryCreateSchema.parse({ scope: "deployment", providerId: "OpenAI", modelGlob: "GPT-4o*" });
    expect(parsed).toMatchObject({ providerId: "openai", modelGlob: "gpt-4o*" });
    // An entry written with an upper-case id (an older client, a direct store write) still matches.
    const entries = [entry("deployment", "OpenAI", "gpt-4o*")];
    expect(evaluateModelAllowlist(entries, { providerId: "openai", model: "gpt-4o-mini" }).allowed).toBe(true);
    expect(evaluateModelAllowlist(entries, { providerId: "OPENAI", model: "gpt-4o-mini" }).allowed).toBe(true);
    expect(evaluateModelAllowlist(entries, { providerId: "anthropic", model: "gpt-4o-mini" }).allowed).toBe(false);
  });
});

describe("the model_not_allowed error category", () => {
  it("has its own remediation", () => {
    expect(remediationForCategory(ErrorCategory.MODEL_NOT_ALLOWED)).toContain("Security → Models");
  });
});
