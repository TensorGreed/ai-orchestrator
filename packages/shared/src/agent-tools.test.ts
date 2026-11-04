import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW_TOOL_SCHEMA,
  builtInToolProviderOf,
  builtInToolsEndpoint,
  deriveWorkflowToolDescriptor,
  toWorkflowToolName,
  workflowIdOfToolServerKey,
  workflowToolServerKey
} from "./agent-tools";

describe("built-in tool endpoints", () => {
  it("uses the node's endpoint, the Wikipedia language edition, or the provider default", () => {
    expect(builtInToolsEndpoint({ provider: "wikipedia" })).toBe("https://en.wikipedia.org");
    expect(builtInToolsEndpoint({ provider: "wikipedia", language: "pt-br" })).toBe("https://pt-br.wikipedia.org");
    expect(builtInToolsEndpoint({ provider: "wikipedia", language: "../evil" })).toBe("https://en.wikipedia.org");
    expect(builtInToolsEndpoint({ provider: "serpapi" })).toBe("https://serpapi.com");
    expect(builtInToolsEndpoint({ provider: "searxng", endpoint: "http://search.local:8080/" })).toBe("http://search.local:8080");
    expect(builtInToolsEndpoint({ provider: "searxng" })).toBeNull();
    expect(builtInToolsEndpoint({ provider: "searxng", endpoint: "file:///etc/passwd" })).toBeNull();
    expect(builtInToolsEndpoint({ provider: "nope" })).toBeNull();
    expect(builtInToolProviderOf({ provider: "wolfram" })).toBe("wolfram");
  });
});

describe("workflow tool descriptors", () => {
  const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };

  it("prefers the Expose as MCP Tool trigger, then the Sub-Workflow Trigger, then one free-text input", () => {
    expect(
      deriveWorkflowToolDescriptor({
        id: "w1",
        name: "Ignored",
        nodes: [
          { type: "sub_workflow_trigger", config: { description: "Sub", inputSchema: { properties: {} } } },
          { type: "mcp_server_trigger", config: { toolName: "Find Order", toolDescription: "Finds.", inputSchema: schema } }
        ]
      })
    ).toEqual({ toolName: "find_order", description: "Finds.", inputSchema: schema, source: "mcp_server_trigger" });
    expect(deriveWorkflowToolDescriptor({ id: "w2", name: "Order lookup", nodes: [{ type: "sub_workflow_trigger", config: { description: "Looks up.", inputSchema: { properties: { id: { type: "string" } } } } }] })).toEqual({
      toolName: "order_lookup",
      description: "Looks up.",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      source: "sub_workflow_trigger"
    });
    expect(deriveWorkflowToolDescriptor({ id: "w3", name: "Plain", nodes: [{ type: "manual_trigger" }] })).toEqual({
      toolName: "plain",
      description: "Runs the workflow 'Plain' and returns its output.",
      inputSchema: DEFAULT_WORKFLOW_TOOL_SCHEMA,
      source: "default"
    });
  });

  it("ignores disabled triggers and lets the node override name and description", () => {
    const derived = deriveWorkflowToolDescriptor(
      { id: "w4", name: "X", nodes: [{ type: "mcp_server_trigger", disabled: true, config: { toolName: "hidden" } }] },
      { toolName: "My Tool!", toolDescription: "  Mine.  " }
    );
    expect(derived).toMatchObject({ toolName: "my_tool", description: "Mine.", source: "default" });
  });

  it("names tools safely and keys them as workflow:<id>", () => {
    expect(toWorkflowToolName("  ***  ")).toBe("run_workflow");
    expect(toWorkflowToolName("a".repeat(80))).toHaveLength(64);
    expect(workflowToolServerKey("wf_1")).toBe("workflow:wf_1");
    expect(workflowIdOfToolServerKey("workflow:wf_1")).toBe("wf_1");
    expect(workflowIdOfToolServerKey("workflow:")).toBeNull();
    expect(workflowIdOfToolServerKey("srv_1")).toBeNull();
  });
});
