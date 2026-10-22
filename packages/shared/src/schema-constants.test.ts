import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runManifestConstantGuide, runManifestConstantWords } from "./audit-manifest";
import { schemaConstantGuide, schemaConstantWords, type SchemaConstantGuide } from "./schema-constants";

const constantsOf = (guide: SchemaConstantGuide | undefined) => [...(guide?.constants ?? [])].sort();

describe("schemaConstantGuide", () => {
  it("collects string enum and literal constants", () => {
    expect(constantsOf(schemaConstantGuide(z.enum(["approve", "reject"])))).toEqual(["approve", "reject"]);
    expect(constantsOf(schemaConstantGuide(z.literal("Ed25519")))).toEqual(["Ed25519"]);
    expect(constantsOf(schemaConstantGuide(z.literal(["a1", "b2"])))).toEqual(["a1", "b2"]);
  });

  it("ignores numeric and boolean literals and free strings, including format-constrained ones", () => {
    expect(schemaConstantGuide(z.literal(1)).constants).toBeUndefined();
    expect(schemaConstantGuide(z.literal(true)).constants).toBeUndefined();
    expect(schemaConstantGuide(z.string()).constants).toBeUndefined();
    expect(schemaConstantGuide(z.string().regex(/^[a-f0-9]{64}$/)).constants).toBeUndefined();
    expect(schemaConstantGuide(z.string().url()).constants).toBeUndefined();
    expect(schemaConstantGuide(z.string().min(1)).constants).toBeUndefined();
  });

  it("sees through optional, nullable, default, readonly, catch and pipe wrappers", () => {
    const base = z.enum(["captured", "current"]);
    const wrapped: z.ZodType[] = [
      base.optional(),
      base.nullable(),
      base.nullable().optional(),
      base.default("current"),
      base.readonly(),
      base.catch("current"),
      base.transform((value) => value.toUpperCase())
    ];
    for (const schema of wrapped) {
      expect(constantsOf(schemaConstantGuide(schema))).toEqual(["captured", "current"]);
    }
  });

  it("maps declared object keys to their values' guides, and undeclared keys to the catchall", () => {
    const guide = schemaConstantGuide(
      z
        .object({ outcome: z.enum(["ok", "policy_blocked"]), name: z.string(), nested: z.object({ role: z.literal("system") }).nullable() })
        .catchall(z.enum(["extra"]))
    );
    expect([...guide.keys!.keys()].sort()).toEqual(["name", "nested", "outcome"]);
    expect(constantsOf(guide.keys!.get("outcome"))).toEqual(["ok", "policy_blocked"]);
    expect(guide.keys!.get("name")!.constants).toBeUndefined();
    expect(constantsOf(guide.keys!.get("nested")!.keys!.get("role"))).toEqual(["system"]);
    expect(constantsOf(guide.rest)).toEqual(["extra"]);
  });

  it("follows array elements, tuples and record values; enum record keys count as declared keys", () => {
    const guide = schemaConstantGuide(z.object({ list: z.array(z.object({ decision: z.enum(["approve"]) })), pair: z.tuple([z.literal("left"), z.string()]) }));
    expect(constantsOf(guide.keys!.get("list")!.element!.keys!.get("decision"))).toEqual(["approve"]);
    expect(constantsOf(guide.keys!.get("pair")!.element)).toEqual(["left"]);
    const free = schemaConstantGuide(z.record(z.string(), z.literal("value")));
    expect(free.keys).toBeUndefined();
    expect(constantsOf(free.rest)).toEqual(["value"]);
    const keyed = schemaConstantGuide(z.record(z.enum(["alpha", "beta"]), z.number()));
    expect([...keyed.keys!.keys()].sort()).toEqual(["alpha", "beta"]);
  });

  it("merges the options of unions and discriminated unions", () => {
    expect(constantsOf(schemaConstantGuide(z.union([z.enum(["success", "error"]), z.string()])))).toEqual(["error", "success"]);
    const guide = schemaConstantGuide(
      z.discriminatedUnion("kind", [z.object({ kind: z.literal("http"), url: z.string() }), z.object({ kind: z.literal("stdio"), command: z.string() })])
    );
    expect(constantsOf(guide.keys!.get("kind"))).toEqual(["http", "stdio"]);
    expect([...guide.keys!.keys()].sort()).toEqual(["command", "kind", "url"]);
  });

  it("handles intersections and recursive lazy schemas without looping", () => {
    const merged = schemaConstantGuide(z.intersection(z.object({ a: z.literal("one") }), z.object({ b: z.literal("two") })));
    expect([...merged.keys!.keys()].sort()).toEqual(["a", "b"]);
    interface Tree {
      kind: "leaf" | "branch";
      children: Tree[];
    }
    const tree: z.ZodType<Tree> = z.lazy(() => z.object({ kind: z.enum(["leaf", "branch"]), children: z.array(tree) }));
    const guide = schemaConstantGuide(tree);
    expect(constantsOf(guide.keys!.get("kind"))).toEqual(["branch", "leaf"]);
    expect(constantsOf(guide.keys!.get("children")!.element!.keys!.get("kind"))).toEqual(["branch", "leaf"]);
  });

  it("lists every constant and declared key as words", () => {
    const words = schemaConstantWords(schemaConstantGuide(z.object({ status: z.enum(["success"]), items: z.array(z.object({ role: z.literal("system") })) })));
    expect([...words].sort()).toEqual(["items", "role", "status", "success", "system"]);
  });
});

