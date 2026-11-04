/**
 * Roadmap 7.3 — optional pagination of list endpoints, with the `page` / `pageSize` convention of
 * `GET /api/executions`.
 *
 * A list route answers exactly as before when the query names neither `page` nor `pageSize`. With either of them it
 * answers the envelope `{ items, total, page, pageSize }` (plus any non-list fields the route also returns). `page`
 * starts at 1 and defaults to 1; `pageSize` defaults to 20 and is capped at 100 (a larger value is answered with 100,
 * as on executions). A value that is not a positive integer is a 400.
 */

export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;

export interface PageRequest {
  page: number;
  pageSize: number;
  /** Rows to skip: (page - 1) * pageSize. */
  offset: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** A malformed `page` or `pageSize`; the API error handler answers it with a 400. */
export class PaginationQueryError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "PaginationQueryError";
  }
}

function present(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return String(value).trim() !== "";
}

function positiveInteger(name: string, value: unknown): number {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) throw new PaginationQueryError(`${name} must be a positive integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new PaginationQueryError(`${name} must be a positive integer`);
  return parsed;
}

/** The page asked for, or null when the query names neither `page` nor `pageSize` (the route answers as before). */
export function pageRequestFromQuery(query: unknown): PageRequest | null {
  const record = query && typeof query === "object" ? (query as Record<string, unknown>) : {};
  const hasPage = present(record.page);
  const hasPageSize = present(record.pageSize);
  if (!hasPage && !hasPageSize) return null;
  const page = hasPage ? positiveInteger("page", record.page) : 1;
  const pageSize = Math.min(PAGE_SIZE_MAX, hasPageSize ? positiveInteger("pageSize", record.pageSize) : PAGE_SIZE_DEFAULT);
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) throw new PaginationQueryError("page is too large");
  return { page, pageSize, offset };
}

/** The envelope for rows a store already read with LIMIT/OFFSET, and the total it counted. */
export function pageEnvelope<T>(items: T[], total: number, request: PageRequest): Page<T> {
  return { items, total, page: request.page, pageSize: request.pageSize };
}

/** One page of a list already read in full (a small configuration list), in the list's order. */
export function pageOf<T>(items: readonly T[], request: PageRequest): Page<T> {
  return pageEnvelope(items.slice(request.offset, request.offset + request.pageSize), items.length, request);
}

/**
 * The list in its own order, with items whose sort key is equal ordered by id, so a page boundary never falls between
 * rows whose order the database leaves open. `items` must already be sorted by `key` (equal keys adjacent).
 */
export function withIdTiebreak<T extends { id: string }>(items: readonly T[], key: (item: T) => unknown): T[] {
  const out: T[] = [];
  let run: T[] = [];
  let runKey: unknown;
  const flush = () => {
    if (run.length > 1) run.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out.push(...run);
    run = [];
  };
  for (const item of items) {
    const itemKey = key(item);
    if (run.length > 0 && itemKey !== runKey) flush();
    runKey = itemKey;
    run.push(item);
  }
  flush();
  return out;
}

/** `withIdTiebreak` then one page of it. */
export function pageOfById<T extends { id: string }>(items: readonly T[], request: PageRequest, key: (item: T) => unknown): Page<T> {
  return pageOf(withIdTiebreak(items, key), request);
}
