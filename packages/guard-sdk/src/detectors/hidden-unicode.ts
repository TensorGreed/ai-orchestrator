import { mergeSpans, replaceSpans } from "../masking";
import type { DetectorContext, GuardDetector, GuardFinding, GuardInput, GuardSpan } from "../types";
import { clampScore } from "../types";

export const HIDDEN_UNICODE_DETECTOR_ID = "injection.hidden_unicode";

/**
 * Phase 12.2 — hidden payloads. Unicode tag characters (U+E0000–U+E007F)
 * spell ASCII invisibly, bidi overrides reorder what a reader sees, and
 * zero-width runs carry bits or split words to dodge filters. The detector
 * reports each run with the decoded tag payload as evidence (it is attacker
 * text, truncated, never user data) and its transform strips them all.
 */

interface HiddenRun {
  kind: "tag_characters" | "bidi_override" | "zero_width" | "soft_hyphen";
  span: GuardSpan;
  decoded?: string;
}

const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|️/u;

function isZeroWidth(code: number): boolean {
  return code === 0x200b || code === 0x200c || code === 0x200d || code === 0x2060 || code === 0xfeff || code === 0x180e;
}

function isBidiControl(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0x200e || code === 0x200f;
}

export function findHiddenRuns(text: string): HiddenRun[] {
  const runs: HiddenRun[] = [];
  const chars = Array.from(text);
  const offsets: number[] = [];
  let offset = 0;
  for (const c of chars) {
    offsets.push(offset);
    offset += c.length;
  }
  offsets.push(text.length);
  let i = 0;
  while (i < chars.length) {
    const code = chars[i]!.codePointAt(0) ?? 0;
    if (code >= 0xe0000 && code <= 0xe007f) {
      let j = i;
      let decoded = "";
      while (j < chars.length) {
        const cj = chars[j]!.codePointAt(0) ?? 0;
        if (cj < 0xe0000 || cj > 0xe007f) break;
        if (cj >= 0xe0020 && cj <= 0xe007e) decoded += String.fromCodePoint(cj - 0xe0000);
        j += 1;
      }
      runs.push({ kind: "tag_characters", span: { start: offsets[i]!, end: offsets[j]! }, decoded });
      i = j;
      continue;
    }
    if (isBidiControl(code)) {
      let j = i;
      while (j < chars.length && isBidiControl(chars[j]!.codePointAt(0) ?? 0)) j += 1;
      runs.push({ kind: "bidi_override", span: { start: offsets[i]!, end: offsets[j]! } });
      i = j;
      continue;
    }
    if (isZeroWidth(code)) {
      let j = i;
      while (j < chars.length && isZeroWidth(chars[j]!.codePointAt(0) ?? 0)) j += 1;
      const onlyJoiner = chars.slice(i, j).every((c) => c === "‍");
      const prev = chars[i - 1];
      const next = chars[j];
      const emojiContext = Boolean(prev && next && EXTENDED_PICTOGRAPHIC.test(prev) && EXTENDED_PICTOGRAPHIC.test(next));
      const bom = i === 0 && j === 1 && code === 0xfeff;
      if (!(onlyJoiner && emojiContext) && !bom) {
        runs.push({ kind: "zero_width", span: { start: offsets[i]!, end: offsets[j]! } });
      }
      i = j;
      continue;
    }
    if (code === 0xad) {
      let j = i;
      while (j < chars.length && (chars[j]!.codePointAt(0) ?? 0) === 0xad) j += 1;
      // One soft hyphen is a legitimate hyphenation hint; a run of them is not.
      if (j - i >= 2) runs.push({ kind: "soft_hyphen", span: { start: offsets[i]!, end: offsets[j]! } });
      i = j;
      continue;
    }
    i += 1;
  }
  return runs;
}

export function stripHiddenUnicode(text: string): string {
  return replaceSpans(
    text,
    findHiddenRuns(text).map((run) => run.span),
    () => ""
  );
}

export function createHiddenUnicodeDetector(): GuardDetector {
  return {
    id: HIDDEN_UNICODE_DETECTOR_ID,
    tier: "rule",
    description: "Unicode tag characters, bidi overrides and zero-width runs that hide or reorder text.",
    channels: ["prompt", "tool_result", "tool_arguments", "model_output", "final_output"],
    categories: ["hidden_payload"],
    detect(_input: GuardInput, context: DetectorContext) {
      const runs = findHiddenRuns(context.text);
      const findings: GuardFinding[] = [];
      const zeroWidth = runs.filter((r) => r.kind === "zero_width");
      for (const run of runs) {
        if (run.kind === "zero_width") continue;
        const length = Array.from(context.text.slice(run.span.start, run.span.end)).length;
        findings.push({
          detectorId: HIDDEN_UNICODE_DETECTOR_ID,
          category: "hidden_payload",
          score: run.kind === "tag_characters" ? (run.decoded && run.decoded.length >= 4 ? 1 : 0.8) : run.kind === "bidi_override" ? 0.7 : 0.6,
          spans: [run.span],
          evidence: run.decoded ? `decoded: ${Array.from(run.decoded).slice(0, 60).join("")}${run.decoded.length > 60 ? "…" : ""}` : `${length} ${run.kind.replace("_", " ")} character(s)`,
          message:
            run.kind === "tag_characters"
              ? `Unicode tag characters hide ${run.decoded?.length ?? 0} ASCII characters`
              : run.kind === "bidi_override"
                ? "Bidirectional override characters reorder displayed text"
                : "Run of soft hyphens",
          metadata: { kind: run.kind }
        });
      }
      if (zeroWidth.length > 0) {
        const total = zeroWidth.reduce((n, r) => n + Array.from(context.text.slice(r.span.start, r.span.end)).length, 0);
        // A stray zero-width space is common in copied text; many, or long runs, are a payload.
        const score = total >= 8 || zeroWidth.some((r) => r.span.end - r.span.start >= 6) ? 0.9 : total >= 3 ? 0.6 : 0.3;
        findings.push({
          detectorId: HIDDEN_UNICODE_DETECTOR_ID,
          category: "hidden_payload",
          score: clampScore(score),
          spans: mergeSpans(zeroWidth.map((r) => r.span)),
          evidence: `${total} zero-width character(s) in ${zeroWidth.length} run(s)`,
          message: "Zero-width characters that can carry a hidden payload or split words",
          metadata: { kind: "zero_width", total, runs: zeroWidth.length }
        });
      }
      return findings;
    },
    transform(text) {
      return stripHiddenUnicode(text);
    }
  };
}
