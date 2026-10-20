import type { MCPExecutionContext } from "./types";
import { describe, expect, it } from "vitest";
import type { McpToolPolicyRule } from "@ai-orchestrator/shared";
import {
  answerServerRequest,
  buildClientCapabilities,
  isCredentialLikeName,
  normalizePromptGetResult,
  normalizePrompts,
  normalizeResourceReadResult,
  normalizeResources,
  normalizeServerCapabilities,
  parseListChangedNotification,
  promptMessagesToText,
  requestedSamplingModels,
  validateElicitationContent,
  validateElicitationRequest,
  validateSamplingRequest
} from "./client-features";
import { evaluateMcpToolAccess, evaluateMcpToolPolicy } from "./tool-policy";

const context: MCPExecutionContext = { resolveSecret: async () => undefined };

describe("client capabilities", () => {
  it("always advertises elicitation and sampling only with a handler", () => {
    expect(buildClientCapabilities(context)).toEqual({ elicitation: {} });
    expect(buildClientCapabilities({ ...context, onSampling: async () => ({ role: "assistant", content: { type: "text", text: "" }, model: "m" }) })).toEqual({
      elicitation: {},
      sampling: {}
    });
  });

  it("normalizes server capabilities and list_changed notifications", () => {
    expect(normalizeServerCapabilities({ tools: { listChanged: true }, resources: { subscribe: true }, prompts: {}, logging: {}, junk: 1 })).toEqual({
      tools: { listChanged: true },
      resources: { subscribe: true },
      prompts: {},
      logging: {}
    });
    expect(parseListChangedNotification({ jsonrpc: "2.0", method: "notifications/resources/list_changed" })).toBe("resources");
    expect(parseListChangedNotification({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })).toBe("tools");
    expect(parseListChangedNotification({ jsonrpc: "2.0", id: 1, method: "notifications/prompts/list_changed" })).toBeNull();
    expect(parseListChangedNotification({ jsonrpc: "2.0", method: "notifications/progress" })).toBeNull();
  });
});

describe("resources and prompts", () => {
  it("normalizes resource lists and drops entries without a uri", () => {
    const resources = normalizeResources([
      { uri: "file:///a.txt", name: "a", mimeType: "text/plain", size: 12.7, annotations: { audience: ["user", "robot"], priority: 0.5 } },
      { name: "no uri" },
      { uri: "file:///b" }
    ]);
    expect(resources).toEqual([
      { uri: "file:///a.txt", name: "a", mimeType: "text/plain", size: 12, annotations: { audience: ["user"], priority: 0.5 } },
      { uri: "file:///b", name: "file:///b" }
    ]);
  });

  it("enforces the read size limit across text and blobs", () => {
    const result = normalizeResourceReadResult("x://1", { contents: [{ uri: "x://1", text: "hello" }, { uri: "x://1", blob: "aGVsbG8=" }] }, 100);
    expect(result.bytes).toBe(10);
    expect(result.contents).toHaveLength(2);
    expect(() => normalizeResourceReadResult("x://1", { contents: [{ uri: "x://1", text: "0123456789" }] }, 9)).toThrow(/read limit/);
  });

  it("normalizes prompts and renders their messages as text", () => {
    expect(normalizePrompts([{ name: "p", arguments: [{ name: "topic", required: true }, { bad: true }] }, { nameless: 1 }])).toEqual([
      { name: "p", arguments: [{ name: "topic", required: true }] }
    ]);
    const got = normalizePromptGetResult("p", {
      description: "d",
      messages: [
        { role: "user", content: { type: "text", text: "Hello" } },
        { role: "assistant", content: { type: "text", text: "Hi" } },
        { role: "user", content: { type: "resource", resource: { uri: "x://r", text: "ctx" } } },
        { role: "user", content: { type: "weird" } }
      ]
    });
    expect(got.messages).toHaveLength(3);
    expect(promptMessagesToText(got.messages)).toBe("User: Hello\n\nAssistant: Hi\n\nUser: ctx");
    expect(promptMessagesToText([{ role: "user", content: { type: "text", text: "only" } }])).toBe("only");
  });
});

