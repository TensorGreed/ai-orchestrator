import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describeRequestIssues, NerHttpError, nerEntitiesRequestSchema } from "./contract.js";
import type { NerConfig } from "./config.js";
import type { NerService } from "./service.js";

/**
 * The HTTP side of l2m-ner (node:http, no framework). Two routes: `GET /health` (no token needed: it carries no
 * input, only the model id and checksum) and `POST /v1/entities` (the bearer token when one is configured).
 * Logs carry the method, route, status, timing and sizes, never text, and errors never quote the input.
 */

export interface NerServerLogger {
  info(entry: Record<string, unknown>): void;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

function tokenMatches(header: string | undefined, expected: Buffer): boolean {
  if (!header) return false;
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  if (!match) return false;
  return timingSafeEqual(digest(match[1]!), expected);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  res.end(payload);
}

function sendError(res: ServerResponse, error: NerHttpError): void {
  send(res, error.status, { error: { code: error.code, message: error.message } }, error.headers);
}

/** Time to send the whole body, separate from (and much shorter than) the time allowed for the model. */
export const NER_BODY_DEADLINE_MS = 15_000;
/** Open connections at once; a slow client cannot hold more. */
export const NER_MAX_CONNECTIONS = 256;

/** Reads the body up to `limit` bytes within `deadlineMs`; past either, an error (the rest is not read). */
function readBody(req: IncomingMessage, limit: number, deadlineMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? Number.NaN);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new NerHttpError(413, "too_large", `The body is larger than ${limit} bytes`, { connection: "close" }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const deadline = setTimeout(() => {
      if (done) return;
      done = true;
      chunks.length = 0;
      reject(new NerHttpError(400, "bad_request", `The body did not arrive within ${deadlineMs / 1000} s`, { connection: "close" }));
      req.pause();
    }, deadlineMs);
    deadline.unref();
    req.on("close", () => clearTimeout(deadline));
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        clearTimeout(deadline);
        chunks.length = 0;
        reject(new NerHttpError(413, "too_large", `The body is larger than ${limit} bytes`, { connection: "close" }));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      clearTimeout(deadline);
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", () => {
      clearTimeout(deadline);
      if (done) return;
      done = true;
      reject(new NerHttpError(400, "bad_request", "The body could not be read"));
    });
  });
}

export function createNerServer(service: NerService, config: NerConfig, logger: NerServerLogger = { info: () => undefined }): Server {
  const expectedToken = config.token ? digest(config.token) : undefined;
  // Bodies being read right now: each can hold up to maxBodyBytes, so they are capped like the queue.
  let reading = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse, note: Record<string, unknown>): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health") {
      note.route = "/health";
      if (req.method !== "GET" && req.method !== "HEAD") throw new NerHttpError(405, "method_not_allowed", "Use GET", { allow: "GET, HEAD" });
      const health = service.health();
      send(res, health.ok ? 200 : 503, health);
      return;
    }
    if (path !== "/v1/entities") {
      note.route = "other";
      throw new NerHttpError(404, "not_found", "No such route");
    }
    note.route = "/v1/entities";
    if (req.method !== "POST") throw new NerHttpError(405, "method_not_allowed", "Use POST", { allow: "POST" });
    if (expectedToken && !tokenMatches(req.headers.authorization, expectedToken)) {
      throw new NerHttpError(401, "unauthorized", "A valid bearer token is required", { "www-authenticate": 'Bearer realm="l2m-ner"' });
    }
    const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") throw new NerHttpError(415, "unsupported_media_type", "Send application/json");
    // Refused before the body is read, so a full queue does not also buffer bodies it cannot run.
    if (service.atCapacity() || reading >= config.maxQueue) {
      throw new NerHttpError(429, "busy", "Too many requests in progress; try again shortly", { "retry-after": "1", connection: "close" });
    }
    reading += 1;
    let body: Buffer;
    try {
      body = await readBody(req, config.maxBodyBytes, NER_BODY_DEADLINE_MS);
    } finally {
      reading -= 1;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString("utf8"));
    } catch {
      throw new NerHttpError(400, "bad_request", "The body is not valid JSON");
    }
    const parsed = nerEntitiesRequestSchema.safeParse(raw);
    if (!parsed.success) throw new NerHttpError(400, "bad_request", `Invalid request: ${describeRequestIssues(parsed.error)}`);
    note.texts = parsed.data.texts.length;
    note.chars = parsed.data.texts.reduce((sum, text) => sum + text.length, 0);
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), config.requestTimeoutMs);
    const onClose = () => {
      if (!res.writableFinished) stop.abort();
    };
    res.on("close", onClose);
    try {
      const result = await service.recognize(parsed.data, stop.signal);
      note.entities = result.results.reduce((sum, item) => sum + item.entities.length, 0);
      send(res, 200, result);
    } finally {
      clearTimeout(timer);
      res.off("close", onClose);
    }
  };

  const server = createServer((req, res) => {
    const started = process.hrtime.bigint();
    const note: Record<string, unknown> = { method: req.method };
    handle(req, res, note)
      .catch((error: unknown) => {
        sendError(res, error instanceof NerHttpError ? error : new NerHttpError(503, "failed", "The request failed"));
      })
      .finally(() => {
        // Health checks every few seconds would drown the log; they are logged only when they fail.
        if (note.route === "/health" && res.statusCode === 200) return;
        logger.info({ msg: "request", ...note, status: res.statusCode, ms: Number((process.hrtime.bigint() - started) / 1_000_000n) });
      });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = config.requestTimeoutMs + NER_BODY_DEADLINE_MS;
  server.maxConnections = NER_MAX_CONNECTIONS;
  server.keepAliveTimeout = 5_000;
  return server;
}
