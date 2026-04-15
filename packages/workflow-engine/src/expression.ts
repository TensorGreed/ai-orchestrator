/**
 * Lightweight, hand-rolled expression engine for workflow templates.
 *
 * Supports `{{ expression }}` syntax with JavaScript-like evaluation in a
 * sandboxed scope. Provides built-in variables ($input, $json, $node,
 * $workflow, $execution, $env, $vars, $now, $today, $itemIndex) and helper
 * functions ($if, $ifEmpty, $jmespath).
 *
 * Security notes:
 *   - process / require / global / Function / eval / globalThis are stripped
 *     from the evaluation scope by passing `undefined`.
 *   - $env exposes a curated subset rather than `process.env` directly.
 */
export interface ExpressionContext {
  $input?: unknown;
  $json?: unknown;
  $workflow?: { id?: string; name?: string };
  $execution?: { id?: string; customData?: Record<string, unknown> };
  $vars?: Record<string, unknown>;
  $env?: Record<string, string | undefined>;
  $itemIndex?: number;
  /** Map of node name to its output. */
  $nodeOutputs?: Record<string, unknown>;
  /** Extra root-level variables exposed verbatim (e.g. `text`, `answer`). */
  extras?: Record<string, unknown>;
}

interface SandboxScope extends Record<string, unknown> {
  $input: unknown;
  $json: unknown;
  $workflow: { id: string; name: string };
  $execution: { id: string; customData: Record<string, unknown> };
  $env: Record<string, string | undefined>;
  $vars: Record<string, unknown>;
  $now: Date;
  $today: Date;
  $itemIndex: number;
  $node: (name: string) => { output: unknown };
  $if: (cond: unknown, a: unknown, b: unknown) => unknown;
  $ifEmpty: (value: unknown, fallback: unknown) => unknown;
  $jmespath: (input: unknown, path: string) => unknown;
}

const DEFAULT_SAFE_ENV_KEYS = [
  "NODE_ENV",
  "TZ",
  "LANG",
  "LC_ALL"
];

function buildSafeEnv(provided?: Record<string, string | undefined>): Record<string, string | undefined> {
  if (provided) return { ...provided };
  const env: Record<string, string | undefined> = {};
  for (const key of DEFAULT_SAFE_ENV_KEYS) {
    if (typeof process !== "undefined" && process.env && key in process.env) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

/**
 * Tiny JMESPath-like evaluator.
 * Supports: dot paths (`a.b.c`), array indexing (`a[0]`), wildcard (`a[*].b`),
 * filter expressions (`a[?field=='val']` and `a[?field==1]`).
 */
export function jmespath(input: unknown, path: string): unknown {
  if (input == null || !path) return input;
  const tokens = tokenizeJmesPath(path);
  let current: unknown = input;
  for (const token of tokens) {
    if (current == null) return undefined;
    current = applyJmesToken(current, token);
  }
  return current;
}

type JmesToken =
  | { kind: "key"; name: string }
  | { kind: "index"; index: number }
  | { kind: "wildcard" }
  | { kind: "filter"; field: string; op: "=="; value: string | number | boolean | null };

function tokenizeJmesPath(path: string): JmesToken[] {
  const tokens: JmesToken[] = [];
  let i = 0;
  let buffer = "";
  const flushBuffer = () => {
    if (buffer.length > 0) {
      tokens.push({ kind: "key", name: buffer });
      buffer = "";
    }
  };
  while (i < path.length) {
    const c = path[i];
    if (c === ".") {
      flushBuffer();
      i++;
      continue;
    }
    if (c === "[") {
      flushBuffer();
      const close = path.indexOf("]", i);
      if (close === -1) throw new Error(`jmespath: unclosed bracket in '${path}'`);
      const inner = path.slice(i + 1, close).trim();
      if (inner === "*") {
        tokens.push({ kind: "wildcard" });
      } else if (inner.startsWith("?")) {
        const filter = inner.slice(1).trim();
        const m = filter.match(/^([A-Za-z_$][\w$]*)\s*==\s*(.+)$/);
        if (!m) throw new Error(`jmespath: unsupported filter '${filter}'`);
        const field = m[1];
        const rawValue = m[2].trim();
        let value: string | number | boolean | null;
        if ((rawValue.startsWith("'") && rawValue.endsWith("'")) ||
            (rawValue.startsWith('"') && rawValue.endsWith('"'))) {
          value = rawValue.slice(1, -1);
        } else if (rawValue === "true") value = true;
        else if (rawValue === "false") value = false;
        else if (rawValue === "null") value = null;
        else if (!Number.isNaN(Number(rawValue))) value = Number(rawValue);
        else value = rawValue;
        tokens.push({ kind: "filter", field, op: "==", value });
      } else if (/^-?\d+$/.test(inner)) {
        tokens.push({ kind: "index", index: Number(inner) });
      } else {
        throw new Error(`jmespath: unsupported bracket expr '[${inner}]'`);
      }
      i = close + 1;
      continue;
    }
    buffer += c;
    i++;
  }
  flushBuffer();
  return tokens;
}

function applyJmesToken(current: unknown, token: JmesToken): unknown {
  if (token.kind === "key") {
    if (Array.isArray(current)) {
      return current.map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>)[token.name] : undefined));
    }
    if (current && typeof current === "object") {
      return (current as Record<string, unknown>)[token.name];
    }
    return undefined;
  }
  if (token.kind === "index") {
    if (Array.isArray(current)) {
      const idx = token.index < 0 ? current.length + token.index : token.index;
      return current[idx];
    }
    return undefined;
  }
  if (token.kind === "wildcard") {
    if (Array.isArray(current)) return current.slice();
    if (current && typeof current === "object") return Object.values(current);
    return [];
  }
  if (token.kind === "filter") {
    if (!Array.isArray(current)) return [];
    return current.filter((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const fieldValue = (entry as Record<string, unknown>)[token.field];
      // eslint-disable-next-line eqeqeq
      return fieldValue == token.value;
    });
  }
  return undefined;
}

