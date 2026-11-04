import { describe, expect, it } from "vitest";
import { WORKFLOW_SCHEMA_VERSION, type Workflow } from "@ai-orchestrator/shared";
import { validateWorkflowGraph } from "./validation";

function webhook(config: Record<string, unknown>): Workflow {
  return {
    id: "wf",
    name: "Webhook",
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    workflowVersion: 1,
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: "p", method: "POST", authMode: "none", ...config } },
      { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: {} }
    ],
    edges: [{ id: "e1", source: "hook", target: "out" }]
  };
}

const codes = (workflow: Workflow) => validateWorkflowGraph(workflow).issues.map((issue) => issue.code);

describe("13.2 — webhook trigger allowedIps", () => {
  it("accepts IPv4 / IPv6 addresses and ranges, an empty list, or none", () => {
    expect(codes(webhook({}))).not.toContain("invalid_webhook_allowed_ips");
    expect(codes(webhook({ allowedIps: [] }))).not.toContain("invalid_webhook_allowed_ips");
    expect(codes(webhook({ allowedIps: ["10.0.0.0/8", "192.168.1.5", "2001:db8::/32"] }))).not.toContain("invalid_webhook_allowed_ips");
  });

  it("flags an entry that is not an address or range, and a value that is not a list", () => {
    const result = validateWorkflowGraph(webhook({ allowedIps: ["10.0.0.0/8", "slack.com"] }));
    const issue = result.issues.find((entry) => entry.code === "invalid_webhook_allowed_ips");
    expect(issue?.message).toContain("'slack.com'");
    expect(issue?.nodeId).toBe("hook");
    expect(codes(webhook({ allowedIps: "10.0.0.0/8" }))).toContain("invalid_webhook_allowed_ips");
  });
});
