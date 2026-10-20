import { createHash } from "node:crypto";
import type { McpToolAnnotations } from "@ai-orchestrator/shared";
import { normalizeToolAnnotations } from "./tool-annotations";

/**
 * Phase 10.1 — tool schema snapshots and diffs for the MCP server registry.
 *
 * Breaking rules (what can make an existing caller fail):
 *   - a tool disappears
 *   - an input property disappears
 *   - a property's type narrows or changes
 *   - a new required property appears, or an optional one becomes required
 *   - an enum loses a value
 * Everything else (new tools, new optional properties, widened types, new enum
 * values, description edits, annotation changes) is recorded but not breaking.
 *
 * Phase 10.2 — tool annotations are part of the snapshot only when a server
 * sends them, so the hash of a server without annotations is unchanged.
 */

export interface McpToolSnapshotEntry {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export type McpToolChangeKind =
  | "tool_added"
  | "tool_removed"
  | "description_changed"
  | "annotations_changed"
  | "property_added"
  | "property_removed"
  | "property_type_changed"
  | "property_type_widened"
  | "property_now_required"
  | "property_no_longer_required"
  | "enum_value_added"
  | "enum_value_removed";

export interface McpToolSchemaChange {
  tool: string;
  kind: McpToolChangeKind;
  /** Dotted path inside the input schema; `items[]` marks array items. Absent for tool-level changes. */
  path?: string;
  breaking: boolean;
  detail: string;
}

export interface McpToolSnapshotDiff {
  changes: McpToolSchemaChange[];
  breaking: boolean;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])])
    );
  }
  return value;
}

