import { describe, expect, it } from "vitest";
import { newNodeConfig } from "./trigger-paths";

describe("new trigger nodes get their own path", () => {
  it("suffixes the sample path of webhook, form and MCP trigger nodes", () => {
    expect(newNodeConfig("webhook_input", { path: "agent-demo", method: "POST" }, () => "x1y2z3")).toEqual({ path: "agent-demo-x1y2z3", method: "POST" });
    expect(newNodeConfig("form_trigger", { path: "feedback", fields: [] }, () => "abc123")).toMatchObject({ path: "feedback-abc123" });
    expect(newNodeConfig("mcp_server_trigger", { path: "helper" }, () => "q")).toMatchObject({ path: "helper-q" });
    expect(newNodeConfig("webhook_input", {}, () => "q")).toEqual({ path: "webhook-q" });
  });

  it("two new webhook nodes never share the default path", () => {
    const paths = new Set(Array.from({ length: 50 }, () => newNodeConfig("webhook_input", { path: "agent-demo" }).path));
    expect(paths.size).toBe(50);
    for (const path of paths) expect(path).toMatch(/^agent-demo-[0-9a-z]{6}$/);
  });

  it("leaves other nodes' config alone and never mutates the sample", () => {
    const sample = { path: "slack-events" };
    expect(newNodeConfig("slack_trigger", sample)).toEqual({ path: "slack-events" });
    newNodeConfig("webhook_input", sample);
    expect(sample).toEqual({ path: "slack-events" });
  });
});
