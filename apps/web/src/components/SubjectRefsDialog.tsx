/**
 * 13.3 — the workflow's subject references: up to three plain paths (such as `{{input.customerId}}`) whose values
 * identify the person a run is about. When a run finishes, each value is stored as a keyed hash so a data-subject
 * request can find the run without searching. Off when the list is empty. "Check" shows how the paths resolve on
 * the latest runs, values masked.
 */
import { useState } from "react";
import { SUBJECT_REF_MAX, subjectRefPath, type SubjectRefPreviewView } from "@ai-orchestrator/shared";
import { ApiError, previewSubjectRefs } from "../lib/api";

interface SubjectRefsDialogProps {
  workflowId: string;
  subjectRefs: string[] | undefined;
  onChange: (subjectRefs: string[]) => void;
  onClose: () => void;
}

export function SubjectRefsDialog({ workflowId, subjectRefs, onChange, onClose }: SubjectRefsDialogProps) {
  const [rows, setRows] = useState<string[]>(() => (subjectRefs && subjectRefs.length > 0 ? [...subjectRefs] : [""]));
  const [preview, setPreview] = useState<SubjectRefPreviewView | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const filled = rows.map((row) => row.trim()).filter(Boolean);
  const invalid = filled.filter((row) => subjectRefPath(row) === null);
  const duplicate = new Set(filled.map((row) => subjectRefPath(row))).size !== filled.length;

  const update = (next: string[]) => {
    setRows(next);
    setPreview(null);
    const valid = next.map((row) => row.trim()).filter((row) => row && subjectRefPath(row) !== null);
    const unique = [...new Map(valid.map((row) => [subjectRefPath(row), row])).values()];
    onChange(unique);
  };

  const check = async () => {
    setChecking(true);
    setPreviewError(null);
    try {
      setPreview(await previewSubjectRefs({ workflowId, subjectRefs: filled }));
    } catch (err) {
      setPreviewError(err instanceof ApiError || err instanceof Error ? err.message : "The check failed");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="pg-modal-backdrop" role="presentation" onClick={onClose}>
      <div className="pg-modal write-gate-modal" role="dialog" aria-modal="true" aria-labelledby="subject-refs-title" onClick={(event) => event.stopPropagation()}>
        <header className="pg-modal-header">
          <div>
            <h3 id="subject-refs-title" className="pg-modal-title">
              Subject references
            </h3>
            <p className="settings-help">
              Paths whose values identify the person a run is about, such as a customer id or email. Each value is stored as
              a keyed hash, never as text, so a data-subject request can find this workflow&apos;s runs and agent memory.
              Leave empty to store nothing.
            </p>
          </div>
          <button type="button" className="pg-btn ghost small" onClick={onClose}>
            Done
          </button>
        </header>
        <div className="pg-modal-body">
          {rows.map((row, index) => {
            const bad = row.trim() !== "" && subjectRefPath(row) === null;
            return (
              <div className="cfg-field" key={index}>
                <label className="cfg-label" htmlFor={`subject-ref-${index}`}>
                  Reference {index + 1}
                </label>
                <div className="subject-ref-row">
                  <input
                    id={`subject-ref-${index}`}
                    className="cfg-input"
                    value={row}
                    placeholder="{{input.customerId}}"
                    aria-invalid={bad}
                    onChange={(event) => update(rows.map((entry, i) => (i === index ? event.target.value : entry)))}
                  />
                  <button
                    type="button"
                    className="pg-btn ghost small"
                    aria-label={`Remove reference ${index + 1}`}
                    onClick={() => update(rows.length === 1 ? [""] : rows.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </div>
                {bad && <div className="cfg-help settings-error">Use a plain path under input, output or customData, or session_id or triggeredBy, in {"{{ }}"}.</div>}
              </div>
            );
          })}
          {rows.length < SUBJECT_REF_MAX && (
            <button type="button" className="pg-btn ghost small" onClick={() => update([...rows, ""])}>
              Add reference
            </button>
          )}
          {duplicate && <div className="cfg-help settings-error">Each path can be listed once.</div>}
          <div className="cfg-help">
            <code>{"{{session_id}}"}</code> also links the agent memory kept for that session.
          </div>

          <div className="subject-ref-check">
            <button type="button" className="pg-btn small" disabled={checking || filled.length === 0 || invalid.length > 0} onClick={() => void check()}>
              {checking ? "Checking…" : "Check on recent runs"}
            </button>
            {previewError && <div className="settings-error">{previewError}</div>}
            {preview && (
              <ul className="subject-ref-preview" aria-label="Check results">
                {preview.runs === 0 && <li>No runs yet to check against.</li>}
                {preview.runs > 0 &&
                  preview.refs.map((ref) => (
                    <li key={ref.expression}>
                      <code>{ref.expression}</code>: found in {ref.resolved} of {preview.runs} recent runs
                      {ref.sample ? ` (latest: ${ref.sample})` : ""}
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
