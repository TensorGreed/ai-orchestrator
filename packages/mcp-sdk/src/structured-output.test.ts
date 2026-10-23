import { describe, expect, it } from "vitest";
import { __scorerSchemaCacheStats, checkStructuredContent, validateJsonSchema } from "./structured-output";

describe("validateJsonSchema", () => {
  const schema = { type: "object", required: ["answer"], properties: { answer: { type: "string" }, score: { type: "number", minimum: 0 } } };

  it("accepts a conforming value", () => {
    expect(validateJsonSchema(schema, { answer: "hi", score: 1 })).toEqual({ ok: true });
  });

  it("says what does not conform (the first error: scorer schemas stop there)", () => {
    const result = validateJsonSchema(schema, { score: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invalidSchema).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors.join(" ")).toContain("answer");
    const second = validateJsonSchema(schema, { answer: "a", score: -1 });
    expect(!second.ok && second.errors.join(" ")).toContain("/score");
  });

  it("reports a schema that cannot be compiled instead of passing", () => {
    const result = validateJsonSchema({ type: "not-a-type" }, {});
    expect(result).toMatchObject({ ok: false, invalidSchema: true });
  });

  it("never registers a scorer's $id where MCP tool output checks can see it", () => {
    const nested = { type: "object", properties: { item: { $id: "https://example.test/item", type: "object", required: ["id"], properties: { id: { type: "string" } } } } };
    expect(validateJsonSchema(nested, { item: { id: "x" } })).toEqual({ ok: true });
    expect(validateJsonSchema(nested, { item: {} }).ok).toBe(false);
    // An MCP outputSchema cannot reach the scorer's schema by its id: the reference stays unresolved there.
    const outputSchema = { type: "object", properties: { item: { $ref: "https://example.test/item" } } };
    const checked = checkStructuredContent("tool", outputSchema, { item: {} });
    expect(checked).toMatchObject({ ok: true, warning: expect.stringContaining("could not be compiled") });
    // And a tool schema that declares the same nested $id still compiles and validates on its own.
    const own = { type: "object", required: ["item"], properties: { item: { $id: "https://example.test/item", type: "object", required: ["name"] } } };
    expect(checkStructuredContent("tool", own, { item: { name: "n" } })).toEqual({ ok: true, structured: { item: { name: "n" } } });
    expect(checkStructuredContent("tool", own, { item: { id: "x" } }).ok).toBe(false);
    // A property literally named "$id" is data, not an id, and survives.
    expect(validateJsonSchema({ type: "object", required: ["$id"], properties: { $id: { type: "string" } } }, {}).ok).toBe(false);
  });

  it("refuses schemas that are too deep or hold an exponential pattern", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 40; index += 1) deep = { type: "object", properties: { a: deep } };
    expect(validateJsonSchema(deep, {})).toMatchObject({ ok: false, invalidSchema: true, errors: [expect.stringContaining("deeper than 32")] });
    expect(validateJsonSchema({ type: "string", pattern: "^(a+)+$" }, "a".repeat(40) + "!")).toMatchObject({ ok: false, invalidSchema: true, errors: [expect.stringContaining("nested quantifiers")] });
  });

  it("keeps at most 200 compiled scorer schemas and frees what it evicts", () => {
    for (let index = 0; index < 260; index += 1) validateJsonSchema({ type: "object", properties: { [`k${index}`]: { type: "number" } } }, {});
    const stats = __scorerSchemaCacheStats();
    expect(stats.cached).toBeLessThanOrEqual(200);
    expect(stats.ajvSchemas).toBeLessThanOrEqual(stats.cached + 5);
  });
});
