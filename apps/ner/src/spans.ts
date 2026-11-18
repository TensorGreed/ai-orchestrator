import type { GlinerPromptCut, RawSpan } from "./gliner.js";
import type { NerEntityClass, NerModel, NerPrompt } from "./models/manifest.js";

/**
 * From the model's raw spans to the endpoint's entities.
 *
 * Scores are calibrated per prompt: each prompt has a threshold in the manifest (set with the entity benchmark), and
 * a raw score at that threshold is reported as `NER_CALIBRATED_CUT` (0.8). Raw scores above it map linearly onto
 * 0.8–1 and scores below onto 0–0.8. So one number means the same for every model and class: at or above 0.8 the
 * model is as sure as its benchmark calibration asks for, which also clears every default lowest score of the
 * content rules check (0.7–0.8). A request's `threshold` is on this scale (default 0.8).
 *
 * Street addresses: the model reports address parts (street, city, state, postcode, country), not whole addresses.
 * A street line followed by address parts, separated by spaces, commas, a line break or a unit ("Apt 4B", "Suite
 * 300"), becomes one `street_address` span, and a unit just before the street joins it too. Parts that join an
 * address are not also reported; a postcode alone is never reported. A postal address starts at a house number, so
 * a street without a digit ("traffic on the high street", "Main Street pricing") and a PO box are not reported.
 */

export const NER_CALIBRATED_CUT = 0.8;
/** Raw scores under this are never decoded, whatever the request's threshold (it bounds the work per window). */
export const NER_MIN_RAW_CUTOFF = 0.05;

/** Characters of a unit designator ("Apt 4B, ") allowed between or before address parts, on top of the plain gap. */
const UNIT_GAP_CHARS = 24;
const UNIT = String.raw`(?:apt|apartment|unit|suite|ste|flat|floor|fl|level|lvl|room|rm|building|bldg|#)\.?\s*#?[A-Za-z0-9][A-Za-z0-9-]{0,5}`;
const UNIT_ONLY = new RegExp(String.raw`^${UNIT}$`, "i");
const GAP_WITH_UNIT = new RegExp(String.raw`^[\s,]*(?:${UNIT}[\s,]*)?$`, "i");
const UNIT_BEFORE = new RegExp(String.raw`(?:^|[\s,(])(${UNIT}[\s,]*)$`, "i");
const PO_BOX = /\bP\.?\s?O\.?\s*Box\b/i;

export interface NerEntity {
  start: number;
  end: number;
  label: NerEntityClass;
  score: number;
}

export function calibrate(raw: number, threshold: number): number {
  const value = raw >= threshold ? NER_CALIBRATED_CUT + ((1 - NER_CALIBRATED_CUT) * (raw - threshold)) / (1 - threshold) : (NER_CALIBRATED_CUT * raw) / threshold;
  return Math.min(1, Math.max(0, Math.round(value * 1000) / 1000));
}

/** The raw score that calibrates to `wanted`. */
export function rawCutoff(wanted: number, threshold: number): number {
  const raw = wanted >= NER_CALIBRATED_CUT ? threshold + ((wanted - NER_CALIBRATED_CUT) * (1 - threshold)) / (1 - NER_CALIBRATED_CUT) : (wanted * threshold) / NER_CALIBRATED_CUT;
  return Math.min(1, Math.max(NER_MIN_RAW_CUTOFF, raw));
}

export interface NerPlan {
  /** The prompts sent to the model, in order (raw spans refer to them by index). */
  prompts: NerPrompt[];
  cuts: GlinerPromptCut[];
  labels: ReadonlySet<NerEntityClass>;
  threshold: number;
}

const joinCut = (prompt: NerPrompt) => Math.max(NER_MIN_RAW_CUTOFF, prompt.joinThreshold ?? prompt.threshold);

/** Which prompts to send for the requested labels: the labels' own prompts, plus the address parts when street addresses are asked for. */
export function planPrompts(model: Pick<NerModel, "prompts">, labels: readonly NerEntityClass[], threshold: number = NER_CALIBRATED_CUT): NerPlan {
  const wanted = new Set(labels);
  const prompts = model.prompts.filter((prompt) => (prompt.class !== null && wanted.has(prompt.class)) || (prompt.addressPart && wanted.has("street_address")));
  const cuts = prompts.map((prompt) => {
    const reported = rawCutoff(threshold, prompt.threshold);
    // Address parts are read down to their join threshold, so they can join an address whatever the request's threshold.
    const cutoff = prompt.addressPart && wanted.has("street_address") ? Math.min(reported, joinCut(prompt)) : reported;
    return { prompt: prompt.prompt, cutoff };
  });
  return { prompts, cuts, labels: wanted, threshold };
}

/**
 * A postcode right after an address (after at most a few spaces or commas, optionally behind a state or province
 * code): US ZIP and ZIP+4, UK and Canadian postcodes, and the 4- and 5-digit codes of Australia, Germany, France and
 * others. Only ever tried next to a street the model found, never on its own.
 */
