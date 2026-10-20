/**
 * Phase 10.6 — import MCP client config files into the registry.
 *
 * Same flow as the workflow import dialog: drop, choose or paste a file, see
 * a preview of every server entry (how it maps, what is approximated or
 * skipped, which values become secrets, which entries match a server that is
 * already registered) and only then import. Values typed here are sent with
 * the import request and stored through SecretService; they are never shown
 * back.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import type { McpConfigImportResponse, McpImportDecision, McpImportEntryView, McpImportValueSlot } from "@ai-orchestrator/shared";
import { ApiError, importMcpConfig, type McpConfigImportEntryOptions, type McpRegisteredServer } from "../lib/api";

interface McpImportDialogProps {
  open: boolean;
  /** Only admins import; everyone else may preview. */
  canImport: boolean;
  projectId?: string | null;
  onClose: () => void;
  onImported: (servers: McpRegisteredServer[]) => void;
}

interface Source {
  text: string;
  fileName?: string;
}

type EntryChoices = Record<string, { decision?: McpImportDecision; name?: string; values: Record<string, string> }>;

const STATUS_LABEL: Record<McpImportEntryView["status"], string> = {
  mapped: "Mapped",
  approximated: "Approximated",
  skipped: "Skipped"
};

const FORMAT_LABEL: Record<McpConfigImportResponse["format"], string> = {
  mcp_servers: "mcpServers config",
  servers_inputs: "servers + inputs config (mcp.json)",
  settings_mcp_servers: "editor settings (mcp.servers)",
  context_servers: "editor settings (context_servers)",
  mcp_typed_map: "typed mcp map (local / remote)"
};

function errorMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error);
}

function slotLabel(slot: McpImportValueSlot): string {
  if (slot.origin === "literal") return "From the file";
  if (slot.origin === "input") return `Prompted input${slot.inputId ? ` ${slot.inputId}` : ""}`;
  return `Read from ${slot.envRef ?? "an env var"} on the client`;
}

/** Typed values plus the defaults the file offers for prompted values. */
function effectiveValues(entry: McpImportEntryView, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slot of entry.slots) {
    const value = values[slot.id] ?? slot.defaultValue;
    if (value) out[slot.id] = value;
  }
  return out;
}

function missingFor(entry: McpImportEntryView, values: Record<string, string>): string[] {
  const effective = effectiveValues(entry, values);
  return entry.slots.filter((slot) => slot.needsValue && !effective[slot.id]).map((slot) => slot.name);
}

function connectionSummary(entry: McpImportEntryView): string {
  const connection = entry.connection;
  if (entry.adapterId === "stdio_mcp") {
    const args = Array.isArray(connection.args) ? connection.args.map(String) : [];
    return [String(connection.command ?? ""), ...args].join(" ");
  }
  return String(connection.endpoint ?? "");
}

