// Names and addresses (`data.entities`) in the rule set editor: immutable edits on the detector's options. The API
// validates the result (`guardEntitiesOptionsSchema`); these helpers keep the shape and drop values equal to the
// defaults, so a rule set only stores what someone changed.

import {
  DEFAULT_ENTITY_JUDGE_BAND,
  DEFAULT_ENTITY_JUDGE_MAX_SPANS,
  DEFAULT_ENTITY_MAX_CHARS,
  DEFAULT_ENTITY_MIN_SCORES,
  ENTITIES_DETECTOR_ID,
  ENTITY_ENDPOINT_CALIBRATED_CUT,
  ENTITY_DATA_CLASSES,
  ENTITY_ENGINES,
  MAX_ENTITY_CONTEXT_WORDS,
  type EntityDataClass,
  type EntityEngine
} from "@ai-orchestrator/shared";

export { ENTITIES_DETECTOR_ID, ENTITY_DATA_CLASSES, DEFAULT_ENTITY_MIN_SCORES, DEFAULT_ENTITY_MAX_CHARS, DEFAULT_ENTITY_JUDGE_BAND, DEFAULT_ENTITY_JUDGE_MAX_SPANS };

export const ENTITY_CLASS_LABELS: Record<EntityDataClass, string> = {
  person_name: "Person names",
  location: "Locations",
  street_address: "Street addresses"
};

/** Options a newly enabled `data.entities` entry starts with: every class (the editor lets one untick them). */
export function defaultEntitiesOptions(): Record<string, unknown> {
  return { classes: [...ENTITY_DATA_CLASSES] };
}

const rec = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export function entityClassesOf(options: Record<string, unknown>): EntityDataClass[] {
  const list = Array.isArray(options.classes) ? options.classes : [];
  return ENTITY_DATA_CLASSES.filter((dataClass) => list.includes(dataClass));
}

/** Turn a class on or off; the last class cannot be turned off (the detector needs at least one). */
export function withEntityClass(options: Record<string, unknown>, dataClass: EntityDataClass, on: boolean): Record<string, unknown> {
  const current = entityClassesOf(options);
  const next = on ? ENTITY_DATA_CLASSES.filter((entry) => entry === dataClass || current.includes(entry)) : current.filter((entry) => entry !== dataClass);
  if (next.length === 0) return options;
  const minScore = rec(options.minScore);
  // A threshold for a class that is off no longer applies.
  const kept = Object.fromEntries(Object.entries(minScore).filter(([key]) => (next as string[]).includes(key)));
  const { minScore: _old, ...rest } = options;
  return { ...rest, classes: next, ...(Object.keys(kept).length > 0 ? { minScore: kept } : {}) };
}

/**
 * The default lowest score of a class: the service's calibrated cut when the rule set uses the deployment's names and
 * addresses service (its findings count from there), else the built-in rules' default.
 */
export function entityDefaultMinScore(dataClass: EntityDataClass, usesService: boolean): number {
  return usesService ? ENTITY_ENDPOINT_CALIBRATED_CUT : DEFAULT_ENTITY_MIN_SCORES[dataClass];
}

/** The class's own lowest score when the rule set sets one. */
export function entityExplicitMinScore(options: Record<string, unknown>, dataClass: EntityDataClass): number | undefined {
  const value = rec(options.minScore)[dataClass];
  return typeof value === "number" ? value : undefined;
}

export function entityMinScoreOf(options: Record<string, unknown>, dataClass: EntityDataClass, usesService = false): number {
  return entityExplicitMinScore(options, dataClass) ?? entityDefaultMinScore(dataClass, usesService);
}

/**
 * Classes whose own lowest score is below the service's benchmark cut, when the rule set uses the service: their
 * service findings are reported below what the service's measured precision covers.
 */
export function entityClassesBelowServiceCut(options: Record<string, unknown>, usesService: boolean): EntityDataClass[] {
  if (!usesService) return [];
  return entityClassesOf(options).filter((dataClass) => {
    const own = entityExplicitMinScore(options, dataClass);
    return own !== undefined && own < ENTITY_ENDPOINT_CALIBRATED_CUT;
  });
}

