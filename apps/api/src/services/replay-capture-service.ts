/**
 * Phase 15.6 — production capture.
 *
 * A workflow can capture a sampled share of its production runs as
 * *candidate* recordings in its "Captured runs" inbox; a builder promotes
 * the useful ones into a golden set in one click. Everything here is
 * optional: a workflow without capture settings (or with capture off) runs
 * exactly as before, and nothing is recorded.
 *
 * Lifecycle of one capture:
 *
 *   1. `decide`, when a run starts: production channel, a production
 *      trigger (never an editor or test run, a test webhook, a retry, an
 *      approval resume, an eval run or a replay), capture on for the
 *      workflow and on for the deployment (REPLAY_CAPTURE_ENABLED), the run
 *      is of the published version when there is one, the sampling draw
 *      falls under the rate (capped by REPLAY_CAPTURE_MAX_RATE), and the
 *      workflow's captures today (UTC, counting runs in flight) are under
 *      `maxPerDay`. Only then does the run get a recorder, so a run that is
 *      not sampled costs nothing.
 *   2. A run that pauses for approval gives its ticket back at once
 *      (`abandon`): nothing is kept of it, its recorder is dropped and its
 *      slot in the day is freed. Its resume is never captured.
 *   3. `finish`, after the run's final history is stored: queued, so it
 *      never delays the run's answer. The settings and the kill switch are
 *      read again: a capture turned off since the run started is dropped,
 *      and masking applies when either the run-start or the current
 *      settings ask for it. A run whose status is not in `onlyStatuses` is
 *      dropped (a miss: it does not count against the day).
 *   4. The candidate is built by `ReplayRecordingService.createCapture`
 *      (secret scrub, then surrogate masking in chunks when `dlp` is on).
 *      Content that cannot be scanned completely drops the capture
 *      (`dropped_unscannable`). The oldest candidates are evicted while the
 *      workflow is at REPLAY_CAPTURES_MAX_PER_WORKFLOW or over
 *      REPLAY_CAPTURES_MAX_BYTES_PER_WORKFLOW, and it is stored with
 *      `status = 'candidate'`, no author.
 *
 * Any failure while capturing is logged and counted (metric
 * `replay_captures_total{outcome="failed"}`), never thrown into the run.
 *
 * Candidates nobody promotes are deleted after REPLAY_CAPTURE_RETENTION_DAYS.
 *
 * The daily limit counts the captures stored today (plus runs in flight):
 * a candidate discarded, evicted or deleted by the data-subject lookup frees
 * its slot again.
 */

import { hkdfSync } from "node:crypto";
import {
  DEFAULT_REPLAY_CAPTURE_SETTINGS,
  REPLAY_CAPTURE_DEFAULT_SET_NAME,
  REPLAY_FIND_SUBJECT_KINDS,
  REPLAY_FIND_SUBJECT_MIN_RAW_LENGTH,
  type ReplayFindSubjectDeleteResult,
  type ReplayFindSubjectKind,
  type McpCassette,
  type ReplayCapturePromoteOutcome,
  type ReplayCaptureSettingsUpdate,
  type ReplayCaptureSettingsView,
  type ReplayCaptureView,
  type ReplayFindSubjectMatch,
  type ReplayFindSubjectResult,
  type ReplayRecordingSummary,
  type Workflow
} from "@ai-orchestrator/shared";
import {
  decodeView,
  MaskIncompleteError,
  MaskUnscannableError,
  scanDlp,
  SubjectIndex,
  surrogateFor,
  surrogateRedacts,
  type GuardDictionary
} from "@ai-orchestrator/guard-sdk";
import { SUBJECT_CASSETTE_SOURCES, SUBJECT_EXECUTION_TRIGGERS, type ReplayCaptureSettingsRecord, type SqliteStore, type SubjectTextRow } from "../db/database.js";
import { inputProvenance, type CaptureInputOrigin } from "./capture-masking.js";
import type { McpCassetteRunPlan } from "./mcp-cassette-service.js";
import { ReplayRecordingError, type ReplayRecordingService } from "./replay-recording-service.js";

/** HKDF info for the surrogate key: one deployment-stable key derived from the master key. */
export const CAPTURE_SURROGATE_HKDF_INFO = "l2m/capture-surrogate/v1";

