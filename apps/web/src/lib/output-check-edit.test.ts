import { describe, expect, it } from "vitest";
import { channelOf, setDetector, setDetectorOptions, setRuleStreamBuffer, type GuardDocument } from "./guard-profile-edit";
import { isOutputCheck, modelFields, textToTopics, topicsToText, withModelField, withOption } from "./output-check-edit";

describe("topic text", () => {
  it("round-trips names and phrases, one topic per line", () => {
    const topics = ["legal advice", { name: "investing", phrases: ["buy stocks", "crypto"] }];
    const text = topicsToText(topics);
    expect(text).toBe("legal advice\ninvesting: buy stocks, crypto");
    expect(textToTopics(text)).toEqual(topics);
  });

  it("keeps fields the text does not show (dictionary, examples) for a topic of the same name", () => {
    const before = [{ name: "rivals", dictionary: "competitor", examples: ["try Acme instead"] }];
    expect(textToTopics("rivals: globex", before)).toEqual([{ name: "rivals", dictionary: "competitor", examples: ["try Acme instead"], phrases: ["globex"] }]);
    expect(textToTopics("rivals", before)).toEqual([{ name: "rivals", dictionary: "competitor", examples: ["try Acme instead"] }]);
  });

  it("drops blank lines and empty names", () => {
    expect(textToTopics("\n  \n: nothing\nkept\n")).toEqual(["kept"]);
    expect(topicsToText(undefined)).toBe("");
  });
});

describe("model and option fields", () => {
  it("reads and writes a model option, dropping it when both fields are empty", () => {
    expect(modelFields({ providerId: "openai", model: "m", secretRef: { secretId: "s" } })).toEqual({ providerId: "openai", model: "m" });
    expect(withModelField({ providerId: "openai", model: "m", secretRef: { secretId: "s" } }, "model", "n")).toEqual({ providerId: "openai", model: "n", secretRef: { secretId: "s" } });
    expect(withModelField({ providerId: "openai" }, "providerId", " ")).toBeUndefined();
  });

  it("drops empty options", () => {
    expect(withOption({ a: 1, b: 2 }, "a", undefined)).toEqual({ b: 2 });
    expect(withOption({}, "list", [])).toEqual({});
    expect(withOption({}, "mode", "semantic")).toEqual({ mode: "semantic" });
    expect(isOutputCheck("output.topic")).toBe(true);
    expect(isOutputCheck("dlp.patterns")).toBe(false);
  });
});

describe("rule set edits for output checks", () => {
  const base: GuardDocument = {
    id: "out",
    name: "Out",
    version: "1",
    channels: { final_output: { detectors: [{ id: "output.schema", threshold: 0.5 }], actions: { ungrounded: { action: "review" } }, defaultAction: { action: "block" } } }
  };

  it("sets and clears a detector's options; a threshold change keeps them", () => {
    const withSchema = setDetectorOptions(base, "final_output", "output.schema", { schema: { type: "object" } });
    expect(channelOf(withSchema, "final_output")!.detectors[0]).toEqual({ id: "output.schema", threshold: 0.5, options: { schema: { type: "object" } } });
    const moved = setDetector(withSchema, "final_output", "output.schema", true, 0.8);
    expect(channelOf(moved, "final_output")!.detectors[0]).toEqual({ id: "output.schema", threshold: 0.8, options: { schema: { type: "object" } } });
    expect(channelOf(setDetectorOptions(withSchema, "final_output", "output.schema", {}), "final_output")!.detectors[0]).toEqual({ id: "output.schema", threshold: 0.5 });
  });

  it("buffers a category's rule, creating it with the default action, and unbuffers it", () => {
    const buffered = setRuleStreamBuffer(base, "final_output", "schema_violation", true);
    expect(channelOf(buffered, "final_output")!.actions.schema_violation).toEqual({ action: "block", stream: "buffer" });
    const existing = setRuleStreamBuffer(base, "final_output", "ungrounded", true);
    expect(channelOf(existing, "final_output")!.actions.ungrounded).toEqual({ action: "review", stream: "buffer" });
    const off = setRuleStreamBuffer(existing, "final_output", "ungrounded", false);
    expect(channelOf(off, "final_output")!.actions.ungrounded).toEqual({ action: "review" });
  });
});
