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

import { hkdfSync, randomUUID } from "node:crypto";
import {
  DEFAULT_REPLAY_CAPTURE_SETTINGS,
  REPLAY_CAPTURE_DEFAULT_SET_NAME,
  REPLAY_CAPTURE_DROP_OUTCOMES,
  REPLAY_FIND_SUBJECT_COUNTRIES,
  REPLAY_FIND_SUBJECT_KINDS,
  REPLAY_FIND_SUBJECT_MIN_RAW_LENGTH,
  type ReplayFindSubjectCertainty,
  type ReplayFindSubjectQuery,
  type ReplayFindSubjectDeleteResult,
  type ReplayFindSubjectKind,
  type McpCassette,
  type ReplayCaptureDropOutcome,
  type ReplayCapturePromoteOutcome,
  type ReplayCaptureSettingsUpdate,
  type ReplayCaptureSettingsView,
  type ReplayCaptureView,
  type ReplayFindSubjectHit,
  type ReplayFindSubjectMatch,
  type ReplayFindSubjectResult,
  type ReplayRecordingSummary,
  type Workflow
} from "@ai-orchestrator/shared";
import {
  CALLING_CODES,
  decodeView,
  findingText,
  legacyTailedPhoneSurrogateDigits,
  legacyTailedSurrogate,
  MaskIdentifierError,
  MaskIncompleteError,
  MaskUnscannableError,
  maskForDataClass,
  parsePhone,
  phoneInCountry,
  phoneSurrogateDigits,
  resolveOverlaps,
  scanForCapture,
  trunkPrefixesFor,
  scrubEvidenceText,
  SubjectIndex,
  surrogateFor,
  surrogateRedacts,
  type GuardDictionary,
  type SubjectSpan
} from "@ai-orchestrator/guard-sdk";
import type { ReplayCaptureSettingsRecord, SubjectTextRow } from "../db/database.js";
import { SUBJECT_CASSETTE_SOURCES, SUBJECT_EXECUTION_TRIGGERS } from "../db/store-shared.js";
import { inputProvenance, type CaptureInputOrigin } from "./capture-masking.js";
import type { McpCassetteRunPlan } from "./mcp-cassette-service.js";
import { ReplayRecordingError, type ReplayRecordingService } from "./replay-recording-service.js";
import type { Store } from "../db/store.js";

/** HKDF info for the surrogate key: one deployment-stable key derived from the master key. */
export const CAPTURE_SURROGATE_HKDF_INFO = "l2m/capture-surrogate/v1";

/** The surrogate key: HKDF-SHA-256 of the 32-byte master key. Refuses any other key length (an empty key would give a key anyone can compute). */
export function deriveCaptureSurrogateKey(masterKey: Uint8Array): Uint8Array {
  if (masterKey.length !== 32) throw new Error("The capture surrogate key needs the 32-byte master key (SECRET_MASTER_KEY_BASE64).");
  return new Uint8Array(hkdfSync("sha256", masterKey, new Uint8Array(0), CAPTURE_SURROGATE_HKDF_INFO, 32));
}

/**
 * Triggers that are never captured, whatever channel they report. Editor
 * runs are `manual` / `manual_stream`. The execute API with an API key runs
 * under the same triggers (the workflow and the history see `manual`, as
 * they always have); the server marks those runs `captureSource: "api_key"`
 * where they start, and only that marker makes them eligible.
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

/** Triggers an API-key run of the execute routes keeps (`manual`, `manual_stream`): eligible only with `captureSource: "api_key"`. */
const API_KEY_TRIGGERS = new Set(["manual", "manual_stream"]);

/** Server-side marker on a run: an API key started it on the production channel. Never taken from a request body. */
export type CaptureSource = "api_key";

function eligibleTrigger(triggerType: string | null | undefined, source: CaptureSource | undefined): boolean {
  if (!triggerType) return false;
  if (!EXCLUDED_TRIGGERS.has(triggerType)) return true;
  return source === "api_key" && API_KEY_TRIGGERS.has(triggerType);
}

/** The metric outcome of a capture that threw. */
function captureFailureOutcome(error: unknown): string {
  if (error instanceof MaskUnscannableError) return "dropped_unscannable";
  if (error instanceof MaskIncompleteError) return "dropped_incomplete_mask";
  if (error instanceof MaskIdentifierError) return "dropped_identifier_value";
  if (error instanceof ReplayCaptureError && error.code === "conflict") return "discarded_disabled";
  if (error instanceof ReplayCaptureError && error.code === "not_found") return "discarded_source_deleted";
  if (error instanceof ReplayRecordingError && error.code === "too_large") return "skipped_too_large";
  return "failed";
}

