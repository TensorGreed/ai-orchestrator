import { describe, expect, it } from "vitest";
import { getNodeDefinition } from "./definitions";
import {
  ECHO_MODEL_PROVIDER,
  MODEL_PROVIDER_CHOICES,
  PROVIDER_CONFIG_NODE_TYPES,
  envModelProviders,
  pickDefaultModelProvider,
  withDefaultModelProvider
} from "./model-defaults";

describe("the default model of a new node", () => {
  it("is Echo when nothing is configured", () => {
    expect(pickDefaultModelProvider({})).toEqual({ providerId: "echo", model: "echo" });
    expect(pickDefaultModelProvider({ envProviders: [], secrets: [] })).toEqual(ECHO_MODEL_PROVIDER);
  });

  it("never picks Ollama on its own, even with an Ollama secret saved", () => {
    expect(pickDefaultModelProvider({ secrets: [{ id: "s1", provider: "ollama" }] })).toEqual(ECHO_MODEL_PROVIDER);
  });

  it("takes a hosted provider whose key the server's environment sets", () => {
    expect(pickDefaultModelProvider({ envProviders: ["anthropic"] })).toEqual({ providerId: "anthropic", model: "claude-sonnet-5-5" });
    expect(pickDefaultModelProvider({ envProviders: ["gemini", "openai"] })).toEqual({ providerId: "openai", model: "gpt-4o-mini" });
  });

  it("takes a saved secret of a hosted provider, referencing it", () => {
    expect(
      pickDefaultModelProvider({ secrets: [{ id: "web", provider: "webhook" }, { id: "g1", provider: "Gemini" }, { id: "a1", provider: "anthropic" }] })
    ).toEqual({ providerId: "anthropic", model: "claude-sonnet-5-5", secretRef: { secretId: "a1" } });
  });

  it("prefers an environment key over a saved secret", () => {
    expect(pickDefaultModelProvider({ envProviders: ["gemini"], secrets: [{ id: "o1", provider: "openai" }] })).toEqual({
      providerId: "gemini",
      model: "gemini-2.5-flash"
    });
  });

  it("reads which hosted keys an environment sets, ignoring blank ones", () => {
    expect(envModelProviders({ OPENAI_API_KEY: "sk", ANTHROPIC_API_KEY: "  ", OLLAMA_BASE_URL: "http://localhost:11434/v1" })).toEqual(["openai"]);
    expect(envModelProviders({})).toEqual([]);
  });
});

describe("withDefaultModelProvider", () => {
  it("puts the default in place of the catalog's sample provider for every provider-config node type", () => {
    for (const nodeType of PROVIDER_CONFIG_NODE_TYPES) {
      const sample = (getNodeDefinition(nodeType)?.sampleConfig ?? {}) as Record<string, unknown>;
      const config = withDefaultModelProvider(nodeType, sample, { providerId: "openai", model: "gpt-4o-mini", secretRef: { secretId: "s" } });
      expect(config.provider).toEqual({ providerId: "openai", model: "gpt-4o-mini", secretRef: { secretId: "s" } });
    }
  });

  it("leaves other node types alone", () => {
    const config = { model: "llama3.1" };
    expect(withDefaultModelProvider("ollama_chat_model", config, ECHO_MODEL_PROVIDER)).toBe(config);
    expect(withDefaultModelProvider("http_request", config, ECHO_MODEL_PROVIDER)).toBe(config);
  });
});

describe("the catalog", () => {
  it("starts a new LLM Call on Echo, not on a local Ollama", () => {
    const sample = getNodeDefinition("llm_call")?.sampleConfig as { provider: Record<string, unknown> };
    expect(sample.provider).toEqual({ providerId: "echo", model: "echo" });
    expect(JSON.stringify(sample)).not.toContain("11434");
  });

  it("offers Echo first in the provider picker", () => {
    expect(MODEL_PROVIDER_CHOICES[0]?.value).toBe("echo");
    expect(MODEL_PROVIDER_CHOICES.map((choice) => choice.value)).toEqual(
      expect.arrayContaining(["echo", "ollama", "openai_compatible", "openai", "azure_openai", "gemini", "anthropic"])
    );
  });
});
