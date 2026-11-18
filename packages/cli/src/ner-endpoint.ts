/**
 * A names and addresses recognizer over the entity endpoint contract (l2m-ner or any service that speaks it), for
 * `l2m guard benchmark --entities --endpoint <url>`. The token, when the service asks for one, comes from
 * L2M_NER_TOKEN only (never a flag, so it stays out of process lists and CI logs). Answers are checked, not trusted.
 */
import type { GuardEntityRecognizer, GuardEntitySpan } from "@ai-orchestrator/guard-sdk";

export const NER_ENDPOINT_LABELS = ["person_name", "location", "street_address"] as const;
const MAX_TEXTS_PER_REQUEST = 64;

export interface NerEndpointModel {
  id: string;
  version: string;
  sha256: string;
}

export interface NerEndpointOptions {
  /** Base URL, without /v1/entities. */
  url: string;
  token?: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export class NerEndpointError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function base(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NerEndpointError("--endpoint is not a URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new NerEndpointError("--endpoint must be an http or https URL");
  if (parsed.username || parsed.password) throw new NerEndpointError("--endpoint must not carry credentials; set L2M_NER_TOKEN");
  return parsed.toString().replace(/\/+$/, "");
}

function parseModel(value: unknown): NerEndpointModel | null {
  if (!isObject(value)) return null;
  const { id, version, sha256 } = value;
  if (typeof id !== "string" || typeof version !== "string" || typeof sha256 !== "string" || id.length > 200 || version.length > 200 || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  return { id, version, sha256 };
}

async function call(options: NerEndpointOptions, path: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${base(options.url)}${path}`, { ...init, headers, signal: AbortSignal.timeout(options.timeoutMs), redirect: "error" });
  } catch (error) {
    if (error instanceof NerEndpointError) throw error;
    throw new NerEndpointError(`The entity endpoint did not answer (${error instanceof Error ? error.name : "error"})`);
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function errorOf(status: number, body: unknown): string {
  const error = isObject(body) && isObject(body.error) ? body.error : undefined;
  const code = typeof error?.code === "string" ? error.code.slice(0, 40) : "error";
  const message = typeof error?.message === "string" ? error.message.slice(0, 200) : "";
  return `HTTP ${status} ${code}${message ? `: ${message}` : ""}`;
}

/** GET /health: the model the service runs, or an error saying why it cannot be measured. */
export async function nerEndpointModel(options: NerEndpointOptions): Promise<NerEndpointModel> {
  const { status, body } = await call(options, "/health", { method: "GET" });
  if (!isObject(body)) throw new NerEndpointError(`The entity endpoint's /health answered HTTP ${status} without JSON`);
  if (body.ready !== true) {
    const message = typeof body.message === "string" ? body.message.slice(0, 300) : "no message";
    throw new NerEndpointError(`The entity endpoint is not ready: ${message}`);
  }
  const model = parseModel(body.model);
  if (!model) throw new NerEndpointError("The entity endpoint's /health has no valid model");
  return model;
}

/** Spans of one result, checked against its text: integer offsets in range, a known label, a finite score in 0..1. */
function spansOf(result: unknown, text: string, wanted: ReadonlySet<string>, source: string): GuardEntitySpan[] {
  if (!isObject(result) || !Array.isArray(result.entities)) throw new NerEndpointError("The entity endpoint's answer has a result without entities");
  const spans: GuardEntitySpan[] = [];
  for (const entity of result.entities) {
    if (!isObject(entity)) throw new NerEndpointError("The entity endpoint's answer has a malformed entity");
    const { start, end, label, score } = entity;
    if (!Number.isInteger(start) || !Number.isInteger(end) || typeof label !== "string" || typeof score !== "number" || !Number.isFinite(score)) {
      throw new NerEndpointError("The entity endpoint's answer has a malformed entity");
    }
    if ((start as number) < 0 || (end as number) > text.length || (end as number) <= (start as number) || score < 0 || score > 1) {
      throw new NerEndpointError("The entity endpoint's answer has an entity out of range");
    }
    if (!wanted.has(label)) continue;
    spans.push({ start: start as number, end: end as number, dataClass: label, score, source });
  }
  return spans;
}

export function createNerEndpointRecognizer(options: NerEndpointOptions, model: NerEndpointModel): GuardEntityRecognizer {
  const source = `endpoint:${model.id}`.slice(0, 64);
  return {
    id: "endpoint",
    version: `${model.id}@${model.version}`,
    classes: NER_ENDPOINT_LABELS,
    languages: ["en"],
    async recognize(texts, request) {
      const labels = request.classes.filter((label) => (NER_ENDPOINT_LABELS as readonly string[]).includes(label));
      if (labels.length === 0) return texts.map(() => []);
      const wanted = new Set(labels);
      const out: GuardEntitySpan[][] = [];
      for (let first = 0; first < texts.length; first += MAX_TEXTS_PER_REQUEST) {
        request.signal?.throwIfAborted();
        const batch = texts.slice(first, first + MAX_TEXTS_PER_REQUEST);
        const { status, body } = await call(options, "/v1/entities", { method: "POST", body: JSON.stringify({ texts: batch, labels, language: request.language ?? "en" }) });
        if (status !== 200) throw new NerEndpointError(`The entity endpoint refused the request: ${errorOf(status, body)}`);
        const results = isObject(body) && Array.isArray(body.results) ? (body.results as unknown[]) : undefined;
        if (!isObject(body) || !results || results.length !== batch.length) throw new NerEndpointError("The entity endpoint's answer does not line up with the texts");
        const answered = parseModel(body.model);
        if (!answered || answered.sha256 !== model.sha256) throw new NerEndpointError("The entity endpoint answered with another model than /health named");
        batch.forEach((text, index) => out.push(spansOf(results[index], text, wanted, source)));
      }
      return out;
    }
  };
}
