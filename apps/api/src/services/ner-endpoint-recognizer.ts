/**
 * The deployment's names and addresses service as the recognizer behind `data.entities` (CONTENT_RULES_NER_ENDPOINT).
 * It speaks the service contract in `@ai-orchestrator/shared` (`guard-entity-endpoint.ts`): the l2m-ner container
 * implements it, and so may any service an operator runs.
 *
 * - Requests go through the outbound URL checks with the connection pinned to the checked addresses. The configured
 *   host is reached even when OUTBOUND_DENY_PRIVATE is on: the operator named it, and the service normally runs on the
 *   internal network. Metadata, link-local and other never-valid addresses stay refused, and redirects are never
 *   followed (a redirect fails the request), so the service cannot send the texts anywhere else.
 * - Texts are sent in requests of at most 64 texts and CONTENT_RULES_NER_ENDPOINT_MAX_REQUEST_CHARS characters. A text
 *   longer than one request allows is sent as overlapping pieces, and each span is taken from the piece that has the
 *   most text around it.
 * - Each request has its own time limit (CONTENT_RULES_NER_ENDPOINT_TIMEOUT_MS) and stops when the check is stopped.
 * - The answer is read with a size cap and checked against the contract: one result per text, offsets inside the
 *   text, only the labels asked for. Anything else fails the check, and the rule set's failure setting decides.
 * - Errors name the HTTP status and the service's error code only; they never quote texts, and neither does the
 *   service's status shown in the editor.
 */

import { ENTITY_DATA_CLASSES, ENTITY_ENDPOINT_MAX_TEXTS, entityEndpointErrorSchema, entityEndpointHealthSchema, entityEndpointResponseSchema, readCapped, type GuardEntityEngineInfo, type GuardEntityModelInfo } from "@ai-orchestrator/shared";
import { parseIp, type DnsResolver, type GuardEntityRecognizer, type GuardEntityRequest, type GuardEntitySpan } from "@ai-orchestrator/guard-sdk";
import { abortableResolver, guardedFetch, nodeDnsResolver, type OutboundGuardConfig } from "@ai-orchestrator/workflow-engine";

export const ENDPOINT_ENTITY_RECOGNIZER_ID = "endpoint";
/** Largest answer read from the service (64 texts' worth of spans with room to spare). */
export const ENDPOINT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Largest error or health answer read. */
const SMALL_RESPONSE_BYTES = 64 * 1024;
/** How long a health answer is reused. */
const HEALTH_TTL_MS = 30_000;
/** Longest a health request may take. */
const HEALTH_TIMEOUT_MS = 3_000;
/** Pieces of a long text overlap by this much. */
const PIECE_OVERLAP = 400;
/** Longest piece of a text in one request (the service reads it in short windows anyway). */
const MAX_PIECE_CHARS = 10_000;

export interface EndpointEntityRecognizerOptions {
  /** CONTENT_RULES_NER_ENDPOINT: an http(s) base URL. */
  baseUrl: string;
  /** CONTENT_RULES_NER_ENDPOINT_TOKEN: sent as `Authorization: Bearer`. */
  token?: string;
  timeoutMs: number;
  maxRequestChars: number;
  /** The deployment's outbound policy (OUTBOUND_DENY_PRIVATE, OUTBOUND_ALLOWLIST); the configured host is added to it. */
  outbound: OutboundGuardConfig;
  resolver?: DnsResolver;
  /** Tests only: replaces the pinned fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Piece {
  /** The text it comes from. */
  text: number;
  offset: number;
  /** Spans that start in [from, to) of the text belong to this piece. */
  from: number;
  to: number;
  value: string;
}

/** The service answered something the contract does not allow, or could not be used. Never quotes texts. */
export class EntityEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityEndpointError";
  }
}

type EngineStatus = Pick<GuardEntityEngineInfo, "status" | "error" | "model" | "message">;

export class EndpointEntityRecognizer implements GuardEntityRecognizer {
  readonly id = ENDPOINT_ENTITY_RECOGNIZER_ID;
  readonly classes = ENTITY_DATA_CLASSES;
  readonly languages = ["en"] as const;
  readonly remote = true;

  private readonly base: URL;
  private readonly policy: OutboundGuardConfig;
  private model: GuardEntityModelInfo | null = null;
  private state: EngineStatus = { status: "not_ready", message: "Not checked yet" };
  private checkedAt: number | null = null;
  private pendingHealth: Promise<void> | null = null;

