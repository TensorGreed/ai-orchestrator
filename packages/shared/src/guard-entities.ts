import { z } from "zod";

/**
 * Person names, locations and street addresses as data classes of content rules: the `data.entities` detector.
 * Opt-in only: a rule set turns it on by listing the detector with the classes it wants, and a gateway content
 * tool call scans for them only when `entity_types` names them (never as part of "all classes"). The built-in rule
 * set does not list it.
 *
 * Options live under the detector entry's `options` in the rule set (validated by `guardEntitiesOptionsSchema`).
 * Recognizer endpoints and models are configured for the deployment, never in a rule set, so the schema is strict:
 * an unknown key (such as a URL) is refused.
 */

export const ENTITIES_DETECTOR_ID = "data.entities";

export const ENTITY_DATA_CLASSES = ["person_name", "location", "street_address"] as const;
export type EntityDataClass = (typeof ENTITY_DATA_CLASSES)[number];

export function isEntityDataClass(value: unknown): value is EntityDataClass {
  return typeof value === "string" && (ENTITY_DATA_CLASSES as readonly string[]).includes(value);
}

/** `auto`: the deployment's recognizer when one is configured, otherwise the built-in rules; `rules`: always the rules. */
export const ENTITY_ENGINES = ["auto", "rules"] as const;
export type EntityEngine = (typeof ENTITY_ENGINES)[number];

/** Languages the detector accepts in v1. */
export const ENTITY_LANGUAGES = ["en"] as const;

/** Default lowest score reported per class: lower scores are kept as suppressed findings. */
export const DEFAULT_ENTITY_MIN_SCORES: Readonly<Record<EntityDataClass, number>> = {
  person_name: 0.75,
  street_address: 0.7,
  location: 0.8
};

export const DEFAULT_ENTITY_MIN_LENGTH = 3;
export const DEFAULT_ENTITY_MAX_CHARS = 20_000;
/** The highest `maxChars` a rule set may set (document scans pass their own limit). */
export const MAX_ENTITY_MAX_CHARS = 1_000_000;
export const MAX_ENTITY_CONTEXT_WORDS = 50;
export const MAX_ENTITY_CONTEXT_WORD_LENGTH = 64;

const score = z.number().min(0).max(1);
const contextWord = z.string().trim().min(1).max(MAX_ENTITY_CONTEXT_WORD_LENGTH);

export const guardEntitiesOptionsSchema = z
  .object({
    /** Which classes to report. Required: the detector reports nothing it was not asked for. */
    classes: z
      .array(z.enum(ENTITY_DATA_CLASSES))
      .min(1, "Choose at least one of person_name, location, street_address")
      .max(ENTITY_DATA_CLASSES.length)
      .refine((list) => new Set(list).size === list.length, "List each class once"),
    engine: z.enum(ENTITY_ENGINES).default("auto"),
    /** Lowest score reported per class; missing classes take `DEFAULT_ENTITY_MIN_SCORES`. */
    minScore: z
      .object({ person_name: score.optional(), location: score.optional(), street_address: score.optional() })
      .strict()
      .default({}),
    /** Shorter spans are dropped. */
    minLength: z.number().int().min(1).max(64).default(DEFAULT_ENTITY_MIN_LENGTH),
    /** Report a one-word name without a cue (a title, a field label, a greeting). Off: one-word names need a cue. */
    singleTokenNames: z.boolean().default(false),
    /** Words near a span that raise (`boost`) or lower (`suppress`) its score. */
    contextWords: z
      .object({
        boost: z.array(contextWord).max(MAX_ENTITY_CONTEXT_WORDS).default([]),
        suppress: z.array(contextWord).max(MAX_ENTITY_CONTEXT_WORDS).default([])
      })
      .strict()
      .default({ boost: [], suppress: [] }),
    languages: z.array(z.enum(ENTITY_LANGUAGES)).min(1).max(ENTITY_LANGUAGES.length).default(["en"]),
    /** Longer text fails the check (the rule set's fail-open or fail-closed choice decides); never cut silently. */
    maxChars: z.number().int().min(1).max(MAX_ENTITY_MAX_CHARS).default(DEFAULT_ENTITY_MAX_CHARS)
  })
  .strict();

export type GuardEntitiesOptions = z.output<typeof guardEntitiesOptionsSchema>;
export type GuardEntitiesOptionsInput = z.input<typeof guardEntitiesOptionsSchema>;

/** The lowest score reported for a class under these options. */
export function entityMinScore(options: Pick<GuardEntitiesOptions, "minScore">, dataClass: EntityDataClass): number {
  return options.minScore[dataClass] ?? DEFAULT_ENTITY_MIN_SCORES[dataClass];
}

/** What the detector list reports about the recognizer behind `data.entities`. */
export const ENTITY_ENGINE_STATUSES = ["rules", "loaded", "idle", "error"] as const;
export type EntityEngineStatus = (typeof ENTITY_ENGINE_STATUSES)[number];

export interface GuardEntityEngineInfo {
  id: string;
  version: string;
  /** `rules`: only the built-in rules (no model or endpoint configured). */
  status: EntityEngineStatus;
  languages: readonly string[] | "any";
  classes: readonly string[];
  /** Why the engine is in `error`, when it is. */
  error?: string;
}
