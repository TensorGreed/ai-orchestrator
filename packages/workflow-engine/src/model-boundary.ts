import { createHash } from "node:crypto";
import { RETRIEVAL_WITHHELD_MARKER, type GuardContentPiece } from "@ai-orchestrator/guard-sdk";
import { APPROVAL_DEFAULT_TIMEOUT_MINUTES, type DataLabels, type ModelBoundaryRenderings } from "@ai-orchestrator/shared";
import { ApprovalHandoffSignal } from "./approval-handoff";
import { unionLabels, type NodeLabelScope, type RunLabelState } from "./data-labels";
import {
  describeGuardVerdict,
  GuardBlockedError,
  guardApprovalKey,
  needsApproval,
  runGuardCheck,
  type GuardCheckResult,
  type GuardEvalScope,
  type ResolvedGuardProfile
} from "./guard-runtime";
import type { TemplatePiece } from "./template";

/**
 * Phase 12 coverage — the model boundary. Outside content (retrieval
 * results, connector and HTTP data, web pages, webhook payloads from callers
 * the run does not trust) is checked where it reaches a model: each untrusted
 * piece of a prompt is judged on the `tool_result` channel with the
 * `untrusted_external` label, before the model call, with placement
 * `retrieval`. The author's own template text is never judged here.
 *
 * Pieces come from the prompt's `{{ }}` reads and their labels. A read whose
 * value is exactly what an earlier node rendered (a Prompt Template's prompt,
 * a retrieval node's numbered context) is split into that rendering's own
 * pieces, so the template text around a retrieved document is not judged as
 * outside content and each document is judged on its own.
 */

/** One piece of a prompt: author text or engine text (`untrusted: false`), or what a read brought in. */
export interface BoundaryPiece {
  text: string;
  untrusted: boolean;
  /** The template expression or field path that read it. Never the value. */
  expression?: string;
  /** The node whose output it came from. */
  sourceNodeId?: string;
  /** Position of the top-level template piece this piece came from (see `rewriteTemplatePieces`). */
  origin?: number;
  /** It came only from the run's input (the trigger's payload), not from a node that fetched it. */
  fromInput?: true;
}

export type BoundaryField = "system_prompt" | "user_prompt";

const UNTRUSTED = ["untrusted_external"] as const;

// ---------------------------------------------------------------------------
// Renderings: what earlier nodes of the run rendered, by piece
// ---------------------------------------------------------------------------

type Layout = ModelBoundaryRenderings[string][number]["pieces"];

/**
 * One run's renderings: node id → its latest rendered text and pieces; and layouts a paused run carried over,
 * by text hash. Only the latest rendering of a node is kept: readers only ever read a node's current output,
 * and a lookup that misses judges the whole value (the conservative result).
 */
interface RunRenderings {
  byNode: Map<string, { text: string; pieces: BoundaryPiece[] }>;
  carried: Map<string, { sha256: string; pieces: Layout }>;
}

/** Per run, keyed by an object that lives exactly as long as the run (its node output map). */
const renderingsByRun = new WeakMap<object, RunRenderings>();