describe("elicitation", () => {
  it("accepts the flat primitive schema and rejects nested or credential-looking properties", () => {
    const parsed = validateElicitationRequest({
      message: "Which region?",
      requestedSchema: {
        type: "object",
        properties: {
          region: { type: "string", enum: ["eu", "us"], enumNames: ["Europe", "United States"] },
          count: { type: "integer", minimum: 1 },
          confirm: { type: "boolean", default: true }
        },
        required: ["region", "ghost"]
      }
    });
    expect(parsed.requestedSchema.required).toEqual(["region"]);
    expect(parsed.requestedSchema.properties.region.enumNames).toEqual(["Europe", "United States"]);
    expect(() =>
      validateElicitationRequest({ message: "x", requestedSchema: { type: "object", properties: { nested: { type: "object" } } } })
    ).toThrow(/nested schemas are not allowed/);
    expect(() =>
      validateElicitationRequest({ message: "x", requestedSchema: { type: "object", properties: { api_token: { type: "string" } } } })
    ).toThrow(/look like credentials/);
    expect(isCredentialLikeName("github_pat")).toBe(true);
    expect(isCredentialLikeName("region")).toBe(false);
  });

  it("validates answers against the schema", () => {
    const schema = validateElicitationRequest({
      message: "m",
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
          age: { type: "integer", minimum: 18, maximum: 120 },
          ok: { type: "boolean" },
          plan: { type: "string", enum: ["a", "b"] }
        },
        required: ["email", "age"]
      }
    }).requestedSchema;
    const bad = validateElicitationContent(schema, { email: "nope", age: 12.5, ok: "maybe", plan: "z", extra: 1 });
    expect(bad.errors).toEqual({
      email: "Must be an email address",
      age: "Must be a whole number",
      ok: "Must be true or false",
      plan: "Pick one of the listed values",
      extra: "Not part of the requested schema"
    });
    const good = validateElicitationContent(schema, { email: "a@b.co", age: "42", ok: "true" });
    expect(good.errors).toEqual({});
    expect(good.content).toEqual({ email: "a@b.co", age: 42, ok: true });
    expect(validateElicitationContent(schema, {}).errors).toEqual({ email: "Required", age: "Required" });
  });

  it("declines elicitation/create without a handler and answers through one", async () => {
    const request = {
      id: 7,
      method: "elicitation/create",
      params: { message: "Pick", requestedSchema: { type: "object", properties: { v: { type: "string" } } } }
    };
    expect(await answerServerRequest(request, context, { serverId: "s" })).toEqual({ jsonrpc: "2.0", id: 7, result: { action: "decline" } });
    const answered = await answerServerRequest(
      request,
      { ...context, onElicitation: async () => ({ action: "accept", content: { v: "x" } }) },
      { serverId: "s" }
    );
    expect(answered).toEqual({ jsonrpc: "2.0", id: 7, result: { action: "accept", content: { v: "x" } } });
    const invalid = await answerServerRequest({ id: 8, method: "elicitation/create", params: { message: "" } }, context, { serverId: "s" });
    expect(invalid).toMatchObject({ id: 8, error: { code: -32602 } });
  });
});

describe("sampling", () => {
  it("validates sampling requests and reads the requested models", () => {
    const parsed = validateSamplingRequest({
      messages: [{ role: "user", content: { type: "text", text: "hi" } }, { role: "x" }],
      modelPreferences: { hints: [{ name: "claude" }, { other: 1 }], speedPriority: 0.5 },
      maxTokens: "50.9",
      systemPrompt: "sys",
      stopSequences: ["END", 3]
    });
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.maxTokens).toBe(50);
    expect(parsed.stopSequences).toEqual(["END"]);
    expect(requestedSamplingModels(parsed)).toEqual(["claude"]);
    expect(() => validateSamplingRequest({ messages: [], maxTokens: 10 })).toThrow(/at least one message/);
    expect(() => validateSamplingRequest({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })).toThrow(/maxTokens/);
  });

  it("refuses sampling/createMessage without a handler and relays the model answer with one", async () => {
    const request = { id: "r1", method: "sampling/createMessage", params: { messages: [{ role: "user", content: { type: "text", text: "q" } }], maxTokens: 5 } };
    expect(await answerServerRequest(request, context, { serverId: "s" })).toMatchObject({ id: "r1", error: { code: -32001 } });
    const answered = await answerServerRequest(
      request,
      { ...context, onSampling: async () => ({ role: "assistant", content: { type: "text", text: "a" }, model: "m", stopReason: "endTurn" }) },
      { serverId: "s" }
    );
    expect(answered).toEqual({ jsonrpc: "2.0", id: "r1", result: { role: "assistant", content: { type: "text", text: "a" }, model: "m", stopReason: "endTurn" } });
    expect(await answerServerRequest({ id: 2, method: "ping" }, context, { serverId: "s" })).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(await answerServerRequest({ id: 3, method: "roots/list" }, context, { serverId: "s" })).toMatchObject({ error: { code: -32601 } });
  });
});

