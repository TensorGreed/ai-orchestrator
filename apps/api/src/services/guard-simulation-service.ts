/**
 * Phase 15.6 — guard policy simulation.
 *
 * "What would this profile change have done to recent traffic?" For guard
 * profile P and a simulated profile (the editor's unsaved document, or a
 * saved version):
 *
 *   1. Scope: the workflows the actor can read that use P: their bindings
 *      resolve to P (project enforced or override, workflow override, or
 *      the built-in default applied automatically), a guard node names it,
 *      or (for the built-in profile) a guard node falls back to it. The scan
 *      yields to the event loop between batches.
 *   2. Cases: recent recordings of those workflows, taken round-robin across
 *      workflows (newest first in each) up to N (default 50, capped by
 *      REPLAY_SIMULATION_MAX_CASES), at most REPLAY_JOB_MAX_CASES per
 *      workflow.
 *   3. One replay job per workflow (EvalService.enqueueSimulationJob): the
 *      published version, else the draft. Each case replays its recording
 *      twice, models from its tape and strict MCP: under the current
 *      profiles (P at its latest version) and with P swapped for the
 *      simulated profile. A model or tool call the recording cannot answer is
 *      a strict miss, never a live call. The jobs are never release proof and
 *      yield their worker slots to every other job. Verdicts stay in memory
 *      and `protect` tokens in a vault that lives as long as the simulation.
 *   4. When every job has finished, the cases' comparisons (candidate vs
 *      baseline, checkpoint by checkpoint) are stored on the simulation row.
 *      A job that stopped early makes the simulation `interrupted`: no
 *      partial result is shown as complete.
 *
 * One simulation runs at a time per deployment. Viewers see only the
 * workflows they can read now: the summary, progress and list are computed
 * from those, and nothing is said about the others. The simulated document
 * is never stored; only its hash is. Simulations (and their jobs) are
 * pruned after GUARD_SIMULATION_RETENTION_DAYS.
 */

import { createHash, randomUUID } from "node:crypto";
import { parseGuardProfile, profileHasDestinationRules } from "@ai-orchestrator/guard-sdk";
import {
  DESTINATION_PREVIEW_SIMULATION_PROFILE,
  GUARD_BUILTIN_PROFILE_ID,
  GUARD_DESTINATION_RULES_PROFILE_ID,
  GUARD_EFFECTIVE_PROFILE_REF,
  GUARD_SIMULATION_DEFAULT_CASES,
  summariseGuardSimulation,
  type DataDestinationRow,
  type GuardSimulationCase,
  type GuardSimulationRequest,
  type GuardSimulationView,
  type GuardSimulationWorkflow,
  type Workflow
} from "@ai-orchestrator/shared";
import type { GuardSimulationRecord, SqliteStore } from "../db/database.js";
import type { RunAccess } from "../run-access.js";
import type { SafeUser } from "./auth-service.js";
import type { EvalService } from "./eval-service.js";
import type { GuardProfileSubstitute, GuardService } from "./guard-service.js";
import { simulateCase } from "./guard-simulation-diff.js";
import { GuardSimulationVault } from "./guard-simulation-sink.js";

/** Another simulation is running (one at a time per deployment). */
export class GuardSimulationBusyError extends Error {
  constructor(readonly simulationId: string) {
    super(
      simulationId === "starting"
        ? "Another simulation is starting. Wait a moment, then start yours."
        : `A guard policy simulation is already running (${simulationId}). Wait for it to finish, then start yours.`
    );
    this.name = "GuardSimulationBusyError";
  }
}

export interface GuardSimulationServiceOptions {
  store: SqliteStore;
  guard: GuardService;
  evals: EvalService;
  runAccess: RunAccess;
  /** REPLAY_SIMULATION_MAX_CASES */
  maxCases: number;
  /** REPLAY_JOB_MAX_CASES: the most cases one workflow's job may have. */
  maxCasesPerJob: number;
  /** Removes secrets from text that is stored and shown (case reasons). */
  scrub?: (text: string) => string;
  logger?: { warn: (message: string, fields?: Record<string, unknown>) => void };
  now?: () => Date;
  /** Workflows scanned between yields to the event loop. Default 25. */
  scanBatch?: number;
}

