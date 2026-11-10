import { createHash } from "node:crypto";
import { RETRIEVAL_WITHHELD_MARKER, type GuardContentPiece } from "@ai-orchestrator/guard-sdk";
import { APPROVAL_DEFAULT_TIMEOUT_MINUTES, type DataLabels, type ModelBoundaryRenderings } from "@ai-orchestrator/shared";
import { ApprovalHandoffSignal } from "./approval-handoff";
import { unionLabels, type NodeLabelScope } from "./data-labels";
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

/** One run's renderings: node id → rendered text → its pieces; and layouts a paused run carried over, by text hash. */
interface RunRenderings {
  byNode: Map<string, Map<string, BoundaryPiece[]>>;
  carried: Map<string, Map<string, Layout>>;
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

/** Remember how a node's rendered text is made up, for the model boundary of the nodes that read it. */
export function recordRendering(run: object, nodeId: string, text: string, pieces: readonly BoundaryPiece[]): void {
  if (text.length === 0 || pieces.length === 0) return;
  if (pieces.map((piece) => piece.text).join("") !== text) return;
  const { byNode } = renderingsOf(run);
  let byText = byNode.get(nodeId);
  if (!byText) {
    byText = new Map();
    byNode.set(nodeId, byText);
  }
  byText.set(text, pieces.map(({ origin: _origin, ...piece }) => ({ ...piece, sourceNodeId: piece.sourceNodeId ?? nodeId })));
}

function renderingOf(run: object | undefined, nodeId: string, text: string): BoundaryPiece[] | undefined {
  if (!run) return undefined;
  const entry = renderingsByRun.get(run);
  if (!entry) return undefined;
  const recorded = entry.byNode.get(nodeId)?.get(text);
  if (recorded) return recorded;
  const layout = entry.carried.get(nodeId)?.get(sha256(text));
  if (!layout || layout.reduce((sum, piece) => sum + piece.length, 0) !== text.length) return undefined;
  let at = 0;
  const pieces = layout.map((piece) => {
    const slice = text.slice(at, (at += piece.length));
    return {
      text: slice,
      untrusted: piece.untrusted === true,
      ...(piece.fromInput ? { fromInput: true as const } : {}),
      ...(piece.expression ? { expression: piece.expression } : {}),
      ...(piece.sourceNodeId ? { sourceNodeId: piece.sourceNodeId } : {})
    };
  });
  entry.byNode.get(nodeId)?.set(text, pieces) ?? entry.byNode.set(nodeId, new Map([[text, pieces]]));
  return pieces;
}

/** The run's renderings as layouts for a paused run's state: lengths, trust and provenance, never text. Undefined when none. */
export function exportRenderings(run: object): ModelBoundaryRenderings | undefined {
  const entry = renderingsByRun.get(run);
  if (!entry) return undefined;
  const out: ModelBoundaryRenderings = {};
  for (const [nodeId, layouts] of entry.carried) {
    out[nodeId] = [...layouts].map(([hash, pieces]) => ({ sha256: hash, pieces }));
  }
  for (const [nodeId, byText] of entry.byNode) {
    const list = out[nodeId] ?? (out[nodeId] = []);
    for (const [text, pieces] of byText) {
      const hash = sha256(text);
      if (list.some((layout) => layout.sha256 === hash)) continue;
      list.push({
        sha256: hash,
        pieces: pieces.map((piece) => ({
          length: piece.text.length,
          ...(piece.untrusted ? { untrusted: true as const } : {}),
          ...(piece.fromInput ? { fromInput: true as const } : {}),
          ...(piece.expression ? { expression: piece.expression } : {}),
          ...(piece.sourceNodeId ? { sourceNodeId: piece.sourceNodeId } : {})
        }))
      });
    }
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
      let byHash = carried.get(nodeId);
      if (!byHash) carried.set(nodeId, (byHash = new Map()));
      byHash.set(record.sha256, pieces);
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
  /** True for nodes that carry the run's input (trigger and input nodes). */
  isInputNode?(nodeId: string): boolean;
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
  const isInput = sources.isInputNode;
  const fromInput = !unheld && (read.input || candidates.length > 0) && Boolean(isInput) && candidates.every((nodeId) => isInput!(nodeId));
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
  const result = await runGuardCheck(scope, request.profiles, { content: piece.text, channel: "tool_result", labels: [...UNTRUSTED], pieces: [meta] });
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
