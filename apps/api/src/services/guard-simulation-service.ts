/**
 * Phase 15.6 — guard policy simulation.
 *
 * "What would this profile change have done to recent traffic?" For guard
 * profile P and a simulated profile (the editor's unsaved document, or a
 * saved version):
 *
 *   1. Scope: the workflows the actor can read that use P: their bindings
 *      resolve to P (project enforced or override, workflow override, or
 *      the built-in default applied automatically), or a guard node names
 *      it.
 *   2. Cases: the most recent N recordings of those workflows (N defaults
 *      to 50, capped by REPLAY_SIMULATION_MAX_CASES), whatever their state.
 *   3. One replay job per workflow (EvalService.enqueueSimulationJob): the
 *      published version, else the draft; models from each recording's
 *      tape, strict MCP, and P swapped for the simulated profile. A model
 *      or tool call the recording cannot answer is a strict miss, never a
 *      live call. The jobs are never release proof.
 *   4. When every job has finished, each case's guard verdicts (the replay
 *      execution's guard events) are compared with the recording's facts,
 *      checkpoint by checkpoint (guard-simulation-diff.ts), and stored on
 *      the simulation row.
 *
 * Viewers see the workflows they can read now: the summary is computed from
 * those, and the others are only counted. The simulated document is never
 * stored; only its hash is. Simulations (and their jobs) are pruned after
 * GUARD_SIMULATION_RETENTION_DAYS.
 */

import { randomUUID } from "node:crypto";
import {
  GUARD_SIMULATION_DEFAULT_CASES,
  summariseGuardSimulation,
  type GuardSimulationCase,
  type GuardSimulationRequest,
  type GuardSimulationView,
  type GuardSimulationWorkflow,
  type RunFactGuardVerdict,
  type Workflow
} from "@ai-orchestrator/shared";
import type { GuardSimulationRecord, SqliteStore } from "../db/database.js";
import type { RunAccess } from "../run-access.js";
import type { SafeUser } from "./auth-service.js";
import type { EvalService } from "./eval-service.js";
import type { GuardService } from "./guard-service.js";
import { simulateCase } from "./guard-simulation-diff.js";

export class GuardSimulationError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid"
  ) {
    super(message);
    this.name = "GuardSimulationError";
  }
}

export interface GuardSimulationServiceOptions {
  store: SqliteStore;
  guard: GuardService;
  evals: EvalService;
  runAccess: RunAccess;
  /** REPLAY_SIMULATION_MAX_CASES */
  maxCases: number;
  /** Removes secrets from text that is stored and shown (case reasons). */
  scrub?: (text: string) => string;
  logger?: { warn: (message: string, fields?: Record<string, unknown>) => void };
  now?: () => Date;
}

/** What the row's detail column holds. */
interface StoredDetail {
  workflows: Array<GuardSimulationWorkflow & { recordingIds?: string[] }>;
  emptyReason?: string | null;
}

