/**
 * Sensitive values in an MCP tool result: a marker in the result's `_meta` that lists values the tool gave back in
 * clear and the token or placeholder each came from. L2M's gateway puts it on a `restore_sensitive_data` result.
 *
 * A workflow run that receives such a result (an MCP Tool node, or an agent's tool call) uses the values like any
 * other tool output, and keeps them out of what it stores and streams the way a Reveal node's values are kept out:
 * run history, live events and session state hold the token instead.
 *
 * The marker is signed with a key derived from the deployment's master key. A marker this deployment signed puts the
 * listed tokens back. Any other marker (another server's, another deployment's, unsigned or altered) only masks
 * more: each listed value found in the result is replaced by `UNVERIFIED_SENSITIVE_PLACEHOLDER`. A marker never
 * makes the run keep anything it would otherwise hide.
 */

/** The `_meta` key (reverse-DNS prefix, as MCP asks of vendor keys). */
export const SENSITIVE_VALUES_META_KEY = "com.lsquarem/sensitive-values";
export const SENSITIVE_VALUES_MARKER_VERSION = 1;
/** Entries read from one marker; the rest are ignored (the gateway restores at most this many tokens per call). */
export const SENSITIVE_VALUES_MARKER_MAX_ENTRIES = 1_000;
/** Longest token and value read from a marker entry. */
export const SENSITIVE_VALUES_MARKER_MAX_TOKEN_CHARS = 512;
export const SENSITIVE_VALUES_MARKER_MAX_VALUE_CHARS = 10_000;
/** What a value listed by a marker that does not verify is replaced with in what the run keeps. */
export const UNVERIFIED_SENSITIVE_PLACEHOLDER = "[SENSITIVE]";

export interface SensitiveValueEntry {
  /** The token or placeholder the value came from. */
  token: string;
  /** The value in clear, as it appears in the result. */
  value: string;
}

export interface SensitiveValuesMarker {
  v: typeof SENSITIVE_VALUES_MARKER_VERSION;
  values: SensitiveValueEntry[];
  /** `v1:` and a base64url HMAC-SHA-256 of `sensitiveValuesSigningPayload(values)`. */
  sig?: string;
}

/**
 * The marker as read from a result's `_meta` (the raw value under `SENSITIVE_VALUES_META_KEY`): well-formed entries
 * only, at most `SENSITIVE_VALUES_MARKER_MAX_ENTRIES`. Undefined when nothing usable is there. `complete` is false when
 * entries were dropped (a signature then cannot verify).
 */
export function parseSensitiveValuesMarker(raw: unknown): (SensitiveValuesMarker & { complete: boolean }) | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.values)) return undefined;
  const values: SensitiveValueEntry[] = [];
  let complete = record.v === SENSITIVE_VALUES_MARKER_VERSION;
  for (const entry of record.values) {
    if (values.length >= SENSITIVE_VALUES_MARKER_MAX_ENTRIES) {
      complete = false;
      break;
    }
    const item = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : undefined;
    const token = item?.token;
    const value = item?.value;
    if (
      typeof token !== "string" ||
      typeof value !== "string" ||
      token.length === 0 ||
      value.length === 0 ||
      token.length > SENSITIVE_VALUES_MARKER_MAX_TOKEN_CHARS ||
      value.length > SENSITIVE_VALUES_MARKER_MAX_VALUE_CHARS
    ) {
      complete = false;
      continue;
    }
    values.push({ token, value });
  }
  if (values.length === 0) return undefined;
  return {
    v: SENSITIVE_VALUES_MARKER_VERSION,
    values,
    ...(typeof record.sig === "string" ? { sig: record.sig } : {}),
    complete
  };
}

/** The exact text the signature covers. */
export function sensitiveValuesSigningPayload(values: readonly SensitiveValueEntry[]): string {
  return JSON.stringify({ v: SENSITIVE_VALUES_MARKER_VERSION, values: values.map((entry) => [entry.token, entry.value]) });
}
