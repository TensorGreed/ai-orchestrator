import { describe, expect, it } from "vitest";
import { ErrorCategory, WorkflowError, remediationForCategory } from "./errors";

describe("remediationForCategory", () => {
  it("returns a non-empty hint for every defined ErrorCategory value", () => {
    for (const category of Object.values(ErrorCategory)) {
      const hint = remediationForCategory(category);
      expect(typeof hint).toBe("string");
      expect(hint.length).toBeGreaterThan(20);
    }
  });

  it("refines PROVIDER_AUTH with the providerId metadata", () => {
    const hint = remediationForCategory(ErrorCategory.PROVIDER_AUTH, { providerId: "openai" });
    expect(hint).toMatch(/openai/i);
    expect(hint).toMatch(/Settings.*Secrets|API key/i);
  });

  it("falls back to a generic PROVIDER_AUTH hint without providerId", () => {
    const hint = remediationForCategory(ErrorCategory.PROVIDER_AUTH);
    expect(hint).not.toMatch(/openai/i);
    expect(hint).toMatch(/credentials|API key/i);
  });

  it("refines MCP_AUTH with the serverId metadata", () => {
    const hint = remediationForCategory(ErrorCategory.MCP_AUTH, { serverId: "http_mcp" });
    expect(hint).toMatch(/http_mcp/);
    expect(hint).toMatch(/auth|secret/i);
  });

  it("refines NODE_CONFIG with the nodeType metadata", () => {
    const hint = remediationForCategory(ErrorCategory.NODE_CONFIG, { nodeType: "agent_orchestrator" });
    expect(hint).toMatch(/agent_orchestrator/);
  });

  it("includes the configured timeout in WORKFLOW_TIMEOUT remediation", () => {
    const hint = remediationForCategory(ErrorCategory.WORKFLOW_TIMEOUT, { timeoutMs: 60000 });
    expect(hint).toMatch(/60000/);
    expect(hint).toMatch(/WORKFLOW_EXECUTION_TIMEOUT_MS|executionTimeoutMs/);
  });

  it("includes the OPENAI_API_KEY hint for PROVIDER_AUTH with openai provider", () => {
    const hint = remediationForCategory(ErrorCategory.PROVIDER_AUTH, { providerId: "openai" });
    expect(hint).toMatch(/OPENAI_API_KEY/);
  });

  it("returns the unknown-category fallback for UNKNOWN", () => {
    const hint = remediationForCategory(ErrorCategory.UNKNOWN);
    expect(hint).toMatch(/issues|github\.com|stack trace/i);
  });
});

describe("WorkflowError.remediation", () => {
  it("auto-derives remediation from the category when no explicit override is passed", () => {
    const err = WorkflowError.providerAuth("Bad token", { providerId: "anthropic" });
    expect(err.remediation).toMatch(/anthropic/i);
    expect(err.remediation).toMatch(/Settings.*Secrets|API key/i);
  });

  it("respects an explicit remediation override on the constructor", () => {
    const err = new WorkflowError(
      "Custom failure",
      ErrorCategory.PROVIDER_AUTH,
      false,
      { providerId: "openai" },
      "Custom remediation: rotate the production OpenAI key in Vault."
    );
    expect(err.remediation).toBe(
      "Custom remediation: rotate the production OpenAI key in Vault."
    );
  });

  it("preserves all existing fields (category, retryable, metadata, message)", () => {
    const err = WorkflowError.mcpTransient("Timeout", { serverId: "http_mcp", attempts: 3 });
    expect(err.message).toBe("Timeout");
    expect(err.category).toBe(ErrorCategory.MCP_TRANSIENT);
    expect(err.retryable).toBe(true);
    expect(err.metadata).toEqual({ serverId: "http_mcp", attempts: 3 });
    expect(err.remediation.length).toBeGreaterThan(20);
  });

  it("provides remediation for parser errors that mentions parser strictness", () => {
    const err = WorkflowError.parserError("invalid json: ...");
    expect(err.remediation).toMatch(/strict|lenient|anything_goes|JSON/i);
  });

  it("is throwable and catchable like a normal Error", () => {
    expect(() => {
      throw WorkflowError.timeout("ran too long", { timeoutMs: 1000 });
    }).toThrowError(/ran too long/);
  });
});