/** The surrogate key: HKDF-SHA-256 of the 32-byte master key. Refuses any other key length (an empty key would give a key anyone can compute). */
export function deriveCaptureSurrogateKey(masterKey: Uint8Array): Uint8Array {
  if (masterKey.length !== 32) throw new Error("The capture surrogate key needs the 32-byte master key (SECRET_MASTER_KEY_BASE64).");
  return new Uint8Array(hkdfSync("sha256", masterKey, new Uint8Array(0), CAPTURE_SURROGATE_HKDF_INFO, 32));
}

/**
 * Triggers that are never captured, whatever channel they report. Editor
 * runs are `manual` / `manual_stream`; the execute API with an API key runs
 * as `api_execute` / `api_execute_stream` and is captured.
 */
const EXCLUDED_TRIGGERS = new Set([
  "manual",
  "manual_stream",
  "manual_retry",
  "mcp_replay",
  "replay",
  "eval",
  "eval_judge",
  "webhook_test",
  "approval_resume",
  "error"
]);

export class ReplayCaptureError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid" | "forbidden" | "conflict" | "too_large" | "limit"
  ) {
    super(message);
    this.name = "ReplayCaptureError";
  }
}

export interface CaptureDeployment {
  enabled: boolean;
  maxRate: number;
  retentionDays: number;
  maxPerWorkflow: number;
  /** REPLAY_CAPTURES_MAX_BYTES_PER_WORKFLOW: candidates' bytes per workflow; the oldest go first. */
  maxBytesPerWorkflow: number;
}

export interface ReplayCaptureServiceOptions {
  store: SqliteStore;
  recordings: ReplayRecordingService;
  /** Golden sets: the promote target. */
  datasets: {
    getDataset(id: string): { id: string; workflowId?: string | null } | null | undefined;
    listDatasets(options: { workflowId?: string }): Array<{ id: string; name: string; workflowId?: string | null }>;
    createDataset(input: { name: string; description?: string; projectId?: string; workflowId?: string; createdBy?: string }): { id: string } | null | undefined;
    addGoldenRun(input: { datasetId: string; recording: NonNullable<ReturnType<SqliteStore["getReplayRecording"]>>; name?: string }): { id: string } | null | undefined;
  };
  /** Surrogate key (HKDF of the master key). */
  surrogateKey: Uint8Array;
  /** The dictionaries of the guard profiles bound to the workflow (custom data classes). */
  dictionariesFor: (workflow: { id: string; projectId?: string | null }) => GuardDictionary[];
  /** Data classes a guard profile bound to the workflow can mask: their surrogates keep what the mask shows. */
  maskableClassesFor?: (workflow: { id: string; projectId?: string | null }) => string[];
  /** The workflow's current project (a promoted run's "Captured" set is made there). */
  workflowProject?: (workflowId: string) => string | null;
  /** Every dictionary data class the deployment's guard profiles define (the data-subject lookup tries them all). */
  dictionaryClasses: () => string[];
  /** The workflow's published version, or null when it has none. */
  publishedVersion: (workflowId: string) => number | null;
  deployment: CaptureDeployment;
  /** Uniform draw in [0, 1); tests pass a seeded generator. */
  random?: () => number;
  now?: () => Date;
  log: { warn: (data: Record<string, unknown>, message: string) => void; info: (data: Record<string, unknown>, message: string) => void };
  metric?: (outcome: string) => void;
}

/** A sampled run's capture, from `decide` to `finish`. */
export interface CaptureTicket {
  workflowId: string;
  rate: number;
  publishedVersion: number | null;
  settings: ReplayCaptureSettingsRecord;
  triggerType: string;
  /** Who produced the run's input, decided where the run started (labels). */
  inputOrigin: CaptureInputOrigin;
  /** When the ticket was given out (ms), for the stale-ticket sweep. */
  issuedAt: number;
  released?: boolean;
}

