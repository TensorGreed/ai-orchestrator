import { describe, expect, it } from "vitest";
import { agentWebhookPayloadSchema, testWebhookPayloadCredentialFields, TEST_WEBHOOK_PAYLOAD_MAX_CHARS, workflowSchema } from "./schemas";

const base = { id: "wf", name: "WF", nodes: [], edges: [] };

describe("a workflow's test webhook payload", () => {
  it("is optional, and an ordinary payload is kept as typed", () => {
    expect(workflowSchema.safeParse(base).success).toBe(true);
    const parsed = workflowSchema.parse({ ...base, settings: { testWebhookPayload: { customer: "Ana", items: [{ sku: "A1", qty: 2 }] } } });
    expect(parsed.settings?.testWebhookPayload).toEqual({ customer: "Ana", items: [{ sku: "A1", qty: 2 }] });
  });

  it("refuses fields named like credentials, nested ones included, and names them", () => {
    const result = workflowSchema.safeParse({
      ...base,
      settings: { testWebhookPayload: { user: { name: "Ana", password: "x" }, apiKey: "k", headers: [{ Authorization: "Bearer t" }] } }
    });
    expect(result.success).toBe(false);
    const message = result.success ? "" : result.error.issues.map((issue) => issue.message).join(" ");
    expect(message).toContain("user.password");
    expect(message).toContain("apiKey");
    expect(message).toContain("headers.0.Authorization");
  });

  it("does not mistake ordinary names for credentials", () => {
    expect(testWebhookPayloadCredentialFields({ tokenizer: "bpe", secretary: "Bo", keyboard: "us", author: "Al", passage: "p" })).toEqual([]);
    expect(testWebhookPayloadCredentialFields({ access_token: "t", client_secret: "s", "x-api-key": "k", session_cookie: "c" })).toEqual([
      "access_token",
      "client_secret",
      "x-api-key",
      "session_cookie"
    ]);
  });

  it("has a size limit", () => {
    const big = { blob: "x".repeat(TEST_WEBHOOK_PAYLOAD_MAX_CHARS) };
    expect(workflowSchema.safeParse({ ...base, settings: { testWebhookPayload: big } }).success).toBe(false);
  });
});

describe("a webhook run request", () => {
  it("takes the body the webhook receives as payload", () => {
    const parsed = agentWebhookPayloadSchema.parse({ workflow_id: "wf", payload: { customer: "Ana" } });
    expect(parsed.payload).toEqual({ customer: "Ana" });
    expect(agentWebhookPayloadSchema.safeParse({ workflow_id: "wf", payload: "text" }).success).toBe(false);
  });
});
