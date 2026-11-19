import { describe, expect, it } from "vitest";
import { defaultRagSearchMode, resolveRagSearchMode } from "./rag-search";

describe("RAG search mode defaults", () => {
  it("is hybrid with the Token embedder (also when none is set) and vector with every other embedder", () => {
    expect(defaultRagSearchMode("token-embedder")).toBe("hybrid");
    expect(defaultRagSearchMode(undefined)).toBe("hybrid");
    expect(defaultRagSearchMode("")).toBe("hybrid");
    expect(defaultRagSearchMode("openai-embedder")).toBe("vector");
  });

  it("keeps a mode the node sets, and ignores one it does not know", () => {
    expect(resolveRagSearchMode({ searchMode: "vector", embedderId: "token-embedder" })).toBe("vector");
    expect(resolveRagSearchMode({ searchMode: "bm25", embedderId: "openai-embedder" })).toBe("bm25");
    expect(resolveRagSearchMode({ embedderId: "token-embedder" })).toBe("hybrid");
    expect(resolveRagSearchMode({ searchMode: "fuzzy", embedderId: "cohere-embedder" })).toBe("vector");
  });
});
