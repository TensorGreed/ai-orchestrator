/**
 * Autocomplete for `{{ }}` in template fields, and the paths the Input pane's fields drag in. Suggestions come from the
 * last run (or pinned data): the fields of the steps connected straight into the node (`{{field}}`), what the node
 * received in the run (run input and context), workflow variables (`{{vars.KEY}}`), and any step of the workflow
 * (`{{results.<nodeId>.field}}`, shown with the step's label). Only paths a template can read as a path are offered:
 * each segment letters, digits, `_` or `-`, and list entries by index (`items.0.title`).
 */

export interface TemplateSuggestion {
  /** The text inside `{{ }}`. */
  path: string;
  /** Where the value comes from (a step's label, "Run input", "Variable"). */
  source: string;
  /** A short description of the value in the last run (`"text"`, `42`, `3 items`), when known. */
  detail?: string;
}

export interface TemplateSuggestStep {
  id: string;
  label: string;
  /** The step's output in the last run (or its pinned data); undefined when unknown. */
  output?: unknown;
}

export interface TemplateSuggestSources {
  /** Steps connected straight into the node. */
  parents: TemplateSuggestStep[];
  /** Every step of the workflow (the node itself included is fine: it is left out). */
  steps: TemplateSuggestStep[];
  /** The node's own id. */
  nodeId: string;
  /** What the node received in the last run, when it ran. */
  input?: unknown;
  vars?: Record<string, unknown>;
  /** Keys the runtime adds for its own bookkeeping, left out. */
  isInternalKey?: (key: string) => boolean;
}

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const MAX_DEPTH = 4;
const MAX_PER_SOURCE = 200;
/** Keys of a node's recorded input that are not fields a template should read directly. */
const INPUT_SKIP_KEYS = new Set(["parent_outputs", "results", "$workflow", "$execution"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A short description of a value: the text (clipped), the number, `3 items`, `{…}`. */
export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return JSON.stringify(value.length > 24 ? `${value.slice(0, 23)}…` : value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") return "{…}";
  return typeof value;
}

/** Appends `key` to a template path, or undefined when the key cannot be read as a path segment. */
export function joinTemplatePath(base: string, key: string | number): string | undefined {
  const segment = String(key);
  if (!SEGMENT.test(segment)) return undefined;
  return base ? `${base}.${segment}` : segment;
}

/** The text a field dragged from run data inserts: `{{path}}`. */
export function templateForPath(path: string): string {
  return `{{${path}}}`;
}

function collectPaths(
  value: unknown,
  base: string,
  source: string,
  out: TemplateSuggestion[],
  isInternalKey: (key: string) => boolean,
  depth = 0,
  budget = { left: MAX_PER_SOURCE }
): void {
  if (depth >= MAX_DEPTH || budget.left <= 0) return;
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    const path = joinTemplatePath(base, 0);
    if (!path) return;
    budget.left -= 1;
    out.push({ path, source, detail: describeValue(value[0]) });
    collectPaths(value[0], path, source, out, isInternalKey, depth + 1, budget);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (budget.left <= 0) return;
    if (depth === 0 && isInternalKey(key)) continue;
    const path = joinTemplatePath(base, key);
    if (!path) continue;
    budget.left -= 1;
    out.push({ path, source, detail: describeValue(child) });
    collectPaths(child, path, source, out, isInternalKey, depth + 1, budget);
  }
}

/** Every suggestion for a node's template fields, nearest data first, without duplicate paths. */
export function buildTemplateSuggestions(sources: TemplateSuggestSources): TemplateSuggestion[] {
  const isInternalKey = sources.isInternalKey ?? (() => false);
  const out: TemplateSuggestion[] = [];
  const parentIds = new Set(sources.parents.map((parent) => parent.id));
  // Fields of the steps connected straight in: `{{field}}`. Only an object's fields are spread into the input: a
  // step whose output is a list (or a single value) is read by its id (`{{<id>.0.title}}`).
  for (const parent of sources.parents) {
    const base = isRecord(parent.output) ? "" : joinTemplatePath("", parent.id);
    if (base === undefined) continue;
    collectPaths(parent.output, base, parent.label, out, isInternalKey);
  }
  // What the node received in the run besides its parents' fields: run input (webhook body, prompt) and context.
  if (isRecord(sources.input)) {
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sources.input)) {
      if (INPUT_SKIP_KEYS.has(key) || parentIds.has(key)) continue;
      rest[key] = value;
    }
    collectPaths(rest, "", "Run input", out, isInternalKey);
  }
  for (const [key, value] of Object.entries(sources.vars ?? {})) {
    const path = joinTemplatePath("vars", key);
    if (path) out.push({ path, source: "Variable", detail: describeValue(value) });
  }
  out.push({ path: "$json", source: "This step's input", detail: "{…}" });
  // Any step: `{{results.<id>.field}}`, labelled with the step's name.
  for (const step of sources.steps) {
    if (step.id === sources.nodeId) continue;
    const root = joinTemplatePath("results", step.id);
    if (!root) continue;
    out.push({ path: root, source: step.label, detail: step.output === undefined ? "no run data yet" : describeValue(step.output) });
    collectPaths(step.output, root, step.label, out, isInternalKey);
  }
  const seen = new Set<string>();
  return out.filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  });
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * A template path as JavaScript under `root`: `items.0.title` is `$json.items[0].title`, and a key that is not a
 * name is quoted (`$json.headers["content-type"]`), since an expression reads `.0` and `-` differently from a path.
 */
