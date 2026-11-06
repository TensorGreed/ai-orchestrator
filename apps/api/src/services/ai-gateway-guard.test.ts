/**
 * 12.6b — what the prompt check of /v1 reads: every piece of caller text in the final provider request, tool results
 * labelled `untrusted_external`, and what stays out (the route's own settings, a message's role, image data).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMProviderConfig } from "@ai-orchestrator/shared";

const checks = vi.hoisted(() => [] as Array<{ content: unknown; labels: unknown }>);

vi.mock("@ai-orchestrator/workflow-engine", async (original) => ({
  ...(await original<typeof import("@ai-orchestrator/workflow-engine")>()),
  runGuardCheck: vi.fn(async (_scope: unknown, _profiles: unknown, input: { content: unknown; labels: unknown }) => {
    checks.push({ content: input.content, labels: input.labels });
    return { action: "allow", content: input.content, transformed: false, verdicts: [] };
  })
}));

import { checkAiGatewayRequest, outboundTextSlots, type AiGatewayGuardScope } from "./ai-gateway-guard.js";

const provider: LLMProviderConfig = { providerId: "openai", model: "route-model", baseUrl: "https://route.example", extra: { note: "route text" } };

const scope = {
  guard: { gatewayRuntime: () => ({}) },
  resolution: { stack: [{ profile: {} }] },
  requestId: "aigw_1",
  routeSetId: "set",
  clientId: "client",
  projectId: null,
  alias: "model",
  subject: {},
  resolveSecret: async () => undefined
} as unknown as AiGatewayGuardScope;

beforeEach(() => {
  checks.length = 0;
});

describe("outboundTextSlots", () => {
  it("finds every string, key and argument number, with the route's settings, roles and images left out", () => {
    const { slots } = outboundTextSlots({
      provider,
      messages: [
        { role: "user" as const, content: "hello", images: [{ mimeType: "image/png", data: "AAAA" }] },
        { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "lookup", arguments: { to: "x", n: 7, nested: [{ deep: "y" }], flag: true } }] },
        { role: "tool" as const, content: "result", toolCallId: "c1" }
      ],
      tools: [{ name: "lookup", description: "desc", inputSchema: { type: "object", maximum: 9 } }],
      options: { stop: ["END"], user: "u1", seed: 5, topP: 0.5, responseFormat: { type: "json_object" as const } }
    });
    const texts = slots.map((slot) => slot.text);
    expect(texts).toEqual(
      expect.arrayContaining(["hello", "c1", "lookup", "to", "x", "7", "nested", "deep", "y", "flag", "result", "desc", "object", "9", "END", "u1", "json_object"])
    );
    for (const absent of ["route-model", "https://route.example", "route text", "assistant", "tool", "image/png", "AAAA", "5", "0.5", "true", ""]) {
      expect(texts).not.toContain(absent);
    }
    expect(slots.some((slot) => slot.path[0] === "provider" || slot.path[2] === "role" || slot.path[2] === "images")).toBe(false);
  });

  it("reads a field it was never told about", () => {
    const { slots } = outboundTextSlots({ provider, messages: [], options: { someFutureField: { nested: ["new text"] } }, somethingElse: "more text" });
    expect(slots.map((slot) => slot.text)).toEqual(expect.arrayContaining(["new text", "more text"]));
  });

  it("marks only tool results as outside content", () => {
    const { slots } = outboundTextSlots({ provider, messages: [{ role: "tool" as const, content: "result", toolCallId: "c1" }, { role: "user" as const, content: "hello" }] });
    expect(slots.filter((slot) => slot.untrusted).map((slot) => slot.text)).toEqual(["result"]);
  });
});

describe("checkAiGatewayRequest", () => {
  it("checks tool results in their own pass, labelled untrusted_external", async () => {
    const outcome = await checkAiGatewayRequest(scope, {
      provider,
      messages: [
        { role: "user" as const, content: "hello" },
        { role: "tool" as const, content: "result", toolCallId: "c1" }
      ],
      options: { user: "u1" }
    });
    expect(outcome).toEqual({ action: "allow" });
    expect(checks).toHaveLength(2);
    expect(checks[0]!.labels).toEqual([]);
    expect(checks[0]!.content).toEqual(expect.arrayContaining(["hello", "c1", "u1"]));
    expect(checks[0]!.content).not.toContain("result");
    expect(checks[1]).toEqual({ content: ["result"], labels: ["untrusted_external"] });
  });
});