/** What a capture failure log carries: the error's class and its message with secrets and personal data scrubbed. */
export function captureErrorLog(error: unknown, redact: (text: string) => string = (text) => text): { errorClass: string; error: string } {
  const errorClass = error instanceof Error ? error.name || error.constructor.name || "Error" : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  let scrubbed: string;
  try {
    scrubbed = scrubEvidenceText(redact(message))
      .replace(/\d{4,}/g, (digits) => "#".repeat(digits.length))
      .replace(/\s+/g, " ")
      .slice(0, 200);
  } catch {
    scrubbed = "";
  }
  return { errorClass: errorClass.slice(0, 80), error: scrubbed };
}

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
  store: Store;
  recordings: ReplayRecordingService;
  /** Golden sets: the promote target. */
  datasets: {
    getDataset(id: string): Promise<{ id: string; workflowId?: string | null } | null | undefined>;
  };
  /** Surrogate key (HKDF of the master key). */
  surrogateKey: Uint8Array;
  /** The dictionaries of the guard profiles bound to the workflow (custom data classes). */
  dictionariesFor: (workflow: { id: string; projectId?: string | null }) => Promise<GuardDictionary[]>;
  /** Tool names a registry server's current tool snapshot lists: such a tool name is not scanned on its own (capture-masking `cassetteIdentifiers`). */
  catalogToolNames?: (registryServerId: string) => Promise<readonly string[]>;
  /** The workflow's current project (a promoted run's "Captured" set is made there). */
  workflowProject?: (workflowId: string) => Promise<string | null>;
  /** Every dictionary data class the deployment's guard profiles define (the data-subject lookup tries them all). */
  dictionaryClasses: () => Promise<string[]>;
  /** The workflow's published version, or null when it has none. */
  publishedVersion: (workflowId: string) => Promise<number | null>;
  deployment: CaptureDeployment;
  /** Uniform draw in [0, 1); tests pass a seeded generator. */
  random?: () => number;
  now?: () => Date;
  log: { warn: (data: Record<string, unknown>, message: string) => void; info: (data: Record<string, unknown>, message: string) => void };
  metric?: (outcome: string) => void;
  /** Removes secret values from a log message (SecretService.redact). */
  redact?: (text: string) => string;
  /**
   * Gives back the tickets of runs that never reached their final history
   * write (the caller's stale-ticket sweep). Called on the caller's timer and
   * here, before a run is refused for the daily limit.
   */
  sweepStale?: () => void;
  /**
   * Phase 13.1 — cluster mode: the daily limit's slots are reserved in the database (serialized per workflow across
   * instances) instead of this process's in-flight count. Unset: the in-memory count, as before.
   */
  reservations?: CaptureReservations;
}

/** Phase 13.1 — daily-limit slots shared by every instance (Store.reserveReplayCapture and friends). */
export interface CaptureReservations {
  /** A reservation id when a slot was free (captures since `since` plus live reservations below `maxPerDay`), else null. */
  reserve(input: { workflowId: string; since: string; maxPerDay: number; ttlMs: number }): Promise<string | null>;
  release(id: string): Promise<void>;
  /** Live reservations of a workflow (the settings view's "captured today" counts them, as it counts runs in flight). */
  countLive(workflowId: string): Promise<number>;
}

/**
 * Phase 13.1 — how long a reservation outlives the run's own time limit: the stale-ticket sweep gives a ticket back a
 * minute after the limit, and masking and saving a capture take a while after the run ends. A reservation still held
 * then (its instance stopped) stops counting.
 */
export const CAPTURE_RESERVATION_MARGIN_MS = 10 * 60 * 1000;
const CAPTURE_RESERVATION_DEFAULT_RUN_MS = 60 * 60 * 1000;

/** A sampled run's capture, from `decide` to `finish`. */
export interface CaptureTicket {
  workflowId: string;
  rate: number;
  publishedVersion: number | null;
  settings: ReplayCaptureSettingsRecord;
  triggerType: string;
  /** Who produced the run's input, decided where the run started (labels). */
  inputOrigin: CaptureInputOrigin;
  /** Set by the server when an API key started the run (execute routes): the only way a `manual` run is captured. */
  captureSource?: CaptureSource;
  /** When the ticket was given out (ms), for the stale-ticket sweep. */
  issuedAt: number;
  released?: boolean;
  /** Phase 13.1 — cluster mode: the database reservation holding the ticket's daily slot. */
  reservationId?: string;
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

  async settings(workflowId: string): Promise<ReplayCaptureSettingsRecord | null> {
    return await this.options.store.getReplayCaptureSettings(workflowId);
  }