export function expressionPath(root: string, path: string): string {
  let out = root;
  for (const segment of path.split(".")) {
    if (/^\d+$/.test(segment)) out += `[${segment}]`;
    else if (IDENTIFIER.test(segment)) out += `.${segment}`;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}

/** The `{{ }}` token being typed at the caret: the range to replace and the text typed so far. */
export interface TemplateToken {
  from: number;
  to: number;
  query: string;
}

const TOKEN_CHAR = /[A-Za-z0-9_.$-]/;

/** The path being typed inside an open `{{` at `caret`, or null when the caret is not inside one. */
export function templateTokenAt(text: string, caret: number): TemplateToken | null {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf("{{");
  if (open < 0) return null;
  if (before.indexOf("}}", open + 2) >= 0) return null;
  let from = caret;
  while (from > open + 2 && TOKEN_CHAR.test(text[from - 1]!)) from -= 1;
  let to = caret;
  while (to < text.length && TOKEN_CHAR.test(text[to]!)) to += 1;
  return { from, to, query: text.slice(from, caret) };
}

/**
 * The suggestions for what was typed, best first: paths that start with it, then paths with a segment that starts
 * with it, then paths or sources that contain it. With nothing typed, the shortest paths first. `$json.` offers the
 * node's own input fields under `$json`.
 */
export function rankTemplateSuggestions(all: TemplateSuggestion[], query: string, limit = 50): TemplateSuggestion[] {
  let pool = all;
  let needle = query;
  if (query.startsWith("$json.")) {
    const direct = all.filter((entry) => !entry.path.startsWith("results.") && !entry.path.startsWith("$"));
    pool = direct.map((entry) => ({ ...entry, path: expressionPath("$json", entry.path) }));
  }
  needle = needle.toLowerCase();
  const scored: Array<{ entry: TemplateSuggestion; score: number; depth: number; index: number }> = [];
  pool.forEach((entry, index) => {
    const path = entry.path.toLowerCase();
    let score: number;
    if (!needle) score = 0;
    else if (path.startsWith(needle)) score = 0;
    else if (path.includes(`.${needle}`)) score = 1;
    else if (path.includes(needle)) score = 2;
    else if (entry.source.toLowerCase().includes(needle)) score = 3;
    else return;
    if (path === needle) return;
    scored.push({ entry, score, depth: entry.path.split(".").length, index });
  });
  scored.sort((a, b) => a.score - b.score || (needle ? 0 : a.depth - b.depth) || a.index - b.index);
  return scored.slice(0, limit).map((item) => item.entry);
}

/**
 * Puts `path` in place of the token, and closes the `{{ }}` when nothing after the caret closes it. Returns the
 * new text and the caret position after the insert.
 */
export function applyTemplateSuggestion(text: string, token: TemplateToken, path: string): { text: string; caret: number } {
  const after = text.slice(token.to);
  const nextOpen = after.indexOf("{{");
  const nextClose = after.indexOf("}}");
  const closed = nextClose >= 0 && (nextOpen < 0 || nextClose < nextOpen);
  const open = text.lastIndexOf("{{", token.from);
  const spaced = open >= 0 && text[open + 2] === " ";
  const closing = closed ? "" : spaced ? " }}" : "}}";
  const next = `${text.slice(0, token.from)}${path}${closing}${after}`;
  return { text: next, caret: token.from + path.length + closing.length };
}
