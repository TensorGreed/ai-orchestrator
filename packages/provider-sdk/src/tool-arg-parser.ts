function toRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (!fenceMatch) {
    return trimmed;
  }
  return fenceMatch[1]?.trim() ?? trimmed;
}

function extractFirstJSONObject(raw: string): string | null {
  const text = raw.trim();
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function repairJsonLike(raw: string): string {
  let text = raw.trim();
  text = text.replace(/[\u201C\u201D]/g, "\"").replace(/[\u2018\u2019]/g, "'");
  text = text.replace(/^\s*arguments\s*:\s*/i, "");

  if (text && !text.startsWith("{") && /^[A-Za-z_][A-Za-z0-9_-]*\s*[:=]/.test(text)) {
    text = `{${text}}`;
  }

  text = text.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, "$1\"$2\"$3");
  text = text.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner: string) => {
    const escaped = inner.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    return `"${escaped}"`;
  });
  text = text.replace(/,\s*([}\]])/g, "$1");

  return text;
}

function parseSimplePairs(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }

  const result: Record<string, unknown> = {};
  const parts = text.split(/[,\n&]/g).map((entry) => entry.trim()).filter(Boolean);
  for (const part of parts) {
    const match = part.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*(.+)$/);
    if (!match) {
      continue;
    }
    const key = match[1]!;
    let valueText = match[2]!.trim();
    valueText = valueText.replace(/^["']|["']$/g, "");

    if (valueText === "true") {
      result[key] = true;
      continue;
    }
    if (valueText === "false") {
      result[key] = false;
      continue;
    }
    if (valueText === "null") {
      result[key] = null;
      continue;
    }
    if (/^-?\d+(?:\.\d+)?$/.test(valueText)) {
      result[key] = Number(valueText);
      continue;
    }
    result[key] = valueText;
  }

  return Object.keys(result).length ? result : null;
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return toRecord(parsed);
  } catch {
    return null;
  }
}

/**
 * Attempts to parse tool arguments that are often malformed by local/open-source models.
 * Falls back to an empty object when no structured payload can be recovered.
 */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }

  if (typeof raw !== "string") {
    return {};
  }

  let text = stripCodeFence(raw);
  if (!text) {
    return {};
  }

  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const asRecord = toRecord(parsed);
      if (asRecord) {
        return asRecord;
      }
      if (typeof parsed === "string") {
        text = stripCodeFence(parsed);
        continue;
      }
      break;
    } catch {
      break;
    }
  }

  const candidates = [text];
  const extracted = extractFirstJSONObject(text);
  if (extracted && extracted !== text) {
    candidates.push(extracted);
  }

  for (const candidate of candidates) {
    const strictParsed = tryParseJsonObject(candidate);
    if (strictParsed) {
      return strictParsed;
    }

    const repairedParsed = tryParseJsonObject(repairJsonLike(candidate));
    if (repairedParsed) {
      return repairedParsed;
    }
  }

  return parseSimplePairs(text) ?? {};
}
