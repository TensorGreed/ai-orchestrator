import { describe, expect, it } from "vitest";
import { validateJsonSchema } from "./structured-output";

describe("validateJsonSchema", () => {
  const schema = { type: "object", required: ["answer"], properties: { answer: { type: "string" }, score: { type: "number", minimum: 0 } } };

  it("accepts a conforming value", () => {
    expect(validateJsonSchema(schema, { answer: "hi", score: 1 })).toEqual({ ok: true });
  });

  it("lists what does not conform", () => {
    const result = validateJsonSchema(schema, { score: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invalidSchema).toBe(false);
    expect(result.errors.join(" ")).toContain("answer");
    expect(result.errors.join(" ")).toContain("/score");
  });

  it("reports a schema that cannot be compiled instead of passing", () => {
    const result = validateJsonSchema({ type: "not-a-type" }, {});
    expect(result).toMatchObject({ ok: false, invalidSchema: true });
  });

  it("caps the number of errors", () => {
    const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, { type: "string" }])) };
    const value = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    const result = validateJsonSchema(wide, value, 3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(3);
  });
});