function SlotInput({
  slot,
  value,
  disabled,
  onChange
}: {
  slot: McpImportValueSlot;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const id = `mcp-import-slot-${slot.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const placeholder = slot.origin === "literal" ? "Stored from the file (type to replace)" : slot.kind === "secret" ? "Enter the secret" : "Enter a value";
  return (
    <div className="mcp-import-slot">
      <label htmlFor={id}>
        <code>{slot.name}</code>
        <span className={slot.kind === "secret" ? "mcp-flag" : "mcp-flag mcp-flag-neutral"}>{slot.kind === "secret" ? "secret" : "value"}</span>
      </label>
      {slot.options && slot.kind === "prompt" ? (
        <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          <option value="">Choose…</option>
          {slot.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={slot.kind === "secret" ? "password" : "text"}
          autoComplete="off"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <small className="kb-subtle">
        {slotLabel(slot)}
        {slot.description ? ` · ${slot.description}` : ""}
      </small>
    </div>
  );
}

function EntryCard({
  entry,
  choice,
  busy,
  canImport,
  onDecision,
  onName,
  onValue
}: {
  entry: McpImportEntryView;
  choice: EntryChoices[string];
  busy: boolean;
  canImport: boolean;
  onDecision: (decision: McpImportDecision) => void;
  onName: (name: string) => void;
  onValue: (slotId: string, value: string) => void;
}) {
  const decision = choice?.decision ?? entry.decision;
  const values = choice?.values ?? {};
  const unusable = entry.status === "skipped";
  const missing = decision === "skip" ? [] : missingFor(entry, values);
  const enforcement = entry.blockedReason && !entry.blockedReason.startsWith("Values needed") && !unusable ? entry.blockedReason : null;
  const notMapped = entry.report.filter((item) => item.status !== "mapped");
  const result = entry.result;

  return (
    <li className={`mcp-import-entry is-${entry.status}${decision === "skip" ? " is-skipping" : ""}`} data-testid={`import-entry-${entry.key}`}>
      <div className="mcp-import-entry-head">
        <div className="mcp-import-entry-title">
          <i className={`mcp-import-dot is-${entry.status}`} aria-hidden="true" />
          {canImport && !result && decision !== "skip" && decision !== "update" ? (
            <input
              aria-label={`Name for ${entry.key}`}
              className="mcp-import-name"
              value={choice?.name ?? entry.name}
              disabled={busy}
              onChange={(event) => onName(event.target.value)}
            />
          ) : (
            <strong>{entry.name}</strong>
          )}
          <span className="mcp-flag mcp-flag-neutral">{entry.transport}</span>
          <span className="kb-subtle">{STATUS_LABEL[entry.status]}</span>
        </div>
        {result ? (
          <span className={result.action === "skipped" ? "mcp-flag mcp-flag-neutral" : "mcp-class is-read"}>{result.action}</span>
        ) : (
          <select
            aria-label={`What to do with ${entry.key}`}
            value={decision}
            disabled={busy || unusable}
            onChange={(event) => onDecision(event.target.value as McpImportDecision)}
          >
            <option value="create">{entry.duplicate ? "Create anyway" : "Create"}</option>
            {entry.duplicate && <option value="update">Update {entry.duplicate.serverName}</option>}
            {entry.duplicate && <option value="copy">Create a copy</option>}
            <option value="skip">Skip</option>
          </select>
        )}
      </div>

      <code className="mcp-import-conn">{connectionSummary(entry)}</code>

      {entry.duplicate && !result && (
        <p className="mcp-import-note">
          Matches registered server <strong>{entry.duplicate.serverName}</strong> (same {entry.duplicate.match === "url" ? "URL" : "command and arguments"}).
        </p>
      )}
      {entry.secretMode === "bundle" && (
        <p className="mcp-import-note">Several credentials: stored together as one secret bundle, injected by name.</p>
      )}
      {enforcement && <p className="mcp-blocked">{enforcement}</p>}
      {unusable && entry.blockedReason && <p className="mcp-blocked">{entry.blockedReason}</p>}
      {result?.reason && result.action === "skipped" && <p className="mcp-import-note">{result.reason}</p>}

      {!result && decision !== "skip" && entry.slots.length > 0 && (
        <div className="mcp-import-slots">
          {entry.slots.map((slot) => (
            <SlotInput
              key={slot.id}
              slot={slot}
              value={values[slot.id] ?? slot.defaultValue ?? ""}
              disabled={busy || !canImport}
              onChange={(value) => onValue(slot.id, value)}
            />
          ))}
          {missing.length > 0 && canImport && <p className="mcp-blocked">Needed to import: {missing.join(", ")}</p>}
        </div>
      )}

      {notMapped.length > 0 && (
        <details className="mcp-import-report">
          <summary>
            {notMapped.length} field{notMapped.length === 1 ? "" : "s"} not mapped one to one
          </summary>
          <ul>
            {notMapped.map((item, index) => (
              <li key={`${item.field}-${index}`} className={`is-${item.status}`}>
                <code>{item.field}</code> <span className="kb-subtle">{item.status}</span>
                <p>{item.message}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

function importedSummary(created: number, updated: number): string {
  const plural = (count: number) => (count === 1 ? "" : "s");
  if (created > 0 && updated > 0) return `Imported ${created} new and updated ${updated} existing server${plural(created + updated)}.`;
  if (updated > 0) return `Updated ${updated} existing server${plural(updated)}.`;
  if (created > 0) return `Imported ${created} new server${plural(created)}.`;
  return "Nothing was imported.";
}

export function McpImportDialog({ open, canImport, projectId, onClose, onImported }: McpImportDialogProps) {
  const [source, setSource] = useState<Source | null>(null);
  const [pasted, setPasted] = useState("");
  const [preview, setPreview] = useState<McpConfigImportResponse | null>(null);
  const [choices, setChoices] = useState<EntryChoices>({});
  const [result, setResult] = useState<(McpConfigImportResponse & { servers?: McpRegisteredServer[] }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const reset = useCallback(() => {
    setSource(null);
    setPasted("");
    setPreview(null);
    setChoices({});
    setResult(null);
    setError(null);
    setBusy(false);
    setDragActive(false);
  }, []);

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, reset]);

  /** Options without values: previews never need the secrets. */
  const previewOptions = (current: EntryChoices): Record<string, McpConfigImportEntryOptions> =>
    Object.fromEntries(
      Object.entries(current).map(([key, choice]) => [
        key,
        { ...(choice.decision ? { decision: choice.decision } : {}), ...(choice.name?.trim() ? { name: choice.name.trim() } : {}) }
      ])
    );

  const runPreview = useCallback(
    async (next: Source, current: EntryChoices = {}) => {
      setBusy(true);
      setError(null);
      try {
        const response = await importMcpConfig({
          content: next.text,
          ...(next.fileName ? { fileName: next.fileName } : {}),
          dryRun: true,
          projectId: projectId ?? null,
          entries: previewOptions(current)
        });
        setSource(next);
        setPreview(response);
      } catch (previewError) {
        setError(errorMessage(previewError));
      } finally {
        setBusy(false);
      }
    },
    [projectId]
  );

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      await runPreview({ text: await file.text(), fileName: file.name });
    } catch (readError) {
      setError(`Could not read ${file.name}: ${errorMessage(readError)}`);
    }
  };

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

  const updateChoice = (key: string, patch: Partial<EntryChoices[string]>, refresh: boolean) => {
    const next: EntryChoices = {
      ...choices,
      [key]: { ...choices[key], ...patch, values: { ...(choices[key]?.values ?? {}), ...(patch.values ?? {}) } }
    };
    setChoices(next);
    // A decision changes names and duplicate handling; ask the server again.
    if (refresh && source) void runPreview(source, next);
  };

  const entries = result?.entries ?? preview?.entries ?? [];
  const ready = useMemo(() => {
    if (!preview) return { importable: 0, blocked: 0 };
    let importable = 0;
    let blocked = 0;
    for (const entry of preview.entries) {
      const choice = choices[entry.key];
      const decision = choice?.decision ?? entry.decision;
      if (decision === "skip" || entry.status === "skipped") continue;
      const missing = missingFor(entry, choice?.values ?? {});
      const otherBlock = entry.blockedReason && !entry.blockedReason.startsWith("Values needed");
      if (missing.length > 0 || otherBlock) blocked += 1;
      else importable += 1;
    }
    return { importable, blocked };
  }, [preview, choices]);

  const handleImport = async () => {
    if (!source || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const options: Record<string, McpConfigImportEntryOptions> = {};
      for (const entry of preview.entries) {
        const choice = choices[entry.key];
        const values = effectiveValues(entry, choice?.values ?? {});
        options[entry.key] = {
          decision: choice?.decision ?? entry.decision,
          ...(choice?.name?.trim() ? { name: choice.name.trim() } : {}),
          ...(Object.keys(values).length > 0 ? { values } : {})
        };
      }
      const response = await importMcpConfig({
        content: source.text,
        ...(source.fileName ? { fileName: source.fileName } : {}),
        projectId: projectId ?? null,
        entries: options
      });
      setResult(response);
      // Values are no longer needed once the server stored them.
      setChoices({});
      onImported(response.servers ?? []);
    } catch (importError) {
      setError(errorMessage(importError));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const summary = result?.summary ?? preview?.summary;
  const createdCount = result ? result.entries.filter((entry) => entry.result?.action === "created").length : 0;
  const updatedCount = result ? result.entries.filter((entry) => entry.result?.action === "updated").length : 0;

  return (
    <div className="pg-modal-backdrop" role="presentation" onClick={busy ? undefined : onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="pg-modal import-dialog mcp-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-import-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="pg-modal-header">
          <div>
            <h3 id="mcp-import-title" className="pg-modal-title">
              Import MCP client config
            </h3>
            <p className="import-dialog-sub">
              {result
                ? importedSummary(createdCount, updatedCount)
                : preview
                  ? `Preview of ${source?.fileName ? `“${source.fileName}”` : "the pasted config"} (${FORMAT_LABEL[preview.format]}). Nothing is saved until you import.`
                  : "Bring the MCP servers you already use: an mcp.json, a workspace config with inputs, or an assistant's settings file. Credentials become secrets."}
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

          {!preview && (
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
                <strong>{busy ? "Reading…" : "Drop a client config file here"}</strong>
                <span className="import-drop-hint">mcp.json, .vscode/mcp.json, settings files with an MCP section (comments allowed)</span>
                <button type="button" className="pg-btn" onClick={() => fileRef.current?.click()} disabled={busy}>
                  Choose file…
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json,.jsonc"
                  hidden
                  onChange={onFileChange}
                  data-testid="mcp-import-file-input"
                />
              </div>

              <label className="import-paste">
                <span>Or paste the JSON</span>
                <textarea
                  value={pasted}
                  onChange={(event) => setPasted(event.target.value)}
                  placeholder='{ "mcpServers": { "files": { "command": "npx", "args": ["-y", "…"] } } }'
                  rows={6}
                  spellCheck={false}
                  disabled={busy}
                  aria-label="Config JSON"
                />
              </label>
            </>
          )}

          {preview && summary && (
            <>
              <ul className="import-counts" aria-label="Import summary">
                <li className="is-mapped">
                  <b>{summary.mapped}</b> mapped
                </li>
                <li className="is-approximated">
                  <b>{summary.approximated}</b> approximated
                </li>
                <li className="is-unsupported">
                  <b>{summary.skipped}</b> unusable
                </li>
              </ul>
              {!canImport && <p className="import-followups">Preview only: an admin imports servers into the registry.</p>}
              <ul className="mcp-import-entries">
                {entries.map((entry) => (
                  <EntryCard
                    key={entry.key}
                    entry={entry}
                    choice={choices[entry.key]}
                    busy={busy}
                    canImport={canImport && !result}
                    onDecision={(decision) => updateChoice(entry.key, { decision }, true)}
                    onName={(name) => updateChoice(entry.key, { name }, false)}
                    onValue={(slotId, value) => updateChoice(entry.key, { values: { [slotId]: value } }, false)}
                  />
                ))}
              </ul>
              {preview.warnings.length > 0 && (
                <ul className="import-warnings" aria-label="Warnings">
                  {preview.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <footer className="import-dialog-footer">
          <span className="import-dialog-dest">
            {preview && !result && canImport
              ? `${ready.importable} to import${ready.blocked ? ` · ${ready.blocked} need attention` : ""}`
              : ""}
          </span>
          {result ? (
            <button type="button" className="pg-btn primary" onClick={onClose}>
              Done
            </button>
          ) : preview ? (
            <>
              <button type="button" className="pg-btn ghost" onClick={reset} disabled={busy}>
                Choose another
              </button>
              {canImport && (
                <button
                  type="button"
                  className="pg-btn primary"
                  onClick={() => void handleImport()}
                  disabled={busy || ready.importable === 0 || ready.blocked > 0}
                >
                  {busy
                    ? "Importing…"
                    : ready.importable === 0
                      ? "Nothing to import"
                      : `Import ${ready.importable} server${ready.importable === 1 ? "" : "s"}`}
                </button>
              )}
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
