import { withExpressionEvaluator, isComplexExpression, type ExpressionContext } from "./expression";
import { isExpressionSandboxFailure, toSandboxJson } from "./expression-sandbox";
import { AsyncLocalStorage } from "node:async_hooks";
import { ErrorCategory, TEMPLATE_VALUE_MISSING_ERROR_CODE, WorkflowError } from "@ai-orchestrator/shared";
import { recordTemplateRead } from "./data-labels";

// ---------------------------------------------------------------------------
// Strict templates (the workflow setting `strictTemplates`)
// ---------------------------------------------------------------------------

/** The error code a node fails with when strict templates are on and a `{{ }}` has no value. */
export const TEMPLATE_VALUE_MISSING_CODE = TEMPLATE_VALUE_MISSING_ERROR_CODE;

/**
 * The run's optional prompt fields. Nodes read them through default templates (`{{system_prompt}}`,
 * `{{session_id}}`) and fall back when they are empty, so a run without them still renders them empty.
 */
const OPTIONAL_RUN_FIELDS = new Set(["system_prompt", "user_prompt", "session_id"]);

/**
 * A `{{ }}` rendered nothing while strict templates are on: its path has no value, or its expression returned
 * nothing or failed. The message names the template body (which the author wrote), never a value. A WorkflowError
 * that is not retryable, with `metadata.code` `template_value_missing`, so handlers that pass WorkflowErrors on keep
 * it as it is and the run reports the code.
 */
export class TemplateValueMissingError extends WorkflowError {
  readonly code = TEMPLATE_VALUE_MISSING_CODE;
  /** A worker's template that has no value fails the supervisor too, instead of becoming a tool error for its model. */
  readonly stopsAgent = true;
  constructor(
    readonly body: string,
    readonly reason: "missing" | "expression_failed"
  ) {
    super(
      reason === "missing"
        ? `Template {{${body}}} has no value, and this workflow uses strict templates. Check the field name, or turn off Strict templates in the workflow menu to render it empty.`
        : `Template {{${body}}} could not be evaluated, and this workflow uses strict templates. Fix the expression, or turn off Strict templates in the workflow menu to render it empty.`,
      ErrorCategory.NODE_CONFIG,
      false,
      { code: TEMPLATE_VALUE_MISSING_CODE },
      "Strict templates are on for this workflow. Open the node and fix the field the error names (type {{ in it for the fields the last run had), or turn off Strict templates in the workflow menu."
    );
    this.name = "TemplateValueMissingError";
  }
}

export function isTemplateValueMissingError(error: unknown): error is TemplateValueMissingError {
  return error instanceof TemplateValueMissingError || (error instanceof WorkflowError && error.metadata?.code === TEMPLATE_VALUE_MISSING_CODE);
}

const strictness = new AsyncLocalStorage<boolean>();

/** Runs `body` with strict templates on or off: on, a `{{ }}` without a value throws `TemplateValueMissingError`. */
export function runWithStrictTemplates<T>(strict: boolean, body: () => T): T {
  return strictness.run(strict, body);
}

function strictTemplatesOn(): boolean {
  return strictness.getStore() === true;
}

