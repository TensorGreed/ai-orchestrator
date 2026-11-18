/**
 * The workflow's error workflow (`settings.errorWorkflowId`): another workflow that starts when a run of this one
 * fails, with the failed run's details as its input. Off when none is picked.
 */
import { useId } from "react";

export interface ErrorWorkflowOption {
  id: string;
  name: string;
}

interface ErrorWorkflowDialogProps {
  /** This workflow: it is left out of the list (a workflow cannot handle its own failures). */
  workflowId: string;
  errorWorkflowId: string | undefined;
  workflows: ErrorWorkflowOption[];
  /** `undefined` turns it off. */
  onChange: (errorWorkflowId: string | undefined) => void;
  onClose: () => void;
}

export function ErrorWorkflowDialog({ workflowId, errorWorkflowId, workflows, onChange, onClose }: ErrorWorkflowDialogProps) {
  const selectId = useId();
  const current = errorWorkflowId ?? "";
  const options = workflows.filter((workflow) => workflow.id !== workflowId);
  // A saved id that is not in the list (another project's shared workflow, or one deleted since) stays visible.
  const unknownCurrent = current !== "" && !options.some((workflow) => workflow.id === current);

  return (
    <div className="pg-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="pg-modal write-gate-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="error-workflow-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="pg-modal-header">
          <div>
            <h3 id="error-workflow-title" className="pg-modal-title">
              Error workflow
            </h3>
            <p className="settings-help">
              A workflow that starts when a run of this one fails, for alerts or clean-up. It gets the failed run&apos;s
              details (workflow, run id, error and time) as its input; start it with an Error Trigger to read them. The
              failed run&apos;s caller still gets the error. Replays never start it.
            </p>
          </div>
          <button type="button" className="pg-btn ghost small" onClick={onClose}>
            Done
          </button>
        </header>
        <div className="pg-modal-body">
          <div className="cfg-field">
            <label className="cfg-label" htmlFor={selectId}>
              Run on failure
            </label>
            <select
              id={selectId}
              className="cfg-input"
              value={current}
              onChange={(event) => onChange(event.target.value || undefined)}
            >
              <option value="">None</option>
              {unknownCurrent && <option value={current}>{current} (not in this project&apos;s list)</option>}
              {options.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name}
                </option>
              ))}
            </select>
          </div>
          {unknownCurrent && (
            <div className="cfg-help">
              The saved error workflow is not in this project&apos;s list. A workflow shared to this project with execute
              access still works; one that was deleted is skipped when a run fails.
            </div>
          )}
          <div className="cfg-help">
            It must be in this project or shared to it with execute access; otherwise it is skipped. Save the workflow to keep
            the change.
          </div>
        </div>
      </div>
    </div>
  );
}
