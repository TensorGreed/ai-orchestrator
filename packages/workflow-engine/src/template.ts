import { evaluateExpression, isComplexExpression } from "./expression";

export function renderTemplateAdvanced(template: string, values: Record<string, unknown>): { rendered: string; unresolvedKeys: string[] } {
  const unresolvedKeys: string[] = [];
  // Match either a simple dotted-path token (back-compat) or any {{ ... }} body.
  const rendered = template.replace(/{{\s*([\s\S]+?)\s*}}/g, (_match, body: string) => {
    const trimmed = body.trim();
    // Simple a.b.c path — preserve original behavior + unresolved tracking.
    if (/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
      const value = resolvePath(values, trimmed);
      if (value === undefined || value === null) {
        unresolvedKeys.push(trimmed);
        return "";
      }
      if (typeof value === "string") return value;
      return JSON.stringify(value);
    }
    // Otherwise — treat as a JS expression in the new engine.
    if (isComplexExpression(trimmed)) {
      try {
        const result = evaluateExpression(trimmed, {
          $input: values,
          $json: values,
          $vars: (values.vars && typeof values.vars === "object" ? values.vars : {}) as Record<string, unknown>,
          extras: values
        });
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