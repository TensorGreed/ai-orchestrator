/**
 * Shown when an imported workflow file has the id of a workflow you can see. Importing it as a new workflow is the
 * default; replacing the stored one is an explicit choice, with a summary of what the replace changes.
 */
import { useEffect, useRef, useState } from "react";
import type { WorkflowDiff } from "@ai-orchestrator/shared";

export type ImportConflictChoice = "new" | "replace";

interface ImportConflictDialogProps {
  fileName?: string;
  /** The name the file gives the workflow. */
  importedName: string;
  existing: { id: string; name: string; updatedAt: string | null };
  diff: WorkflowDiff | null;
  /** False when you may only view the stored workflow: replacing it is not offered. */
  canReplace?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: (choice: ImportConflictChoice) => void;
  onClose: () => void;
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** One line per kind of change, such as "2 nodes added: Set, Output". */
export function diffSummaryLines(diff: WorkflowDiff): string[] {
  const names = (items: Array<{ name?: string; id: string }>) => {
    const shown = items.slice(0, 5).map((item) => item.name ?? item.id);
    return items.length > 5 ? `${shown.join(", ")} and ${items.length - 5} more` : shown.join(", ");
  };
  const lines: string[] = [];
  if (diff.nodes.added.length) lines.push(`${count(diff.nodes.added.length, "node")} added: ${names(diff.nodes.added)}`);
  if (diff.nodes.removed.length) lines.push(`${count(diff.nodes.removed.length, "node")} removed: ${names(diff.nodes.removed)}`);
  if (diff.nodes.changed.length) lines.push(`${count(diff.nodes.changed.length, "node")} changed: ${names(diff.nodes.changed)}`);
  if (diff.edges.added.length) lines.push(`${count(diff.edges.added.length, "connection")} added`);
  if (diff.edges.removed.length) lines.push(`${count(diff.edges.removed.length, "connection")} removed`);
  if (diff.edges.changed.length) lines.push(`${count(diff.edges.changed.length, "connection")} changed`);
  if (diff.fields.length) lines.push(`Workflow settings changed: ${diff.fields.join(", ")}`);
  if (diff.nodes.moved) lines.push(`${count(diff.nodes.moved, "node")} moved`);
  return lines;
}

export function ImportConflictDialog({ fileName, importedName, existing, diff, canReplace = true, busy, error, onConfirm, onClose }: ImportConflictDialogProps) {
  const [choice, setChoice] = useState<ImportConflictChoice>("new");
  const firstRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    firstRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const lines = diff ? diffSummaryLines(diff) : [];

  return (
    <div className="pg-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="pg-modal write-gate-modal import-conflict-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-conflict-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="pg-modal-header">
          <div>
            <h3 id="import-conflict-title" className="pg-modal-title">
              This workflow is already here
            </h3>
            <p className="settings-help">
              {fileName ? <code>{fileName}</code> : "The file"} has the id <code>{existing.id}</code>, which is{" "}
              <strong>{existing.name}</strong>
              {existing.updatedAt ? ` (last saved ${new Date(existing.updatedAt).toLocaleString()})` : ""}.
            </p>
          </div>
        </header>
        <div className="pg-modal-body">
          <fieldset className="import-conflict-choices">
            <legend className="sr-only">How to import</legend>
            <label className="import-conflict-choice">
              <input
                ref={firstRef}
                type="radio"
                name="import-conflict"
                value="new"
                checked={choice === "new"}
                onChange={() => setChoice("new")}
              />
              <span>
                <strong>Import as a new workflow</strong>
                <span className="settings-help">
                  Saved as “{importedName} (imported)” with its own id and trigger paths. {existing.name} is not changed.
                </span>
              </span>
            </label>
            {canReplace ? (
              <label className="import-conflict-choice">
                <input type="radio" name="import-conflict" value="replace" checked={choice === "replace"} onChange={() => setChoice("replace")} />
                <span>
                  <strong>Replace {existing.name}</strong>
                  <span className="settings-help">Overwrites it with the file. Its current version stays in the version history.</span>
                </span>
              </label>
            ) : (
              <p className="settings-muted">You can view {existing.name} but not change it, so the file can only be imported as a new workflow.</p>
            )}
          </fieldset>
          {choice === "replace" ? (
            <div className="import-conflict-diff" aria-live="polite">
              <h4>What the replace changes</h4>
              {!diff || diff.identical ? (
                <p className="settings-muted">Nothing but positions: the file matches the saved workflow.</p>
              ) : (
                <ul>
                  {lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
          {error ? (
            <div className="error-banner" role="alert">
              {error}
            </div>
          ) : null}
          <div className="webhook-test-actions">
            <button type="button" className="pg-btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={choice === "replace" ? "pg-btn primary danger" : "pg-btn primary"}
              onClick={() => onConfirm(choice)}
              disabled={busy}
            >
              {choice === "replace" ? `Replace ${existing.name}` : "Import as new"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
