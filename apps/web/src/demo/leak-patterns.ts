/**
 * What must never appear in the demo fixtures. `demo/record-fixtures.mts`
 * refuses to write a recording that matches one, and `fixtures.test.ts`
 * checks the committed fixtures against the same list, so a bad re-record
 * fails CI. Machine-specific values (home directory, user and host names,
 * the recording's master key and session cookie) are only known to the
 * recorder, which checks them as well.
 */
export const LEAK_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "API key (sk-/pk-/rk-)", pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/ },
  { name: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "JSON Web Token", pattern: /\beyJ[\w-]+\.[\w-]+\.[\w-]+/ },
  { name: "PEM block", pattern: /-----BEGIN [A-Z ]*-----/ },
  { name: "Bearer token", pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/ },
  { name: "recording password", pattern: /Demo-Only-Pass/ }
];

/** Every pattern the text matches, with what matched. */
export function findLeaks(text: string, extra: ReadonlyArray<{ name: string; pattern: RegExp }> = []): Array<{ name: string; match: string }> {
  const found: Array<{ name: string; match: string }> = [];
  for (const { name, pattern } of [...LEAK_PATTERNS, ...extra]) {
    const match = pattern.exec(text);
    if (match) found.push({ name, match: match[0].slice(0, 40) });
  }
  return found;
}

/** A literal value as a pattern; word-bounded when it starts and ends with a word character. */
export function literalPattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(/^\w.*\w$/s.test(value) ? `\\b${escaped}\\b` : escaped);
}
