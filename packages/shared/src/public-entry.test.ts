import { describe, expect, it } from "vitest";
import { PUBLIC_ENTRY_WARNING_CODE, getNodeDefinition, publicEntryMessage, publicEntryWarnings, unknownAuthMode } from "./index";

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

  it("reads unknown modes as the routes do: refused, and says so", () => {
    expect(publicEntryMessage(node("webhook_input", { authMode: "bearer" }))).toMatch(/^Auth Mode 'bearer' is not one this trigger knows/);
    expect(publicEntryMessage(node("form_trigger", { authMode: "bearer" }))).toMatch(/refuses every call/);
    expect(publicEntryMessage(node("mcp_server_trigger", { authMode: "session" }))).toMatch(/refuses every call/);
    expect(publicEntryMessage(node("chat_trigger", { authMode: "public" }))).toMatch(/^Public chat/);
    expect(publicEntryMessage(node("chat_trigger"))).toMatch(/^Public chat/);
  });

  it("compares the mode exactly, as the routes do; a Telegram trigger is never open (it refuses calls without its token)", () => {
    // A padded or unknown mode is not a protected mode, and not an open one either: the routes refuse every call.
    expect(publicEntryMessage(node("mcp_server_trigger", { authMode: "bearer " }))).toMatch(/^Auth Mode 'bearer ' is not one this trigger knows/);
    expect(publicEntryMessage(node("webhook_input", { authMode: " bearer_token" }))).toMatch(/refuses every call/);
    expect(unknownAuthMode(node("webhook_input", { authMode: " bearer_token" }))).toBe(" bearer_token");
    expect(unknownAuthMode(node("chat_trigger", { authMode: "public" }))).toBeNull();
    expect(unknownAuthMode(node("form_trigger", { authMode: "none" }))).toBeNull();
    expect(unknownAuthMode(node("form_trigger", {}))).toBeNull();
    expect(unknownAuthMode(node("telegram_trigger", { authMode: "x" }))).toBeNull();
    expect(publicEntryMessage(node("telegram_trigger", {}))).toBeNull();
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
