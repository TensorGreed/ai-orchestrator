/**
 * 12.6b — what the prompt check of /v1 reads: every piece of caller text in the final provider request, tool results
 * labelled `untrusted_external`, and what stays out (the route's own settings, a message's role, image data).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMProviderConfig } from "@ai-orchestrator/shared";

const checks = vi.hoisted(() => [] as Array<{ content: unknown; labels: unknown; streamWindow?: unknown }>);
/** What the next checks answer (first in, first out); the default allows. */
const answers = vi.hoisted(() => [] as Array<(input: { content: unknown; streamWindow?: { start: number; end: number } }) => unknown>);

vi.mock("@ai-orchestrator/workflow-engine", async (original) => ({
  ...(await original<typeof import("@ai-orchestrator/workflow-engine")>()),
  runGuardCheck: vi.fn(async (_scope: unknown, _profiles: unknown, input: { content: unknown; labels: unknown; streamWindow?: { start: number; end: number } }) => {
    checks.push({ content: input.content, labels: input.labels, ...(input.streamWindow ? { streamWindow: input.streamWindow } : {}) });
    const answer = answers.shift();
    if (answer) return answer(input);
    return { action: "allow", content: input.content, transformed: false, verdicts: [], ...(input.streamWindow ? { window: input.streamWindow } : {}) };
  })
}));

import type { ResolvedGuardProfile } from "@ai-orchestrator/workflow-engine";
import { createDefaultGuardProfile, parseGuardProfile } from "@ai-orchestrator/guard-sdk";
import {
  checkAiGatewayRequest,
  checkAiGatewayStreamWindow,
  createAiGatewayHistoryMemo,
  outboundTextSlots,
  outputGuardMode,
  rewrittenValuePieces,
  STREAM_HOLD_CHARS,
  streamContextChars,
  streamCheckDue,
  streamReleaseLength,
  type AiGatewayGuardScope
} from "./ai-gateway-guard.js";
import { toChatMessages } from "./ai-gateway-wire.js";

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
  answers.length = 0;
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

  it("marks the content of user messages the caller marked untrusted as outside content too (D17)", () => {
    const messages = [
      { role: "user" as const, content: "my question" },
      { role: "user" as const, content: "retrieved page" }
    ];
    const { slots } = outboundTextSlots({ provider, messages }, { untrustedMessages: new Set([1]) });
    expect(slots.filter((slot) => slot.untrusted).map((slot) => slot.text)).toEqual(["retrieved page"]);
  });
});

describe("the history memo (D16)", () => {
  const clean = { action: "allow", findings: [], actions: [], transformed: false, protectedCount: 0, budget: { exceeded: false, skippedDetectors: [] } };
  const allowClean = (input: { content: unknown }) => ({ action: "allow", content: input.content, transformed: false, verdicts: [{ profile: { profileId: "p", version: 1 }, summary: clean }] });
  const memoScope = (overrides: Partial<AiGatewayGuardScope> = {}) =>
    ({ ...scope, resolution: { stack: [{ profile: createDefaultGuardProfile(), hash: "h1" }] }, historyMemo: sharedMemo, ...overrides }) as AiGatewayGuardScope;
  let sharedMemo = createAiGatewayHistoryMemo();
  beforeEach(() => {
    sharedMemo = createAiGatewayHistoryMemo();
  });
  const request = (...texts: string[]) => ({ provider, messages: texts.map((content) => ({ role: "user" as const, content })) });

  it("checks only text it has not seen pass cleanly, and skips the check when nothing is new", async () => {
    answers.push(allowClean);
    await checkAiGatewayRequest(memoScope(), request("first question"));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.content).toContain("first question");
    await checkAiGatewayRequest(memoScope(), request("first question"));
    expect(checks).toHaveLength(1);
    answers.push(allowClean);
    await checkAiGatewayRequest(memoScope(), request("first question", "second question"));
    expect(checks).toHaveLength(2);
    expect(checks[1]!.content).toEqual(["second question"]);
  });

  it("maps a rewrite of the new text back to its place", async () => {
    answers.push(allowClean);
    await checkAiGatewayRequest(memoScope(), request("hello"));
    answers.push((input) => ({ action: "redact", content: (input.content as string[]).map((text) => text.replace("secret", "[R]")), transformed: true, verdicts: [] }));
    const outcome = await checkAiGatewayRequest(memoScope(), request("hello", "my secret"));
    expect(outcome).toMatchObject({ action: "rewrite" });
    const messages = (outcome as { content: { messages: Array<{ content: string }> } }).content.messages;
    expect(messages.map((message) => message.content)).toEqual(["hello", "my [R]"]);
  });

  it("keeps nothing that was not clean, and nothing across clients or projects", async () => {
    answers.push((input) => ({ action: "allow", content: input.content, transformed: false, verdicts: [{ profile: { profileId: "p", version: 1 }, summary: { ...clean, findings: [{}] } }] }));
    await checkAiGatewayRequest(memoScope(), request("flagged in shadow"));
    await checkAiGatewayRequest(memoScope(), request("flagged in shadow"));
    expect(checks).toHaveLength(2);
    answers.push(allowClean);
    await checkAiGatewayRequest(memoScope(), request("shared text"));
    await checkAiGatewayRequest(memoScope({ clientId: "other-client" }), request("shared text"));
    await checkAiGatewayRequest(memoScope({ projectId: "other-project" }), request("shared text"));
    expect(checks).toHaveLength(5);
  });

  it("is not used when destination rules apply to the request", async () => {
    const withRules = parseGuardProfile({
      ...createDefaultGuardProfile(),
      id: "dest",
      destinations: { rules: [{ when: { dataClasses: ["email"] }, allow: { maxTier: "private" }, action: "block", name: "In-house" }] }
    });
    const destScope = memoScope({ resolution: { stack: [{ profile: withRules, hash: "h2" }] } as unknown as AiGatewayGuardScope["resolution"] });
    answers.push(allowClean, allowClean);
    await checkAiGatewayRequest(destScope, request("same text"));
    await checkAiGatewayRequest(destScope, request("same text"));
    expect(checks).toHaveLength(2);
    expect(sharedMemo.size).toBe(0);
  });
});

