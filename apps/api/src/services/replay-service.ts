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
 */

import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  judgeReplayDiff,
  REPLAY_BLOCKED_LOAD_MARKER,
  type ReplayHealthWarning,
  type ReplayMcpMode,
  type ReplayRunRequest,
  type ReplayRunResponse,
  type McpReplayReport,
  type Workflow
} from "@ai-orchestrator/shared";
import { buildReplayPlan, type ReplayPlan } from "@ai-orchestrator/workflow-engine";
import type { ReplayRecordingRecord, SqliteStore } from "../db/database.js";
import { sha256Hex, workflowForHash } from "./audit-bundle-service.js";
import type { McpCassetteRunPlan, McpCassetteService } from "./mcp-cassette-service.js";
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
  resolveCandidate(recording: ReplayRecordingRecord, request: ReplayRunRequest): { workflow: Workflow; kind: "draft" | "version"; version: number | null } {
    const current = this.options.store.getWorkflow(recording.workflowId);
    if (!current) throw new ReplayRunError("The workflow this golden run belongs to no longer exists.", "not_found");
    if (request.version === undefined) return { workflow: current, kind: "draft", version: null };
    const entry = this.options.store.getWorkflowVersion(recording.workflowId, request.version);
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
        id: recording.workflowId,
        ...(current.projectId !== undefined ? { projectId: current.projectId } : {}),
        ...(current.folderId !== undefined ? { folderId: current.folderId } : {})
      },
      kind: "version",
      version: request.version
    };
  }

  async replay(recording: ReplayRecordingRecord, request: ReplayRunRequest, actor: SafeUser): Promise<ReplayRunResponse> {
    const candidate = this.resolveCandidate(recording, request);
    const workflowHash = sha256Hex(canonicalJson(workflowForHash(candidate.workflow)));
    const mcpMode: ReplayMcpMode = request.mcpMode ?? "strict";
    const scrubber = this.options.recordings.scrubber();
    const plan = buildReplayPlan(candidate.workflow, recording.nodes, {
      recordedWorkflow: ReplayRecordingService.capturedWorkflow(recording),
      normaliseConfig: (config) => this.options.recordings.storedConfig(config, scrubber)
    });
    const mcpPlan = this.options.cassettes.planOfflineReplay(recording.mcpCassette, mcpMode, `${recording.id}:cassette`);
    const executionId = randomUUID();
    const customData = {
      replay: {
        recordingId: recording.id,
        sourceExecutionId: recording.sourceExecutionId,
        candidate: { kind: candidate.kind, version: candidate.version, workflowHash },
        mcpMode,
        startedBy: actor.email
      }
    };

    let result: ReplayExecutionResult;
    let executeError: string | null = null;
    try {
      result = await this.options.execute({ executionId, workflow: candidate.workflow, recording, plan, mcpPlan, customData }, actor);
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

    const health = this.health(recording, plan, result);
    if (executeError) health.push({ kind: "replay_error", nodeId: null, message: `The replay could not run: ${executeError}`, blocking: true });
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
    const diff = diffRunFacts(recording.facts, candidateFacts, {
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
      warnings.push({
        kind: "recording_overrun",
        nodeId: hit.nodeId,
        message: code
          ? `Code node ${hit.nodeId} ran more times than the golden run recorded; code nodes are not executed in replay, so the extra calls cannot be judged.`
          : `Node ${hit.nodeId} (${hit.nodeType}) ran more times than the golden run recorded; the extra calls reused its last recorded answer.`,
        blocking: code
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