  async view(workflowId: string): Promise<ReplayCaptureSettingsView> {
    const stored = await this.settings(workflowId);
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
      candidates: await this.options.store.countReplayRecordingsForWorkflow(workflowId, "candidate"),
      capturedToday:
        await this.options.store.countReplayCapturesSince(workflowId, startOfUtcDay(this.now())) +
        (this.options.reservations ? await this.options.reservations.countLive(workflowId) : (this.inFlight.get(workflowId) ?? 0)),
      lastDrop:
        stored?.lastDropOutcome && stored.lastDropAt && (REPLAY_CAPTURE_DROP_OUTCOMES as readonly string[]).includes(stored.lastDropOutcome)
          ? { outcome: stored.lastDropOutcome as ReplayCaptureDropOutcome, at: stored.lastDropAt }
          : null
    };
  }

  /**
   * Saves a workflow's settings. Turning masking off is for admins only, with
   * a reason (the caller audits it); a rate above the deployment's ceiling
   * and a target that is not one of the workflow's golden sets are refused.
   */
  async update(workflow: Pick<Workflow, "id">, patch: ReplayCaptureSettingsUpdate, actor: { email: string; role: string }): Promise<ReplayCaptureSettingsView> {
    const current = await this.settings(workflow.id);
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
      const dataset = await this.options.datasets.getDataset(next.targetDatasetId);
      if (!dataset || dataset.workflowId !== workflow.id) {
        throw new ReplayCaptureError("The target must be a golden set of this workflow.", "invalid");
      }
    }
    await this.options.store.saveReplayCaptureSettings({
      workflowId: workflow.id,
      ...next,
      dlpOffReason,
      updatedAt: this.now().toISOString(),
      updatedBy: actor.email
    });
    return await this.view(workflow.id);
  }

  // ---------------------------------------------------------------------------
  // Sampling and capture
  // ---------------------------------------------------------------------------

  /**
   * Whether this run is captured. Called when the run starts, before its
   * registries are built; never throws (a failure means "not captured").
   */
  async decide(input: {
    workflow: Pick<Workflow, "id">;
    channel: string;
    triggerType: string | undefined;
    releaseVersion: number | null;
    /** The run already records or replays (an eval run, a replay, a resume, a single-node run). */
    excluded: boolean;
    /** Who produced the run's input (server-side): only the scheduler earns `trusted`. Default `external`. */
    inputOrigin?: CaptureInputOrigin;
    /** Server-side: an API key started the run (never from a request body). */
    captureSource?: CaptureSource;
    /** Phase 13.1 — the run's time limit, so a cluster-mode reservation outlives it (default one hour). */
    runTimeoutMs?: number;
  }): Promise<CaptureTicket | null> {
    try {
      const deployment = this.options.deployment;
      if (!deployment.enabled || input.excluded || input.channel !== "production") return null;
      if (!input.triggerType || !eligibleTrigger(input.triggerType, input.captureSource)) return null;
      const settings = await this.settings(input.workflow.id);
      if (!settings?.enabled) return null;
      const published = await this.options.publishedVersion(input.workflow.id);
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
      const since = startOfUtcDay(this.now());
      const ticketBase = {
        workflowId: input.workflow.id,
        rate,
        publishedVersion: published,
        settings,
        triggerType: input.triggerType,
        inputOrigin: input.inputOrigin ?? "external",
        ...(input.captureSource ? { captureSource: input.captureSource } : {})
      } satisfies Omit<CaptureTicket, "issuedAt">;
      const reservations = this.options.reservations;
      if (reservations) {
        // Cluster mode: one database step per workflow counts the stored captures and every instance's live
        // reservations, and reserves only below the limit.
        const reservationId = await reservations.reserve({
          workflowId: input.workflow.id,
          since,
          maxPerDay: settings.maxPerDay,
          ttlMs: (input.runTimeoutMs ?? CAPTURE_RESERVATION_DEFAULT_RUN_MS) + CAPTURE_RESERVATION_MARGIN_MS
        });
        if (!reservationId) {
          this.metric("skipped_daily_limit");
          return null;
        }
        return { ...ticketBase, issuedAt: this.now().getTime(), reservationId };
      }
      // The slot is held before the count is read: a capture that commits and gives its slot back
      // while the count is in flight is then counted once (in flight or stored), never zero times.
      const workflowId = input.workflow.id;
      this.inFlight.set(workflowId, (this.inFlight.get(workflowId) ?? 0) + 1);
      const others = () => (this.inFlight.get(workflowId) ?? 1) - 1;
      const unreserve = () => {
        const count = (this.inFlight.get(workflowId) ?? 1) - 1;
        if (count <= 0) this.inFlight.delete(workflowId);
        else this.inFlight.set(workflowId, count);
      };
      let used: number;
      try {
        used = others() + await this.options.store.countReplayCapturesSince(workflowId, since);
        if (used >= settings.maxPerDay && this.options.sweepStale) {
          // Tickets of runs that never finished may hold the day's slots: give them back first.
          this.options.sweepStale();
          used = others() + await this.options.store.countReplayCapturesSince(workflowId, since);
        }
      } catch (error) {
        unreserve();
        throw error;
      }
      if (used >= settings.maxPerDay) {
        unreserve();
        this.metric("skipped_daily_limit");
        return null;
      }
      return {
        workflowId: input.workflow.id,
        rate,
        publishedVersion: published,
        settings,
        triggerType: input.triggerType,
        inputOrigin: input.inputOrigin ?? "external",
        ...(input.captureSource ? { captureSource: input.captureSource } : {}),
        issuedAt: this.now().getTime()
      };
    } catch (error) {
      this.metric("failed");
      this.options.log.warn({ workflowId: input.workflow.id, ...captureErrorLog(error, this.options.redact) }, "Capture sampling failed; the run is not captured");
      return null;
    }
  }

  private release(ticket: CaptureTicket): void {
    // A ticket is given back once, whichever path gets there first.
    if (ticket.released) return;
    ticket.released = true;
    if (ticket.reservationId) {
      const reservationId = ticket.reservationId;
      // Best effort: a reservation that is not given back stops counting when it expires.
      this.options.reservations?.release(reservationId).catch((error: unknown) => {
        this.options.log.warn({ workflowId: ticket.workflowId, ...captureErrorLog(error, this.options.redact) }, "Could not give back a capture reservation; it lapses on its own");
      });
      return;
    }
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

  /**
   * Registry catalog tool names of every registry server the cassette
   * called, read before masking (which is synchronous). A server whose
   * catalog cannot be read is left out, so its names are scanned on their own.
   */
  private async catalogToolNamesOf(
    cassette: McpCassette | null,
    lookup: (registryServerId: string) => Promise<readonly string[]>
  ): Promise<Map<string, readonly string[]>> {
    const names = new Map<string, readonly string[]>();
    for (const server of cassette?.servers ?? []) {
      if (!server.registryServerId || names.has(server.registryServerId)) continue;
      try {
        names.set(server.registryServerId, await lookup(server.registryServerId));
      } catch {
        // No registry catalog: masking scans the server's names on their own (fails closed).
      }
    }
    return names;
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
  finish(ticket: CaptureTicket, input: { executionId: string; workflow: Pick<Workflow, "id" | "name" | "projectId">; plan: McpCassetteRunPlan; issuedSurrogates?: ReadonlySet<string> }): void {
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

  private async capture(
    ticket: CaptureTicket,
    input: { executionId: string; workflow: Pick<Workflow, "id" | "name" | "projectId">; plan: McpCassetteRunPlan; issuedSurrogates?: ReadonlySet<string> }
  ): Promise<void> {
    try {
      const store = this.options.store;
      // Settings as they are now: capture turned off (or the kill switch) since the run started drops it.
      const current = await this.settings(ticket.workflowId);
      if (!this.options.deployment.enabled || !current?.enabled) {
        this.metric("discarded_disabled");
        return;
      }
      const history = await store.getExecutionHistory(input.executionId);
      if (!history || !history.completedAt || ["running", "pending", "queued", "waiting_approval"].includes(history.status)) {
        this.metric("skipped_unfinished");
        return;
      }
      // Never a run a production trigger did not start (a resume under the same execution id).
      if (!history.triggerType || history.triggerType !== ticket.triggerType || !eligibleTrigger(history.triggerType, ticket.captureSource)) {
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
      const cassette = ReplayCaptureService.cassetteOf(input.plan);
      const catalogNames = masked && this.options.catalogToolNames ? await this.catalogToolNamesOf(cassette, this.options.catalogToolNames) : null;
      const mask = masked
        ? {
            key: this.options.surrogateKey,
            dictionaries: await this.options.dictionariesFor(input.workflow),
            ...(catalogNames
              ? {
                  catalogToolNames: (registryServerId: string) => {
                    const names = catalogNames.get(registryServerId);
                    if (!names) throw new Error(`No registry catalog for ${registryServerId}`);
                    return names;
                  }
                }
              : {}),
            // Phase 16 — surrogates the run issued itself stay as they are (same key, so the original's lookup still finds them).
            ...(input.issuedSurrogates && input.issuedSurrogates.size > 0 ? { keepValues: [...input.issuedSurrogates] } : {})
          }
        : null;
      const name = `Captured ${ticket.captureSource === "api_key" ? "API-key run" : history.triggerType} ${capturedAt.slice(0, 16).replace("T", " ")}`;
      const summary = await this.options.recordings.createCapture(
        { executionId: input.executionId, name },
        {
          cassette,
          mask,
          rate: ticket.rate,
          publishedVersion: ticket.publishedVersion,
          capturedAt,
          ...(ticket.captureSource ? { source: ticket.captureSource } : {}),
          inputProvenance: inputProvenance(history.triggerType, ticket.inputOrigin),
          beforeSave: async (bytes) => {
            // Read once more right before saving: masking ran in chunks, and capture may have been turned off meanwhile.
            const latest = await this.settings(ticket.workflowId);
            if (!this.options.deployment.enabled || !latest?.enabled) throw new ReplayCaptureError("Capture was turned off while the run was being masked.", "conflict");
            // The run or its workflow deleted meanwhile (perhaps for privacy): nothing of it is kept.
            if (!await store.getExecutionHistory(input.executionId) || !await store.getWorkflow(ticket.workflowId)) {
              throw new ReplayCaptureError("The run or its workflow was deleted while it was being captured.", "not_found");
            }
            if (!masked && latest.dlp) throw new ReplayCaptureError("Masking was turned on while the run was being captured.", "conflict");
            await this.evictFor(ticket.workflowId, bytes);
          }
        }
      );
      this.metric("captured");
      this.options.log.info({ workflowId: ticket.workflowId, recordingId: summary.id, bytes: summary.bytes, masked: Boolean(mask) }, "Captured a production run");
    } catch (error) {
      const outcome = captureFailureOutcome(error);
      this.metric(outcome);
      if ((REPLAY_CAPTURE_DROP_OUTCOMES as readonly string[]).includes(outcome)) {
        try {
          await this.options.store.recordReplayCaptureDrop(ticket.workflowId, outcome, this.now().toISOString());
        } catch {
          // The note is for the settings panel; the metric and the log line above still carry the drop.
        }
      }
      this.options.log.warn(
        { workflowId: ticket.workflowId, executionId: input.executionId, outcome, ...captureErrorLog(error, this.options.redact) },
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
  private async evictFor(workflowId: string, bytes: number): Promise<void> {
    const store = this.options.store;
    const { maxPerWorkflow, maxBytesPerWorkflow } = this.options.deployment;
    if (bytes > maxBytesPerWorkflow) {
      throw new ReplayRecordingError(`The captured run is ${bytes} bytes, more than REPLAY_CAPTURES_MAX_BYTES_PER_WORKFLOW (${maxBytesPerWorkflow}).`, "too_large");
    }
    let count = await store.countReplayRecordingsForWorkflow(workflowId, "candidate");
    let used = await store.sumReplayCaptureBytesForWorkflow(workflowId);
    while (count > 0 && (count + 1 > maxPerWorkflow || used + bytes > maxBytesPerWorkflow)) {
      const oldest = await store.oldestReplayCaptures(workflowId, 20);
      if (oldest.length === 0) break;
      for (const candidate of oldest) {
        if (!(count + 1 > maxPerWorkflow || used + bytes > maxBytesPerWorkflow)) break;
        if (await store.deleteReplayRecording(candidate.id)) this.metric("evicted");
        count -= 1;
        used -= candidate.bytes;
      }
    }
  }

  /** Retention: candidates older than REPLAY_CAPTURE_RETENTION_DAYS. */
  async pruneExpired(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - this.options.deployment.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    return await this.options.store.pruneReplayCaptures(cutoff);
  }

  // ---------------------------------------------------------------------------
  // Inbox
  // ---------------------------------------------------------------------------

  static view(summary: ReplayRecordingSummary): ReplayCaptureView {
    return {
      ...summary,
      dataClasses: summary.capabilities.capture?.dataClasses ?? [],
      masked: summary.capabilities.capture?.masked ?? false,
      source: summary.capabilities.capture?.source === "api_key" ? "api_key" : null
    };
  }

  /**
   * Promotes a candidate: it is scrubbed again with today's secrets, checked
   * against the size limit, the golden-run count and the storage budgets,
   * becomes golden, and joins the golden set (`datasetId`, else the
   * settings' target, else a set named "Captured" made on first use).
   */
  async promote(id: string, input: { datasetId?: string; name?: string }, actor: { email: string }): Promise<ReplayCapturePromoteOutcome & { workflowId?: string }> {
    const store = this.options.store;
    const record = await store.getReplayRecording(id);
    if (!record || record.status !== "candidate") return { id, ok: false, error: "Captured run not found" };
    try {
      // Checks first; the "Captured" set is made inside the transaction, so a refused promote leaves nothing behind.
      const prepared = await this.options.recordings.preparePromotion(record);
      const projectId = (await this.options.workflowProject?.(record.workflowId)) ?? record.projectId;
      const target = await this.targetSet(record.workflowId, projectId, input.datasetId, actor.email);
      // The candidate becomes golden, the "Captured" set is made when missing and the case is added in one
      // transaction, so a refused promote leaves nothing behind.
      const outcome = await store.promoteReplayCaptureToGoldenSet({
        recordingId: id,
        promotion: { ...prepared, name: input.name ?? prepared.name, createdBy: actor.email },
        target,
        fixture: { id: `fix_${randomUUID()}` },
        limits: this.options.recordings.limits
      });
      if ("refused" in outcome) {
        if (outcome.refused === "not_candidate") throw new ReplayCaptureError("The run is no longer waiting in the inbox.", "conflict");
        if (outcome.refused === "set_gone") throw new ReplayCaptureError("The run could not be added to the golden set.", "conflict");
        throw this.options.recordings.refusalError(outcome, "promoting");
      }
      return { id, ok: true, datasetId: outcome.datasetId, workflowId: record.workflowId, fixtureId: outcome.fixtureId };
    } catch (error) {
      if (error instanceof ReplayCaptureError || error instanceof ReplayRecordingError) return { id, ok: false, error: error.message, workflowId: record.workflowId };
      throw error;
    }
  }

  /** The golden set a promote joins: the requested or configured one, else the workflow's "Captured" set (made on first use). */
  private async targetSet(
    workflowId: string,
    projectId: string | null,
    requested: string | undefined,
    actorEmail: string
  ): Promise<{ datasetId: string } | { findOrCreate: { id: string; name: string; description: string; workflowId: string; projectId?: string; createdBy: string } }> {
    const wanted = requested ?? (await this.settings(workflowId))?.targetDatasetId ?? null;
    if (wanted) {
      const dataset = await this.options.datasets.getDataset(wanted);
      if (!dataset || dataset.workflowId !== workflowId) {
        // A target that was deleted since falls back to the default set; an explicit one that is wrong is an error.
        if (requested) throw new ReplayCaptureError("The golden set must belong to this workflow.", "invalid");
      } else {
        return { datasetId: dataset.id };
      }
    }
    return {
      findOrCreate: {
        id: `ds_${randomUUID()}`,
        name: REPLAY_CAPTURE_DEFAULT_SET_NAME,
        description: "Runs captured from production and promoted from the Captured runs inbox.",
        workflowId,
        ...(projectId ? { projectId } : {}),
        createdBy: actorEmail
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Data-subject lookup
  // ---------------------------------------------------------------------------

  /**
   * The looked-up value's data class: the capture scan of the value itself
   * (the DLP patterns plus the international phone detector, so a `+` number
   * with an assigned calling code is a phone), one finding covering all of
   * it (an IBAN or NI number is also tried in upper case). Null when it is
   * not a recognised class, or is a secret (secrets are removed outright, so
   * there is no surrogate to find).
   */
  classify(value: string): string | null {
    const trimmed = value.trim();
    const upper = trimmed.toUpperCase();
    for (const text of upper.length === trimmed.length && upper !== trimmed ? [trimmed, upper] : [trimmed]) {
      // A phone's `+` is part of the value even when the pattern matched from the digits after it.
      const whole = resolveOverlaps(scanForCapture(text)).find((match) => match.span.end === text.length && findingText(text, match).length === text.length);
      if (!whole) continue;
      const dataClass = String(whole.dataClass);
      return surrogateRedacts(dataClass) ? null : dataClass;
    }
    return null;
  }

  /**
   * What the admin asked for, read: the class (the hint, else the value's
   * own), and for a phone the text searched (with its country code when the
   * value has one or a country was chosen). A hint the value does not parse
   * as, or an unknown country, is refused; never silently searched as text.
   * Messages never repeat the value.
   */
  private readQuery(query: ReplayFindSubjectQuery): { text: string; dataClass: string | null; callingCode: string | null } {
    const trimmed = query.value.trim();
    let callingCode: string | null = null;
    if (query.country) {
      const country = query.country.toUpperCase();
      callingCode = country.startsWith("+") ? country.slice(1) : (REPLAY_FIND_SUBJECT_COUNTRIES.find((entry) => entry.code === country)?.callingCode ?? null);
      if (!callingCode || !CALLING_CODES.has(callingCode)) throw new ReplayCaptureError("That country is not one the lookup knows. Pick one from the list or give a calling code such as +44.", "invalid");
    }
    const auto = this.classify(trimmed);
    const dataClass = query.dataClass ?? (auto === null && callingCode ? "phone" : auto);
    if (query.dataClass && query.dataClass !== auto) {
      const parses = query.dataClass === "phone" ? phoneShaped(trimmed) : wholeFindingOf(trimmed, query.dataClass);
      if (!parses) {
        throw new ReplayCaptureError(
          query.dataClass === "phone"
            ? "That does not read as a phone number: it needs 7 to 15 digits, written with digits, spaces, dashes, dots, brackets or a leading +."
            : `That does not read as ${FIND_SUBJECT_CLASS_NAMES[query.dataClass] ?? query.dataClass}.`,
          "invalid"
        );
      }
    }
    if (callingCode && dataClass !== "phone") throw new ReplayCaptureError("A country applies to phone numbers only.", "invalid");
    if (dataClass !== "phone") return { text: trimmed, dataClass, callingCode: null };
    if (callingCode) {
      const phone = phoneInCountry(trimmed, callingCode);
      if (!phone) throw new ReplayCaptureError("The number's own country code is not the country chosen.", "invalid");
      return { text: `+${phone.cc}${phone.national}`, dataClass, callingCode };
    }
    const phone = parsePhone(trimmed);
    return { text: trimmed, dataClass, callingCode: phone?.explicit && phone.cc ? phone.cc : null };
  }

  /**
   * The finders for one value, all strict (`SubjectIndex` `strict`: whole
   * values only; a phone is `exact` only as the same number with its country
   * code on both sides, `national_only` when one side has none). A value of
   * a recognised class matches only stored values of that class: raw, and
   * as its surrogate (and as the tailed surrogate captures wrote before
   * surrogates stopped keeping the mask's visible tail). Any other value is
   * matched as exact text, and as the surrogate of each dictionary class.
   */
  private async needlesFor(query: ReplayFindSubjectQuery): Promise<{
    dataClass: string | null;
    callingCode: string | null;
    classesTried: string[];
    needles: Array<{ label: string; index: SubjectIndex }>;
  }> {
    const { text, dataClass, callingCode } = this.readQuery(query);
    if (!dataClass && text.length < REPLAY_FIND_SUBJECT_MIN_RAW_LENGTH) {
      throw new ReplayCaptureError(
        `A value that is not an email address, card, IBAN, SSN, phone or NI number needs at least ${REPLAY_FIND_SUBJECT_MIN_RAW_LENGTH} characters.`,
        "invalid"
      );
    }
    const raw = new SubjectIndex({ strict: true });
    if (dataClass) raw.add(text, dataClass);
    else raw.addLiteral(text, "raw");
    const needles: Array<{ label: string; index: SubjectIndex }> = [{ label: "raw", index: raw }];
    const classes = dataClass ? [dataClass] : [...new Set(await this.options.dictionaryClasses())].sort();
    const key = this.options.surrogateKey;
    for (const surrogateClass of classes) {
      const index = new SubjectIndex({ strict: true });
      const surrogate = surrogateFor(text, surrogateClass, key);
      if (surrogate.startsWith("[")) index.addLiteral(surrogate, surrogateClass);
      else index.add(surrogate, surrogateClass);
      // Captures stored before surrogates stopped keeping the mask's visible tail hold the tailed form, and their raw
      // value is gone: build it too (lookup only, never for masking), so a lookup never misses data it used to find.
      const legacy = legacyTailedSurrogate(text, surrogateClass, key);
      if (legacy !== null && legacy !== surrogate) index.add(legacy, surrogateClass);
      if (surrogateClass === "phone") {
        // A capture keys a copy written without its `+` on that copy's own digits (it cannot know the country code):
        // the full number, and the national number behind a trunk prefix. Those surrogates are written without a country code.
        for (const plainKey of plainMaskKeys(text)) {
          index.add(phoneSurrogateDigits(plainKey, key), "phone");
          index.add(legacyTailedPhoneSurrogateDigits(plainKey, key), "phone");
        }
      }
      needles.push({ label: surrogateClass, index });
    }
    return { dataClass, callingCode, classesTried: classes, needles };
  }

  private matchRow(row: SubjectTextRow, needles: Array<{ label: string; index: SubjectIndex }>): ReplayFindSubjectMatch | null {
    const matchedAs = new Set<string>();
    const fields = new Set<string>();
    const hits: ReplayFindSubjectHit[] = [];
    let exact = false;
    for (const [field, text] of Object.entries(row.texts)) {
      if (!text) continue;
      // Stored text is JSON: decode its escapes (and URL-encoding) once, then match each finder.
      const view = decodeView(decodeView(text).text).text;
      for (const needle of needles) {
        const spans = needle.index.find(view);
        if (spans.length === 0) continue;
        matchedAs.add(needle.label);
        fields.add(field);
        if (spans.some((span) => (span.certainty ?? "exact") === "exact")) exact = true;
        // Exact hits first, so the preview shows why a row is certain.
        const ordered = [...spans].sort((a, b) => Number((a.certainty ?? "exact") !== "exact") - Number((b.certainty ?? "exact") !== "exact"));
        for (const span of ordered) {
          if (hits.length >= FIND_SUBJECT_HITS_PER_ROW) break;
          hits.push(subjectHit(view, span, field, needle.label));
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
      fields: [...fields].sort(),
      hits,
      certainty: exact ? "exact" : "national_only"
    };
  }

  /**
   * Search: every stored copy of `value`, as its surrogate (a masked
   * capture) or raw (a run saved by hand, captured with masking off, or a
   * replay of one). The value is never stored or logged. Pages are small and
   * the event loop gets a turn between them. Nothing is deleted here.
   */
  async findSubject(query: ReplayFindSubjectQuery): Promise<ReplayFindSubjectResult> {
    const { dataClass, callingCode, classesTried, needles } = await this.needlesFor(query);
    const store = this.options.store;
    const matches: ReplayFindSubjectMatch[] = [];
    const counts = Object.fromEntries(REPLAY_FIND_SUBJECT_KINDS.map((kind) => [kind, 0])) as Record<ReplayFindSubjectKind, number>;
    const searched = { ...counts };
    for (const kind of REPLAY_FIND_SUBJECT_KINDS) {
      let after = 0;
      for (;;) {
        const page = await store.subjectTextPage(kind, after, FIND_SUBJECT_PAGE);
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
    // Certain matches first; possible matches (no country code in the stored copy) after them.
    matches.sort((a, b) => Number(a.certainty !== "exact") - Number(b.certainty !== "exact"));
    return { dataClass, callingCode, classesTried, matches, counts, searched, covered: FIND_SUBJECT_COVERED, notCovered: FIND_SUBJECT_NOT_COVERED };
  }

  /**
   * Delete: the rows a search returned. Each is checked again against the
   * value first, with the same strict matching; one that is gone or no
   * longer holds it is skipped, never deleted. A row that is only a
   * possible match (`national_only`: a phone with no country code on one
   * side) is skipped unless its target says `confirmPossible`. `beforeDelete` gets every row
   * about to be deleted before the first one is (the caller writes the
   * intent audit row; if it throws, nothing is deleted). A golden run takes
   * its golden-set cases and their results; a run takes its tool-call,
   * guard-event and usage rows. `beforeRowDelete` runs before each row's
   * delete and its result after it (the release gate audits admitted cases
   * taken and marks jobs whose results went stale).
   */
  async deleteSubject(
    query: ReplayFindSubjectQuery,
    targets: Array<{ kind: ReplayFindSubjectKind; id: string; confirmPossible?: true }>,
    hooks: {
      beforeDelete?: (rows: Array<{ kind: ReplayFindSubjectKind; id: string; certainty: ReplayFindSubjectCertainty }>) => void | Promise<void>;
      /** Just before one row is deleted: a function called once it is gone (the release gate's audit and stale jobs), or null. */
      beforeRowDelete?: (row: { kind: ReplayFindSubjectKind; id: string }) => Promise<(() => Promise<void>) | null>;
    } = {}
  ): Promise<ReplayFindSubjectDeleteResult> {
    // A row named both with and without a confirmation is a mistake in the request, whichever comes first: refused, nothing deleted.
    const confirmations = new Map<string, boolean>();
    for (const target of targets) {
      const key = `${target.kind}:${target.id.trim()}`;
      const confirmedHere = target.confirmPossible === true;
      if (confirmations.has(key) && confirmations.get(key) !== confirmedHere) {
        throw new ReplayCaptureError("A row is listed twice, once confirmed as a possible match and once not. List each row once.", "invalid");
      }
      confirmations.set(key, confirmedHere);
    }
    const { needles } = await this.needlesFor(query);
    const store = this.options.store;
    const deleted = Object.fromEntries(REPLAY_FIND_SUBJECT_KINDS.map((kind) => [kind, 0])) as Record<ReplayFindSubjectKind, number>;
    const skipped: ReplayFindSubjectDeleteResult["skipped"] = [];
    const removed: ReplayFindSubjectDeleteResult["removed"] = [];
    const seen = new Set<string>();
    const confirmed: Array<{ kind: ReplayFindSubjectKind; id: string; certainty: ReplayFindSubjectCertainty }> = [];
    let checked = 0;
    for (const target of targets) {
      const key = `${target.kind}:${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = await store.subjectTextRow(target.kind, target.id);
      const match = row ? this.matchRow(row, needles) : null;
      if (!row) skipped.push({ kind: target.kind, id: target.id, reason: "not_found" });
      else if (!match) skipped.push({ kind: target.kind, id: target.id, reason: "no_match" });
      // A possible match may be another person's number: never deleted unless the admin confirmed this row.
      else if (match.certainty !== "exact" && target.confirmPossible !== true) skipped.push({ kind: target.kind, id: target.id, reason: "possible_match_unconfirmed" });
      else confirmed.push({ kind: target.kind, id: target.id, certainty: match.certainty });
      checked += 1;
      if (checked % FIND_SUBJECT_PAGE === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (confirmed.length === 0) return { deleted, removed, skipped };
    await hooks.beforeDelete?.(confirmed);
    const gone = new Set<string>();
    let done = 0;
    for (const target of confirmed) {
      // Already removed with a golden run deleted before it (a case or a result named as a target too).
      if (gone.has(`${target.kind}:${target.id}`)) continue;
      const afterDelete = (await hooks.beforeRowDelete?.({ kind: target.kind, id: target.id })) ?? null;
      const outcome = await store.deleteSubjectRow(target.kind, target.id);
      if (outcome.deleted) await afterDelete?.();
      if (outcome.deleted) {
        gone.add(`${target.kind}:${target.id}`);
        deleted[target.kind] += 1;
        removed.push({ kind: target.kind, id: target.id });
      } else {
        skipped.push({ kind: target.kind, id: target.id, reason: "not_found" });
      }
      for (const cascaded of outcome.cascaded) {
        const cascadedKey = `${cascaded.kind}:${cascaded.id}`;
        if (gone.has(cascadedKey)) continue;
        gone.add(cascadedKey);
        deleted[cascaded.kind] += 1;
        removed.push(cascaded);
      }
      done += 1;
      if (done % FIND_SUBJECT_PAGE === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { deleted, removed, skipped };
  }
}

/** Most hits listed per matching row in a search. */
const FIND_SUBJECT_HITS_PER_ROW = 5;
/** Characters of context on each side of a hit's excerpt. */
const FIND_SUBJECT_EXCERPT_CONTEXT = 24;

/**
 * One hit for the search preview: the matched value as the guard mask
 * action shows it, with a little context around it whose DLP findings are
 * masked and whose digits are hidden, so the excerpt never shows another
 * value whole.
 */
function subjectHit(view: string, span: SubjectSpan, field: string, matchedAs: string): ReplayFindSubjectHit {
  const dataClass = span.entry.dataClass === "raw" ? null : span.entry.dataClass;
  const certainty: ReplayFindSubjectCertainty = span.certainty ?? "exact";
  // A possible match shows the stored copy's country code when it has one (not personal data): "+33" tells the admin it is someone else's.
  // A text hit inside a longer number reads the country code from that number (`+33 4155551234`).
  const storedPhone =
    certainty !== "national_only"
      ? null
      : span.around
        ? parsePhone(view.slice(span.around.start, span.around.end))
        : parsePhone(view.slice(span.start, span.end), span.start > 0 && view[span.start - 1] === "+");
  const storedCallingCode = storedPhone?.explicit ? storedPhone.cc : null;
  const context = (text: string) => scrubEvidenceText(text).replace(/\d/g, "#").replace(/\s+/g, " ");
  const from = Math.max(0, span.start - FIND_SUBJECT_EXCERPT_CONTEXT);
  const to = Math.min(view.length, span.end + FIND_SUBJECT_EXCERPT_CONTEXT);
  const value = view.slice(span.start, span.end);
  // A phone keeps its brackets in the excerpt, as written: `[(•••) •••-••58]`.
  const shown = dataClass === "phone" ? maskPhoneKeepingBrackets(value) : maskForDataClass(value, dataClass ?? undefined);
  const excerpt = `${from > 0 ? "…" : ""}${context(view.slice(from, span.start))}[${shown}]${context(view.slice(span.end, to))}${to < view.length ? "…" : ""}`;
  return { field, matchedAs, dataClass, excerpt, certainty, ...(certainty === "national_only" ? { storedCallingCode } : {}) };
}

/** A phone as the guard mask shows it (the last two digits), with its brackets, `+` and separators kept as written. */
function maskPhoneKeepingBrackets(value: string): string {
  const total = value.replace(/\D/g, "").length;
  let seen = 0;
  let out = "";
  for (const char of value) {
    if (/\d/.test(char)) {
      seen += 1;
      out += seen > total - 2 ? char : "•";
    } else {
      out += char;
    }
  }
  return out;
}

/** Plain names of the classes a lookup hint can ask for, for messages. */
const FIND_SUBJECT_CLASS_NAMES: Record<string, string> = {
  email: "an email address",
  phone: "a phone number",
  card_number: "a card number",
  us_ssn: "a US Social Security number",
  iban: "an IBAN",
  national_id: "a national ID number"
};

/** A value typed as a phone: 7 to 15 digits, written only with digits, separators and a leading `+`. */
function phoneShaped(value: string): boolean {
  if (!/^\+?[\d\s().-]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, "").length;
  return digits >= 7 && digits <= 15;
}

/** Whether the capture scan reads all of `value` as `dataClass` (an IBAN or NI number also in upper case). */
function wholeFindingOf(value: string, dataClass: string): boolean {
  const upper = value.toUpperCase();
  for (const text of upper !== value ? [value, upper] : [value]) {
    if (scanForCapture(text).some((match) => String(match.dataClass) === dataClass && match.span.start === 0 && match.span.end === text.length)) return true;
  }
  return false;
}

/**
 * The digits a capture keys a copy of this number on when the copy is
 * written without its `+` (masking keys such a copy on its own digits): the
 * full number, and the number behind each of the country's trunk prefixes.
 * Only for a number with a country code; the main surrogate covers the rest.
 */
function plainMaskKeys(text: string): string[] {
  const phone = parsePhone(text);
  if (!phone?.cc) return [];
  const keys = new Set<string>();
  const written = [phone.cc + phone.national, phone.national, ...trunkPrefixesFor(phone.cc).map((trunk) => trunk + phone.national)];
  if (trunkPrefixesFor(phone.cc).length > 0) written.push(`${phone.cc}0${phone.national}`);
  for (const digits of written) {
    const key = parsePhone(digits)?.national;
    if (key && key !== phone.national) keys.add(key);
  }
  return [...keys];
}

/** Rows read per page by the data-subject lookup (each golden run can be several megabytes). */
const FIND_SUBJECT_PAGE = 20;

/** What the data-subject lookup searches (and can delete from). */
export const FIND_SUBJECT_COVERED = [
  "Golden runs and captured runs (replay_recordings): input, node outputs, run facts, MCP cassette, model tape, memory seed, workflow snapshot, notes",
  "Golden-set cases (eval_fixtures): input and expected output, including hand-written cases and copied inputs",
  "Replay, replay-job, gate and eval results (eval_results): output, error and diff",
  `Runs made from golden runs and cases (execution_history with trigger ${SUBJECT_EXECUTION_TRIGGERS.join(", ")}): input, output, node results, custom data, error; deleting one also deletes its tool-call, guard-event and usage rows`,
  `MCP cassettes recorded by those runs (mcp_cassettes with source ${SUBJECT_CASSETTE_SOURCES.join(", ")})`
];

/** What it does not search: these follow their own retention settings. */
export const FIND_SUBJECT_NOT_COVERED = [
  "Production execution history, tool-call telemetry and paused runs (EXECUTION_HISTORY_RETENTION_DAYS)",
  "MCP cassettes from Record calls on ordinary runs, and imported cassettes (they follow EXECUTION_HISTORY_RETENTION_DAYS)",
  "Session memory, tool data and session artifacts (their own retention)",
  "Logs, metrics and log-streaming destinations (outside the database)",
  "Audit log (AUDIT_LOG_RETENTION_DAYS; it holds ids and counts, not values)",
  "Guard events of production runs (masked evidence only) and the guard token vault",
  "Usage events of production runs, and eval run summaries (counts and costs)"
];
