/**
 * Phase 15.1 — golden runs.
 *
 * Saving an execution as a golden run copies everything a replay needs
 * into `replay_recordings`, so execution-history retention, cassette
 * pruning and saved-version pruning can never take it away: the workflow
 * as it ran (from the run context captured when the run finished, else
 * the workflow as saved now), the trigger input, every node's last result,
 * the normalised run facts and the run's MCP cassette.
 *
 * Secrets: everything is scrubbed before it is stored, twice over. First
 * the cassette scrubber removes credential-named keys and token shapes,
 * then the audit `SecretScrubber` replaces every secret value the
 * deployment holds (secret store and provider keys from the environment)
 * in the value tree and, as a last pass, in the serialised JSON (raw and
 * JSON-escaped forms). Workflow configurations only ever carry
 * `secretRef.secretId`; a replay resolves credentials live through
 * `SecretService`, like any run.
 */

import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  REPLAY_TRUNCATED_MARKER,
  type McpCassette,
  type ReplayRecordedNode,
  type ReplayRecordingCapabilities,
  type ReplayRecordingDetail,
  type ReplayRecordingSummary,
  type ReplayScrubbedValues,
  type RunFacts,
  type Workflow
} from "@ai-orchestrator/shared";
import { scrubForCassette } from "@ai-orchestrator/mcp-sdk";
import type { ReplayRecordingRecord, SqliteStore } from "../db/database.js";
import { SecretScrubber } from "./audit-scrub.js";
import { sha256Hex, workflowForHash } from "./audit-bundle-service.js";
import { buildRunFacts, nodeResultRecords, type PriceTurn } from "./run-facts.js";
import type { SecretService } from "./secret-service.js";

const IN_PROGRESS_STATUSES = new Set(["running", "pending", "queued", "waiting_approval"]);

export class ReplayRecordingError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "in_progress" | "not_allowed" | "duplicate" | "limit" | "too_large"
  ) {
    super(message);
    this.name = "ReplayRecordingError";
  }
}

export interface ReplayRecordingServiceOptions {
  store: SqliteStore;
  secrets: Pick<SecretService, "valuesForScrubbing">;
  /** Credentials L2M reads from its environment (provider API keys and similar). */
  environmentSecretValues?: () => string[];
  /** String redaction for token shapes (the secret service's redactor). */
  redact?: (value: string) => string;
  priceTurn: PriceTurn;
  maxBytes: number;
  maxPerWorkflow: number;
  /** Total bytes one workflow's golden runs may use, cassettes included. */
  maxBytesPerWorkflow: number;
  now?: () => Date;
}

