import { z } from "zod";

/**
 * The names and addresses service contract, defined once here: the API is the client, and the l2m-ner service
 * (`apps/ner`, which also publishes it as `apps/ner/openapi.json`) is the reference server. A deployment may run any
 * service that speaks it.
 *
 * - `POST {base}/v1/entities` with `{ texts, labels, language, threshold? }` answers one result per text, in order.
 *   Offsets are UTF-16 code units into each text (JavaScript string indices), half-open `[start, end)`.
 * - `GET {base}/health` says whether a model is loaded (`ready`) and which.
 * - Errors are `{ error: { code, message } }` with 400, 401, 413, 429 or 503, and never quote the input. An
 *   overloaded service answers code `busy` (429, with Retry-After).
 * - An optional `Authorization: Bearer <token>`.
 *
 * This file imports nothing but zod, so l2m-ner (built on its own, with NodeNext resolution) can import its types.
 */

/** The labels a request may ask for: the `data.entities` classes of content rules. */
export const ENTITY_ENDPOINT_LABELS = ["person_name", "location", "street_address"] as const;
export type EntityEndpointLabel = (typeof ENTITY_ENDPOINT_LABELS)[number];

/** Texts in one request at most. */
export const ENTITY_ENDPOINT_MAX_TEXTS = 64;

/**
 * The error codes a service may answer. A client tolerates others. `busy` (429) is the overload answer: too many
 * requests in progress, try again after Retry-After.
 */
export const ENTITY_ENDPOINT_ERROR_CODES = [
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
export type EntityEndpointErrorCode = (typeof ENTITY_ENDPOINT_ERROR_CODES)[number];

export const entityEndpointModelSchema = z.object({
  id: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  /** The model file's SHA-256 (hex); read as text, so a service that adds a prefix still works. */
  sha256: z.string().min(1).max(128)
});
export type EntityEndpointModel = z.infer<typeof entityEndpointModelSchema>;

export const entityEndpointRequestSchema = z
  .object({
    texts: z.array(z.string()).min(1).max(ENTITY_ENDPOINT_MAX_TEXTS),
    labels: z.array(z.enum(ENTITY_ENDPOINT_LABELS)).min(1).max(ENTITY_ENDPOINT_LABELS.length),
    language: z.literal("en"),
    threshold: z.number().min(0).max(1).optional()
  })
  .strict();
export type EntityEndpointRequest = z.infer<typeof entityEndpointRequestSchema>;

export const entityEndpointEntitySchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  label: z.string().min(1).max(64),
  score: z.number().min(0).max(1)
});
export type EntityEndpointEntity = z.infer<typeof entityEndpointEntitySchema>;

export const entityEndpointResponseSchema = z.object({
  results: z.array(z.object({ entities: z.array(entityEndpointEntitySchema).max(10_000) })),
  model: entityEndpointModelSchema
});
export type EntityEndpointResponse = z.infer<typeof entityEndpointResponseSchema>;

export const entityEndpointHealthSchema = z.object({
  ok: z.boolean(),
  ready: z.boolean(),
  model: entityEndpointModelSchema.nullable(),
  message: z.string().max(1000).optional()
});
export type EntityEndpointHealth = z.infer<typeof entityEndpointHealthSchema>;

export const entityEndpointErrorSchema = z.object({
  error: z.object({ code: z.string().min(1).max(100), message: z.string().max(1000) })
});
export type EntityEndpointErrorBody = z.infer<typeof entityEndpointErrorSchema>;
