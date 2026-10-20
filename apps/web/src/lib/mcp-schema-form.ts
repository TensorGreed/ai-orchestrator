/**
 * Phase 10.6 — turn a tool's JSON Schema `inputSchema` into form fields and
 * the form's values back into call arguments.
 *
 * Supported: strings, numbers, integers, booleans, enums, arrays of scalars
 * (or of enum values) and nested objects. Anything else (anyOf / oneOf,
 * arrays of objects, tuples, objects without properties, very deep nesting)
 * becomes a JSON field for that property; a schema that is not an object
 * with properties falls back to one JSON editor for all arguments.
 *
 * Values live in a flat map keyed by field path (`reporter.name`): text for
 * strings / numbers / enums / JSON, a boolean (or undefined) for booleans,
 * a list of item texts for arrays.
 */

export type ScalarKind = "string" | "number" | "integer" | "boolean";

interface FieldBase {
  path: string;
  key: string;
  label: string;
  description?: string;
  required: boolean;
}

export type SchemaField =
  | (FieldBase & { kind: "string"; format?: string; multiline: boolean })
  | (FieldBase & { kind: "number" | "integer"; minimum?: number; maximum?: number })
  | (FieldBase & { kind: "boolean" })
  | (FieldBase & { kind: "enum"; options: Array<string | number | boolean> })
  | (FieldBase & { kind: "array"; itemKind: ScalarKind | "enum"; options?: Array<string | number | boolean> })
  | (FieldBase & { kind: "object"; fields: SchemaField[] })
  | (FieldBase & { kind: "json" });

export type FormValue = string | boolean | string[] | undefined;
export type FormValues = Record<string, FormValue>;

export interface SchemaFormModel {
  /** null when the schema cannot be shown as fields; use one JSON editor instead. */
  fields: SchemaField[] | null;
}

const MAX_DEPTH = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The schema's type, ignoring a "null" alternative. */
function schemaType(schema: Record<string, unknown>): string | undefined {
  const raw = schema.type;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const types = raw.filter((entry): entry is string => typeof entry === "string" && entry !== "null");
    return types.length === 1 ? types[0] : undefined;
  }
  return undefined;
}

function enumOptions(schema: Record<string, unknown>): Array<string | number | boolean> | null {
  if (Array.isArray(schema.enum)) {
    const options = schema.enum.filter(
      (entry): entry is string | number | boolean => ["string", "number", "boolean"].includes(typeof entry)
    );
    return options.length > 0 ? options : null;
  }
  if (schema.const !== undefined && ["string", "number", "boolean"].includes(typeof schema.const)) {
    return [schema.const as string | number | boolean];
  }
  return null;
}

function labelFor(key: string, schema: Record<string, unknown>): string {
  return typeof schema.title === "string" && schema.title.trim() ? schema.title.trim() : key;
}

function buildField(key: string, path: string, schema: unknown, required: boolean, depth: number): SchemaField {
  const base: FieldBase = { path, key, label: key, required };
  if (!isRecord(schema)) return { ...base, kind: "json" };
  base.label = labelFor(key, schema);
  if (typeof schema.description === "string" && schema.description.trim()) base.description = schema.description.trim();
  if (schema.anyOf || schema.oneOf || schema.allOf) return { ...base, kind: "json" };

  const options = enumOptions(schema);
  if (options) return { ...base, kind: "enum", options };

  const type = schemaType(schema);
  switch (type) {
    case "string":
      return {
        ...base,
        kind: "string",
        ...(typeof schema.format === "string" ? { format: schema.format } : {}),
        multiline:
          (typeof schema.maxLength !== "number" || schema.maxLength > 200) &&
          /text|body|content|description|query|prompt|message/i.test(key)
      };
    case "number":
    case "integer":
      return {
        ...base,
        kind: type,
        ...(typeof schema.minimum === "number" ? { minimum: schema.minimum } : {}),
        ...(typeof schema.maximum === "number" ? { maximum: schema.maximum } : {})
      };
    case "boolean":
      return { ...base, kind: "boolean" };
    case "array": {
      const items = isRecord(schema.items) ? schema.items : null;
      if (!items) return { ...base, kind: "json" };
      const itemOptions = enumOptions(items);
      if (itemOptions) return { ...base, kind: "array", itemKind: "enum", options: itemOptions };
      const itemType = schemaType(items);
      if (itemType === "string" || itemType === "number" || itemType === "integer" || itemType === "boolean") {
        return { ...base, kind: "array", itemKind: itemType };
      }
      return { ...base, kind: "json" };
    }
    case "object": {
      if (depth >= MAX_DEPTH || !isRecord(schema.properties) || Object.keys(schema.properties).length === 0) {
        return { ...base, kind: "json" };
      }
      return { ...base, kind: "object", fields: buildFields(schema, path, depth + 1) };
    }
    default:
      return { ...base, kind: "json" };
  }
}

function buildFields(schema: Record<string, unknown>, prefix: string, depth: number): SchemaField[] {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : []);
  // Required fields first; otherwise the schema's own order (servers often send keys sorted).
  const entries = Object.entries(properties);
  const ordered = [...entries.filter(([key]) => required.has(key)), ...entries.filter(([key]) => !required.has(key))];
  return ordered.map(([key, property]) =>
    buildField(key, prefix ? `${prefix}.${key}` : key, property, required.has(key), depth)
  );
}