function buildScope(context: ExpressionContext): SandboxScope {
  const nodeOutputs = context.$nodeOutputs ?? {};
  const $node = (name: string) => ({
    output: nodeOutputs[name]
  });
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const scope: SandboxScope = {
    $input: context.$input,
    $json: context.$json ?? context.$input,
    $workflow: { id: context.$workflow?.id ?? "", name: context.$workflow?.name ?? "" },
    $execution: {
      id: context.$execution?.id ?? "",
      customData: context.$execution?.customData ?? {}
    },
    $env: buildSafeEnv(context.$env),
    $vars: context.$vars ?? {},
    $now: now,
    $today: today,
    $itemIndex: context.$itemIndex ?? 0,
    $node,
    $if: (cond, a, b) => (cond ? a : b),
    $ifEmpty: (value, fallback) => (isEmpty(value) ? fallback : value),
    $jmespath: jmespath
  };

  if (context.extras) {
    for (const [key, value] of Object.entries(context.extras)) {
      if (!(key in scope)) {
        scope[key] = value;
      }
    }
  }

  // Explicitly block dangerous globals so a `with` scope cannot reach them.
  scope.process = undefined;
  scope.require = undefined;
  scope.global = undefined;
  scope.globalThis = undefined;
  scope.Function = undefined;
  scope.eval = undefined;

  return scope;
}

const evaluatorCache = new Map<string, (scope: Record<string, unknown>) => unknown>();

function compileExpression(expression: string): (scope: Record<string, unknown>) => unknown {
  const cached = evaluatorCache.get(expression);
  if (cached) return cached;
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "__scope",
    `with (__scope) { return (${expression}); }`
  ) as (scope: Record<string, unknown>) => unknown;
  evaluatorCache.set(expression, fn);
  return fn;
}

export function evaluateExpression(expression: string, context: ExpressionContext): unknown {
  const trimmed = expression.trim();
  if (!trimmed) return undefined;
  const scope = buildScope(context);
  try {
    return compileExpression(trimmed)(scope);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Expression evaluation failed for '${trimmed}': ${message}`);
  }
}

const TEMPLATE_REGEX = /{{\s*([\s\S]+?)\s*}}/g;

function stringifyResult(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function renderExpressionTemplate(template: string, context: ExpressionContext): string {
  if (typeof template !== "string" || !template.includes("{{")) return template;
  return template.replace(TEMPLATE_REGEX, (_match, expr: string) => {
    try {
      const result = evaluateExpression(expr, context);
      return stringifyResult(result);
    } catch {
      return "";
    }
  });
}

/**
 * True if a `{{...}}` template body is non-trivial JS (contains operators,
 * parentheses, brackets, comparison, or starts with `$`). Otherwise the
 * existing simple `a.b.c` path lookup is sufficient.
 */
export function isComplexExpression(expr: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("$")) return true;
  if (/[()[\]+\-*/%!<>=?:,'"`]/.test(trimmed)) return true;
  return false;
}
