import { describe, expect, it } from "vitest";
import { relabelForModel } from "./model-labels";

const echo = { providerId: "echo", model: "demo" };
const anthropic = { providerId: "anthropic", model: "claude-sonnet-4-5" };

describe("relabelForModel", () => {
  it("follows the provider named in a trailing (…), keeping the shipped templates' lower case", () => {
    expect(relabelForModel("Chat Model (echo)", echo, anthropic)).toBe("Chat Model (anthropic)");
    expect(relabelForModel("Supervisor Chat Model (echo)", echo, anthropic)).toBe("Supervisor Chat Model (anthropic)");
    expect(relabelForModel("Researcher (OpenAI)", { providerId: "openai", model: "gpt-4o-mini" }, anthropic)).toBe("Researcher (Anthropic)");
  });

  it("follows a '<Provider> Chat Model' label and a label that is the model's name", () => {
    expect(relabelForModel("OpenAI Chat Model", echo, anthropic)).toBe("Anthropic Chat Model");
    expect(relabelForModel("Echo Chat", anthropic, echo)).toBe("Echo Chat");
    expect(relabelForModel("GPT-4o-mini", { providerId: "openai", model: "gpt-4o-mini" }, { providerId: "openai", model: "gpt-4.1" })).toBe("gpt-4.1");
    expect(relabelForModel("Writer (gpt-4o-mini)", { providerId: "openai", model: "gpt-4o-mini" }, { providerId: "openai", model: "gpt-4.1" })).toBe("Writer (gpt-4.1)");
  });

  it("keeps a name the person gave the node", () => {
    for (const label of ["Classify", "LLM Call", "Chat Model", "My OpenAI bot", "Summary (short)"]) {
      expect(relabelForModel(label, echo, anthropic)).toBe(label);
    }
  });

  it("changes nothing when neither the provider nor the model changed, or the new model is still empty", () => {
    expect(relabelForModel("Chat Model (echo)", echo, echo)).toBe("Chat Model (echo)");
    expect(relabelForModel("gpt-4o-mini", { providerId: "openai", model: "gpt-4o-mini" }, { providerId: "openai", model: "" })).toBe("gpt-4o-mini");
  });
});
