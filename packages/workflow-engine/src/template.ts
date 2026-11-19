import { withExpressionEvaluator, isComplexExpression, type ExpressionContext } from "./expression";
import { isExpressionSandboxFailure, toSandboxJson } from "./expression-sandbox";
import { recordTemplateRead } from "./data-labels";

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const TEMPLATE_BODY = /{{\s*([\s\S]+?)\s*}}/g;
const SIMPLE_PATH = /^[A-Za-z0-9_.-]+$/;

function expressionContextFor(values: Record<string, unknown>): ExpressionContext {
  const workflowContext = toRecord(values.$workflow ?? values.workflow);
  const executionContext = toRecord(values.$execution ?? values.execution);
  return {
    $input: values,
    $json: values,
    $workflow: {
      id: typeof workflowContext.id === "string" ? workflowContext.id : "",
      name: typeof workflowContext.name === "string" ? workflowContext.name : ""
    },
    $execution: {
      id: typeof executionContext.id === "string" ? executionContext.id : "",
      customData: toRecord(executionContext.customData)
    },
    $vars: (values.vars && typeof values.vars === "object" ? values.vars : {}) as Record<string, unknown>,
    // `$node('id')` reads what `results.id` reads: any completed node (the same object, so it is sent to the sandbox once).
    $nodeOutputs: toRecord(values.results),
    extras: values
  };
}

/**
 * 12.2 — one piece of a rendered template: literal text the author wrote, or what one `{{ }}` rendered to (with
 * its body, so the caller can tell which data it came from).
 */
export type TemplatePiece = { text: string; body?: undefined } | { text: string; body: string; simplePath: boolean };

export function renderTemplateAdvanced(
  template: string,
  values: Record<string, unknown>,
  options: { pieces?: TemplatePiece[] } = {}
): { rendered: string; unresolvedKeys: string[] } {
  const render = (evaluate: ((expression: string) => unknown) | null) => {
    const unresolvedKeys: string[] = [];
    const pieces = options.pieces;
    if (pieces) pieces.length = 0;
    let last = 0;
    // Match either a simple dotted-path token (back-compat) or any {{ ... }} body.
    const rendered = template.replace(TEMPLATE_BODY, (match, body: string, offset: number) => {
      if (!pieces) return renderBody(body);
      if (offset > last) pieces.push({ text: template.slice(last, offset) });
      last = offset + match.length;
      const text = renderBody(body);
      const trimmed = body.trim();
      pieces.push({ text, body: trimmed, simplePath: SIMPLE_PATH.test(trimmed) });
      return text;
    });
    if (pieces && last < template.length) pieces.push({ text: template.slice(last) });
    return { rendered, unresolvedKeys };

    function renderBody(body: string): string {
      const trimmed = body.trim();
      // Simple a.b.c path — preserve original behavior + unresolved tracking.
      if (SIMPLE_PATH.test(trimmed)) {
        // Phase 16 — the running node read this path (its labels follow).
        recordTemplateRead(trimmed, true);
        const value = resolvePath(values, trimmed);
        if (value === undefined || value === null) {
          unresolvedKeys.push(trimmed);
          return "";
        }
        if (typeof value === "string") return value;
        return JSON.stringify(value);
      }
      // Otherwise — treat as a JS expression in the sandbox.
      if (evaluate && isComplexExpression(trimmed)) {
        recordTemplateRead(trimmed, false);
        try {
          const result = evaluate(trimmed);
          if (result === undefined || result === null) return "";
          if (typeof result === "string") return result;
          if (typeof result === "number" || typeof result === "boolean") return String(result);
          try { return JSON.stringify(result); } catch { return String(result); }
        } catch (error) {
          // The expression's own error or timeout renders "". A sandbox failure fails the node instead:
          // an IF or Switch must never branch on a value that silently lost its expression.
          if (isExpressionSandboxFailure(error)) throw error;
          return "";
        }
      }
      return "";
    }
  };
  // Only open a sandbox session when the template has an expression; all of them share it.
  const hasExpression = [...template.matchAll(TEMPLATE_BODY)].some((match) => {
    const trimmed = (match[1] ?? "").trim();
    return !SIMPLE_PATH.test(trimmed) && isComplexExpression(trimmed);
  });
  if (!hasExpression) return render(null);
  // A session that cannot start throws ExpressionSandboxError (retryable when no instance was ready).
  return withExpressionEvaluator(expressionContextFor(values), render);
}