  constructor(private readonly options: EndpointEntityRecognizerOptions) {
    const base = new URL(options.baseUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("The names and addresses service must be an http(s) URL");
    if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
    this.base = base;
    this.policy = { denyPrivate: options.outbound.denyPrivate, allowlist: [...options.outbound.allowlist, allowEntryFor(base)] };
  }

  /** The service's model as id, version and the start of its checksum: a new model changes the verdict memo's key. */
  get version(): string {
    return this.model ? `${this.model.id}@${this.model.version}#${this.model.sha256.slice(0, 12).toLowerCase()}` : "unknown";
  }

  /** Where the service is (origin only), for the detector list. */
  get origin(): string {
    return this.base.origin;
  }

  status(): EngineStatus {
    return { ...this.state, ...(this.model && !this.state.model ? { model: this.model } : {}) };
  }

  /** Asks the service's health when the last answer is older than `maxAgeMs`; never throws. */
  async refreshStatus(maxAgeMs = HEALTH_TTL_MS): Promise<void> {
    if (this.checkedAt !== null && this.now() - this.checkedAt < maxAgeMs) return;
    if (!this.pendingHealth) {
      // promise-ok: kept so concurrent callers share one health request; awaited just below.
      this.pendingHealth = this.checkHealth().finally(() => {
        this.pendingHealth = null;
      });
    }
    await this.pendingHealth;
  }

  async recognize(texts: string[], request: GuardEntityRequest): Promise<GuardEntitySpan[][]> {
    const labels = ENTITY_DATA_CLASSES.filter((dataClass) => request.classes.includes(dataClass));
    const out: GuardEntitySpan[][] = texts.map(() => []);
    if (labels.length === 0) return out;
    const pieceChars = Math.min(MAX_PIECE_CHARS, this.options.maxRequestChars);
    const pieces = texts.flatMap((text, index) => piecesOf(text, index, pieceChars));
    for (const batch of batchesOf(pieces, this.options.maxRequestChars)) {
      if (request.signal?.aborted) throw new EntityEndpointError("The names and addresses check was stopped");
      const results = await this.post(batch.map((piece) => piece.value), labels, request.minScore, request.signal);
      batch.forEach((piece, position) => {
        for (const entity of results[position]!) {
          if (entity.end > piece.value.length || entity.end <= entity.start) {
            throw this.contractError("The names and addresses service answered offsets outside a text (offsets must be UTF-16 code units)");
          }
          if (!(labels as readonly string[]).includes(entity.label)) throw this.contractError("The names and addresses service answered a label that was not asked for");
          const start = entity.start + piece.offset;
          if (start < piece.from || start >= piece.to) continue;
          out[piece.text]!.push({ start, end: entity.end + piece.offset, dataClass: entity.label, score: entity.score, source: `${this.id}:${entity.label}` });
        }
      });
    }
    return out;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private contractError(message: string): EntityEndpointError {
    this.state = { status: "error", error: message };
    return new EntityEndpointError(message);
  }

  /** One `POST /v1/entities`; the results, one per text. */
  private async post(texts: string[], labels: string[], threshold: number | undefined, signal: AbortSignal | undefined) {
    const body = { texts, labels, language: "en", ...(threshold !== undefined ? { threshold } : {}) };
    const response = await this.request("v1/entities", { method: "POST", body: JSON.stringify(body) }, this.options.timeoutMs, signal);
    if (!response.ok) {
      const code = await errorCodeOf(response);
      const message = `The names and addresses service answered ${response.status}${code ? ` (${code})` : ""}`;
      this.state = response.status === 503 ? { status: "not_ready", message } : { status: "error", error: message };
      throw new EntityEndpointError(message);
    }
    let answer: unknown;
    try {
      answer = JSON.parse(await readCapped(response, ENDPOINT_MAX_RESPONSE_BYTES));
    } catch {
      throw this.contractError("The names and addresses service's answer is not JSON or is too large");
    }
    const parsed = entityEndpointResponseSchema.safeParse(answer);
    if (!parsed.success) throw this.contractError("The names and addresses service's answer does not follow the contract");
    if (parsed.data.results.length !== texts.length) throw this.contractError("The names and addresses service answered a different number of results than texts sent");
    this.model = parsed.data.model;
    this.state = { status: "loaded", model: parsed.data.model };
    this.checkedAt = this.now();
    return parsed.data.results.map((result) => result.entities);
  }

  private async checkHealth(): Promise<void> {
    try {
      const response = await this.request("health", { method: "GET" }, Math.min(HEALTH_TIMEOUT_MS, this.options.timeoutMs));
      let body: unknown;
      try {
        body = JSON.parse(await readCapped(response, SMALL_RESPONSE_BYTES));
      } catch {
        body = undefined;
      }
      const parsed = entityEndpointHealthSchema.safeParse(body);
      if (!parsed.success) {
        this.state = { status: "error", error: `The names and addresses service's health answer (${response.status}) does not follow the contract` };
      } else {
        const health = parsed.data;
        if (health.model) this.model = health.model;
        const message = health.message ? clip(health.message) : undefined;
        this.state =
          health.ok && health.ready
            ? { status: "loaded", ...(health.model ? { model: health.model } : {}), ...(message ? { message } : {}) }
            : health.ok
              ? { status: "not_ready", message: message ?? "The service runs but has no model loaded" }
              : { status: "error", error: message ?? "The service reports a problem" };
      }
    } catch (error) {
      this.state = { status: "error", error: error instanceof EntityEndpointError ? error.message : "The names and addresses service cannot be reached" };
    }
    this.checkedAt = this.now();
  }

  /** A request to the service: checked and pinned, no redirects, its own time limit, stopped with `signal`. */
  private async request(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers = new Headers({ accept: "application/json" });
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (this.options.token) headers.set("authorization", `Bearer ${this.options.token}`);
    const url = new URL(path, this.base).toString();
    const attempt = guardedFetch(url, { ...init, headers, signal: combined }, {
      config: this.policy,
      resolver: abortableResolver(this.options.resolver ?? nodeDnsResolver, combined),
      maxRedirects: 0,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
    });
    try {
      return await raceAbort(attempt, combined);
    } catch {
      if (signal?.aborted) throw new EntityEndpointError("The names and addresses check was stopped");
      const message = timeout.aborted ? `The names and addresses service did not answer within ${timeoutMs} ms` : "The names and addresses service cannot be reached";
      this.state = { status: "error", error: message };
      throw new EntityEndpointError(message);
    }
  }
}

/** The allow-list entry that lets the configured service through OUTBOUND_DENY_PRIVATE: its host and port, or its address. */
function allowEntryFor(base: URL): string {
  const host = base.hostname.replace(/^\[|\]$/g, "");
  const literal = parseIp(host);
  if (literal) return `${host}/${literal.bytes.length * 8}`;
  return `${host}:${base.port || (base.protocol === "https:" ? "443" : "80")}`;
}

/** A text as pieces of at most `size` characters, overlapping by PIECE_OVERLAP and cut at white space where possible. */
export function piecesOf(text: string, index: number, size: number): Piece[] {
  if (text.length === 0) return [];
  if (text.length <= size) return [{ text: index, offset: 0, from: 0, to: text.length, value: text }];
  const overlap = Math.min(PIECE_OVERLAP, Math.floor(size / 4));
  const pieces: Piece[] = [];
  let start = 0;
  for (;;) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      // Cut at the last white space in the piece's final quarter, so a word is not split.
      const space = text.slice(start + Math.floor((size * 3) / 4), end).search(/\s\S*$/);
      if (space >= 0) end = start + Math.floor((size * 3) / 4) + space + 1;
    }
    pieces.push({ text: index, offset: start, from: 0, to: 0, value: text.slice(start, end) });
    if (end >= text.length) break;
    start = end - overlap;
  }
  // Ownership: the overlap between two pieces is split in the middle.
  pieces.forEach((piece, position) => {
    const previous = pieces[position - 1];
    const next = pieces[position + 1];
    piece.from = previous ? Math.floor((piece.offset + previous.offset + previous.value.length) / 2) : 0;
    piece.to = next ? Math.floor((next.offset + piece.offset + piece.value.length) / 2) : text.length;
  });
  return pieces;
}

/** Pieces in request-sized groups: at most 64 pieces and `maxChars` characters each. */
export function batchesOf(pieces: readonly Piece[], maxChars: number): Piece[][] {
  const batches: Piece[][] = [];
  let current: Piece[] = [];
  let chars = 0;
  for (const piece of pieces) {
    if (current.length > 0 && (current.length >= ENTITY_ENDPOINT_MAX_TEXTS || chars + piece.value.length > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(piece);
    chars += piece.value.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** The service's error code, when its error answer follows the contract (its message is not kept). */
async function errorCodeOf(response: Response): Promise<string | undefined> {
  try {
    const parsed = entityEndpointErrorSchema.safeParse(JSON.parse(await readCapped(response, SMALL_RESPONSE_BYTES)));
    return parsed.success && /^[A-Za-z0-9_.-]{1,64}$/.test(parsed.data.error.code) ? parsed.data.error.code : undefined;
  } catch {
    return undefined;
  }
}

function clip(text: string): string {
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** Rejects as soon as `signal` aborts, even when the work does not listen for it. */
async function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    throw signal.reason;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    work.catch(() => undefined);
  }
}
