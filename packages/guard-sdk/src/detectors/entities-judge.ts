import { ENTITIES_DETECTOR_ID, type EntityDataClass, type GuardEntitiesOptions } from "@ai-orchestrator/shared";
import type { DetectorContext } from "../types";
import { DATA_BLOCK_RULE, fenceForModel, guardModelRefOption, randomBoundary, requireCompletion, strictJsonAnswer } from "./output-model";

/**
 * The optional judge of `data.entities`: spans the recognizer scored inside the judge's band are uncertain, and each
 * one goes, with up to `JUDGE_CONTEXT_CHARS` characters on either side, to the chat model the rule set names. The
 * model answers one verdict per span. A confirmed span is raised to its class's lowest reported score (so it acts); a
 * rejected one is dropped; a span the answer leaves out keeps the recognizer's score.
 *
 * What goes to the model is the spans and their surroundings, nothing else of the text. The excerpt is fenced with a
 * random boundary and passed as JSON strings, so text in it cannot pose as instructions or close the block. The answer
 * is read strictly (one JSON object, nothing around it); an answer without verdicts fails the check, and the rule
 * set's failure setting decides.
 */

export const JUDGE_CONTEXT_CHARS = 120;

type Judge = NonNullable<GuardEntitiesOptions["judge"]>;

interface JudgeableMatch {
  start: number;
  end: number;
  dataClass: EntityDataClass;
  score: number;
  minScore: number;
  source: string;
}

const CLASS_MEANING: Record<EntityDataClass, string> = {
  person_name: "the name of a real or fictional person (not a product, company, month or place)",
  location: "a place: a city, region, country or similar (not a person, organisation or product)",
  street_address: "a postal street address (a house number with a street, possibly with town and postcode)"
};

const SYSTEM_PROMPT = [
  "You check spans that a recognizer found in text and was unsure about.",
  "Each item has an index i, the class the recognizer gave, the span text and the text around it.",
  `For each item decide whether the span really is what the class says: ${Object.entries(CLASS_MEANING)
    .map(([dataClass, meaning]) => `${dataClass} means ${meaning}`)
    .join("; ")}.`,
  DATA_BLOCK_RULE,
  'Answer with exactly one JSON object and nothing else: {"verdicts":[{"i":0,"sensitive":true}]}, one entry per item.'
].join("\n");

/** The judged matches: confirmed ones raised to their class's lowest reported score, rejected ones removed. */
export async function judgeEntities<T extends JudgeableMatch>(text: string, matches: readonly T[], judge: Judge, context: DetectorContext): Promise<T[]> {
  const [low, high] = judge.band;
  const uncertain = matches
    .map((match, index) => ({ match, index }))
    .filter(({ match }) => match.score >= low && match.score <= high)
    .slice(0, judge.maxSpans);
  if (uncertain.length === 0) return [...matches];
  const model = guardModelRefOption(judge.model, ENTITIES_DETECTOR_ID);
  const complete = requireCompletion(context, ENTITIES_DETECTOR_ID);
  const items = uncertain.map(({ match }, i) =>
    JSON.stringify({
      i,
      class: match.dataClass,
      span: text.slice(match.start, match.end),
      context: text.slice(Math.max(0, match.start - JUDGE_CONTEXT_CHARS), Math.min(text.length, match.end + JUDGE_CONTEXT_CHARS))
    })
  );
  const boundary = randomBoundary();
  const answer = await complete({
    ...(model ? { model } : {}),
    system: SYSTEM_PROMPT,
    prompt: `Items, one JSON object per line:\n${fenceForModel(items.join("\n"), boundary)}`,
    detectorId: ENTITIES_DETECTOR_ID,
    ...(context.signal ? { signal: context.signal } : {})
  });
  const verdicts = parseJudgeVerdicts(answer.text, uncertain.length);
  const rejected = new Set<number>();
  const confirmed = new Set<number>();
  verdicts.forEach((sensitive, i) => {
    const original = uncertain[i]!.index;
    if (sensitive === true) confirmed.add(original);
    else if (sensitive === false) rejected.add(original);
  });
  const out: T[] = [];
  matches.forEach((match, index) => {
    if (rejected.has(index)) return;
    if (confirmed.has(index)) out.push({ ...match, score: Math.max(match.score, match.minScore), source: `${match.source}+judge`.slice(0, 64) });
    else out.push(match);
  });
  return out;
}

/**
 * The verdicts in a judge's answer, by item index (undefined: no verdict for that item). Throws when the answer is not
 * exactly one JSON object with a `verdicts` list.
 */
export function parseJudgeVerdicts(text: string, count: number): Array<boolean | undefined> {
  const parsed = strictJsonAnswer(text);
  const list = parsed?.verdicts;
  if (!Array.isArray(list)) throw new Error(`${ENTITIES_DETECTOR_ID}: the judge's answer held no verdicts`);
  const out: Array<boolean | undefined> = Array.from({ length: count }, () => undefined);
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const { i, sensitive } = entry as { i?: unknown; sensitive?: unknown };
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= count || typeof sensitive !== "boolean") continue;
    // The first verdict for an item counts; a repeat cannot flip it.
    if (out[i] === undefined) out[i] = sensitive;
  }
  return out;
}

