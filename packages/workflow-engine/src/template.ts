import { withExpressionEvaluator, isComplexExpression, type ExpressionContext } from "./expression";

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

export function renderTemplateAdvanced(template: string, values: Record<string, unknown>): { rendered: string; unresolvedKeys: string[] } {
  const render = (evaluate: ((expression: string) => unknown) | null) => {
    const unresolvedKeys: string[] = [];
    // Match either a simple dotted-path token (back-compat) or any {{ ... }} body.
    const rendered = template.replace(TEMPLATE_BODY, (_match, body: string) => {
      const trimmed = body.trim();
      // Simple a.b.c path — preserve original behavior + unresolved tracking.
      if (SIMPLE_PATH.test(trimmed)) {
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
        try {
          const result = evaluate(trimmed);
          if (result === undefined || result === null) return "";
          if (typeof result === "string") return result;
          if (typeof result === "number" || typeof result === "boolean") return String(result);
          try { return JSON.stringify(result); } catch { return String(result); }
        } catch {
          return "";
        }
      }
      return "";
    });
    return { rendered, unresolvedKeys };
  };
  // Only open a sandbox session when the template has an expression; all of them share it.
  const hasExpression = [...template.matchAll(TEMPLATE_BODY)].some((match) => {
    const trimmed = (match[1] ?? "").trim();
    return !SIMPLE_PATH.test(trimmed) && isComplexExpression(trimmed);
  });
  if (!hasExpression) return render(null);
  try {
    return withExpressionEvaluator(expressionContextFor(values), render);
  } catch {
    // No session could start (the sandbox is restarting): expressions render empty, as a failed expression always has.
    return render(null);
  }
}

export function renderTemplate(template: string, values: Record<string, unknown>): string {
  return renderTemplateAdvanced(template, values).rendered;
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
