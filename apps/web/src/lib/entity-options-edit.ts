// Names and addresses (`data.entities`) in the rule set editor: immutable edits on the detector's options. The API
// validates the result (`guardEntitiesOptionsSchema`); these helpers keep the shape and drop values equal to the
// defaults, so a rule set only stores what someone changed.

import { DEFAULT_ENTITY_MAX_CHARS, DEFAULT_ENTITY_MIN_SCORES, ENTITIES_DETECTOR_ID, ENTITY_DATA_CLASSES, MAX_ENTITY_CONTEXT_WORDS, type EntityDataClass } from "@ai-orchestrator/shared";

export { ENTITIES_DETECTOR_ID, ENTITY_DATA_CLASSES, DEFAULT_ENTITY_MIN_SCORES, DEFAULT_ENTITY_MAX_CHARS };

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

export function entityMinScoreOf(options: Record<string, unknown>, dataClass: EntityDataClass): number {
  const value = rec(options.minScore)[dataClass];
  return typeof value === "number" ? value : DEFAULT_ENTITY_MIN_SCORES[dataClass];
}

/** Set a class's lowest reported score (0..1); the default value is stored as nothing. */
export function withEntityMinScore(options: Record<string, unknown>, dataClass: EntityDataClass, value: number): Record<string, unknown> {
  const clamped = Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) * 100) / 100;
  const minScore = { ...rec(options.minScore) };
  if (clamped === DEFAULT_ENTITY_MIN_SCORES[dataClass]) delete minScore[dataClass];
  else minScore[dataClass] = clamped;
  const { minScore: _old, ...rest } = options;
  return Object.keys(minScore).length > 0 ? { ...rest, minScore } : rest;
}

/** Set or clear a plain option; `undefined` removes it. */
export function withEntityOption(options: Record<string, unknown>, key: "engine" | "singleTokenNames" | "maxChars", value: unknown): Record<string, unknown> {
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
