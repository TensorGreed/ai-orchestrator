/**
 * HTTP Request bodies: a body that is a JSON object or array goes out as `application/json` when the node's headers
 * name no Content-Type, instead of the `text/plain` a string body gets by default. A Content-Type set in the headers
 * always wins, and any other body is sent as before.
 */
export function applyJsonContentType(headers: Headers, body: string): void {
  if (headers.has("content-type")) return;
  const trimmed = body.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return;
  try {
    JSON.parse(trimmed);
  } catch {
    return;
  }
  headers.set("Content-Type", "application/json");
}
