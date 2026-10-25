import { describe, expect, it } from "vitest";
import { BUILTIN_DESTINATIONS, destinationHostOfUrl, resolveDestination } from "@ai-orchestrator/shared";
import { PROVIDER_DEFAULT_BASE_URLS, providerDefaultBaseUrl } from "./default-base-urls";

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
});
