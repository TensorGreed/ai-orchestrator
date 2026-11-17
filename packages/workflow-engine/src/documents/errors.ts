/**
 * Why a document could not be scanned. `status` is the HTTP status a route answers with: 400 for an unsupported or
 * oversized document, 403 for a host the caller may not fetch from, 422 for a URL the outbound checks refuse, 502 when
 * the server answered with an error, 504 when it did not answer in time, 499 when the caller went away (nobody reads
 * that answer), 503 when names and addresses could not be checked. Messages never carry document content.
 */
export type DocumentErrorCode =
  | "unsupported_type"
  | "too_large"
  | "invalid_document"
  | "invalid_url"
  | "host_not_allowed"
  | "blocked_url"
  | "fetch_failed"
  | "timeout"
  | "cancelled"
  | "check_failed";

const STATUS: Record<DocumentErrorCode, number> = {
  unsupported_type: 400,
  too_large: 400,
  invalid_document: 400,
  invalid_url: 400,
  host_not_allowed: 403,
  blocked_url: 422,
  fetch_failed: 502,
  timeout: 504,
  cancelled: 499,
  check_failed: 503
};

export class DocumentError extends Error {
  readonly code: DocumentErrorCode;
  readonly status: number;
  /** For `blocked_url`: the outbound check's reason (scheme, address_blocked, ...). */
  readonly reason?: string;
  constructor(code: DocumentErrorCode, message: string, reason?: string) {
    super(message);
    this.name = "DocumentError";
    this.code = code;
    this.status = STATUS[code];
    if (reason) this.reason = reason;
  }
}
