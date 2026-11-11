import { describe, expect, it } from "vitest";
import { createDefaultGuardProfile } from "./default-profile";
import { evaluateGuard } from "./evaluate";
import { createDefaultGuardRegistry } from "./index";
import { parseGuardProfile } from "./profile";

/**
 * Phase 12 coverage — the response and incoming-payload channels offer the detectors that already check a final
 * answer (the rule set editor lists a channel's detectors from this metadata), and they evaluate there as anywhere.
 */
describe("response and trigger_input detectors", () => {
  const registry = createDefaultGuardRegistry();
  const offered = (channel: "response" | "trigger_input") =>
    registry
      .list()
      .filter((detector) => detector.channels.includes(channel))
      .map((detector) => detector.id)
      .sort();

  it("every detector of the built-in final answer channel is offered on the response channel", () => {
    const finalAnswer = createDefaultGuardProfile().channels.final_output!.detectors.map((entry) => entry.id);
    for (const id of finalAnswer) expect(offered("response"), id).toContain(id);
  });

  it("the payload checks D12 names are offered on trigger_input: data, hidden characters and injection", () => {
    expect(offered("trigger_input")).toEqual(expect.arrayContaining(["dlp.patterns", "injection.hidden_unicode"]));
    // Tool-argument detectors never apply to what a caller sends or receives.
    for (const channel of ["response", "trigger_input"] as const) {
      expect(offered(channel)).not.toContain("tool.egress");
      expect(offered(channel)).not.toContain("tool.path");
    }
  });

  it("a response channel copied from the final answer redacts the same way", async () => {
    const builtIn = createDefaultGuardProfile();
    const profile = parseGuardProfile({ ...builtIn, id: "responses", channels: { response: builtIn.channels.final_output } });
    const secret = "sk-live-abcdefghijklmnopqrstuvwxyz123456";
    const verdict = await evaluateGuard(profile, { content: { reply: `key ${secret}` }, channel: "response", labels: [] }, { registry });
    expect(verdict.action).toBe("redact");
    expect(JSON.stringify(verdict.content)).not.toContain(secret);
  });
});
