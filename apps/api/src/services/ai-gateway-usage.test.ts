import { describe, expect, it } from "vitest";
import { chargedUsage, estimateAnswerTokens, estimateRequestTokens, estimateTextTokens, unseenOutputTokens } from "./ai-gateway-usage.js";

const guess = { input: 10, output: 20 };
const never = () => {
  throw new Error("the estimate is not needed");
};

describe("estimateTextTokens", () => {
  it("counts bytes, so text that packs fewer characters per token is not undercounted", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abc")).toBe(1);
    expect(estimateTextTokens("abcd")).toBe(2);
    expect(estimateTextTokens("文字")).toBe(2);
  });
});

describe("estimateRequestTokens", () => {
  const provider = { providerId: "openai", model: "m", extra: { note: "x".repeat(3000) } };

  it("counts messages, tools and options, and not the route's settings", () => {
    const plain = estimateRequestTokens({ provider, messages: [{ role: "user", content: "hi" }] });
    expect(plain).toBeLessThan(100);
    const withTools = estimateRequestTokens({ provider, messages: [{ role: "user", content: "hi" }], tools: [{ name: "t", description: "d".repeat(300), inputSchema: {} }] });
    expect(withTools).toBeGreaterThanOrEqual(plain + 100);
  });

  it("charges an image a flat amount, not its base64 size", () => {
    const image = { data: "A".repeat(90_000), mimeType: "image/png" };
    const tokens = estimateRequestTokens({ provider, messages: [{ role: "user", content: "hi", images: [image, image] }] });
    expect(tokens).toBeGreaterThanOrEqual(3200);
    expect(tokens).toBeLessThan(3300);
  });
});

describe("estimateAnswerTokens", () => {
  it("adds tool call names and arguments to the text", () => {
    expect(estimateAnswerTokens("abc", [{ name: "abc", arguments: "abcabc" }])).toBe(1 + 3);
  });
});

describe("unseenOutputTokens", () => {
  it("allows at least the floor, more the longer the upstream ran unseen", () => {
    expect(unseenOutputTokens({ quietMs: 0, seenTokens: 0 })).toBe(256);
    expect(unseenOutputTokens({ quietMs: 30_000, seenTokens: 0 })).toBe(3000);
  });

  it("never passes what max_tokens leaves", () => {
    expect(unseenOutputTokens({ quietMs: 30_000, seenTokens: 90, maxTokens: 100 })).toBe(10);
    expect(unseenOutputTokens({ quietMs: 0, seenTokens: 200, maxTokens: 100 })).toBe(0);
  });
});

describe("chargedUsage", () => {
  it("keeps full usage as it came, without working out an estimate", () => {
    const usage = { inputTokens: 3, outputTokens: 4, totalTokens: 7, cachedInputTokens: 1 };
    expect(chargedUsage(usage, never)).toEqual({ usage, estimated: false });
  });

  it("estimates when there is no usage, or only zeros", () => {
    expect(chargedUsage(undefined, () => guess)).toEqual({ usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, estimated: true });
    expect(chargedUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }, () => guess)).toEqual({ usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, estimated: true });
  });

  it("fills in the half that is missing", () => {
    expect(chargedUsage({ inputTokens: 5 }, () => guess)).toEqual({ usage: { inputTokens: 5, outputTokens: 20, totalTokens: 25 }, estimated: true });
    expect(chargedUsage({ outputTokens: 5 }, () => guess)).toEqual({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, estimated: true });
  });

  it("treats input with no output as exact when no output was seen", () => {
    expect(chargedUsage({ inputTokens: 5, totalTokens: 5 }, () => ({ input: 10, output: 0 }))).toEqual({ usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 }, estimated: false });
  });

  it("trusts a total on its own, and splits it by the estimate", () => {
    expect(chargedUsage({ totalTokens: 100 }, () => guess)).toEqual({ usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 }, estimated: false });
    expect(chargedUsage({ totalTokens: 5 }, () => guess)).toEqual({ usage: { inputTokens: 0, outputTokens: 5, totalTokens: 5 }, estimated: false });
  });

  it("never lets a low total hide the parts", () => {
    expect(chargedUsage({ inputTokens: 5, totalTokens: 6 }, () => guess).usage.totalTokens).toBe(25);
  });
});
