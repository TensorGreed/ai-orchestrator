/**
 * Phase 13.2 — one place that keeps OAuth/OIDC callback secrets out of request logs and OpenTelemetry server spans.
 *
 * The browser reaches the OIDC login callback and the MCP OAuth callback with a one-time authorization `code` and the
 * `state` in the query string. Those values are redacted in the URL that the Fastify request serializer logs and in
 * the span's `http.target`; the request itself is untouched, so route behaviour does not change.
 */

/** Callback routes whose query carries authorization-response secrets. */
export const SENSITIVE_CALLBACK_PATHS: ReadonlySet<string> = new Set(["/api/auth/oidc/callback", "/api/mcp/oauth/callback"]);

/** Query parameters redacted on those routes (`error`, `error_description` and `iss` are kept for diagnosis). */
export const SENSITIVE_CALLBACK_PARAMS: readonly string[] = ["code", "state", "session_state", "id_token", "access_token"];

export const REDACTED_VALUE = "REDACTED";

/** Percent-decodes a path; a malformed escape returns null so the caller redacts anyway. */
function decodePath(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

/** Routing decodes the path before matching, so the check does too (and ignores case and trailing slashes). */
function isSensitiveCallbackPath(path: string): boolean {
  const decoded = decodePath(path);
  // A path that cannot be decoded is redacted when it could be a callback in disguise (contains a `%`).
  if (decoded === null) return true;
  return SENSITIVE_CALLBACK_PATHS.has(decoded.toLowerCase().replace(/\/+$/, "") || "/");
}

/** Returns `url` (a request target such as `/path?query`) with sensitive callback parameters replaced. */
export function redactSensitiveUrl(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart < 0) return url;
  const path = url.slice(0, queryStart);
  if (!isSensitiveCallbackPath(path)) return url;
  const params = new URLSearchParams(url.slice(queryStart + 1));
  let changed = false;
  for (const name of [...new Set(params.keys())]) {
    if (SENSITIVE_CALLBACK_PARAMS.includes(name.toLowerCase())) {
      params.set(name, REDACTED_VALUE);
      changed = true;
    }
  }
  return changed ? `${path}?${params.toString()}` : url;
}
