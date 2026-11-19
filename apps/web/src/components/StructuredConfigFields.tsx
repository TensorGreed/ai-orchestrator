/**
 * Forms in place of raw JSON fields: Switch cases, Execute Workflow mappings, Form Trigger fields and the
 * key/value settings of embedders and vector stores. Each editor writes the same config shape the JSON field did,
 * and keeps keys it does not show.
 */
import { useEffect, useId, useRef, useState } from "react";
import {
  FORM_FIELD_TYPES,
  duplicateCaseLabels,
  fieldNameFromLabel,
  formFieldsOf,
  mappingOf,
  otherSettings,
  readFormFields,
  readMapping,
  readSwitchCases,
  settingText,
  withCaseValue,
  withOtherSettings,
  withSetting,
  type FormFieldRow,
  type FormFieldType,
  type MappingRow,
  type SettingField,
  type SwitchCaseRow
} from "../lib/structured-settings";

type Settings = Record<string, unknown>;

const FORM_FIELD_TYPE_LABELS: Record<FormFieldType, string> = {
  text: "Text",
  textarea: "Long text",
  email: "Email",
  number: "Number",
  select: "Choice",
  checkbox: "Checkbox"
};

// ── Switch cases ─────────────────────────────────────────────────────────────

export function SwitchCasesEditor({
  cases,
  defaultLabel,
  onChange
}: {
  cases: unknown;
  defaultLabel: string;
  onChange: (next: SwitchCaseRow[]) => void;
}) {
  const rows = readSwitchCases(cases);
  const duplicates = duplicateCaseLabels(rows, defaultLabel);
  const update = (index: number, row: SwitchCaseRow) => onChange(rows.map((entry, i) => (i === index ? row : entry)));
  return (
    <fieldset className="cfg-field cfg-rows" aria-label="Cases">
      <legend className="cfg-field-label">Cases</legend>
      <div className="cfg-tip">
        When the value equals a case, the run takes that case&apos;s output; otherwise the Default output. Renaming an output disconnects
        its branch.
      </div>
      {rows.length > 0 ? (
        <div className="cfg-row cfg-row-head" aria-hidden="true">
          <span>Value</span>
          <span>Output</span>
          <span />
        </div>
      ) : null}
      {rows.map((row, index) => (
        <div key={index} className="cfg-row" role="group" aria-label={`Case ${index + 1}`}>
          <input aria-label={`Case ${index + 1} value`} placeholder="complete" value={row.value} onChange={(event) => update(index, withCaseValue(row, event.target.value))} />
          <input aria-label={`Case ${index + 1} output`} placeholder={row.value || "output name"} value={row.label} onChange={(event) => update(index, { ...row, label: event.target.value })} />
          <button type="button" className="mini-btn cfg-row-remove" aria-label={`Remove case ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}>
            ×
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="mini-btn" onClick={() => onChange([...rows, { value: "", label: "" }])}>
          + Add case
        </button>
      </div>
      {duplicates.length > 0 ? (
        <div className="cfg-tip cfg-tip-warn" role="alert">
          More than one case uses the output {duplicates.map((label) => `"${label}"`).join(", ")}: give each its own name.
        </div>
      ) : null}
    </fieldset>
  );
}

// ── Mappings ─────────────────────────────────────────────────────────────────

export function MappingEditor({
  label,
  value,
  fromLabel,
  toLabel,
  fromPlaceholder,
  toPlaceholder,
  help,
  onChange
}: {
  label: string;
  value: unknown;
  fromLabel: string;
  toLabel: string;
  fromPlaceholder?: string;
  toPlaceholder?: string;
  help?: string;
  onChange: (next: Record<string, string>) => void;
}) {
  // Rows are kept locally so a row being typed (no source yet) does not vanish; the config gets the complete ones.
  const [rows, setRows] = useState<MappingRow[]>(() => readMapping(value));
  const lastWritten = useRef(JSON.stringify(mappingOf(rows)));
  useEffect(() => {
    const incoming = JSON.stringify(mappingOf(readMapping(value)));
    if (incoming !== lastWritten.current) {
      lastWritten.current = incoming;
      setRows(readMapping(value));
    }
  }, [value]);
  const write = (next: MappingRow[]) => {
    setRows(next);
    const mapping = mappingOf(next);
    lastWritten.current = JSON.stringify(mapping);
    onChange(mapping);
  };
  return (
    <fieldset className="cfg-field cfg-rows" aria-label={label}>
      <legend className="cfg-field-label">{label}</legend>
      {help ? <div className="cfg-tip">{help}</div> : null}
      {rows.length > 0 ? (
        <div className="cfg-row cfg-row-head" aria-hidden="true">
          <span>{fromLabel}</span>
          <span>{toLabel}</span>
          <span />
        </div>
      ) : null}
      {rows.map((row, index) => (
        <div key={index} className="cfg-row" role="group" aria-label={`${label} row ${index + 1}`}>
          <input aria-label={`${fromLabel} ${index + 1}`} placeholder={fromPlaceholder} value={row.from} onChange={(event) => write(rows.map((entry, i) => (i === index ? { ...entry, from: event.target.value } : entry)))} />
          <input aria-label={`${toLabel} ${index + 1}`} placeholder={toPlaceholder} value={row.to} onChange={(event) => write(rows.map((entry, i) => (i === index ? { ...entry, to: event.target.value } : entry)))} />
          <button type="button" className="mini-btn cfg-row-remove" aria-label={`Remove ${label.toLowerCase()} row ${index + 1}`} onClick={() => write(rows.filter((_, i) => i !== index))}>
            ×
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="mini-btn" onClick={() => write([...rows, { from: "", to: "" }])}>
          + Add row
        </button>
      </div>
    </fieldset>
  );
}

// ── Form Trigger fields ──────────────────────────────────────────────────────

/** A saved `fields` value as rows: a list, or JSON text of one (a field typed before this editor existed). */
function formFieldRowsOf(value: unknown): FormFieldRow[] {
  if (typeof value === "string") {
    try {
      return readFormFields(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return readFormFields(value);
}

/** Choices as comma-separated text; the text is kept while typing (a trailing comma included), the list is saved. */
function ChoicesInput({ label, options, onChange }: { label: string; options: string[]; onChange: (next: string[]) => void }) {
  const joined = options.join(", ");
  const [draft, setDraft] = useState(joined);
  const lastSaved = useRef(joined);
  useEffect(() => {
    if (joined !== lastSaved.current) {
      lastSaved.current = joined;
      setDraft(joined);
    }
  }, [joined]);
  return (
    <input
      className="cfg-row-wide"
      aria-label={label}
      placeholder="Choices, separated by commas"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        const next = event.target.value.split(",").map((option) => option.trim()).filter(Boolean);
        lastSaved.current = next.join(", ");
        onChange(next);
      }}
    />
  );
}

export function FormFieldsEditor({ value, onChange }: { value: unknown; onChange: (next: Array<Record<string, unknown>>) => void }) {
  const rows = formFieldRowsOf(value);
  const unreadable = typeof value === "string" && value.trim() !== "" && rows.length === 0;
  const write = (next: FormFieldRow[]) => onChange(formFieldsOf(next));
  const update = (index: number, patch: Partial<FormFieldRow>) => write(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const names = rows.map((row) => row.name.trim());
  const missingName = names.some((name) => !name);
  const duplicateNames = names.filter((name, index) => name && names.indexOf(name) !== index);
  return (
    <fieldset className="cfg-field cfg-rows" aria-label="Form fields">
      <legend className="cfg-field-label">Fields</legend>
      <div className="cfg-tip">
        Each answer reaches the run under its name, for example <code>{"{{email}}"}</code>.
      </div>
      {unreadable ? (
        <div className="cfg-tip cfg-tip-warn" role="alert">
          The saved fields are not a list the form can read. Add fields here to replace them.
        </div>
      ) : null}
      {rows.map((row, index) => (
        <div key={index} className="cfg-row cfg-row-form" role="group" aria-label={`Field ${index + 1}`}>
          <input
            aria-label={`Field ${index + 1} label`}
            placeholder="Label, e.g. Email"
            value={row.label}
            onChange={(event) => {
              const label = event.target.value;
              // The name follows the label until it is typed by hand.
              const follows = !row.name || row.name === fieldNameFromLabel(row.label);
              update(index, { label, ...(follows ? { name: fieldNameFromLabel(label) } : {}) });
            }}
          />
          <input aria-label={`Field ${index + 1} name`} placeholder="name" value={row.name} onChange={(event) => update(index, { name: event.target.value.trim() })} />
          <select aria-label={`Field ${index + 1} type`} value={row.type} onChange={(event) => update(index, { type: event.target.value as FormFieldType })}>
            {FORM_FIELD_TYPES.map((type) => (
              <option key={type} value={type}>
                {FORM_FIELD_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          {row.type === "select" ? (
            <ChoicesInput label={`Field ${index + 1} choices`} options={row.options} onChange={(options) => update(index, { options })} />
          ) : null}
          <div className="cfg-row-foot">
            <label className="guard-check">
              <input type="checkbox" checked={row.required} onChange={(event) => update(index, { required: event.target.checked })} /> Required
            </label>
            <button type="button" className="mini-btn cfg-row-remove" aria-label={`Remove field ${index + 1}`} onClick={() => write(rows.filter((_, i) => i !== index))}>
              Remove
            </button>
          </div>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="mini-btn"
          onClick={() => write([...rows, { name: "", label: "", type: "text", required: false, placeholder: "", options: [], extra: {} }])}
        >
          + Add field
        </button>
      </div>
      {missingName ? (
        <div className="cfg-tip cfg-tip-warn" role="alert">
          Every field needs a name.
        </div>
      ) : null}
      {duplicateNames.length > 0 ? (
        <div className="cfg-tip cfg-tip-warn" role="alert">
          More than one field is named {[...new Set(duplicateNames)].map((name) => `"${name}"`).join(", ")}.
        </div>
      ) : null}
    </fieldset>
  );
}

// ── Key/value settings ───────────────────────────────────────────────────────

/** The settings the fields do not show, as JSON text to edit; committed when it parses to an object. */
function OtherSettingsJson({ others, label, onCommit }: { others: Settings; label: string; onCommit: (next: Settings) => void }) {
  const shown = Object.keys(others).length > 0 ? JSON.stringify(others, null, 2) : "";
  const [draft, setDraft] = useState(shown);
  const [error, setError] = useState("");
  const lastCommitted = useRef(shown);
  useEffect(() => {
    if (shown !== lastCommitted.current) {
      lastCommitted.current = shown;
      setDraft(shown);
      setError("");
    }
  }, [shown]);
  return (
    <details className="cfg-other-settings" open={Object.keys(others).length > 0 || undefined}>
      <summary>{label}</summary>
      <label className="cfg-field">
        <span className="cfg-field-label">{label} (JSON)</span>
        <textarea
          rows={4}
          spellCheck={false}
          aria-label={`${label} (JSON)`}
          placeholder='{ "key": "value" }'
          value={draft}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            if (!next.trim()) {
              setError("");
              lastCommitted.current = "";
              onCommit({});
              return;
            }
            try {
              const parsed: unknown = JSON.parse(next);
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                setError("Use a JSON object.");
                return;
              }
              setError("");
              lastCommitted.current = JSON.stringify(parsed, null, 2);
              onCommit(parsed as Settings);
            } catch {
              setError("Not valid JSON yet.");
            }
          }}
        />
        {error ? <span className="cfg-field-error">{error}</span> : null}
      </label>
    </details>
  );
}

/**
 * One text input per known setting, and the rest of the object as JSON under "Other settings" (collapsed when empty).
 * `onChange` gets the whole settings object.
 */
export function SettingsFields({
  fields,
  settings,
  onChange,
  otherLabel = "Other settings",
  hiddenKeys = []
}: {
  fields: readonly SettingField[];
  settings: Settings;
  onChange: (next: Settings) => void;
  otherLabel?: string;
  /** Keys another control edits: neither shown as fields nor as other settings. */
  hiddenKeys?: readonly string[];
}) {
  const others = otherSettings(settings, fields, hiddenKeys);
  const idBase = useId();
  return (
    <>
      {fields.map((field) => {
        const inputId = `${idBase}-${field.key}`;
        return (
          <div key={field.key} className="cfg-field">
            <label className="cfg-field-label" htmlFor={inputId}>
              {field.label}
            </label>
            <input
              id={inputId}
              value={settingText(settings, field.key)}
              placeholder={field.placeholder}
              aria-describedby={field.help ? `${inputId}-help` : undefined}
              onChange={(event) => onChange(withSetting(settings, field.key, event.target.value))}
            />
            {field.help ? (
              <span id={`${inputId}-help`} className="cfg-tip">
                {field.help}
              </span>
            ) : null}
          </div>
        );
      })}
      <OtherSettingsJson others={others} label={otherLabel} onCommit={(next) => onChange(withOtherSettings(settings, fields, next, hiddenKeys))} />
    </>
  );
}