describe("toChatMessages", () => {
  it("lists user messages marked l2m.untrusted and sends the mark nowhere", () => {
    const mapped = toChatMessages([
      { role: "system", content: "sys", l2m: { untrusted: true } },
      { role: "user", content: "mine" },
      { role: "user", content: "theirs", l2m: { untrusted: true } },
      { role: "user", content: "odd", l2m: { untrusted: "yes" } }
    ] as unknown as Parameters<typeof toChatMessages>[0]);
    expect(mapped.untrusted).toEqual([2]);
    expect(JSON.stringify(mapped.messages)).not.toContain("l2m");
  });
});

describe("outputGuardMode", () => {
  const resolved = (finalOutput: Record<string, unknown> | undefined) =>
    ({ profile: { ...createDefaultGuardProfile(), channels: finalOutput ? { final_output: finalOutput } : {} } }) as unknown as ResolvedGuardProfile;

  it("buffers a rule set that rewrites (a copy of the built-in one) unless its rewrites opt in to windows", () => {
    expect(outputGuardMode([{ profile: createDefaultGuardProfile() } as unknown as ResolvedGuardProfile])).toBe("buffered");
    expect(outputGuardMode([resolved({ detectors: [], actions: { email: { action: "redact" } }, defaultAction: { action: "allow" } })])).toBe("buffered");
    expect(outputGuardMode([resolved({ detectors: [], actions: { email: { action: "redact", stream: "window" } }, defaultAction: { action: "allow" } })])).toBe("chunked");
    expect(outputGuardMode([resolved({ detectors: [{ id: "dlp.patterns" }], actions: { private_key: { action: "redact", stream: "window" } }, defaultAction: { action: "allow" } })])).toBe("buffered");
    expect(outputGuardMode([resolved({ detectors: [], actions: { email: { action: "block" } }, defaultAction: { action: "allow" } })])).toBe("chunked");
    expect(outputGuardMode([resolved({ detectors: [], actions: { email: { action: "redact", stream: "buffer" } }, defaultAction: { action: "allow" } })])).toBe("buffered");
    expect(outputGuardMode([resolved({ detectors: [], actions: {}, defaultAction: { action: "block", stream: "buffer" } })])).toBe("buffered");
    expect(outputGuardMode([resolved(undefined)])).toBe("none");
    expect(outputGuardMode([])).toBe("none");
  });
});

describe("rewrittenValuePieces", () => {
  const summary = (spans: Array<[number, number]>, effective = "redact", shadow = false) => ({
    findings: spans.map(([start, end]) => ({ spans: [{ start, end }] })),
    actions: spans.map(() => ({ effective, shadow }))
  });

  it("lists the pieces of rewritten values that the rewritten text no longer has", () => {
    const raw = "key: -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0\n-----END PRIVATE KEY----- ok";
    const pieces = rewrittenValuePieces(raw, "key: [REDACTED:private_key] ok", summary([[5, raw.length - 3]]));
    expect(pieces).toEqual(expect.arrayContaining(["-----BEGIN", "KEY-----", "MIIEvQIBADANBgkqhkiG9w0", "-----END"]));
    expect(pieces.every((piece) => piece.length >= 8 && !piece.includes("\n"))).toBe(true);
  });

  it("skips short pieces, kept words, shadow and non-rewrite actions", () => {
    const raw = "card 4111 1111 1111 1111 tokenvalue123";
    expect(rewrittenValuePieces(raw, "card •••• 1111 tokenvalue123", summary([[5, 24]]))).toEqual([]);
    expect(rewrittenValuePieces(raw, "card", summary([[25, 38]], "redact", true))).toEqual([]);
    expect(rewrittenValuePieces(raw, "card", summary([[25, 38]], "block"))).toEqual([]);
    expect(rewrittenValuePieces(raw, "card", summary([[25, 38]]))).toEqual(["tokenvalue123"]);
    expect(rewrittenValuePieces(raw, "card", undefined)).toEqual([]);
  });
});

