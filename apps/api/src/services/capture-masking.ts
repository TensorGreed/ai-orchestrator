/**
 * Phase 15.6 — masking a production capture before it is stored.
 *
 * The recording is split into content parts (trigger input, every node's
 * recorded output and error, the run's output and error, every tool call's
 * arguments, every string of every MCP cassette entry (a resource URI or
 * prompt name, arguments, result, error, exchanges and any other field) and
 * the cassette's server labels,
 * every model-tape entry's request, answer and error, and the memory seed's
 * sessions) and masked at once with `maskRecording` from guard-sdk: a value
 * found anywhere is replaced everywhere by its keyed surrogate. Only fields
 * that cannot hold personal data stay out (node ids and types, providers,
 * models, a cassette entry's method, sequence numbers and timings); the match
 * keys (`argsHash`, `requestHash`) are taken again over the masked content,
 * and a resource URI or prompt name is masked with the same surrogates as
 * the input, so a replay of the masked input asks for the masked resource
 * and still finds its answers. Routing identifiers (a server's key,
 * registry id and adapter, an entry's server, a `tools/call` tool name) stay
 * as written, because replay looks them up as configured; if one holds a
 * collected value the capture is dropped (`dropped_identifier_value`).
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
  inputProvenance,
  provenanceFor,
  PROVENANCE_LABELS,
  type DataLabels,
  type McpCassette,
  type ModelMemorySeed,
  type ModelTape,
  type ProvenanceLabel,
  type RunInputOrigin,
  type ReplayRecordedNode,
  type RunFacts
} from "@ai-orchestrator/shared";
import {
  maskRecordingSteps,
  maskedClassesForNode,
  runSteps,
  runStepsAsync,
  type GuardDictionary,
  type MaskIdentifier,
  type MaskPart,
  type MaskReport
} from "@ai-orchestrator/guard-sdk";
import { canonicalJson as cassetteCanonical, hashCassetteArgs } from "@ai-orchestrator/mcp-sdk";
import { canonicalTapeJson, hashModelRequest } from "@ai-orchestrator/provider-sdk";
import { sha256Hex } from "./audit-bundle-service.js";

/** Cassette entry fields that are not content: a method name, the order, timings, the match key taken again after masking, and the server key replay looks the entry up by. */
const CASSETTE_ENTRY_KEPT = new Set(["seq", "method", "argsHash", "at", "durationMs", "server"]);
/** Cassette server fields masked like content. Its `key`, `registryServerId` and `adapterId` are routing identifiers, kept as written. */
const CASSETTE_SERVER_MASKED = ["label"] as const;
/** Cassette server fields replay rebuilds from the live configuration: kept as written, and checked for collected values. */
const CASSETTE_SERVER_IDENTIFIERS = ["key", "registryServerId", "adapterId"] as const;

/** A `tools/call` entry's `name` is the tool name from the workflow (replay asks for it as configured); a resource URI or prompt name is content. */
function nameIsIdentifier(entry: McpCassette["entries"][number]): boolean {
  return entry.method === "tools/call";
}

function cassetteEntryContent(entry: McpCassette["entries"][number]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(entry)) {
    if (CASSETTE_ENTRY_KEPT.has(field) || value === undefined) continue;
    if (field === "name" && nameIsIdentifier(entry)) continue;
    out[field] = value;
  }
  return out;
}

/**
 * The cassette's routing identifiers, kept as written: replay rebuilds the
 * server key from the live configuration and asks for a tool by the name
 * the workflow gives it, so a masked identifier would never be found. They
 * are operator configuration (stored in plain text in the registry and the
 * workflow); masking drops the capture if one holds a collected value.
 *
 * Server keys, registry ids and adapter ids are made by the server
 * (`generated`), and a tool name the server's own catalog lists (its
 * recorded `tools/list` answer, or the registry's current tool snapshot) is
 * `catalog`: neither is scanned on its own, so a digit run in a
 * `mcp_<uuid>` id or a dictionary word in `atlas_search` never drops every
 * capture of a workflow. Any other tool name is scanned on its own too.
 */
