import { describe, expect, it } from "vitest";
import { BUILTIN_DESTINATIONS, destinationHostOfUrl, resolveDestination } from "@ai-orchestrator/shared";
import { PROVIDER_DEFAULT_BASE_URLS, PROVIDERS_WITH_FIXED_HOST, PROVIDERS_WITHOUT_NETWORK, providerDefaultBaseUrl } from "./default-base-urls";
import { createDefaultProviderRegistry } from "./index";

describe("provider default base URLs", () => {
  it("are the hosts the built-in vendor destinations list", () => {
    for (const providerId of ["openai", "anthropic", "gemini"]) {
      const host = destinationHostOfUrl(PROVIDER_DEFAULT_BASE_URLS[providerId]);
      expect(BUILTIN_DESTINATIONS.some((row) => row.host === host && row.tier === "vendor"), providerId).toBe(true);
      expect(resolveDestination({ kind: "model_provider", id: providerId, host }, []).tier).toBe("vendor");
    }
    expect(resolveDestination({ kind: "model_provider", id: "ollama", host: destinationHostOfUrl(PROVIDER_DEFAULT_BASE_URLS.ollama) }, []).tier).toBe("local");
  });

  it("honours OLLAMA_BASE_URL and has no default for endpoint-only providers", () => {
    expect(providerDefaultBaseUrl("ollama", { OLLAMA_BASE_URL: "http://gpu.internal:11434/v1" })).toBe("http://gpu.internal:11434/v1");
    expect(providerDefaultBaseUrl("ollama", {})).toBe("http://localhost:11434/v1");
    expect(providerDefaultBaseUrl("azure_openai", {})).toBeUndefined();
    expect(providerDefaultBaseUrl("openai_compatible", {})).toBeUndefined();
  });

  it("names only registered providers as offline or fixed-host, and fixed-host ones have a default", () => {
    const registry = createDefaultProviderRegistry();
    for (const id of [...PROVIDERS_WITHOUT_NETWORK, ...PROVIDERS_WITH_FIXED_HOST]) expect(registry.tryGet(id), id).toBeDefined();
    for (const id of PROVIDERS_WITH_FIXED_HOST) expect(PROVIDER_DEFAULT_BASE_URLS[id], id).toBeDefined();
  });
});
