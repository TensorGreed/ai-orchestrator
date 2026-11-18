import { splitWords, wordWindows, type Word, type WordWindow } from "./words.js";

/**
 * The GLiNER span decoder (uni-encoder, span mode `markerV0`), written for this service instead of depending on a
 * GLiNER package. Input layout, as the exported ONNX graph expects it:
 *
 *   [CLS] (<<ENT>> prompt-subtokens)… <<SEP>> word-subtokens… [SEP]
 *
 * Each word is tokenised on its own; `words_mask` holds the 1-based word index on each word's first subtoken.
 * `span_idx` lists every span of up to `maxWidth` words as (first word, last word); the graph answers `logits`
 * `[1, words, maxWidth, prompts]`. A span is a candidate when sigmoid(logit) reaches its prompt's cut-off.
 *
 * Long texts are read in windows of words that overlap; a span touching a window's inner edge is kept only when no
 * other window holds it whole away from its own inner edges, so an entity cut by a window edge loses to the full
 * one. Overlapping candidates are then resolved greedily by score (flat entities).
 */

export interface TensorLike {
  readonly type: "int64" | "bool";
  readonly data: BigInt64Array | Uint8Array;
  readonly dims: readonly number[];
}

export type MakeTensor = (type: "int64" | "bool", data: BigInt64Array | Uint8Array, dims: readonly number[]) => unknown;

/** The part of an ONNX Runtime session the decoder needs. */
export interface GlinerSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number>; dims: readonly number[] }>>;
}

export interface GlinerSpecialTokens {
  cls: number;
  sep: number;
  /** `<<ENT>>`, before each prompt. */
  ent: number;
  /** `<<SEP>>`, between the prompts and the text. */
  promptSep: number;
}

export interface GlinerCoreOptions {
  session: GlinerSession;
  makeTensor: MakeTensor;
  /** Subtoken ids of one word or prompt, without special tokens. */
  encode: (text: string) => number[];
  special: GlinerSpecialTokens;
  maxWidth: number;
  window: { words: number; overlap: number; maxTokens: number; maxWordTokens: number };
}

/** A prompt with the lowest raw (sigmoid) score kept for it. */
export interface GlinerPromptCut {
  prompt: string;
  cutoff: number;
}

/** A raw span: character offsets, which prompt, raw sigmoid score. */
export interface RawSpan {
  start: number;
  end: number;
  prompt: number;
  score: number;
}

export interface GlinerCandidate {
  first: number;
  last: number;
  prompt: number;
  score: number;
  window: number;
  edge: boolean;
}

/** Words longer than this are cut before tokenising (no name or address part is this long). */
const MAX_WORD_CHARS = 100;
const ENCODE_CACHE_LIMIT = 50_000;

export class GlinerCore {
  /** Prompt encodings only; words are cached per text, so no request's words outlive it. */
  private readonly cache = new Map<string, number[]>();

  constructor(private readonly options: GlinerCoreOptions) {}

  private encodeCached(text: string, limit: number, cache: Map<string, number[]> = this.cache): number[] {
    const key = text.length > MAX_WORD_CHARS ? text.slice(0, MAX_WORD_CHARS) : text;
    let ids = cache.get(key);
    if (!ids) {
      ids = this.options.encode(key);
      if (cache.size >= ENCODE_CACHE_LIMIT) cache.clear();
      cache.set(key, ids);
    }
    return ids.length > limit ? ids.slice(0, limit) : ids;
  }

  /**
   * Raw spans of one text. `isCancelled` is checked between windows, so a stopped request frees the model after the
   * window being run.
   */
  async recognize(text: string, prompts: readonly GlinerPromptCut[], isCancelled: () => boolean = () => false): Promise<RawSpan[]> {
    const read = await this.candidates(text, prompts, isCancelled);
    return resolveCandidates(read.candidates, read.windows, read.words);
  }

  /** Every span at or above its prompt's cut-off in every window, before the edge rule and the overlap resolution. */
  async candidates(text: string, prompts: readonly GlinerPromptCut[], isCancelled: () => boolean = () => false): Promise<{ candidates: GlinerCandidate[]; windows: WordWindow[]; words: Word[] }> {
    const words = prompts.length === 0 ? [] : splitWords(text);
    if (words.length === 0) return { candidates: [], windows: [], words };
    const { window: settings, special } = this.options;
    const promptIds: number[] = [special.cls];
    for (const prompt of prompts) {
      promptIds.push(special.ent, ...this.encodeCached(prompt.prompt, 32));
    }
    promptIds.push(special.promptSep);
    const textCache = new Map<string, number[]>();
    const wordIds = words.map((word) => this.encodeCached(word.text, settings.maxWordTokens, textCache));
    // Room for the words: the window budget less the prompt and the closing [SEP].
    const budget = Math.max(settings.maxWordTokens, settings.maxTokens - promptIds.length - 1);
    const windows = wordWindows(words.length, settings.words, settings.overlap, budget, (index) => Math.max(1, wordIds[index]!.length));
    const candidates: GlinerCandidate[] = [];
    for (let index = 0; index < windows.length; index += 1) {
      if (isCancelled()) throw new GlinerCancelled();
      const window = windows[index]!;
      const found = await this.runWindow(promptIds, wordIds, window, prompts);
      for (const span of found) candidates.push({ ...span, window: index, edge: touchesInnerEdge(span, window, words.length) });
    }
    return { candidates, windows, words };
  }