/** A small deterministic generator (mulberry32) for seeded sampling. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function startOfUtcDay(date: Date): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}

export class ReplayCaptureService {
  private readonly inFlight = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private readonly options: ReplayCaptureServiceOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private metric(outcome: string): void {
    try {
      this.options.metric?.(outcome);
    } catch {
      // Metrics never fail a capture.
    }
  }

  get deployment(): CaptureDeployment {
    return this.options.deployment;
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  settings(workflowId: string): ReplayCaptureSettingsRecord | null {
    return this.options.store.getReplayCaptureSettings(workflowId);
  }

  view(workflowId: string): ReplayCaptureSettingsView {
    const stored = this.settings(workflowId);
    const base = stored ?? { ...DEFAULT_REPLAY_CAPTURE_SETTINGS, workflowId, dlpOffReason: null, updatedAt: null, updatedBy: null };
    const deployment = this.options.deployment;
    const active = deployment.enabled && base.enabled;
    return {
      workflowId,
      configured: Boolean(stored),
      enabled: base.enabled,
      rate: base.rate,
      maxPerDay: base.maxPerDay,
      onlyStatuses: base.onlyStatuses,
      dlp: base.dlp,
      targetDatasetId: base.targetDatasetId,
      updatedAt: base.updatedAt,
      updatedBy: base.updatedBy,
      dlpOffReason: base.dlpOffReason,
      deployment: { enabled: deployment.enabled, maxRate: deployment.maxRate, retentionDays: deployment.retentionDays, maxCandidates: deployment.maxPerWorkflow },
      effectiveRate: active ? Math.min(base.rate, deployment.maxRate) : 0,
      candidates: this.options.store.countReplayRecordingsForWorkflow(workflowId, "candidate"),
      capturedToday: this.options.store.countReplayCapturesSince(workflowId, startOfUtcDay(this.now())) + (this.inFlight.get(workflowId) ?? 0)
    };
  }

  /**
   * Saves a workflow's settings. Turning masking off is for admins only, with
   * a reason (the caller audits it); a rate above the deployment's ceiling
   * and a target that is not one of the workflow's golden sets are refused.
   */
  update(workflow: Pick<Workflow, "id">, patch: ReplayCaptureSettingsUpdate, actor: { email: string; role: string }): ReplayCaptureSettingsView {
    const current = this.settings(workflow.id);
    const next = {
      enabled: patch.enabled ?? current?.enabled ?? DEFAULT_REPLAY_CAPTURE_SETTINGS.enabled,
      rate: patch.rate ?? current?.rate ?? DEFAULT_REPLAY_CAPTURE_SETTINGS.rate,
      maxPerDay: patch.maxPerDay ?? current?.maxPerDay ?? DEFAULT_REPLAY_CAPTURE_SETTINGS.maxPerDay,
      onlyStatuses: patch.onlyStatuses ? [...new Set(patch.onlyStatuses)] : (current?.onlyStatuses ?? DEFAULT_REPLAY_CAPTURE_SETTINGS.onlyStatuses),
      dlp: patch.dlp ?? current?.dlp ?? DEFAULT_REPLAY_CAPTURE_SETTINGS.dlp,
      targetDatasetId: patch.targetDatasetId !== undefined ? patch.targetDatasetId : (current?.targetDatasetId ?? null)
    };
    const maxRate = this.options.deployment.maxRate;
    if (patch.rate !== undefined && patch.rate > maxRate) {
      throw new ReplayCaptureError(`The rate is above this deployment's ceiling (REPLAY_CAPTURE_MAX_RATE = ${maxRate}).`, "invalid");
    }
    let dlpOffReason = current?.dlpOffReason ?? null;
    const turningMaskingOff = next.dlp === false && (current?.dlp ?? true) === true;
    if (turningMaskingOff) {
      if (actor.role !== "admin") throw new ReplayCaptureError("Only admins can turn masking off for captured runs.", "forbidden");
      if (!patch.reason?.trim()) throw new ReplayCaptureError("Give a reason for turning masking off; it is audited.", "invalid");
      dlpOffReason = patch.reason.trim();
    }
    if (next.dlp) dlpOffReason = null;
    if (next.targetDatasetId) {
      const dataset = this.options.datasets.getDataset(next.targetDatasetId);
      if (!dataset || dataset.workflowId !== workflow.id) {
        throw new ReplayCaptureError("The target must be a golden set of this workflow.", "invalid");
      }
    }
    this.options.store.saveReplayCaptureSettings({
      workflowId: workflow.id,
      ...next,
      dlpOffReason,
      updatedAt: this.now().toISOString(),
      updatedBy: actor.email
    });
    return this.view(workflow.id);
  }

  // ---------------------------------------------------------------------------
  // Sampling and capture
  // ---------------------------------------------------------------------------

  /**
   * Whether this run is captured. Called when the run starts, before its
   * registries are built; never throws (a failure means "not captured").
   */
  decide(input: {
    workflow: Pick<Workflow, "id">;
    channel: string;
    triggerType: string | undefined;
    releaseVersion: number | null;
    /** The run already records or replays (an eval run, a replay, a resume, a single-node run). */
    excluded: boolean;
    /** Who produced the run's input (server-side): only the scheduler earns `trusted`. Default `external`. */
    inputOrigin?: CaptureInputOrigin;
  }): CaptureTicket | null {
    try {
      const deployment = this.options.deployment;
      if (!deployment.enabled || input.excluded || input.channel !== "production") return null;
      if (!input.triggerType || EXCLUDED_TRIGGERS.has(input.triggerType)) return null;
      const settings = this.settings(input.workflow.id);
      if (!settings?.enabled) return null;
      const published = this.options.publishedVersion(input.workflow.id);
      if (published !== null && input.releaseVersion !== published) {
        this.metric("skipped_not_published_version");
        return null;
      }
      const rate = Math.min(settings.rate, deployment.maxRate);
      const draw = (this.options.random ?? Math.random)();
      if (!(draw < rate)) {
        this.metric("not_sampled");
        return null;
      }
      const used = this.options.store.countReplayCapturesSince(input.workflow.id, startOfUtcDay(this.now())) + (this.inFlight.get(input.workflow.id) ?? 0);
      if (used >= settings.maxPerDay) {
        this.metric("skipped_daily_limit");
        return null;
      }
      this.inFlight.set(input.workflow.id, (this.inFlight.get(input.workflow.id) ?? 0) + 1);
      return {
        workflowId: input.workflow.id,
        rate,
        publishedVersion: published,
        settings,
        triggerType: input.triggerType,
        inputOrigin: input.inputOrigin ?? "external",
        issuedAt: this.now().getTime()
      };
    } catch (error) {
      this.metric("failed");
      this.options.log.warn({ workflowId: input.workflow.id, error: error instanceof Error ? error.message : String(error) }, "Capture sampling failed; the run is not captured");
      return null;
    }
  }

  private release(ticket: CaptureTicket): void {
    // A ticket is given back once, whichever path gets there first.
    if (ticket.released) return;
    ticket.released = true;
    const count = (this.inFlight.get(ticket.workflowId) ?? 1) - 1;
    if (count <= 0) this.inFlight.delete(ticket.workflowId);
    else this.inFlight.set(ticket.workflowId, count);
  }

  /** A sampled run that will not be captured after all (it threw, paused, or its history was not stored). */
  abandon(ticket: CaptureTicket, outcome = "abandoned"): void {
    if (ticket.released) return;
    this.release(ticket);
    this.metric(outcome);
  }

  /** Runs in flight for a workflow (tests and the settings view). */
  inFlightFor(workflowId: string): number {
    return this.inFlight.get(workflowId) ?? 0;
  }

  /** The recording the run's recorder holds: MCP cassette with model tape and memory seed. */
  static cassetteOf(plan: McpCassetteRunPlan): McpCassette | null {
    if (!plan.recorder) return null;
    const cassette = plan.recorder.toCassette();
    if (plan.modelRecorder) {
      cassette.llm = "tape";
      cassette.models = plan.modelRecorder.toTape();
      const seed = plan.memoryCapture?.toSeed();
      if (seed) cassette.memorySeed = seed;
    }
    return cassette;
  }

  /**
   * Queues the capture of a finished run. The work runs after the current
   * request has answered; `idle()` resolves when the queue is empty.
   */
  finish(ticket: CaptureTicket, input: { executionId: string; workflow: Pick<Workflow, "id" | "name" | "projectId">; plan: McpCassetteRunPlan }): void {
    this.pending += 1;
    this.queue = this.queue
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => this.capture(ticket, input))
      .catch(() => undefined)
      .finally(() => {
        this.pending -= 1;
      });
  }

  /** Resolves when every queued capture is done. */
  async idle(): Promise<void> {
    while (this.pending > 0) await this.queue;
  }

  private async capture(ticket: CaptureTicket, input: { executionId: string; workflow: Pick<Workflow, "id" | "name" | "projectId">; plan: McpCassetteRunPlan }): Promise<void> {
    try {
      const store = this.options.store;
      // Settings as they are now: capture turned off (or the kill switch) since the run started drops it.
      const current = this.settings(ticket.workflowId);
      if (!this.options.deployment.enabled || !current?.enabled) {
        this.metric("discarded_disabled");
        return;
      }
      const history = store.getExecutionHistory(input.executionId);
      if (!history || !history.completedAt || ["running", "pending", "queued", "waiting_approval"].includes(history.status)) {
        this.metric("skipped_unfinished");
        return;
      }
      // Never a run a production trigger did not start (a resume under the same execution id).
      if (!history.triggerType || EXCLUDED_TRIGGERS.has(history.triggerType) || history.triggerType !== ticket.triggerType) {
        this.metric("skipped_excluded_trigger");
        return;
      }
      const statuses = current.onlyStatuses as readonly string[];
      if (!statuses.includes(history.status)) {
        this.metric("discarded_status");
        return;
      }
      const capturedAt = this.now().toISOString();
      // Masking applies when either the settings the run started with or the current ones ask for it.
      const masked = ticket.settings.dlp || current.dlp;
      const mask = masked
        ? {
            key: this.options.surrogateKey,
            dictionaries: this.options.dictionariesFor(input.workflow),
            visibleTailClasses: this.options.maskableClassesFor?.(input.workflow) ?? []
          }
        : null;
      const name = `Captured ${history.triggerType ?? "run"} ${capturedAt.slice(0, 16).replace("T", " ")}`;
      const summary = await this.options.recordings.createCapture(
        { executionId: input.executionId, name },
        {
          cassette: ReplayCaptureService.cassetteOf(input.plan),
          mask,
          rate: ticket.rate,
          publishedVersion: ticket.publishedVersion,
          capturedAt,
          inputProvenance: inputProvenance(history.triggerType, ticket.inputOrigin),
          beforeSave: (bytes) => {
            // Read once more right before saving: masking ran in chunks, and capture may have been turned off meanwhile.
            const latest = this.settings(ticket.workflowId);
            if (!this.options.deployment.enabled || !latest?.enabled) throw new ReplayCaptureError("Capture was turned off while the run was being masked.", "conflict");
            if (!masked && latest.dlp) throw new ReplayCaptureError("Masking was turned on while the run was being captured.", "conflict");
            this.evictFor(ticket.workflowId, bytes);
          }
        }
      );
      this.metric("captured");
      this.options.log.info({ workflowId: ticket.workflowId, recordingId: summary.id, bytes: summary.bytes, masked: Boolean(mask) }, "Captured a production run");
    } catch (error) {
      const outcome =
        error instanceof MaskUnscannableError
          ? "dropped_unscannable"
          : error instanceof MaskIncompleteError
            ? "dropped_incomplete_mask"
            : error instanceof ReplayCaptureError && error.code === "conflict"
              ? "discarded_disabled"
              : error instanceof ReplayRecordingError && error.code === "too_large"
                ? "skipped_too_large"
                : "failed";
      this.metric(outcome);
      this.options.log.warn(
        { workflowId: ticket.workflowId, executionId: input.executionId, outcome, error: error instanceof Error ? error.message : String(error) },
        "A production run could not be captured; the run itself is unaffected"
      );
    } finally {
      this.release(ticket);
    }
  }

  /**
   * Makes room for one more candidate of `bytes`: the oldest go first, while
   * the workflow is at its candidate count or over its byte budget. A
   * candidate larger than the whole budget is refused.
   */
  private evictFor(workflowId: string, bytes: number): void {
    const store = this.options.store;
    const { maxPerWorkflow, maxBytesPerWorkflow } = this.options.deployment;
    if (bytes > maxBytesPerWorkflow) {
      throw new ReplayRecordingError(`The captured run is ${bytes} bytes, more than REPLAY_CAPTURES_MAX_BYTES_PER_WORKFLOW (${maxBytesPerWorkflow}).`, "too_large");
    }
    let count = store.countReplayRecordingsForWorkflow(workflowId, "candidate");
    let used = store.sumReplayCaptureBytesForWorkflow(workflowId);
    while (count > 0 && (count + 1 > maxPerWorkflow || used + bytes > maxBytesPerWorkflow)) {
      const oldest = store.oldestReplayCaptures(workflowId, 20);
      if (oldest.length === 0) break;
      for (const candidate of oldest) {
        if (!(count + 1 > maxPerWorkflow || used + bytes > maxBytesPerWorkflow)) break;
        if (store.deleteReplayRecording(candidate.id)) this.metric("evicted");
        count -= 1;
        used -= candidate.bytes;
      }
    }
  }

  /** Retention: candidates older than REPLAY_CAPTURE_RETENTION_DAYS. */
  pruneExpired(): number {
    const cutoff = new Date(this.now().getTime() - this.options.deployment.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    return this.options.store.pruneReplayCaptures(cutoff);
  }

  // ---------------------------------------------------------------------------
  // Inbox
  // ---------------------------------------------------------------------------

  static view(summary: ReplayRecordingSummary): ReplayCaptureView {
    return { ...summary, dataClasses: summary.capabilities.capture?.dataClasses ?? [], masked: summary.capabilities.capture?.masked ?? false };
  }

  /**
   * Promotes a candidate: it is scrubbed again with today's secrets, checked
   * against the size limit, the golden-run count and the storage budgets,
   * becomes golden, and joins the golden set (`datasetId`, else the
   * settings' target, else a set named "Captured" made on first use).
   */
  promote(id: string, input: { datasetId?: string; name?: string }, actor: { email: string }): ReplayCapturePromoteOutcome & { workflowId?: string } {
    const store = this.options.store;
    const record = store.getReplayRecording(id);
    if (!record || record.status !== "candidate") return { id, ok: false, error: "Captured run not found" };
    try {
      // Checks first; the "Captured" set is made inside the transaction, so a refused promote leaves nothing behind.
      const prepared = this.options.recordings.preparePromotion(record);
      const projectId = this.options.workflowProject?.(record.workflowId) ?? record.projectId;
      let fixtureId: string | undefined;
      let datasetId = "";
      store.transaction(() => {
        datasetId = this.targetSet(record.workflowId, projectId, input.datasetId, actor.email);
        if (!store.promoteReplayCapture(id, { ...prepared, name: input.name ?? prepared.name, createdBy: actor.email })) {
          throw new ReplayCaptureError("The run is no longer waiting in the inbox.", "conflict");
        }
        const promoted = store.getReplayRecording(id)!;
        fixtureId = this.options.datasets.addGoldenRun({ datasetId, recording: promoted })?.id;
        if (!fixtureId) throw new ReplayCaptureError("The run could not be added to the golden set.", "conflict");
      });
      return { id, ok: true, datasetId, workflowId: record.workflowId, ...(fixtureId ? { fixtureId } : {}) };
    } catch (error) {
      if (error instanceof ReplayCaptureError || error instanceof ReplayRecordingError) return { id, ok: false, error: error.message, workflowId: record.workflowId };
      throw error;
    }
  }

  private targetSet(workflowId: string, projectId: string | null, requested: string | undefined, actorEmail: string): string {
    const datasets = this.options.datasets;
    const wanted = requested ?? this.settings(workflowId)?.targetDatasetId ?? null;
    if (wanted) {
      const dataset = datasets.getDataset(wanted);
      if (!dataset || dataset.workflowId !== workflowId) {
        // A target that was deleted since falls back to the default set; an explicit one that is wrong is an error.
        if (requested) throw new ReplayCaptureError("The golden set must belong to this workflow.", "invalid");
      } else {
        return dataset.id;
      }
    }
    const existing = datasets.listDatasets({ workflowId }).find((dataset) => dataset.name === REPLAY_CAPTURE_DEFAULT_SET_NAME);
    if (existing) return existing.id;
    const created = datasets.createDataset({
      name: REPLAY_CAPTURE_DEFAULT_SET_NAME,
      description: "Runs captured from production and promoted from the Captured runs inbox.",
      workflowId,
      ...(projectId ? { projectId } : {}),
      createdBy: actorEmail
    });
    if (!created) throw new ReplayCaptureError("The Captured golden set could not be created.", "conflict");
    return created.id;
  }

  // ---------------------------------------------------------------------------
  // Data-subject lookup
  // ---------------------------------------------------------------------------

  /** The built-in classes a looked-up value could have been masked as. */
  private builtInClasses(value: string): string[] {
    const trimmed = value.trim();
    const classes = new Set<string>(scanDlp(trimmed).map((match) => String(match.dataClass)));
    const digits = trimmed.replace(/\D/g, "").length;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) classes.add("email");
    if (digits >= 13 && digits <= 19 && /^[\d\s-]+$/.test(trimmed)) classes.add("card_number");
    if (digits >= 9 && digits <= 15 && /^[+\d\s().-]+$/.test(trimmed)) classes.add("phone");
    if (/^\d{3}[- ]?\d{2}[- ]?\d{4}$/.test(trimmed)) classes.add("us_ssn");
    if (/^[A-Z]{2}\d{2}[A-Z0-9\s-]{8,}$/i.test(trimmed)) classes.add("iban");
    if (/^[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]$/i.test(trimmed)) classes.add("national_id");
    // Secrets are removed outright, so there is nothing keyed to find.
    for (const redacted of [...classes]) if (surrogateRedacts(redacted)) classes.delete(redacted);
    return [...classes].sort();
  }

  /** The classes a looked-up value could have been masked as: the built-in ones it fits, and every dictionary class. */
  plausibleClasses(value: string): string[] {
    const classes = new Set(this.builtInClasses(value));
    for (const name of this.options.dictionaryClasses()) classes.add(name);
    return [...classes].sort();
  }

  /**
   * The finders for one value: raw (boundary-aware, in canonical form per
   * class: `ann@x.co` never matches `joann@x.com`) and, per plausible class,
   * its surrogates (with and without the visible tail, since a capture keeps
   * the tail only when a guard profile could mask the class). A phone is
   * matched on its last nine digits, so it is found written with or without
   * its country code.
   */
  private needlesFor(value: string): { classesTried: string[]; needles: Array<{ label: string; index: SubjectIndex }> } {
    const trimmed = value.trim();
    const builtIn = this.builtInClasses(trimmed);
    if (builtIn.length === 0 && trimmed.length < REPLAY_FIND_SUBJECT_MIN_RAW_LENGTH) {
      throw new ReplayCaptureError(
        `A value that is not an email address, card, IBAN, SSN, phone or NI number needs at least ${REPLAY_FIND_SUBJECT_MIN_RAW_LENGTH} characters.`,
        "invalid"
      );
    }
    const classes = this.plausibleClasses(trimmed);
    const raw = new SubjectIndex({ boundedLiterals: true });
    for (const dataClass of builtIn) raw.add(trimmed, dataClass);
    if (builtIn.length === 0) raw.addLiteral(trimmed, "raw");
    const needles: Array<{ label: string; index: SubjectIndex }> = [{ label: "raw", index: raw }];
    for (const dataClass of classes) {
      const index = new SubjectIndex({ boundedLiterals: true });
      for (const visibleTail of [false, true]) {
        const surrogate = surrogateFor(trimmed, dataClass, this.options.surrogateKey, { visibleTail });
        if (surrogate.startsWith("[")) index.addLiteral(surrogate, dataClass);
        else index.add(surrogate, dataClass);
      }
      needles.push({ label: dataClass, index });
    }
    return { classesTried: classes, needles };
  }

  private matchRow(row: SubjectTextRow, needles: Array<{ label: string; index: SubjectIndex }>): ReplayFindSubjectMatch | null {
    const matchedAs = new Set<string>();
    const fields = new Set<string>();
    for (const [field, text] of Object.entries(row.texts)) {
      if (!text) continue;
      // Stored text is JSON: decode its escapes (and URL-encoding) once, then match each finder.
      const view = decodeView(decodeView(text).text).text;
      for (const needle of needles) {
        if (needle.index.find(view).length > 0) {
          matchedAs.add(needle.label);
          fields.add(field);
        }
      }
    }
    if (matchedAs.size === 0) return null;
    return {
      kind: row.kind,
      id: row.id,
      workflowId: row.workflowId,
      projectId: row.projectId,
      name: row.name,
      status: row.status,
      matchedAs: [...matchedAs].sort(),
      fields: [...fields].sort()
    };
  }

  /**
   * Search: every stored copy of `value`, as its surrogate (a masked
   * capture) or raw (a run saved by hand, captured with masking off, or a
   * replay of one). The value is never stored or logged. Pages are small and
   * the event loop gets a turn between them. Nothing is deleted here.
   */
  async findSubject(value: string): Promise<ReplayFindSubjectResult> {
    const { classesTried, needles } = this.needlesFor(value);
    const store = this.options.store;
    const matches: ReplayFindSubjectMatch[] = [];
    const counts = Object.fromEntries(REPLAY_FIND_SUBJECT_KINDS.map((kind) => [kind, 0])) as Record<ReplayFindSubjectKind, number>;
    const searched = { ...counts };
    for (const kind of REPLAY_FIND_SUBJECT_KINDS) {
      let after = 0;
      for (;;) {
        const page = store.subjectTextPage(kind, after, FIND_SUBJECT_PAGE);
        for (const row of page.rows) {
          searched[kind] += 1;
          const match = this.matchRow(row, needles);
          if (match) {
            matches.push(match);
            counts[kind] += 1;
          }
        }
        if (page.lastRowid === null || page.rows.length < FIND_SUBJECT_PAGE) break;
        after = page.lastRowid;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return { classesTried, matches, counts, searched, covered: FIND_SUBJECT_COVERED, notCovered: FIND_SUBJECT_NOT_COVERED };
  }

  /**
   * Delete: the rows a search returned. Each is checked again against the
   * value first; one that is gone or no longer holds it is skipped, never
   * deleted. A golden run takes its golden-set cases and their results.
   */
  async deleteSubject(value: string, targets: Array<{ kind: ReplayFindSubjectKind; id: string }>): Promise<ReplayFindSubjectDeleteResult> {
    const { needles } = this.needlesFor(value);
    const store = this.options.store;
    const deleted = Object.fromEntries(REPLAY_FIND_SUBJECT_KINDS.map((kind) => [kind, 0])) as Record<ReplayFindSubjectKind, number>;
    const skipped: ReplayFindSubjectDeleteResult["skipped"] = [];
    const removed: ReplayFindSubjectDeleteResult["removed"] = [];
    const seen = new Set<string>();
    let checked = 0;
    for (const target of targets) {
      const key = `${target.kind}:${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = store.subjectTextRow(target.kind, target.id);
      if (!row) {
        skipped.push({ ...target, reason: "not_found" });
        continue;
      }
      if (!this.matchRow(row, needles)) {
        skipped.push({ ...target, reason: "no_match" });
        continue;
      }
      const outcome = store.transaction(() => store.deleteSubjectRow(target.kind, target.id));
      if (outcome.deleted) {
        deleted[target.kind] += 1;
        removed.push({ kind: target.kind, id: target.id });
      }
      for (const cascaded of outcome.cascaded) {
        const cascadedKey = `${cascaded.kind}:${cascaded.id}`;
        if (seen.has(cascadedKey)) continue;
        seen.add(cascadedKey);
        deleted[cascaded.kind] += 1;
        removed.push(cascaded);
      }
      checked += 1;
      if (checked % FIND_SUBJECT_PAGE === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { deleted, removed, skipped };
  }
}

/** Rows read per page by the data-subject lookup (each golden run can be several megabytes). */
const FIND_SUBJECT_PAGE = 20;

/** What the data-subject lookup searches (and can delete from). */
export const FIND_SUBJECT_COVERED = [
  "Golden runs and captured runs (replay_recordings): input, node outputs, run facts, MCP cassette, model tape, memory seed, workflow snapshot, notes",
  "Golden-set cases (eval_fixtures): input and expected output, including hand-written cases and copied inputs",
  "Replay, replay-job, gate and eval results (eval_results): output, error and diff",
  `Runs made from golden runs and cases (execution_history with trigger ${SUBJECT_EXECUTION_TRIGGERS.join(", ")}): input, output, node results, custom data, error`,
  `MCP cassettes recorded by those runs (mcp_cassettes with source ${SUBJECT_CASSETTE_SOURCES.join(", ")})`
];

/** What it does not search: these follow their own retention settings. */
export const FIND_SUBJECT_NOT_COVERED = [
  "Production execution history, tool-call telemetry and paused runs (EXECUTION_HISTORY_RETENTION_DAYS)",
  "MCP cassettes from Record calls on ordinary runs, and imported cassettes (they follow EXECUTION_HISTORY_RETENTION_DAYS)",
  "Session memory, tool data and session artifacts (their own retention)",
  "Logs, metrics and log-streaming destinations (outside the database)",
  "Audit log (AUDIT_LOG_RETENTION_DAYS; it holds ids and counts, not values)",
  "Guard events (masked evidence only) and the guard token vault",
  "Usage events and eval run summaries (counts and costs)"
];
