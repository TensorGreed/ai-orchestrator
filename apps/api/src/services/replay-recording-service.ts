/**
 * Phase 15.1 — golden runs.
 *
 * Saving an execution as a golden run copies everything a replay needs
 * into `replay_recordings`, so execution-history retention, cassette
 * pruning and saved-version pruning can never take it away: the workflow
 * as it ran (from the run context captured when the run finished, else
 * the workflow as saved now), the trigger input, every node's last result,
 * the normalised run facts and the run's MCP cassette. Phase 15.3: when
 * the run recorded its model calls, the model tape and memory seed stored
 * with its cassette are copied too (into their own columns), so a replay
 * can answer model calls and start from the same session memory.
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
  type ModelMemorySeed,
  type ModelTape,
  type ReplayRecordedNode,
  type ReplayRecordedRun,
  type ReplayRecordingCapabilities,
  type ReplayRecordingDetail,
  type ReplayRecordingSummary,
  type ReplayScrubbedValues,
  type RunFacts,
  stripSecretReferences,
  type GoldenSetFileRecording,
  type Workflow
} from "@ai-orchestrator/shared";
import { parseCassette, scrubForCassette } from "@ai-orchestrator/mcp-sdk";
import type { ReplayRecordingRecord, SqliteStore } from "../db/database.js";
import { SecretScrubber } from "./audit-scrub.js";
import { sanitizeConfig, sha256Hex, workflowForHash } from "./audit-bundle-service.js";
import { buildRunFacts, nodeResultRecords, type PriceTurn } from "./run-facts.js";
import type { SecretService } from "./secret-service.js";

const IN_PROGRESS_STATUSES = new Set(["running", "pending", "queued", "waiting_approval"]);

export class ReplayRecordingError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "in_progress" | "not_allowed" | "duplicate" | "limit" | "too_large" | "invalid"
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
  /** Total bytes every golden run in the deployment may use, cassettes included. */
  maxTotalBytes: number;
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

function jsonBytes(value: unknown): number {
  return byteLength(JSON.stringify(value ?? null) ?? "null");
}

/**
 * Scrubbing replaces secret values and token-shaped strings with a short
 * marker, so it can shrink a run but rarely by much. Before the scrub passes
 * run, a run is refused only if it would still be over a limit after
 * shrinking to half its raw size; the exact sizes are checked again after.
 */
