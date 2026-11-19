import type { WorkflowValidationIssue } from "@ai-orchestrator/shared";
import { splitDraftIssues } from "../lib/draft-validation";

interface DraftWarningsProps {
  issues: readonly WorkflowValidationIssue[] | null | undefined;
  /** Production would run this unfinished version: its webhooks, schedules, forms and app triggers are paused. */
  liveTriggersPaused?: boolean;
  /** The node's name on the canvas, when the issue names a node that is still there. */
  nodeLabel: (nodeId: string) => string | undefined;
  onSelectNode?: (nodeId: string) => void;
  /** Removes stored error settings with invalid values from every node (offered when the list names some). */
  onRemoveInvalidErrorConfig?: () => void;
  onDismiss: () => void;
}

function IssueLine({ issue, nodeLabel, onSelectNode }: { issue: WorkflowValidationIssue } & Pick<DraftWarningsProps, "nodeLabel" | "onSelectNode">) {
  const label = issue.nodeId ? nodeLabel(issue.nodeId) : undefined;
  return (
    <li>
      {label && issue.nodeId ? (
        onSelectNode ? (
          <button type="button" className="draft-warnings-node" onClick={() => onSelectNode(issue.nodeId!)}>
            {label}
          </button>
        ) : (
          <strong>{label}</strong>
        )
      ) : null}
      {label ? ": " : null}
      {issue.message}
    </li>
  );
}

/**
 * What a saved workflow still lacks. A draft saves with unfinished node settings; each one stops a run until it is
 * fixed. Notes (such as having no Output node) do not stop a run.
 */
export function DraftWarnings({ issues, liveTriggersPaused, nodeLabel, onSelectNode, onRemoveInvalidErrorConfig, onDismiss }: DraftWarningsProps) {
  const { toFix, notes } = splitDraftIssues(issues);
  const hasInvalidErrorConfig = (issues ?? []).some((issue) => issue.code === "invalid_error_config");
  if (toFix.length === 0 && notes.length === 0 && !liveTriggersPaused) return null;
  return (
    <div className="warn-banner global-banner draft-warnings" role="status" data-testid="draft-warnings">
      {toFix.length > 0 ? (
        <>
          <p>
            <strong>Unfinished draft.</strong> {toFix.length === 1 ? "One setting needs" : `${toFix.length} settings need`} finishing before
            this workflow can run or be published:
          </p>

          <ul>
            {toFix.map((issue, index) => (
              <IssueLine key={`fix-${issue.code}-${issue.nodeId ?? ""}-${index}`} issue={issue} nodeLabel={nodeLabel} onSelectNode={onSelectNode} />
            ))}
          </ul>
        </>
      ) : null}
      {liveTriggersPaused ? (
        <p data-testid="live-triggers-paused">
          Live triggers (webhooks, schedules, forms and app triggers) are paused until it is finished: they answer with
          an error or skip, and no run is recorded.
        </p>
      ) : null}
      {notes.length > 0 ? (
        <ul className="draft-warnings-notes">
          {notes.map((issue, index) => (
            <IssueLine key={`note-${issue.code}-${issue.nodeId ?? ""}-${index}`} issue={issue} nodeLabel={nodeLabel} onSelectNode={onSelectNode} />
          ))}
        </ul>
      ) : null}
      {hasInvalidErrorConfig && onRemoveInvalidErrorConfig ? (
        <p>
          <button type="button" className="auth-link-btn" onClick={onRemoveInvalidErrorConfig}>
            Remove the invalid error settings
          </button>{" "}
          (from every node listed, keeping their valid values), then save or run.
        </p>
      ) : null}
      <button type="button" className="auth-link-btn" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
