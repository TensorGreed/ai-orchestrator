/**
 * Lightweight, hand-rolled expression engine for workflow templates.
 *
 * Supports `{{ expression }}` syntax with JavaScript-like evaluation in a
 * sandboxed scope. Provides built-in variables ($input, $json, $node,
 * $workflow, $execution, $env, $vars, $now, $today, $itemIndex) and helper
 * functions ($if, $ifEmpty, $jmespath).
 *
 * Security notes:
 *   - Expressions run in an isolated realm with no host objects (see
 *     expression-sandbox.ts) and a time limit; data goes in and out as JSON.
 *   - process / require / global / Function / eval / globalThis are also
 *     shadowed in the evaluation scope.
 *   - $env exposes a curated subset rather than `process.env` directly.
 */
import {
  JMESPATH_SOURCE,
  evaluateInSandbox,
  serializeExpressionPayload,
  type SandboxExpressionPayload
} from "./expression-sandbox";

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

/**
 * Tiny JMESPath-like evaluator.
 * Supports: dot paths (`a.b.c`), array indexing (`a[0]`), wildcard (`a[*].b`),
 * filter expressions (`a[?field=='val']` and `a[?field==1]`).
 * Built from the same source the expression sandbox uses as `$jmespath`.
 */
// eslint-disable-next-line no-new-func
export const jmespath = new Function(`return (${JMESPATH_SOURCE});`)() as (input: unknown, path: string) => unknown;

/** The payload the sandbox builds `$input`, `$json`, `$node()`, `$vars` and the rest from. */
function payloadFor(context: ExpressionContext): SandboxExpressionPayload {
  return {
    input: context.$input,
    json: context.$json ?? context.$input,
    extras: context.extras,
    workflow: { id: context.$workflow?.id ?? "", name: context.$workflow?.name ?? "" },
    execution: { id: context.$execution?.id ?? "", customData: context.$execution?.customData ?? {} },
    env: buildSafeEnv(context.$env),
    vars: context.$vars ?? {},
    itemIndex: context.$itemIndex ?? 0,
    nodeOutputs: context.$nodeOutputs ?? {}
  };
}

/**
 * An evaluator bound to one context: the context is serialized for the
 * sandbox once, on the first evaluation, and reused for the rest (a template
 * with several expressions).
 */
export function createExpressionEvaluator(context: ExpressionContext): (expression: string) => unknown {
  let serialized: string | null = null;
  return (expression: string) => {
    const trimmed = expression.trim();
    if (!trimmed) return undefined;
    try {
      serialized ??= serializeExpressionPayload(payloadFor(context));
      return evaluateInSandbox(trimmed, serialized);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Expression evaluation failed for '${trimmed}': ${message}`);
    }
  };
}

export function evaluateExpression(expression: string, context: ExpressionContext): unknown {
  return createExpressionEvaluator(context)(expression);
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
  const evaluate = createExpressionEvaluator(context);
  return template.replace(TEMPLATE_REGEX, (_match, expr: string) => {
    try {
      const result = evaluate(expr);
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