export class GuardSimulationService {
  /** Simulations this process is waiting on, so a read does not finalize one twice. */
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly options: GuardSimulationServiceOptions) {}

  private now(): string {
    return (this.options.now ? this.options.now() : new Date()).toISOString();
  }

  /**
   * Starts a simulation. Throws GuardValidationError for an invalid document,
   * GuardNotFoundError for a missing profile or version.
   */
  start(profileId: string, request: GuardSimulationRequest, actor: SafeUser): GuardSimulationView {
    const { store, guard } = this.options;
    const substitute = guard.simulationProfile(profileId, request.document !== undefined ? { document: request.document } : { version: request.version! });
    const baseVersion = store.getGuardProfile(profileId)?.latestVersion ?? null;
    const limit = Math.min(request.limit ?? GUARD_SIMULATION_DEFAULT_CASES, this.options.maxCases);
    const scope = this.workflowsUsing(profileId, actor);
    const recordings = this.recentRecordings(scope.map((workflow) => workflow.id), limit);
    const id = `gsim_${randomUUID()}`;

    const byWorkflow = new Map<string, string[]>();
    for (const recording of recordings) byWorkflow.set(recording.workflowId, [...(byWorkflow.get(recording.workflowId) ?? []), recording.id]);
    const workflows: StoredDetail["workflows"] = scope
      .filter((workflow) => byWorkflow.has(workflow.id))
      .map((workflow) => ({ workflowId: workflow.id, workflowName: workflow.name, projectId: workflow.projectId ?? null, jobId: null, cases: [], recordingIds: byWorkflow.get(workflow.id)! }));
    const emptyReason =
      scope.length === 0
        ? "No workflow you can read uses this profile yet: bind it to a project or workflow, or name it on a guard node."
        : recordings.length === 0
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

    const jobIds: string[] = [];
    for (const workflow of workflows) {
      try {
        const published = store.getPublishedVersion(workflow.workflowId);
        const job = this.options.evals.enqueueSimulationJob(
          { simulationId: id, workflowId: workflow.workflowId, recordingIds: workflow.recordingIds!, substitute, ...(published !== null ? { version: published } : {}) },
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
    if (allFailed) return this.view(store.getGuardSimulation(id)!, actor, true);
    this.track(id, jobIds);
    return this.view(store.getGuardSimulation(id)!, actor, true);
  }

  /** One simulation as `viewer` sees it, or null when it does not exist. Finishes one whose jobs are done. */
  get(id: string, viewer: SafeUser, detail = true): GuardSimulationView | null {
    const record = this.settle(this.options.store.getGuardSimulation(id));
    return record ? this.view(record, viewer, detail) : null;
  }

  list(profileId: string, viewer: SafeUser, limit = 20): GuardSimulationView[] {
    return this.options.store.listGuardSimulations({ profileId, limit }).map((record) => this.view(this.settle(record)!, viewer, false));
  }

  /** Waits until a simulation this process started has finished (tests, `?wait`). */
  async wait(id: string): Promise<void> {
    await this.pending.get(id);
  }

  /** Finishes simulations a stopped server left running (their jobs were interrupted). */
  recover(): number {
    let count = 0;
    for (const record of this.options.store.listRunningGuardSimulations()) {
      if (this.pending.has(record.id)) continue;
      if (record.jobIds.some((jobId) => this.options.evals.isActive(jobId))) continue;
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

  /** A running simulation whose jobs are no longer running anywhere in this process is finished now. */
  private settle(record: GuardSimulationRecord | null): GuardSimulationRecord | null {
    if (!record || record.status !== "running" || this.pending.has(record.id)) return record;
    if (record.jobIds.some((jobId) => this.options.evals.isActive(jobId))) return record;
    const running = record.jobIds.some((jobId) => {
      const status = this.options.store.getEvalRun(jobId)?.status;
      return status === "queued" || status === "running";
    });
    // Jobs another instance may still run (a shared database) are left alone.
    if (running) return record;
    this.finalize(record.id);
    return this.options.store.getGuardSimulation(record.id);
  }

  /** Compares every case of a finished simulation and stores the per-workflow detail. */
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
      if (job && job.status !== "completed") interrupted.push(`${workflow.workflowName}: ${job.error ?? job.status}`);
      const results = job ? store.listEvalResults(job.id) : [];
      const cases: GuardSimulationCase[] = recordingIds.map((recordingId) => {
        const result = results.find((entry) => entry.recordingId === recordingId) ?? null;
        const full = result ? store.getEvalResult(result.runId, result.id) : null;
        const recording = store.getReplayRecording(recordingId);
        const replayed = full?.executionId ? GuardSimulationService.replayedVerdicts(store, full.executionId) : [];
        return simulateCase({
          recordingId,
          recording: recording ? { id: recording.id, name: recording.name, createdAt: recording.createdAt, guard: recording.facts?.guard ?? [] } : null,
          stored: full ? { status: full.status, error: full.error, executionId: full.executionId, diff: full.diff } : null,
          replayed,
          workflowChanged: Boolean(recording && job?.workflowHash && recording.workflowHash !== job.workflowHash),
          scrub: (text) => this.scrub(text)
        });
      });
      return {
        ...rest,
        ...(job && job.status !== "completed" && !rest.error ? { error: this.scrub(`The replay job ended ${job.status}${job.error ? `: ${job.error}` : ""}`) } : {}),
        cases
      };
    });
    store.updateGuardSimulation({
      id,
      status: "completed",
      detail: { workflows, emptyReason: detail.emptyReason ?? null } as unknown as Record<string, unknown>,
      error: interrupted.length > 0 ? this.scrub(`Some replay jobs did not finish: ${interrupted.join("; ")}`) : null,
      finishedAt: this.now(),
      onlyFrom: ["running"]
    });
  }

  /** The replay's guard verdicts in the facts' shape (one row per finding, with its verdict number and data class). */
  static replayedVerdicts(store: SqliteStore, executionId: string): RunFactGuardVerdict[] {
    const index = new Map<string, number>();
    return store.listGuardEventsForExecution(executionId).map((event) => {
      if (!index.has(event.verdictId)) index.set(event.verdictId, index.size);
      return {
        nodeId: event.nodeId,
        placement: event.placement,
        channel: event.channel,
        detectorId: event.detectorId,
        effectiveAction: event.effectiveAction,
        shadow: event.shadow,
        dataClass: event.dataClass ?? null,
        verdict: index.get(event.verdictId)!
      };
    });
  }

  /** Workflows `actor` can read whose guard resolution includes the profile, or whose guard nodes name it. */
  workflowsUsing(profileId: string, actor: SafeUser): Workflow[] {
    const { store, guard, runAccess } = this.options;
    const readable = runAccess.readableWorkflowIds(actor);
    const ids = readable ?? store.listWorkflows().map((workflow) => workflow.id);
    const out: Workflow[] = [];
    for (const workflowId of ids) {
      const workflow = store.getWorkflow(workflowId);
      if (!workflow) continue;
      let uses = false;
      try {
        const resolution = guard.resolveRun({ workflowId: workflow.id, projectId: workflow.projectId ?? null });
        uses = resolution.stack.some((entry) => entry.profileId === profileId) || resolution.enforced?.profileId === profileId;
      } catch {
        uses = false;
      }
      if (!uses) {
        uses = workflow.nodes.some((node) => node.type === "guard" && node.disabled !== true && (node.config as { profileId?: unknown } | undefined)?.profileId === profileId);
      }
      if (uses) out.push(workflow);
    }
    return out;
  }

  /** The newest recordings of these workflows, at most `limit`. */
  private recentRecordings(workflowIds: string[], limit: number): Array<{ id: string; workflowId: string }> {
    if (workflowIds.length === 0 || limit <= 0) return [];
    const out: Array<{ id: string; workflowId: string }> = [];
    while (out.length < limit) {
      const page = this.options.store.listReplayRecordings({ workflowIds, limit: Math.min(500, limit - out.length), offset: out.length });
      out.push(...page.items.map((item) => ({ id: item.id, workflowId: item.workflowId })));
      if (page.items.length === 0 || out.length >= page.total) break;
    }
    return out;
  }

  private view(record: GuardSimulationRecord, viewer: SafeUser, withDetail: boolean): GuardSimulationView {
    const detail = (record.detail ?? { workflows: [] }) as unknown as StoredDetail;
    const readable = this.options.runAccess.readableWorkflowIds(viewer);
    const canRead = (workflowId: string) => readable === null || readable.includes(workflowId);
    const visible = detail.workflows.filter((workflow) => canRead(workflow.workflowId));
    const hidden = detail.workflows.length - visible.length;
    const finished = record.status !== "running";
    let progress: GuardSimulationView["progress"] = null;
    if (!finished) {
      let done = 0;
      let total = 0;
      for (const jobId of record.jobIds) {
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
      status: record.status === "completed" || record.status === "failed" ? record.status : "running",
      createdAt: record.createdAt,
      createdBy: record.createdBy,
      finishedAt: record.finishedAt,
      jobIds: record.jobIds.filter((jobId) => {
        const workflow = detail.workflows.find((entry) => entry.jobId === jobId);
        return !workflow || canRead(workflow.workflowId);
      }),
      summary: finished ? summariseGuardSimulation(visible) : null,
      progress,
      ...(withDetail ? { workflows: visible.map(({ recordingIds: _ids, ...workflow }) => workflow) } : {}),
      hiddenWorkflows: hidden,
      emptyReason: detail.emptyReason ?? null,
      error: record.error
    };
  }
}