describe("run manifest constants", () => {
  it("derives the manifest's enum and literal positions from its schema", () => {
    const guide = runManifestConstantGuide();
    expect(constantsOf(guide.keys!.get("format"))).toEqual(["l2m.run-manifest"]);
    expect(constantsOf(guide.keys!.get("deployment")!.keys!.get("algorithm"))).toEqual(["Ed25519"]);
    expect(constantsOf(guide.keys!.get("workflow")!.keys!.get("source"))).toEqual(["captured", "current", "unavailable"]);
    expect(constantsOf(guide.keys!.get("prompts")!.element!.keys!.get("role"))).toEqual(["system", "user"]);
    expect(constantsOf(guide.keys!.get("approvals")!.element!.keys!.get("decision"))).toEqual(["approve", "reject"]);
    expect(constantsOf(guide.keys!.get("toolCalls")!.element!.keys!.get("outcome"))).toContain("policy_blocked");
    expect(constantsOf(guide.keys!.get("run")!.keys!.get("status"))).toEqual(expect.arrayContaining(["success", "error", "partial", "canceled"]));
    expect(constantsOf(guide.keys!.get("nodes")!.element!.keys!.get("status"))).toEqual(expect.arrayContaining(["success", "skipped", "not_run"]));
  });

  it("leaves free-text and format-constrained positions without constants", () => {
    const guide = runManifestConstantGuide();
    expect(guide.keys!.get("workflow")!.keys!.get("hash")!.constants).toBeUndefined();
    expect(guide.keys!.get("nodes")!.element!.keys!.get("name")!.constants).toBeUndefined();
    expect(guide.keys!.get("nodes")!.element!.keys!.get("config")!.rest).toEqual({});
    expect(guide.keys!.get("mcpServers")!.element!.keys!.get("url")!.constants).toBeUndefined();
    expect(guide.keys!.get("prompts")!.element!.keys!.get("rendered")!.constants).toBeUndefined();
  });

  it("exposes one word set for the scrubber exemption and the save-time warning", () => {
    const words = runManifestConstantWords();
    for (const word of ["success", "captured", "system", "Ed25519", "workflow", "executionId"]) expect(words.has(word)).toBe(true);
    expect(words.has("Success")).toBe(false);
    expect(runManifestConstantWords()).toBe(words);
  });
});