/** Set a class's lowest reported score (0..1); the default value (for the engine in use) is stored as nothing. */
export function withEntityMinScore(options: Record<string, unknown>, dataClass: EntityDataClass, value: number, usesService = false): Record<string, unknown> {
  const clamped = Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) * 100) / 100;
  const minScore = { ...rec(options.minScore) };
  if (clamped === entityDefaultMinScore(dataClass, usesService)) delete minScore[dataClass];
  else minScore[dataClass] = clamped;
  const { minScore: _old, ...rest } = options;
  return Object.keys(minScore).length > 0 ? { ...rest, minScore } : rest;
}

/** The engine an options object names (`auto` when absent or unknown). */
export function entityEngineOf(options: Record<string, unknown>): EntityEngine {
  return (ENTITY_ENGINES as readonly string[]).includes(options.engine as string) ? (options.engine as EntityEngine) : "auto";
}

/** Set or clear a plain option; `undefined` removes it. */
export function withEntityOption(options: Record<string, unknown>, key: "engine" | "singleTokenNames" | "maxChars" | "timeoutMs", value: unknown): Record<string, unknown> {
  const { [key]: _old, ...rest } = options;
  return value === undefined ? rest : { ...rest, [key]: value };
}

/** Context words as typed (commas or line breaks between words), at most MAX_ENTITY_CONTEXT_WORDS each. */
export function contextWordsText(options: Record<string, unknown>, list: "boost" | "suppress"): string {
  const words = rec(options.contextWords)[list];
  return Array.isArray(words) ? words.filter((word): word is string => typeof word === "string").join(", ") : "";
}

export function withContextWords(options: Record<string, unknown>, list: "boost" | "suppress", text: string): Record<string, unknown> {
  const words = [...new Set(text.split(/[,\n]/).map((word) => word.trim()).filter(Boolean))].slice(0, MAX_ENTITY_CONTEXT_WORDS);
  const context = { ...rec(options.contextWords) };
  if (words.length > 0) context[list] = words;
  else delete context[list];
  const { contextWords: _old, ...rest } = options;
  return Object.keys(context).length > 0 ? { ...rest, contextWords: context } : rest;
}

/** The judge's settings as the editor shows them (defaults filled in). */
export function entityJudgeOf(options: Record<string, unknown>): { enabled: boolean; model: unknown; band: [number, number]; maxSpans: number } {
  const judge = rec(options.judge);
  const band = Array.isArray(judge.band) && judge.band.length === 2 && judge.band.every((value) => typeof value === "number") ? (judge.band as [number, number]) : [DEFAULT_ENTITY_JUDGE_BAND[0], DEFAULT_ENTITY_JUDGE_BAND[1]];
  return {
    enabled: judge.enabled === true,
    model: judge.model,
    band: [band[0], band[1]],
    maxSpans: typeof judge.maxSpans === "number" ? judge.maxSpans : DEFAULT_ENTITY_JUDGE_MAX_SPANS
  };
}

/**
 * Turn the judge on or off, or change one of its settings. Turning it off removes the whole judge block (nothing is
 * kept that could send spans to a model later); defaults are stored as nothing.
 */
export function withEntityJudge(
  options: Record<string, unknown>,
  change: { enabled: boolean } | { model: Record<string, unknown> | undefined } | { band: [number, number] } | { maxSpans: number }
): Record<string, unknown> {
  const { judge: _old, ...rest } = options;
  if ("enabled" in change && !change.enabled) return rest;
  const judge: Record<string, unknown> = { ...rec(options.judge), enabled: true };
  if ("model" in change) {
    if (change.model === undefined) delete judge.model;
    else judge.model = change.model;
  }
  if ("band" in change) {
    const [low, high] = change.band.map((value) => Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) * 100) / 100) as [number, number];
    if (low === DEFAULT_ENTITY_JUDGE_BAND[0] && high === DEFAULT_ENTITY_JUDGE_BAND[1]) delete judge.band;
    else judge.band = [low, high];
  }
  if ("maxSpans" in change) {
    const value = Math.floor(change.maxSpans);
    if (!Number.isFinite(value) || value === DEFAULT_ENTITY_JUDGE_MAX_SPANS) delete judge.maxSpans;
    else judge.maxSpans = Math.min(50, Math.max(1, value));
  }
  return { ...rest, judge };
}
