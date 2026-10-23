/** The CLI's API access: the I/O it is given, the target (URL and key) and one request helper. */
import fs from "node:fs";
import { oneFlag, UsageError, type ParsedArgs } from "./args";

export interface CliIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Waits between polls of a replay job (tests pass an instant one). */
  sleep?: (ms: number) => Promise<void>;
}

export function write(stream: NodeJS.WritableStream, text: string): void {
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

export interface ApiTarget {
  url: string;
  key: string;
  fetch: typeof fetch;
}

/** `--api-url` / `--api-key`, else `L2M_API_URL` / `L2M_API_KEY`. */
export function apiTarget(args: ParsedArgs, io: CliIo): ApiTarget {
  const url = (oneFlag(args, "api-url") ?? io.env.L2M_API_URL ?? "").trim().replace(/\/+$/, "");
  const key = (oneFlag(args, "api-key") ?? io.env.L2M_API_KEY ?? "").trim();
  if (!url) throw new UsageError("Set --api-url or L2M_API_URL");
  if (!key) throw new UsageError("Set --api-key or L2M_API_KEY");
  return { url, key, fetch: io.fetch ?? fetch };
}

export class RequestError extends Error {
  constructor(
    message: string,
    /** The HTTP status, when the API answered. */
    readonly status: number | null = null,
    /** The parsed JSON body of the answer, when there was one. */
    readonly body: unknown = null
  ) {
    super(message);
  }
}

export interface ApiReply {
  status: number;
  ok: boolean;
  body: unknown;
  text: string;
  headers: Headers;
}

/** One request; any HTTP status is a reply. Only an unreachable server or an unreadable answer throws. */
export async function apiCall(target: ApiTarget, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<ApiReply> {
  let response: Response;
  try {
    response = await target.fetch(`${target.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${target.key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
  } catch (error) {
    throw new RequestError(`Cannot reach ${target.url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new RequestError(`${method} ${path}: the response could not be read: ${error instanceof Error ? error.message : String(error)}`, response.status);
  }
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, ok: response.ok, body: parsed, text, headers: response.headers };
}

/** The API's own error text of a failed reply. */
export function replyError(reply: ApiReply): string {
  const body = reply.body;
  return body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : reply.text.slice(0, 200);
}

/** A request that must succeed: a non-2xx answer throws a `RequestError` carrying the status and body. */
export async function apiRequest<T>(target: ApiTarget, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const reply = await apiCall(target, method, path, body);
  if (!reply.ok) throw new RequestError(`${method} ${path} failed with ${reply.status}: ${replyError(reply)}`, reply.status, reply.body);
  return reply.body as T;
}

/**
 * Server text (run errors, case names, score reasons) can carry a replayed
 * output's bytes; control characters are dropped so it cannot drive the
 * terminal or a CI log (ANSI escapes, carriage returns).
 */
export function cleanServerText(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A JSON file, or a usage error that names it. */
export function readJsonFile(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${file} is not JSON`);
  }
}

