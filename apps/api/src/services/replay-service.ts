/**
 * Phase 15.1 — replaying a golden run against a candidate.
 *
 * The candidate is the workflow as saved now (the draft) or one saved
 * version. It runs on the recorded input with:
 *
 *   - a replay plan (workflow-engine `buildReplayPlan`) that answers every
 *     external read and write, code node, approval, wait and unknown node
 *     type from the recording; their handlers never run. Expressions inside
 *     the nodes that do run are evaluated as in any run;
 *   - MCP calls answered from the golden run's copied cassette, never from a
 *     live server (strict: each recorded call once; lenient: a call made more
 *     often than recorded reuses its last answer; different arguments are
 *     unanswered in both);
 *   - in-memory session memory, tool cache and artifacts, refused
 *     knowledge-base writes, declined elicitations, no error workflow, no
 *     notifications and no SLO metrics (the `replay` trigger type);
 *   - model calls live, guard live under the workflow's bindings.
 *
 * The run is stored like any other (trigger type `replay`), its facts are
 * scrubbed the same way as the golden run's and diffed against them. The
 * verdict is inconclusive (`error`) when the replay fed the candidate
 * something the golden run never produced: a placeholder for a node it never
 * saw, the old output of a code node whose code changed, or a code node's
 * answer for more calls than were recorded.
 *
 * Phase 15.3 — candidates and fair comparison:
 *
 *   - a job's candidate is the draft, a saved version or an inline workflow
 *     file (same workflow id, validated like an import, never saved), plus
 *     overrides: models per node or provider (`applyCandidate`, part of the
 *     candidate hash), a guard profile, per-server MCP modes and read nodes
 *     that run live (reads only; a write is never run live);
 *   - `models: "replay"` answers model calls from the golden run's model
 *     tape (strict: a miss is inconclusive; lenient: a miss calls the live
 *     model and says so). A golden run without a tape is inconclusive at
 *     once, without running anything;
 *   - session memory starts from the golden run's memory seed;
 *   - a baseline rerun replays the golden run's own version under the same
 *     settings, and the candidate is compared with that run instead of the
 *     recording.
 */

import { randomUUID } from "node:crypto";
import {
  applyCandidate,
  canonicalJson,
  judgeReplayDiff,
  liveReadNodeProblems,
  normaliseCandidateOverrides,
  REPLAY_BLOCKED_LOAD_MARKER,
  ReplayCandidateError,
  type ModelMemorySeed,
  type ModelTapeReport,
  type ReplayCandidateOverrides,
  type ReplayHealthWarning,
  type ReplayMcpMode,
  type ReplayModelMode,
  type ReplayRunRequest,
  type ReplayRunResponse,
  type McpReplayReport,
  type RunFacts,
  type Workflow
} from "@ai-orchestrator/shared";
import { buildReplayPlan, importWorkflowFromJson, validateWorkflowGraph, type ReplayPlan } from "@ai-orchestrator/workflow-engine";
import type { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type { ReplayRecordingRecord, SqliteStore } from "../db/database.js";
import { sha256Hex, workflowForHash } from "./audit-bundle-service.js";
import type { McpCassetteRunPlan, McpCassetteService, ModelReplayPlan, OfflineReplayOptions } from "./mcp-cassette-service.js";
import { diffRunFacts } from "./run-diff.js";
import { buildRunFacts, nodeResultRecords, type PriceTurn } from "./run-facts.js";
import { ReplayRecordingService } from "./replay-recording-service.js";
import type { SafeUser } from "./auth-service.js";

export class ReplayRunError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid"
  ) {
    super(message);
    this.name = "ReplayRunError";
  }
}

/** What the API's execution machinery is asked to run, and must run sandboxed. */
export interface ReplayExecutionInput {
  executionId: string;
  workflow: Workflow;
  recording: ReplayRecordingRecord;
  plan: ReplayPlan;
  mcpPlan: McpCassetteRunPlan;
  customData: Record<string, unknown>;
  /** Phase 15.3 — model calls answered from the golden run's tape (`models: "replay"`). */
  modelPlan?: ModelReplayPlan;
  /** Phase 15.3 — session memory the replay starts from. */
  memorySeed?: ModelMemorySeed | null;
  /** Phase 15.3 — the candidate's guard profile. */
  guardProfileOverride?: { profileId: string; version?: number };
}

