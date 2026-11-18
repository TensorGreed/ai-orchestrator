/**
 * Word splitting for GLiNER. The model was trained on words from the pattern `\w+(?:[-_]\w+)*|\S` with Unicode
 * word characters; JavaScript's `\w` is ASCII-only even with the `u` flag, so letters, marks and digits are spelled
 * out. Offsets are UTF-16 code units (JavaScript string indices), as in the endpoint contract.
 */

export interface Word {
  text: string;
  start: number;
  end: number;
}

const WORD = /[\p{L}\p{M}\p{N}_]+(?:[-_][\p{L}\p{M}\p{N}_]+)*|\S/gu;

export function splitWords(text: string): Word[] {
  const words: Word[] = [];
  WORD.lastIndex = 0;
  for (const match of text.matchAll(WORD)) {
    const start = match.index ?? 0;
    words.push({ text: match[0], start, end: start + match[0].length });
  }
  return words;
}

/** A window of words `[first, end)`. */
export interface WordWindow {
  first: number;
  end: number;
}

/**
 * Windows of at most `size` words that overlap by `overlap` words, also ended early when the next word would take
 * the window past `tokenBudget` subtokens (`tokensOf(i)` is word i's subtoken count). Every word is in at least one
 * window, and every window makes progress, so the loop always ends.
 */
export function wordWindows(count: number, size: number, overlap: number, tokenBudget: number, tokensOf: (index: number) => number): WordWindow[] {
  const windows: WordWindow[] = [];
  let first = 0;
  while (first < count) {
    let end = first;
    let tokens = 0;
    while (end < count && end - first < size) {
      const next = tokensOf(end);
      if (end > first && tokens + next > tokenBudget) break;
      tokens += next;
      end += 1;
    }
    windows.push({ first, end });
    if (end >= count) break;
    first = Math.max(first + 1, end - overlap);
  }
  return windows;
}