interface CapturedRunContext {
  version: 1;
  workflow: Record<string, unknown>;
  workflowHash: string;
  savedVersion: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export class ReplayRecordingService {
  constructor(private readonly options: ReplayRecordingServiceOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** A scrubber over every secret value the deployment holds (in memory only). */
  scrubber(): SecretScrubber {
    const values: string[] = [];
    try {
      values.push(...this.options.secrets.valuesForScrubbing());
    } catch {
      // The secret store is unreadable: nothing from it can have reached a run.
    }
    try {
      values.push(...(this.options.environmentSecretValues?.() ?? []));
    } catch {
      // No environment values.
    }
    return new SecretScrubber(values);
  }

  /** A value with credential keys, token shapes and every secret value removed. */
  scrubValue<T>(value: T, scrubber: SecretScrubber = this.scrubber()): T {
    if (value === undefined) return value;
    const shaped = scrubForCassette(value, this.options.redact ? { redact: this.options.redact } : {});
    const tree = scrubber.tree(shaped);
    return JSON.parse(scrubber.text(JSON.stringify(tree) ?? "null")) as T;
  }

  /**
   * Run facts scrubbed like a value, with argument hashes taken over the
   * scrubbed arguments. Identifiers (node ids and types, server ids, tool,
   * provider and model names, guard placements) only lose secret values:
   * the token-shape redactor would otherwise blank long registry ids.
   */
  scrubFacts(facts: RunFacts, scrubber: SecretScrubber = this.scrubber()): RunFacts {
    const scrubbed = this.scrubValue(facts, scrubber);
    const id = (value: string) => scrubber.text(value);
    const optionalId = (value: string | null) => (value === null ? null : id(value));
    return {
      ...scrubbed,
      nodes: scrubbed.nodes.map((node, index) => ({ ...node, nodeId: id(facts.nodes[index]!.nodeId), nodeType: id(facts.nodes[index]!.nodeType) })),
      toolCalls: scrubbed.toolCalls.map((call, index) => {
        const original = facts.toolCalls[index]!;
        return { ...call, nodeId: id(original.nodeId), server: id(original.server), tool: id(original.tool), outcome: id(original.outcome), argsHash: sha256Hex(canonicalJson(call.args ?? null)) };
      }),
      modelCalls: scrubbed.modelCalls.map((call, index) => {
        const original = facts.modelCalls[index]!;
        return { ...call, nodeId: id(original.nodeId), providerId: id(original.providerId), model: id(original.model) };
      }),
      guard: scrubbed.guard.map((verdict, index) => {
        const original = facts.guard[index]!;
        return {
          ...verdict,
          nodeId: optionalId(original.nodeId),
          placement: id(original.placement),
          channel: id(original.channel),
          detectorId: optionalId(original.detectorId),
          effectiveAction: id(original.effectiveAction)
        };
      })
    };
  }

  private serialise(value: unknown, scrubber: SecretScrubber): string {
    return scrubber.text(JSON.stringify(value) ?? "null");
  }

  /** Saves a finished execution as a golden run. */
  create(input: { executionId: string; name: string; notes?: string | null }, createdBy: string | null): ReplayRecordingSummary {
    const store = this.options.store;
    const history = store.getExecutionHistory(input.executionId);
    if (!history) throw new ReplayRecordingError("Execution not found", "not_found");
    if (!history.completedAt || IN_PROGRESS_STATUSES.has(history.status)) {
      throw new ReplayRecordingError("The run has not finished; save it as a golden run once it has.", "in_progress");
    }
    if (history.triggerType === "replay") {
      throw new ReplayRecordingError("A replay cannot be saved as a golden run; save the run it replayed instead.", "not_allowed");
    }
    // One golden run per execution: a second copy of the same run adds storage and nothing to compare.
    const existing = store.findReplayRecordingIdForExecution(history.id);
    if (existing) {
      throw new ReplayRecordingError(`This run is already saved as golden run ${existing}. Open that one, or delete it before saving the run again.`, "duplicate");
    }
    if (store.countReplayRecordingsForWorkflow(history.workflowId) >= this.options.maxPerWorkflow) {
      throw new ReplayRecordingError(
        `This workflow already has ${this.options.maxPerWorkflow} golden runs (REPLAY_RECORDINGS_MAX_PER_WORKFLOW). Delete some before saving more.`,
        "limit"
      );
    }

    const current = store.getWorkflow(history.workflowId);
    const context = asRecord(store.getExecutionManifest(history.id)?.runContext) as CapturedRunContext | null;
    let captured: Record<string, unknown>;
    let workflowHash: string;
    let savedVersion: number | null;
    let workflowSource: ReplayRecordingCapabilities["workflowSource"];
    if (context && context.version === 1 && asRecord(context.workflow) && typeof context.workflowHash === "string") {
      captured = context.workflow;
      workflowHash = context.workflowHash;
      savedVersion = typeof context.savedVersion === "number" ? context.savedVersion : null;
      workflowSource = "captured";
    } else if (current) {
      captured = workflowForHash(current);
      workflowHash = sha256Hex(canonicalJson(captured));
      savedVersion = null;
      workflowSource = "current";
    } else {
      throw new ReplayRecordingError("The workflow this run belongs to no longer exists.", "not_found");
    }
    const capturedNodes = (Array.isArray(captured.nodes) ? captured.nodes : [])
      .map(asRecord)
      .filter((node): node is Record<string, unknown> => Boolean(node && typeof node.id === "string" && typeof node.type === "string"))
      .map((node) => ({ id: node.id as string, type: node.type as string, config: node.config }));
    const typeById = new Map(capturedNodes.map((node) => [node.id, node.type]));

    // Each node's last result (a loop body node keeps its last iteration).
    const nodes: Record<string, ReplayRecordedNode> = {};
    for (const result of nodeResultRecords(history.nodeResults)) {
      const nodeId = result.nodeId as string;
      nodes[nodeId] = {
        nodeId,
        nodeType: typeById.get(nodeId) ?? (typeof result.nodeType === "string" ? result.nodeType : "unknown"),
        status: typeof result.status === "string" ? result.status : "unknown",
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(typeof result.error === "string" ? { error: result.error } : {})
      };
    }

    const facts: RunFacts = buildRunFacts({
      status: history.status,
      error: history.error,
      output: history.output,
      durationMs: history.durationMs,
      nodeResults: history.nodeResults,
      nodes: capturedNodes,
      guardEvents: store.listGuardEventsForExecution(history.id),
      priceTurn: this.options.priceTurn
    });

    const scrubber = this.scrubber();
    const scrubbedNodes = this.scrubValue(nodes, scrubber);
    const scrubbedFacts = this.scrubFacts(facts, scrubber);
    const scrubbedInput = history.input === undefined || history.input === null ? null : this.scrubValue(history.input, scrubber);
    // Where scrubbing changed what the replay will feed the candidate (or compare against), so a replay can say so.
    const altered = (before: unknown, after: unknown) => canonicalJson(before ?? null) !== canonicalJson(after ?? null);
    const scrubbed: ReplayScrubbedValues = {
      input: scrubbedInput !== null && altered(history.input, scrubbedInput),
      output: altered(facts.output, scrubbedFacts.output),
      nodes: Object.keys(nodes).filter((nodeId) => {
        const before = nodes[nodeId]!;
        const after = scrubbedNodes[nodeId];
        return !after || altered(before.output, after.output) || altered(before.error, after.error);
      })
    };
    const workflowJson = this.serialise(scrubber.tree(captured), scrubber);

    const inputJson = scrubbedInput === null ? null : this.serialise(scrubbedInput, scrubber);
    const factsJson = this.serialise(scrubbedFacts, scrubber);
    let truncated = false;
    let nodesJson = this.serialise(scrubbedNodes, scrubber);
    const fixedBytes = byteLength(factsJson) + (inputJson ? byteLength(inputJson) : 0) + byteLength(workflowJson);
    if (fixedBytes + byteLength(nodesJson) > this.options.maxBytes) {
      // Cut the largest node outputs first until the recording fits.
      const sized = Object.values(scrubbedNodes)
        .map((node) => ({ node, bytes: byteLength(JSON.stringify(node.output ?? null)) }))
        .sort((a, b) => b.bytes - a.bytes);
      for (const entry of sized) {
        if (fixedBytes + byteLength(nodesJson) <= this.options.maxBytes) break;
        if (entry.bytes < 256) break;
        entry.node.output = { [REPLAY_TRUNCATED_MARKER]: true, bytes: entry.bytes };
        truncated = true;
        nodesJson = this.serialise(scrubbedNodes, scrubber);
      }
      if (fixedBytes + byteLength(nodesJson) > this.options.maxBytes) {
        throw new ReplayRecordingError(`The run is too large to save as a golden run (over REPLAY_RECORDING_MAX_BYTES, ${this.options.maxBytes} bytes).`, "too_large");
      }
    }

    const cassetteRecord = store.getMcpCassetteForExecution(history.id);
    const cassette: McpCassette | null = cassetteRecord ? (scrubber.tree(cassetteRecord.cassette) as McpCassette) : null;
    const cassetteJson = cassette ? this.serialise(cassette, scrubber) : null;
    const bytes = fixedBytes + byteLength(nodesJson) + (cassetteJson ? byteLength(cassetteJson) : 0);
    const used = store.sumReplayRecordingBytesForWorkflow(history.workflowId);
    if (used + bytes > this.options.maxBytesPerWorkflow) {
      throw new ReplayRecordingError(
        `Saving this run (${bytes} bytes) would take this workflow's golden runs over REPLAY_RECORDINGS_MAX_BYTES_PER_WORKFLOW (${used} of ${this.options.maxBytesPerWorkflow} bytes used). Delete some before saving more.`,
        "limit"
      );
    }

    return store.saveReplayRecording({
      id: `rec_${randomUUID()}`,
      workflowId: history.workflowId,
      projectId: current?.projectId ?? (typeof captured.projectId === "string" ? captured.projectId : null),
      name: input.name,
      notes: input.notes?.trim() ? input.notes.trim() : null,
      sourceExecutionId: history.id,
      sourceTriggerType: history.triggerType,
      sourceStatus: history.status,
      workflowHash,
      workflowSavedVersion: savedVersion,
      capturedWorkflowJson: workflowJson,
      inputJson,
      nodeOutputsJson: nodesJson,
      factsJson,
      mcpCassetteJson: cassetteJson,
      capabilities: { mcp: cassette ? "cassette" : "none", models: "live", memory: "empty", workflowSource, scrubbed },
      bytes,
      truncated,
      createdAt: this.now().toISOString(),
      createdBy
    });
  }

  get(id: string): ReplayRecordingRecord | null {
    return this.options.store.getReplayRecording(id);
  }

  /** What the API returns for one golden run: no captured workflow or raw cassette. */
  static detail(record: ReplayRecordingRecord): ReplayRecordingDetail {
    const { capturedWorkflow: _workflow, mcpCassette, ...rest } = record;
    return { ...rest, mcpCallCount: mcpCassette?.entries.filter((entry) => entry.method === "tools/call").length ?? 0 };
  }

  /** The node types the golden run's workflow had, for the replay plan. */
  static capturedWorkflow(record: ReplayRecordingRecord): Pick<Workflow, "nodes"> {
    return { nodes: (Array.isArray(record.capturedWorkflow.nodes) ? record.capturedWorkflow.nodes : []) as Workflow["nodes"] };
  }
}
