import type { z } from "zod";

/**
 * The positions of a value tree where a zod schema fixes a string to one of
 * a few constants (`z.enum`, `z.literal`), and the object keys it declares.
 *
 * The secret scrubber uses it to leave a value alone at such a position
 * when the value is exactly one of that position's constants: replacing it
 * would only break validation of a value that is not secret material. Every
 * other string, including format-constrained ones (regex, URL, digest), is
 * free text to the guide.
 */
export interface SchemaConstantGuide {
  /** String constants allowed at this position. */
  constants?: ReadonlySet<string>;
  /** Declared object keys (and enum record keys), with the guide for their values. */
  keys?: ReadonlyMap<string, SchemaConstantGuide>;
  /** Guide for the values of undeclared keys (record values, an object's catchall). */
  rest?: SchemaConstantGuide;
  /** Guide for array and tuple elements. */
  element?: SchemaConstantGuide;
}

interface MutableGuide {
  constants?: Set<string>;
  keys?: Map<string, MutableGuide>;
  rest?: MutableGuide;
  element?: MutableGuide;
}

/** Recursive (`z.lazy`) schemas are followed this deep; manifests nest far less. */
const MAX_DEPTH = 24;

type LooseDef = Record<string, unknown> & { type?: string };

function defOf(schema: unknown): LooseDef | null {
  const internals = (schema as { _zod?: { def?: unknown } } | null)?._zod;
  const def = internals?.def;
  return def && typeof def === "object" ? (def as LooseDef) : null;
}

function merge(target: MutableGuide, source: MutableGuide): MutableGuide {
  if (source.constants) {
    target.constants ??= new Set();
    for (const constant of source.constants) target.constants.add(constant);
  }
  if (source.keys) {
    target.keys ??= new Map();
    for (const [key, guide] of source.keys) {
      const existing = target.keys.get(key);
      target.keys.set(key, existing ? merge(existing, guide) : guide);
    }
  }
  if (source.rest) target.rest = target.rest ? merge(target.rest, source.rest) : source.rest;
  if (source.element) target.element = target.element ? merge(target.element, source.element) : source.element;
  return target;
}

function stringConstants(values: unknown[]): Set<string> | undefined {
  const strings = values.filter((value): value is string => typeof value === "string");
  return strings.length > 0 ? new Set(strings) : undefined;
}

function walk(schema: unknown, depth: number): MutableGuide {
  const def = defOf(schema);
  if (!def || depth > MAX_DEPTH) return {};
  switch (def.type) {
    case "enum": {
      const constants = stringConstants(Object.values((def.entries as Record<string, unknown>) ?? {}));
      return constants ? { constants } : {};
    }
    case "literal": {
      const constants = stringConstants(Array.isArray(def.values) ? def.values : []);
      return constants ? { constants } : {};
    }
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
      return walk(def.innerType, depth);
    case "pipe":
      // Validation runs on the input side of a pipe.
      return walk(def.in, depth);
    case "lazy":
      return typeof def.getter === "function" ? walk((def.getter as () => unknown)(), depth + 1) : {};
    case "object": {
      const shape = (def.shape as Record<string, unknown>) ?? {};
      const keys = new Map<string, MutableGuide>();
      for (const key of Object.keys(shape)) keys.set(key, walk(shape[key], depth + 1));
      const guide: MutableGuide = { keys };
      if (def.catchall) guide.rest = walk(def.catchall, depth + 1);
      return guide;
    }
    case "record": {
      const value = walk(def.valueType, depth + 1);
      const keyConstants = walk(def.keyType, depth + 1).constants;
      if (!keyConstants) return { rest: value };
      return { keys: new Map([...keyConstants].map((key) => [key, value])) };
    }
    case "array":
      return { element: walk(def.element, depth + 1) };
    case "tuple": {
      const element: MutableGuide = {};
      for (const item of Array.isArray(def.items) ? def.items : []) merge(element, walk(item, depth + 1));
      if (def.rest) merge(element, walk(def.rest, depth + 1));
      return { element };
    }
    case "union": {
      const guide: MutableGuide = {};
      for (const option of Array.isArray(def.options) ? def.options : []) merge(guide, walk(option, depth + 1));
      return guide;
    }
    case "intersection":
      return merge(walk(def.left, depth + 1), walk(def.right, depth + 1));
    default:
      return {};
  }
}

/** The enum and literal positions, and declared keys, of a zod schema. */
export function schemaConstantGuide(schema: z.ZodType): SchemaConstantGuide {
  return walk(schema, 0);
}

/** Every constant and declared key a guide names. */
export function schemaConstantWords(guide: SchemaConstantGuide): Set<string> {
  const words = new Set<string>();
  const seen = new Set<SchemaConstantGuide>();
  const visit = (node: SchemaConstantGuide | undefined) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    for (const constant of node.constants ?? []) words.add(constant);
    for (const [key, inner] of node.keys ?? []) {
      words.add(key);
      visit(inner);
    }
    visit(node.rest);
    visit(node.element);
  };
  visit(guide);
  return words;
}
