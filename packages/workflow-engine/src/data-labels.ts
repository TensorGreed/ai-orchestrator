import { AsyncLocalStorage } from "node:async_hooks";
import { dropIssuedSurrogates, scanDlp, type GuardDictionary } from "@ai-orchestrator/guard-sdk";
import {
  emptyDataLabels,
  endorseLabels,
  isEmptyDataLabels,
  labelEndorsementSchema,
  unionDataLabels,
  nodeContentSource,
  orderedProvenance,
  parseStoredDataLabels,
  withoutDataClasses,
  type DataLabels,
  type LabelEndorsement,
  type NodeLabelMap,
  type ProvenanceLabel,
  type WorkflowExecutionState
} from "@ai-orchestrator/shared";

/**
 * Phase 16 — data label propagation in the engine.
 *
 * A run keeps a side map beside its node outputs: for every completed node,
 * where its output came from (provenance) and the data classes it holds.
 * Outputs are never changed. A node's labels are
 *
 *   its own source (an input node carries the run's input labels; a node
 *   that fetches from outside the workflow adds `untrusted_external`)
 *   ∪ the labels of its direct parents that ran
 *   ∪ the labels of every node it read through `{{ }}` (recorded as the
 *     node's templates render, see `recordTemplateRead`)
 *   ∪ what the handler adds at run time (memory it read, a sub-workflow's
 *     or an agent's result)
 *   − data classes a guard redacted, masked or protected (never provenance)
 *   ∪ data classes a scan of the output finds (only on runs that track labels).
 *
 * Provenance is computed on every run (cheap: a few set unions per node).
 * Scanning, storing labels on node results and in session memory happen only
 * when the run tracks labels, which a guard profile turns on.
 */

/** Labels from provenance and data classes, sorted and de-duplicated, source `propagated`. */
export function labelsOf(provenance: Iterable<ProvenanceLabel>, dataClasses: Iterable<string> = []): DataLabels {
  return { provenance: orderedProvenance(provenance), dataClasses: [...new Set(dataClasses)].sort(), source: "propagated" };
}

/** The union of label sets (missing parts ignored); always source `propagated`. */
export function unionLabels(parts: ReadonlyArray<DataLabels | null | undefined>): DataLabels {
  return unionDataLabels(parts);
}

// ---------------------------------------------------------------------------
// References: which nodes a template or expression reads
// ---------------------------------------------------------------------------

