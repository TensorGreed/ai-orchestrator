/**
 * Phase 11.2 — config fields for the Approval Gate node: the message, who may
 * approve, the timeout and what it does, and the fields an approver may edit
 * before approving. Problems are checked with the shared config schema, the
 * same one the engine uses when the gate runs.
 */

import { useMemo, useState } from "react";
import {
  APPROVAL_DEFAULT_TIMEOUT_MINUTES,
  APPROVAL_MAX_TIMEOUT_MINUTES,
  APPROVER_ROLE_VALUES,
  approvalGateConfigSchema
} from "@ai-orchestrator/shared";

type Config = Record<string, unknown>;
type SetConfig = (update: (current: Config) => Config) => void;

type FieldType = "string" | "text" | "number" | "boolean" | "json";
interface FieldRow {
  key: string;
  label?: string;
  type: FieldType;
  valueTemplate?: string;
  required?: boolean;
  maxLength?: number;
}

const FIELD_TYPES: Array<{ value: FieldType; label: string }> = [
  { value: "string", label: "Text (one line)" },
  { value: "text", label: "Text (long)" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Yes / no" },
  { value: "json", label: "JSON" }
];
const MAX_FIELDS = 20;

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

function readFields(config: Config): FieldRow[] {
  if (!Array.isArray(config.editableFields)) return [];
  return config.editableFields
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      key: str(entry.key),
      ...(typeof entry.label === "string" ? { label: entry.label } : {}),
      type: (FIELD_TYPES.some((type) => type.value === entry.type) ? entry.type : "string") as FieldType,
      ...(typeof entry.valueTemplate === "string" ? { valueTemplate: entry.valueTemplate } : {}),
      ...(entry.required === true ? { required: true } : {}),
      ...(typeof entry.maxLength === "number" ? { maxLength: entry.maxLength } : {})
    }));
}

