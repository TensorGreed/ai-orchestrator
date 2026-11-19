import { describe, expect, it } from "vitest";
import { PUBLIC_ENTRY_WARNING_CODE, getNodeDefinition, publicEntryMessage, publicEntryWarnings } from "./index";

const node = (type: string, config: Record<string, unknown> = {}) => ({ id: `${type}_1`, type, config });

describe("public live triggers", () => {
  it("flags a webhook with no token or signature, a public form and a public MCP tool, unset read as the routes read it", () => {
    expect(publicEntryMessage(node("webhook_input", { path: "a" }))).toMatch(/^Public webhook/);
    expect(publicEntryMessage(node("webhook_input", { authMode: "none" }))).toMatch(/^Public webhook/);
    expect(publicEntryMessage(node("form_trigger", { path: "f" }))).toMatch(/^Public form/);
    expect(publicEntryMessage(node("form_trigger", { authMode: "public" }))).toMatch(/^Public form/);
    expect(publicEntryMessage(node("mcp_server_trigger", { path: "t" }))).toMatch(/^Public MCP tool/);
    expect(publicEntryMessage(node("mcp_server_trigger", { authMode: "public" }))).toMatch(/^Public MCP tool/);
  });

  it("reads unknown modes as the routes do: open", () => {
    expect(publicEntryMessage(node("webhook_input", { authMode: "bearer" }))).toMatch(/^Public webhook/);
    expect(publicEntryMessage(node("form_trigger", { authMode: "bearer" }))).toMatch(/^Public form/);
    expect(publicEntryMessage(node("mcp_server_trigger", { authMode: "session" }))).toMatch(/^Public MCP tool/);
    expect(publicEntryMessage(node("chat_trigger", { authMode: "public" }))).toMatch(/^Public chat/);
    expect(publicEntryMessage(node("chat_trigger"))).toMatch(/^Public chat/);
  });

  it("compares the mode exactly, as the routes do, and flags a Telegram trigger without a secret token (on or off)", () => {
    expect(publicEntryMessage(node("mcp_server_trigger", { authMode: "bearer " }))).toMatch(/^Public MCP tool/);
    expect(publicEntryMessage(node("webhook_input", { authMode: " bearer_token" }))).toMatch(/^Public webhook/);
    expect(publicEntryMessage(node("telegram_trigger", {}))).toMatch(/^Public Telegram trigger/);
    expect(publicEntryMessage(node("telegram_trigger", { active: false }))).toMatch(/^Public Telegram trigger/);
    expect(publicEntryMessage(node("telegram_trigger", { signingSecretRef: { secretId: "sec_1" } }))).toBeNull();
  });

  it("leaves out protected and switched-off triggers and every other node", () => {
    expect(publicEntryMessage(node("webhook_input", { authMode: "bearer_token" }))).toBeNull();
    expect(publicEntryMessage(node("webhook_input", { authMode: "hmac_sha256" }))).toBeNull();
    expect(publicEntryMessage(node("form_trigger", { authMode: "session" }))).toBeNull();
    expect(publicEntryMessage(node("mcp_server_trigger", { authMode: "bearer" }))).toBeNull();
    expect(publicEntryMessage(node("webhook_input", { authMode: "none", active: false }))).toBeNull();
    expect(publicEntryMessage(node("mcp_server_trigger", { active: false }))).toBeNull();
    expect(publicEntryMessage(node("http_request", { authMode: "none" }))).toBeNull();
    expect(publicEntryMessage(node("chat_trigger", { authMode: "session" }))).toBeNull();
    expect(publicEntryMessage(node("chat_trigger", { authMode: "bearer" }))).toBeNull();
  });

  it("gives one one-line warning per open trigger, never an error", () => {
    const issues = publicEntryWarnings({
      nodes: [node("webhook_input"), { ...node("form_trigger"), id: "f" }, node("set_node"), { ...node("mcp_server_trigger", { authMode: "bearer" }), id: "m" }]
    });
    expect(issues.map((issue) => issue.nodeId)).toEqual(["webhook_input_1", "f"]);
    for (const issue of issues) {
      expect(issue).toMatchObject({ code: PUBLIC_ENTRY_WARNING_CODE, severity: "warning" });
      expect(issue.message).not.toContain("\n");
    }
  });

  it("a new Expose as MCP Tool node asks for a bearer token", () => {
    expect(getNodeDefinition("mcp_server_trigger")?.sampleConfig.authMode).toBe("bearer");
  });
});