export interface TemplateReferences {
  /** Node ids named literally (`results.X`, `results["X"]`, `$node("X")`, `parent_outputs.X`). */
  nodes: string[];
  /** Dynamic access (`results[key]`, `$node(name)`, the whole `results`, `$json` or `$input`): every node in context. */
  all: boolean;
  /** Top-level names read (`user_prompt`, `webhook`, a parent's field): run input when they come from the run's globals. */
  heads: string[];
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** Names that never point at data: JavaScript words and the sandbox's helpers. */
const NON_DATA_NAMES = new Set([
  "true", "false", "null", "undefined", "NaN", "Infinity", "typeof", "instanceof", "in", "of", "new", "void", "delete",
  "this", "return", "if", "else", "let", "const", "var", "function", "Math", "JSON", "String", "Number", "Boolean",
  "Object", "Array", "Date", "RegExp", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "$now", "$today", "$itemIndex", "$if", "$ifEmpty", "$jmespath",
  "$workflow", "$execution", "$env", "$vars", "vars", "workflow", "execution"
]);

/** References of a simple dotted path (`results.X.y`, `user_prompt`, `parent_outputs.X`). */
export function referencesInPath(path: string): TemplateReferences {
  const segments = path.split(".").map((segment) => segment.trim()).filter(Boolean);
  const out: TemplateReferences = { nodes: [], all: false, heads: [] };
  addPathReference(out, segments);
  return out;
}

function addPathReference(out: TemplateReferences, segments: string[]): void {
  const [head, second] = segments;
  if (!head) return;
  if (head === "results") {
    if (second) out.nodes.push(second);
    else out.all = true;
    return;
  }
  if (head === "parent_outputs") {
    // Direct parents count anyway; a named one is still a literal read.
    if (second) out.nodes.push(second);
    return;
  }
  if (!NON_DATA_NAMES.has(head)) out.heads.push(head);
}

const STRING_LITERAL = /(["'])((?:\\.|(?!\1)[^\\\r\n])*)\1|`((?:\\.|[^\\`])*)`/g;

function literalValue(source: string): string | undefined {
  const trimmed = source.trim();
  // An escape (`\x66`, `\u0066`, `\n`) changes the name the engine looks up: not decoded here, so the key is dynamic
  // and the access reads every node (fail closed).
  if (trimmed.includes("\\")) return undefined;
  const quoted = /^(["'])((?:\\.|(?!\1)[^\\])*)\1$/.exec(trimmed);
  if (quoted) return quoted[2]!.replace(/\\(.)/g, "$1");
  const template = /^`((?:\\.|[^\\`$]|\$(?!\{))*)`$/.exec(trimmed);
  if (template) return template[1]!.replace(/\\(.)/g, "$1");
  return undefined;
}

/** The bracket argument after `name[`, up to its matching `]`; undefined when unbalanced. */
function bracketArgument(source: string, openIndex: number, open: string, close: string): string | undefined {
  let depth = 0;
  let quote: string | null = null;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return undefined;
}

/**
 * References of a sandboxed expression. Literal node references are parsed;
 * any access the parser cannot pin to a node (a computed key, a variable
 * passed to `$node`, the whole `results`, `$json` or `$input`) reads every
 * node in context. Over-reporting is the safe direction: a label is never
 * dropped because an expression was clever.
 */
/**
 * Names that reach the whole evaluation scope (or the global object) and so
 * every value in it: the sandbox evaluates inside `with (__scope)` in a
 * plain function, where `arguments[0]` and `__scope` are the scope itself.
 * Seeing one means the expression could read anything.
 */
const SCOPE_ESCAPES = /(?<![\w$])(arguments|__scope|this|globalThis|self|global|window|eval|Function|Reflect|Proxy|constructor|__proto__|__l2mRun)(?![\w$])/;
/** A computed property named like a scope escape (`x["constructor"]`). */
const ESCAPE_KEY = /\[\s*(["'`])\s*(constructor|__proto__|prototype)\s*\1\s*\]/;

/** Words after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER_WORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/** Words whose parenthesised header is followed by a statement, which may be a regular expression. */
const STATEMENT_HEADER_WORDS = new Set(["if", "while", "for", "with"]);

/**
 * Phase 16 — syntax the string blanking below cannot read safely: comments
 * (`/*`, `//`), anything that could be a regular expression literal (a quote
 * inside one pairs with a later quote and hides real code), unicode escapes,
 * and template literals holding `${ }`. A left-to-right scan that skips
 * string contents; seeing any of these means the references are not
 * understood, so the expression reads everything (fail closed).
 */
function hasOpaqueSyntax(source: string): boolean {
  let previous = "";
  let word = "";
  let gap = false;
  // One entry per open `(`: whether the word before it was `if`, `while`, `for` or `with`. After such a header's `)` a
  // `/` starts a regular expression statement, not a division.
  const parens: boolean[] = [];
  let closedHeader = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "(") parens.push(STATEMENT_HEADER_WORDS.has(word));
    else if (char === ")") closedHeader = parens.pop() ?? false;
    if (char === '"' || char === "'" || char === "`") {
      for (index += 1; index < source.length && source[index] !== char; index += 1) {
        if (source[index] === "\\") index += 1;
        else if (char === "`" && source[index] === "$" && source[index + 1] === "{") return true;
      }
      if (index >= source.length) return true;
      previous = char;
      word = "";
      gap = false;
      continue;
    }
    if (char === "\\") return true;
    if (char === "/") {
      const next = source[index + 1];
      if (next === "*" || next === "/") return true;
      const regexContext = (previous === ")" && closedHeader) || previous === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(previous) || REGEX_AFTER_WORDS.has(word);
      if (regexContext) return true;
      previous = char;
      word = "";
      gap = false;
      continue;
    }
    if (/\s/.test(char)) {
      gap = true;
      continue;
    }
    if (/[\w$]/.test(char)) {
      word = !gap && /[\w$]/.test(previous) ? word + char : char;
    } else {
      word = "";
    }
    gap = false;
    previous = char;
  }
  return false;
}

