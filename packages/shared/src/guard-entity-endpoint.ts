import { z } from "zod";
import { ENTITY_DATA_CLASSES } from "./guard-entities";

/**
 * The names and addresses service contract (the l2m-ner container implements it; a deployment may run any service
 * that does). The API is the client:
 *
 * - `POST {base}/v1/entities` with `{ texts, labels, language, threshold? }` answers one result per text, in order.
 *   Offsets are UTF-16 code units into each text (JavaScript string indices), half-open `[start, end)`.
 * - `GET {base}/health` says whether a model is loaded (`ready`) and which.
 * - Errors are `{ error: { code, message } }` with 400, 401, 413, 429 or 503, and never quote the input.
 * - An optional `Authorization: Bearer <token>`.
 */

/** Texts in one request at most. */
export const ENTITY_ENDPOINT_MAX_TEXTS = 64;

export const entityEndpointModelSchema = z.object({
  id: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  /** The model file's SHA-256 (hex); read as text, so a service that adds a prefix still works. */
  sha256: z.string().min(1).max(128)
});

export const entityEndpointRequestSchema = z
  .object({
    texts: z.array(z.string()).min(1).max(ENTITY_ENDPOINT_MAX_TEXTS),
    labels: z.array(z.enum(ENTITY_DATA_CLASSES)).min(1).max(ENTITY_DATA_CLASSES.length),
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
