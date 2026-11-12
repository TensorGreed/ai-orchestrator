/**
 * The optional link from a run to its trace in an operator's trace backend: L2M_OTEL_TRACE_URL_TEMPLATE, an absolute
 * http(s) URL containing `{traceId}`. Pure string work, so it loads whether or not tracing is on.
 */
export const TRACE_URL_PLACEHOLDER = "{traceId}";

const SAMPLE_TRACE_ID = "0123456789abcdef0123456789abcdef";

/** The reason a template is unusable, or null when it is valid. */
export function traceUrlTemplateProblem(template: string): string | null {
  if (!template.includes(TRACE_URL_PLACEHOLDER)) return `must contain ${TRACE_URL_PLACEHOLDER}`;
  let url: URL;
  try {
    url = new URL(template.split(TRACE_URL_PLACEHOLDER).join(SAMPLE_TRACE_ID));
  } catch {
    return "must be an absolute http:// or https:// URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "must be an absolute http:// or https:// URL";
  return null;
}

/** The trace's link, or null when no template is set or the id is not a 32-hex trace id. */
export function traceUrlFor(template: string | undefined, traceId: string | null | undefined): string | null {
  if (!template || !traceId || !/^[0-9a-f]{32}$/.test(traceId)) return null;
  if (traceUrlTemplateProblem(template) !== null) return null;
  return template.split(TRACE_URL_PLACEHOLDER).join(traceId);
}
