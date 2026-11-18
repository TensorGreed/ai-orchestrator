import { describe, expect, it } from "vitest";
import { GlinerCancelled, GlinerCore, type GlinerSession, type MakeTensor } from "./gliner.js";

/**
 * A mocked ONNX session: no model. It checks the inputs the decoder builds and answers logits from a function of
 * (first word, last word, prompt) in window coordinates, mapped back to text words through `offset`.
 */

const makeTensor: MakeTensor = (type, data, dims) => ({ type, data, dims });
const logit = (p: number) => Math.log(p / (1 - p));

interface Captured {
  feeds: Record<string, { type: string; data: BigInt64Array | Uint8Array; dims: number[] }>;
}

function core(options: { score: (first: number, last: number, prompt: number, windowFirstWord: number) => number; words?: number; overlap?: number; maxWidth?: number; calls?: Captured[] }) {
  const maxWidth = options.maxWidth ?? 4;
  // Word "wN" encodes to id 1000 + N (one subtoken), so the session can tell which text word starts a window; other
  // words and prompts get ids from 5000 in the order they are first seen.
  const ids = new Map<string, number>();
  const encode = (text: string) => {
    const numbered = /^w(\d+)$/.exec(text);
    if (numbered) return [1000 + Number(numbered[1])];
    if (!ids.has(text)) ids.set(text, 5000 + ids.size);
    return [ids.get(text)!];
  };
  const session: GlinerSession = {
    async run(feeds) {
      const typed = feeds as Captured["feeds"];
      options.calls?.push({ feeds: typed });
      const count = Number(typed.text_lengths!.data[0]);
      const prompts = typed.input_ids!.data.filter((value) => value === 9001n).length;
      const words = typed.words_mask!.data;
      const inputs = typed.input_ids!.data;
      let firstWordId = -1;
      for (let i = 0; i < words.length; i += 1) if (words[i] === 1n) firstWordId = Number(inputs[i]) - 1000;
      const data = new Float32Array(count * maxWidth * prompts).fill(-20);
      for (let i = 0; i < count; i += 1) {
        for (let k = 0; k < maxWidth && i + k < count; k += 1) {
          for (let c = 0; c < prompts; c += 1) {
            const p = options.score(i, i + k, c, firstWordId);
            if (p > 0) data[(i * maxWidth + k) * prompts + c] = logit(p);
          }
        }
      }
      return { logits: { data, dims: [1, count, maxWidth, prompts] } };
    }
  };
  return new GlinerCore({
    session,
    makeTensor,
    encode,
    special: { cls: 1, sep: 2, ent: 9001, promptSep: 9002 },
    maxWidth,
    window: { words: options.words ?? 128, overlap: options.overlap ?? 16, maxTokens: 512, maxWordTokens: 16 }
  });
}

