import { z } from "zod";
import { NER_ENTITY_CLASSES } from "./models/manifest.js";

/**
 * The entity endpoint contract (also in openapi.json). Any service that speaks it can be the deployment's names and
 * addresses recognizer; l2m-ner is the reference implementation.
 *
 *   POST /v1/entities  { texts: string[1..64], labels: (person_name|location|street_address)[], language: "en", threshold?: 0..1 }
 *     → { results: [{ entities: [{ start, end, label, score }] }], model: { id, version, sha256 } }
 *   GET  /health       → { ok, ready, model: { id, version, sha256 } | null, message? }
 *
 * Offsets are UTF-16 code units (JavaScript string indices) into each text, half-open; results line up with texts.
 * Errors are `{ error: { code, message } }` with 400, 401, 413, 429 or 503, and never quote the input.
 */

export const NER_MAX_TEXTS = 64;

export const nerEntitiesRequestSchema = z
  .object({
    texts: z.array(z.string()).min(1).max(NER_MAX_TEXTS),
    labels: z
      .array(z.enum(NER_ENTITY_CLASSES))
      .min(1)
      .max(NER_ENTITY_CLASSES.length)
      .refine((labels) => new Set(labels).size === labels.length, "each label once"),
    language: z.string(),
    threshold: z.number().min(0).max(1).optional()
  })
  .strict();

export type NerEntitiesRequest = z.output<typeof nerEntitiesRequestSchema>;

export interface NerModelInfo {
  id: string;
  version: string;
  sha256: string;
}

export interface NerEntitiesResponse {
  results: Array<{ entities: Array<{ start: number; end: number; label: string; score: number }> }>;
  model: NerModelInfo;
}

export interface NerHealthResponse {
  ok: boolean;
  ready: boolean;
  model: NerModelInfo | null;
  message?: string;
}

export const NER_ERROR_CODES = [
  "bad_request",
  "unsupported_language",
  "unauthorized",
  "not_found",
  "method_not_allowed",
  "unsupported_media_type",
  "too_large",
  "busy",
  "not_ready",
  "timeout",
  "failed"
] as const;
export type NerErrorCode = (typeof NER_ERROR_CODES)[number];

export class NerHttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 405 | 413 | 415 | 429 | 503,
    readonly code: NerErrorCode,
    message: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(message);
  }
}

/**
 * Validation problems as paths and fixed reasons only: zod's own messages can quote the received value, and the
 * value here is the caller's text.
 */
export function describeRequestIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 5).map((issue) => {
    const where = issue.path.length > 0 ? issue.path.map(String).join(".") : "body";
    switch (issue.code) {
      case "invalid_type":
        return `${where}: wrong type`;
      case "too_small":
        return `${where}: too small or too few`;
      case "too_big":
        return `${where}: too large or too many`;
      case "invalid_value":
        return `${where}: not an allowed value`;
      case "unrecognized_keys":
        return `${where}: unknown field(s) ${issue.keys.slice(0, 5).map((key) => JSON.stringify(key.slice(0, 40))).join(", ")}`;
      default:
        return `${where}: invalid`;
    }
  });
  return parts.join("; ");
}