export function renderTemplate(template: string, values: Record<string, unknown>, options: { pieces?: TemplatePiece[] } = {}): string {
  return renderTemplateAdvanced(template, values, options).rendered;
}

const SINGLE_TEMPLATE = /^\s*{{\s*([\s\S]+?)\s*}}\s*$/;

/**
 * A template's value with its type kept. A template that is one `{{ }}` (spaces around it allowed) gives what the
 * path or expression gives: a number, boolean, object, list or text, or `undefined` when it is missing or the
 * expression fails (which `renderTemplate` renders as ""). Any other template is rendered to text.
 */
export function renderTemplateValue(template: string, values: Record<string, unknown>): { single: true; value: unknown } | { single: false; rendered: string } {
  const match = SINGLE_TEMPLATE.exec(template);
  const body = match ? (match[1] ?? "").trim() : "";
  // `{{a}} {{b}}` also matches the pattern above: one `{{ }}` only.
  if (!match || body.includes("{{") || body.includes("}}")) return { single: false, rendered: renderTemplate(template, values) };
  if (SIMPLE_PATH.test(body)) {
    recordTemplateRead(body, true);
    const value = resolvePath(values, body);
    return { single: true, value: value === null ? undefined : value };
  }
  if (!isComplexExpression(body)) return { single: true, value: undefined };
  recordTemplateRead(body, false);
  return withExpressionEvaluator(expressionContextFor(values), (evaluate) => {
    try {
      const value = evaluate(body);
      return { single: true as const, value: value === null ? undefined : value };
    } catch (error) {
      if (isExpressionSandboxFailure(error)) throw error;
      return { single: true as const, value: undefined };
    }
  });
}

/** The truthiness an IF node has always used for its rendered condition. */
function isTruthyConditionText(text: string): boolean {
  return Boolean(text) && text !== "false" && text !== "0" && text !== "null" && text !== "undefined";
}

function stringifyConditionValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value) ?? ""; } catch { return String(value); }
}

/** Words in a condition's own text that read no data. */
const CONDITION_KEYWORDS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity", "typeof", "instanceof", "in", "void", "new"]);

/** True when a condition's text outside its `{{ }}` names something (a variable, `$json`, `results`), not only operators and literals. */
function conditionTextReadsData(outside: string): boolean {
  // A template literal can hold code in `${ }`: counted as a read rather than parsed.
  if (outside.includes("`")) return true;
  const code = outside.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "");
  for (const word of code.match(/[A-Za-z_$][\w$]*/g) ?? []) if (!CONDITION_KEYWORDS.has(word)) return true;
  return false;
}

/**
 * What kind of error a failed condition hit (`SyntaxError`, `ReferenceError`, `TypeError`, a timeout), read from the
 * sandbox's message, which is not repeated: a guest message may hold values.
 */
function conditionErrorKind(error: unknown, expression: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = `Expression evaluation failed for '${expression.trim()}': `;
  const inner = message.startsWith(prefix) ? message.slice(prefix.length) : "";
  if (/^timed out/.test(inner)) return "it timed out";
  if (/SyntaxError|unexpected|expecting|unterminated|invalid (?:token|regular|number)/i.test(inner)) return "SyntaxError";
  if (/ReferenceError|is not defined/i.test(inner)) return "ReferenceError";
  if (/TypeError|cannot read|not a function|not an object|cannot convert/i.test(inner)) return "TypeError";
  return "an error";
}

