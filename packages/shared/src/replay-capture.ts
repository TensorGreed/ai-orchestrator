import { z } from "zod";
import type { ReplayRecordingSummary } from "./replay";

/**
 * Phase 15.6 — production capture: a sampled share of a workflow's
 * production runs is recorded (MCP cassette, model tape, memory seed),
 * scrubbed of secrets, masked with keyed surrogates, and kept as a
 * *candidate* recording in the workflow's "Captured runs" inbox. A builder
 * promotes the useful ones into a golden set in one click.
 *
 * Captured: runs started by production triggers (webhooks, schedules, chat
 * and widget, forms, API execute, app triggers, the MCP gateway, the queue).
 * Never captured: editor and test runs, test webhooks, retries, approval
 * resumes, eval runs, replays and gate runs. When the workflow has a
 * published version, only runs of that version.
 *
 * Off by default. A workflow that never turns capture on runs exactly as
 * before.
 */

/** Run outcomes a capture may keep. */
export const REPLAY_CAPTURE_STATUSES = ["success", "error", "canceled"] as const;
export type ReplayCaptureStatus = (typeof REPLAY_CAPTURE_STATUSES)[number];

/** Most captures a day a workflow may ask for. */
export const REPLAY_CAPTURE_MAX_PER_DAY_LIMIT = 1_000;

export const DEFAULT_REPLAY_CAPTURE_SETTINGS = {
  enabled: false,
  rate: 0.1,
  maxPerDay: 20,
  onlyStatuses: [...REPLAY_CAPTURE_STATUSES] as ReplayCaptureStatus[],
  dlp: true,
  targetDatasetId: null as string | null
};

const rateSchema = z.number().finite().min(0.0001, "rate must be above 0").max(1, "rate is a share between 0 and 1");

export const replayCaptureSettingsUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** Share of eligible runs to capture, 0..1 (0.1 = 10%). */
    rate: rateSchema.optional(),
    maxPerDay: z.number().int().min(1).max(REPLAY_CAPTURE_MAX_PER_DAY_LIMIT).optional(),
    onlyStatuses: z
      .array(z.enum(REPLAY_CAPTURE_STATUSES))
      .min(1, "keep at least one run status")
      .max(REPLAY_CAPTURE_STATUSES.length)
      .optional(),
    /** Mask personal data with surrogates (on by default). Only admins may turn it off, with a reason. */
    dlp: z.boolean().optional(),
    /** Golden set promoted runs go to; null: a set named "Captured", created on the first promote. */
    targetDatasetId: z.string().trim().min(1).max(200).nullable().optional(),
    /** Required when an admin turns masking off; audited. */
    reason: z.string().trim().min(1).max(500).optional()
  })
  .strict();
export type ReplayCaptureSettingsUpdate = z.infer<typeof replayCaptureSettingsUpdateSchema>;

export interface ReplayCaptureSettings {
  enabled: boolean;
  rate: number;
  maxPerDay: number;
  onlyStatuses: ReplayCaptureStatus[];
  dlp: boolean;
  targetDatasetId: string | null;
}

/** Capture outcomes that lost a run the settings asked for (masking could not finish, too large, an error): shown as the last drop. */
export const REPLAY_CAPTURE_DROP_OUTCOMES = ["dropped_identifier_value", "dropped_unscannable", "dropped_incomplete_mask", "skipped_too_large", "failed"] as const;
export type ReplayCaptureDropOutcome = (typeof REPLAY_CAPTURE_DROP_OUTCOMES)[number];

/** The last run the workflow's capture dropped, and when. */
export interface ReplayCaptureLastDrop {
  outcome: ReplayCaptureDropOutcome;
  at: string;
}

export interface ReplayCaptureSettingsView extends ReplayCaptureSettings {
  workflowId: string;
  /** False until the workflow's settings were first saved. */
  configured: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Why masking was turned off (admins only). */
  dlpOffReason: string | null;
  /** The deployment's limits: REPLAY_CAPTURE_ENABLED and REPLAY_CAPTURE_MAX_RATE. */
  deployment: { enabled: boolean; maxRate: number; retentionDays: number; maxCandidates: number };
  /** The rate sampling uses now: the workflow's, capped by the deployment's ceiling; 0 when capture is off. */
  effectiveRate: number;
  /** Candidates waiting in the inbox, and captures counted against today's (UTC) limit. */
  candidates: number;
  capturedToday: number;
  /** The last sampled run that could not be captured (null when none was): a workflow that never captures shows why. */
  lastDrop: ReplayCaptureLastDrop | null;
}

