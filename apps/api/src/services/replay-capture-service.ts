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
 *   2. `finish`, after the run's final history is stored: queued, so it
 *      never delays the run's answer. A run whose status is not in
 *      `onlyStatuses` is dropped (a miss: it does not count against the
 *      day), as is a run that paused for approval.
 *   3. The candidate is built by `ReplayRecordingService.create` (secret
 *      scrub, then surrogate masking when `dlp` is on), the oldest candidate
 *      is evicted when the workflow is at REPLAY_CAPTURES_MAX_PER_WORKFLOW,
 *      and it is stored with `status = 'candidate'`, no author.
 *
 * Any failure while capturing is logged and counted (metric
 * `replay_captures_total{outcome="failed"}`), never thrown into the run.
 *
 * Candidates nobody promotes are deleted after REPLAY_CAPTURE_RETENTION_DAYS.
 */

import { hkdfSync } from "node:crypto";
import {
  DEFAULT_REPLAY_CAPTURE_SETTINGS,
  REPLAY_CAPTURE_DEFAULT_SET_NAME,
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
import { scanDlp, surrogateFor, type GuardDictionary } from "@ai-orchestrator/guard-sdk";
import type { ReplayCaptureSettingsRecord, ReplayRecordingTextRow, SqliteStore } from "../db/database.js";
import type { McpCassetteRunPlan } from "./mcp-cassette-service.js";
import { ReplayRecordingError, type ReplayRecordingService } from "./replay-recording-service.js";

/** HKDF info for the surrogate key: one deployment-stable key derived from the master key. */
export const CAPTURE_SURROGATE_HKDF_INFO = "l2m/capture-surrogate/v1";

export function deriveCaptureSurrogateKey(masterKey: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", masterKey, new Uint8Array(0), CAPTURE_SURROGATE_HKDF_INFO, 32));
}

/** Triggers that are never captured, whatever channel they report. */
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
      return { workflowId: input.workflow.id, rate, publishedVersion: published, settings };
    } catch (error) {
      this.metric("failed");
      this.options.log.warn({ workflowId: input.workflow.id, error: error instanceof Error ? error.message : String(error) }, "Capture sampling failed; the run is not captured");
      return null;
    }
  }

  private release(ticket: CaptureTicket): void {
    const count = (this.inFlight.get(ticket.workflowId) ?? 1) - 1;
    if (count <= 0) this.inFlight.delete(ticket.workflowId);
    else this.inFlight.set(ticket.workflowId, count);
  }

  /** A sampled run that will not be captured after all (it threw, or paused). */
  abandon(ticket: CaptureTicket, outcome = "abandoned"): void {
    this.release(ticket);
    this.metric(outcome);
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

  private capture(ticket: CaptureTicket, input: { executionId: string; workflow: Pick<Workflow, "id" | "name" | "projectId">; plan: McpCassetteRunPlan }): void {
    try {
      const store = this.options.store;
      const history = store.getExecutionHistory(input.executionId);
      if (!history || !history.completedAt || ["running", "pending", "queued", "waiting_approval"].includes(history.status)) {
        this.metric("skipped_unfinished");
        return;
      }
      const statuses = ticket.settings.onlyStatuses as readonly string[];
      if (!statuses.includes(history.status)) {
        this.metric("discarded_status");
        return;
      }
      const capturedAt = this.now().toISOString();
      const mask = ticket.settings.dlp ? { key: this.options.surrogateKey, dictionaries: this.options.dictionariesFor(input.workflow) } : null;
      const name = `Captured ${history.triggerType ?? "run"} ${capturedAt.slice(0, 16).replace("T", " ")}`;
      const summary = this.options.recordings.create({ executionId: input.executionId, name }, null, {
        cassette: ReplayCaptureService.cassetteOf(input.plan),
        mask,
        rate: ticket.rate,
        publishedVersion: ticket.publishedVersion,
        capturedAt,
        beforeSave: () => this.evictFor(ticket.workflowId)
      });
      this.metric("captured");
      this.options.log.info({ workflowId: ticket.workflowId, recordingId: summary.id, bytes: summary.bytes, masked: Boolean(mask) }, "Captured a production run");
    } catch (error) {
      const outcome = error instanceof ReplayRecordingError && error.code === "too_large" ? "skipped_too_large" : "failed";
      this.metric(outcome);
      this.options.log.warn(
        { workflowId: ticket.workflowId, executionId: input.executionId, outcome, error: error instanceof Error ? error.message : String(error) },
        "A production run could not be captured; the run itself is unaffected"
      );
    } finally {
      this.release(ticket);
    }
  }

  /** Makes room for one more candidate: the oldest go first. */
  private evictFor(workflowId: string): void {
    const store = this.options.store;
    const over = store.countReplayRecordingsForWorkflow(workflowId, "candidate") - this.options.deployment.maxPerWorkflow + 1;
    if (over <= 0) return;
    for (const id of store.oldestReplayCaptureIds(workflowId, over)) {
      store.deleteReplayRecording(id);
      this.metric("evicted");
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
      const datasetId = this.targetSet(record.workflowId, record.projectId, input.datasetId, actor.email);
      const prepared = this.options.recordings.preparePromotion(record);
      let fixtureId: string | undefined;
      store.transaction(() => {
        if (!store.promoteReplayCapture(id, { ...prepared, name: input.name ?? prepared.name, createdBy: actor.email })) {
          throw new ReplayCaptureError("The run is no longer waiting in the inbox.", "conflict");
        }
        const promoted = store.getReplayRecording(id)!;
        fixtureId = this.options.datasets.addGoldenRun({ datasetId, recording: promoted })?.id;
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

  /** The classes a looked-up value could have been masked as. */
  plausibleClasses(value: string): string[] {
    const trimmed = value.trim();
    const classes = new Set<string>(scanDlp(trimmed).map((match) => String(match.dataClass)));
    const digits = trimmed.replace(/\D/g, "").length;
    if (/@/.test(trimmed)) classes.add("email");
    if (digits >= 13 && digits <= 19 && /^[\d\s-]+$/.test(trimmed)) classes.add("card_number");
    if (digits >= 9 && digits <= 15 && /^[+\d\s().-]+$/.test(trimmed)) classes.add("phone");
    if (/^\d{3}[- ]?\d{2}[- ]?\d{4}$/.test(trimmed)) classes.add("us_ssn");
    if (/^[A-Z]{2}\d{2}[A-Z0-9\s-]{8,}$/i.test(trimmed)) classes.add("iban");
    if (/^[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]$/i.test(trimmed)) classes.add("national_id");
    for (const name of this.options.dictionaryClasses()) classes.add(name);
    // Secrets are removed outright, so there is nothing keyed to find.
    for (const redacted of ["credential", "private_key", "jwt"]) classes.delete(redacted);
    return [...classes].sort();
  }

  /**
   * Every recording that holds `value`, as its surrogate (a masked capture)
   * or raw (a run saved by hand, or captured with masking off). The value is
   * never stored or logged. With `remove`, those recordings and the
   * golden-set cases made from them are deleted.
   */
  findSubject(value: string, remove: boolean): ReplayFindSubjectResult {
    const trimmed = value.trim();
    const classes = this.plausibleClasses(trimmed);
    const needles: Array<{ label: string; test: (text: string) => boolean }> = [];
    const separators = "[\\s.()\\-]*";
    const flexible = (core: string, flags = "") => {
      const pattern = new RegExp(`(?<![0-9A-Za-z])${Array.from(core).map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(separators)}(?![0-9A-Za-z])`, flags);
      return (text: string) => pattern.test(text);
    };
    const escaped = (text: string) => JSON.stringify(text).slice(1, -1);
    const literal = (needle: string, caseInsensitive = false) => {
      const forms = [...new Set([needle, escaped(needle)])];
      return caseInsensitive
        ? (text: string) => {
            const lower = text.toLowerCase();
            return forms.some((form) => lower.includes(form.toLowerCase()));
          }
        : (text: string) => forms.some((form) => text.includes(form));
    };

    for (const dataClass of classes) {
      const surrogate = surrogateFor(trimmed, dataClass, this.options.surrogateKey);
      if (["card_number", "phone", "us_ssn"].includes(dataClass)) needles.push({ label: dataClass, test: flexible(surrogate.replace(/\D/g, "")) });
      else if (["iban", "national_id"].includes(dataClass) && !surrogate.startsWith("[")) needles.push({ label: dataClass, test: flexible(surrogate.replace(/[^A-Za-z0-9]/g, ""), "i") });
      else needles.push({ label: dataClass, test: literal(surrogate) });
    }
    const rawTests = [literal(trimmed, /@/.test(trimmed))];
    const digitsOnly = trimmed.replace(/\D/g, "");
    if (digitsOnly.length >= 9 && /^[+\d\s().-]+$/.test(trimmed)) rawTests.push(flexible(digitsOnly));
    if (/^[A-Z]{2}\d{2}/i.test(trimmed.replace(/[\s-]/g, ""))) rawTests.push(flexible(trimmed.replace(/[^A-Za-z0-9]/g, ""), "i"));
    needles.push({ label: "raw", test: (text) => rawTests.some((test) => test(text)) });

    const store = this.options.store;
    const matches: ReplayFindSubjectMatch[] = [];
    let searched = 0;
    let after = 0;
    for (;;) {
      const page = store.replayRecordingTextPage(after, 200);
      for (const row of page.rows) {
        searched += 1;
        const match = this.matchRow(row, needles);
        if (match) matches.push(match);
      }
      if (page.lastRowid === null || page.rows.length < 200) break;
      after = page.lastRowid;
    }

    let deleted = 0;
    let casesDeleted = 0;
    if (remove && matches.length > 0) {
      store.transaction(() => {
        for (const match of matches) {
          casesDeleted += store.deleteEvalFixturesForRecording(match.recordingId);
          if (store.deleteReplayRecording(match.recordingId)) deleted += 1;
        }
      });
    }
    return { classesTried: classes, matches, deleted, casesDeleted, searched };
  }

  private matchRow(row: ReplayRecordingTextRow, needles: Array<{ label: string; test: (text: string) => boolean }>): ReplayFindSubjectMatch | null {
    const matchedAs = new Set<string>();
    const fields = new Set<string>();
    for (const [field, text] of Object.entries(row.texts)) {
      if (!text) continue;
      for (const needle of needles) {
        if (needle.test(text)) {
          matchedAs.add(needle.label);
          fields.add(field);
        }
      }
    }
    if (matchedAs.size === 0) return null;
    return { recordingId: row.id, workflowId: row.workflowId, projectId: row.projectId, name: row.name, status: row.status, matchedAs: [...matchedAs].sort(), fields: [...fields].sort() };
  }
}
