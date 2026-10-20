import { useMemo, useState } from "react";
import type { ImportReport, WorkflowValidationResult } from "@ai-orchestrator/shared";
import { buildImportChecklist, summarizeReport, type ImportChecklistItem, type ImportChecklistNode } from "../lib/external-import";
import { ImportMeter } from "./ExternalImportDialog";

export interface ImportPanelSecret {
  id: string;
  name: string;
  provider: string;
}

export interface ImportReportPanelProps {
  report: ImportReport;
  nodes: ImportChecklistNode[];
  variables: Record<string, string>;
  secrets: ImportPanelSecret[];
  onLinkSecret: (placeholderId: string, secretId: string) => void;
  /** Omitted for roles that cannot open the Secrets page. */
  onOpenSecrets?: () => void;
  onOpenVariables: () => void;
  onFocusNode: (nodeId: string) => void;
  onTidy: () => void;
  /** Saves pending edits and validates the stored workflow. */
  onValidate: () => Promise<WorkflowValidationResult>;
  onDismiss: () => void;
}

const KIND_HEADING: Record<ImportChecklistItem["kind"], string> = {
  secret: "Link credentials",
  variable: "Fill in variables",
  expression: "Rewrite expressions",
  unsupported: "Replace placeholders"
};

const KIND_ORDER: ImportChecklistItem["kind"][] = ["secret", "variable", "expression", "unsupported"];

type ValidationState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; result: WorkflowValidationResult }
  | { phase: "failed"; message: string };