/** A candidate workflow, resolved once. */
export interface ResolvedCandidate {
  workflow: Workflow;
  kind: "draft" | "version" | "inline";
  version: number | null;
}

/** Phase 15.3 — a replay job's candidate: the workflow after model overrides, its hashes and the other overrides. */
export interface ResolvedJobCandidate extends ResolvedCandidate {
  workflowHash: string;
  baseHash: string;
  overrides: ReplayCandidateOverrides | null;
  name: string;
}

/** Phase 15.3 — how one case replays, on top of the request. */
export interface ReplayCaseOptions {
  candidate?: ResolvedCandidate;
  executionId?: string;
  models?: ReplayModelMode;
  /** The overrides that change how the replay runs (model overrides are already in the candidate). */
  overrides?: Pick<ReplayCandidateOverrides, "guardProfile" | "mcpServers" | "liveReadNodes"> | null;
  /** Compare with this run instead of the recording (a baseline rerun's facts, already scrubbed). */
  baseline?: { facts: RunFacts; executionId: string };
  /** What this execution is in the job: the candidate, or the baseline it is compared with. */
  role?: "candidate" | "baseline";
  repeatIndex?: number;
}

export interface ReplayExecutionResult {
  status: string;
  error?: string | null;
  output?: unknown;
  startedAt: string;
  completedAt?: string;
  nodeResults: unknown;
  mcpReplay?: McpReplayReport;
}

export interface ReplayServiceOptions {
  store: SqliteStore;
  recordings: ReplayRecordingService;
  cassettes: McpCassetteService;
  priceTurn: PriceTurn;
  /** Runs the candidate in the replay sandbox as `actor` (the tool policy subject) and stores the execution. */
  execute: (input: ReplayExecutionInput, actor: SafeUser) => Promise<ReplayExecutionResult>;
  /** Phase 15.3 — the deployment's providers: lenient model replays call them on a tape miss. */
  providerRegistry?: ProviderRegistry;
  /** Phase 15.3 — what `live_read_only` MCP servers need to read from the live server. */
  liveReads?: OfflineReplayOptions["liveReads"];
  /** Phase 15.3 — why a guard profile override cannot run (null when it can). */
  guardProfileProblem?: (override: { profileId: string; version?: number }) => string | null;
}