describe("streamContextChars", () => {
  it("reads back the hold after a word break, and the full overlap inside a value", () => {
    expect(streamContextChars("plain text. ")).toBe(STREAM_HOLD_CHARS);
    expect(streamContextChars("")).toBe(STREAM_HOLD_CHARS);
    expect(streamContextChars("token abcdef")).toBeGreaterThan(STREAM_HOLD_CHARS + 4000);
  });
});

describe("checkAiGatewayStreamWindow", () => {
  it("checks the context and the pending text, with the window on the part to release", async () => {
    const release = await checkAiGatewayStreamWindow(scope, { context: "sent ", pending: "new text held", release: 9 });
    expect(checks[0]).toMatchObject({ content: "sent new text held", streamWindow: { start: 5, end: 14 } });
    expect(release).toEqual({ action: "release", text: "new text ", consumed: 9, rewritten: false });
  });

  it("releases less when the window ended early", async () => {
    answers.push((input) => ({ action: "allow", content: input.content, transformed: false, verdicts: [], window: { start: 5, end: 9 } }));
    expect(await checkAiGatewayStreamWindow(scope, { context: "sent ", pending: "new text held", release: 9 })).toEqual({ action: "release", text: "new ", consumed: 4, rewritten: false });
  });

  it("releases the rewritten part in place of the raw characters it covers", async () => {
    answers.push(() => ({ action: "redact", content: "sent [X] text held", transformed: true, verdicts: [], window: { start: 5, end: 14 } }));
    expect(await checkAiGatewayStreamWindow(scope, { context: "sent ", pending: "new text held", release: 9 })).toEqual({ action: "release", text: "[X] text ", consumed: 9, rewritten: true });
  });

  it("releases nothing when the rewrite cannot be placed exactly", async () => {
    // A later rule set rewrote text the window then left held: the held text is no longer the raw text.
    answers.push(() => ({ action: "redact", content: "sent [X] text [Y]", transformed: true, verdicts: [], window: { start: 5, end: 9 } }));
    expect(await checkAiGatewayStreamWindow(scope, { context: "sent ", pending: "new text held", release: 9 })).toMatchObject({ action: "release", text: "", consumed: 0 });
    // The text already sent changed.
    answers.push(() => ({ action: "redact", content: "SENT [X] text held", transformed: true, verdicts: [], window: { start: 5, end: 14 } }));
    expect(await checkAiGatewayStreamWindow(scope, { context: "sent ", pending: "new text held", release: 9 })).toMatchObject({ consumed: 0 });
  });

  it("passes a block through", async () => {
    answers.push(() => ({ action: "block", content: "", transformed: false, verdicts: [{ profile: { profileId: "p", version: 1 }, summary: { findings: [], actions: [], action: "block" } }] }));
    expect(await checkAiGatewayStreamWindow(scope, { context: "", pending: "x", release: 1 })).toMatchObject({ action: "block" });
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

describe("streamReleaseLength", () => {
  const words = (count: number) => "word ".repeat(count);

  it("releases nothing while the text fits in the tail", () => {
    expect(streamReleaseLength("short text")).toBe(0);
    expect(streamReleaseLength("x".repeat(STREAM_HOLD_CHARS))).toBe(0);
  });

  it("keeps at least the tail, and stops at the end of a word", () => {
    const text = words(200);
    const at = streamReleaseLength(text);
    expect(at).toBeGreaterThan(0);
    expect(text.length - at).toBeGreaterThanOrEqual(STREAM_HOLD_CHARS);
    expect(text[at - 1]).toBe(" ");
  });

  it("the tail covers the longest address a mail server accepts", () => {
    expect(STREAM_HOLD_CHARS).toBeGreaterThanOrEqual(254);
  });

  it("never splits an unbroken value, wherever the tail lands in it", () => {
    const value = `key-${"a".repeat(1500)}`;
    const text = `${words(100)}${value}${"b".repeat(100)}`;
    expect(streamReleaseLength(text)).toBe(500);
  });

  it("gives up on an unbroken run past the limit, so memory stays bounded", () => {
    const text = "a".repeat(10_000);
    const at = streamReleaseLength(text, 256, 4096);
    expect(at).toBe(10_000 - 256 - 4096);
  });

  it("does not wait for a space in text that has none, such as Chinese", () => {
    const text = "\u6587".repeat(1000);
    expect(streamReleaseLength(text)).toBe(1000 - STREAM_HOLD_CHARS);
  });

  it("does not cut a surrogate pair in two", () => {
    const text = "\u{1F600}".repeat(600);
    const at = streamReleaseLength(text);
    expect(at % 2).toBe(0);
    expect(at).toBeGreaterThan(0);
  });
});

describe("streamCheckDue", () => {
  it("is due at the end of a sentence or after enough new text", () => {
    expect(streamCheckDue("short.")).toBe(false);
    expect(streamCheckDue(`${"a".repeat(60)}.`)).toBe(true);
    expect(streamCheckDue("a".repeat(60))).toBe(false);
    expect(streamCheckDue("a".repeat(400))).toBe(true);
  });
});