describe("policy kinds", () => {
  const rule = (overrides: Partial<McpToolPolicyRule>): McpToolPolicyRule => ({
    id: overrides.id ?? "r",
    name: null,
    description: null,
    effect: "deny",
    projectId: null,
    roles: [],
    serverId: null,
    toolPattern: "*",
    enabled: true,
    ...overrides
  });

  it("rules without a kind only govern tool calls", () => {
    const rules = [rule({ id: "deny-tools" })];
    expect(evaluateMcpToolPolicy(rules, { role: "viewer", adapterId: "http_mcp", toolName: "x" }).allowed).toBe(false);
    expect(evaluateMcpToolPolicy(rules, { role: "viewer", adapterId: "http_mcp", toolName: "file:///x", kind: "resource" }).allowed).toBe(true);
    expect(evaluateMcpToolPolicy(rules, { role: "viewer", adapterId: "http_mcp", toolName: "p", kind: "prompt" }).allowed).toBe(true);
    expect(evaluateMcpToolPolicy(rules, { role: "viewer", adapterId: "http_mcp", toolName: "gpt", kind: "sampling" }).allowed).toBe(true);
  });

  it("resource rules match the uri pattern and prompt rules the prompt name", () => {
    const rules = [rule({ id: "no-secrets", kind: "resource", toolPattern: "file:///etc/*" }), rule({ id: "no-prompt", kind: "prompt", toolPattern: "danger*" })];
    expect(evaluateMcpToolAccess({ rules, role: "builder", adapterId: "stdio_mcp", toolName: "file:///etc/passwd", kind: "resource" })).toMatchObject({
      allowed: false,
      message: expect.stringContaining("MCP resource 'file:///etc/passwd'")
    });
    expect(evaluateMcpToolAccess({ rules, role: "builder", adapterId: "stdio_mcp", toolName: "file:///home/me", kind: "resource" }).allowed).toBe(true);
    expect(evaluateMcpToolAccess({ rules, role: "builder", adapterId: "stdio_mcp", toolName: "dangerous", kind: "prompt" }).allowed).toBe(false);
    expect(evaluateMcpToolAccess({ rules, role: "builder", adapterId: "stdio_mcp", toolName: "dangerous" }).allowed).toBe(true);
  });

  it("no write tools never blocks resources, prompts or sampling, and sampling rules match the model", () => {
    expect(evaluateMcpToolAccess({ rules: [], role: "builder", adapterId: "http_mcp", toolName: "x", kind: "resource", noWriteTools: true }).allowed).toBe(true);
    const rules = [rule({ id: "deny-sampling", kind: "sampling", roles: ["operator"] }), rule({ id: "allow-small", kind: "sampling", roles: ["operator"], effect: "allow", toolPattern: "gpt-4o-mini" })];
    expect(evaluateMcpToolAccess({ rules, role: "operator", adapterId: "http_mcp", toolName: "gpt-4o", kind: "sampling" })).toMatchObject({
      allowed: false,
      message: expect.stringContaining("Sampling with model 'gpt-4o'")
    });
    expect(evaluateMcpToolAccess({ rules, role: "operator", adapterId: "http_mcp", toolName: "gpt-4o-mini", kind: "sampling" }).allowed).toBe(true);
  });
});
