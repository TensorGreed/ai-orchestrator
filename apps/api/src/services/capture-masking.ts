/**
 * Phase 15.6 — masking a production capture before it is stored.
 *
 * The recording is split into content parts (trigger input, every node's
 * recorded output and error, the run's output and error, every tool call's
 * arguments, every MCP cassette entry's arguments, result and error, every
 * model-tape entry's request, answer and error, and the memory seed's
 * sessions) and masked at once with `maskRecording` from guard-sdk: a value
 * found anywhere is replaced everywhere by its keyed surrogate. Identifiers
 * and match keys (node ids and types, servers, tools, providers, models,
 * sequence numbers) are not content and stay as they are; the match keys
 * (`argsHash`, `requestHash`) are taken again over the masked content, so a
 * replay of the masked input meets the masked tape and cassette and still
 * finds its answers.
 *
 * Values the workflow definition itself holds as whole literals are kept
 * (see `MaskRecordingOptions.keepLiteralsFrom`).
 *
 * Masking runs in chunks (`maskCapturedRunAsync`), so a large capture never
 * holds the event loop for long.
 */

import {
  DATA_LABEL_SOURCES,
  canonicalJson,
  getNodeDefinition,
  PROVENANCE_LABELS,
  type DataLabels,
  type McpCassette,
  type ModelMemorySeed,
  type ModelTape,
  type ProvenanceLabel,
  type ReplayRecordedNode,
  type RunFacts
} from "@ai-orchestrator/shared";
import {
  maskRecordingSteps,
  maskedClassesForNode,
  runSteps,
  runStepsAsync,
  type GuardDictionary,
  type MaskPart,
  type MaskReport
} from "@ai-orchestrator/guard-sdk";
import { canonicalJson as cassetteCanonical, hashCassetteArgs } from "@ai-orchestrator/mcp-sdk";
import { canonicalTapeJson, hashModelRequest } from "@ai-orchestrator/provider-sdk";
import { sha256Hex } from "./audit-bundle-service.js";

export interface CaptureMaskOptions {
  key: Uint8Array;
  /** The bound guard profile's dictionaries. */
  dictionaries: GuardDictionary[];
  /** Classes a bound guard profile can mask: their surrogates keep what the mask shows. */
  visibleTailClasses?: readonly string[];
}

export interface CapturedRunParts {
  input: unknown;
  nodes: Record<string, ReplayRecordedNode>;
  facts: RunFacts;
  cassette: McpCassette | null;
  modelTape: ModelTape | null;
  memorySeed: ModelMemorySeed | null;
}

export interface MaskedCapturedRun extends CapturedRunParts {
  report: MaskReport;
}

type MaskRunOptions = CaptureMaskOptions & { keepLiteralsFrom?: unknown };

/** Masks a scrubbed capture across all of its parts, in one go. See the module comment. */
export function maskCapturedRun(run: CapturedRunParts, options: MaskRunOptions): MaskedCapturedRun {
  return runSteps(maskCapturedRunSteps(run, options));
}

/** Masks a scrubbed capture across all of its parts, giving the event loop a turn between chunks. */
export function maskCapturedRunAsync(run: CapturedRunParts, options: MaskRunOptions): Promise<MaskedCapturedRun> {
  return runStepsAsync(maskCapturedRunSteps(run, options));
}