export function normalizeToolSnapshot(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown; annotations?: unknown }>
): McpToolSnapshotEntry[] {
  return [...tools]
    .map((tool) => {
      const annotations = normalizeToolAnnotations(tool.annotations);
      return {
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: canonicalize(toRecord(tool.inputSchema)) as Record<string, unknown>,
        ...(annotations ? { annotations: canonicalize(annotations) as McpToolAnnotations } : {})
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Stable sha256 over the normalized snapshot; equal hashes mean nothing changed. */
export function hashToolSnapshot(tools: McpToolSnapshotEntry[]): string {
  return createHash("sha256").update(JSON.stringify(normalizeToolSnapshot(tools))).digest("hex");
}

function typeSet(schema: Record<string, unknown>): Set<string> {
  const raw = schema.type;
  if (typeof raw === "string") return new Set([raw]);
  if (Array.isArray(raw)) return new Set(raw.filter((entry): entry is string => typeof entry === "string"));
  return new Set();
}

function describeTypes(types: Set<string>): string {
  return types.size ? [...types].sort().join(" | ") : "any";
}

function requiredSet(schema: Record<string, unknown>): Set<string> {
  return new Set(
    Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : []
  );
}

function joinPath(parent: string | undefined, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function diffSchema(
  tool: string,
  path: string | undefined,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  changes: McpToolSchemaChange[]
): void {
  if (path) {
    const beforeTypes = typeSet(before);
    const afterTypes = typeSet(after);
    // An untyped schema accepts anything, so dropping the type is a widening.
    const widened = afterTypes.size === 0 || [...beforeTypes].every((entry) => afterTypes.has(entry));
    const same = beforeTypes.size === afterTypes.size && widened;
    if (!same) {
      const detail = `type ${describeTypes(beforeTypes)} → ${describeTypes(afterTypes)}`;
      if (beforeTypes.size > 0 && widened) {
        changes.push({ tool, kind: "property_type_widened", path, breaking: false, detail });
      } else {
        changes.push({ tool, kind: "property_type_changed", path, breaking: true, detail });
      }
    }

    if (Array.isArray(before.enum) || Array.isArray(after.enum)) {
      const beforeEnum = Array.isArray(before.enum) ? before.enum.map((entry) => JSON.stringify(entry)) : [];
      const afterEnum = Array.isArray(after.enum) ? after.enum.map((entry) => JSON.stringify(entry)) : [];
      // No enum after means any value is accepted, which removes nothing.
      if (Array.isArray(after.enum)) {
        for (const value of beforeEnum) {
          if (!afterEnum.includes(value)) {
            changes.push({ tool, kind: "enum_value_removed", path, breaking: true, detail: `enum value ${value} removed` });
          }
        }
      }
      if (Array.isArray(before.enum)) {
        for (const value of afterEnum) {
          if (!beforeEnum.includes(value)) {
            changes.push({ tool, kind: "enum_value_added", path, breaking: false, detail: `enum value ${value} added` });
          }
        }
      }
    }
  }

  const beforeProps = toRecord(before.properties);
  const afterProps = toRecord(after.properties);
  const beforeRequired = requiredSet(before);
  const afterRequired = requiredSet(after);

  for (const key of Object.keys(beforeProps).sort()) {
    const childPath = joinPath(path, key);
    if (!(key in afterProps)) {
      changes.push({ tool, kind: "property_removed", path: childPath, breaking: true, detail: `property ${childPath} removed` });
      continue;
    }
    if (!beforeRequired.has(key) && afterRequired.has(key)) {
      changes.push({
        tool,
        kind: "property_now_required",
        path: childPath,
        breaking: true,
        detail: `property ${childPath} is now required`
      });
    } else if (beforeRequired.has(key) && !afterRequired.has(key)) {
      changes.push({
        tool,
        kind: "property_no_longer_required",
        path: childPath,
        breaking: false,
        detail: `property ${childPath} is now optional`
      });
    }
    diffSchema(tool, childPath, toRecord(beforeProps[key]), toRecord(afterProps[key]), changes);
  }

  for (const key of Object.keys(afterProps).sort()) {
    if (key in beforeProps) continue;
    const childPath = joinPath(path, key);
    const required = afterRequired.has(key);
    changes.push({
      tool,
      kind: "property_added",
      path: childPath,
      breaking: required,
      detail: required ? `required property ${childPath} added` : `optional property ${childPath} added`
    });
  }

  if (before.items || after.items) {
    diffSchema(tool, joinPath(path, "items[]"), toRecord(before.items), toRecord(after.items), changes);
  }
}

export function diffToolSnapshots(before: McpToolSnapshotEntry[], after: McpToolSnapshotEntry[]): McpToolSnapshotDiff {
  const changes: McpToolSchemaChange[] = [];
  const beforeByName = new Map(normalizeToolSnapshot(before).map((tool) => [tool.name, tool]));
  const afterByName = new Map(normalizeToolSnapshot(after).map((tool) => [tool.name, tool]));

  for (const [name, previous] of beforeByName) {
    const next = afterByName.get(name);
    if (!next) {
      changes.push({ tool: name, kind: "tool_removed", breaking: true, detail: `tool ${name} removed` });
      continue;
    }
    if ((previous.description ?? "") !== (next.description ?? "")) {
      changes.push({ tool: name, kind: "description_changed", breaking: false, detail: "description changed" });
    }
    const beforeAnnotations = JSON.stringify(previous.annotations ?? {});
    const afterAnnotations = JSON.stringify(next.annotations ?? {});
    if (beforeAnnotations !== afterAnnotations) {
      changes.push({
        tool: name,
        kind: "annotations_changed",
        breaking: false,
        detail: `annotations ${beforeAnnotations} → ${afterAnnotations}`
      });
    }
    diffSchema(name, undefined, previous.inputSchema, next.inputSchema, changes);
  }

  for (const name of afterByName.keys()) {
    if (!beforeByName.has(name)) {
      changes.push({ tool: name, kind: "tool_added", breaking: false, detail: `tool ${name} added` });
    }
  }

  return { changes, breaking: changes.some((change) => change.breaking) };
}
