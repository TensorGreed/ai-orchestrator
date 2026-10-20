import { describe, expect, it } from "vitest";
import { diffToolSnapshots, hashToolSnapshot, normalizeToolSnapshot, type McpToolSnapshotEntry } from "./schema-diff";

const search = (inputSchema: Record<string, unknown>, description = "Search issues"): McpToolSnapshotEntry => ({
  name: "search_issues",
  description,
  inputSchema
});

const base = search({
  type: "object",
  properties: {
    query: { type: "string" },
    state: { type: "string", enum: ["open", "closed"] },
    limit: { type: "number" }
  },
  required: ["query"]
});

function kinds(before: McpToolSnapshotEntry[], after: McpToolSnapshotEntry[]) {
  return diffToolSnapshots(before, after).changes.map((change) => `${change.kind}:${change.path ?? change.tool}:${change.breaking}`);
}

describe("hashToolSnapshot", () => {
  it("ignores key and tool order", () => {
    const a = [
      { name: "b", description: "", inputSchema: { type: "object", properties: { x: { type: "string" } } } },
      { name: "a", description: "", inputSchema: { properties: { y: { type: "number" } }, type: "object" } }
    ];
    const b = [
      { name: "a", description: "", inputSchema: { type: "object", properties: { y: { type: "number" } } } },
      { name: "b", description: "", inputSchema: { properties: { x: { type: "string" } }, type: "object" } }
    ];
    expect(hashToolSnapshot(a)).toBe(hashToolSnapshot(b));
  });

  it("changes when a schema changes", () => {
    expect(hashToolSnapshot([base])).not.toBe(
      hashToolSnapshot([search({ ...base.inputSchema, required: ["query", "limit"] })])
    );
  });

  it("treats a missing description and schema as empty", () => {
    expect(normalizeToolSnapshot([{ name: "t" }])).toEqual([{ name: "t", description: "", inputSchema: {} }]);
  });
});

describe("diffToolSnapshots", () => {
  it("reports nothing for identical snapshots", () => {
    expect(diffToolSnapshots([base], [base])).toEqual({ changes: [], breaking: false });
  });

  it("flags removed tools as breaking and added tools as not", () => {
    const other: McpToolSnapshotEntry = { name: "create_issue", inputSchema: { type: "object" } };
    expect(kinds([base], [other])).toEqual(["tool_removed:search_issues:true", "tool_added:create_issue:false"]);
  });

  it("separates required from optional property additions", () => {
    const after = search({
      type: "object",
      properties: { ...(base.inputSchema.properties as object), repo: { type: "string" }, page: { type: "number" } },
      required: ["query", "repo"]
    });
    expect(kinds([base], [after])).toEqual(["property_added:page:false", "property_added:repo:true"]);
  });

  it("flags removed properties and newly required ones", () => {
    const after = search({
      type: "object",
      properties: { query: { type: "string" }, state: { type: "string", enum: ["open", "closed"] } },
      required: ["query", "state"]
    });
    const diff = diffToolSnapshots([base], [after]);
    expect(diff.breaking).toBe(true);
    expect(kinds([base], [after])).toEqual(["property_removed:limit:true", "property_now_required:state:true"]);
  });

  it("treats relaxing a required property as non-breaking", () => {
    const after = search({ ...base.inputSchema, required: [] });
    expect(diffToolSnapshots([base], [after])).toMatchObject({
      breaking: false,
      changes: [{ kind: "property_no_longer_required", path: "query" }]
    });
  });

  it("distinguishes narrowed and widened types", () => {
    const narrowed = search({
      ...base.inputSchema,
      properties: { ...(base.inputSchema.properties as object), limit: { type: "integer" } }
    });
    const widened = search({
      ...base.inputSchema,
      properties: { ...(base.inputSchema.properties as object), limit: { type: ["number", "string"] } }
    });
    const untyped = search({
      ...base.inputSchema,
      properties: { ...(base.inputSchema.properties as object), limit: {} }
    });
    expect(kinds([base], [narrowed])).toEqual(["property_type_changed:limit:true"]);
    expect(kinds([base], [widened])).toEqual(["property_type_widened:limit:false"]);
    expect(kinds([base], [untyped])).toEqual(["property_type_widened:limit:false"]);
    expect(kinds([untyped], [base])).toEqual(["property_type_changed:limit:true"]);
  });

  it("flags removed enum values only", () => {
    const after = search({
      ...base.inputSchema,
      properties: { ...(base.inputSchema.properties as object), state: { type: "string", enum: ["open", "all"] } }
    });
    expect(kinds([base], [after])).toEqual(['enum_value_removed:state:true', 'enum_value_added:state:false']);
    const unconstrained = search({
      ...base.inputSchema,
      properties: { ...(base.inputSchema.properties as object), state: { type: "string" } }
    });
    expect(diffToolSnapshots([base], [unconstrained]).changes).toEqual([]);
  });

  it("recurses into nested objects and array items", () => {
    const nested = (filterRequired: string[], labelType: string) =>
      search({
        type: "object",
        properties: {
          filter: {
            type: "object",
            properties: { author: { type: "string" }, labels: { type: "array", items: { type: labelType } } },
            required: filterRequired
          }
        }
      });
    expect(kinds([nested([], "string")], [nested(["author"], "number")])).toEqual([
      "property_now_required:filter.author:true",
      "property_type_changed:filter.labels.items[]:true"
    ]);
  });

  it("records description edits as non-breaking", () => {
    expect(diffToolSnapshots([base], [search(base.inputSchema, "Search GitHub issues")])).toMatchObject({
      breaking: false,
      changes: [{ kind: "description_changed" }]
    });
  });
});
