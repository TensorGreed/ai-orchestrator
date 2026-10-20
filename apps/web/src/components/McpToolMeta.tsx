/**
 * Phase 10.5 — MCP tool metadata shared by the server registry and the MCP
 * Tool inspector: annotation chips (behaviour hints the server sent with
 * tools/list) and a compact view of a tool's outputSchema.
 */

import type { McpToolAnnotations } from "@ai-orchestrator/shared";

const HINT_NOTE = "Hint sent by the MCP server, not verified by L2M.";

interface Chip {
  key: string;
  label: string;
  tone: "ok" | "warn" | "err" | "neutral";
  title: string;
}

function chipsFor(annotations: McpToolAnnotations): Chip[] {
  const chips: Chip[] = [];
  if (annotations.readOnlyHint === true) {
    chips.push({ key: "ro", label: "Read-only", tone: "ok", title: `Does not modify its environment. ${HINT_NOTE}` });
  } else if (annotations.readOnlyHint === false) {
    chips.push({ key: "ro", label: "Writes", tone: "warn", title: `May modify its environment. ${HINT_NOTE}` });
  }
  if (annotations.destructiveHint === true) {
    chips.push({ key: "de", label: "Destructive", tone: "err", title: `May delete or overwrite data. ${HINT_NOTE}` });
  } else if (annotations.destructiveHint === false) {
    chips.push({ key: "de", label: "Non-destructive", tone: "neutral", title: `Only adds data. ${HINT_NOTE}` });
  }
  if (annotations.idempotentHint === true) {
    chips.push({ key: "id", label: "Idempotent", tone: "neutral", title: `Repeating a call has no extra effect. ${HINT_NOTE}` });
  } else if (annotations.idempotentHint === false) {
    chips.push({ key: "id", label: "Not idempotent", tone: "neutral", title: `Repeating a call may have extra effects. ${HINT_NOTE}` });
  }
  if (annotations.openWorldHint === true) {
    chips.push({ key: "ow", label: "Open world", tone: "neutral", title: `Reaches external systems or the internet. ${HINT_NOTE}` });
  } else if (annotations.openWorldHint === false) {
    chips.push({ key: "ow", label: "Closed world", tone: "neutral", title: `Works only on a closed set of data. ${HINT_NOTE}` });
  }
  return chips;
}

export function McpAnnotationChips({ annotations }: { annotations?: McpToolAnnotations | null }) {
  if (!annotations) return null;
  const chips = chipsFor(annotations);
  if (chips.length === 0 && !annotations.title) return null;
  return (
    <span className="mcp-hints" aria-label="Tool annotations">
      {annotations.title && (
        <span className="mcp-hint-title" title={`Display title. ${HINT_NOTE}`}>
          {annotations.title}
        </span>
      )}
      {chips.map((chip) => (
        <span key={chip.key} className={`mcp-hint mcp-hint-${chip.tone}`} title={chip.title}>
          {chip.label}
        </span>
      ))}
    </span>
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function describeType(schema: Record<string, unknown>): string {
  const type = schema.type;
  if (typeof type === "string") {
    if (type === "array") {
      const items = describeType(asRecord(schema.items));
      return items ? `${items}[]` : "array";
    }
    return type;
  }
  if (Array.isArray(type)) return type.filter((entry) => typeof entry === "string").join(" | ");
  if (Array.isArray(schema.enum)) return "enum";
  return "";
}

/** Output properties with their types (`*` = always present), and the raw schema on demand. */
export function McpOutputSchema({ schema, compact = false }: { schema?: Record<string, unknown> | null; compact?: boolean }) {
  if (!schema || Object.keys(schema).length === 0) {
    return <span className="kb-subtle">{compact ? "—" : "No output schema; the tool returns text."}</span>;
  }
  const properties = asRecord(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).map(String) : []);
  const names = Object.keys(properties);
  return (
    <div className="mcp-output-schema">
      {names.length === 0 ? (
        <span className="kb-subtle">{describeType(schema) || "object"}</span>
      ) : (
        <span className="mcp-inputs">
          {names.map((name) => {
            const type = describeType(asRecord(properties[name]));
            return (
              <code
                key={name}
                className={required.has(name) ? "is-required" : undefined}
                title={`${type || "any"}${required.has(name) ? ", always present" : ", optional"}`}
              >
                {name}
                {required.has(name) ? "*" : ""}
                {type ? <span className="mcp-output-type">: {type}</span> : null}
              </code>
            );
          })}
        </span>
      )}
      <details className="mcp-output-raw">
        <summary>JSON schema</summary>
        <pre>{JSON.stringify(schema, null, 2)}</pre>
      </details>
    </div>
  );
}
