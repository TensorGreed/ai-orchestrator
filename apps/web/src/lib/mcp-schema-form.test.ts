import { describe, expect, it } from "vitest";
import { buildSchemaForm, collectArgs, initialFormValues, valuesFromArgs, type SchemaField } from "./mcp-schema-form";

const ticketSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short summary" },
    priority: { type: "string", enum: ["low", "normal", "high"] },
    labels: { type: "array", items: { type: "string" } },
    estimate: { type: "number", minimum: 0 },
    count: { type: "integer", default: 1 },
    urgent: { type: "boolean" },
    channels: { type: "array", items: { enum: ["email", "chat"] } },
    reporter: {
      type: "object",
      properties: {
        name: { type: "string" },
        notify: { type: "boolean" },
        address: { type: "object", properties: { city: { type: "string" } } }
      },
      required: ["name"]
    },
    filter: { anyOf: [{ type: "string" }, { type: "number" }] },
    rows: { type: "array", items: { type: "object", properties: { a: { type: "string" } } } }
  },
  required: ["title", "reporter"]
};

function byPath(fields: SchemaField[], path: string): SchemaField | undefined {
  for (const field of fields) {
    if (field.path === path) return field;
    if (field.kind === "object") {
      const nested = byPath(field.fields, path);
      if (nested) return nested;
    }
  }
  return undefined;
}

describe("buildSchemaForm", () => {
  it("maps scalars, enums, arrays and nested objects, with JSON for the rest", () => {
    const { fields } = buildSchemaForm(ticketSchema);
    expect(fields).not.toBeNull();
    const list = fields!;
    expect(byPath(list, "title")).toMatchObject({ kind: "string", required: true, description: "Short summary" });
    expect(byPath(list, "priority")).toMatchObject({ kind: "enum", options: ["low", "normal", "high"] });
    expect(byPath(list, "labels")).toMatchObject({ kind: "array", itemKind: "string" });
    expect(byPath(list, "estimate")).toMatchObject({ kind: "number", minimum: 0 });
    expect(byPath(list, "count")).toMatchObject({ kind: "integer" });
    expect(byPath(list, "urgent")).toMatchObject({ kind: "boolean", required: false });
    expect(byPath(list, "channels")).toMatchObject({ kind: "array", itemKind: "enum", options: ["email", "chat"] });
    expect(byPath(list, "reporter")).toMatchObject({ kind: "object", required: true });
    expect(byPath(list, "reporter.name")).toMatchObject({ kind: "string", required: true });
    expect(byPath(list, "reporter.address.city")).toMatchObject({ kind: "string" });
    expect(byPath(list, "filter")).toMatchObject({ kind: "json" });
    expect(byPath(list, "rows")).toMatchObject({ kind: "json" });
  });

  it("falls back to a JSON editor for schemas it cannot show as fields", () => {
    expect(buildSchemaForm({ type: "array" }).fields).toBeNull();
    expect(buildSchemaForm({ type: "object", additionalProperties: true }).fields).toBeNull();
    expect(buildSchemaForm({ oneOf: [{ type: "object" }], properties: {} }).fields).toBeNull();
    expect(buildSchemaForm({ type: "object" }).fields).toEqual([]);
    expect(buildSchemaForm(undefined).fields).toEqual([]);
  });

  it("accepts nullable types and const values", () => {
    const { fields } = buildSchemaForm({
      type: "object",
      properties: { note: { type: ["string", "null"] }, mode: { const: "fast" } }
    });
    expect(fields!.map((field) => field.kind)).toEqual(["string", "enum"]);
  });
});

describe("collectArgs", () => {
  const fields = buildSchemaForm(ticketSchema).fields!;

  it("builds typed, nested arguments and leaves empty optional fields out", () => {
    const { args, errors } = collectArgs(fields, {
      title: "Disk full",
      priority: "high",
      labels: ["ops", "", "disk"],
      estimate: "2.5",
      count: "3",
      urgent: false,
      channels: ["chat"],
      "reporter.name": "Ana",
      "reporter.notify": true,
      filter: '{"gt": 3}'
    });
    expect(errors).toEqual({});
    expect(args).toEqual({
      title: "Disk full",
      priority: "high",
      labels: ["ops", "disk"],
      estimate: 2.5,
      count: 3,
      urgent: false,
      channels: ["chat"],
      reporter: { name: "Ana", notify: true },
      filter: { gt: 3 }
    });
  });

  it("reports required, numeric, range and JSON errors by path", () => {
    const { errors } = collectArgs(fields, { estimate: "-1", count: "1.5", filter: "{nope" });
    expect(errors).toEqual({
      title: "Required",
      estimate: "At least 0",
      count: "Enter a whole number",
      "reporter.name": "Required",
      filter: "Not valid JSON"
    });
  });

  it("round-trips arguments through form values", () => {
    const args = { title: "T", reporter: { name: "Bo", address: { city: "Oslo" } }, labels: ["a"], urgent: true, rows: [{ a: "x" }] };
    const values = valuesFromArgs(fields, args);
    expect(values["reporter.address.city"]).toBe("Oslo");
    expect(collectArgs(fields, values).args).toEqual(args);
  });

  it("starts from schema defaults", () => {
    expect(initialFormValues(ticketSchema, fields)).toEqual({ count: "1" });
  });
});