/** One `{{ }}` of a template that rendered nothing: its body and why. */
export interface MissingTemplateValue {
  body: string;
  reason: "missing" | "expression_failed";
}

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
): { rendered: string; unresolvedKeys: string[]; missing: MissingTemplateValue[] } {
  const strict = strictTemplatesOn();
  const render = (evaluate: ((expression: string) => unknown) | null) => {
    const unresolvedKeys: string[] = [];
    const missing: MissingTemplateValue[] = [];
    const noValue = (body: string, reason: MissingTemplateValue["reason"]): string => {
      missing.push({ body, reason });
      return "";
    };
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
    return { rendered, unresolvedKeys, missing };

    function renderBody(body: string): string {
      const trimmed = body.trim();
      // Simple a.b.c path — preserve original behavior + unresolved tracking.
      if (SIMPLE_PATH.test(trimmed)) {
        // Phase 16 — the running node read this path (its labels follow).
        recordTemplateRead(trimmed, true);
        const value = resolvePath(values, trimmed);
        if (value === undefined) {
          unresolvedKeys.push(trimmed);
          return noValue(trimmed, "missing");
        }
        if (value === null) {
          // A field that holds null has a value: it renders empty, in strict mode too.
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
          if (result === undefined) return noValue(trimmed, "missing");
          if (result === null) return "";
          if (typeof result === "string") return result;
          if (typeof result === "number" || typeof result === "boolean") return String(result);
          try { return JSON.stringify(result); } catch { return String(result); }
        } catch (error) {
          // The expression's own error or timeout renders "". A sandbox failure fails the node instead:
          // an IF or Switch must never branch on a value that silently lost its expression.
          if (isExpressionSandboxFailure(error)) throw error;
          return noValue(trimmed, "expression_failed");
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
  // A session that cannot start throws ExpressionSandboxError (retryable when no instance was ready).
  const result = hasExpression ? withExpressionEvaluator(expressionContextFor(values), render) : render(null);
  // Strict templates: a `{{ }}` without a value fails the node, except the run's optional prompt fields. Thrown
  // after the sandbox session has closed, so it never counts as a sandbox failure.
  if (strict) throwIfStrictMissing(result.missing);
  return result;
}

function throwIfStrictMissing(missing: MissingTemplateValue[]): void {
  const first = missing.find((entry) => !OPTIONAL_RUN_FIELDS.has(entry.body));
  if (first) throw new TemplateValueMissingError(first.body, first.reason);
}

export function renderTemplate(template: string, values: Record<string, unknown>, options: { pieces?: TemplatePiece[] } = {}): string {
  return renderTemplateAdvanced(template, values, options).rendered;
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
export function evaluateConditionTemplate(
  template: string,
  values: Record<string, unknown>
): { result: boolean; evaluatedValue: string; missing: MissingTemplateValue[] } {
  const matches = [...template.matchAll(TEMPLATE_BODY)];
  const outside = template.replace(TEMPLATE_BODY, " ");
  if (matches.length === 0 || !outside.trim()) {
    const rendered = renderTemplateAdvanced(template, values);
    const evaluated = rendered.rendered.trim();
    return { result: isTruthyConditionText(evaluated), evaluatedValue: evaluated, missing: rendered.missing };
  }
  // Text outside the braces that names data reads it as a computed expression does (its labels follow).
  if (conditionTextReadsData(outside)) recordTemplateRead(template.replace(TEMPLATE_BODY, " 0 ").trim(), false);
  const missing: MissingTemplateValue[] = [];
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
        if (value === undefined) missing.push({ body, reason: "missing" });
      } else {
        recordTemplateRead(body, false);
        try {
          value = evaluate(body);
          if (value === undefined) missing.push({ body, reason: "missing" });
        } catch (error) {
          if (isExpressionSandboxFailure(error)) throw error;
          value = undefined;
          missing.push({ body, reason: "expression_failed" });
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
  // Strict templates: a `{{ }}` of the condition without a value fails the node (after the session has closed).
  if (strictTemplatesOn()) throwIfStrictMissing(missing);
  if (!outcome.ok) {
    throw new Error(
      `IF condition '${template}' could not be evaluated once its {{ }} values were filled in (${outcome.kind}). ` +
        "Text outside {{ }} is evaluated as JavaScript: quote text values, for example {{status}} === 'done', " +
        "or put the whole condition inside one {{ }}."
    );
  }
  const evaluatedValue = stringifyConditionValue(outcome.value).trim();
  return { result: isTruthyConditionText(evaluatedValue), evaluatedValue, missing };
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
  if (checked !== undefined) {
    // The check rendered it without strict templates (it renders settings this operation may not use). With strict
    // templates on, a path the handler uses must still have a value; an expression is never evaluated a second time.
    if (strictTemplatesOn()) {
      const missing: MissingTemplateValue[] = [];
      for (const match of template.matchAll(TEMPLATE_BODY)) {
        const body = (match[1] ?? "").trim();
        if (SIMPLE_PATH.test(body) && resolvePath(values, body) === undefined) missing.push({ body, reason: "missing" });
      }
      throwIfStrictMissing(missing);
    }
    return checked;
  }
  if (template.includes("{{")) {
    throw new Error("A templated setting was not checked by the content rules before sending, so the request was not sent.");
  }
  return template;
}
