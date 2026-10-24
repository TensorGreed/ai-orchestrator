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
  modelMemorySeedSchema,
  modelTapeSchema,
  type ModelMemorySeed,
  type ModelTape,
  type McpCassetteEntry,
  type ReplayRecordedNode,
  type ReplayRecordedRun,
  type ReplayCaptureInfo,
  type ReplayRecordingCapabilities,
  type ReplayRecordingDetail,
  type ReplayRecordingSummary,
  type ReplayScrubbedValues,
  type RunFacts,
  stripSecretReferences,
  type GoldenSetFileRecording,
  type Workflow
} from "@ai-orchestrator/shared";
import { canonicalJson as cassetteCanonical, hashCassetteArgs, parseCassette, scrubForCassette } from "@ai-orchestrator/mcp-sdk";
import type { ReplayRecordingRecord, SqliteStore } from "../db/database.js";
import { SecretScrubber } from "./audit-scrub.js";
import { runSteps, runStepsAsync } from "@ai-orchestrator/guard-sdk";
import type { ProvenanceLabel } from "@ai-orchestrator/shared";
import { maskCapturedRunSteps, withNodeLabels, type CaptureMaskOptions } from "./capture-masking.js";
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

/** Phase 15.6 — how `create` saves a production capture. */
export interface CaptureOptions {
  /** The run's own recording (MCP cassette with its model tape and memory seed); null when nothing was recorded. */
  cassette: McpCassette | null;
  /** Mask personal data with keyed surrogates; null when the workflow's capture masking is off. */
  mask: CaptureMaskOptions | null;
  rate: number;
  publishedVersion: number | null;
  capturedAt: string;
  /** Where the run's input came from (labels); decided by the server where the run started. */
  inputProvenance: ProvenanceLabel;
  /** Called once the candidate is built and checked, right before it is saved (eviction makes room here). Throw to drop it. */
  beforeSave?: (bytes: number) => void;
}

/** A golden run from a file, checked and scrubbed, ready to be saved (`ReplayRecordingService.saveImport`). */
export interface PreparedImport {
  row: Omit<Parameters<SqliteStore["saveReplayRecording"]>[0], "createdBy">;
  /** The scrubbed trigger input, for the golden set's fixture. */
  input: unknown;
  /** Recorded nodes left out because the target has no node with the same id and type. */
  droppedNodes: string[];
  /** Model tape entries left out because they belong to a node the target does not have. */
  droppedTapeEntries: number;
}

/**
 * Scrubbing replaces secret values and token-shaped strings with a short
 * marker, so it can shrink a run but rarely by much. Before the scrub passes
 * run, a run is refused only if it would still be over a limit after
 * shrinking to half its raw size; the exact sizes are checked again after.
 */
const SCRUB_SHRINK_ALLOWANCE = 2;