const POSTCODE = String.raw`(?:\d{5}(?:-\d{4})?|\d{4}|[A-Z]{1,2}\d[A-Z\d]?[ \t]?\d[A-Z]{2}|[A-Z]\d[A-Z][ \t]?\d[A-Z]\d)(?![\p{L}\p{N}])`;
/** Separators: spaces or commas, and at most one line break. */
const SEP = String.raw`[ \t,]{0,4}(?:\r?\n[ \t]{0,4})?`;
/** Optionally a capitalised town of up to three words and a state or province code, then the postcode. */
const POSTCODE_AFTER = new RegExp(String.raw`^${SEP}(?:\p{Lu}[\p{L}'.-]{1,30}(?:[ \t]\p{Lu}[\p{L}'.-]{1,30}){0,2}[ \t,]{1,3})?(?:[A-Z]{2,3}[ \t]+)?${POSTCODE}`, "u");
/** A line that starts with a postcode ("44907 Nantes"). */
const POSTCODE_START = new RegExp(String.raw`^${POSTCODE}`, "u");
const POSTCODE_WINDOW = 120;

const isAddressPiece = (prompt: NerPrompt) => prompt.addressPart || prompt.class === "street_address";

function joins(text: string, end: number, part: RawSpan, partPrompt: NerPrompt, addressMaxGap: number): boolean {
  // A part, or a "postcode town" line the model took for a street.
  const piece = partPrompt.addressPart ? part.score >= joinCut(partPrompt) : partPrompt.class === "street_address" && POSTCODE_START.test(text.slice(part.start, part.end));
  if (!piece) return false;
  if (part.start - end > addressMaxGap + UNIT_GAP_CHARS) return false;
  const gap = text.slice(end, part.start);
  return /^[\s,]*$/.test(gap) ? gap.length <= addressMaxGap : GAP_WITH_UNIT.test(gap);
}

/** A street line that can start a postal address: a house number, a word, and not a PO box. */
function isStreetLine(value: string): boolean {
  return /\d/.test(value) && /\p{L}{3,}/u.test(value) && !PO_BOX.test(value) && !UNIT_ONLY.test(value.trim());
}

const TITLE_BEFORE = /^(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Professor|Sir|Dame|Rev|Herr|Frau|Mme|Mlle)\.?\s+/;
const SUFFIX_AFTER = /,?\s+(?:Jr|Sr|II|III|IV|PhD|MD)\.?$/;

/** A name without a leading title ("Dr. Okafor" → "Okafor") or a trailing suffix ("Jr."): the title is the cue, not the name. */
function trimName(text: string, start: number, end: number): { start: number; end: number } | undefined {
  const value = text.slice(start, end);
  const title = TITLE_BEFORE.exec(value);
  const from = title ? start + title[0].length : start;
  const suffix = SUFFIX_AFTER.exec(text.slice(from, end));
  const to = suffix ? end - suffix[0].length : end;
  return to > from ? { start: from, end: to } : undefined;
}

/** Raw spans (non-overlapping, any order) of one text to entities, sorted by start. */
export function entitiesFromRaw(text: string, raw: readonly RawSpan[], plan: NerPlan, addressMaxGap: number): NerEntity[] {
  const spans = [...raw]
    .filter((span) => span.prompt >= 0 && span.prompt < plan.prompts.length && span.start >= 0 && span.end <= text.length && span.end > span.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const used = new Set<number>();
  const out: NerEntity[] = [];
  const wantAddresses = plan.labels.has("street_address");
  for (let index = 0; index < spans.length; index += 1) {
    if (used.has(index)) continue;
    const span = spans[index]!;
    const prompt = plan.prompts[span.prompt]!;
    const score = calibrate(span.score, prompt.threshold);
    if (prompt.class === "street_address") {
      if (!wantAddresses || score < plan.threshold || !isStreetLine(text.slice(span.start, span.end))) continue;
      let start = span.start;
      const before = UNIT_BEFORE.exec(text.slice(Math.max(0, span.start - UNIT_GAP_CHARS), span.start));
      if (before) start = span.start - before[1]!.length;
      let end = span.end;
      let cursor = index + 1;
      for (let grew = true; grew; ) {
        grew = false;
        // Parts the address already covers (a postcode read by the pattern below) are part of it.
        while (cursor < spans.length && spans[cursor]!.start < end && isAddressPiece(plan.prompts[spans[cursor]!.prompt]!)) {
          end = Math.max(end, spans[cursor]!.end);
          used.add(cursor);
          cursor += 1;
        }
        const part = spans[cursor];
        if (part && part.start >= end && joins(text, end, part, plan.prompts[part.prompt]!, addressMaxGap)) {
          end = part.end;
          used.add(cursor);
          cursor += 1;
          grew = true;
          continue;
        }
        // The model rarely labels postcodes, so a postcode-shaped token right after the address joins it.
        const postcode = POSTCODE_AFTER.exec(text.slice(end, end + POSTCODE_WINDOW));
        if (postcode && (!part || part.start >= end + postcode[0].length || isAddressPiece(plan.prompts[part.prompt]!))) {
          end += postcode[0].length;
          grew = true;
        }
      }
      out.push({ start, end, label: "street_address", score });
      continue;
    }
    if (prompt.class === null || !plan.labels.has(prompt.class) || score < plan.threshold) continue;
    if (prompt.class === "person_name") {
      const name = trimName(text, span.start, span.end);
      if (name) out.push({ ...name, label: "person_name", score });
      continue;
    }
    out.push({ start: span.start, end: span.end, label: prompt.class, score });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}