  private async runWindow(promptIds: number[], wordIds: number[][], window: WordWindow, prompts: readonly GlinerPromptCut[]): Promise<Array<Omit<GlinerCandidate, "window" | "edge">>> {
    const { makeTensor, session, special, maxWidth } = this.options;
    const ids = [...promptIds];
    const wordsMask: number[] = new Array(promptIds.length).fill(0);
    const count = window.end - window.first;
    for (let w = 0; w < count; w += 1) {
      const sub = wordIds[window.first + w]!;
      // A word that tokenises to nothing still needs a position for its index.
      const pieces = sub.length > 0 ? sub : [special.sep];
      pieces.forEach((id, j) => {
        ids.push(id);
        wordsMask.push(j === 0 ? w + 1 : 0);
      });
    }
    ids.push(special.sep);
    wordsMask.push(0);
    const length = ids.length;
    const spanCount = count * maxWidth;
    const spanIdx = new BigInt64Array(spanCount * 2);
    const spanMask = new Uint8Array(spanCount);
    for (let i = 0; i < count; i += 1) {
      for (let k = 0; k < maxWidth; k += 1) {
        const p = i * maxWidth + k;
        spanIdx[2 * p] = BigInt(i);
        spanIdx[2 * p + 1] = BigInt(Math.min(i + k, count - 1));
        spanMask[p] = i + k < count ? 1 : 0;
      }
    }
    const int64 = (values: number[]) => BigInt64Array.from(values, (value) => BigInt(value));
    const feeds = {
      input_ids: makeTensor("int64", int64(ids), [1, length]),
      attention_mask: makeTensor("int64", new BigInt64Array(length).fill(1n), [1, length]),
      words_mask: makeTensor("int64", int64(wordsMask), [1, length]),
      text_lengths: makeTensor("int64", BigInt64Array.from([BigInt(count)]), [1, 1]),
      span_idx: makeTensor("int64", spanIdx, [1, spanCount, 2]),
      span_mask: makeTensor("bool", spanMask, [1, spanCount])
    };
    const output = await session.run(feeds);
    const logits = output.logits;
    if (!logits) throw new Error("The model gave no logits output");
    const classes = prompts.length;
    const expected = count * maxWidth * classes;
    if (logits.data.length < expected) throw new Error(`The model's logits have ${logits.data.length} values, expected ${expected}`);
    const found: Array<Omit<GlinerCandidate, "window" | "edge">> = [];
    for (let i = 0; i < count; i += 1) {
      for (let k = 0; k < maxWidth && i + k < count; k += 1) {
        const base = (i * maxWidth + k) * classes;
        for (let c = 0; c < classes; c += 1) {
          const score = sigmoid(Number(logits.data[base + c]));
          if (score >= prompts[c]!.cutoff) found.push({ first: window.first + i, last: window.first + i + k, prompt: c, score });
        }
      }
    }
    return found;
  }
}

export class GlinerCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

export function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

/** Window-edge rule, de-duplication, then greedy non-overlap by score; character offsets out. */
export function resolveCandidates(candidates: readonly GlinerCandidate[], windows: readonly WordWindow[], words: readonly Word[]): RawSpan[] {
  const kept = candidates.filter((candidate) => {
    if (!candidate.edge) return true;
    // Dropped when another window saw the same words away from its own inner edges (that window decides on its own).
    // Windows start and end in increasing order, so only the run of windows next to this one can hold the span.
    const holds = (index: number) => {
      const window = windows[index]!;
      return window.first <= candidate.first && candidate.last < window.end && !touchesInnerEdge(candidate, window, words.length);
    };
    for (let index = candidate.window - 1; index >= 0 && windows[index]!.end > candidate.last; index -= 1) if (holds(index)) return false;
    for (let index = candidate.window + 1; index < windows.length && windows[index]!.first <= candidate.first; index += 1) if (holds(index)) return false;
    return true;
  });
  const best = new Map<string, GlinerCandidate>();
  for (const candidate of kept) {
    const key = `${candidate.first}:${candidate.last}:${candidate.prompt}`;
    const seen = best.get(key);
    if (!seen || candidate.score > seen.score) best.set(key, candidate);
  }
  const sorted = [...best.values()].sort((a, b) => b.score - a.score || a.first - b.first || a.last - b.last || a.prompt - b.prompt);
  // Words already taken: each candidate costs its width (at most max_width words), not the number chosen so far.
  const taken = new Uint8Array(words.length);
  const chosen: GlinerCandidate[] = [];
  for (const candidate of sorted) {
    let free = true;
    for (let word = candidate.first; word <= candidate.last; word += 1) {
      if (taken[word]) {
        free = false;
        break;
      }
    }
    if (!free) continue;
    taken.fill(1, candidate.first, candidate.last + 1);
    chosen.push(candidate);
  }
  return chosen
    .sort((a, b) => a.first - b.first)
    .map((candidate) => ({ start: words[candidate.first]!.start, end: words[candidate.last]!.end, prompt: candidate.prompt, score: candidate.score }));
}

function touchesInnerEdge(span: { first: number; last: number }, window: WordWindow, wordCount: number): boolean {
  return (span.first === window.first && window.first > 0) || (span.last === window.end - 1 && window.end < wordCount);
}