/** The earliest `recordedAt` an imported golden run may claim. */
export const MIN_RECORDED_AT_MS = Date.UTC(2000, 0, 1);

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
   *
   * `imported`: the form an imported golden run stores its workflow in (see
   * `scrubWorkflow`): secret references dropped and the full shape scrub
   * applied. Only imported golden runs are compared this way: a file carries
   * no secret references, so the candidate's are left out too. For a run
   * recorded here a changed credential reference still counts as a change.
   */
  storedConfig(config: unknown, scrubber: SecretScrubber = this.scrubber(), options: { imported?: boolean } = {}): unknown {
    if (options.imported) {
      return this.scrubValue(JSON.parse(canonicalJson(stripSecretReferences(sanitizeConfig(config ?? {}, 3)))) as unknown, scrubber);
    }
    const sanitised = JSON.parse(canonicalJson(sanitizeConfig(config ?? {}, 3))) as unknown;
    return JSON.parse(scrubber.text(JSON.stringify(scrubber.tree(sanitised)) ?? "null")) as unknown;
  }

  private serialise(value: unknown, scrubber: SecretScrubber): string {
    return scrubber.text(JSON.stringify(value) ?? "null");
  }

  /**
   * Saves a finished execution as a golden run. Phase 15.6: with `capture`,
   * it is saved as a *candidate* (a production capture): the cassette comes
   * from the run's own recorder instead of the cassette table (a capture never
   * stores an unmasked cassette there), the golden-run limits do not apply
   * (candidates have their own cap, enforced by the caller), and with
   * `capture.mask` every part is masked with keyed surrogates after the
   * secret scrub; tape and cassette match keys are then taken again over the
   * masked content, so a `models: "replay"` replay still finds its answers.
   */
  create(input: { executionId: string; name: string; notes?: string | null }, createdBy: string | null): ReplayRecordingSummary {
    return runSteps(this.build(input, createdBy));
  }

  /**
   * Phase 15.6 — saves a finished production run as a capture candidate (see
   * `create`). Masking runs in chunks, giving the event loop a turn between
   * them, so a large capture never stalls production requests.
   */
  createCapture(input: { executionId: string; name: string }, capture: CaptureOptions): Promise<ReplayRecordingSummary> {
    return runStepsAsync(this.build(input, null, capture));
  }

  private *build(input: { executionId: string; name: string; notes?: string | null }, createdBy: string | null, capture?: CaptureOptions): Generator<void, ReplayRecordingSummary, void> {
    const store = this.options.store;
    const history = store.getExecutionHistory(input.executionId);
    if (!history) throw new ReplayRecordingError("Execution not found", "not_found");
    if (!history.completedAt || IN_PROGRESS_STATUSES.has(history.status)) {
      throw new ReplayRecordingError("The run has not finished; save it as a golden run once it has.", "in_progress");
    }
    if (history.triggerType === "replay") {
      throw new ReplayRecordingError("A replay cannot be saved as a golden run; save the run it replayed instead.", "not_allowed");
    }
    if (!capture) {
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
    } else if (store.findReplayRecordingIdForExecution(history.id, "candidate")) {
      throw new ReplayRecordingError("This run was already captured.", "duplicate");
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
    const cassetteRecord = capture ? (capture.cassette ? { cassette: capture.cassette } : null) : store.getMcpCassetteForExecution(history.id);
    const rawFixed = jsonBytes(facts) + (history.input === undefined || history.input === null ? 0 : jsonBytes(history.input)) + jsonBytes(captured);
    const rawNodes = jsonBytes(nodes);
    const rawCassette = cassetteRecord ? jsonBytes(cassetteRecord.cassette) : 0;
    if (rawFixed / SCRUB_SHRINK_ALLOWANCE > this.options.maxBytes) {
      throw new ReplayRecordingError(this.tooLargeMessage(), "too_large");
    }
    // Node outputs that do not fit are cut, so only an untruncated run counts them in its estimate.
    const estimate = (rawFixed + (rawFixed + rawNodes <= this.options.maxBytes ? rawNodes : 0) + rawCassette) / SCRUB_SHRINK_ALLOWANCE;
    if (!capture) this.checkBudgets(history.workflowId, Math.ceil(estimate), true);

    const scrubber = this.scrubber();
    let scrubbedNodes = this.scrubValue(nodes, scrubber);
    let scrubbedFacts = this.scrubFacts(facts, scrubber);
    let scrubbedInput = history.input === undefined || history.input === null ? null : this.scrubValue(history.input, scrubber);
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

    // Phase 15.3 — the model tape and memory seed travel in the cassette row; the golden run keeps them apart.
    const { models: rawTape, memorySeed: rawSeed, ...mcpOnly } = cassetteRecord?.cassette ?? ({} as Partial<McpCassette>);
    let cassette: McpCassette | null = cassetteRecord ? (scrubber.tree(mcpOnly) as McpCassette) : null;
    let modelTape: ModelTape | null = rawTape ? (scrubber.tree(rawTape) as ModelTape) : null;
    let memorySeed: ModelMemorySeed | null = rawSeed ? (scrubber.tree(rawSeed) as ModelMemorySeed) : null;

    // Phase 15.6 — a capture is masked after the secret scrub, across every part at once.
    let captureInfo: ReplayCaptureInfo | undefined;
    if (capture) {
      const masked = capture.mask
        ? yield* maskCapturedRunSteps(
            { input: scrubbedInput, nodes: scrubbedNodes, facts: scrubbedFacts, cassette, modelTape, memorySeed },
            { ...capture.mask, keepLiteralsFrom: JSON.parse(workflowJson) as unknown }
          )
        : null;
      if (masked) {
        scrubbedInput = (masked.input ?? null) as typeof scrubbedInput;
        scrubbedNodes = masked.nodes;
        scrubbedFacts = masked.facts;
        cassette = masked.cassette;
        modelTape = masked.modelTape;
        memorySeed = masked.memorySeed;
      }
      scrubbedFacts = withNodeLabels(scrubbedFacts, masked?.report ?? null, capture.inputProvenance);
      captureInfo = {
        rate: capture.rate,
        masked: Boolean(masked),
        dataClasses: masked ? Object.keys(masked.report.values).sort() : [],
        values: masked ? { ...masked.report.values } : {},
        notDetectableAfterMasking: masked ? masked.report.notDetectableAfterMasking : [],
        keptFromWorkflow: masked ? masked.report.keptFromWorkflow : 0,
        publishedVersion: capture.publishedVersion
      };
    }

    const inputJson = scrubbedInput === null ? null : this.serialise(scrubbedInput, scrubber);
    const factsJson = this.serialise(scrubbedFacts, scrubber);
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

    let modelTapeJson = modelTape ? this.serialise(modelTape, scrubber) : null;
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
    if (!capture) this.checkBudgets(history.workflowId, bytes);
    capture?.beforeSave?.(bytes);

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
      capabilities: {
        mcp: cassette ? "cassette" : "none",
        models: modelTape ? "tape" : "live",
        memory: memorySeed ? "seeded" : "empty",
        workflowSource,
        scrubbed,
        ...(captureInfo ? { capture: captureInfo } : {})
      },
      bytes,
      truncated,
      createdAt: this.now().toISOString(),
      createdBy: capture ? null : createdBy,
      ...(capture ? { status: "candidate" as const, capturedAt: capture.capturedAt } : {})
    });
  }

  /**
   * Phase 15.6 — a candidate as it becomes golden: every stored part scrubbed
   * again with the secrets the deployment holds now (one may have been added
   * since the capture), then the per-recording size limit, the golden-run
   * count and the storage budgets apply, as for a run saved by hand.
   */
  preparePromotion(record: ReplayRecordingRecord): {
    name: string;
    capturedWorkflowJson: string;
    inputJson: string | null;
    nodeOutputsJson: string;
    factsJson: string;
    mcpCassetteJson: string | null;
    modelTapeJson: string | null;
    memorySeedJson: string | null;
    bytes: number;
    workflowHash: string;
  } {
    const scrubber = this.scrubber();
    const workflowJson = this.serialise(scrubber.tree(record.capturedWorkflow), scrubber);
    const inputJson = record.input === null || record.input === undefined ? null : this.serialise(this.scrubValue(record.input, scrubber), scrubber);
    const nodesJson = this.serialise(this.scrubValue(record.nodes, scrubber), scrubber);
    const factsJson = this.serialise(this.scrubFacts(record.facts, scrubber), scrubber);
    const cassetteJson = record.mcpCassette ? this.serialise(this.scrubCassette(record.mcpCassette, scrubber), scrubber) : null;
    const modelTapeJson = record.modelTape
      ? this.serialise(ReplayRecordingService.keepTapeHashes(record.modelTape, this.scrubValue(record.modelTape, scrubber)), scrubber)
      : null;
    const memorySeedJson = record.memorySeed ? this.serialise(this.scrubValue(record.memorySeed, scrubber), scrubber) : null;
    const bytes =
      byteLength(workflowJson) +
      (inputJson ? byteLength(inputJson) : 0) +
      byteLength(nodesJson) +
      byteLength(factsJson) +
      (cassetteJson ? byteLength(cassetteJson) : 0) +
      (modelTapeJson ? byteLength(modelTapeJson) : 0) +
      (memorySeedJson ? byteLength(memorySeedJson) : 0);
    if (bytes > this.options.maxBytes) throw new ReplayRecordingError(`${this.tooLargeMessage()} The captured run is ${bytes} bytes.`, "too_large");
    if (this.options.store.countReplayRecordingsForWorkflow(record.workflowId) >= this.options.maxPerWorkflow) {
      throw new ReplayRecordingError(
        `This workflow already has ${this.options.maxPerWorkflow} golden runs (REPLAY_RECORDINGS_MAX_PER_WORKFLOW). Delete some before promoting more.`,
        "limit"
      );
    }
    this.checkBudgets(record.workflowId, bytes);
    // The hash binds to the workflow as it ran (the run context's hash), as for a run saved by hand.
    const workflowHash = record.workflowHash;
    return {
      name: record.name,
      capturedWorkflowJson: workflowJson,
      inputJson,
      nodeOutputsJson: nodesJson,
      factsJson,
      mcpCassetteJson: cassetteJson,
      modelTapeJson,
      memorySeedJson,
      bytes,
      workflowHash
    };
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
   * One generic deep scrub for a value of a golden-set file, on import and on
   * export: every string anywhere (no key is exempt, `data` and `blob`
   * included) loses token shapes and this deployment's secret values, and an
   * object key that is itself token-shaped or a secret value is replaced by
   * a stable `[REDACTED_KEY_<n>]` (`keys` keeps the numbering across the
   * whole file). Credential key names and secret references are handled by
   * the per-field passes that follow.
   */
  scrubFileValue<T>(value: T, scrubber: SecretScrubber, keys: Map<string, string> = new Map()): T {
    // Token shapes and secret values only: the secret service's redactor would blank hashes and long identifiers, which the per-field passes keep.
    const text = (input: string): string => scrubber.text(scrubForCassette(input) as string);
    const walk = (node: unknown, depth: number): unknown => {
      if (typeof node === "string") return text(node);
      if (depth > 100) return "[REDACTED]";
      if (Array.isArray(node)) return node.map((entry) => walk(entry, depth + 1));
      if (node && typeof node === "object") {
        const out: Record<string, unknown> = {};
        for (const [name, nested] of Object.entries(node as Record<string, unknown>)) {
          if (nested === undefined) continue;
          let key = name;
          if (text(name) !== name) {
            key = keys.get(name) ?? `[REDACTED_KEY_${keys.size + 1}]`;
            keys.set(name, key);
          }
          out[key] = walk(nested, depth + 1);
        }
        return out;
      }
      return node;
    };
    return walk(value, 0) as T;
  }

  /**
   * A golden run from a golden-set file (one case's `recording`): its claimed
   * workflow hash is checked against the workflow as the file carries it (unless `verifyHash` is false, for a row of this deployment),
   * then the whole recording goes through the generic deep scrub, and the hash
   * is taken again over the scrubbed workflow. Throws `invalid` on a mismatch.
   */
  scrubFileRecording(recording: GoldenSetFileRecording, scrubber: SecretScrubber, keys: Map<string, string>, verifyHash = true): GoldenSetFileRecording {
    const claimedHash = sha256Hex(canonicalJson(recording.workflow));
    if (verifyHash && claimedHash !== recording.workflowHash) {
      throw new ReplayRecordingError(`The workflow hash ${JSON.stringify(recording.workflowHash.slice(0, 80))} does not match the workflow the case carries (${claimedHash.slice(0, 16)}...).`, "invalid");
    }
    const scrubbed = this.scrubFileValue(recording, scrubber, keys);
    if (recording.modelTape !== undefined && recording.modelTape !== null) scrubbed.modelTape = ReplayRecordingService.keepTapeHashes(recording.modelTape, scrubbed.modelTape);
    return { ...scrubbed, workflowHash: sha256Hex(canonicalJson(scrubbed.workflow)) };
  }

  /**
   * A scrubbed model tape gets its request hashes back. A hash is 64 hex
   * characters, which the token-shape scrub blanks; a replay finds a tape
   * entry by it, so a blanked hash would make the whole tape unusable. A
   * hash holds no secret: it is a digest of the request.
   */
  static keepTapeHashes(original: unknown, scrubbed: unknown): unknown {
    const before = asRecord(original)?.entries;
    const after = asRecord(scrubbed)?.entries;
    if (!Array.isArray(before) || !Array.isArray(after)) return scrubbed;
    before.forEach((entry, index) => {
      const hash = asRecord(entry)?.requestHash;
      const target = asRecord(after[index]);
      if (target && typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) target.requestHash = hash;
    });
    return scrubbed;
  }

  /**
   * The full recording-time scrub plus secret-reference stripping, for a
   * value that came from outside (or is about to leave): credential key
   * names, token shapes and the deployment's secret values, and every
   * `secretRef` / `...SecretId` / `credentialId` key.
   */
  private scrubForFile<T>(value: T, scrubber: SecretScrubber): T {
    return this.scrubValue(stripSecretReferences(value), scrubber);
  }

  /**
   * A workflow as a golden-set file or an imported golden run carries it:
   * sanitised like a captured workflow, secret references dropped, then the
   * full scrub. Identifiers (the workflow id, node ids and types, edge ends)
   * only lose secret values: the token-shape redactor would otherwise blank
   * a long id and break the replay plan.
   */
  scrubWorkflow(workflow: Record<string, unknown>, scrubber: SecretScrubber = this.scrubber()): Record<string, unknown> {
    const scrubbed = this.scrubForFile(sanitizeConfig(workflow) as Record<string, unknown>, scrubber);
    const id = (value: unknown) => (typeof value === "string" ? scrubber.text(value) : value);
    if (typeof workflow.id === "string") scrubbed.id = id(workflow.id);
    const restore = (key: "nodes" | "edges", fields: string[]) => {
      const before = Array.isArray(workflow[key]) ? (workflow[key] as unknown[]) : null;
      const after = Array.isArray(scrubbed[key]) ? (scrubbed[key] as unknown[]) : null;
      if (!before || !after) return;
      before.forEach((entry, index) => {
        const original = asRecord(entry);
        const target = asRecord(after[index]);
        if (!original || !target) return;
        for (const field of fields) if (typeof original[field] === "string") target[field] = id(original[field]);
      });
    };
    restore("nodes", ["id", "type"]);
    restore("edges", ["id", "source", "target", "sourceHandle", "targetHandle"]);
    return JSON.parse(canonicalJson(scrubbed)) as Record<string, unknown>;
  }

  /**
   * An MCP cassette with the full scrub applied to all of it (names,
   * arguments, results, errors, server-initiated exchanges and anything else
   * an entry carries); argument hashes are taken again over the scrubbed
   * arguments, as the recorder does. The match fields (format, server keys
   * and ids, methods, snapshot hashes) only lose secret values, so a replay
   * still finds its entries.
   */
  scrubCassette(cassette: McpCassette, scrubber: SecretScrubber = this.scrubber()): McpCassette {
    const scrubbed = this.scrubForFile(cassette, scrubber) as McpCassette;
    const text = (value: unknown) => (typeof value === "string" ? scrubber.text(value) : value);
    const servers = cassette.servers.map((server, index) => {
      const out = { ...(asRecord(scrubbed.servers?.[index]) ?? {}) } as Record<string, unknown>;
      const original = server as unknown as Record<string, unknown>;
      for (const field of ["key", "adapterId", "registryServerId", "snapshotHash"]) {
        if (typeof original[field] === "string") out[field] = text(original[field]);
      }
      return out as unknown as McpCassette["servers"][number];
    });
    const entries = cassette.entries.map((entry, index) => {
      const out = { ...(asRecord(scrubbed.entries?.[index]) ?? {}) } as unknown as McpCassetteEntry;
      out.seq = entry.seq;
      out.method = entry.method;
      out.server = scrubber.text(entry.server);
      if (out.args !== undefined) {
        out.args = cassetteCanonical(out.args);
        out.argsHash = hashCassetteArgs(out.args);
      } else {
        out.argsHash = scrubber.text(entry.argsHash);
      }
      return out;
    });
    return { ...scrubbed, format: cassette.format, version: cassette.version, servers, entries };
  }

  /**
   * A golden run in the form a golden-set file carries it. Every field goes
   * through the full scrub again on the way out (defence in depth: it was
   * scrubbed when it was stored, but the deployment may hold new secrets
   * since), and secret references are removed. `workflowHash` is the hash of
   * the workflow exactly as the file carries it, so an importer can check it.
   */
  toFileRecording(record: ReplayRecordingRecord, scrubber: SecretScrubber = this.scrubber()): GoldenSetFileRecording {
    const nodes = this.scrubForFile(record.nodes, scrubber);
    const input = record.input === undefined || record.input === null ? null : this.scrubForFile(record.input, scrubber);
    const workflow = this.scrubWorkflow(record.capturedWorkflow, scrubber);
    const imported = record.capabilities.origin === "imported";
    return {
      name: record.name,
      notes: record.notes,
      sourceTriggerType: record.sourceTriggerType,
      sourceStatus: record.sourceStatus,
      workflowHash: sha256Hex(canonicalJson(workflow)),
      recordedAt: record.capabilities.recordedAt ?? record.createdAt,
      origin: imported ? "imported" : "recorded",
      ...(imported ? { sourceWorkflowId: record.capabilities.sourceWorkflowId ?? null } : {}),
      workflowSavedVersion: record.workflowSavedVersion,
      workflow,
      input,
      nodes,
      facts: this.scrubFacts(stripSecretReferences(record.facts), scrubber),
      cassette: record.mcpCassette ? this.scrubCassette(record.mcpCassette, scrubber) : null,
      ...(record.modelTape ? { modelTape: ReplayRecordingService.keepTapeHashes(record.modelTape, this.scrubForFile(record.modelTape, scrubber)) } : {}),
      ...(record.memorySeed ? { memorySeed: this.scrubForFile(record.memorySeed, scrubber) } : {}),
      truncated: record.truncated,
      ...(record.capabilities.scrubbed ? { scrubbed: record.capabilities.scrubbed } : {}),
      // A captured run keeps its masked flag and classes, so an importer knows the values are surrogates.
      ...(record.capabilities.capture ? { capture: { masked: record.capabilities.capture.masked, dataClasses: [...record.capabilities.capture.dataClasses] } } : {})
    };
  }

  /**
   * Checks and scrubs one golden run from a golden-set file, without touching
   * the store: the file is not trusted. Its workflow hash must match the
   * workflow it carries, its cassette must be a valid cassette, every field
   * goes through the full recording-time scrub and loses its secret
   * references, and the per-recording size limit applies. `keepNodes`
   * (node id to type) keeps recorded outputs only for nodes whose id and type
   * both match; the ids of the others come back in `droppedNodes`.
   *
   * The result is saved with `saveImport`; the split lets a caller do this
   * expensive part outside a transaction and yield between cases.
   */
  prepareImport(
    input: { workflowId: string; projectId: string | null; recording: GoldenSetFileRecording; name: string; sourceWorkflowId: string; keepNodes?: Map<string, string> },
    scrubber: SecretScrubber = this.scrubber()
  ): PreparedImport {
    const file = input.recording;
    const claimedHash = sha256Hex(canonicalJson(file.workflow));
    if (claimedHash !== file.workflowHash) {
      throw new ReplayRecordingError(`The workflow hash ${JSON.stringify(file.workflowHash.slice(0, 80))} does not match the workflow the case carries (${claimedHash.slice(0, 16)}...).`, "invalid");
    }
    for (const [key, node] of Object.entries(file.nodes)) {
      if (node.nodeId !== key) throw new ReplayRecordingError(`Node ${JSON.stringify(key.slice(0, 80))} is recorded under a different id.`, "invalid");
    }
    let cassette: McpCassette | null = null;
    if (file.cassette !== null && file.cassette !== undefined) {
      try {
        cassette = parseCassette(this.scrubCassette(parseCassette(file.cassette), scrubber));
      } catch (error) {
        throw new ReplayRecordingError(`The MCP cassette is not valid: ${error instanceof Error ? error.message : String(error)}`, "invalid");
      }
    }
    const droppedNodes: string[] = [];
    let recordedNodes = file.nodes as Record<string, ReplayRecordedNode>;
    if (input.keepNodes) {
      recordedNodes = {};
      for (const [nodeId, node] of Object.entries(file.nodes)) {
        if (input.keepNodes.get(nodeId) === node.nodeType) recordedNodes[nodeId] = node as ReplayRecordedNode;
        else droppedNodes.push(nodeId);
      }
    }
    // The model tape and memory seed: validated against their formats, then scrubbed like the rest. A tape entry of a node the target does not have is left out and the tape marked truncated.
    let modelTape: ModelTape | null = null;
    let droppedTapeEntries = 0;
    if (file.modelTape !== undefined && file.modelTape !== null) {
      const parsed = modelTapeSchema.safeParse(file.modelTape);
      if (!parsed.success) throw new ReplayRecordingError(`The model tape is not valid: ${parsed.error.issues[0]?.message ?? "invalid"} (${parsed.error.issues[0]?.path.join(".") ?? ""}).`, "invalid");
      let tape = parsed.data as ModelTape;
      if (input.keepNodes) {
        const kept = tape.entries.filter((entry) => entry.nodeId === null || input.keepNodes!.has(entry.nodeId));
        droppedTapeEntries = tape.entries.length - kept.length;
        if (droppedTapeEntries > 0) tape = { ...tape, entries: kept, truncated: true, bytes: jsonBytes(kept) };
      }
      modelTape = ReplayRecordingService.keepTapeHashes(tape, this.scrubForFile(tape, scrubber)) as ModelTape;
    }
    let memorySeed: ModelMemorySeed | null = null;
    if (file.memorySeed !== undefined && file.memorySeed !== null) {
      const parsed = modelMemorySeedSchema.safeParse(file.memorySeed);
      if (!parsed.success) throw new ReplayRecordingError(`The memory seed is not valid: ${parsed.error.issues[0]?.message ?? "invalid"} (${parsed.error.issues[0]?.path.join(".") ?? ""}).`, "invalid");
      memorySeed = this.scrubForFile(parsed.data as unknown as ModelMemorySeed, scrubber);
    }
    const nodes = this.scrubForFile(recordedNodes, scrubber);
    const facts = this.scrubFacts(stripSecretReferences(file.facts as RunFacts), scrubber);
    const scrubbedInput = file.input === undefined || file.input === null ? null : this.scrubForFile(file.input, scrubber);
    const altered = (before: unknown, after: unknown) => canonicalJson(before ?? null) !== canonicalJson(after ?? null);
    const scrubbed: ReplayScrubbedValues = {
      input: Boolean(file.scrubbed?.input) || (scrubbedInput !== null && altered(file.input, scrubbedInput)),
      output: Boolean(file.scrubbed?.output) || altered((file.facts as RunFacts).output, facts.output),
      nodes: [
        ...new Set([
          ...(file.scrubbed?.nodes ?? []).filter((nodeId) => nodeId in nodes),
          ...Object.keys(nodes).filter((nodeId) => {
            const before = recordedNodes[nodeId]!;
            const after = nodes[nodeId];
            return !after || altered(before.output, after.output) || altered(before.error, after.error) || altered(before.runs, after.runs);
          })
        ])
      ]
    };
    const workflow = this.scrubWorkflow(file.workflow, scrubber);
    const workflowJson = this.serialise(workflow, scrubber);
    const inputJson = scrubbedInput === null ? null : this.serialise(scrubbedInput, scrubber);
    const factsJson = this.serialise(facts, scrubber);
    const nodesJson = this.serialise(nodes, scrubber);
    const cassetteJson = cassette ? this.serialise(cassette, scrubber) : null;
    const modelTapeJson = modelTape ? this.serialise(modelTape, scrubber) : null;
    const memorySeedJson = memorySeed ? this.serialise(memorySeed, scrubber) : null;
    const bytes =
      byteLength(workflowJson) +
      (inputJson ? byteLength(inputJson) : 0) +
      byteLength(factsJson) +
      byteLength(nodesJson) +
      (cassetteJson ? byteLength(cassetteJson) : 0) +
      (modelTapeJson ? byteLength(modelTapeJson) : 0) +
      (memorySeedJson ? byteLength(memorySeedJson) : 0);
    if (bytes > this.options.maxBytes) throw new ReplayRecordingError(`${this.tooLargeMessage()} The recording is ${bytes} bytes.`, "too_large");
    // The claimed recording time, never later than now: an old golden run stays old (accepted decision 3).
    const now = this.now();
    const claimed = Date.parse(file.recordedAt);
    if (!Number.isFinite(claimed) || claimed < MIN_RECORDED_AT_MS) {
      throw new ReplayRecordingError("recordedAt must be a valid ISO timestamp not before 2000-01-01.", "invalid");
    }
    const recordedAt = new Date(Math.min(claimed, now.getTime())).toISOString();
    return {
      row: {
        id: `rec_${randomUUID()}`,
        workflowId: input.workflowId,
        projectId: input.projectId,
        name: input.name,
        notes: file.notes?.trim() ? file.notes.trim() : null,
        sourceExecutionId: null,
        sourceTriggerType: file.sourceTriggerType ?? null,
        sourceStatus: file.sourceStatus,
        // The hash of the workflow as stored here, after the import scrub.
        workflowHash: sha256Hex(canonicalJson(JSON.parse(workflowJson) as unknown)),
        workflowSavedVersion: file.workflowSavedVersion ?? null,
        capturedWorkflowJson: workflowJson,
        inputJson,
        nodeOutputsJson: nodesJson,
        factsJson,
        mcpCassetteJson: cassetteJson,
        modelTapeJson,
        memorySeedJson,
        capabilities: {
          mcp: cassette ? "cassette" : "none",
          models: modelTape ? "tape" : "live",
          memory: memorySeed ? "seeded" : "empty",
          workflowSource: "captured",
          scrubbed,
          origin: "imported",
          recordedAt,
          importedAt: now.toISOString(),
          sourceWorkflowId: input.sourceWorkflowId,
          ...(file.capture
            ? {
                capture: {
                  rate: 0,
                  masked: file.capture.masked,
                  dataClasses: [...new Set(file.capture.dataClasses)].sort(),
                  values: {},
                  notDetectableAfterMasking: [],
                  keptFromWorkflow: 0,
                  publishedVersion: null
                }
              }
            : {})
        },
        bytes,
        truncated: Boolean(file.truncated),
        createdAt: recordedAt
      },
      input: scrubbedInput === null ? null : (JSON.parse(inputJson!) as unknown),
      droppedNodes,
      droppedTapeEntries
    };
  }

  /** Saves a golden run `prepareImport` checked, after the per-workflow count and the storage budgets. */
  saveImport(prepared: PreparedImport, createdBy: string | null): ReplayRecordingSummary {
    const store = this.options.store;
    const { row } = prepared;
    if (store.countReplayRecordingsForWorkflow(row.workflowId) >= this.options.maxPerWorkflow) {
      throw new ReplayRecordingError(`This workflow already has ${this.options.maxPerWorkflow} golden runs (REPLAY_RECORDINGS_MAX_PER_WORKFLOW). Delete some before importing more.`, "limit");
    }
    this.checkBudgets(row.workflowId, row.bytes);
    return store.saveReplayRecording({ ...row, createdBy });
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