/** The stepping form of `maskCapturedRun` (yields between chunks of work). */
export function* maskCapturedRunSteps(run: CapturedRunParts, options: MaskRunOptions): Generator<void, MaskedCapturedRun, void> {
  const parts: MaskPart[] = [];
  const add = (id: string, value: unknown, nodeId?: string | null) => parts.push({ id, value, nodeId: nodeId ?? null });

  add("input", run.input);
  const nodeIds = Object.keys(run.nodes);
  for (const nodeId of nodeIds) {
    const node = run.nodes[nodeId]!;
    add(`node:${nodeId}`, { output: node.output, error: node.error, runs: node.runs }, nodeId);
  }
  add("facts", { output: run.facts.output, error: run.facts.error });
  run.facts.toolCalls.forEach((call, index) => add(`facts.tool:${index}`, call.args, call.nodeId));
  run.cassette?.entries.forEach((entry, index) => add(`cassette:${index}`, { args: entry.args, result: entry.result, error: entry.error, exchanges: entry.exchanges }));
  run.modelTape?.entries.forEach((entry, index) => add(`tape:${index}`, { request: entry.request, response: entry.response, error: entry.error }, entry.nodeId));
  run.memorySeed?.sessions.forEach((session, index) => add(`memory:${index}`, session));

  const { parts: masked, report } = yield* maskRecordingSteps(parts, {
    key: options.key,
    dictionaries: options.dictionaries,
    keepLiteralsFrom: options.keepLiteralsFrom,
    visibleTailClasses: options.visibleTailClasses
  });
  let cursor = 0;
  const next = <T>() => masked[cursor++]!.value as T;

  const input = next<unknown>();
  const nodes: Record<string, ReplayRecordedNode> = {};
  for (const nodeId of nodeIds) {
    const value = next<{ output?: unknown; error?: string | null; runs?: ReplayRecordedNode["runs"] }>();
    const node: ReplayRecordedNode = { ...run.nodes[nodeId]! };
    if ("output" in node) node.output = value.output;
    if ("error" in node) node.error = value.error;
    if (node.runs) node.runs = value.runs;
    nodes[nodeId] = node;
  }
  const factsContent = next<{ output: unknown; error: string | null }>();
  const toolCalls = run.facts.toolCalls.map((call) => {
    const args = next<unknown>();
    return { ...call, args, argsHash: sha256Hex(canonicalJson(args ?? null)) };
  });
  const facts: RunFacts = { ...run.facts, output: factsContent.output, error: factsContent.error, toolCalls };

  const cassette: McpCassette | null = run.cassette
    ? {
        ...run.cassette,
        entries: run.cassette.entries.map((entry) => {
          const content = next<{ args?: unknown; result?: unknown; error?: string; exchanges?: typeof entry.exchanges }>();
          const out = { ...entry };
          if (entry.args !== undefined) {
            out.args = cassetteCanonical(content.args);
            out.argsHash = hashCassetteArgs(out.args);
          }
          if (entry.result !== undefined) out.result = content.result;
          if (entry.error !== undefined) out.error = content.error;
          if (entry.exchanges !== undefined) out.exchanges = content.exchanges;
          return out;
        })
      }
    : null;

  const modelTape: ModelTape | null = run.modelTape
    ? {
        ...run.modelTape,
        entries: run.modelTape.entries.map((entry) => {
          const content = next<{ request: ModelTape["entries"][number]["request"]; response?: unknown; error?: string }>();
          const request = canonicalTapeJson(content.request) as ModelTape["entries"][number]["request"];
          const out = { ...entry, request, requestHash: hashModelRequest(request) };
          if (entry.response !== undefined) out.response = content.response;
          if (entry.error !== undefined) out.error = content.error;
          return out;
        })
      }
    : null;

  const memorySeed: ModelMemorySeed | null = run.memorySeed
    ? { ...run.memorySeed, sessions: run.memorySeed.sessions.map(() => next<ModelMemorySeed["sessions"][number]>()) }
    : null;

  return { input, nodes, facts, cassette, modelTape, memorySeed, report };
}

/**
 * Who produced a run's input, decided by the server where the run started
 * (never by a caller-supplied trigger name): `scheduler` for the server's own
 * scheduled runs, `user` for runs a signed-in user or an API key started
 * (the queue, the execute API), `external` for everything else.
 */
export type CaptureInputOrigin = "scheduler" | "user" | "external";

/** Production triggers whose input a person typed (chat, forms, app messages) or an authenticated caller sent. */
const USER_TRIGGERS = new Set(["chat", "form", "webhook_api", "webhook_api_stream", "mcp_server", "slack_webhook", "telegram_webhook", "discord_webhook", "api_execute", "api_execute_stream"]);
/** Node categories that bring in content from outside the workflow. */
const EXTERNAL_CATEGORIES = new Set(["Connector", "RAG", "MCP"]);
const EXTERNAL_TYPES = new Set(["http_request", "web_browse", "mcp_tool"]);

/**
 * The provenance of a run's input. `trusted` only for the server's own
 * scheduler: a trigger name a caller chose (`cron` on the queue route) earns
 * nothing.
 */
export function inputProvenance(triggerType: string | null, origin: CaptureInputOrigin | undefined): ProvenanceLabel {
  if (origin === "scheduler") return "trusted";
  if (origin === "user") return "user";
  if (triggerType && USER_TRIGGERS.has(triggerType)) return "user";
  return "untrusted_external";
}

/** Where a node's content came from: input nodes carry the run's input provenance, nodes that fetch from outside are external. */
export function provenanceFor(nodeType: string, input: ProvenanceLabel): ProvenanceLabel[] {
  const category = getNodeDefinition(nodeType)?.category;
  if (category === "Input") return [input];
  if ((category && EXTERNAL_CATEGORIES.has(category)) || EXTERNAL_TYPES.has(nodeType)) return ["untrusted_external"];
  return [];
}

/**
 * Every node of the run facts gets `labels` (source `scan`): the data
 * classes the masking pass found in its content (`dataClasses`), and where
 * its content came from (`provenance`, from the trigger and the node type
 * only, never from the scan). Without a masking report (masking off)
 * nothing was scanned and the facts are unchanged.
 */
export function withNodeLabels(facts: RunFacts, report: MaskReport | null, input: ProvenanceLabel): RunFacts {
  if (!report) return facts;
  const scan: (typeof DATA_LABEL_SOURCES)[number] = "scan";
  return {
    ...facts,
    nodes: facts.nodes.map((node) => {
      const dataClasses = maskedClassesForNode(report, node.nodeId);
      const provenance = new Set<ProvenanceLabel>(provenanceFor(node.nodeType, input));
      const labels: DataLabels = { provenance: PROVENANCE_LABELS.filter((label) => provenance.has(label)), dataClasses, source: scan };
      return { ...node, labels };
    })
  };
}