/** Problems with the gate's config, as "path: message" lines. */
export function approvalGateConfigIssues(config: Config): string[] {
  const parsed = approvalGateConfigSchema.safeParse(config);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const path = issue.path
      .map((part, index) => (typeof part === "number" && issue.path[index - 1] === "editableFields" ? `field ${part + 1}` : String(part)))
      .join(" › ");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

export function ApprovalGateNodeFields({ config, setConfig }: { config: Config; setConfig: SetConfig }) {
  const roles = Array.isArray(config.approverRoles) ? config.approverRoles.map(String) : [];
  const [usersText, setUsersText] = useState(() => (Array.isArray(config.approverUsers) ? config.approverUsers.map(String).join("\n") : ""));
  const fields = readFields(config);
  const issues = useMemo(() => approvalGateConfigIssues(config), [config]);

  const writeFields = (next: FieldRow[]) => setConfig((current) => ({ ...current, editableFields: next }));
  const updateField = (index: number, patch: Partial<FieldRow>) => {
    const next = fields.map((field, i) => {
      if (i !== index) return field;
      const merged: Record<string, unknown> = { ...field, ...patch };
      for (const [key, value] of Object.entries(merged)) {
        if (value === undefined || value === "" || value === false) delete merged[key];
      }
      return { type: "string", ...merged } as FieldRow;
    });
    writeFields(next);
  };

  return (
    <>
      <div className="cfg-field">
        <label className="cfg-label" htmlFor="gate-message">
          Message to the approver
        </label>
        <textarea
          id="gate-message"
          className="cfg-input"
          rows={3}
          value={str(config.message, "Approval required to continue.")}
          onChange={(event) => setConfig((current) => ({ ...current, message: event.target.value }))}
        />
        <div className="cfg-help">
          A template: <code>{"{{results.nodeId.key}}"}</code> pulls in values from earlier nodes.
        </div>
      </div>

      <fieldset className="cfg-field">
        <legend className="cfg-label">Approver roles</legend>
        <div className="gate-roles">
          {APPROVER_ROLE_VALUES.map((role) => (
            <label key={role} className="guard-check">
              <input
                type="checkbox"
                checked={roles.includes(role)}
                onChange={(event) =>
                  setConfig((current) => {
                    const currentRoles = Array.isArray(current.approverRoles) ? current.approverRoles.map(String) : [];
                    const next = event.target.checked ? [...new Set([...currentRoles, role])] : currentRoles.filter((entry) => entry !== role);
                    return { ...current, approverRoles: next };
                  })
                }
              />
              <span>{role}</span>
            </label>
          ))}
        </div>
        <div className="cfg-help">With no roles and no users, any operator, builder or admin with run access may decide.</div>
      </fieldset>

      <div className="cfg-field">
        <label className="cfg-label" htmlFor="gate-users">
          Approver users
        </label>
        <textarea
          id="gate-users"
          className="cfg-input"
          rows={2}
          value={usersText}
          placeholder={"alice@example.com\nuser id"}
          onChange={(event) => {
            const text = event.target.value;
            setUsersText(text);
            const users = text
              .split(/[\n,]/)
              .map((entry) => entry.trim())
              .filter(Boolean);
            setConfig((current) => ({ ...current, approverUsers: [...new Set(users)] }));
          }}
        />
        <div className="cfg-help">One email or user id per line. A listed user may decide whatever their role.</div>
      </div>

      <label className="guard-check">
        <input
          type="checkbox"
          checked={bool(config.allowSelfApproval, false)}
          onChange={(event) => setConfig((current) => ({ ...current, allowSelfApproval: event.target.checked }))}
        />
        <span>Let the person who started the run approve it</span>
      </label>

      <div className="cfg-field">
        <label className="cfg-label" htmlFor="gate-timeout">
          Timeout (minutes)
        </label>
        <input
          id="gate-timeout"
          type="number"
          min={1}
          max={APPROVAL_MAX_TIMEOUT_MINUTES}
          step={1}
          className="cfg-input"
          value={num(config.timeoutMinutes, APPROVAL_DEFAULT_TIMEOUT_MINUTES)}
          onChange={(event) => {
            const value = Math.round(Number(event.target.value));
            const clamped = Number.isFinite(value) ? Math.min(APPROVAL_MAX_TIMEOUT_MINUTES, Math.max(1, value)) : 1;
            setConfig((current) => ({ ...current, timeoutMinutes: clamped }));
          }}
        />
        <div className="cfg-help">1 to {APPROVAL_MAX_TIMEOUT_MINUTES} minutes (30 days).</div>
      </div>

      <div className="cfg-field">
        <label className="cfg-label" htmlFor="gate-timeout-outcome">
          When nobody decides in time
        </label>
        <select
          id="gate-timeout-outcome"
          className="cfg-input"
          value={str(config.timeoutOutcome, "reject")}
          onChange={(event) => setConfig((current) => ({ ...current, timeoutOutcome: event.target.value }))}
        >
          <option value="reject">Reject</option>
          <option value="fallback">Take the Timed out output</option>
        </select>
        <div className="cfg-help">Timed out is used only when that output is connected; otherwise the gate rejects.</div>
      </div>

      <label className="guard-check">
        <input
          type="checkbox"
          checked={bool(config.requireRejectReason, true)}
          onChange={(event) => setConfig((current) => ({ ...current, requireRejectReason: event.target.checked }))}
        />
        <span>Require a reason to reject</span>
      </label>

      <fieldset className="cfg-field">
        <legend className="cfg-label">Editable fields</legend>
        <div className="cfg-help">Values the approver may change before approving. The Approved output carries them on the item.</div>
        {fields.map((field, index) => (
          <div key={index} className="gate-field-row" role="group" aria-label={`Editable field ${index + 1}`}>
            <input
              className="cfg-input"
              aria-label="Key"
              placeholder="key"
              value={field.key}
              onChange={(event) => updateField(index, { key: event.target.value.trim() })}
            />
            <input
              className="cfg-input"
              aria-label="Label"
              placeholder="Label (optional)"
              value={field.label ?? ""}
              onChange={(event) => updateField(index, { label: event.target.value })}
            />
            <select className="cfg-input" aria-label="Type" value={field.type} onChange={(event) => updateField(index, { type: event.target.value as FieldType })}>
              {FIELD_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
            <input
              className="cfg-input gate-field-template"
              aria-label="Proposed value"
              placeholder="Proposed value, e.g. {{results.agent.answer}}"
              value={field.valueTemplate ?? ""}
              onChange={(event) => updateField(index, { valueTemplate: event.target.value })}
            />
            <div className="gate-field-row-foot">
              <label className="guard-check">
                <input type="checkbox" checked={field.required === true} onChange={(event) => updateField(index, { required: event.target.checked })} />
                <span>Required</span>
              </label>
              {(field.type === "string" || field.type === "text") && (
                <label className="guard-check">
                  <span>Max length</span>
                  <input
                    type="number"
                    className="cfg-input gate-field-maxlen"
                    aria-label="Max length"
                    min={1}
                    value={field.maxLength ?? ""}
                    onChange={(event) => {
                      const value = Math.round(Number(event.target.value));
                      updateField(index, { maxLength: event.target.value === "" || !Number.isFinite(value) ? undefined : Math.max(1, value) });
                    }}
                  />
                </label>
              )}
              <button type="button" className="mini-btn gate-field-remove" onClick={() => writeFields(fields.filter((_, i) => i !== index))}>
                Remove
              </button>
            </div>
          </div>
        ))}
        <div>
          <button
            type="button"
            className="mini-btn"
            disabled={fields.length >= MAX_FIELDS}
            onClick={() => writeFields([...fields, { key: `field${fields.length + 1}`, type: "string" }])}
          >
            Add field
          </button>
        </div>
      </fieldset>

      {issues.length > 0 && (
        <div className="cfg-field" role="alert">
          {issues.map((issue) => (
            <div key={issue} className="gate-error">
              {issue}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
