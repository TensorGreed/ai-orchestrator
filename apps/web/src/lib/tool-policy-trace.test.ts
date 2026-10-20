import { describe, expect, it } from "vitest";
import { buildToolPolicyTraceView, describeToolPolicySubject, readToolPolicyTrace } from "./tool-policy-trace";

describe("tool policy trace view", () => {
  it("formats the subject for each source", () => {
    expect(describeToolPolicySubject({ role: "builder", source: "user", userId: "u1", email: "alice@example.com" })).toBe(
      "Evaluated as builder — triggered by alice@example.com"
    );
    expect(describeToolPolicySubject({ role: "operator", source: "owner", userId: "u2", email: "bob@example.com" })).toBe(
      "Evaluated as operator — workflow owner bob@example.com"
    );
    expect(
      describeToolPolicySubject({ role: "viewer", source: "fallback", fallbackReason: "the workflow has no recorded owner" })
    ).toBe("Evaluated as viewer — workflow owner unknown");
    expect(
      describeToolPolicySubject({ role: "viewer", source: "fallback", fallbackReason: "the workflow owner no longer exists" })
    ).toBe("Evaluated as viewer — workflow owner no longer exists");
  });

  it("reads _toolPolicy from an agent output and builds hidden-tool lines", () => {
    const trace = readToolPolicyTrace({
      answer: "ok",
      _toolPolicy: {
        subject: { role: "viewer", source: "user", email: "v@example.com" },
        projectId: "default",
        noWriteTools: true,
        hidden: [
          { tool: "calculator", server: "mock-mcp", reason: "policy", ruleId: "r1", ruleName: "Viewers: no calculator" },
          { tool: "create_issue", server: "mcp_gh", reason: "no_write_tools" }
        ]
      }
    });
    expect(trace).toBeDefined();
    const view = buildToolPolicyTraceView(trace!);
    expect(view.subject).toBe("Evaluated as viewer — triggered by v@example.com");
    expect(view.lines).toEqual([
      "calculator hidden by policy Viewers: no calculator",
      "create_issue hidden: write tool and this workflow allows no write tools"
    ]);
    expect(view.noWriteTools).toBe(true);
  });

  it("ignores outputs without a policy trace", () => {
    expect(readToolPolicyTrace({ answer: "x" })).toBeUndefined();
    expect(readToolPolicyTrace(null)).toBeUndefined();
    expect(readToolPolicyTrace({ _toolPolicy: { hidden: [] } })).toBeUndefined();
  });
});
