import { describe, expect, it } from "vitest";
import {
  connectorDestinationRef,
  describeDestinationSummary,
  destinationHostOfSetting,
  mcpServerDestinationRef,
  resolveDestination
} from "./data-destinations";

/** Phase 16 (p3) — call-time refs shared by the "not classified yet" list and the engine. */
describe("call-time destination refs", () => {
  it("reads hosts from URLs and bare hosts; templates and paths give nothing", () => {
    expect(destinationHostOfSetting("https://API.Example.com:8443/v1")).toBe("api.example.com");
    expect(destinationHostOfSetting("smtp.example.com")).toBe("smtp.example.com");
    expect(destinationHostOfSetting("https://{{vars.host}}/x")).toBeUndefined();
    expect(destinationHostOfSetting("example.com/path")).toBeUndefined();
    expect(destinationHostOfSetting(42)).toBeUndefined();
  });

  it("connectors: a host in their settings, else the vendor host they always call, else an unknown host (public)", () => {
    expect(connectorDestinationRef("smtp_send_email", { host: "mail.corp.internal" })).toEqual({ kind: "connector", id: "smtp_send_email", host: "mail.corp.internal" });
    expect(connectorDestinationRef("slack_send_message", { secretRef: { secretId: "hook" } })).toEqual({ kind: "connector", id: "slack_send_message", host: "hooks.slack.com" });
    // A vendor connector whose address is set but templated: unknown, never the vendor default.
    expect(connectorDestinationRef("slack_send_message", { webhookUrl: "{{vars.hook}}" }).host).toBe("");
    const unknown = connectorDestinationRef("postgres_query", { secretRef: { secretId: "db" } });
    expect(unknown).toEqual({ kind: "connector", id: "postgres_query", host: "" });
    expect(resolveDestination(unknown, []).tier).toBe("public");
    // Credentials are never read for a host.
    expect(connectorDestinationRef("x_node", { auth: { password: "https://evil.example" }, credentials: { url: "https://evil.example" } }).host).toBe("");
  });

  it("MCP servers: none for the mock adapter, the endpoint host otherwise", () => {
    expect(mcpServerDestinationRef({ serverId: "mock-mcp" })).toBeNull();
    expect(mcpServerDestinationRef({ adapterId: "mock-mcp", registryServerId: "m1" })).toBeNull();
    expect(mcpServerDestinationRef({ serverId: "http-mcp", registryServerId: "gh", connection: { endpoint: "https://mcp.github.example/mcp" } })).toEqual({
      kind: "mcp_server",
      id: "gh",
      host: "mcp.github.example"
    });
    expect(mcpServerDestinationRef({ serverId: "http-mcp", connection: {} })).toEqual({ kind: "mcp_server", host: "" });
  });

  it("names a destination in copy by its row, else its host or id, with the tier", () => {
    expect(describeDestinationSummary({ name: "OpenAI", tier: "vendor" })).toBe("OpenAI (vendor)");
    expect(describeDestinationSummary({ host: "api.example.com", tier: "public" })).toBe("api.example.com (public)");
    expect(describeDestinationSummary({ id: "scripted", host: "", tier: "public" })).toBe("scripted (public)");
    expect(describeDestinationSummary({ tier: "public" })).toBe("an unknown host (public)");
  });
});
