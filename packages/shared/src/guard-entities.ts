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

/**
 * Which recognizer finds the spans:
 * - `auto`: the deployment's names and addresses service when one is configured, otherwise the built-in rules;
 * - `rules`: always the built-in rules;
 * - `endpoint`: always the deployment's service (the check fails when none is configured);
 * - `union`: the built-in rules and the service together, overlapping spans keep the higher score (fails without a service).
 */
export const ENTITY_ENGINES = ["auto", "rules", "endpoint", "union"] as const;
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

/** Default score band a judge looks at: spans scored inside it are uncertain. */
export const DEFAULT_ENTITY_JUDGE_BAND: readonly [number, number] = [0.35, 0.7];
export const DEFAULT_ENTITY_JUDGE_MAX_SPANS = 20;
export const MAX_ENTITY_JUDGE_MAX_SPANS = 50;

/**
 * The optional judge: spans the recognizer scored inside `band` go, each with a little text around it, to the chat
 * model `model` names, which answers whether each one is a name, a place or an address. A confirmed span is reported;
 * a rejected one is dropped. Off by default; the model is required (the spans leave the deployment when the model is
 * an external service). The model config is checked further by the detector (no credentials, stored secrets only).
 */
export const guardEntitiesJudgeSchema = z
  .object({
    enabled: z.boolean().default(false),
    model: z.record(z.string(), z.unknown()).optional(),
    band: z
      .tuple([score, score])
      .refine(([low, high]) => low < high, "Two numbers from 0 to 1, low first")
      .default([DEFAULT_ENTITY_JUDGE_BAND[0], DEFAULT_ENTITY_JUDGE_BAND[1]]),
    /** Spans judged per check at most; the rest keep the recognizer's score. */
    maxSpans: z.number().int().min(1).max(MAX_ENTITY_JUDGE_MAX_SPANS).default(DEFAULT_ENTITY_JUDGE_MAX_SPANS)
  })
  .strict()
  .refine((judge) => !judge.enabled || judge.model !== undefined, { message: "Name the model that judges uncertain spans", path: ["model"] });
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
    maxChars: z.number().int().min(1).max(MAX_ENTITY_MAX_CHARS).default(DEFAULT_ENTITY_MAX_CHARS),
    /**
     * The check's own time limit in milliseconds when it waits on a service or a model (the `endpoint` and `union`
     * engines, `auto` with a service configured, or the judge). Such a check is timed apart from the rule set's latency
     * budget. Default 30 000.
     */
    timeoutMs: z.number().int().min(1000).max(300_000).optional(),
    judge: guardEntitiesJudgeSchema.optional()
  })
  .strict();

export type GuardEntitiesOptions = z.output<typeof guardEntitiesOptionsSchema>;
export type GuardEntitiesOptionsInput = z.input<typeof guardEntitiesOptionsSchema>;

/** The lowest score reported for a class under these options. */
export function entityMinScore(options: Pick<GuardEntitiesOptions, "minScore">, dataClass: EntityDataClass): number {
  return options.minScore[dataClass] ?? DEFAULT_ENTITY_MIN_SCORES[dataClass];
}

/** What the detector list reports about the recognizer behind `data.entities`. */
/**
 * `rules`: only the built-in rules; `loaded`: a recognizer that is ready (a service that answers with a model loaded);
 * `idle`: a local model not loaded yet; `not_ready`: a service that answers but has no model loaded; `error`: a
 * service that cannot be reached or answered with an error.
 */
export const ENTITY_ENGINE_STATUSES = ["rules", "loaded", "idle", "not_ready", "error"] as const;
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
  /** `endpoint`: a names and addresses service the deployment configured. Absent: in-process. */
  kind?: "rules" | "endpoint";
  /** The model a service reports (its id, version and file checksum), when it reports one. */
  model?: GuardEntityModelInfo;
  /** A service's own status line (`not_ready`: why), never input text. */
  message?: string;
}

export interface GuardEntityModelInfo {
  id: string;
  version: string;
  sha256: string;
}

/** The commands that turn on the local names and addresses service (shown when only the built-in rules run). */
export const ENTITY_SERVICE_ENABLE_COMMAND = "l2m models pull --accept-licence && docker compose --profile ner up -d";