/** What the row's detail column holds. */
interface StoredDetail {
  workflows: Array<GuardSimulationWorkflow & { recordingIds?: string[] }>;
  emptyReason?: string | null;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export class GuardSimulationService {
  /** Simulations this process is waiting on, so a read does not finalize one twice. */
  private readonly pending = new Map<string, Promise<void>>();
  /** A start in progress in this process (the scope scan yields, so two starts could interleave). */
  private starting = false;

  constructor(private readonly options: GuardSimulationServiceOptions) {}

  private now(): string {
    return (this.options.now ? this.options.now() : new Date()).toISOString();
  }

  /**
   * Why `user` may not simulate this profile, with the HTTP status (404 when
   * it does not exist); null when they may. The same rule as saving a
   * version: admins, and builders on a profile that is neither built-in nor
   * enforced on a project.
   */
  editorDenial(user: SafeUser, profileId: string): { status: 403 | 404; error: string } | null {
    const { store } = this.options;
    // Phase 16 — destination previews and the deployment's destination rules are admin-only.
    if (profileId === DESTINATION_PREVIEW_SIMULATION_PROFILE) return user.role === "admin" ? null : { status: 403, error: "Only admins can preview destination changes" };
    if (profileId === GUARD_DESTINATION_RULES_PROFILE_ID && user.role !== "admin" && store.getGuardProfile(profileId)) {
      return { status: 403, error: "The deployment's destination rules apply to every workflow; only an admin can simulate changes to them" };
    }
    const profile = store.getGuardProfile(profileId);
    if (!profile) return { status: 404, error: "Guard profile not found" };
    if (user.role === "admin") return null;
    if (user.role !== "builder") return { status: 403, error: "Only admins and builders can simulate guard profile changes" };
    if (profile.builtIn) return { status: 403, error: "The built-in profile is read-only; only an admin can simulate changes to it. Duplicate it to simulate your own." };
    const enforced = store.listGuardBindingsForProfile(profileId).some((binding) => binding.scope === "project" && binding.mode === "enforced");
    if (enforced) return { status: 403, error: "This guard profile is enforced on a project; only an admin can change or simulate it" };
    return null;
  }

  /**
   * Starts a simulation. Throws GuardValidationError for an invalid document,
   * GuardNotFoundError for a missing profile or version, and
   * GuardSimulationBusyError when one is already running.
   */
  async start(profileId: string, request: GuardSimulationRequest, actor: SafeUser): Promise<GuardSimulationView> {
    const { store, guard } = this.options;
    const substitute = guard.simulationProfile(profileId, request.document !== undefined ? { document: request.document } : { version: request.version! });
    this.assertIdle();
    this.starting = true;
    try {
      const baseVersion = store.getGuardProfile(profileId)?.latestVersion ?? null;
      const limit = Math.min(request.limit ?? GUARD_SIMULATION_DEFAULT_CASES, this.options.maxCases);
      const scope = await this.workflowsUsing(profileId, actor);
      const byWorkflow = this.recentRecordings(scope.map((workflow) => workflow.id), limit);
      // Checked again after the scan: the database is the deployment's one source of truth.
      this.assertIdle(true);
      const id = `gsim_${randomUUID()}`;
      const workflows: StoredDetail["workflows"] = scope
        .filter((workflow) => byWorkflow.has(workflow.id))
        .map((workflow) => ({ workflowId: workflow.id, workflowName: workflow.name, projectId: workflow.projectId ?? null, jobId: null, cases: [], recordingIds: byWorkflow.get(workflow.id)! }));
      const recordings = [...byWorkflow.values()].reduce((sum, ids) => sum + ids.length, 0);
      const emptyReason =
        scope.length === 0
          ? "No workflow you can read uses this profile yet: bind it to a project or workflow, or name it on a guard node."
          : recordings === 0
            ? "None of the workflows that use this profile has a recorded run yet. Save runs as golden runs (or capture production runs) to simulate on them."
            : null;

      store.insertGuardSimulation({
        id,
        profileId,
        sourceKind: substitute.inline ? "inline" : "version",
        sourceVersion: substitute.inline ? null : substitute.version,
        simulatedHash: substitute.hash,
        baseVersion,
        jobIds: [],
        detail: { workflows, emptyReason } as unknown as Record<string, unknown>,
        status: workflows.length === 0 ? "completed" : "running",
        createdAt: this.now(),
        createdBy: actor.email,
        createdByUserId: actor.id,
        ...(workflows.length === 0 ? { finishedAt: this.now() } : {})
      });
      if (workflows.length === 0) return this.view(store.getGuardSimulation(id)!, actor, true);

      // One vault for the whole simulation: tokens it creates stay in memory and go away with it.
      const vault = new GuardSimulationVault(guard.vault);
      const canRun = (current: SafeUser) => this.editorDenial(current, profileId)?.error ?? null;
      // The current-profile side is pinned to the version the simulation started against, so a save mid-simulation never mixes baselines.
      const baseSubstitute = baseVersion !== null ? guard.simulationProfile(profileId, { version: baseVersion }) : null;
      const profileChanged = substitute.hash !== (baseSubstitute ? baseSubstitute.hash : guard.loadProfile(profileId)?.hash);
      const jobIds: string[] = [];
      for (const workflow of workflows) {
        try {
          const published = store.getPublishedVersion(workflow.workflowId);
          const job = this.options.evals.enqueueSimulationJob(
            { simulationId: id, workflowId: workflow.workflowId, recordingIds: workflow.recordingIds!, substitute, baseSubstitute, vault, canRun, profileChanged, ...(published !== null ? { version: published } : {}) },
            actor
          );
          workflow.jobId = job.id;
          jobIds.push(job.id);
        } catch (error) {
          workflow.error = this.scrub(`The replay job could not start: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const allFailed = jobIds.length === 0;
      store.updateGuardSimulation({
        id,
        jobIds,
        detail: { workflows, emptyReason } as unknown as Record<string, unknown>,
        ...(allFailed ? { status: "failed", error: "No replay job could start.", finishedAt: this.now() } : {})
      });
      if (!allFailed) this.track(id, jobIds);
      return this.view(store.getGuardSimulation(id)!, actor, true);
    } finally {
      this.starting = false;
    }
  }

  /**
   * Phase 16 — "Preview impact" on the Destinations tab: what the
   * destination rules in force would do with the admin's unsaved destination
   * rows, on recent recorded traffic of the workflows whose profiles have
   * destination rules. Both sides run the same profiles; the baseline
   * resolves destinations with the stored rows (as they were at the start),
   * the candidate with the unsaved ones (validated, never stored). Admin
   * only; one simulation at a time (shared with profile simulations).
   */
  async startDestinationPreview(rows: { baseline: DataDestinationRow[]; candidate: DataDestinationRow[] }, request: { limit?: number }, actor: SafeUser): Promise<GuardSimulationView> {
    const { store, guard } = this.options;
    this.assertIdle();
    this.starting = true;
    try {
      const limit = Math.min(request.limit ?? GUARD_SIMULATION_DEFAULT_CASES, this.options.maxCases);
      const scope = await this.workflowsWithDestinationRules(actor);
      const byWorkflow = this.recentRecordings(scope.map((workflow) => workflow.id), limit);
      this.assertIdle(true);
      const id = `gsim_${randomUUID()}`;
      const workflows: StoredDetail["workflows"] = scope
        .filter((workflow) => byWorkflow.has(workflow.id))
        .map((workflow) => ({ workflowId: workflow.id, workflowName: workflow.name, projectId: workflow.projectId ?? null, jobId: null, cases: [], recordingIds: byWorkflow.get(workflow.id)! }));
      const recordings = [...byWorkflow.values()].reduce((sum, ids) => sum + ids.length, 0);
      const emptyReason =
        scope.length === 0
          ? "No workflow has destination rules yet: add the starter rule on the Security page, or add rules to a guard profile."
          : recordings === 0
            ? "None of the workflows with destination rules has a recorded run yet. Save runs as golden runs (or capture production runs) to preview on them."
            : null;
      // The unsaved rows' fingerprint stands in for a profile hash; the rows themselves are never stored.
      const hash = createHash("sha256").update(JSON.stringify(rows.candidate.map(({ createdAt: _c, updatedAt: _u, ...row }) => row))).digest("hex");
      store.insertGuardSimulation({
        id,
        profileId: DESTINATION_PREVIEW_SIMULATION_PROFILE,
        sourceKind: "inline",
        sourceVersion: null,
        simulatedHash: hash,
        baseVersion: null,
        jobIds: [],
        detail: { workflows, emptyReason } as unknown as Record<string, unknown>,
        status: workflows.length === 0 ? "completed" : "running",
        createdAt: this.now(),
        createdBy: actor.email,
        createdByUserId: actor.id,
        ...(workflows.length === 0 ? { finishedAt: this.now() } : {})
      });
      if (workflows.length === 0) return this.view(store.getGuardSimulation(id)!, actor, true);

      const vault = new GuardSimulationVault(guard.vault);
      // No profile is swapped: the substitute names no profile a run uses.
      const substitute: GuardProfileSubstitute = {
        profileId: DESTINATION_PREVIEW_SIMULATION_PROFILE,
        version: 0,
        hash,
        name: "Destination preview",
        profile: parseGuardProfile({ id: DESTINATION_PREVIEW_SIMULATION_PROFILE, name: "Destination preview", version: "1" }),
        inline: true
      };
      const canRun = (current: SafeUser) => (current.role === "admin" ? null : "Only admins can preview destination changes");
      const jobIds: string[] = [];
      for (const workflow of workflows) {
        try {
          const published = store.getPublishedVersion(workflow.workflowId);
          const job = this.options.evals.enqueueSimulationJob(
            {
              simulationId: id,
              workflowId: workflow.workflowId,
              recordingIds: workflow.recordingIds!,
              substitute,
              baseSubstitute: null,
              vault,
              canRun,
              profileChanged: true,
              destinationRows: rows,
              ...(published !== null ? { version: published } : {})
            },
            actor
          );
          workflow.jobId = job.id;
          jobIds.push(job.id);
        } catch (error) {
          workflow.error = this.scrub(`The replay job could not start: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const allFailed = jobIds.length === 0;
      store.updateGuardSimulation({
        id,
        jobIds,
        detail: { workflows, emptyReason } as unknown as Record<string, unknown>,
        ...(allFailed ? { status: "failed", error: "No replay job could start.", finishedAt: this.now() } : {})
      });
      if (!allFailed) this.track(id, jobIds);
      return this.view(store.getGuardSimulation(id)!, actor, true);
    } finally {
      this.starting = false;
    }
  }

  /** Workflows `actor` can read whose resolved profiles (or guard nodes' profiles) have destination rules. */
  async workflowsWithDestinationRules(actor: SafeUser): Promise<Workflow[]> {
    const { store, guard, runAccess } = this.options;
    const readable = runAccess.readableWorkflowIds(actor);
    const ids = readable ?? store.listWorkflows().map((workflow) => workflow.id);
    const batch = Math.max(1, this.options.scanBatch ?? 25);
    const named = new Map<string, boolean>();
    const hasRules = (profileId: string) => {
      if (!named.has(profileId)) {
        const loaded = guard.loadProfile(profileId);
        named.set(profileId, Boolean(loaded && profileHasDestinationRules(loaded.profile)));
      }
      return named.get(profileId)!;
    };
    const out: Workflow[] = [];
    for (const [index, workflowId] of ids.entries()) {
      if (index > 0 && index % batch === 0) await yieldToLoop();
      const workflow = store.getWorkflow(workflowId);
      if (!workflow) continue;
      let uses = false;
      try {
        uses = guard.resolveRun({ workflowId: workflow.id, projectId: workflow.projectId ?? null }).stack.some((entry) => profileHasDestinationRules(entry.profile));
      } catch {
        uses = false;
      }
      if (!uses) {
        uses = workflow.nodes.some((node) => {
          if (node.type !== "guard" || node.disabled === true) return false;
          const profileId = (node.config as { profileId?: unknown } | undefined)?.profileId;
          return typeof profileId === "string" && profileId !== "" && hasRules(profileId);
        });
      }
      if (uses) out.push(workflow);
    }
    return out;
  }

  /** Throws GuardSimulationBusyError when a simulation is starting in this process or running anywhere. */
  private assertIdle(ignoreStarting = false): void {
    // A row whose jobs are gone (no recovery ran) is finished first, so it never blocks every start.
    for (const record of this.options.store.listRunningGuardSimulations()) {
      const settled = this.settle(record);
      if (settled?.status === "running") throw new GuardSimulationBusyError(settled.id);
    }
    if (this.starting && !ignoreStarting) throw new GuardSimulationBusyError("starting");
  }

  /** One simulation as `viewer` sees it, or null when it does not exist. Finishes one whose jobs are done. */
  get(id: string, viewer: SafeUser, detail = true): GuardSimulationView | null {
    const record = this.settle(this.options.store.getGuardSimulation(id));
    return record ? this.view(record, viewer, detail) : null;
  }

  /**
   * The profile's recent simulations `viewer` may see: their own, and others'
   * that include a workflow they can read (filtered before the limit).
   */
  list(profileId: string, viewer: SafeUser, limit = 20): GuardSimulationView[] {
    const wanted = Math.max(1, Math.min(100, Math.floor(limit)));
    const readable = this.readable(viewer);
    const out: GuardSimulationView[] = [];
    // Visibility is decided before the limit: page through the profile's simulations until `wanted` are visible or they run out.
    for (let offset = 0; out.length < wanted; offset += 100) {
      const page = this.options.store.listGuardSimulations({ profileId, limit: 100, offset });
      for (const record of page) {
        if (!this.visibleTo(record, viewer, readable)) continue;
        out.push(this.view(this.settle(record)!, viewer, false));
        if (out.length >= wanted) break;
      }
      if (page.length < 100) break;
    }
    return out;
  }

  /** Whether `viewer` may see this simulation at all (their own, or one with a workflow they can read). */
  visibleTo(record: GuardSimulationRecord, viewer: SafeUser, readable = this.readable(viewer)): boolean {
    if (readable === null || record.createdByUserId === viewer.id) return true;
    const detail = (record.detail ?? { workflows: [] }) as unknown as StoredDetail;
    return detail.workflows.some((workflow) => readable.has(workflow.workflowId));
  }

  /** Whether `viewer` may cancel this simulation: admins, and whoever started it. */
  mayCancel(record: GuardSimulationRecord, viewer: SafeUser): boolean {
    return viewer.role === "admin" || record.createdByUserId === viewer.id;
  }

  /**
   * Cancels a running simulation: its replay jobs are canceled (running
   * replays aborted) and it is marked `canceled`, with no result. A finished
   * one is returned unchanged. Ordinary replay and gate jobs take priority
   * over a simulation's cases, so a simulation behind them may wait; canceling
   * frees the deployment for the next one.
   */
  cancel(id: string, viewer: SafeUser): GuardSimulationView | null {
    const { store, evals } = this.options;
    const record = this.settle(store.getGuardSimulation(id));
    if (!record) return null;
    if (record.status === "running") {
      for (const jobId of record.jobIds) evals.cancel(jobId);
      store.updateGuardSimulation({ id, status: "canceled", error: null, finishedAt: this.now(), onlyFrom: ["running"] });
    }
    return this.view(store.getGuardSimulation(id)!, viewer, true);
  }

  /** Waits until a simulation this process started has finished (tests, `?wait`). */
  async wait(id: string): Promise<void> {
    await this.pending.get(id);
  }

  /**
   * After a restart: simulations left running whose jobs no longer run
   * anywhere are finished, `interrupted` when a job stopped early. Jobs
   * another instance still runs (a shared database) are left alone.
   */
  recover(): number {
    let count = 0;
    for (const record of this.options.store.listRunningGuardSimulations()) {
      if (this.pending.has(record.id) || this.jobsStillRunning(record)) continue;
      this.finalize(record.id);
      count += 1;
    }
    return count;
  }

  prune(before: string): number {
    return this.options.store.pruneGuardSimulations({ before });
  }

  // ---------------------------------------------------------------------------

  private scrub(text: string): string {
    try {
      return this.options.scrub ? this.options.scrub(text) : text;
    } catch {
      return text;
    }
  }

  private readable(viewer: SafeUser): Set<string> | null {
    const ids = this.options.runAccess.readableWorkflowIds(viewer);
    return ids === null ? null : new Set(ids);
  }

  private track(id: string, jobIds: string[]): void {
    const done = Promise.all(jobIds.map((jobId) => this.options.evals.wait(jobId)))
      .then(() => this.finalize(id))
      .catch((error) => {
        this.options.logger?.warn("Guard simulation could not finish", { id, error: error instanceof Error ? error.message : String(error) });
        this.options.store.updateGuardSimulation({ id, status: "failed", error: "The simulation stopped on an internal error.", finishedAt: this.now(), onlyFrom: ["running"] });
      })
      .finally(() => this.pending.delete(id));
    this.pending.set(id, done);
  }

  /** A job of the simulation is still running here, or queued or running in the database (another instance). */
  private jobsStillRunning(record: GuardSimulationRecord): boolean {
    return record.jobIds.some((jobId) => {
      if (this.options.evals.isActive(jobId)) return true;
      const status = this.options.store.getEvalRun(jobId)?.status;
      return status === "queued" || status === "running";
    });
  }

  /** A running simulation whose jobs are no longer running anywhere is finished now. */
  private settle(record: GuardSimulationRecord | null): GuardSimulationRecord | null {
    if (!record || record.status !== "running" || this.pending.has(record.id)) return record;
    if (this.jobsStillRunning(record)) return record;
    this.finalize(record.id);
    return this.options.store.getGuardSimulation(record.id);
  }

  /**
   * Stores every case's comparison of a finished simulation. A job that did
   * not complete makes it `interrupted`, with no summary.
   */
  private finalize(id: string): void {
    const { store } = this.options;
    const record = store.getGuardSimulation(id);
    if (!record || record.status !== "running") return;
    const detail = (record.detail ?? { workflows: [] }) as unknown as StoredDetail;
    const interrupted: string[] = [];
    const workflows: GuardSimulationWorkflow[] = detail.workflows.map((workflow) => {
      const { recordingIds = [], ...rest } = workflow;
      if (!workflow.jobId) return { ...rest, cases: [] };
      const job = store.getEvalRun(workflow.jobId);
      if (!job || job.status !== "completed") interrupted.push(`${workflow.workflowName}: the replay job ${job ? `ended ${job.status}${job.error ? ` (${job.error})` : ""}` : "was deleted"}`);
      const results = job ? store.listEvalResults(job.id) : [];
      const cases: GuardSimulationCase[] = recordingIds.map((recordingId) => {
        const result = results.find((entry) => entry.recordingId === recordingId) ?? null;
        const full = result ? store.getEvalResult(result.runId, result.id) : null;
        const stored = (full?.diff as { simulation?: GuardSimulationCase; truncated?: boolean } | null | undefined) ?? null;
        if (stored?.simulation) return stored.simulation;
        const recording = store.getReplayRecording(recordingId);
        return simulateCase({
          recordingId,
          recording: recording ? { id: recording.id, name: recording.name, createdAt: recording.createdAt } : null,
          baseline: null,
          candidate: null,
          skipped: stored?.truncated
            ? "This run's comparison was too large to keep."
            : full
              ? (full.error ?? "The replay did not run.")
              : "The replay did not run (the simulation stopped first).",
          scrub: (text) => this.scrub(text)
        });
      });
      return { ...rest, cases };
    });
    const stopped = interrupted.length > 0;
    store.updateGuardSimulation({
      id,
      status: stopped ? "interrupted" : "completed",
      detail: { workflows, emptyReason: detail.emptyReason ?? null } as unknown as Record<string, unknown>,
      error: stopped ? this.scrub(`The simulation was interrupted before every run was replayed, so it has no result. Start it again. ${interrupted.join("; ")}`) : null,
      finishedAt: this.now(),
      onlyFrom: ["running"]
    });
  }

  /**
   * Workflows `actor` can read whose guard resolution includes the profile,
   * whose guard nodes name it, or (the built-in profile) whose guard nodes
   * fall back to it. Yields to the event loop between batches.
   */
  async workflowsUsing(profileId: string, actor: SafeUser): Promise<Workflow[]> {
    const { store, guard, runAccess } = this.options;
    const readable = runAccess.readableWorkflowIds(actor);
    const ids = readable ?? store.listWorkflows().map((workflow) => workflow.id);
    const batch = Math.max(1, this.options.scanBatch ?? 25);
    const builtIn = profileId === GUARD_BUILTIN_PROFILE_ID;
    const out: Workflow[] = [];
    for (const [index, workflowId] of ids.entries()) {
      if (index > 0 && index % batch === 0) await yieldToLoop();
      const workflow = store.getWorkflow(workflowId);
      if (!workflow) continue;
      let uses = false;
      let fallsBackToBuiltIn = false;
      try {
        const resolution = guard.resolveRun({ workflowId: workflow.id, projectId: workflow.projectId ?? null });
        uses = resolution.stack.some((entry) => entry.profileId === profileId) || resolution.enforced?.profileId === profileId;
        fallsBackToBuiltIn = resolution.stack.length === 0 && !resolution.enforced;
      } catch {
        uses = false;
      }
      if (!uses) {
        uses = workflow.nodes.some((node) => {
          if (node.type !== "guard" || node.disabled === true) return false;
          const named = (node.config as { profileId?: unknown } | undefined)?.profileId;
          if (named === profileId) return true;
          // A guard node on the effective profile with nothing bound runs the built-in profile.
          return builtIn && fallsBackToBuiltIn && (named === undefined || named === null || named === "" || named === GUARD_EFFECTIVE_PROFILE_REF);
        });
      }
      if (uses) out.push(workflow);
    }
    return out;
  }

  /**
   * Recent recordings of these workflows, newest first in each, taken
   * round-robin across workflows (the workflow with the newest recording
   * first) up to `limit`, at most REPLAY_JOB_MAX_CASES per workflow.
   */
  private recentRecordings(workflowIds: string[], limit: number): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (workflowIds.length === 0 || limit <= 0) return out;
    const perWorkflow = Math.min(limit, this.options.maxCasesPerJob);
    const queues: Array<{ workflowId: string; newest: string; ids: string[] }> = [];
    for (const workflowId of workflowIds) {
      const ids: string[] = [];
      let newest = "";
      while (ids.length < perWorkflow) {
        const page = this.options.store.listReplayRecordings({ workflowId, limit: Math.min(500, perWorkflow - ids.length), offset: ids.length });
        if (ids.length === 0 && page.items[0]) newest = page.items[0].createdAt;
        ids.push(...page.items.map((item) => item.id));
        if (page.items.length === 0 || ids.length >= page.total) break;
      }
      if (ids.length > 0) queues.push({ workflowId, newest, ids });
    }
    queues.sort((a, b) => b.newest.localeCompare(a.newest));
    let taken = 0;
    for (let round = 0; taken < limit; round += 1) {
      let any = false;
      for (const queue of queues) {
        if (taken >= limit) break;
        const id = queue.ids[round];
        if (id === undefined) continue;
        any = true;
        out.set(queue.workflowId, [...(out.get(queue.workflowId) ?? []), id]);
        taken += 1;
      }
      if (!any) break;
    }
    return out;
  }

  private view(record: GuardSimulationRecord, viewer: SafeUser, withDetail: boolean): GuardSimulationView {
    const detail = (record.detail ?? { workflows: [] }) as unknown as StoredDetail;
    const readable = this.readable(viewer);
    const canRead = (workflowId: string) => readable === null || readable.has(workflowId);
    const visible = detail.workflows.filter((workflow) => canRead(workflow.workflowId));
    const visibleJobs = record.jobIds.filter((jobId) => {
      const workflow = detail.workflows.find((entry) => entry.jobId === jobId);
      return workflow ? canRead(workflow.workflowId) : readable === null;
    });
    const status: GuardSimulationView["status"] =
      record.status === "completed" || record.status === "failed" || record.status === "interrupted" || record.status === "canceled" ? record.status : "running";
    let progress: GuardSimulationView["progress"] = null;
    if (status === "running") {
      let done = 0;
      let total = 0;
      for (const jobId of visibleJobs) {
        const job = this.options.store.getEvalRun(jobId);
        const jobProgress = job?.progress as { done?: unknown; total?: unknown } | null | undefined;
        done += typeof jobProgress?.done === "number" ? jobProgress.done : 0;
        total += typeof jobProgress?.total === "number" ? jobProgress.total : 0;
      }
      progress = { done, total };
    }
    return {
      id: record.id,
      profileId: record.profileId,
      source: { kind: record.sourceKind, version: record.sourceVersion, hash: record.simulatedHash },
      baseVersion: record.baseVersion,
      status,
      canCancel: status === "running" && this.mayCancel(record, viewer),
      createdAt: record.createdAt,
      createdBy: record.createdBy,
      finishedAt: record.finishedAt,
      jobIds: visibleJobs,
      summary: status === "completed" ? summariseGuardSimulation(visible) : null,
      progress,
      ...(withDetail ? { workflows: visible.map(({ recordingIds: _ids, ...workflow }) => workflow) } : {}),
      emptyReason: detail.emptyReason ?? null,
      // An interrupted simulation's reason names workflows: only those who can read them all see it.
      error: record.error && (readable === null || visible.length === detail.workflows.length) ? record.error : record.error ? "The simulation did not finish." : null
    };
  }
}
