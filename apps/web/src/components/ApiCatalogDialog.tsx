/**
 * "Your integrations": add an API from an OpenAPI 3 spec (a URL or a file), and refresh or remove the project's APIs
 * and registered MCP servers' tool lists. Each operation and tool then shows in the palette as `<source> · <item>`.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { CatalogSourceSummary } from "@ai-orchestrator/shared";
import {
  createOpenApiSpec,
  deleteOpenApiSpec,
  probeMcpServer,
  refreshOpenApiSpec,
  updateOpenApiSpec
} from "../lib/api";
import { clearOpenApiSpecCache } from "./IntegrationForms";

/** Largest file the dialog reads (the server's own limit). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface ApiCatalogDialogProps {
  projectId: string | null;
  sources: CatalogSourceSummary[];
  /** Only admins probe MCP servers (the probe route is theirs). */
  canRefreshMcp: boolean;
  /** Reloads the catalog after a change. */
  onChanged: () => Promise<void> | void;
  onClose: () => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function when(value: string | null): string {
  if (!value) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function ApiCatalogDialog({ projectId, sources, canRefreshMcp, onChanged, onClose }: ApiCatalogDialogProps) {
  const urlId = useId();
  const fileId = useId();
  const nameId = useId();
  const baseId = useId();
  const [mode, setMode] = useState<"url" | "file">("url");
  const [url, setUrl] = useState("");
  const [fileText, setFileText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsBaseUrl, setNeedsBaseUrl] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const refreshFileRef = useRef<HTMLInputElement>(null);
  const [refreshTarget, setRefreshTarget] = useState<string | null>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    urlRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const readFile = async (file: File): Promise<string | null> => {
    if (file.size > MAX_FILE_BYTES) {
      setError("The file is larger than 2 MB.");
      return null;
    }
    return await file.text();
  };

  const run = async (key: string, action: () => Promise<string | null>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const message = await action();
      // Operation forms read the spec again after a change.
      clearOpenApiSpecCache();
      await onChanged();
      if (message) setNotice(message);
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      setBusy(null);
    }
  };

  const add = () =>
    run("add", async () => {
      if (mode === "url" && !url.trim()) throw new Error("Enter the spec's URL.");
      if (mode === "file" && !fileText) throw new Error("Choose a spec file.");
      const { spec } = await createOpenApiSpec({
        projectId,
        ...(mode === "url" ? { url: url.trim() } : { specText: fileText! }),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {})
      });
      setUrl("");
      setFileText(null);
      setFileName("");
      setName("");
      setBaseUrl("");
      setNeedsBaseUrl(spec.baseUrl ? null : spec.id);
      const warnings = spec.warnings.length ? ` Note: ${spec.warnings.join(" ")}` : "";
      return `Added ${spec.name}: ${spec.operationCount} operation${spec.operationCount === 1 ? "" : "s"} in the palette.${warnings}`;
    });

  const apis = sources.filter((source) => source.kind === "openapi_spec");
  const servers = sources.filter((source) => source.kind === "mcp_server");

  return (
    <div className="pg-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="pg-modal api-catalog-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="api-catalog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="pg-modal-header">
          <div>
            <h3 id="api-catalog-title" className="pg-modal-title">
              Your integrations
            </h3>
            <p className="settings-help">
              Add an API from its OpenAPI 3 spec. Each operation becomes a node in the palette with a form for its
              parameters. Pick a secret on the node; the spec never holds one.
            </p>
          </div>
        </header>
        <div className="pg-modal-body">
          <div className="api-catalog-add" role="group" aria-label="Add an API">
            <div className="api-catalog-mode" role="radiogroup" aria-label="Spec source">
              <label>
                <input type="radio" name="api-catalog-mode" checked={mode === "url"} onChange={() => setMode("url")} /> From a URL
              </label>
              <label>
                <input type="radio" name="api-catalog-mode" checked={mode === "file"} onChange={() => setMode("file")} /> From a file
              </label>
            </div>
            {mode === "url" ? (
              <div className="cfg-field">
                <label className="cfg-label" htmlFor={urlId}>
                  Spec URL
                </label>
                <input
                  id={urlId}
                  ref={urlRef}
                  className="cfg-input"
                  placeholder="https://api.example.com/openapi.json"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void add();
                    }
                  }}
                />
              </div>
            ) : (
              <div className="cfg-field">
                <label className="cfg-label" htmlFor={fileId}>
                  Spec file (JSON or YAML)
                </label>
                <input
                  id={fileId}
                  type="file"
                  accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    const text = await readFile(file);
                    setFileText(text);
                    setFileName(text ? file.name : "");
                  }}
                />
                {fileName ? <small className="kb-subtle">{fileName}</small> : null}
              </div>
            )}
            <details className="cfg-advanced">
              <summary>Name and base URL (optional)</summary>
              <div className="cfg-advanced-body">
                <div className="cfg-field">
                  <label className="cfg-label" htmlFor={nameId}>
                    Name
                  </label>
                  <input id={nameId} className="cfg-input" placeholder="The spec's title" value={name} onChange={(event) => setName(event.target.value)} />
                </div>
                <div className="cfg-field">
                  <label className="cfg-label" htmlFor={baseId}>
                    Base URL
                  </label>
                  <input
                    id={baseId}
                    className="cfg-input"
                    placeholder="The spec's first server"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                  />
                </div>
              </div>
            </details>
            <div className="webhook-test-actions">
              <button type="button" className="pg-btn primary" onClick={() => void add()} disabled={busy !== null}>
                {busy === "add" ? "Adding…" : "Add API"}
              </button>
            </div>
          </div>

          {error ? (
            <div className="error-banner" role="alert">
              {error}
            </div>
          ) : null}
          {notice ? (
            <div className="cfg-tip" role="status">
              {notice}
            </div>
          ) : null}

          {apis.length > 0 && (
            <section className="api-catalog-list" aria-label="APIs">
              <h4>APIs</h4>
              <ul>
                {apis.map((source) => (
                  <li key={source.id}>
                    <div>
                      <strong>{source.name}</strong>
                      <small className="kb-subtle">
                        {source.itemCount} operation{source.itemCount === 1 ? "" : "s"} · read {when(source.refreshedAt)}
                        {source.sourceUrl ? "" : " · uploaded"}
                      </small>
                      {needsBaseUrl === source.id && (
                        <BaseUrlPrompt
                          busy={busy !== null}
                          onSave={(value) => run(`base:${source.id}`, async () => {
                            await updateOpenApiSpec(source.id, { baseUrl: value });
                            setNeedsBaseUrl(null);
                            return `Base URL of ${source.name} saved. New nodes use it.`;
                          })}
                        />
                      )}
                    </div>
                    <div className="api-catalog-actions">
                      <button
                        type="button"
                        className="pg-btn ghost small"
                        disabled={busy !== null}
                        aria-label={`Refresh ${source.name}`}
                        onClick={() => {
                          if (source.sourceUrl) {
                            void run(`refresh:${source.id}`, async () => {
                              const result = await refreshOpenApiSpec(source.id);
                              return `${source.name} refreshed: ${result.spec.operationCount} operations${result.removed.length ? `; removed: ${result.removed.join(", ")}` : ""}.`;
                            });
                          } else {
                            setRefreshTarget(source.id);
                            refreshFileRef.current?.click();
                          }
                        }}
                      >
                        {busy === `refresh:${source.id}` ? "Refreshing…" : "Refresh"}
                      </button>
                      <button
                        type="button"
                        className="pg-btn ghost small danger"
                        disabled={busy !== null}
                        aria-label={`Remove ${source.name}`}
                        onClick={() => {
                          if (!window.confirm(`Remove ${source.name} from the palette? Nodes already made from it keep working.`)) return;
                          void run(`delete:${source.id}`, async () => {
                            await deleteOpenApiSpec(source.id);
                            return `${source.name} removed.`;
                          });
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <input
                ref={refreshFileRef}
                type="file"
                hidden
                accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
                aria-label="New spec file"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  const target = refreshTarget;
                  if (!file || !target) return;
                  const text = await readFile(file);
                  if (!text) return;
                  void run(`refresh:${target}`, async () => {
                    const result = await refreshOpenApiSpec(target, text);
                    return `${result.spec.name} refreshed: ${result.spec.operationCount} operations.`;
                  });
                }}
              />
            </section>
          )}

          {servers.length > 0 && (
            <section className="api-catalog-list" aria-label="MCP servers">
              <h4>MCP servers</h4>
              <ul>
                {servers.map((source) => (
                  <li key={source.id}>
                    <div>
                      <strong>{source.name}</strong>
                      <small className="kb-subtle">
                        {source.itemCount} tool{source.itemCount === 1 ? "" : "s"} · listed {when(source.refreshedAt)}
                      </small>
                    </div>
                    {canRefreshMcp && (
                      <div className="api-catalog-actions">
                        <button
                          type="button"
                          className="pg-btn ghost small"
                          disabled={busy !== null}
                          aria-label={`Refresh tools of ${source.name}`}
                          onClick={() =>
                            void run(`probe:${source.id}`, async () => {
                              await probeMcpServer(source.id);
                              return `Tools of ${source.name} listed again.`;
                            })
                          }
                        >
                          {busy === `probe:${source.id}` ? "Refreshing…" : "Refresh"}
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <p className="settings-help">Register MCP servers on the MCP servers page; their tools show here after a probe.</p>
            </section>
          )}

          <div className="webhook-test-actions">
            <button type="button" className="pg-btn ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BaseUrlPrompt({ busy, onSave }: { busy: boolean; onSave: (value: string) => Promise<void> }) {
  const id = useId();
  const [value, setValue] = useState("");
  return (
    <div className="cfg-field api-catalog-base">
      <label className="cfg-label" htmlFor={id}>
        The spec names no server. Base URL
      </label>
      <input id={id} className="cfg-input" placeholder="https://api.example.com/v1" value={value} onChange={(event) => setValue(event.target.value)} />
      <button type="button" className="pg-btn small" disabled={busy || !value.trim()} onClick={() => void onSave(value.trim())}>
        Save base URL
      </button>
    </div>
  );
}
