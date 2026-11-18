import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NER_ERROR_CODES, NER_MAX_TEXTS, nerEntitiesRequestSchema } from "./contract.js";
import { NER_ENTITY_CLASSES } from "./models/manifest.js";

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
