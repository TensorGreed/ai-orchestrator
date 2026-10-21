/**
 * Text normalisation shared by the injection detectors. Attackers hide
 * instructions behind leetspeak, odd spacing, zero-width characters and
 * base64. The detectors match on the original text and on these normalised
 * views, mapping hits back to spans in the original.
 */

export interface NormalizedView {
  /** Short label for traces (`leetspeak`, `base64`). */
  kind: "plain" | "leetspeak" | "base64";
  text: string;
  /** Map from an index in `text` back to an index in the original text. */
  toOriginal(index: number): number;
  /** Multiplier applied to pattern weights for hits found only in this view. */
  weight: number;
}

const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "l",
  "+": "t"
};

/** Characters that carry no visible meaning and are dropped from the plain view. */
export const INVISIBLE_CHARS = /[​‌‍⁠﻿­᠎‪-‮⁦-⁩]|[\u{E0000}-\u{E007F}]/gu;

/** Lower-cased text with invisible characters removed; offsets map back to the original. */
export function plainView(text: string): NormalizedView {
  const map: number[] = [];
  let out = "";
  let index = 0;
  for (const char of text) {
    const length = char.length;
    if (!INVISIBLE_CHARS.test(char)) {
      const lower = char.toLowerCase();
      for (let i = 0; i < lower.length; i += 1) map.push(index);
      out += lower;
    }
    INVISIBLE_CHARS.lastIndex = 0;
    index += length;
  }
  map.push(text.length);
  return { kind: "plain", text: out, toOriginal: (i) => map[Math.min(i, map.length - 1)] ?? text.length, weight: 1 };
}

/**
 * Leetspeak view: digits and symbols inside words are read as letters.
 * Only applied inside runs that mix letters with substitutable characters,
 * so "version 3" or "$100" stays as it is.
 */
export function leetspeakView(text: string): NormalizedView | null {
  const plain = plainView(text);
  const words = plain.text.split(/(\s+)/);
  let changed = false;
  const out = words
    .map((word) => {
      if (!/[a-z]/.test(word) || !/[0134578@$!|+]/.test(word)) return word;
      const letters = word.replace(/[a-z]/g, "").length;
      if (letters > word.length * 0.6) return word;
      changed = true;
      return word.replace(/[0134578@$!|+]/g, (c) => LEET[c] ?? c);
    })
    .join("");
  if (!changed) return null;
  return { kind: "leetspeak", text: out, toOriginal: plain.toOriginal, weight: 0.85 };
}

const BASE64_RUN = /[A-Za-z0-9+/]{32,}={0,2}/g;

/** Decoded base64 runs that are mostly printable text, each mapped back to the span of its encoded form. */
export function base64Views(text: string): NormalizedView[] {
  const views: NormalizedView[] = [];
  for (const match of text.matchAll(BASE64_RUN)) {
    const encoded = match[0];
    if (encoded.length % 4 === 1) continue;
    let decoded: string;
    try {
      decoded = Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      continue;
    }
    if (!decoded || !isMostlyText(decoded)) continue;
    const start = match.index ?? 0;
    const end = start + encoded.length;
    const lower = decoded.toLowerCase();
    views.push({ kind: "base64", text: lower, toOriginal: (i) => (i > 0 ? end : start), weight: 0.9 });
  }
  return views;
}

function isMostlyText(value: string): boolean {
  let printable = 0;
  for (const c of value) {
    const code = c.codePointAt(0) ?? 0;
    if ((code >= 32 && code < 127) || code === 10 || code === 13 || code === 9) printable += 1;
  }
  return printable / Array.from(value).length > 0.9 && /[a-z]{3}/i.test(value);
}

export function allViews(text: string): NormalizedView[] {
  const views: NormalizedView[] = [plainView(text)];
  const leet = leetspeakView(text);
  if (leet) views.push(leet);
  views.push(...base64Views(text));
  return views;
}