const SCRUB_SHRINK_ALLOWANCE = 2;

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

  /**
   * A node configuration in the form a golden run stores it: sanitised as in
   * the captured workflow (where a node's config sits three levels down) and
   * scrubbed of secret values. A replay compares candidate and recorded
   * configurations in this form, so scrubbing alone never reads as a change.
   * Secret references (`secretRef`, `...SecretId`) are dropped from it.
   */
  storedConfig(config: unknown, scrubber: SecretScrubber = this.scrubber()): unknown {
    // Secret references are left out of the comparison: a golden run that came from a golden-set file carries none.
    const sanitised = JSON.parse(canonicalJson(stripSecretReferences(sanitizeConfig(config ?? {}, 3)))) as unknown;
    return JSON.parse(scrubber.text(JSON.stringify(scrubber.tree(sanitised)) ?? "null")) as unknown;
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

    // Each node's last result, plus every finished result in order when it ran more than once (a loop body).
    const nodes: Record<string, ReplayRecordedNode> = {};
    const finished = new Map<string, ReplayRecordedRun[]>();
    for (const result of nodeResultRecords(history.nodeResults)) {
      const nodeId = result.nodeId as string;
      const run: ReplayRecordedRun = {
        status: typeof result.status === "string" ? result.status : "unknown",
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(typeof result.error === "string" ? { error: result.error } : {})
      };
      nodes[nodeId] = { nodeId, nodeType: typeById.get(nodeId) ?? (typeof result.nodeType === "string" ? result.nodeType : "unknown"), ...run };
      if (run.status === "success" || run.status === "error") finished.set(nodeId, [...(finished.get(nodeId) ?? []), run]);
    }
    for (const [nodeId, runs] of finished) {
      if (runs.length > 1) nodes[nodeId]!.runs = runs;
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

    // Cheap size checks on the raw copy first: the clone, scrub and serialise passes below cost time on the event loop.
    const cassetteRecord = store.getMcpCassetteForExecution(history.id);
    const rawFixed = jsonBytes(facts) + (history.input === undefined || history.input === null ? 0 : jsonBytes(history.input)) + jsonBytes(captured);
    const rawNodes = jsonBytes(nodes);
    const rawCassette = cassetteRecord ? jsonBytes(cassetteRecord.cassette) : 0;
    if (rawFixed / SCRUB_SHRINK_ALLOWANCE > this.options.maxBytes) {
      throw new ReplayRecordingError(this.tooLargeMessage(), "too_large");
    }
    // Node outputs that do not fit are cut, so only an untruncated run counts them in its estimate.
    const estimate = (rawFixed + (rawFixed + rawNodes <= this.options.maxBytes ? rawNodes : 0) + rawCassette) / SCRUB_SHRINK_ALLOWANCE;
    this.checkBudgets(history.workflowId, Math.ceil(estimate), true);

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
        return !after || altered(before.output, after.output) || altered(before.error, after.error) || altered(before.runs, after.runs);
      })
    };
    const workflowJson = this.serialise(scrubber.tree(captured), scrubber);

    const inputJson = scrubbedInput === null ? null : this.serialise(scrubbedInput, scrubber);
    const factsJson = this.serialise(scrubbedFacts, scrubber);
    // Phase 15.3 — the model tape and memory seed travel in the cassette row; the golden run keeps them apart.
    const { models: rawTape, memorySeed: rawSeed, ...mcpOnly } = cassetteRecord?.cassette ?? ({} as Partial<McpCassette>);
    const cassette: McpCassette | null = cassetteRecord ? (scrubber.tree(mcpOnly) as McpCassette) : null;
    const cassetteJson = cassette ? this.serialise(cassette, scrubber) : null;
    // The MCP cassette counts toward REPLAY_RECORDING_MAX_BYTES with the rest: it cannot be cut (a cut cassette
    // answers wrongly), so the node outputs give way to it, and a run whose fixed parts do not fit is refused.
    const fixedBytes = byteLength(factsJson) + (inputJson ? byteLength(inputJson) : 0) + byteLength(workflowJson) + (cassetteJson ? byteLength(cassetteJson) : 0);
    if (fixedBytes > this.options.maxBytes) throw new ReplayRecordingError(this.tooLargeMessage(), "too_large");
    let truncated = false;
    let nodesJson = this.serialise(scrubbedNodes, scrubber);
    if (fixedBytes + byteLength(nodesJson) > this.options.maxBytes) {
      // Cut the largest node outputs first until the recording fits. Sizes are tracked per node, so
      // the whole map is serialised again only once, after the cuts.
      let nodesBytes = byteLength(nodesJson);
      const sized = Object.values(scrubbedNodes)
        .map((node) => ({ node, entryBytes: jsonBytes(node), bytes: jsonBytes(node.output) + (node.runs ? jsonBytes(node.runs) : 0) }))
        .sort((a, b) => b.bytes - a.bytes);
      for (const entry of sized) {
        if (fixedBytes + nodesBytes <= this.options.maxBytes) break;
        if (entry.bytes < 256) break;
        // A cut node keeps no per-iteration results: a replay that reaches it is inconclusive either way.
        delete entry.node.runs;
        entry.node.output = { [REPLAY_TRUNCATED_MARKER]: true, bytes: entry.bytes };
        truncated = true;
        nodesBytes += jsonBytes(entry.node) - entry.entryBytes;
      }
      nodesJson = this.serialise(scrubbedNodes, scrubber);
      if (fixedBytes + byteLength(nodesJson) > this.options.maxBytes) throw new ReplayRecordingError(this.tooLargeMessage(), "too_large");
    }

    let modelTape: ModelTape | null = rawTape ? (scrubber.tree(rawTape) as ModelTape) : null;
    let modelTapeJson = modelTape ? this.serialise(modelTape, scrubber) : null;
    let memorySeed: ModelMemorySeed | null = rawSeed ? (scrubber.tree(rawSeed) as ModelMemorySeed) : null;
    let memorySeedJson = memorySeed ? this.serialise(memorySeed, scrubber) : null;
    // Phase 15.3 — the tape and the seed count toward REPLAY_RECORDING_MAX_BYTES with the node outputs. What does
    // not fit is cut: the tape keeps its first calls (`truncated: true`), then the seed keeps the sessions that fit.
    const left = this.options.maxBytes - fixedBytes - byteLength(nodesJson);
    if (modelTape && modelTapeJson && byteLength(modelTapeJson) > left) {
      const cut = this.cutTape(modelTape, left, scrubber);
      modelTape = cut.tape;
      modelTapeJson = cut.json;
      truncated = true;
    }
    const leftForSeed = left - (modelTapeJson ? byteLength(modelTapeJson) : 0);
    if (memorySeed && memorySeedJson && byteLength(memorySeedJson) > leftForSeed) {
      const cut = this.cutSeed(memorySeed, leftForSeed, scrubber);
      memorySeed = cut.seed;
      memorySeedJson = cut.json;
      truncated = true;
    }
    const bytes =
      fixedBytes +
      byteLength(nodesJson) +
      (modelTapeJson ? byteLength(modelTapeJson) : 0) +
      (memorySeedJson ? byteLength(memorySeedJson) : 0);
    this.checkBudgets(history.workflowId, bytes);

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
      modelTapeJson,
      memorySeedJson,
      capabilities: { mcp: cassette ? "cassette" : "none", models: modelTape ? "tape" : "live", memory: memorySeed ? "seeded" : "empty", workflowSource, scrubbed },
      bytes,
      truncated,
      createdAt: this.now().toISOString(),
      createdBy
    });
  }

  /** The longest prefix of the tape (in call order) that fits in `maxBytes`, marked truncated. */
  private cutTape(tape: ModelTape, maxBytes: number, scrubber: SecretScrubber): { tape: ModelTape; json: string } {
    const entries = [...tape.entries].sort((a, b) => a.seq - b.seq);
    const empty: ModelTape = { ...tape, entries: [], truncated: true, bytes: 0 };
    let used = jsonBytes(empty) + 64;
    const kept: ModelTape["entries"] = [];
    for (const entry of entries) {
      const size = jsonBytes(entry) + 1;
      if (used + size > maxBytes) break;
      used += size;
      kept.push(entry);
    }
    const cut: ModelTape = { ...tape, entries: kept, truncated: true, bytes: jsonBytes(kept) };
    return { tape: cut, json: this.serialise(cut, scrubber) };
  }

  /** The sessions of the seed that fit in `maxBytes`, marked truncated. */
  private cutSeed(seed: ModelMemorySeed, maxBytes: number, scrubber: SecretScrubber): { seed: ModelMemorySeed; json: string } {
    let used = jsonBytes({ sessions: [], truncated: true }) + 8;
    const kept: ModelMemorySeed["sessions"] = [];
    for (const session of seed.sessions) {
      const size = jsonBytes(session) + 1;
      if (used + size > maxBytes) continue;
      used += size;
      kept.push(session);
    }
    const cut: ModelMemorySeed = { sessions: kept, truncated: true };
    return { seed: cut, json: this.serialise(cut, scrubber) };
  }

  /**
   * A golden run in the form a golden-set file carries it: everything scrubbed
   * again with the secrets the deployment holds now, secret references removed.
   */
  toFileRecording(record: ReplayRecordingRecord, scrubber: SecretScrubber = this.scrubber()): GoldenSetFileRecording {
    const nodes = this.scrubValue(record.nodes, scrubber);
    const input = record.input === undefined || record.input === null ? null : this.scrubValue(record.input, scrubber);
    return {
      name: record.name,
      notes: record.notes,
      sourceTriggerType: record.sourceTriggerType,
      sourceStatus: record.sourceStatus,
      workflowHash: record.workflowHash,
      workflowSavedVersion: record.workflowSavedVersion,
      workflow: JSON.parse(this.serialise(scrubber.tree(stripSecretReferences(record.capturedWorkflow)), scrubber)) as Record<string, unknown>,
      input,
      nodes,
      facts: this.scrubFacts(record.facts, scrubber),
      cassette: record.mcpCassette ? (JSON.parse(this.serialise(scrubber.tree(record.mcpCassette), scrubber)) as unknown) : null,
      truncated: record.truncated,
      ...(record.capabilities.scrubbed ? { scrubbed: record.capabilities.scrubbed } : {})
    };
  }

  /**
   * Stores a golden run from a golden-set file for `workflowId`. The file is
   * not trusted: it is scrubbed again with this deployment's secrets, its
   * secret references are dropped, its cassette must be a valid cassette and
   * the size and storage budgets apply as for a run saved here.
   */
  importRecording(
    input: { workflowId: string; projectId: string | null; recording: GoldenSetFileRecording; name: string },
    createdBy: string | null,
    scrubber: SecretScrubber = this.scrubber()
  ): ReplayRecordingSummary {
    const store = this.options.store;
    const file = input.recording;
    if (store.countReplayRecordingsForWorkflow(input.workflowId) >= this.options.maxPerWorkflow) {
      throw new ReplayRecordingError(`This workflow already has ${this.options.maxPerWorkflow} golden runs (REPLAY_RECORDINGS_MAX_PER_WORKFLOW). Delete some before importing more.`, "limit");
    }
    for (const [key, node] of Object.entries(file.nodes)) {
      if (node.nodeId !== key) throw new ReplayRecordingError(`Node ${JSON.stringify(key.slice(0, 80))} is recorded under a different id.`, "invalid");
    }
    let cassette: McpCassette | null = null;
    if (file.cassette !== null && file.cassette !== undefined) {
      try {
        cassette = parseCassette(file.cassette);
      } catch (error) {
        throw new ReplayRecordingError(`The MCP cassette is not valid: ${error instanceof Error ? error.message : String(error)}`, "invalid");
      }
    }
    const nodes = this.scrubValue(file.nodes as Record<string, ReplayRecordedNode>, scrubber);
    const facts = this.scrubFacts(file.facts as RunFacts, scrubber);
    const scrubbedInput = file.input === undefined || file.input === null ? null : this.scrubValue(file.input, scrubber);
    const altered = (before: unknown, after: unknown) => canonicalJson(before ?? null) !== canonicalJson(after ?? null);
    const scrubbed: ReplayScrubbedValues = {
      input: Boolean(file.scrubbed?.input) || (scrubbedInput !== null && altered(file.input, scrubbedInput)),
      output: Boolean(file.scrubbed?.output) || altered((file.facts as RunFacts).output, facts.output),
      nodes: [
        ...new Set([
          ...(file.scrubbed?.nodes ?? []),
          ...Object.keys(nodes).filter((nodeId) => {
            const before = file.nodes[nodeId]!;
            const after = nodes[nodeId];
            return !after || altered(before.output, after.output) || altered(before.error, after.error) || altered(before.runs, after.runs);
          })
        ])
      ]
    };
    const workflowJson = this.serialise(scrubber.tree(stripSecretReferences(file.workflow)), scrubber);
    const inputJson = scrubbedInput === null ? null : this.serialise(scrubbedInput, scrubber);
    const factsJson = this.serialise(facts, scrubber);
    const nodesJson = this.serialise(nodes, scrubber);
    const cassetteJson = cassette ? this.serialise(scrubber.tree(cassette), scrubber) : null;
    const bytes = byteLength(workflowJson) + (inputJson ? byteLength(inputJson) : 0) + byteLength(factsJson) + byteLength(nodesJson) + (cassetteJson ? byteLength(cassetteJson) : 0);
    if (bytes > this.options.maxBytes) throw new ReplayRecordingError(`${this.tooLargeMessage()} The recording is ${bytes} bytes.`, "too_large");
    this.checkBudgets(input.workflowId, bytes);
    return store.saveReplayRecording({
      id: `rec_${randomUUID()}`,
      workflowId: input.workflowId,
      projectId: input.projectId,
      name: input.name,
      notes: file.notes?.trim() ? file.notes.trim() : null,
      sourceExecutionId: null,
      sourceTriggerType: file.sourceTriggerType ?? null,
      sourceStatus: file.sourceStatus,
      workflowHash: file.workflowHash,
      workflowSavedVersion: file.workflowSavedVersion ?? null,
      capturedWorkflowJson: workflowJson,
      inputJson,
      nodeOutputsJson: nodesJson,
      factsJson,
      mcpCassetteJson: cassetteJson,
      capabilities: { mcp: cassette ? "cassette" : "none", models: "live", memory: "empty", workflowSource: "captured", scrubbed },
      bytes,
      truncated: Boolean(file.truncated),
      createdAt: this.now().toISOString(),
      createdBy
    });
  }

  private tooLargeMessage(): string {
    return `The run is too large to save as a golden run (over REPLAY_RECORDING_MAX_BYTES, ${this.options.maxBytes} bytes).`;
  }

  /** Refuses a save of `bytes` that would take the workflow's or the deployment's golden runs over their budget. */
  private checkBudgets(workflowId: string, bytes: number, estimated = false): void {
    const store = this.options.store;
    const size = estimated ? `at least about ${bytes} bytes once scrubbed` : `${bytes} bytes`;
    const used = store.sumReplayRecordingBytesForWorkflow(workflowId);
    if (used + bytes > this.options.maxBytesPerWorkflow) {
      throw new ReplayRecordingError(
        `Saving this run (${size}) would take this workflow's golden runs over REPLAY_RECORDINGS_MAX_BYTES_PER_WORKFLOW (${used} of ${this.options.maxBytesPerWorkflow} bytes used). Delete some before saving more.`,
        "limit"
      );
    }
    const total = store.sumReplayRecordingBytes();
    if (total + bytes > this.options.maxTotalBytes) {
      throw new ReplayRecordingError(
        `Saving this run (${size}) would take the golden runs in this deployment over REPLAY_RECORDINGS_MAX_TOTAL_BYTES (${total} of ${this.options.maxTotalBytes} bytes used). Delete some before saving more.`,
        "limit"
      );
    }
  }

  get(id: string): ReplayRecordingRecord | null {
    return this.options.store.getReplayRecording(id);
  }

  /** What the API returns for one golden run: no captured workflow or raw cassette. */
  static detail(record: ReplayRecordingRecord): ReplayRecordingDetail {
    const { capturedWorkflow: _workflow, mcpCassette, modelTape, memorySeed: _seed, ...rest } = record;
    return {
      ...rest,
      mcpCallCount: mcpCassette?.entries.filter((entry) => entry.method === "tools/call").length ?? 0,
      modelCallCount: modelTape?.entries.length ?? 0
    };
  }

  /** The node types the golden run's workflow had, for the replay plan. */
  static capturedWorkflow(record: ReplayRecordingRecord): Pick<Workflow, "nodes"> {
    return { nodes: (Array.isArray(record.capturedWorkflow.nodes) ? record.capturedWorkflow.nodes : []) as Workflow["nodes"] };
  }
}
