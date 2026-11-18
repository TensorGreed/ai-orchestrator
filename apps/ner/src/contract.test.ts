import { readFileSync } from "node:fs";
import {
  ENTITY_ENDPOINT_CALIBRATED_CUT,
  ENTITY_ENDPOINT_ERROR_CODES,
  ENTITY_ENDPOINT_LABELS,
  ENTITY_ENDPOINT_MAX_TEXTS,
  entityEndpointHealthSchema,
  entityEndpointRequestSchema,
  entityEndpointResponseSchema
} from "@ai-orchestrator/shared/src/guard-entity-endpoint.js";
import { describe, expect, it } from "vitest";
import { NER_ERROR_CODES, NER_MAX_TEXTS, nerEntitiesRequestSchema } from "./contract.js";
import { NER_ENTITY_CLASSES } from "./models/manifest.js";
import { NER_CALIBRATED_CUT } from "./spans.js";

/** openapi.json is the published contract: it has to say what the service does. */
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
const schemas = openapi.components.schemas;

describe("openapi.json", () => {
  it("states the request limits and labels the service enforces", () => {
    expect(schemas.EntitiesRequest.properties.texts.maxItems).toBe(NER_MAX_TEXTS);
    expect(schemas.EntitiesRequest.properties.texts.minItems).toBe(1);
    expect(schemas.Label.enum).toEqual([...NER_ENTITY_CLASSES]);
    expect(schemas.EntitiesRequest.additionalProperties).toBe(false);
    expect(schemas.EntitiesRequest.required).toEqual(["texts", "labels", "language"]);
  });

  it("lists exactly the error codes the service answers", () => {
    expect(schemas.Error.properties.error.properties.code.enum).toEqual([...NER_ERROR_CODES]);
  });

  it("agrees with the request schema on an example", () => {
    const example = { texts: ["Write to Anna Lee."], labels: ["person_name"], language: "en", threshold: 0.8 };
    expect(nerEntitiesRequestSchema.safeParse(example).success).toBe(true);
    expect(nerEntitiesRequestSchema.safeParse({ ...example, texts: Array.from({ length: NER_MAX_TEXTS + 1 }, () => "x") }).success).toBe(false);
  });
});

describe("the shared contract (packages/shared, used by the API's client)", () => {
  it("has the same limits, labels and error codes as the server", () => {
    expect(NER_MAX_TEXTS).toBe(ENTITY_ENDPOINT_MAX_TEXTS);
    expect([...NER_ENTITY_CLASSES]).toEqual([...ENTITY_ENDPOINT_LABELS]);
    expect([...NER_ERROR_CODES]).toEqual([...ENTITY_ENDPOINT_ERROR_CODES]);
    // The API reports the service's spans from this cut by default; the server maps each class's cut to it.
    expect(NER_CALIBRATED_CUT).toBe(ENTITY_ENDPOINT_CALIBRATED_CUT);
  });

  it("accepts every request the client sends and the server accepts", () => {
    const requests = [
      { texts: ["Write to Anna Lee."], labels: ["person_name"], language: "en" },
      { texts: ["a", "b"], labels: ["person_name", "location", "street_address"], language: "en", threshold: 0.8 },
      { texts: Array.from({ length: NER_MAX_TEXTS }, () => "x"), labels: ["location"], language: "en", threshold: 0 }
    ];
    for (const request of requests) {
      expect(entityEndpointRequestSchema.safeParse(request).success).toBe(true);
      expect(nerEntitiesRequestSchema.safeParse(request).success).toBe(true);
    }
    for (const request of [
      { texts: [], labels: ["location"], language: "en" },
      { texts: ["x"], labels: ["organization"], language: "en" },
      { texts: ["x"], labels: ["location"], language: "en", extra: true },
      { texts: ["x"], labels: ["location"], language: "en", threshold: 2 }
    ]) {
      expect(entityEndpointRequestSchema.safeParse(request).success).toBe(false);
      expect(nerEntitiesRequestSchema.safeParse(request).success).toBe(false);
    }
  });

  it("describes the server's answers as the client reads them", () => {
    const model = { id: "knowledgator/gliner-pii-base-v1.0", version: "abc123def456-0123abcd", sha256: "a".repeat(64) };
    expect(entityEndpointResponseSchema.safeParse({ results: [{ entities: [{ start: 9, end: 17, label: "person_name", score: 0.93 }] }], model }).success).toBe(true);
    expect(entityEndpointHealthSchema.safeParse({ ok: true, ready: false, model: null, message: "No model" }).success).toBe(true);
    expect(entityEndpointHealthSchema.safeParse({ ok: true, ready: true, model }).success).toBe(true);
  });
});