describe("GlinerCore", () => {
  it("builds the GLiNER inputs: prompts, words mask, span index and mask", async () => {
    const calls: Captured[] = [];
    const gliner = core({ score: () => 0, calls });
    await gliner.recognize("Anna Lee", [{ prompt: "name", cutoff: 0.5 }]);
    const { feeds } = calls[0]!;
    // [CLS] <<ENT>> name <<SEP>> Anna Lee [SEP]
    expect([...feeds.input_ids!.data].map(Number)).toEqual([1, 9001, 5000, 9002, 5001, 5002, 2]);
    expect([...feeds.words_mask!.data].map(Number)).toEqual([0, 0, 0, 0, 1, 2, 0]);
    expect([...feeds.attention_mask!.data].map(Number)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(Number(feeds.text_lengths!.data[0])).toBe(2);
    expect(feeds.span_idx!.dims).toEqual([1, 8, 2]);
    expect([...feeds.span_idx!.data.slice(0, 8)].map(Number)).toEqual([0, 0, 0, 1, 0, 1, 0, 1]);
    expect([...feeds.span_mask!.data]).toEqual([1, 1, 0, 0, 1, 0, 0, 0]);
    expect(feeds.span_mask!.type).toBe("bool");
  });

  it("decodes spans at or above each prompt's cut-off, greedily without overlaps", async () => {
    const text = "Mail Anna Lee at 12 Main Street today";
    const gliner = core({
      score: (first, last, prompt) => {
        if (prompt === 0 && first === 1 && last === 2) return 0.9; // Anna Lee
        if (prompt === 0 && first === 2 && last === 2) return 0.6; // Lee (overlaps, loses)
        if (prompt === 1 && first === 4 && last === 6) return 0.4; // 12 Main Street, under its cut-off of 0.5
        if (prompt === 1 && first === 5 && last === 6) return 0.7; // Main Street
        return 0;
      }
    });
    const spans = await gliner.recognize(text, [
      { prompt: "name", cutoff: 0.5 },
      { prompt: "location street", cutoff: 0.5 }
    ]);
    expect(spans.map((span) => ({ text: text.slice(span.start, span.end), prompt: span.prompt, score: Number(span.score.toFixed(2)) }))).toEqual([
      { text: "Anna Lee", prompt: 0, score: 0.9 },
      { text: "Main Street", prompt: 1, score: 0.7 }
    ]);
  });

  it("prefers the window that holds an entity whole over one that cuts it at its edge", async () => {
    // 20 words, windows of 10 with 4 overlap: [0,10) [6,16) [12,20). "w8 w9 w10" crosses the first window's end.
    const text = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    const gliner = core({
      words: 10,
      overlap: 4,
      maxWidth: 3,
      score: (first, last, _prompt, windowFirst) => {
        const a = first + windowFirst;
        const b = last + windowFirst;
        if (windowFirst === 0 && a === 8 && b === 9) return 0.95; // the cut part, at the first window's edge
        if (windowFirst === 6 && a === 8 && b === 10) return 0.8; // the whole entity in the second window
        return 0;
      }
    });
    const spans = await gliner.recognize(text, [{ prompt: "name", cutoff: 0.5 }]);
    expect(spans.map((span) => text.slice(span.start, span.end))).toEqual(["w8 w9 w10"]);
  });

  it("keeps an edge span when no other window holds it (overlap under the span width)", async () => {
    const text = Array.from({ length: 10 }, (_, i) => `w${i}`).join(" ");
    const gliner = core({
      words: 6,
      overlap: 2,
      score: (first, last, _prompt, windowFirst) => (windowFirst === 0 && first + windowFirst === 3 && last + windowFirst === 5 ? 0.9 : 0)
    });
    const spans = await gliner.recognize(text, [{ prompt: "name", cutoff: 0.5 }]);
    expect(spans.map((span) => text.slice(span.start, span.end))).toEqual(["w3 w4 w5"]);
  });

  it("returns nothing without prompts or words, and stops between windows when cancelled", async () => {
    const gliner = core({ words: 6, overlap: 2, score: () => 0 });
    expect(await gliner.recognize("Anna", [])).toEqual([]);
    expect(await gliner.recognize("   ", [{ prompt: "name", cutoff: 0.5 }])).toEqual([]);
    let checks = 0;
    await expect(gliner.recognize(Array.from({ length: 20 }, (_, i) => `w${i}`).join(" "), [{ prompt: "name", cutoff: 0.5 }], () => ++checks > 1)).rejects.toBeInstanceOf(GlinerCancelled);
  });

  it("refuses an output with too few logits", async () => {
    const session: GlinerSession = { run: async () => ({ logits: { data: new Float32Array(1), dims: [1] } }) };
    const gliner = new GlinerCore({ session, makeTensor, encode: () => [5], special: { cls: 1, sep: 2, ent: 3, promptSep: 4 }, maxWidth: 12, window: { words: 128, overlap: 16, maxTokens: 512, maxWordTokens: 16 } });
    await expect(gliner.recognize("Anna Lee", [{ prompt: "name", cutoff: 0.5 }])).rejects.toThrow(/logits/);
  });

  it("cuts very long words before tokenising and caps their subtokens", async () => {
    const seen: string[] = [];
    const session: GlinerSession = {
      run: async (feeds) => {
        const count = Number((feeds as Captured["feeds"]).text_lengths!.data[0]);
        expect((feeds as Captured["feeds"]).input_ids!.data.length).toBeLessThan(40);
        return { logits: { data: new Float32Array(count * 12), dims: [1, count, 12, 1] } };
      }
    };
    const gliner = new GlinerCore({
      session,
      makeTensor,
      encode: (text) => {
        seen.push(text);
        return Array.from({ length: text.length }, () => 7);
      },
      special: { cls: 1, sep: 2, ent: 3, promptSep: 4 },
      maxWidth: 12,
      window: { words: 128, overlap: 16, maxTokens: 512, maxWordTokens: 16 }
    });
    await gliner.recognize(`${"a".repeat(5_000)} b`, [{ prompt: "x", cutoff: 0.5 }]);
    expect(Math.max(...seen.map((text) => text.length))).toBe(100);
  });
});
