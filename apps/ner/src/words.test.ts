import { describe, expect, it } from "vitest";
import { splitWords, wordWindows } from "./words.js";

describe("splitWords", () => {
  it("splits words and punctuation with UTF-16 offsets", () => {
    const text = "Dr. José Núñez-García, 12 Rue d'Alésia";
    const words = splitWords(text);
    expect(words.map((word) => word.text)).toEqual(["Dr", ".", "José", "Núñez-García", ",", "12", "Rue", "d", "'", "Alésia"]);
    for (const word of words) expect(text.slice(word.start, word.end)).toBe(word.text);
  });

  it("keeps offsets right after characters outside the BMP", () => {
    const text = "🙂 Anna Lee";
    const words = splitWords(text);
    expect(words[0]).toEqual({ text: "🙂", start: 0, end: 2 });
    expect(words[1]).toEqual({ text: "Anna", start: 3, end: 7 });
  });

  it("returns nothing for blank text", () => {
    expect(splitWords("  \n\t ")).toEqual([]);
  });
});

describe("wordWindows", () => {
  it("covers every word with overlapping windows", () => {
    const windows = wordWindows(300, 128, 16, 10_000, () => 1);
    expect(windows).toEqual([
      { first: 0, end: 128 },
      { first: 112, end: 240 },
      { first: 224, end: 300 }
    ]);
  });

  it("ends a window early at the token budget", () => {
    const windows = wordWindows(10, 128, 2, 9, () => 3);
    expect(windows).toEqual([
      { first: 0, end: 3 },
      { first: 1, end: 4 },
      { first: 2, end: 5 },
      { first: 3, end: 6 },
      { first: 4, end: 7 },
      { first: 5, end: 8 },
      { first: 6, end: 9 },
      { first: 7, end: 10 }
    ]);
  });

  it("always makes progress, even when one word is over the budget", () => {
    const windows = wordWindows(3, 128, 16, 4, () => 50);
    expect(windows).toEqual([
      { first: 0, end: 1 },
      { first: 1, end: 2 },
      { first: 2, end: 3 }
    ]);
  });

  it("returns no window for no words", () => {
    expect(wordWindows(0, 128, 16, 100, () => 1)).toEqual([]);
  });
});
