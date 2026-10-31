import { withExpressionEvaluator, isComplexExpression, type ExpressionContext } from "./expression";
import { isExpressionSandboxFailure } from "./expression-sandbox";
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
    throw new Error("A templated setting was not checked by the guard before sending, so the request was not sent.");
  }
  return template;
}