/** One row of the "Captured runs" inbox. */
export interface ReplayCaptureView extends ReplayRecordingSummary {
  /** Data classes masked in the run (chips: "contains email, card"). */
  dataClasses: string[];
  masked: boolean;
  /** `api_key`: an API key started the run on the execute routes (its trigger stays `manual`). Set by the server only. */
  source: "api_key" | null;
}

/** The inbox trigger filter's value for runs an API key started (filters on the capture source, not the trigger). */
export const REPLAY_CAPTURE_API_KEY_FILTER = "api_key";

export const replayCaptureListQuerySchema = z.object({
  /** The source run's outcome. */
  runStatus: z.enum(REPLAY_CAPTURE_STATUSES).optional(),
  trigger: z.string().trim().min(1).max(100).optional(),
  /** ISO timestamps bounding `capturedAt`. */
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0)
});
export type ReplayCaptureListQuery = z.infer<typeof replayCaptureListQuerySchema>;

/** Most captured runs one bulk promote or discard may name. */
export const REPLAY_CAPTURE_BULK_MAX = 100;

export const replayCapturePromoteSchema = z
  .object({
    /** Golden set of the same workflow; default: the capture settings' target, else the "Captured" set. */
    datasetId: z.string().trim().min(1).max(200).optional(),
    name: z.string().trim().min(1).max(120).optional()
  })
  .strict();

export const replayCaptureBulkPromoteSchema = z
  .object({
    ids: z.array(z.string().trim().min(1).max(200)).min(1).max(REPLAY_CAPTURE_BULK_MAX),
    datasetId: z.string().trim().min(1).max(200).optional()
  })
  .strict();

export const replayCaptureBulkDiscardSchema = z
  .object({ ids: z.array(z.string().trim().min(1).max(200)).min(1).max(REPLAY_CAPTURE_BULK_MAX) })
  .strict();

/** Name of the golden set promoted runs go to when no target is set. */
export const REPLAY_CAPTURE_DEFAULT_SET_NAME = "Captured";

