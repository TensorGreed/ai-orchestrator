/**
 * Phase 15.2 — a conservative check for regular expressions that can
 * backtrack exponentially (ReDoS) when a scorer runs them on the API thread.
 *
 * It rejects:
 *   - a repeating quantifier (`*`, `+`, `{n,}`, `{n,m}` with m > n) applied to
 *     a group that holds a variable quantifier itself (star height above
 *     one): `(a+)+`, `(\w+\s?)*`, `(.*,){2,}`, `((ab)*c)+`;
 *   - backreferences (`\1`, `\k<name>`), which defeat any linear-time bound.
 *
 * What it does not catch, and why that is bounded rather than solved: a
 * quantified alternation whose branches overlap (`(a|a)*`, `(a|ab)+`) and
 * adjacent unbounded quantifiers (`.*a.*a.*a`) are polynomial or
 * exponential on hostile input but too common in honest patterns to reject.
 * Scorers cap the text they match against (EVAL_SCORER_INPUT_MAX_BYTES).
 */

export interface RegexSafety {
  safe: boolean;
  reason?: string;
}

interface Frame {
  /** The group (so far) holds a quantifier whose count varies. */
  variable: boolean;
}

const QUANTIFIER_BRACE = /^\{(\d+)(,(\d*))?\}/;

export function checkRegexSafety(source: string): RegexSafety {
  const stack: Frame[] = [{ variable: false }];
  // What the next quantifier applies to: a closed group (and whether it held a variable quantifier), or one character.
  let atom: { group: boolean; variable: boolean } | null = null;
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\\") {
      const next = source[index + 1] ?? "";
      if (/[1-9]/.test(next) || (next === "k" && source[index + 2] === "<")) {
        return { safe: false, reason: "backreferences are not allowed in scorer patterns" };
      }
      atom = { group: false, variable: false };
      index += 2;
      continue;
    }
    if (char === "[") {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== "]") cursor += source[cursor] === "\\" ? 2 : 1;
      atom = { group: false, variable: false };
      index = cursor + 1;
      continue;
    }
    if (char === "(") {
      stack.push({ variable: false });
      atom = null;
      index += 1;
      if (source[index] === "?") {
        const kind = source[index + 1];
        if (kind === ":" || kind === "=" || kind === "!") index += 2;
        else if (kind === "<" && (source[index + 2] === "=" || source[index + 2] === "!")) index += 3;
        else if (kind === "<") {
          const close = source.indexOf(">", index);
          index = close === -1 ? source.length : close + 1;
        } else index += 1;
      }
      continue;
    }
    if (char === ")") {
      const frame = stack.length > 1 ? stack.pop()! : { variable: false };
      const parent = stack[stack.length - 1]!;
      if (frame.variable) parent.variable = true;
      atom = { group: true, variable: frame.variable };
      index += 1;
      continue;
    }
    if (char === "|") {
      atom = null;
      index += 1;
      continue;
    }
    let min: number | null = null;
    let max = 0;
    let length = 1;
    if (char === "*") [min, max] = [0, Infinity];
    else if (char === "+") [min, max] = [1, Infinity];
    else if (char === "?") [min, max] = [0, 1];
    else if (char === "{") {
      const match = QUANTIFIER_BRACE.exec(source.slice(index));
      if (match) {
        min = Number(match[1]);
        max = match[2] === undefined ? min : match[3] === "" || match[3] === undefined ? Infinity : Number(match[3]);
        length = match[0].length;
      }
    }
    if (min === null) {
      atom = { group: false, variable: false };
      index += 1;
      continue;
    }
    const variable = min !== max;
    const repeats = variable && max > 1;
    if (repeats && atom?.group && atom.variable) {
      return { safe: false, reason: "nested quantifiers (a repeated group that itself repeats) can take exponential time" };
    }
    if (variable) stack[stack.length - 1]!.variable = true;
    atom = null;
    index += length;
    // A lazy (`*?`) or possessive-looking suffix belongs to this quantifier.
    if (source[index] === "?" || source[index] === "+") index += 1;
  }
  return { safe: true };
}

/** Keys of a JSON Schema whose values are data, not subschemas: patterns inside them are never compiled. */
const SCHEMA_DATA_KEYS = new Set(["const", "enum", "default", "examples", "example"]);

/** Every regular expression a JSON Schema asks a validator to compile (`pattern`, `patternProperties` keys). */
export function jsonSchemaPatterns(schema: unknown, limit = 1000): string[] {
  const out: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (out.length >= limit || depth > 64 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SCHEMA_DATA_KEYS.has(key)) continue;
      if (key === "pattern" && typeof entry === "string") out.push(entry);
      if (key === "patternProperties" && entry && typeof entry === "object" && !Array.isArray(entry)) out.push(...Object.keys(entry));
      walk(entry, depth + 1);
    }
  };
  walk(schema, 0);
  return out;
}

/** The first unsafe pattern in a JSON Schema, as a readable problem, or null. */
export function jsonSchemaRegexProblem(schema: unknown): string | null {
  for (const pattern of jsonSchemaPatterns(schema)) {
    const check = checkRegexSafety(pattern);
    if (!check.safe) return `the schema pattern ${JSON.stringify(pattern.length > 60 ? `${pattern.slice(0, 60)}…` : pattern)} is not allowed: ${check.reason}`;
  }
  return null;
}