export function buildSchemaForm(inputSchema: unknown): SchemaFormModel {
  if (!isRecord(inputSchema)) return { fields: [] };
  const type = schemaType(inputSchema);
  const hasProperties = isRecord(inputSchema.properties);
  if (type !== undefined && type !== "object") return { fields: null };
  if (!hasProperties) {
    // `{ type: "object" }` with nothing declared: no arguments, unless extra properties are allowed.
    return { fields: inputSchema.additionalProperties === false || Object.keys(inputSchema).length <= 1 ? [] : null };
  }
  if (inputSchema.anyOf || inputSchema.oneOf || inputSchema.allOf) return { fields: null };
  return { fields: buildFields(inputSchema, "", 0) };
}

function defaultText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

/** Starting values from the schema's `default`s. */
export function initialFormValues(inputSchema: unknown, fields: SchemaField[] | null): FormValues {
  const values: FormValues = {};
  if (!fields) return values;
  const walk = (list: SchemaField[], schema: unknown) => {
    const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
    for (const field of list) {
      const property = properties[field.key];
      const fallback = isRecord(property) ? property.default : undefined;
      if (field.kind === "object") {
        walk(field.fields, property);
      } else if (fallback !== undefined) {
        if (field.kind === "boolean") values[field.path] = fallback === true;
        else if (field.kind === "array") values[field.path] = Array.isArray(fallback) ? fallback.map((item) => String(item)) : [];
        else values[field.path] = defaultText(fallback);
      }
    }
  };
  walk(fields, inputSchema);
  return values;
}

function isEmpty(value: FormValue): boolean {
  if (value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.every((item) => item.trim() === "");
  return false;
}

function parseScalar(kind: ScalarKind, text: string): { value?: unknown; error?: string } {
  const trimmed = text.trim();
  if (kind === "string") return { value: text };
  if (kind === "boolean") {
    if (trimmed === "true") return { value: true };
    if (trimmed === "false") return { value: false };
    return { error: "Use true or false" };
  }
  const number = Number(trimmed);
  if (!trimmed || !Number.isFinite(number)) return { error: "Enter a number" };
  if (kind === "integer" && !Number.isInteger(number)) return { error: "Enter a whole number" };
  return { value: number };
}

function enumValue(options: Array<string | number | boolean>, text: string): { value?: unknown; error?: string } {
  const match = options.find((option) => String(option) === text);
  return match === undefined ? { error: "Pick one of the options" } : { value: match };
}

export interface CollectedArgs {
  args: Record<string, unknown>;
  errors: Record<string, string>;
}

/** Build the call arguments; empty optional fields are left out. */
export function collectArgs(fields: SchemaField[], values: FormValues): CollectedArgs {
  const errors: Record<string, string> = {};

  const collect = (list: SchemaField[]): { value: Record<string, unknown>; touched: boolean } => {
    const out: Record<string, unknown> = {};
    let touched = false;
    for (const field of list) {
      if (field.kind === "object") {
        const nested = collect(field.fields);
        if (nested.touched || field.required) {
          out[field.key] = nested.value;
          touched = true;
        }
        continue;
      }
      const raw = values[field.path];
      if (isEmpty(raw) && !(field.kind === "boolean" && typeof raw === "boolean")) {
        if (field.required) errors[field.path] = "Required";
        continue;
      }
      touched = true;
      switch (field.kind) {
        case "string":
          out[field.key] = String(raw);
          break;
        case "number":
        case "integer": {
          const parsed = parseScalar(field.kind, String(raw));
          if (parsed.error) errors[field.path] = parsed.error;
          else {
            const number = parsed.value as number;
            if (field.minimum !== undefined && number < field.minimum) errors[field.path] = `At least ${field.minimum}`;
            else if (field.maximum !== undefined && number > field.maximum) errors[field.path] = `At most ${field.maximum}`;
            else out[field.key] = number;
          }
          break;
        }
        case "boolean":
          out[field.key] = raw === true;
          break;
        case "enum": {
          const parsed = enumValue(field.options, String(raw));
          if (parsed.error) errors[field.path] = parsed.error;
          else out[field.key] = parsed.value;
          break;
        }
        case "array": {
          const items = (Array.isArray(raw) ? raw : []).filter((item) => item.trim() !== "");
          const converted: unknown[] = [];
          for (const item of items) {
            const parsed = field.itemKind === "enum" ? enumValue(field.options ?? [], item) : parseScalar(field.itemKind, item);
            if (parsed.error) {
              errors[field.path] = `${item}: ${parsed.error}`;
              break;
            }
            converted.push(parsed.value);
          }
          out[field.key] = converted;
          break;
        }
        case "json": {
          try {
            out[field.key] = JSON.parse(String(raw));
          } catch {
            errors[field.path] = "Not valid JSON";
          }
          break;
        }
      }
    }
    return { value: out, touched };
  };

  const { value } = collect(fields);
  return { args: value, errors };
}

/** Values that reproduce `args` in the form (used to replay history entries). */
export function valuesFromArgs(fields: SchemaField[], args: Record<string, unknown>): FormValues {
  const values: FormValues = {};
  const walk = (list: SchemaField[], source: unknown) => {
    const record = isRecord(source) ? source : {};
    for (const field of list) {
      const value = record[field.key];
      if (value === undefined) continue;
      if (field.kind === "object") walk(field.fields, value);
      else if (field.kind === "boolean") values[field.path] = value === true;
      else if (field.kind === "array") values[field.path] = Array.isArray(value) ? value.map((item) => String(item)) : [];
      else if (field.kind === "json") values[field.path] = JSON.stringify(value, null, 2);
      else values[field.path] = String(value);
    }
  };
  walk(fields, args);
  return values;
}
