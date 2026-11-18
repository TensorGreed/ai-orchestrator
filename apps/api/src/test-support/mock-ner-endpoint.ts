/**
 * A local names and addresses service for tests that follows the endpoint contract exactly
 * (`@ai-orchestrator/shared` `guard-entity-endpoint.ts`): `POST /v1/entities`, `GET /health`, bearer auth, and
 * `{ error: { code, message } }` answers with 400, 401, 413, 429 and 503 that never quote the input. It "recognizes"
 * the phrases in `vocabulary` (every occurrence, UTF-16 offsets) instead of running a model.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { entityEndpointRequestSchema, type EntityEndpointRequest } from "@ai-orchestrator/shared";

export interface MockNerEndpointOptions {
  /** Phrase → label and score. */
  vocabulary?: Record<string, { label: string; score: number }>;
  model?: { id: string; version: string; sha256: string };
  /** False: no model loaded (health ready=false, entities 503). */
  ready?: boolean;
  /** When set, requests without `Authorization: Bearer <token>` get 401. */
  token?: string;
  /** Characters a request may carry in all; more gets 413. */
  maxChars?: number;
  /** Delay before each answer. */
  delayMs?: number;
  /** Retry-After sent with a not-ready 503 (default "0"; null sends none). */
  retryAfter?: string | null;
}

export interface MockNerEndpoint {
  url: string;
  port: number;
  /** Every entities request body, in order. */
  requests: EntityEndpointRequest[];
  /** Authorization headers seen. */
  authorizations: Array<string | undefined>;
  healthChecks: number;
  /** Most entities requests the mock was answering at once. */
  maxInFlight: number;
  /** Replaces the next entities answers (status, raw body and extra headers), one per request. */
  answerNext(status: number, body: unknown, headers?: Record<string, string>): void;
  set(options: Partial<MockNerEndpointOptions>): void;
  close(): Promise<void>;
}

export const MOCK_NER_MODEL = { id: "mock-gliner", version: "1.0.0", sha256: "ab".repeat(32) };

export async function startMockNerEndpoint(initial: MockNerEndpointOptions = {}): Promise<MockNerEndpoint> {
  let options: MockNerEndpointOptions = { ready: true, model: MOCK_NER_MODEL, maxChars: 1_000_000, ...initial };
  const requests: EntityEndpointRequest[] = [];
  const authorizations: Array<string | undefined> = [];
  const scripted: Array<{ status: number; body: unknown; headers?: Record<string, string> }> = [];
  let healthChecks = 0;
  let inFlight = 0;
  let maxInFlight = 0;

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const fail = (res: http.ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}) => send(res, status, { error: { code, message } }, headers);

  const server = http.createServer((req, res) => {
    if (req.method === "POST") {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      res.on("close", () => {
        inFlight -= 1;
      });
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        authorizations.push(req.headers.authorization);
        if (options.token && req.headers.authorization !== `Bearer ${options.token}`) return fail(res, 401, "unauthorized", "A valid bearer token is required");
        if (req.method === "GET" && req.url === "/health") {
          healthChecks += 1;
          return send(res, 200, { ok: true, ready: options.ready !== false, model: options.ready === false ? null : options.model ?? null, ...(options.ready === false ? { message: "No model is loaded; run l2m models pull" } : {}) });
        }
        if (req.method !== "POST" || req.url !== "/v1/entities") return fail(res, 404, "not_found", "No such route");
        const next = scripted.shift();
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return fail(res, 400, "invalid_json", "The body is not JSON");
        }
        const parsed = entityEndpointRequestSchema.safeParse(body);
        if (!parsed.success) return fail(res, 400, "invalid_request", "The request does not follow the contract");
        requests.push(parsed.data);
        if (next) return send(res, next.status, next.body, next.headers);
        const chars = parsed.data.texts.reduce((sum, text) => sum + text.length, 0);
        if (chars > (options.maxChars ?? Infinity)) return fail(res, 413, "too_large", "The request carries too much text");
        if (options.ready === false) {
          const retryAfter = options.retryAfter === undefined ? "0" : options.retryAfter;
          return fail(res, 503, "not_ready", "No model is loaded", retryAfter === null ? {} : { "retry-after": retryAfter });
        }
        const threshold = parsed.data.threshold ?? 0;
        const results = parsed.data.texts.map((text) => ({
          entities: Object.entries(options.vocabulary ?? {}).flatMap(([phrase, { label, score }]) => {
            if (!(parsed.data.labels as string[]).includes(label) || score < threshold) return [];
            const found: Array<{ start: number; end: number; label: string; score: number }> = [];
            for (let at = text.indexOf(phrase); at !== -1; at = text.indexOf(phrase, at + phrase.length)) found.push({ start: at, end: at + phrase.length, label, score });
            return found;
          })
        }));
        return send(res, 200, { results, model: options.model });
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    authorizations,
    get healthChecks() {
      return healthChecks;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    answerNext: (status, body, headers) => scripted.push({ status, body, ...(headers ? { headers } : {}) }),
    set: (changes) => {
      options = { ...options, ...changes };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
