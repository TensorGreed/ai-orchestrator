import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiProviderAdapter, extractGeminiUsage } from "./gemini";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Gemini usage", () => {
  it("bills thinking as output and a built-in tool's prompt as input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            candidates: [{ finishReason: "STOP", content: { parts: [{ text: "hi" }] } }],
            usageMetadata: {
              promptTokenCount: 100,
              cachedContentTokenCount: 60,
              toolUsePromptTokenCount: 10,
              candidatesTokenCount: 5,
              thoughtsTokenCount: 300,
              totalTokenCount: 415
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    const response = await new GeminiProviderAdapter().generate(
      { provider: { providerId: "gemini", model: "gemini-2.5-flash" }, messages: [{ role: "user", content: "hello" }] },
      { resolveSecret: async () => "key" }
    );
    expect(response.usage).toEqual({ inputTokens: 110, outputTokens: 305, totalTokens: 415, cachedInputTokens: 60 });
  });

  it("keeps a plain response as it was and answers undefined for no usage", () => {
    expect(extractGeminiUsage({ promptTokenCount: 15, candidatesTokenCount: 6, totalTokenCount: 21 })).toEqual({ inputTokens: 15, outputTokens: 6, totalTokens: 21 });
    expect(extractGeminiUsage(undefined)).toBeUndefined();
    expect(extractGeminiUsage({})).toBeUndefined();
  });
});