function durationOf(result: ReplayExecutionResult): number | null {
  if (!result.completedAt) return null;
  const ms = Date.parse(result.completedAt) - Date.parse(result.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export class ReplayService {
  constructor(private readonly options: ReplayServiceOptions) {}

  /**
   * The candidate workflow: the draft, or a saved version of the golden
   * run's workflow. A saved version is a snapshot of the whole workflow,
   * including the project it lived in then; it runs under the workflow's
   * current project and folder, so project variables, guard bindings and
   * budgets are the ones that apply to the workflow now (a moved workflow
   * never replays under its old project).
   */
  resolveCandidate(recording: ReplayRecordingRecord, request: ReplayRunRequest): ResolvedCandidate {
    return this.resolveWorkflowCandidate(recording.workflowId, request);
  }

  /**
   * Phase 15.3 — a replay job's candidate: the draft, a saved version or an
   * inline workflow file, with the model overrides applied. Checks every
   * override: a model override that matches nothing, a live read node that
   * is not a read, a guard profile or version that does not exist.
   */
  resolveJobCandidate(workflowId: string, request: { version?: number; workflow?: Record<string, unknown>; overrides?: ReplayCandidateOverrides }): ResolvedJobCandidate {
    const base: ResolvedCandidate = request.workflow ? this.inlineCandidate(workflowId, request.workflow) : this.resolveWorkflowCandidate(workflowId, request);
    const overrides = normaliseCandidateOverrides(request.overrides) ?? null;
    let workflow: Workflow;
    try {
      workflow = applyCandidate(base.workflow, overrides);
    } catch (error) {
      if (error instanceof ReplayCandidateError) throw new ReplayRunError(error.message, "invalid");
      throw error;
    }
    const problems = liveReadNodeProblems(workflow, overrides?.liveReadNodes ?? []);
    if (problems.length > 0) throw new ReplayRunError(problems.join(" "), "invalid");
    if (overrides?.guardProfile) {
      const problem = this.options.guardProfileProblem?.(overrides.guardProfile);
      if (problem) throw new ReplayRunError(problem, "invalid");
    }
    return {
      ...base,
      workflow,
      workflowHash: ReplayService.candidateHash(workflow),
      baseHash: ReplayService.candidateHash(base.workflow),
      overrides,
      name: workflow.name
    };
  }

  /**
   * An inline candidate: a workflow JSON (or an export file holding one),
   * validated like an import. It must be this workflow's, and it runs in the
   * workflow's current project and folder. It is never saved.
   */
  inlineCandidate(workflowId: string, raw: Record<string, unknown>): ResolvedCandidate {
    const current = this.options.store.getWorkflow(workflowId);
    if (!current) throw new ReplayRunError("The workflow this golden set belongs to no longer exists.", "not_found");
    const inner = raw.workflow && typeof raw.workflow === "object" && !Array.isArray(raw.workflow) && !Array.isArray(raw.nodes) ? (raw.workflow as Record<string, unknown>) : raw;
    let parsed: Workflow;
    try {
      parsed = importWorkflowFromJson(JSON.stringify(inner));
    } catch (error) {
      const issue = error instanceof Error ? error.message.split("\n")[0]!.slice(0, 300) : "invalid JSON";
      throw new ReplayRunError(`The workflow file is not a valid workflow: ${issue}`, "invalid");
    }
    if (parsed.id !== workflowId) {
      throw new ReplayRunError(`The workflow file is for workflow ${String(parsed.id).slice(0, 200)}, not this golden set's workflow (${workflowId}).`, "invalid");
    }
    const validation = validateWorkflowGraph(parsed);
    if (!validation.valid) {
      throw new ReplayRunError(`The workflow file failed validation: ${validation.issues.map((issue) => issue.message).join("; ")}`, "invalid");
    }
    const { projectId: _project, folderId: _folder, ...snapshot } = parsed;
    return {
      workflow: {
        ...snapshot,
        id: workflowId,
        ...(current.projectId !== undefined ? { projectId: current.projectId } : {}),
        ...(current.folderId !== undefined ? { folderId: current.folderId } : {})
      },
      kind: "inline",
      version: null
    };
  }

  /**
   * Phase 15.3 — the golden run's own workflow for a baseline rerun: the
   * saved version it ran, else (no saved version, or pruned since) the
   * workflow captured with it, in the workflow's current project.
   */
  baselineFor(recording: ReplayRecordingRecord): ResolvedCandidate & { source: "version" | "captured" } {
    const current = this.options.store.getWorkflow(recording.workflowId);
    if (!current) throw new ReplayRunError("The workflow this golden run belongs to no longer exists.", "not_found");
    if (recording.workflowSavedVersion !== null) {
      try {
        return { ...this.resolveWorkflowCandidate(recording.workflowId, { version: recording.workflowSavedVersion }), source: "version" };
      } catch (error) {
        if (!(error instanceof ReplayRunError)) throw error;
      }
    }
    const captured = recording.capturedWorkflow as unknown as Workflow;
    if (!captured || !Array.isArray(captured.nodes) || !Array.isArray(captured.edges)) {
      throw new ReplayRunError("The golden run's own workflow could not be read, so there is no baseline to rerun.", "invalid");
    }
    const { projectId: _project, folderId: _folder, ...snapshot } = captured;
    return {
      workflow: {
        ...snapshot,
        id: recording.workflowId,
        name: typeof captured.name === "string" ? captured.name : current.name,
        ...(current.projectId !== undefined ? { projectId: current.projectId } : {}),
        ...(current.folderId !== undefined ? { folderId: current.folderId } : {})
      } as Workflow,
      kind: "version",
      version: recording.workflowSavedVersion,
      source: "captured"
    };
  }

  /** The candidate for a workflow: the draft, or one of its saved versions (see `resolveCandidate`). */
  resolveWorkflowCandidate(workflowId: string, request: { version?: number }): { workflow: Workflow; kind: "draft" | "version"; version: number | null } {
    const current = this.options.store.getWorkflow(workflowId);
    if (!current) throw new ReplayRunError("The workflow this golden run belongs to no longer exists.", "not_found");
    if (request.version === undefined) return { workflow: current, kind: "draft", version: null };
    const entry = this.options.store.getWorkflowVersion(workflowId, request.version);
    if (!entry) throw new ReplayRunError(`Version ${request.version} of this workflow was not found.`, "not_found");
    let parsed: Workflow;
    try {
      parsed = JSON.parse(entry.workflowJson) as Workflow;
    } catch {
      throw new ReplayRunError(`Version ${request.version} could not be read.`, "invalid");
    }
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) throw new ReplayRunError(`Version ${request.version} could not be read.`, "invalid");
    const { projectId: _savedProject, folderId: _savedFolder, ...snapshot } = parsed;
    return {
      workflow: {
        ...snapshot,
        id: workflowId,
        ...(current.projectId !== undefined ? { projectId: current.projectId } : {}),
        ...(current.folderId !== undefined ? { folderId: current.folderId } : {})
      },
      kind: "version",
      version: request.version
    };
  }

  /**
   * The candidate's hash: the same hash the run manifest and golden runs use.
   */
  static candidateHash(workflow: Workflow): string {
    return sha256Hex(canonicalJson(workflowForHash(workflow)));
  }

  /**
   * Replays a golden run. `options.candidate` is a candidate a replay job
   * resolved once for all its cases (so a draft saved mid-job does not
   * change what the job tests); `options.executionId` lets the job cancel
   * the run.
   */
  async replay(recording: ReplayRecordingRecord, request: ReplayRunRequest, actor: SafeUser, options: ReplayCaseOptions = {}): Promise<ReplayRunResponse> {
    const candidate = options.candidate ?? this.resolveCandidate(recording, request);
    const workflowHash = ReplayService.candidateHash(candidate.workflow);
    const mcpMode: ReplayMcpMode = request.mcpMode ?? "strict";
    const models: ReplayModelMode = options.models ?? "live";
    const overrides = options.overrides ?? null;
    const liveReadNodes = overrides?.liveReadNodes ?? [];
    const scrubber = this.options.recordings.scrubber();
    const plan = buildReplayPlan(candidate.workflow, recording.nodes, {
      recordedWorkflow: ReplayRecordingService.capturedWorkflow(recording),
      normaliseConfig: (config) => this.options.recordings.storedConfig(config, scrubber),
      ...(liveReadNodes.length > 0 ? { liveNodes: new Set(liveReadNodes) } : {})
    });
    const mcpPlan = this.options.cassettes.planOfflineReplay(recording.mcpCassette, mcpMode, `${recording.id}:cassette`, {
      ...(overrides?.mcpServers ? { serverModes: overrides.mcpServers } : {}),
      ...(this.options.liveReads ? { liveReads: this.options.liveReads } : {})
    });
    const executionId = options.executionId ?? randomUUID();
    const role = options.role ?? "candidate";
    const customData = {
      replay: {
        recordingId: recording.id,
        sourceExecutionId: recording.sourceExecutionId,
        candidate: { kind: candidate.kind, version: candidate.version, workflowHash },
        mcpMode,
        models,
        role,
        ...(options.repeatIndex !== undefined ? { repeatIndex: options.repeatIndex } : {}),
        ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
        startedBy: actor.email
      }
    };

    // Phase 15.3 — model calls from the tape. Without a tape the case cannot be judged, and nothing runs.
    let modelPlan: ModelReplayPlan | undefined;
    const preflight: ReplayHealthWarning[] = [];
    if (models === "replay") {
      if (!recording.modelTape) {
        preflight.push({
          kind: "no_model_tape",
          nodeId: null,
          message: "This golden run has no model tape (it was saved from a run that did not record its calls), so model calls cannot be replayed. Record a new run with Record calls on, or replay with live models.",
          blocking: true
        });
      } else if (this.options.providerRegistry) {
        modelPlan = this.options.cassettes.planModelReplay(recording.modelTape, mcpMode, this.options.providerRegistry);
      } else {
        preflight.push({ kind: "no_model_tape", nodeId: null, message: "Model replay is not available on this server.", blocking: true });
      }
    }

    let result: ReplayExecutionResult;
    let executeError: string | null = null;
    try {
      if (preflight.some((warning) => warning.blocking)) {
        const at = new Date().toISOString();
        result = { status: "error", error: preflight[0]!.message, startedAt: at, completedAt: at, nodeResults: [] };
      } else {
        result = await this.options.execute(
          {
            executionId,
            workflow: candidate.workflow,
            recording,
            plan,
            mcpPlan,
            customData,
            ...(modelPlan ? { modelPlan } : {}),
            memorySeed: recording.memorySeed,
            ...(overrides?.guardProfile ? { guardProfileOverride: overrides.guardProfile } : {})
          },
          actor
        );
      }
    } catch (error) {
      executeError = error instanceof Error ? error.message : String(error);
      result = {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        nodeResults: []
      };
    }

    const health = [...preflight, ...(preflight.some((warning) => warning.blocking) ? [] : this.health(recording, plan, result))];
    if (executeError) health.push({ kind: "replay_error", nodeId: null, message: `The replay could not run: ${executeError}`, blocking: true });
    if (modelPlan) health.push(...this.modelHealth(modelPlan.player.report()));
    for (const nodeId of liveReadNodes) {
      if (plan.decisions.some((decision) => decision.nodeId === nodeId && decision.action === "live")) {
        health.push({ kind: "live_read", nodeId, message: `Node ${nodeId} read live data instead of the recorded answer; differences can come from data that changed since the golden run.`, blocking: false });
      }
    }
    if (result.mcpReplay?.liveRead) {
      health.push({
        kind: "mcp_live_read",
        nodeId: null,
        message: `${result.mcpReplay.liveRead} read-only MCP call(s) went to the live server (live_read_only); their answers can differ from the golden run's.`,
        blocking: false
      });
    }
    const candidateFacts = this.options.recordings.scrubFacts(
      buildRunFacts({
        status: result.status,
        error: result.error ?? null,
        output: result.output,
        durationMs: durationOf(result),
        nodeResults: result.nodeResults,
        nodes: candidate.workflow.nodes,
        guardEvents: this.options.store.listGuardEventsForExecution(executionId),
        priceTurn: this.options.priceTurn
      })
    );
    const diff = diffRunFacts(options.baseline?.facts ?? recording.facts, candidateFacts, {
      ignorePaths: request.ignorePaths,
      numberTolerance: request.numberTolerance,
      health
    });
    const judged = judgeReplayDiff(diff);
    return {
      recordingId: recording.id,
      executionId,
      candidate: { kind: candidate.kind, version: candidate.version, workflowHash },
      status: result.status,
      diff,
      verdict: judged.verdict,
      reasons: judged.reasons,
      facts: candidateFacts
    };
  }

  /** Phase 15.3 — what the model tape did: a strict miss makes the case inconclusive, a live call is reported. */
  private modelHealth(report: ModelTapeReport): ReplayHealthWarning[] {
    const warnings: ReplayHealthWarning[] = [];
    if (report.unmatched.length > 0) {
      const count = report.unmatched.length;
      warnings.push({
        kind: "model_unmatched",
        nodeId: report.unmatched[0]!.nodeId,
        message: `${count} model call${count === 1 ? "" : "s"} had no recorded answer on the model tape: ${report.unmatched[0]!.reason}`,
        blocking: true
      });
    }
    if (report.live > 0) {
      warnings.push({
        kind: "model_live",
        nodeId: null,
        message: `${report.live} model call${report.live === 1 ? "" : "s"} were not on the model tape and called the live model (lenient).`,
        blocking: false
      });
    }
    return warnings;
  }

  private health(recording: ReplayRecordingRecord, plan: ReplayPlan, result: ReplayExecutionResult): ReplayHealthWarning[] {
    const warnings: ReplayHealthWarning[] = [];
    const seen = new Set<string>();
    for (const hit of plan.hits) {
      if (hit.recorded || hit.stub !== "output" || seen.has(hit.nodeId)) continue;
      seen.add(hit.nodeId);
      // The node is not in the golden run, so it got a placeholder: whatever the output says, the new node was never tested.
      warnings.push({
        kind: "unrecorded_stub",
        nodeId: hit.nodeId,
        message: `Node ${hit.nodeId} (${hit.nodeType}) is not in the golden run, so the replay gave it a placeholder instead of running it and cannot judge it. Save a golden run that goes through this node.`,
        blocking: true
      });
    }
    const overrun = new Set<string>();
    for (const hit of plan.hits) {
      if (!hit.overrun || overrun.has(hit.nodeId)) continue;
      overrun.add(hit.nodeId);
      const code = hit.nodeClass === "code";
      // Calls past the recording are never answered by the real node, so nothing says what they would have done.
      warnings.push({
        kind: "recording_overrun",
        nodeId: hit.nodeId,
        message: code
          ? `Code node ${hit.nodeId} ran more times than the golden run recorded; code nodes are not executed in replay, so the extra calls cannot be judged.`
          : `Node ${hit.nodeId} (${hit.nodeType}) ran more times than the golden run recorded; the extra calls are not executed in replay, so they cannot be judged.`,
        blocking: true
      });
    }
    const changedHits = new Set(plan.hits.filter((hit) => hit.configChanged).map((hit) => hit.nodeId));
    for (const warning of plan.warnings) {
      if (warning.kind === "unknown_node_type") {
        warnings.push({ kind: warning.kind, nodeId: warning.nodeId, message: warning.message, blocking: false });
      } else if (warning.kind === "config_changed" && changedHits.has(warning.nodeId)) {
        // A code node's recorded output says nothing about its new code; a changed write or read is reported, not judged.
        warnings.push({ kind: warning.kind, nodeId: warning.nodeId, message: warning.message, blocking: warning.nodeClass === "code" });
      } else if (warning.kind === "truncated_recording" && plan.hits.some((hit) => hit.nodeId === warning.nodeId)) {
        // The candidate was fed a placeholder instead of the recorded data, so neither pass nor fail would mean anything.
        warnings.push({
          kind: warning.kind,
          nodeId: warning.nodeId,
          message: `${warning.message} The replay fed a placeholder to the nodes after it, so the result cannot be judged; save a smaller run or raise REPLAY_RECORDING_MAX_BYTES.`,
          blocking: true
        });
      }
    }
    // Scrubbing protects secrets but can change what downstream logic reads; say so where the replay used such a value.
    const scrubbed = recording.capabilities.scrubbed;
    if (scrubbed) {
      const scrubbedNodes = new Set(scrubbed.nodes);
      const used = new Set<string>();
      for (const hit of plan.hits) {
        if (hit.recorded && scrubbedNodes.has(hit.nodeId) && !used.has(hit.nodeId)) {
          used.add(hit.nodeId);
          warnings.push({
            kind: "scrubbed_recording",
            nodeId: hit.nodeId,
            message: `The recorded output of node ${hit.nodeId} had values replaced with [REDACTED] when the golden run was saved (secrets, credential-named keys or long token-like strings). Nodes that read them saw the placeholder, which can change their result.`,
            blocking: false
          });
        }
      }
      if (scrubbed.input) {
        warnings.push({
          kind: "scrubbed_recording",
          nodeId: null,
          message: "The golden run's input had values replaced with [REDACTED] when it was saved; the candidate ran on the scrubbed input.",
          blocking: false
        });
      }
      if (scrubbed.output) {
        warnings.push({
          kind: "scrubbed_recording",
          nodeId: null,
          message: "The golden run's output had values replaced with [REDACTED]; the replay's output is scrubbed the same way before they are compared.",
          blocking: false
        });
      }
    }
    const blockedLoads = new Set<string>();
    for (const entry of nodeResultRecords(result.nodeResults)) {
      if (typeof entry.error === "string" && entry.error.includes(REPLAY_BLOCKED_LOAD_MARKER)) blockedLoads.add(entry.nodeId as string);
    }
    for (const nodeId of blockedLoads) {
      warnings.push({
        kind: "blocked_load",
        nodeId,
        message: `Node ${nodeId} tried to load data from a URL or file. Replays never make that call, so the result cannot be judged.`,
        blocking: true
      });
    }
    const report = result.mcpReplay;
    if (report && report.unmatched.length > 0) {
      const count = report.unmatched.length;
      warnings.push({
        kind: "mcp_unmatched",
        nodeId: null,
        message: `${count} MCP call${count === 1 ? "" : "s"} had no recorded answer (${report.unmatched[0]!.reason})`,
        blocking: true
      });
    }
    if (report && report.live > 0) {
      warnings.push({ kind: "replay_error", nodeId: null, message: `${report.live} MCP call(s) reached a live server during the replay.`, blocking: true });
    }
    if (recording.capabilities.mcp === "none" && (report?.matched ?? 0) + (report?.unmatched.length ?? 0) > 0) {
      warnings.push({
        kind: "no_cassette",
        nodeId: null,
        message: "The golden run was saved from a run without recorded MCP calls, so MCP tools cannot be answered. Run with Record MCP calls and save that run instead.",
        blocking: false
      });
    }
    if (result.status === "waiting_approval") {
      warnings.push({ kind: "paused", nodeId: null, message: "The replay paused for a person; replays never wait for approvals.", blocking: true });
    }
    if (result.status === "canceled") {
      warnings.push({ kind: "replay_error", nodeId: null, message: result.error ?? "The replay was stopped before it finished.", blocking: true });
    }
    return warnings;
  }
}
