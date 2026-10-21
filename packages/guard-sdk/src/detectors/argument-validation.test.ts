import { describe, expect, it } from "vitest";
import type { GuardFinding } from "../types";
import { createArgumentValidationDetector, strictSchema, validateToolArguments } from "./argument-validation";

const schema = {
  type: "object",
  properties: {
    query: { type: "string", maxLength: 100 },
    limit: { type: "integer", minimum: 1 },
    filter: { type: "object", properties: { tag: { type: "string" } } }
  },
  required: ["query"]
};

describe("argument validation", () => {
  it("accepts valid arguments and rejects type, required and additional-property violations", () => {
    expect(validateToolArguments({ query: "x", limit: 2 }, schema)).toEqual([]);
    expect(validateToolArguments({ limit: 2 }, schema).map((i) => i.code)).toEqual(["schema"]);
    expect(validateToolArguments({ query: "x", limit: "2" }, schema)[0]!.path).toBe("limit");
    const extra = validateToolArguments({ query: "x", bogus: 1 }, schema);
    expect(extra[0]!.message).toContain("bogus");
    expect(validateToolArguments({ query: "x", bogus: 1 }, schema, { rejectAdditional: false })).toEqual([]);
    expect(validateToolArguments({ query: "x", filter: { tag: "a", other: 1 } }, schema)[0]!.path).toBe("filter");
  });

  it("applies size, depth, string, array and property limits before validation", () => {
    expect(validateToolArguments({ query: "x".repeat(50) }, schema, { maxBytes: 20 })[0]!.code).toBe("too_large");
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 40; i += 1) deep = { d: deep };
    expect(validateToolArguments(deep, undefined)[0]!.code).toBe("too_deep");
    expect(validateToolArguments({ query: "x".repeat(10) }, schema, { maxStringLength: 5 })[0]!.code).toBe("string_too_long");
    expect(validateToolArguments({ items: [1, 2, 3] }, undefined, { maxArrayLength: 2 })[0]!.code).toBe("array_too_long");
    expect(validateToolArguments({ a: 1, b: 2, c: 3 }, undefined, { maxProperties: 2 })[0]!.code).toBe("too_many_properties");
  });

  it("rejects non-object arguments for object schemas and uncompilable schemas", () => {
    expect(validateToolArguments("text", schema)[0]!.code).toBe("not_an_object");
    expect(validateToolArguments({ a: 1 }, { type: "object", properties: { a: { type: "nope" } } })[0]!.code).toBe("schema_invalid");
  });

  it("tightens object schemas without touching explicit additionalProperties", () => {
    const strict = strictSchema({ type: "object", properties: { a: { type: "object", additionalProperties: true } } }) as { additionalProperties: unknown; properties: { a: { additionalProperties: unknown } } };
    expect(strict.additionalProperties).toBe(false);
    expect(strict.properties.a.additionalProperties).toBe(true);
  });

  it("detector uses the tool's input schema and reports each issue", () => {
    const detector = createArgumentValidationDetector();
    const content = { query: 5, bogus: "x" };
    const text = JSON.stringify(content);
    const findings = detector.detect({ channel: "tool_arguments", content, tool: { toolName: "search", inputSchema: schema } }, { text, options: {}, now: () => 0 }) as GuardFinding[];
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.category === "schema_violation" && f.score === 1)).toBe(true);
    expect(detector.detect({ channel: "tool_arguments", content: { query: "ok" }, tool: { toolName: "search", inputSchema: schema } }, { text: "", options: {}, now: () => 0 })).toEqual([]);
    expect(detector.detect({ channel: "tool_arguments", content: { anything: 1 }, tool: { toolName: "search" } }, { text: "", options: {}, now: () => 0 })).toEqual([]);
  });
});