/**
 * An IF node's condition. A condition that is one `{{ }}` (or plain text) renders and is judged by its text, as
 * before. A condition with text outside its `{{ }}`, such as `{{userScore}} > 90` or `{{answer}} === 'true'`, is
 * one JavaScript expression: each `{{ }}` becomes its value (a number stays a number, a string a string, a
 * missing value `undefined`) and the whole expression runs in the expression sandbox. Values go in as JSON literals
 * in the form the sandbox gets all its data (Dates as ISO text, cycles and BigInts as text), never as code, so a
 * value cannot change the expression. A
 * condition that fails (not a valid expression once filled in, an error while it runs, a timeout) throws after the
 * sandbox session has closed, so it fails the node without counting as a sandbox crash; the error names the
 * condition and the error's class, not values.
 */
export function evaluateConditionTemplate(template: string, values: Record<string, unknown>): { result: boolean; evaluatedValue: string } {
  const matches = [...template.matchAll(TEMPLATE_BODY)];
  const outside = template.replace(TEMPLATE_BODY, " ");
  if (matches.length === 0 || !outside.trim()) {
    const evaluated = renderTemplate(template, values).trim();
    return { result: isTruthyConditionText(evaluated), evaluatedValue: evaluated };
  }
  // Text outside the braces that names data reads it as a computed expression does (its labels follow).
  if (conditionTextReadsData(outside)) recordTemplateRead(template.replace(TEMPLATE_BODY, " 0 ").trim(), false);
  const outcome = withExpressionEvaluator(expressionContextFor(values), (evaluate): { ok: true; value: unknown } | { ok: false; kind: string } => {
    let expression = "";
    let last = 0;
    for (const match of matches) {
      const offset = match.index ?? 0;
      expression += template.slice(last, offset);
      last = offset + match[0].length;
      const body = (match[1] ?? "").trim();
      let value: unknown;
      if (SIMPLE_PATH.test(body)) {
        recordTemplateRead(body, true);
        value = resolvePath(values, body);
      } else {
        recordTemplateRead(body, false);
        try {
          value = evaluate(body);
        } catch (error) {
          if (isExpressionSandboxFailure(error)) throw error;
          value = undefined;
        }
      }
      expression += value === undefined ? " (undefined) " : ` (${toSandboxJson(value)}) `;
    }
    expression += template.slice(last);
    // On lines of its own inside parentheses, so a trailing `//` comment ends before the sandbox closes the expression.
    expression = `(\n${expression}\n)`;
    try {
      return { ok: true, value: evaluate(expression) };
    } catch (error) {
      if (isExpressionSandboxFailure(error)) throw error;
      return { ok: false, kind: conditionErrorKind(error, expression) };
    }
  });
  if (!outcome.ok) {
    throw new Error(
      `IF condition '${template}' could not be evaluated once its {{ }} values were filled in (${outcome.kind}). ` +
        "Text outside {{ }} is evaluated as JavaScript: quote text values, for example {{status}} === 'done', " +
        "or put the whole condition inside one {{ }}."
    );
  }
  const evaluatedValue = stringifyConditionValue(outcome.value).trim();
  return { result: isTruthyConditionText(evaluatedValue), evaluatedValue };
}

function resolvePath(values: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = values;

  for (const segment of segments) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

export function tryParseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Phase 16 — the renderings an outbound check already judged, bound to the
 * template data the handler renders with: the handler sends exactly what was
 * checked (an expression with `Math.random()` or `new Date()` is never
 * evaluated a second time) and a value that came from data is never rendered
 * again. Keys are template texts; values are their checked renderings.
 */
const checkedRenderings = new WeakMap<Record<string, unknown>, ReadonlyMap<string, string>>();

export function bindCheckedRenderings(values: Record<string, unknown>, renderings: ReadonlyMap<string, string>): void {
  checkedRenderings.set(values, renderings);
}

/**
 * `renderTemplate` for connector handlers: the checked rendering when there
 * is one. After a check, a template it did not render fails closed (it is
 * never rendered a second time, so nothing unchecked is sent); without a
 * check, a fresh rendering as before.
 */
export function renderCheckedTemplate(template: string, values: Record<string, unknown>): string {
  const renderings = checkedRenderings.get(values);
  if (!renderings) return renderTemplate(template, values);
  const checked = renderings.get(template);
  if (checked !== undefined) return checked;
  if (template.includes("{{")) {
    throw new Error("A templated setting was not checked by the content rules before sending, so the request was not sent.");
  }
  return template;
}
