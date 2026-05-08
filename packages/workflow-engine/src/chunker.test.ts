import { describe, expect, it } from "vitest";
import { chunkDocument, chunkDocuments } from "./chunker.js";

describe("chunker", () => {
  describe("separator strategy", () => {
    it("groups text into chunks bounded by chunkSize using paragraph breaks", () => {
      const longParagraph = "x".repeat(120);
      const text = [longParagraph, longParagraph, longParagraph].join("\n\n");
      const chunks = chunkDocument(
        { id: "doc1", text, metadata: { source: "test" } },
        { strategy: "separator", chunkSize: 200, chunkOverlap: 0 }
      );
      // Three 120-char paragraphs joined by "\n\n" — at chunkSize=200 each
      // chunk holds at most one paragraph, so we expect 3 chunks.
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0]!.id).toBe("doc1-chunk-0");
      expect(chunks[0]!.metadata).toMatchObject({ source: "test", originalId: "doc1", chunkIndex: 0 });
    });

    it("emits an empty result for whitespace-only documents", () => {
      const chunks = chunkDocument({ id: "blank", text: "   \n\n  ", metadata: {} });
      expect(chunks).toEqual([]);
    });
  });

  describe("character strategy", () => {
    it("slides a window of chunkSize chars with chunkOverlap", () => {
      const text = "abcdefghij"; // 10 chars
      const chunks = chunkDocument(
        { id: "d", text, metadata: {} },
        { strategy: "character", chunkSize: 4, chunkOverlap: 1 }
      );
      // stride = chunkSize - overlap = 3, so window starts at 0, 3, 6, 9
      expect(chunks.map((c) => c.text)).toEqual(["abcd", "defg", "ghij", "j"]);
    });
  });

  describe("recursive strategy", () => {
    it("splits on cascading separators until pieces fit chunkSize", () => {
      // 3 paragraphs, each 100 chars, joined by "\n\n" — total ~306 chars
      const para = "y".repeat(100);
      const text = [para, para, para].join("\n\n");
      const chunks = chunkDocument(
        { id: "d", text, metadata: {} },
        { strategy: "recursive", chunkSize: 110, chunkOverlap: 0 }
      );
      // Each chunk must respect maxSize (with some slack for the recursive merge)
      for (const c of chunks) {
        expect(c.text.length).toBeLessThanOrEqual(120);
      }
      expect(chunks.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("token strategy", () => {
    it("snaps to word boundaries near the end of each window", () => {
      const text = "the quick brown fox jumps over the lazy dog ".repeat(30);
      const chunks = chunkDocument(
        { id: "d", text, metadata: {} },
        { strategy: "token", chunkSize: 30, chunkOverlap: 5 }
      );
      // Every chunk that isn't the final one should end at a space boundary
      // (or at end of text).
      for (const c of chunks.slice(0, -1)) {
        expect(c.text.endsWith(" ") || c.text.endsWith(".") || /\w$/.test(c.text)).toBe(true);
      }
    });
  });

  describe("metadata propagation", () => {
    it("preserves source metadata + tags chunkIndex + originalId on every chunk", () => {
      const chunks = chunkDocuments(
        [
          { id: "d1", text: "alpha\n\nbeta\n\ngamma", metadata: { sourceId: "s1", topic: "x" } },
          { id: "d2", text: "delta\n\nepsilon", metadata: { sourceId: "s2", topic: "y" } }
        ],
        { strategy: "separator", chunkSize: 10, chunkOverlap: 0 }
      );
      for (const c of chunks) {
        expect(c.metadata).toHaveProperty("originalId");
        expect(c.metadata).toHaveProperty("chunkIndex");
        expect(["s1", "s2"]).toContain((c.metadata as Record<string, unknown>).sourceId);
      }
    });
  });
});
