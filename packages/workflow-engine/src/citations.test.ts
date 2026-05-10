import { describe, expect, it } from "vitest";
import {
  DEFAULT_CITATION_INSTRUCTIONS,
  extractCitationsFromText,
  formatNumberedContext
} from "./citations.js";

const docs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `kbc_${i + 1}`,
    text: `Chunk content number ${i + 1} about a topic.`,
    metadata: {
      chunkId: `kbc_${i + 1}`,
      sourceId: `src-${(i % 2) + 1}`,
      knowledgeBaseId: "kb_main",
      similarityScore: 0.9 - i * 0.1,
      retrieval: { mode: "hybrid" }
    }
  }));

describe("citations", () => {
  describe("DEFAULT_CITATION_INSTRUCTIONS", () => {
    it("mentions bracketed numeric markers", () => {
      expect(DEFAULT_CITATION_INSTRUCTIONS).toMatch(/\[1\]|\[2\]/);
      expect(DEFAULT_CITATION_INSTRUCTIONS).toMatch(/cit/i);
    });
  });

  describe("formatNumberedContext", () => {
    it("prefixes each chunk with its 1-based index", () => {
      const formatted = formatNumberedContext(docs(2));
      expect(formatted).toContain("[1] Chunk content number 1");
      expect(formatted).toContain("[2] Chunk content number 2");
    });
  });

  describe("extractCitationsFromText — numeric markers", () => {
    it("resolves [1] to documents[0] and carries provenance", () => {
      const answer = "Reset your password by clicking the link [1].";
      const result = extractCitationsFromText(answer, docs(3));
      expect(result.hasCitations).toBe(true);
      expect(result.citations).toHaveLength(1);
      const c = result.citations[0]!;
      expect(c.marker).toBe("[1]");
      expect(c.index).toBe(1);
      expect(c.chunkId).toBe("kbc_1");
      expect(c.sourceId).toBe("src-1");
      expect(c.knowledgeBaseId).toBe("kb_main");
      expect(c.similarityScore).toBeCloseTo(0.9, 5);
      expect(c.retrievalMode).toBe("hybrid");
    });

    it("captures multiple distinct markers in document order", () => {
      const answer = "The first claim [1] and a second one [3] later.";
      const result = extractCitationsFromText(answer, docs(3));
      expect(result.citations.map((c) => c.marker)).toEqual(["[1]", "[3]"]);
      expect(result.uniqueCitedDocuments).toBe(2);
    });

    it("counts repeated markers but reports uniqueCitedDocuments correctly", () => {
      const answer = "Cite the first [1] then [1] again then [2].";
      const result = extractCitationsFromText(answer, docs(3));
      expect(result.citations).toHaveLength(3);
      expect(result.uniqueCitedDocuments).toBe(2);
    });

    it("returns char offsets the UI can use to splice in <sup> links", () => {
      const answer = "Sentence one [1]. Sentence two [2].";
      const result = extractCitationsFromText(answer, docs(2));
      const c1 = result.citations[0]!;
      expect(answer.slice(c1.startIndex, c1.endIndex)).toBe("[1]");
      const c2 = result.citations[1]!;
      expect(answer.slice(c2.startIndex, c2.endIndex)).toBe("[2]");
    });

    it("ignores out-of-range numeric markers (e.g. [99] when only 2 docs exist)", () => {
      const answer = "Bad citation [99] should be skipped.";
      const result = extractCitationsFromText(answer, docs(2));
      expect(result.hasCitations).toBe(false);
      expect(result.citations).toHaveLength(0);
    });
  });

  describe("extractCitationsFromText — chunkId markers", () => {
    it("resolves [kbc_2] to the right document", () => {
      const answer = "We have evidence [kbc_2] of this.";
      const result = extractCitationsFromText(answer, docs(3));
      expect(result.citations).toHaveLength(1);
      expect(result.citations[0]!.chunkId).toBe("kbc_2");
      expect(result.citations[0]!.index).toBe(2);
    });

    it("ignores bracketed tokens that don't match any document", () => {
      const answer = "References [unknown-id] go nowhere [also-not-real].";
      const result = extractCitationsFromText(answer, docs(2));
      expect(result.citations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("returns no citations for an empty answer", () => {
      expect(extractCitationsFromText("", docs(2)).citations).toEqual([]);
    });

    it("returns no citations when there are no documents", () => {
      expect(extractCitationsFromText("Some answer with [1].", []).citations).toEqual([]);
    });

    it("preserves the answer text verbatim regardless of markers", () => {
      const answer = "First [1]. Second [2]. Third [unknown].";
      const result = extractCitationsFromText(answer, docs(2));
      expect(result.answer).toBe(answer);
    });

    it("handles documents without metadata gracefully", () => {
      const minimal = [{ id: "x", text: "raw chunk" }];
      const answer = "It says [1].";
      const result = extractCitationsFromText(answer, minimal);
      expect(result.citations).toHaveLength(1);
      expect(result.citations[0]!.chunkId).toBe("x");
      expect(result.citations[0]!.sourceId).toBeUndefined();
    });
  });
});