export function ImportReportPanel({
  report,
  nodes,
  variables,
  secrets,
  onLinkSecret,
  onOpenSecrets,
  onOpenVariables,
  onFocusNode,
  onTidy,
  onValidate,
  onDismiss
}: ImportReportPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [validation, setValidation] = useState<ValidationState>({ phase: "idle" });
  const checklist = useMemo(() => buildImportChecklist(report, { nodes, variables }), [nodes, report, variables]);
  const labelById = useMemo(() => new Map(nodes.map((node) => [node.id, node.label])), [nodes]);
  const done = checklist.total > 0 && checklist.resolved === checklist.total;

  const runValidation = async () => {
    setValidation({ phase: "running" });
    try {
      setValidation({ phase: "done", result: await onValidate() });
    } catch (error) {
      setValidation({ phase: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const progressLabel = checklist.total === 0 ? "Nothing to fix" : `${checklist.resolved} of ${checklist.total} done`;

  if (collapsed) {
    return (
      <button type="button" className={`import-panel-pill${done ? " is-done" : ""}`} onClick={() => setCollapsed(false)} aria-label="Show import checklist">
        <i aria-hidden="true" />
        Import checklist · {progressLabel}
      </button>
    );
  }

  return (
    <aside className="import-panel" aria-label="Import checklist">
      <header className="import-panel-head">
        <div>
          <p className="import-panel-eyebrow">Imported from “{report.sourceName}”</p>
          <h4>{done || checklist.total === 0 ? "Ready to run" : "Finish the import"}</h4>
        </div>
        <div className="import-panel-head-actions">
          <button type="button" className="import-icon-btn" onClick={() => setCollapsed(true)} aria-label="Minimise import checklist" title="Minimise">
            –
          </button>
          <button type="button" className="import-icon-btn" onClick={onDismiss} aria-label="Dismiss import checklist" title="Dismiss">
            ✕
          </button>
        </div>
      </header>

      <div className="import-panel-summary">
        <ImportMeter report={report} />
        <p>{summarizeReport(report)}</p>
      </div>

      {checklist.total > 0 && (
        <div className="import-panel-progress" aria-live="polite">
          <span style={{ width: `${(checklist.resolved / checklist.total) * 100}%` }} />
          <em>{progressLabel}</em>
        </div>
      )}

      <div className="import-panel-actions">
        <button type="button" className="canvas-tool" onClick={onTidy}>
          Tidy layout
        </button>
        <button type="button" className="canvas-tool" onClick={() => void runValidation()} disabled={validation.phase === "running"}>
          {validation.phase === "running" ? "Validating…" : "Validate"}
        </button>
      </div>

      {validation.phase === "done" &&
        (validation.result.valid ? (
          <p className="import-validation is-ok" role="status">
            Saved and valid. The graph is ready to run.
          </p>
        ) : (
          <div className="import-validation is-err" role="status">
            <p>Validation found {validation.result.issues.length} issue{validation.result.issues.length === 1 ? "" : "s"}:</p>
            <ul>
              {validation.result.issues.map((issue, index) => (
                <li key={`${issue.code}-${index}`}>
                  {issue.nodeId ? (
                    <button type="button" className="import-link" onClick={() => onFocusNode(issue.nodeId as string)}>
                      {labelById.get(issue.nodeId) ?? issue.nodeId}
                    </button>
                  ) : null}{" "}
                  {issue.message}
                </li>
              ))}
            </ul>
          </div>
        ))}
      {validation.phase === "failed" && (
        <p className="import-validation is-err" role="status">
          {validation.message}
        </p>
      )}

      <div className="import-panel-body">
        {KIND_ORDER.map((kind) => {
          const items = checklist.items.filter((item) => item.kind === kind);
          if (items.length === 0) return null;
          return (
            <section key={kind} className="import-panel-section">
              <h5>
                {KIND_HEADING[kind]}
                {kind === "secret" && onOpenSecrets && (
                  <button type="button" className="import-link" onClick={onOpenSecrets}>
                    Manage secrets
                  </button>
                )}
                {kind === "variable" && (
                  <button type="button" className="import-link" onClick={onOpenVariables}>
                    Open variables
                  </button>
                )}
              </h5>
              <ul>
                {items.map((item) => (
                  <li key={item.key} className={`import-item${item.resolved ? " is-resolved" : ""}`}>
                    <span className="import-check" aria-label={item.resolved ? "Done" : "To do"} role="img">
                      {item.resolved ? "✓" : ""}
                    </span>
                    <div className="import-item-main">
                      <div className="import-item-title">
                        {item.nodeIds.length === 1 ? (
                          <button type="button" className="import-link" onClick={() => onFocusNode(item.nodeIds[0])}>
                            {item.title}
                          </button>
                        ) : (
                          <span>{item.title}</span>
                        )}
                      </div>
                      {item.code && <code className="import-item-code">{item.code}</code>}
                      <p>{item.detail}</p>
                      {item.kind === "secret" && !item.resolved && item.secretId && (
                        <select
                          className="import-secret-select"
                          aria-label={`Secret for ${item.title}`}
                          value=""
                          onChange={(event) => {
                            if (event.target.value && item.secretId) onLinkSecret(item.secretId, event.target.value);
                          }}
                        >
                          <option value="">{secrets.length ? "Use a stored secret…" : "No stored secrets yet"}</option>
                          {secrets.map((secret) => (
                            <option key={secret.id} value={secret.id}>
                              {secret.name} · {secret.provider}
                            </option>
                          ))}
                        </select>
                      )}
                      {item.kind === "secret" && item.nodeIds.length > 1 && (
                        <p className="import-item-nodes">
                          Used by{" "}
                          {item.nodeIds.map((id, index) => (
                            <span key={id}>
                              {index > 0 ? ", " : ""}
                              <button type="button" className="import-link" onClick={() => onFocusNode(id)}>
                                {labelById.get(id) ?? id}
                              </button>
                            </span>
                          ))}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

        {checklist.review.length > 0 && (
          <details className="import-panel-section import-review">
            <summary>Worth a look · {checklist.review.length} approximated</summary>
            <ul>
              {checklist.review.map((entry) => (
                <li key={entry.targetNodeId} className="import-item">
                  <div className="import-item-main">
                    <button type="button" className="import-link" onClick={() => onFocusNode(entry.targetNodeId)}>
                      {labelById.get(entry.targetNodeId) ?? entry.sourceName}
                    </button>
                    <p>{entry.reason}</p>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}

        {report.warnings.length > 0 && (
          <details className="import-panel-section import-review">
            <summary>Warnings · {report.warnings.length}</summary>
            <ul className="import-warnings">
              {report.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </aside>
  );
}