function renderingsOf(run: object): RunRenderings {
  let entry = renderingsByRun.get(run);
  if (!entry) {
    entry = { byNode: new Map(), carried: new Map() };
    renderingsByRun.set(run, entry);
  }
  return entry;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Remember how a node's rendered text is made up, for the model boundary of the nodes that read it. Replaces the node's earlier rendering. */
export function recordRendering(run: object, nodeId: string, text: string, pieces: readonly BoundaryPiece[]): void {
  const entry = renderingsOf(run);
  // A newer rendering always replaces what the node had, even one that cannot be recorded.
  entry.byNode.delete(nodeId);
  entry.carried.delete(nodeId);
  if (text.length === 0 || pieces.length === 0) return;
  if (pieces.map((piece) => piece.text).join("") !== text) return;
  entry.byNode.set(nodeId, {
    text,
    pieces: pieces.map(({ origin: _origin, ...piece }) => ({ ...piece, sourceNodeId: piece.sourceNodeId ?? nodeId }))
  });
}

function renderingOf(run: object | undefined, nodeId: string, text: string): BoundaryPiece[] | undefined {
  if (!run) return undefined;
  const entry = renderingsByRun.get(run);
  if (!entry) return undefined;
  const recorded = entry.byNode.get(nodeId);
  if (recorded) return recorded.text === text ? recorded.pieces : undefined;
  const carried = entry.carried.get(nodeId);
  if (!carried || carried.pieces.reduce((sum, piece) => sum + piece.length, 0) !== text.length) return undefined;
  if (carried.sha256 !== sha256(text)) return undefined;
  let at = 0;
  return carried.pieces.map((piece) => {
    const slice = text.slice(at, (at += piece.length));
    return {
      text: slice,
      untrusted: piece.untrusted === true,
      ...(piece.fromInput ? { fromInput: true as const } : {}),
      ...(piece.expression ? { expression: piece.expression } : {}),
      ...(piece.sourceNodeId ? { sourceNodeId: piece.sourceNodeId } : {})
    };
  });
}

/** The run's renderings as layouts for a paused run's state: lengths, trust and provenance, never text. One per node; undefined when none. */
export function exportRenderings(run: object): ModelBoundaryRenderings | undefined {
  const entry = renderingsByRun.get(run);
  if (!entry) return undefined;
  const out: ModelBoundaryRenderings = {};
  for (const [nodeId, carried] of entry.carried) {
    out[nodeId] = [{ sha256: carried.sha256, pieces: carried.pieces }];
  }
  for (const [nodeId, { text, pieces }] of entry.byNode) {
    out[nodeId] = [
      {
        sha256: sha256(text),
        pieces: pieces.map((piece) => ({
          length: piece.text.length,
          ...(piece.untrusted ? { untrusted: true as const } : {}),
          ...(piece.fromInput ? { fromInput: true as const } : {}),
          ...(piece.expression ? { expression: piece.expression } : {}),
          ...(piece.sourceNodeId ? { sourceNodeId: piece.sourceNodeId } : {})
        }))
      }
    ];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A resumed run takes over the layouts its paused state carried. Malformed entries are skipped (the read is judged whole). */
export function importRenderings(run: object, layouts: unknown): void {
  if (!layouts || typeof layouts !== "object" || Array.isArray(layouts)) return;
  const { carried } = renderingsOf(run);
  for (const [nodeId, list] of Object.entries(layouts as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const layout of list) {
      const record = layout as { sha256?: unknown; pieces?: unknown };
      if (typeof record?.sha256 !== "string" || !Array.isArray(record.pieces)) continue;
      const pieces: Layout = [];
      let valid = true;
      for (const piece of record.pieces as Array<Record<string, unknown>>) {
        if (!piece || typeof piece.length !== "number" || !Number.isInteger(piece.length) || piece.length < 0) {
          valid = false;
          break;
        }
        pieces.push({
          length: piece.length,
          ...(piece.untrusted === true ? { untrusted: true as const } : {}),
          ...(piece.fromInput === true ? { fromInput: true as const } : {}),
          ...(typeof piece.expression === "string" ? { expression: piece.expression } : {}),
          ...(typeof piece.sourceNodeId === "string" ? { sourceNodeId: piece.sourceNodeId } : {})
        });
      }
      if (!valid) continue;
      // One layout per node: the latest (the last valid entry).
      carried.set(nodeId, { sha256: record.sha256, pieces });
    }
  }
}

/** The pieces of a numbered retrieval context (`[1] text\n[2] text`): the numbering is engine text, each document is outside content. */
export function numberedContextPieces(documents: ReadonlyArray<{ text: string }>, nodeId: string): { text: string; pieces: BoundaryPiece[] } {
  const pieces: BoundaryPiece[] = [];
  documents.forEach((doc, index) => {
    pieces.push({ text: `${index > 0 ? "\n" : ""}[${index + 1}] `, untrusted: false });
    if (doc.text.length > 0) pieces.push({ text: doc.text, untrusted: true, expression: `documents[${index}].text`, sourceNodeId: nodeId });
  });
  return { text: pieces.map((piece) => piece.text).join(""), pieces };
}

// ---------------------------------------------------------------------------
// Pieces of a prompt
// ---------------------------------------------------------------------------

export interface PieceSources {
  scope: NodeLabelScope;
  /** The run (see `recordRendering`); absent: reads are never split. */
  run?: object;
  /** The node's parents' outputs, to tell which parent a field read comes from. */
  parentOutputs: Record<string, unknown>;
  /**
   * True for nodes whose output is only the caller's own input (see
   * `callerInputCheck`); absent when the run's input is not a caller's own words.
   */
  callerInput?(nodeId: string): boolean;
}

// ---------------------------------------------------------------------------
// The caller's own input (D11a)
// ---------------------------------------------------------------------------

/**
 * Runs whose input is the caller's own words: webhooks, API calls, chat,
 * forms and MCP server calls. Runs started by email, feeds, files, chat apps,
 * queues, other workflows and the rest carry third-party content.
 */
const CALLER_INPUT_TRIGGERS = new Set(["webhook", "webhook_test", "webhook_api", "webhook_api_stream", "api_queue", "chat", "form", "mcp_server"]);

/** Nodes that hand on the run's input as the caller sent it. Content triggers (email, feeds, files, chat apps, queues, sub-workflows) are not here. */
const CALLER_INPUT_NODES = new Set(["webhook_input", "chat_trigger", "form_trigger", "mcp_server_trigger", "manual_trigger", "text_input", "user_prompt", "system_prompt"]);

/** Nodes that only reshape what they read: their output is the caller's input when everything they read is. */
const PASS_THROUGH_NODES = new Set([
  "set_node",
  "edit_fields_node",
  "rename_keys_node",
  "merge_node",
  "code_node",
  "prompt_template",
  "if_node",
  "switch_node",
  "filter_node",
  "noop_node",
  "loop_node",
  "limit_node",
  "sort_node",
  "aggregate_node",
  "split_out_node",
  "remove_duplicates_node",
  "date_time_node",
  "input_validator",
  "try_catch"
]);

/** Node ids a paused run's state carried as caller input, per resumed run. */
const carriedCallerInput = new WeakMap<RunLabelState, ReadonlySet<string>>();

/** True when a run started by this trigger has the caller's own words as its input. */
export function isCallerInputRun(triggerType: unknown): boolean {
  return typeof triggerType === "string" && CALLER_INPUT_TRIGGERS.has(triggerType.trim().toLowerCase());
}

function isCallerInputNode(run: RunLabelState, nodeId: string, visiting: Set<string>): boolean {
  const derivation = run.derivationOf(nodeId);
  if (!derivation) return carriedCallerInput.get(run)?.has(nodeId) === true;
  if (CALLER_INPUT_NODES.has(derivation.nodeType)) return !derivation.other;
  if (!PASS_THROUGH_NODES.has(derivation.nodeType) || derivation.other) return false;
  if (visiting.has(nodeId)) return false;
  visiting.add(nodeId);
  const sources = [...new Set([...derivation.parentIds, ...derivation.nodeIds])];
  const result = (sources.length > 0 || derivation.input) && sources.every((sourceId) => isCallerInputNode(run, sourceId, visiting));
  visiting.delete(nodeId);
  return result;
}

/**
 * D11a — whether a node's output is only the caller's own input: a caller
 * input node, or a pass-through node all of whose sources (DAG parents and
 * template reads, everything that had run when it read everything) are. Any
 * other node (a connector, retrieval, a model, an agent, a sub-workflow, a
 * node whose handler took content from elsewhere) breaks the chain.
 */
export function callerInputCheck(run: RunLabelState): (nodeId: string) => boolean {
  return (nodeId) => isCallerInputNode(run, nodeId, new Set());
}

/** The finished nodes whose output is only the caller's own input, for a paused run's state. Undefined when none. */
export function exportCallerInput(run: RunLabelState): string[] | undefined {
  const check = callerInputCheck(run);
  const ids = [...new Set([...run.nodeIds(), ...(carriedCallerInput.get(run) ?? [])])].filter(check);
  return ids.length > 0 ? ids : undefined;
}

/** A resumed run takes over the caller-input nodes its paused state carried (nodes that finished before the pause). */
export function importCallerInput(run: RunLabelState, ids: unknown): void {
  if (!Array.isArray(ids)) return;
  const valid = ids.filter((id): id is string => typeof id === "string");
  if (valid.length > 0) carriedCallerInput.set(run, new Set(valid));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * What one read brought into a prompt. Its labels are those of the nodes it
 * names and of the parents that hold the field it reads (all parents when no
 * single holder is known); untrusted reads whose value is a recorded
 * rendering of one of those nodes are split into the rendering's pieces.
 */
export function readPieces(text: string, body: string, simplePath: boolean, sources: PieceSources, origin?: number): BoundaryPiece[] {
  if (text.length === 0) return [];
  const { scope } = sources;
  const read = scope.sourcesOfTemplateRead(body, simplePath);
  const holders = new Set<string>();
  let unheld = false;
  for (const field of read.parentFields) {
    const holding = Object.entries(sources.parentOutputs).filter(([, output]) => isRecord(output) && Object.prototype.hasOwnProperty.call(output, field));
    if (holding.length === 0) unheld = true;
    for (const [parentId] of holding) holders.add(parentId);
  }
  const labels: DataLabels = unheld
    ? scope.labelsOfTemplateRead(body, simplePath)
    : unionLabels([
        ...read.nodeIds.map((nodeId) => scope.run.getFor(scope.nodeId, nodeId)),
        ...[...holders].map((nodeId) => scope.run.getFor(scope.nodeId, nodeId)),
        read.input ? scope.run.inputFor(scope.nodeId) : undefined
      ]);
  const at = origin !== undefined ? { origin } : {};
  if (!labels.provenance.includes("untrusted_external")) return [{ text, untrusted: false, expression: body, ...at }];
  const candidates = [...new Set([...read.nodeIds, ...holders])];
  for (const nodeId of candidates) {
    const rendering = renderingOf(sources.run, nodeId, text);
    if (rendering) return rendering.map((piece) => ({ ...piece, ...at }));
  }
  const callerInput = sources.callerInput;
  const fromInput = !unheld && callerInput !== undefined && (read.input || candidates.length > 0) && candidates.every((nodeId) => callerInput(nodeId));
  return [
    { text, untrusted: true, expression: body, ...(candidates.length === 1 ? { sourceNodeId: candidates[0] } : {}), ...(fromInput ? { fromInput: true as const } : {}), ...at }
  ];
}

/**
 * The pieces of a rendered template, or undefined when the template's pieces
 * do not add up to the text (it was replaced after rendering).
 */
export function templateBoundaryPieces(templatePieces: readonly TemplatePiece[], rendered: string, sources: PieceSources): BoundaryPiece[] | undefined {
  if (templatePieces.map((piece) => piece.text).join("") !== rendered) return undefined;
  const out: BoundaryPiece[] = [];
  templatePieces.forEach((piece, origin) => {
    if (piece.text.length === 0) return;
    if (piece.body === undefined) out.push({ text: piece.text, untrusted: false, origin });
    else out.push(...readPieces(piece.text, piece.body, piece.simplePath, sources, origin));
  });
  return out;
}

/** A model node's prompt part: engine or author text, or a field it read (`path`, as `readData` reads it). */
export type PromptPart = string | { text: string; path: string };

/** The text a list of prompt parts makes. */
export function joinPromptParts(parts: readonly PromptPart[]): string {
  return parts.map((part) => (typeof part === "string" ? part : part.text)).join("");
}

/**
 * The pieces of a prompt built from parts. When the parts do not add up to
 * the text (a server prompt replaced it), the whole text is one piece:
 * untrusted when `replaced` says an MCP server wrote it or any part read
 * outside content.
 */
export function promptPartPieces(parts: readonly PromptPart[], text: string, sources: PieceSources, replaced = false): BoundaryPiece[] {
  const pieces = parts.flatMap((part) => (typeof part === "string" ? (part.length > 0 ? [{ text: part, untrusted: false }] : []) : readPieces(part.text, part.path, true, sources)));
  if (!replaced && joinPromptParts(parts) === text) return pieces;
  return text.length > 0 ? [{ text, untrusted: replaced || pieces.some((piece) => piece.untrusted) }] : [];
}

/** True when some piece is outside content worth judging. */
export function hasUntrustedPiece(fields: ReadonlyArray<{ pieces: readonly BoundaryPiece[] }>): boolean {
  return fields.some((field) => field.pieces.some((piece) => piece.untrusted && piece.text.trim().length > 0));
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** Profiles that judge the model boundary: those with a `tool_result` channel. */
export function boundaryProfiles(profiles: readonly ResolvedGuardProfile[]): ResolvedGuardProfile[] {
  return profiles.filter((entry) => entry.profile.channels.tool_result !== undefined);
}

/**
 * `retrieval.onBlock` across a stack: `withhold` when some profile asks for
 * it and none asks for `fail` explicitly (an enforced profile can pin `fail`).
 */
export function stackOnBlock(profiles: readonly ResolvedGuardProfile[]): "fail" | "withhold" {
  const asked = profiles.map((entry) => entry.profile.retrieval?.onBlock).filter((value): value is "fail" | "withhold" => value !== undefined);
  return asked.includes("withhold") && !asked.includes("fail") ? "withhold" : "fail";
}

/** `retrieval.perDocument` across a stack: on when any profile turns it on. */
export function stackChecksPerDocument(profiles: readonly ResolvedGuardProfile[]): boolean {
  return profiles.some((entry) => entry.profile.retrieval?.perDocument === true);
}

export interface BoundaryCheckEntry {
  field: BoundaryField;
  action: GuardCheckResult["action"];
  verdicts: GuardCheckResult["verdicts"];
  withheld?: true;
  approved?: true;
}

export interface ModelBoundaryRequest {
  /** Placement `retrieval`; with the run's memo. */
  scope: GuardEvalScope;
  profiles: ResolvedGuardProfile[];
  fields: Array<{ field: BoundaryField; pieces: BoundaryPiece[] }>;
  approvals?: ReadonlySet<string>;
  /** A replay: never pause; an approval fails the node as "would wait for approval". */
  replay: boolean;
  /** Plain words for messages: "LLM Call (model call)". */
  what: string;
  /**
   * Pieces that came only from the run's input are judged with the built-in
   * rule set in shadow (an agent's own prompt check already acts on its input).
   */
  shadowInputUnderBuiltin?: boolean;
}

export interface ModelBoundaryOutcome {
  /** Each field's text after the check, and its pieces with their new text. */
  fields: Array<{ field: BoundaryField; text: string; pieces: BoundaryPiece[]; changed: boolean }>;
  checks: BoundaryCheckEntry[];
}

const FIELD_WORDS: Record<BoundaryField, string> = { system_prompt: "system prompt", user_prompt: "prompt" };

/**
 * Judge every untrusted piece once (the same text in two places is judged
 * once). A block fails the node (`GuardBlockedError`) unless the stack asks
 * to withhold, which replaces the piece with `RETRIEVAL_WITHHELD_MARKER`;
 * an approval the run does not have pauses it (re-run on approval); a
 * rewrite replaces the piece's text.
 */
export async function checkModelBoundary(request: ModelBoundaryRequest): Promise<ModelBoundaryOutcome> {
  const onBlock = stackOnBlock(request.profiles);
  const decided = new Map<string, string>();
  const checks: BoundaryCheckEntry[] = [];
  const fields: ModelBoundaryOutcome["fields"] = [];
  for (const { field, pieces } of request.fields) {
    const out: BoundaryPiece[] = [];
    let changed = false;
    for (const piece of pieces) {
      if (!piece.untrusted || piece.text.trim().length === 0) {
        out.push(piece);
        continue;
      }
      let replacement = decided.get(piece.text);
      if (replacement === undefined) {
        replacement = await judgePiece(request, field, piece, onBlock, checks);
        decided.set(piece.text, replacement);
      }
      if (replacement !== piece.text) changed = true;
      out.push(replacement === piece.text ? piece : { ...piece, text: replacement });
    }
    fields.push({ field, text: out.map((piece) => piece.text).join(""), pieces: out, changed });
  }
  return { fields, checks };
}

async function judgePiece(
  request: ModelBoundaryRequest,
  field: BoundaryField,
  piece: BoundaryPiece,
  onBlock: "fail" | "withhold",
  checks: BoundaryCheckEntry[]
): Promise<string> {
  const meta: GuardContentPiece = {
    span: { start: 0, end: piece.text.length },
    labels: [...UNTRUSTED],
    field,
    ...(piece.expression ? { expression: piece.expression } : {}),
    ...(piece.sourceNodeId ? { sourceNodeId: piece.sourceNodeId } : {})
  };
  const scope = piece.fromInput && request.shadowInputUnderBuiltin ? { ...request.scope, shadowUnderBuiltin: true } : request.scope;
  // Shadow checks record findings only: clean rows would be noise until the shadow period ends.
  const result = await runGuardCheck(
    scope,
    request.profiles,
    { content: piece.text, channel: "tool_result", labels: [...UNTRUSTED], pieces: [meta] },
    scope.shadowUnderBuiltin ? { onlyFindings: true } : {}
  );
  const entry: BoundaryCheckEntry = { field, action: result.action, verdicts: result.verdicts };
  checks.push(entry);
  const where = `outside content in its ${FIELD_WORDS[field]}${piece.sourceNodeId ? ` (from ${piece.sourceNodeId})` : ""}`;
  if (result.action === "block") {
    if (onBlock === "withhold") {
      entry.withheld = true;
      return RETRIEVAL_WITHHELD_MARKER;
    }
    throw new GuardBlockedError(`${request.what} was blocked by content rules: ${where}: ${describeGuardVerdict(result)}`, result.verdicts);
  }
  if (needsApproval(result.action)) {
    const key = guardApprovalKey(request.scope.nodeId, "tool_result", result, `boundary:${field}`);
    if (!request.approvals?.has(key)) {
      const reason = describeGuardVerdict(result);
      if (request.replay) throw new GuardBlockedError(`${request.what} would wait for approval: ${where}: ${reason}`, result.verdicts);
      throw new ApprovalHandoffSignal({
        message: `Content rules approval needed before ${request.what}: ${where}: ${reason}`,
        timeoutMinutes: APPROVAL_DEFAULT_TIMEOUT_MINUTES,
        handoff: { kind: "rerun", source: "model_boundary", approvalKey: key },
        details: { channel: "tool_result", verdicts: result.verdicts }
      });
    }
    entry.approved = true;
  }
  if (!result.transformed) return piece.text;
  return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
}

/**
 * The template pieces with each piece's text replaced by what the boundary
 * left of it (pieces carry `origin`), so code that walks the template pieces
 * (spotlighting) sees the checked prompt. Unchanged when a piece has no origin.
 */
export function rewriteTemplatePieces(templatePieces: readonly TemplatePiece[], checked: readonly BoundaryPiece[]): TemplatePiece[] {
  const texts = new Map<number, string>();
  for (const piece of checked) {
    if (piece.origin === undefined) return [...templatePieces];
    texts.set(piece.origin, (texts.get(piece.origin) ?? "") + piece.text);
  }
  return templatePieces.map((piece, index) => ({ ...piece, text: texts.get(index) ?? piece.text }));
}

// ---------------------------------------------------------------------------
// Per-document checks (retrieval nodes)
// ---------------------------------------------------------------------------

export interface DocumentCheckOutcome<T extends { text: string }> {
  documents: T[];
  dropped: number;
  redacted: number;
}

/**
 * `retrieval.perDocument` — each retrieved document judged on its own: a
 * block, or an approval (a retrieval cannot wait for a person), drops it; a
 * rewrite applies to its text.
 */
export async function checkRetrievedDocuments<T extends { text: string }>(input: {
  scope: GuardEvalScope;
  profiles: ResolvedGuardProfile[];
  documents: readonly T[];
}): Promise<DocumentCheckOutcome<T>> {
  const kept: T[] = [];
  let dropped = 0;
  let redacted = 0;
  for (const [index, doc] of input.documents.entries()) {
    if (doc.text.trim().length === 0) {
      kept.push(doc);
      continue;
    }
    const result = await runGuardCheck(input.scope, input.profiles, {
      content: doc.text,
      channel: "tool_result",
      labels: [...UNTRUSTED],
      pieces: [{ span: { start: 0, end: doc.text.length }, labels: [...UNTRUSTED], field: "documents", expression: `documents[${index}].text`, sourceNodeId: input.scope.nodeId }]
    });
    if (result.action === "block" || needsApproval(result.action)) {
      dropped += 1;
      continue;
    }
    if (result.transformed) {
      redacted += 1;
      kept.push({ ...doc, text: typeof result.content === "string" ? result.content : JSON.stringify(result.content) });
      continue;
    }
    kept.push(doc);
  }
  return { documents: kept, dropped, redacted };
}