export interface ReplayCapturePromoteOutcome {
  id: string;
  ok: boolean;
  /** The golden set the run went to. */
  datasetId?: string;
  fixtureId?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Data-subject lookup (admins)
// ---------------------------------------------------------------------------

/** Shortest value searched raw when it is not recognised as a data class (an email, card, phone, ...). */
export const REPLAY_FIND_SUBJECT_MIN_RAW_LENGTH = 6;

/** Data classes the lookup can be told to read a value as. */
export const REPLAY_FIND_SUBJECT_CLASSES = ["email", "phone", "card_number", "us_ssn", "iban", "national_id"] as const;
export type ReplayFindSubjectClass = (typeof REPLAY_FIND_SUBJECT_CLASSES)[number];

/** Countries the lookup offers for a phone number typed without its country code (ISO 3166 code → calling code). */
export const REPLAY_FIND_SUBJECT_COUNTRIES: ReadonlyArray<{ code: string; name: string; callingCode: string }> = [
  { code: "US", name: "United States", callingCode: "1" },
  { code: "CA", name: "Canada", callingCode: "1" },
  { code: "GB", name: "United Kingdom", callingCode: "44" },
  { code: "IE", name: "Ireland", callingCode: "353" },
  { code: "FR", name: "France", callingCode: "33" },
  { code: "DE", name: "Germany", callingCode: "49" },
  { code: "IT", name: "Italy", callingCode: "39" },
  { code: "ES", name: "Spain", callingCode: "34" },
  { code: "PT", name: "Portugal", callingCode: "351" },
  { code: "NL", name: "Netherlands", callingCode: "31" },
  { code: "BE", name: "Belgium", callingCode: "32" },
  { code: "CH", name: "Switzerland", callingCode: "41" },
  { code: "AT", name: "Austria", callingCode: "43" },
  { code: "SE", name: "Sweden", callingCode: "46" },
  { code: "NO", name: "Norway", callingCode: "47" },
  { code: "DK", name: "Denmark", callingCode: "45" },
  { code: "FI", name: "Finland", callingCode: "358" },
  { code: "PL", name: "Poland", callingCode: "48" },
  { code: "CZ", name: "Czechia", callingCode: "420" },
  { code: "HU", name: "Hungary", callingCode: "36" },
  { code: "RO", name: "Romania", callingCode: "40" },
  { code: "GR", name: "Greece", callingCode: "30" },
  { code: "UA", name: "Ukraine", callingCode: "380" },
  { code: "BY", name: "Belarus", callingCode: "375" },
  { code: "RU", name: "Russia", callingCode: "7" },
  { code: "KZ", name: "Kazakhstan", callingCode: "7" },
  { code: "TR", name: "Türkiye", callingCode: "90" },
  { code: "IL", name: "Israel", callingCode: "972" },
  { code: "AE", name: "United Arab Emirates", callingCode: "971" },
  { code: "SA", name: "Saudi Arabia", callingCode: "966" },
  { code: "EG", name: "Egypt", callingCode: "20" },
  { code: "ZA", name: "South Africa", callingCode: "27" },
  { code: "NG", name: "Nigeria", callingCode: "234" },
  { code: "KE", name: "Kenya", callingCode: "254" },
  { code: "IN", name: "India", callingCode: "91" },
  { code: "PK", name: "Pakistan", callingCode: "92" },
  { code: "CN", name: "China", callingCode: "86" },
  { code: "HK", name: "Hong Kong", callingCode: "852" },
  { code: "TW", name: "Taiwan", callingCode: "886" },
  { code: "JP", name: "Japan", callingCode: "81" },
  { code: "KR", name: "South Korea", callingCode: "82" },
  { code: "SG", name: "Singapore", callingCode: "65" },
  { code: "MY", name: "Malaysia", callingCode: "60" },
  { code: "TH", name: "Thailand", callingCode: "66" },
  { code: "VN", name: "Vietnam", callingCode: "84" },
  { code: "ID", name: "Indonesia", callingCode: "62" },
  { code: "PH", name: "Philippines", callingCode: "63" },
  { code: "AU", name: "Australia", callingCode: "61" },
  { code: "NZ", name: "New Zealand", callingCode: "64" },
  { code: "BR", name: "Brazil", callingCode: "55" },
  { code: "MX", name: "Mexico", callingCode: "52" },
  { code: "AR", name: "Argentina", callingCode: "54" },
  { code: "CL", name: "Chile", callingCode: "56" },
  { code: "CO", name: "Colombia", callingCode: "57" }
];

const findSubjectQuery = {
  /** The value to look for (an email address, card number, phone number, ...). Never stored or logged. */
  value: z.string().min(3).max(1_000),
  /**
   * Read the value as this class (a value it does not parse as is refused).
   * Without it the class comes from the value itself; a `+` number with an
   * assigned calling code is a phone.
   */
  dataClass: z.enum(REPLAY_FIND_SUBJECT_CLASSES).optional(),
  /**
   * Phones: the country of a number typed without its country code, as an
   * ISO code from REPLAY_FIND_SUBJECT_COUNTRIES or a calling code (`+44`).
   * With it the number is searched as an international number; without it
   * a number typed without a country code finds possible matches only.
   */
  country: z
    .string()
    .trim()
    .regex(/^(?:[A-Za-z]{2}|\+\d{1,3})$/, "country is a two-letter country code or a calling code such as +44")
    .optional()
};

/** Search: where a value is stored, raw or as its surrogate. Nothing is deleted. */
export const replayFindSubjectSchema = z.object(findSubjectQuery).strict();
export type ReplayFindSubjectQuery = z.infer<typeof replayFindSubjectSchema>;

/** Stores the lookup searches. */
export const REPLAY_FIND_SUBJECT_KINDS = ["recording", "fixture", "eval_result", "execution", "cassette"] as const;
export type ReplayFindSubjectKind = (typeof REPLAY_FIND_SUBJECT_KINDS)[number];

/** Most rows one delete may name. */
export const REPLAY_FIND_SUBJECT_DELETE_MAX = 2_000;

/** Delete: the rows a search returned, by kind and id. Each is checked again against the value before it is deleted. */
export const replayFindSubjectDeleteSchema = z
  .object({
    ...findSubjectQuery,
    targets: z
      .array(
        z
          .object({
            kind: z.enum(REPLAY_FIND_SUBJECT_KINDS),
            id: z.string().trim().min(1).max(200),
            /**
             * Required to delete a possible match (certainty `national_only`):
             * the admin checked this row and confirms it holds this person's
             * number. Without it such a row is skipped, never deleted.
             */
            confirmPossible: z.literal(true).optional()
          })
          .strict()
      )
      .min(1)
      .max(REPLAY_FIND_SUBJECT_DELETE_MAX)
  })
  .strict();

/**
 * How sure a match is. `exact`: the same value (a phone with the same
 * country code on both sides). `national_only`: a phone whose national
 * digits agree but one side has no country code, so it may be someone
 * else's number; listed as a possible match and deleted only when confirmed.
 */
export type ReplayFindSubjectCertainty = "exact" | "national_only";

export interface ReplayFindSubjectMatch {
  kind: ReplayFindSubjectKind;
  id: string;
  workflowId: string | null;
  projectId: string | null;
  name: string;
  /** A golden run's status (`candidate` | `golden`), or a result's or run's outcome. */
  status: string | null;
  /** How it matched: `raw` (stored unmasked) or the data class whose surrogate matched. */
  matchedAs: string[];
  /** Which stored parts hold it (a golden run: input, nodes, facts, cassette, modelTape, memorySeed, workflow, notes). */
  fields: string[];
  /** Why it matched, so an admin can check before deleting: up to a few hits, each with a masked excerpt. */
  hits: ReplayFindSubjectHit[];
  /** `exact` when any hit is exact; `national_only` rows are possible matches (a delete needs `confirmPossible`). */
  certainty: ReplayFindSubjectCertainty;
}

/** One place a stored row holds the value. The excerpt is masked: the match as the guard mask shows it, digits around it hidden. */
export interface ReplayFindSubjectHit {
  field: string;
  /** `raw` or the data class whose surrogate matched. */
  matchedAs: string;
  /** The value's data class (null for a value searched as plain text). */
  dataClass: string | null;
  excerpt: string;
  certainty: ReplayFindSubjectCertainty;
  /** A possible match's stored country code, when the stored copy has one (a country code is not personal data). */
  storedCallingCode?: string | null;
}

export interface ReplayFindSubjectResult {
  /**
   * The value's data class, by the DLP scan of the value itself (null: not a
   * recognised class, searched as exact text and as each dictionary class's
   * surrogate). Only stored values of that class match.
   */
  dataClass: string | null;
  /** The data classes the value was surrogated as for the search. */
  classesTried: string[];
  /** A phone searched with its country code (from the value or the country chosen): `1` for "Searched as phone (+1)". */
  callingCode: string | null;
  matches: ReplayFindSubjectMatch[];
  /** Matches per store. */
  counts: Record<ReplayFindSubjectKind, number>;
  /** Rows searched per store. */
  searched: Record<ReplayFindSubjectKind, number>;
  /** What the search covers, and what it does not (those follow their own retention). */
  covered: string[];
  notCovered: string[];
}

export interface ReplayFindSubjectDeleteResult {
  /** Rows deleted per store. Golden-set cases and results removed with a golden run are counted under fixture and eval_result. */
  deleted: Record<ReplayFindSubjectKind, number>;
  /** Every row deleted, by kind and id (the targets, and the cases and results removed with a golden run). */
  removed: Array<{ kind: ReplayFindSubjectKind; id: string }>;
  /** Targets not deleted: gone already, or no longer holding the value. */
  skipped: Array<{ kind: ReplayFindSubjectKind; id: string; reason: "not_found" | "no_match" | "possible_match_unconfirmed" }>;
}