export function cassetteIdentifiers(cassette: McpCassette, catalogToolNames?: (registryServerId: string) => readonly string[]): MaskIdentifier[] {
  const out: MaskIdentifier[] = [];
  const catalog = new Map<string, Set<string>>();
  const catalogOf = (serverKey: string): Set<string> => {
    let names = catalog.get(serverKey);
    if (names) return names;
    names = new Set<string>();
    for (const entry of cassette.entries) {
      if (entry.server !== serverKey || entry.method !== "tools/list" || !Array.isArray(entry.result)) continue;
      for (const tool of entry.result as unknown[]) {
        const name = tool && typeof tool === "object" ? (tool as { name?: unknown }).name : undefined;
        if (typeof name === "string") names.add(name);
      }
    }
    const registryServerId = cassette.servers.find((server) => server.key === serverKey)?.registryServerId;
    if (registryServerId && catalogToolNames) {
      try {
        for (const name of catalogToolNames(registryServerId)) names.add(name);
      } catch {
        // No registry catalog: the name is scanned on its own (fails closed).
      }
    }
    catalog.set(serverKey, names);
    return names;
  };
  const serverKeys = new Set(cassette.servers.map((server) => server.key));
  cassette.servers.forEach((server, index) => {
    for (const field of CASSETTE_SERVER_IDENTIFIERS) {
      const value = server[field];
      if (typeof value === "string" && value) out.push({ id: `cassette server ${index + 1} ${field}`, text: value, kind: "generated" });
    }
  });
  cassette.entries.forEach((entry, index) => {
    // An entry's server is one of the cassette's server keys; anything else is scanned on its own.
    if (entry.server) out.push({ id: `cassette entry ${index + 1} server`, text: entry.server, kind: serverKeys.has(entry.server) ? "generated" : "free" });
    if (nameIsIdentifier(entry) && entry.name) {
      out.push({ id: `cassette entry ${index + 1} tool name`, text: entry.name, kind: catalogOf(entry.server).has(entry.name) ? "catalog" : "free" });
    }
  });
  return out;
}

export interface CaptureMaskOptions {
  key: Uint8Array;
  /** The bound guard profile's dictionaries. */
  dictionaries: GuardDictionary[];
  /** The tool names a registry server's current tool snapshot lists (`cassetteIdentifiers`). */
  catalogToolNames?: (registryServerId: string) => readonly string[];
  /** Phase 16 — surrogates the run issued at runtime: kept as they are (`MaskRecordingOptions.keepValues`). */
  keepValues?: Iterable<string>;
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
  run.cassette?.entries.forEach((entry, index) => add(`cassette:${index}`, cassetteEntryContent(entry)));
  if (run.cassette) {
    add(
      "cassette.servers",
      run.cassette.servers.map((server) => Object.fromEntries(CASSETTE_SERVER_MASKED.filter((field) => typeof server[field] === "string").map((field) => [field, server[field]])))
    );
  }
  run.modelTape?.entries.forEach((entry, index) => add(`tape:${index}`, { request: entry.request, response: entry.response, error: entry.error }, entry.nodeId));
  run.memorySeed?.sessions.forEach((session, index) => add(`memory:${index}`, session));

  const { parts: masked, report } = yield* maskRecordingSteps(parts, {
    key: options.key,
    dictionaries: options.dictionaries,
    keepLiteralsFrom: options.keepLiteralsFrom,
    ...(options.keepValues ? { keepValues: options.keepValues } : {}),
    identifiers: run.cassette ? cassetteIdentifiers(run.cassette, options.catalogToolNames) : []
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
          const content = next<Record<string, unknown>>();
          const out = { ...entry, ...content } as McpCassette["entries"][number];
          if (entry.args !== undefined) {
            out.args = cassetteCanonical(content.args);
            out.argsHash = hashCassetteArgs(out.args);
          }
          return out;
        })
      }
    : null;
  if (cassette && run.cassette) {
    const servers = next<Array<Record<string, string>>>();
    cassette.servers = run.cassette.servers.map((server, index) => ({ ...server, ...servers[index] }));
  }

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
 * (the queue, the execute API), `external` for everything else. The rules
 * live in shared (Phase 16) so capture and label propagation use one copy.
 */
export type CaptureInputOrigin = RunInputOrigin;
export { inputProvenance, provenanceFor };

/**
 * Every node of the run facts gets `labels`. With a masking report (a
 * masked capture), source `scan`: the data classes the masking pass found in
 * its content and where its content came from (from the trigger and the node
 * type only, never from the scan). Phase 16 — a node that carries labels the
 * engine propagated (the run tracked labels) gets source `propagated`: those
 * labels merged with what the scan found. Without either, the facts are
 * unchanged.
 */
export function withNodeLabels(
  facts: RunFacts,
  report: MaskReport | null,
  input: ProvenanceLabel,
  propagated: ReadonlyMap<string, DataLabels> = new Map()
): RunFacts {
  if (!report && propagated.size === 0) return facts;
  return {
    ...facts,
    nodes: facts.nodes.map((node) => {
      const carried = propagated.get(node.nodeId);
      if (!report && !carried) return node;
      const provenance = new Set<ProvenanceLabel>(report ? provenanceFor(node.nodeType, input) : []);
      const dataClasses = new Set<string>(report ? maskedClassesForNode(report, node.nodeId) : []);
      carried?.provenance.forEach((label) => provenance.add(label));
      carried?.dataClasses.forEach((name) => dataClasses.add(name));
      const source: (typeof DATA_LABEL_SOURCES)[number] = carried ? "propagated" : "scan";
      const labels: DataLabels = {
        provenance: PROVENANCE_LABELS.filter((label) => provenance.has(label)),
        dataClasses: report && !carried ? maskedClassesForNode(report, node.nodeId) : [...dataClasses].sort(),
        source
      };
      return { ...node, labels };
    })
  };
}
