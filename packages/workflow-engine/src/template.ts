export function renderTemplateAdvanced(template: string, values: Record<string, unknown>): { rendered: string; unresolvedKeys: string[] } {
  const unresolvedKeys: string[] = [];
  const rendered = template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_match, key: string) => {
    const value = resolvePath(values, key);
    if (value === undefined || value === null) {
      unresolvedKeys.push(key);
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    return JSON.stringify(value);
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