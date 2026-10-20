import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import type { ImportNodeStatus, ImportReport } from "@ai-orchestrator/shared";
import type { ExternalImportResponse } from "../lib/api";
import { inspectImportText, summarizeReport } from "../lib/external-import";

export interface ExternalImportSource {
  text: string;
  fileName?: string;
}

interface ExternalImportDialogProps {
  open: boolean;
  /** A file that was dropped or picked before the dialog opened; previewed straight away. */
  initialSource?: ExternalImportSource | null;
  /** Where the workflow will land, shown in the footer. */
  projectName?: string;
  /** Converts without saving. */
  onPreview: (sourceText: string) => Promise<ExternalImportResponse>;
  /** Converts and saves; the dialog closes when this resolves. */
  onImport: (sourceText: string, name: string) => Promise<void>;
  /** Called when the file is already an L2M export, so the regular import can take it. */
  onNativeFile: (source: ExternalImportSource) => void;
  onClose: () => void;
}

const STATUS_ORDER: ImportNodeStatus[] = ["unsupported", "approximated", "mapped"];
const STATUS_LABEL: Record<ImportNodeStatus, string> = {
  mapped: "Mapped",
  approximated: "Approximated",
  unsupported: "Placeholder"
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ImportMeter({ report }: { report: ImportReport }) {
  const { total, mapped, approximated, unsupported } = report.summary;
  const pct = (value: number) => (total > 0 ? `${(value / total) * 100}%` : "0%");
  return (
    <div className="import-meter" role="img" aria-label={summarizeReport(report)}>
      <span className="import-meter-seg is-mapped" style={{ width: pct(mapped) }} />
      <span className="import-meter-seg is-approximated" style={{ width: pct(approximated) }} />
      <span className="import-meter-seg is-unsupported" style={{ width: pct(unsupported) }} />
    </div>
  );
}

export function ExternalImportDialog({
  open,
  initialSource,
  projectName,
  onPreview,
  onImport,
  onNativeFile,
  onClose
}: ExternalImportDialogProps) {
  const [source, setSource] = useState<ExternalImportSource | null>(null);
  const [pasted, setPasted] = useState("");
  const [preview, setPreview] = useState<ExternalImportResponse | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const reset = useCallback(() => {
    setSource(null);
    setPasted("");
    setPreview(null);
    setName("");
    setError(null);
    setBusy(false);
    setDragActive(false);
  }, []);

  const runPreview = useCallback(
    async (next: ExternalImportSource) => {
      setError(null);
      const inspected = inspectImportText(next.text);
      if (inspected.error) {
        setError(`That file is not valid JSON: ${inspected.error}`);
        return;
      }
      if (inspected.format === "native") {
        onNativeFile(next);
        return;
      }
      if (inspected.format === "unknown") {
        setError("This JSON does not look like a workflow export. It needs a top-level \"nodes\" list.");
        return;
      }
      setSource(next);
      setBusy(true);
      try {
        const result = await onPreview(next.text);
        setPreview(result);
        setName(result.workflow.name);
      } catch (previewError) {
        setPreview(null);
        setError(errorMessage(previewError));
      } finally {
        setBusy(false);
      }
    },
    [onNativeFile, onPreview]
  );

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    if (initialSource) void runPreview(initialSource);
    // Only react to a new open or a new initial file, not to callback identity changes.
  }, [open, initialSource]);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  const readFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      try {
        await runPreview({ text: await file.text(), fileName: file.name });
      } catch (readError) {
        setError(`Could not read ${file.name}: ${errorMessage(readError)}`);
      }
    },
    [runPreview]
  );

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    void readFile(file);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    void readFile(event.dataTransfer.files?.[0]);
  };

  const grouped = useMemo(() => {
    const nodes = preview?.report.nodes ?? [];
    return STATUS_ORDER.map((status) => ({ status, entries: nodes.filter((entry) => entry.status === status) })).filter(
      (group) => group.entries.length > 0
    );
  }, [preview]);

  const handleImport = async () => {
    if (!source || !preview) return;
    setBusy(true);
    setError(null);
    try {
      await onImport(source.text, name.trim() || preview.workflow.name);
    } catch (importError) {
      setError(errorMessage(importError));
      setBusy(false);
    }
  };

  if (!open) return null;

  const report = preview?.report;
  const followUps = report
    ? [
        report.secretsToResolve.length ? `${report.secretsToResolve.length} credential${report.secretsToResolve.length === 1 ? "" : "s"} to link` : null,
        report.variablesToSet.length ? `${report.variablesToSet.length} variable${report.variablesToSet.length === 1 ? "" : "s"} to fill in` : null,
        report.unresolvedExpressions.length
          ? `${report.unresolvedExpressions.length} expression${report.unresolvedExpressions.length === 1 ? "" : "s"} to rewrite`
          : null,
        report.summary.unsupported ? `${report.summary.unsupported} placeholder node${report.summary.unsupported === 1 ? "" : "s"} to replace` : null
      ].filter((item): item is string => Boolean(item))
    : [];

  return (
    <div className="pg-modal-backdrop" role="presentation" onClick={busy ? undefined : onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="pg-modal import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="pg-modal-header">
          <div>
            <h3 id="import-dialog-title" className="pg-modal-title">
              Import from another builder
            </h3>
            <p className="import-dialog-sub">
              {report
                ? `Preview of “${report.sourceName}”. Nothing is saved until you import.`
                : "Bring a workflow you exported as JSON. You'll see how every node converts before anything is saved."}
            </p>
          </div>
          <button type="button" className="pg-btn ghost small" onClick={onClose} aria-label="Close import dialog" disabled={busy}>
            ✕
          </button>
        </header>

        <div className="pg-modal-body">
          {error && (
            <div className="import-error" role="alert">
              {error}
            </div>
          )}

          {!report && (
            <>
              <div
                className={`import-drop${dragActive ? " is-active" : ""}${busy ? " is-busy" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={onDrop}
              >
                <span className="import-drop-glyph" aria-hidden="true">
                  ⇣
                </span>
                <strong>{busy ? "Converting…" : "Drop an exported workflow file here"}</strong>
                <span className="import-drop-hint">.json export with a nodes list and their connections</span>
                <button type="button" className="pg-btn" onClick={() => fileRef.current?.click()} disabled={busy}>
                  Choose file…
                </button>
                <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={onFileChange} data-testid="import-file-input" />
              </div>

              <label className="import-paste">
                <span>Or paste the JSON</span>
                <textarea
                  value={pasted}
                  onChange={(event) => setPasted(event.target.value)}
                  placeholder='{ "name": "…", "nodes": [ … ], "connections": { … } }'
                  rows={5}
                  spellCheck={false}
                  disabled={busy}
                />
              </label>
            </>
          )}

          {report && preview && (
            <>
              <label className="import-name">
                <span>Workflow name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
              </label>

              <section className="import-summary" aria-label="Conversion summary">
                <ImportMeter report={report} />
                <ul className="import-counts">
                  <li className="is-mapped">
                    <b>{report.summary.mapped}</b> mapped
                  </li>
                  <li className="is-approximated">
                    <b>{report.summary.approximated}</b> approximated
                  </li>
                  <li className="is-unsupported">
                    <b>{report.summary.unsupported}</b> placeholder
                  </li>
                </ul>
              </section>

              {followUps.length > 0 ? (
                <p className="import-followups">
                  After import, a checklist on the canvas walks you through: {followUps.join(", ")}.
                </p>
              ) : (
                <p className="import-followups is-clean">Every node converts cleanly. It is ready to run once imported.</p>
              )}

              <div className="import-node-groups">
                {grouped.map((group) => (
                  <details key={group.status} className={`import-node-group is-${group.status}`} open={group.status !== "mapped"}>
                    <summary>
                      <i aria-hidden="true" />
                      {STATUS_LABEL[group.status]} <span>{group.entries.length}</span>
                    </summary>
                    <ul>
                      {group.entries.map((entry) => (
                        <li key={entry.targetNodeId}>
                          <div className="import-node-line">
                            <strong>{entry.sourceName}</strong>
                            <code>{entry.targetType}</code>
                          </div>
                          {entry.status !== "mapped" && <p>{entry.reason}</p>}
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
              </div>

              {report.warnings.length > 0 && (
                <ul className="import-warnings" aria-label="Warnings">
                  {report.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <footer className="import-dialog-footer">
          <span className="import-dialog-dest">{projectName ? `Imports into ${projectName}` : ""}</span>
          {report ? (
            <>
              <button type="button" className="pg-btn ghost" onClick={reset} disabled={busy}>
                Choose another
              </button>
              <button type="button" className="pg-btn primary" onClick={() => void handleImport()} disabled={busy}>
                {busy ? "Importing…" : "Import workflow"}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="pg-btn primary"
              onClick={() => void runPreview({ text: pasted })}
              disabled={busy || pasted.trim().length === 0}
            >
              Preview
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
