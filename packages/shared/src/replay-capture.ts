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
}

/** One row of the "Captured runs" inbox. */
export interface ReplayCaptureView extends ReplayRecordingSummary {
  /** Data classes masked in the run (chips: "contains email, card"). */
  dataClasses: string[];
  masked: boolean;
}

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

export const replayFindSubjectSchema = z
  .object({
    /** The value to look for (an email address, card number, phone number, ...). Never stored or logged. */
    value: z.string().min(3).max(1_000),
    /** Delete every recording that holds it (and the golden-set cases made from them). */
    delete: z.boolean().optional()
  })
  .strict();

export interface ReplayFindSubjectMatch {
  recordingId: string;
  workflowId: string;
  projectId: string | null;
  name: string;
  status: ReplayRecordingSummary["status"];
  /** How it matched: `raw` (an unmasked run saved by hand) or the data class whose surrogate matched. */
  matchedAs: string[];
  /** Which stored parts hold it: input, nodes, facts, cassette, modelTape, memorySeed, workflow, notes. */
  fields: string[];
}

export interface ReplayFindSubjectResult {
  /** The data classes the value was surrogated as for the search. */
  classesTried: string[];
  matches: ReplayFindSubjectMatch[];
  /** Recordings deleted (with `delete: true`). */
  deleted: number;
  /** Golden-set cases removed with them. */
  casesDeleted: number;
  /** Recordings searched. */
  searched: number;
}
