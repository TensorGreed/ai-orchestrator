/**
 * Phase 10.6 — form generated from an MCP tool's `inputSchema` (see
 * lib/mcp-schema-form.ts for what maps to which control).
 */

import type { ReactNode } from "react";
import type { FormValue, FormValues, SchemaField } from "../lib/mcp-schema-form";

interface McpSchemaFormProps {
  fields: SchemaField[];
  values: FormValues;
  errors: Record<string, string>;
  disabled?: boolean;
  onChange: (path: string, value: FormValue) => void;
}

function fieldId(path: string): string {
  return `pgf-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function FieldLabel({ field, htmlFor }: { field: SchemaField; htmlFor?: string }) {
  return (
    <span className="mcp-pg-field-label">
      {htmlFor ? <label htmlFor={htmlFor}>{field.label}</label> : <span>{field.label}</span>}
      {field.required ? <span className="mcp-pg-field-req" aria-label="required">*</span> : null}
      <code className="mcp-pg-field-type">{field.kind === "array" ? `${field.itemKind}[]` : field.kind}</code>
    </span>
  );
}

function ArrayField({
  field,
  value,
  disabled,
  onChange
}: {
  field: Extract<SchemaField, { kind: "array" }>;
  value: FormValue;
  disabled?: boolean;
  onChange: (value: FormValue) => void;
}) {
  const items = Array.isArray(value) ? value : [];
  if (field.itemKind === "enum") {
    const options = field.options ?? [];
    return (
      <div className="mcp-pg-chip-group" role="group" aria-label={field.label}>
        {options.map((option) => {
          const text = String(option);
          const checked = items.includes(text);
          return (
            <label key={text} className={checked ? "mcp-pg-chip-option is-on" : "mcp-pg-chip-option"}>
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => onChange(checked ? items.filter((item) => item !== text) : [...items, text])}
              />
              {text}
            </label>
          );
        })}
      </div>
    );
  }
  const rows = items.length > 0 ? items : [""];
  return (
    <div className="mcp-pg-array">
      {rows.map((item, index) => (
        <div key={index} className="mcp-pg-array-row">
          {field.itemKind === "boolean" ? (
            <select
              aria-label={`${field.label} item ${index + 1}`}
              value={item}
              disabled={disabled}
              onChange={(event) => onChange(rows.map((entry, i) => (i === index ? event.target.value : entry)))}
            >
              <option value="">—</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
              aria-label={`${field.label} item ${index + 1}`}
              inputMode={field.itemKind === "string" ? undefined : "decimal"}
              value={item}
              disabled={disabled}
              onChange={(event) => onChange(rows.map((entry, i) => (i === index ? event.target.value : entry)))}
            />
          )}
          <button
            type="button"
            className="pg-btn ghost small"
            aria-label={`Remove ${field.label} item ${index + 1}`}
            disabled={disabled || (rows.length === 1 && item === "")}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            −
          </button>
        </div>
      ))}
      <button type="button" className="pg-btn ghost small" disabled={disabled} onClick={() => onChange([...rows, ""])}>
        + Add item
      </button>
    </div>
  );
}

function Field({ field, values, errors, disabled, onChange }: { field: SchemaField } & Omit<McpSchemaFormProps, "fields">) {
  const id = fieldId(field.path);
  const value = values[field.path];
  const error = errors[field.path];
  const describedBy = [field.description ? `${id}-desc` : null, error ? `${id}-err` : null].filter(Boolean).join(" ") || undefined;

  if (field.kind === "object") {
    return (
      <fieldset className="mcp-pg-fieldset">
        <legend>
          {field.label}
          {field.required ? <span className="mcp-pg-field-req" aria-label="required">*</span> : null}
          <code className="mcp-pg-field-type">object</code>
        </legend>
        {field.description && <p className="mcp-pg-field-desc">{field.description}</p>}
        {field.fields.map((child) => (
          <Field key={child.path} field={child} values={values} errors={errors} disabled={disabled} onChange={onChange} />
        ))}
      </fieldset>
    );
  }

  let control: ReactNode;
  switch (field.kind) {
    case "boolean":
      control = field.required ? (
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => onChange(field.path, event.target.checked)}
        />
      ) : (
        <select
          id={id}
          value={value === true ? "true" : value === false ? "false" : ""}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => onChange(field.path, event.target.value === "" ? undefined : event.target.value === "true")}
        >
          <option value="">Not set</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
      break;
    case "enum":
      control = (
        <select
          id={id}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => onChange(field.path, event.target.value || undefined)}
        >
          <option value="">{field.required ? "Choose…" : "Not set"}</option>
          {field.options.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      );
      break;
    case "array":
      control = <ArrayField field={field} value={value} disabled={disabled} onChange={(next) => onChange(field.path, next)} />;
      break;
    case "json":
      control = (
        <textarea
          id={id}
          className="mcp-pg-json"
          rows={4}
          spellCheck={false}
          placeholder="JSON value"
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => onChange(field.path, event.target.value)}
        />
      );
      break;
    case "number":
    case "integer":
      control = (
        <input
          id={id}
          inputMode={field.kind === "integer" ? "numeric" : "decimal"}
          placeholder={
            field.minimum !== undefined || field.maximum !== undefined
              ? `${field.minimum ?? "…"} – ${field.maximum ?? "…"}`
              : field.kind === "integer"
                ? "whole number"
                : "number"
          }
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => onChange(field.path, event.target.value)}
        />
      );
      break;
    default:
      control = field.multiline ? (
        <textarea
          id={id}
          rows={3}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => onChange(field.path, event.target.value)}
        />
      ) : (
        <input
          id={id}
          type={field.format === "email" ? "email" : field.format === "uri" ? "url" : "text"}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => onChange(field.path, event.target.value)}
        />
      );
  }

  return (
    <div className={error ? "mcp-pg-field has-error" : "mcp-pg-field"}>
      <FieldLabel field={field} htmlFor={field.kind === "array" ? undefined : id} />
      {control}
      {field.description && (
        <small id={`${id}-desc`} className="mcp-pg-field-desc">
          {field.description}
        </small>
      )}
      {error && (
        <small id={`${id}-err`} className="mcp-pg-field-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}

export function McpSchemaForm({ fields, values, errors, disabled, onChange }: McpSchemaFormProps) {
  if (fields.length === 0) {
    return <p className="kb-subtle">This tool takes no arguments.</p>;
  }
  return (
    <div className="mcp-pg-form">
      {fields.map((field) => (
        <Field key={field.path} field={field} values={values} errors={errors} disabled={disabled} onChange={onChange} />
      ))}
    </div>
  );
}