export function referencesInExpression(expression: string): TemplateReferences {
  const out: TemplateReferences = { nodes: [], all: false, heads: [] };
  const source = expression;
  // Comments, regular expressions, unicode escapes and `${ }` inside template literals hide code from the string
  // blanking below: not understood, so everything.
  if (hasOpaqueSyntax(source) || ESCAPE_KEY.test(source)) {
    out.all = true;
  }
  // String contents blanked out (same length, so indexes match the source): a root inside a string is not a read.
  // A spread (`...results`) is blanked too, so the root after it is seen as a root reading the whole value.
  const blanked = source
    .replace(STRING_LITERAL, (literal) => literal[0] + " ".repeat(literal.length - 2) + literal[literal.length - 1])
    .replace(/\.\.\./g, "   ");
  // Every occurrence of a data root, outside property access (`a.results` is not the root).
  const roots = /(?<![\w$.])(\$json|\$input|results|parent_outputs|\$node)(?![\w$])/g;
  for (const match of blanked.matchAll(roots)) {
    const root = match[1]!;
    let cursor = (match.index ?? 0) + root.length;
    while (source[cursor] === " " || source[cursor] === "\t" || source[cursor] === "\n") cursor += 1;
    const next = source[cursor];
    if (root === "$node") {
      if (next !== "(") {
        out.all = true;
        continue;
      }
      const argument = bracketArgument(source, cursor, "(", ")");
      const literal = argument === undefined ? undefined : literalValue(argument);
      if (literal) out.nodes.push(literal);
      else out.all = true;
      continue;
    }
    const segments: string[] = [];
    // Read a chain of `.name` / `["literal"]` accessors after the root.
    let dynamic = false;
    for (;;) {
      while (source[cursor] === " " || source[cursor] === "\t" || source[cursor] === "\n") cursor += 1;
      if (source[cursor] === "." || (source[cursor] === "?" && source[cursor + 1] === ".")) {
        cursor += source[cursor] === "?" ? 2 : 1;
        if (source[cursor] === "[") continue;
        const name = /^[A-Za-z_$][\w$-]*/.exec(source.slice(cursor));
        if (!name) break;
        segments.push(name[0]);
        cursor += name[0].length;
        if (segments.length >= 2) break;
        continue;
      }
      if (source[cursor] === "[") {
        const argument = bracketArgument(source, cursor, "[", "]");
        const literal = argument === undefined ? undefined : literalValue(argument);
        if (literal === undefined) {
          dynamic = true;
          break;
        }
        segments.push(literal);
        cursor += (argument?.length ?? 0) + 2;
        if (segments.length >= 2) break;
        continue;
      }
      break;
    }
    if (root === "$json" || root === "$input") {
      // `$json` is the node's whole input: a named field is a path, anything else reads everything.
      if (dynamic || segments.length === 0) {
        out.all = true;
        continue;
      }
      if ((segments[0] === "results" || segments[0] === "parent_outputs") && segments.length < 2) {
        if (segments[0] === "results") out.all = true;
        continue;
      }
      addPathReference(out, segments);
      continue;
    }
    if (root === "results") {
      if (dynamic || segments.length === 0) out.all = true;
      else out.nodes.push(segments[0]!);
      continue;
    }
    // parent_outputs: direct parents count anyway; a literal name is still recorded.
    if (!dynamic && segments[0]) out.nodes.push(segments[0]);
  }
  if (SCOPE_ESCAPES.test(blanked)) out.all = true;
  // Bare names outside string literals: run inputs such as `user_prompt` (`a.b` property names are skipped).
  const withoutStrings = blanked;
  for (const match of withoutStrings.matchAll(/(?<![\w$.])([A-Za-z_][\w$]*)(?![\w$])/g)) {
    const name = match[1]!;
    if (name === "results" || name === "parent_outputs" || NON_DATA_NAMES.has(name) || !IDENTIFIER.test(name)) continue;
    // An object literal key (`{ a: 1 }`) is not a read.
    const after = withoutStrings.slice((match.index ?? 0) + name.length).trimStart();
    const before = withoutStrings.slice(0, match.index ?? 0).trimEnd();
    if (after.startsWith(":") && !after.startsWith("::") && (before.endsWith("{") || before.endsWith(","))) continue;
    out.heads.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scanning node outputs for data classes (only on runs that track labels)
// ---------------------------------------------------------------------------

/** Most characters of one output scanned; the rest is not scanned. */
export const LABEL_SCAN_MAX_CHARS = 256 * 1024;

/**
 * The DLP data classes found in a node output: every string (and long
 * number) in it, joined and scanned with the runtime guard's DLP patterns
 * and the profiles' dictionaries (no capture-only detectors). Top-level
 * `_`-prefixed trace fields (telemetry, guard verdicts) are skipped.
 */
export function createLabelScanner(dictionaries: readonly GuardDictionary[], issuedSurrogates?: ReadonlySet<string>): (value: unknown) => string[] {
  return (value: unknown) => {
    const parts: string[] = [];
    let size = 0;
    const seen = new Set<unknown>();
    const visit = (current: unknown, depth: number, topLevel: boolean) => {
      if (size >= LABEL_SCAN_MAX_CHARS || depth > 32) return;
      if (typeof current === "string") {
        if (current.length === 0) return;
        const text = current.slice(0, LABEL_SCAN_MAX_CHARS - size);
        parts.push(text);
        size += text.length + 1;
        return;
      }
      if (typeof current === "number" && Number.isFinite(current) && Math.abs(current) >= 1e8) {
        const text = String(current);
        parts.push(text);
        size += text.length + 1;
        return;
      }
      if (!current || typeof current !== "object" || seen.has(current)) return;
      seen.add(current);
      if (Array.isArray(current)) {
        for (const item of current) visit(item, depth + 1, false);
        return;
      }
      for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
        if (topLevel && key.startsWith("_")) continue;
        visit(item, depth + 1, false);
      }
    };
    visit(value, 0, true);
    if (parts.length === 0) return [];
    const text = parts.join("\n");
    const found = scanDlp(text, { dictionaries: [...dictionaries] });
    // Phase 16 — a surrogate the run issued (or any `@surrogate.invalid` email) stands in for a value that is gone: its class left the labels.
    const matches = issuedSurrogates ? dropIssuedSurrogates(found, issuedSurrogates, text) : found;
    return [...new Set(matches.map((match) => String(match.dataClass)))].sort();
  };
}

// ---------------------------------------------------------------------------
// The run's label state and one node's scope
// ---------------------------------------------------------------------------

/** Globals that are not run input: workflow variables and the run's own bookkeeping. */
/** Run globals that are not the run's input (12.2: exported so an approval can tell what the input holds). */
export const NON_INPUT_GLOBALS: ReadonlySet<string> = new Set(["vars", "execution_id", "execution_custom_data", "trigger_type", "scheduled_at", "_loop_index"]);

export interface RunLabelOptions {
  /** Labels of the run's input (the trigger's provenance, or an Execute Workflow node's input labels). */
  input: DataLabels;
  /**
   * 12.2 — record input nodes' labels on their results even when the run does not track labels: the server
   * derived the input's trust from the trigger (verified auth, an admin's setting), and a replay must keep it.
   */
  recordInput?: boolean;
  /** Store labels and scan outputs for data classes (a guard profile asked for propagated labels). */
  tracked: boolean;
  /** Finds data classes in an output; used only when tracked. */
  scan?: (value: unknown) => string[];
}

/** 12.2 — a human approval that endorsed content: what it covers, and which nodes read it endorsed. */
interface ActiveEndorsement {
  /** The approving node. */
  nodeId: string;
  endorsement: LabelEndorsement;
  covered: ReadonlySet<string>;
  /** Nodes downstream of the approving node: only they read the covered outputs endorsed. */
  readers: ReadonlySet<string>;
  /** The approval request read the run input: readers' reads of the run input are endorsed too. */
  coversInput: boolean;
}

/** 12.2 — what an approval request showed the approver: the nodes its text read, and whether it read the run input. */
export interface ApprovalShown {
  nodeIds: string[];
  input: boolean;
}

export class RunLabelState {
  readonly input: DataLabels;
  readonly tracked: boolean;
  private readonly scan?: (value: unknown) => string[];
  private readonly nodes = new Map<string, DataLabels>();
  /** 12.2 — nodes whose labels go on their results although the run does not track labels. */
  private readonly recorded = new Set<string>();
  /** 12.2 — input nodes whose labels are recorded, with their type (it goes on their results). */
  private readonly inputTypes = new Map<string, string>();
  private readonly recordInput: boolean;
  private readonly endorsements: ActiveEndorsement[] = [];
  /** 12.2 — what the pending approval request showed, kept from the pause to the decision. */
  private shown?: ApprovalShown;
  /** The node whose output is the run's output, once known. */
  outputNodeId?: string;

  constructor(options: RunLabelOptions) {
    this.input = options.input;
    this.tracked = options.tracked;
    this.recordInput = options.recordInput === true;
    this.scan = options.tracked ? options.scan : undefined;
  }

  /**
   * A paused run's labels; it tracks when it did at the pause or does now (`trackedNow`). `readersOf` gives the
   * nodes downstream of an approving node, so its endorsement applies again after the resume.
   */
  static fromState(
    state: WorkflowExecutionState["dataLabels"],
    scan?: (value: unknown) => string[],
    trackedNow = false,
    readersOf: (nodeId: string) => ReadonlySet<string> = () => new Set()
  ): RunLabelState | undefined {
    if (!state) return undefined;
    const run = new RunLabelState({ input: parseStoredDataLabels(state.input) ?? emptyDataLabels(), tracked: state.tracked === true || trackedNow, scan });
    for (const [nodeId, labels] of Object.entries(state.nodes ?? {})) {
      const parsed = parseStoredDataLabels(labels);
      run.nodes.set(nodeId, parsed ?? emptyDataLabels());
    }
    for (const nodeId of state.recorded ?? []) if (typeof nodeId === "string") run.recorded.add(nodeId);
    for (const stored of state.endorsements ?? []) {
      const parsed = labelEndorsementSchema.safeParse(stored?.endorsement);
      if (!parsed.success || typeof stored.nodeId !== "string") continue;
      run.endorsements.push({
        nodeId: stored.nodeId,
        endorsement: parsed.data,
        covered: new Set(parsed.data.nodeIds),
        readers: readersOf(stored.nodeId),
        coversInput: stored.coversInput === true
      });
    }
    const shown = state.shown;
    if (shown && Array.isArray(shown.nodeIds)) {
      run.shown = { nodeIds: shown.nodeIds.filter((id): id is string => typeof id === "string"), input: shown.input === true };
    }
    const outputNodeId = (state as { outputNodeId?: unknown }).outputNodeId;
    if (typeof outputNodeId === "string") run.outputNodeId = outputNodeId;
    return run;
  }

  toState(): NonNullable<WorkflowExecutionState["dataLabels"]> & { outputNodeId?: string } {
    const nodes: NodeLabelMap = {};
    for (const [nodeId, labels] of this.nodes) if (!isEmptyDataLabels(labels)) nodes[nodeId] = labels;
    return {
      input: this.input,
      nodes,
      tracked: this.tracked,
      ...(this.recorded.size > 0 ? { recorded: [...this.recorded] } : {}),
      ...(this.endorsements.length > 0
        ? { endorsements: this.endorsements.map((entry) => ({ nodeId: entry.nodeId, endorsement: entry.endorsement, ...(entry.coversInput ? { coversInput: true } : {}) })) }
        : {}),
      ...(this.shown ? { shown: { nodeIds: [...this.shown.nodeIds], ...(this.shown.input ? { input: true } : {}) } } : {}),
      ...(this.outputNodeId ? { outputNodeId: this.outputNodeId } : {})
    };
  }

  /** 12.2 — the approval request the run pauses for showed this (replaces what an earlier request showed). */
  setShown(shown: ApprovalShown | undefined): void {
    this.shown = shown;
  }

  /** 12.2 — what the pending approval request showed, once: the decision consumes it. Nothing recorded: nothing shown. */
  takeShown(): ApprovalShown {
    const shown = this.shown ?? { nodeIds: [], input: false };
    this.shown = undefined;
    return shown;
  }

  /**
   * 12.2 — a paused run keeps its labels when it tracks them, or when it carries something a later check needs and
   * the resume could not rebuild: a declared sensitive output, a trigger trust, an endorsement, what a pending
   * approval request showed. Otherwise nothing new
   * is stored (a resume then counts the run's content as outside content, as before).
   */
  get persists(): boolean {
    const showsSomething = this.shown !== undefined && (this.shown.nodeIds.length > 0 || this.shown.input);
    return this.tracked || this.recordInput || this.recorded.size > 0 || this.endorsements.length > 0 || showsSomething;
  }

  /** The nodes that have labels so far. */
  nodeIds(): IterableIterator<string> {
    return this.nodes.keys();
  }

  has(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  get(nodeId: string): DataLabels | undefined {
    return this.nodes.get(nodeId);
  }

  /** 12.2 — a node's labels as `reader` reads them: endorsed when an approval upstream of the reader covered that node. */
  getFor(reader: string, nodeId: string): DataLabels | undefined {
    const labels = this.nodes.get(nodeId);
    if (!labels || this.endorsements.length === 0) return labels;
    return this.endorsements.some((entry) => entry.covered.has(nodeId) && entry.readers.has(reader)) ? endorseLabels(labels) : labels;
  }

  /** 12.2 — the run input's labels as `reader` reads them (endorsed when an approval upstream of it showed the trigger's input). */
  inputFor(reader: string): DataLabels {
    if (this.endorsements.length === 0) return this.input;
    return this.endorsements.some((entry) => entry.coversInput && entry.readers.has(reader)) ? endorseLabels(this.input) : this.input;
  }

  /**
   * 12.2 — a person approved at `nodeId`: the approving node's own output is endorsed (when covered), and nodes
   * downstream of it (`readers`) read the covered nodes' outputs endorsed, and the run input when `coversInput`
   * (the request read it). Covered nodes keep their own labels for every other reader. An endorsement that covers
   * nothing is only recorded.
   */
  endorse(nodeId: string, endorsement: LabelEndorsement, readers: ReadonlySet<string>, coversInput: boolean): void {
    const covered = new Set(endorsement.nodeIds);
    const own = this.nodes.get(nodeId);
    if (own && covered.has(nodeId)) this.nodes.set(nodeId, endorseLabels(own));
    this.endorsements.push({ nodeId, endorsement, covered, readers, coversInput });
    this.recorded.add(nodeId);
  }

  /** 12.2 — this node's labels go on its result even when the run does not track labels. */
  record(nodeId: string): void {
    this.recorded.add(nodeId);
  }

  /** 12.2 — an input node's labels go on its result, with its type, so a retry or replay can match them later. */
  recordInputNode(nodeId: string, nodeType: string): void {
    this.recorded.add(nodeId);
    this.inputTypes.set(nodeId, nodeType);
  }

  /** 12.2 — input nodes' labels are recorded on their results (see `recordInput`). */
  get recordsInput(): boolean {
    return this.recordInput;
  }

  set(nodeId: string, labels: DataLabels): void {
    this.nodes.set(nodeId, labels);
  }

  /** Every completed node's labels and the run input: what a dynamic read could have touched. */
  everything(): DataLabels {
    return unionLabels([this.input, ...this.nodes.values()]);
  }

  /**
   * The field a node result carries: its labels, on a tracked run (or for a node recorded on any run, 12.2) and only
   * when not empty, plus the endorsement it recorded.
   */
  resultField(nodeId: string): { labels?: DataLabels; endorsement?: LabelEndorsement; nodeType?: string } {
    let endorsement: LabelEndorsement | undefined;
    for (const entry of this.endorsements) if (entry.nodeId === nodeId) endorsement = entry.endorsement;
    const endorsed = endorsement ? { endorsement } : {};
    if (!this.tracked && !this.recorded.has(nodeId)) return endorsed;
    const labels = this.nodes.get(nodeId);
    if (!labels || isEmptyDataLabels(labels)) return endorsed;
    const nodeType = this.inputTypes.get(nodeId);
    return { labels, ...endorsed, ...(nodeType ? { nodeType } : {}) };
  }

  /** The run's data-class scanner, on tracked runs only (others never scan). */
  get scanner(): ((value: unknown) => string[]) | undefined {
    return this.scan;
  }

  /** The labels of a finished output: the base, minus declassified classes, plus what a scan finds (tracked runs only). */
  finalize(base: DataLabels, output: unknown, declassified: readonly string[] = []): DataLabels {
    let labels = withoutDataClasses(base, declassified);
    if (this.scan && output !== undefined) {
      const found = this.scan(output);
      if (found.length > 0) labels = unionLabels([labels, labelsOf([], found)]);
    }
    return labels;
  }

  /** A scope for one node about to run. */
  scope(input: { nodeId: string; nodeType: string; parents: ReadonlyArray<DataLabels | undefined>; merged?: Record<string, unknown>; globals?: Record<string, unknown> }): NodeLabelScope {
    return new NodeLabelScope(this, input);
  }
}

/** What a node (or one part of it) read: nodes named, everything in context, the run input. */
class Reads {
  readonly nodes = new Set<string>();
  all = false;
  input = false;
}

/**
 * One node's labels while it runs: its own source and parents, plus what
 * it reads through templates and what its handler adds or declassifies.
 * A node with no parent that ran (a root) reads the run input as well:
 * handlers read the run's globals directly.
 */
export class NodeLabelScope {
  readonly nodeId: string;
  readonly nodeType: string;
  readonly run: RunLabelState;
  private readonly base: DataLabels;
  private readonly merged: Record<string, unknown>;
  private readonly globals: Record<string, unknown>;
  private readonly reads = new Reads();
  /** Reads of named parts (an agent's user prompt), kept apart so a rewrite of that part can declassify it alone. */
  private readonly segments = new Map<string, Reads>();
  private target: Reads;
  private readonly added: DataLabels[] = [];
  private replaced?: DataLabels;
  private readonly declassified = new Set<string>();

  constructor(
    run: RunLabelState,
    input: { nodeId: string; nodeType: string; parents: ReadonlyArray<DataLabels | undefined>; merged?: Record<string, unknown>; globals?: Record<string, unknown> }
  ) {
    this.run = run;
    this.nodeId = input.nodeId;
    this.nodeType = input.nodeType;
    this.merged = input.merged ?? {};
    this.globals = input.globals ?? {};
    this.target = this.reads;
    const source = nodeContentSource(input.nodeType);
    if (source === "input" && run.recordsInput) run.recordInputNode(input.nodeId, input.nodeType);
    const own = source === "input" || input.parents.length === 0 ? run.inputFor(input.nodeId) : undefined;
    this.base = unionLabels([own, source === "external" ? labelsOf(["untrusted_external"]) : undefined, ...input.parents]);
  }

  /** A scope for a node this one runs on its behalf (a supervisor's worker), starting from the given labels. */
  child(nodeId: string, nodeType: string, start: DataLabels, globals?: Record<string, unknown>): NodeLabelScope {
    return new NodeLabelScope(this.run, { nodeId, nodeType, parents: [start], merged: this.merged, ...(globals ? { globals } : { globals: this.globals }) });
  }

  private applyReferences(references: TemplateReferences, reads: Reads = this.target): void {
    for (const nodeId of references.nodes) if (this.run.has(nodeId)) reads.nodes.add(nodeId);
    if (references.all) reads.all = true;
    if (reads.input) return;
    for (const head of references.heads) {
      // A parent's field is the parent's data (already counted); a run global is the run's input.
      if (Object.prototype.hasOwnProperty.call(this.merged, head)) continue;
      if (Object.prototype.hasOwnProperty.call(this.globals, head) && !NON_INPUT_GLOBALS.has(head)) {
        reads.input = true;
        return;
      }
    }
  }

  /** A simple `{{ a.b.c }}` path or a configured lookup path was read. */
  readPath(path: string): void {
    this.applyReferences(referencesInPath(path));
  }

  /** A `{{ expression }}` was evaluated. */
  readExpression(expression: string): void {
    this.applyReferences(referencesInExpression(expression));
  }

  /** The node could read anything in context (a code node, a save of the whole template data). */
  readEverything(): void {
    this.target.all = true;
    this.target.input = true;
  }

  /** The handler read the run's globals directly (the run input). */
  readRunInput(): void {
    this.target.input = true;
  }

  /**
   * Runs `body` with its reads recorded under `name` instead of the node's
   * other reads (they still count in `inputLabels`). Synchronous bodies only:
   * an await inside would let other reads land in the segment.
   */
  segment<T>(name: string, body: () => T): T {
    const previous = this.target;
    let reads = this.segments.get(name);
    if (!reads) {
      reads = new Reads();
      this.segments.set(name, reads);
    }
    this.target = reads;
    try {
      return body();
    } finally {
      this.target = previous;
    }
  }

  /** Like `segment`, for an asynchronous body: every read until it settles lands in the segment. */
  async segmentAsync<T>(name: string, body: () => Promise<T>): Promise<T> {
    const previous = this.target;
    let reads = this.segments.get(name);
    if (!reads) {
      reads = new Reads();
      this.segments.set(name, reads);
    }
    this.target = reads;
    try {
      return await body();
    } finally {
      this.target = previous;
    }
  }

  private labelsOfReads(reads: Reads): Array<DataLabels | undefined> {
    return [
      ...[...reads.nodes].map((nodeId) => this.run.getFor(this.nodeId, nodeId)),
      reads.all ? this.run.everything() : undefined,
      reads.input ? this.run.inputFor(this.nodeId) : undefined
    ];
  }

  /**
   * 12.2 — the labels of what one `{{ }}` body reads, without recording the read (it was recorded when it rendered):
   * the nodes it names, the run input, and the parents' data when it reads a parent's field.
   */
  labelsOfTemplateRead(body: string, simplePath: boolean): DataLabels {
    const references = simplePath ? referencesInPath(body) : referencesInExpression(body);
    const reads = new Reads();
    this.applyReferences(references, reads);
    const parentField = references.heads.some((head) => Object.prototype.hasOwnProperty.call(this.merged, head));
    return unionLabels([...this.labelsOfReads(reads), parentField ? this.base : undefined]);
  }

  /**
   * 12.2 — what one `{{ }}` body reads, as sources: the nodes it names, whether it reads the run input, and the
   * names it reads from the parents' merged item (the caller maps them to the parents that hold them).
   */
  sourcesOfTemplateRead(body: string, simplePath: boolean): { nodeIds: string[]; input: boolean; parentFields: string[] } {
    const references = simplePath ? referencesInPath(body) : referencesInExpression(body);
    const reads = new Reads();
    this.applyReferences(references, reads);
    if (reads.all) return { nodeIds: [...this.run.nodeIds()], input: true, parentFields: [] };
    const parentFields = references.heads.filter((head) => Object.prototype.hasOwnProperty.call(this.merged, head));
    return { nodeIds: [...reads.nodes], input: reads.input, parentFields };
  }

  /** The labels of what was read inside one segment (nothing else). */
  segmentLabels(name: string): DataLabels {
    const reads = this.segments.get(name);
    return reads ? unionLabels(this.labelsOfReads(reads)) : emptyDataLabels();
  }

  /** The node's input labels without the reads of the named segments. */
  inputLabelsExcept(names: readonly string[]): DataLabels {
    const skip = new Set(names);
    return unionLabels([
      this.base,
      ...this.labelsOfReads(this.reads),
      ...[...this.segments].filter(([name]) => !skip.has(name)).flatMap(([, reads]) => this.labelsOfReads(reads)),
      ...this.added
    ]);
  }

  /** Labels the handler learned at run time (memory it read, a fetched result). */
  add(labels: DataLabels | null | undefined): void {
    if (labels && !isEmptyDataLabels(labels)) this.added.push(labels);
  }

  /** The output's labels are exactly these (an agent's accumulation, a sub-workflow's output). */
  replace(labels: DataLabels): void {
    this.replaced = labels;
  }

  /** A guard redacted, masked or protected these classes in the output. */
  declassify(classes: readonly string[]): void {
    for (const name of classes) this.declassified.add(name);
  }

  /** The labels of what the node has read so far (its input). */
  inputLabels(): DataLabels {
    return this.inputLabelsExcept([]);
  }

  /** The labels before the output is scanned: input (or the replacement) minus declassified classes. */
  pendingLabels(): DataLabels {
    return withoutDataClasses(this.replaced ?? this.inputLabels(), [...this.declassified]);
  }

  /** The output's final labels (scanned on tracked runs). */
  finish(output: unknown): DataLabels {
    return this.run.finalize(this.replaced ?? this.inputLabels(), output, [...this.declassified]);
  }
}

// ---------------------------------------------------------------------------
// Recording template reads for the node that is running
// ---------------------------------------------------------------------------

const scopes = new AsyncLocalStorage<NodeLabelScope | undefined>();

/** Runs `body` with `scope` as the node whose template reads are recorded (none: reads are not recorded). */
export function runInLabelScope<T>(scope: NodeLabelScope | undefined, body: () => T): T {
  return scopes.run(scope, body);
}

export function currentLabelScope(): NodeLabelScope | undefined {
  return scopes.getStore();
}

/** Called by the template renderer for each `{{ }}` body it resolves. */
export function recordTemplateRead(body: string, simplePath: boolean): void {
  const scope = scopes.getStore();
  if (!scope) return;
  if (simplePath) scope.readPath(body);
  else scope.readExpression(body);
}
