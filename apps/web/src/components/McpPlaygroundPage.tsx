/**
 * Phase 10.6 — MCP playground: pick a registered server, pick a tool from its
 * current schema snapshot, fill the arguments through a form generated from
 * the tool's input schema and call it through the registry (secrets injected
 * server-side, tool policy enforced for the signed-in user and the active
 * project, telemetry recorded with source `playground`).
 *
 * The view is a list of capability panels. Tools are the one capability
 * today; a panel for another capability (server resources, prompts) is added
 * to PLAYGROUND_PANELS with its own component.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { McpPlaygroundCallResponse, McpPromptGetResult, McpResourceContent } from "@ai-orchestrator/shared";
import {
  ApiError,
  callMcpPlaygroundTool,
  fetchMcpServerPrompts,
  fetchMcpServerResources,
  fetchMcpServerTools,
  getMcpServerPrompt,
  readMcpServerResource,
  type McpCatalogPrompt,
  type McpCatalogResource,
  type McpCatalogResourceTemplate,
  type McpRegisteredServer,
  type McpResourceReadResponse,
  type McpSnapshotTool
} from "../lib/api";
import {
  buildSchemaForm,
  collectArgs,
  initialFormValues,
  valuesFromArgs,
  type FormValue,
  type FormValues
} from "../lib/mcp-schema-form";
import { McpSchemaForm } from "./McpSchemaForm";

const HISTORY_LIMIT = 20;
const MASK = "••••••";
const SECRET_NAME = /(token|key|secret|passw|pwd|auth|credential|cookie)/i;

export interface PlaygroundHistoryEntry {
  serverId: string;
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  at: string;
}

function historyKey(userId: string | undefined): string {
  return `l2m:mcp-playground-history:${userId ?? "anonymous"}`;
}

export function readPlaygroundHistory(userId: string | undefined): PlaygroundHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(historyKey(userId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as PlaygroundHistoryEntry[]).slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function writePlaygroundHistory(userId: string | undefined, entries: PlaygroundHistoryEntry[]): void {
  try {
    window.localStorage.setItem(historyKey(userId), JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
  } catch {
    // Storage full or blocked: history is a convenience, the call already happened.
  }
}

/**
 * Mask credential-looking header and env values in an exchange before it is
 * shown. The API masks them already; this keeps the panel safe on its own.
 */
export function maskExchange(exchange: McpPlaygroundCallResponse["exchange"]): McpPlaygroundCallResponse["exchange"] {
  const maskMap = (map: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(map).map(([key, value]) => {
        if (!SECRET_NAME.test(key) || value.includes(MASK)) return [key, value];
        return [key, /^(bearer|basic)\s/i.test(value) ? `${value.split(/\s/)[0]} ${MASK}` : MASK];
      })
    );
  const transport = exchange.transport;
  if (transport.kind === "http") return { ...exchange, transport: { ...transport, headers: maskMap(transport.headers) } };
  if (transport.kind === "stdio") return { ...exchange, transport: { ...transport, env: maskMap(transport.env) } };
  return exchange;
}

function formatError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ClassificationChip({ tool }: { tool: McpSnapshotTool }) {
  const readOnly = tool.classification?.readOnly ?? tool.annotations?.readOnlyHint === true;
  return (
    <span className={readOnly ? "mcp-class is-read" : "mcp-class is-write"} title={readOnly ? "Read-only" : "May change data"}>
      {readOnly ? "read-only" : "write"}
    </span>
  );
}

function ContentBlock({ block }: { block: Record<string, unknown> }) {
  if (block.type === "text" && typeof block.text === "string") {
    return <pre className="mcp-pg-block is-text">{block.text}</pre>;
  }
  if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string" && block.mimeType.startsWith("image/")) {
    return <img className="mcp-pg-block is-image" src={`data:${block.mimeType};base64,${block.data}`} alt="Tool output" />;
  }
  return <pre className="mcp-pg-block">{pretty(block)}</pre>;
}

function ResultPanel({ result }: { result: McpPlaygroundCallResponse }) {
  const exchange = maskExchange(result.exchange);
  return (
    <section className="mcp-pg-result" aria-label="Tool result">
      <div className="mcp-pg-result-head">
        <span className={result.ok ? "mcp-status mcp-status-healthy" : "mcp-status mcp-status-down"}>
          <span className="mcp-status-dot" aria-hidden="true" />
          {result.ok ? "Succeeded" : "Failed"}
        </span>
        <span className="kb-subtle">
          {result.durationMs} ms · as {result.policy.role} in {result.policy.projectId}
        </span>
      </div>
      <h4 className="mcp-pg-subhead">Content</h4>
      <div className="mcp-pg-blocks">
        {result.result.content.map((block, index) => (
          <ContentBlock key={index} block={block} />
        ))}
      </div>
      {result.result.structuredContent && (
        <>
          <h4 className="mcp-pg-subhead">Structured content</h4>
          <pre className="mcp-pg-block">{pretty(result.result.structuredContent)}</pre>
        </>
      )}
      <details className="mcp-pg-exchange">
        <summary>JSON-RPC exchange</summary>
        <p className="kb-subtle">{exchange.note}</p>
        <h5>Transport</h5>
        <pre className="mcp-pg-block" data-testid="exchange-transport">
          {pretty(exchange.transport)}
        </pre>
        <h5>Request</h5>
        <pre className="mcp-pg-block">{pretty(exchange.request)}</pre>
        <h5>Response</h5>
        <pre className="mcp-pg-block">{pretty(exchange.response)}</pre>
      </details>
    </section>
  );
}

interface ToolsPanelProps {
  server: McpRegisteredServer;
  projectId?: string | null;
  userId?: string;
}

function ToolsPanel({ server, projectId, userId }: ToolsPanelProps) {
  const [tools, setTools] = useState<McpSnapshotTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toolName, setToolName] = useState<string | null>(null);
  const [values, setValues] = useState<FormValues>({});
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("{}");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Record<string, unknown> | null>(null);
  const [result, setResult] = useState<McpPlaygroundCallResponse | null>(null);
  const [history, setHistory] = useState<PlaygroundHistoryEntry[]>(() => readPlaygroundHistory(userId));
  /** History entry to load once its tool is selected. */
  const pendingReplay = useRef<PlaygroundHistoryEntry | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setResult(null);
    fetchMcpServerTools(server.id, projectId ?? undefined)
      .then((response) => {
        if (cancelled) return;
        setTools(response.tools);
        setToolName((current) => (current && response.tools.some((tool) => tool.name === current) ? current : response.tools[0]?.name ?? null));
      })
      .catch((error) => {
        if (!cancelled) setLoadError(formatError(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [server.id, projectId]);

  const tool = useMemo(() => tools.find((entry) => entry.name === toolName) ?? null, [tools, toolName]);
  const form = useMemo(() => buildSchemaForm(tool?.inputSchema), [tool]);

  const applyArgs = useCallback(
    (args: Record<string, unknown>, fields: typeof form.fields) => {
      if (fields) {
        setJsonMode(false);
        setValues(valuesFromArgs(fields, args));
      } else {
        setJsonMode(true);
      }
      setJsonText(pretty(args));
    },
    []
  );

  useEffect(() => {
    const pending = pendingReplay.current;
    pendingReplay.current = null;
    if (pending && pending.toolName === tool?.name) {
      applyArgs(pending.args, form.fields);
    } else {
      setValues(initialFormValues(tool?.inputSchema, form.fields));
      setJsonMode(form.fields === null);
      setJsonText("{}");
    }
    setErrors({});
    setCallError(null);
    setConfirming(null);
    setResult(null);
  }, [tool, form, applyArgs]);

  const onFieldChange = useCallback((path: string, value: FormValue) => {
    setValues((current) => ({ ...current, [path]: value }));
    setErrors((current) => {
      if (!current[path]) return current;
      const { [path]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const readOnly = tool ? tool.classification?.readOnly ?? tool.annotations?.readOnlyHint === true : false;
  const blocked = tool?.access && !tool.access.allowed ? tool.access : null;

  const gatherArgs = (): Record<string, unknown> | null => {
    if (jsonMode || !form.fields) {
      try {
        const parsed = JSON.parse(jsonText || "{}") as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setErrors({ $json: "Arguments must be a JSON object" });
          return null;
        }
        return parsed as Record<string, unknown>;
      } catch {
        setErrors({ $json: "Not valid JSON" });
        return null;
      }
    }
    const collected = collectArgs(form.fields, values);
    setErrors(collected.errors);
    return Object.keys(collected.errors).length > 0 ? null : collected.args;
  };

  const runCall = async (args: Record<string, unknown>, confirmWrite: boolean) => {
    if (!tool) return;
    setBusy(true);
    setCallError(null);
    setConfirming(null);
    try {
      const response = await callMcpPlaygroundTool(server.id, {
        toolName: tool.name,
        args,
        ...(projectId ? { projectId } : {}),
        ...(confirmWrite ? { confirmWrite: true } : {})
      });
      setResult(response);
      const entry: PlaygroundHistoryEntry = {
        serverId: server.id,
        serverName: server.name,
        toolName: tool.name,
        args,
        ok: response.ok,
        durationMs: response.durationMs,
        at: new Date().toISOString()
      };
      setHistory((current) => {
        const next = [entry, ...current].slice(0, HISTORY_LIMIT);
        writePlaygroundHistory(userId, next);
        return next;
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.payload?.requiresConfirmation === true) {
        setConfirming(args);
      } else {
        setCallError(formatError(error));
      }
    } finally {
      setBusy(false);
    }
  };

  const onCall = () => {
    const args = gatherArgs();
    if (!args) return;
    if (!readOnly) {
      setConfirming(args);
      return;
    }
    void runCall(args, false);
  };

  const replay = (entry: PlaygroundHistoryEntry) => {
    setErrors({});
    if (entry.toolName === toolName) {
      applyArgs(entry.args, form.fields);
      return;
    }
    pendingReplay.current = entry;
    setToolName(entry.toolName);
  };

  const serverHistory = history.filter((entry) => entry.serverId === server.id);

  if (loading) return <p className="kb-subtle">Loading tools…</p>;
  if (loadError) return <div className="settings-error">{loadError}</div>;
  if (tools.length === 0) {
    return <p className="kb-subtle">No tools in the current snapshot. Probe the server on the Servers tab to load them.</p>;
  }

  return (
    <div className="mcp-pg-tools">
      <aside className="mcp-pg-toollist" aria-label="Tools">
        {tools.map((entry) => (
          <button
            key={entry.name}
            type="button"
            className={entry.name === toolName ? "kb-item active" : "kb-item"}
            onClick={() => setToolName(entry.name)}
          >
            <div className="mcp-item-head">
              <span className="kb-item-name">{entry.name}</span>
              <ClassificationChip tool={entry} />
            </div>
            {entry.access && !entry.access.allowed && <span className="mcp-blocked">Blocked for your role</span>}
          </button>
        ))}
      </aside>

      {tool && (
        <div className="mcp-pg-main">
          <header className="mcp-pg-tool-head">
            <div className="mcp-title-row">
              <h3>{tool.name}</h3>
              <ClassificationChip tool={tool} />
            </div>
            {tool.description && <p className="kb-subtle">{tool.description}</p>}
            {blocked && (
              <p className="mcp-blocked" role="status">
                {blocked.message ?? "Tool policy blocks this tool for your role in this project."}
              </p>
            )}
          </header>

          <div className="mcp-pg-mode">
            {form.fields !== null && (
              <button type="button" className="kb-link-btn" onClick={() => {
                if (!jsonMode && form.fields) setJsonText(pretty(collectArgs(form.fields, values).args));
                setJsonMode((current) => !current);
                setErrors({});
              }}>
                {jsonMode ? "Use the form" : "Edit as JSON"}
              </button>
            )}
          </div>

          {jsonMode || form.fields === null ? (
            <div className={errors.$json ? "mcp-pg-field has-error" : "mcp-pg-field"}>
              <label htmlFor="mcp-pg-json-args" className="mcp-pg-field-label">
                Arguments (JSON)
              </label>
              <textarea
                id="mcp-pg-json-args"
                className="mcp-pg-json"
                rows={8}
                spellCheck={false}
                value={jsonText}
                onChange={(event) => setJsonText(event.target.value)}
                disabled={busy}
              />
              {errors.$json && (
                <small className="mcp-pg-field-error" role="alert">
                  {errors.$json}
                </small>
              )}
            </div>
          ) : (
            <McpSchemaForm fields={form.fields} values={values} errors={errors} disabled={busy} onChange={onFieldChange} />
          )}

          {confirming ? (
            <div className="mcp-pg-confirm" role="alertdialog" aria-label="Confirm write tool">
              <p>
                <strong>{tool.name}</strong> is classified as a write tool and may change data on {server.name}. Call it?
              </p>
              <div className="mcp-form-actions">
                <button type="button" className="pg-btn ghost" onClick={() => setConfirming(null)} disabled={busy}>
                  Cancel
                </button>
                <button type="button" className="pg-btn primary" onClick={() => void runCall(confirming, true)} disabled={busy}>
                  {busy ? "Calling…" : "Call write tool"}
                </button>
              </div>
            </div>
          ) : (
            <div className="mcp-form-actions">
              <button type="button" className="pg-btn primary" onClick={onCall} disabled={busy || Boolean(blocked)}>
                {busy ? "Calling…" : "Call tool"}
              </button>
            </div>
          )}

          {callError && (
            <div className="settings-error" role="alert">
              {callError}
            </div>
          )}

          {result && result.toolName === tool.name && <ResultPanel result={result} />}

          {serverHistory.length > 0 && (
            <section className="mcp-pg-history" aria-label="Recent calls">
              <h4 className="mcp-pg-subhead">Recent calls (this browser)</h4>
              <ul>
                {serverHistory.slice(0, 8).map((entry, index) => (
                  <li key={`${entry.at}-${index}`}>
                    <button type="button" className="kb-link-btn" onClick={() => replay(entry)}>
                      {entry.toolName}
                    </button>
                    <span className={entry.ok ? "mcp-pg-dot is-ok" : "mcp-pg-dot is-err"} aria-label={entry.ok ? "succeeded" : "failed"} />
                    <span className="kb-subtle">
                      {entry.durationMs} ms · {new Date(entry.at).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

const TEMPLATE_VARIABLE = /\{([^}]+)\}/g;

/** `{name}` placeholders of an RFC 6570 level-1 template, in order. */
export function templateVariables(uriTemplate: string): string[] {
  const names: string[] = [];
  for (const match of uriTemplate.matchAll(TEMPLATE_VARIABLE)) {
    const name = match[1].trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function expandTemplate(uriTemplate: string, values: Record<string, string>): string {
  return uriTemplate.replace(TEMPLATE_VARIABLE, (_match, name: string) => encodeURIComponent(values[name.trim()] ?? ""));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function isJsonMime(mimeType: string | undefined): boolean {
  return Boolean(mimeType && /json/i.test(mimeType));
}

function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

function extensionFor(mimeType: string | undefined): string {
  if (!mimeType) return "bin";
  const subtype = mimeType.split("/")[1]?.split(";")[0] ?? "";
  if (subtype === "plain") return "txt";
  if (subtype === "svg+xml") return "svg";
  return subtype.replace(/^x-/, "") || "bin";
}

function downloadName(uri: string, mimeType: string | undefined): string {
  const last = uri.split(/[/:]/).filter(Boolean).pop() ?? "resource";
  return /\.[A-Za-z0-9]+$/.test(last) ? last : `${last}.${extensionFor(mimeType)}`;
}

function ResourceContentView({ content, uri }: { content: McpResourceContent; uri: string }) {
  const [raw, setRaw] = useState(false);
  if ("blob" in content) {
    const href = `data:${content.mimeType ?? "application/octet-stream"};base64,${content.blob}`;
    const image = content.mimeType?.startsWith("image/");
    const bytes = Math.floor((content.blob.length * 3) / 4) - (content.blob.endsWith("==") ? 2 : content.blob.endsWith("=") ? 1 : 0);
    return (
      <div className="mcp-pg-resource-blob">
        {image ? <img className="mcp-pg-block is-image" src={href} alt={`Resource ${uri}`} /> : null}
        <a className="pg-btn small" href={href} download={downloadName(content.uri || uri, content.mimeType)}>
          Download {content.mimeType ?? "binary"} ({formatBytes(bytes)})
        </a>
      </div>
    );
  }
  const formatted = isJsonMime(content.mimeType) && !raw ? prettyJson(content.text) : null;
  return (
    <div className="mcp-pg-resource-text">
      {isJsonMime(content.mimeType) && (
        <button type="button" className="kb-link-btn" onClick={() => setRaw((current) => !current)}>
          {raw ? "Format JSON" : "Show raw"}
        </button>
      )}
      <pre className="mcp-pg-block is-text">{formatted ?? content.text}</pre>
    </div>
  );
}

interface CatalogPanelProps {
  server: McpRegisteredServer;
  projectId?: string | null;
  userId?: string;
}

function ResourcesPanel({ server, projectId }: CatalogPanelProps) {
  const [resources, setResources] = useState<McpCatalogResource[]>([]);
  const [templates, setTemplates] = useState<McpCatalogResourceTemplate[]>([]);
  const [supported, setSupported] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({});
  const [customUri, setCustomUri] = useState("");
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [result, setResult] = useState<McpResourceReadResponse | null>(null);

  const load = useCallback(
    (refresh: boolean) => {
      let cancelled = false;
      setLoading(true);
      setLoadError(null);
      fetchMcpServerResources(server.id, { projectId, refresh })
        .then((response) => {
          if (cancelled) return;
          setResources(response.resources);
          setTemplates(response.resourceTemplates);
          setSupported(Boolean(response.capabilities.resources) || response.resources.length > 0 || response.resourceTemplates.length > 0);
          setUpdatedAt(response.updatedAt);
          setSelected((current) => current ?? response.resources[0]?.uri ?? response.resourceTemplates[0]?.uriTemplate ?? null);
        })
        .catch((error) => {
          if (!cancelled) setLoadError(formatError(error));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    },
    [server.id, projectId]
  );

  useEffect(() => load(false), [load]);

  const resource = resources.find((entry) => entry.uri === selected) ?? null;
  const template = templates.find((entry) => entry.uriTemplate === selected) ?? null;
  const variables = template ? templateVariables(template.uriTemplate) : [];
  const uri = resource ? resource.uri : template ? expandTemplate(template.uriTemplate, templateValues) : customUri.trim();
  const access = resource?.access ?? template?.access ?? null;
  const blocked = access && !access.allowed ? access : null;

  const read = async () => {
    if (!uri) return;
    setBusy(true);
    setReadError(null);
    setResult(null);
    try {
      setResult(await readMcpServerResource(server.id, { uri, ...(projectId ? { projectId } : {}) }));
    } catch (error) {
      setReadError(formatError(error));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="kb-subtle">Loading resources…</p>;
  if (loadError) return <div className="settings-error">{loadError}</div>;
  if (!supported) {
    return <p className="kb-subtle">This server does not advertise resources. Probe it on the Servers tab after it starts offering some.</p>;
  }

  return (
    <div className="mcp-pg-tools">
      <aside className="mcp-pg-toollist" aria-label="Resources">
        {resources.map((entry) => (
          <button
            key={entry.uri}
            type="button"
            className={entry.uri === selected ? "kb-item active" : "kb-item"}
            onClick={() => {
              setSelected(entry.uri);
              setResult(null);
              setReadError(null);
            }}
          >
            <div className="mcp-item-head">
              <span className="kb-item-name">{entry.title ?? entry.name}</span>
              {entry.mimeType && <code className="mcp-pg-field-type">{entry.mimeType}</code>}
            </div>
            <span className="kb-subtle mcp-pg-uri">{entry.uri}</span>
            {!entry.access.allowed && <span className="mcp-blocked">Blocked for your role</span>}
          </button>
        ))}
        {templates.map((entry) => (
          <button
            key={entry.uriTemplate}
            type="button"
            className={entry.uriTemplate === selected ? "kb-item active" : "kb-item"}
            onClick={() => {
              setSelected(entry.uriTemplate);
              setResult(null);
              setReadError(null);
            }}
          >
            <div className="mcp-item-head">
              <span className="kb-item-name">{entry.title ?? entry.name}</span>
              <code className="mcp-pg-field-type">template</code>
            </div>
            <span className="kb-subtle mcp-pg-uri">{entry.uriTemplate}</span>
            {!entry.access.allowed && <span className="mcp-blocked">Blocked for your role</span>}
          </button>
        ))}
        <button
          type="button"
          className={selected === "__custom__" ? "kb-item active" : "kb-item"}
          onClick={() => {
            setSelected("__custom__");
            setResult(null);
            setReadError(null);
          }}
        >
          <span className="kb-item-name">Any URI…</span>
        </button>
        <button type="button" className="kb-link-btn" onClick={() => load(true)}>
          Refresh list{updatedAt ? ` (listed ${new Date(updatedAt).toLocaleTimeString()})` : ""}
        </button>
      </aside>

      <div className="mcp-pg-main">
        <header className="mcp-pg-tool-head">
          <h3>{resource?.title ?? resource?.name ?? template?.title ?? template?.name ?? "Read a resource"}</h3>
          {(resource?.description ?? template?.description) && <p className="kb-subtle">{resource?.description ?? template?.description}</p>}
          {blocked && (
            <p className="mcp-blocked" role="status">
              {blocked.message ?? "Tool policy blocks this resource for your role in this project."}
            </p>
          )}
        </header>
        {template && variables.length > 0 && (
          <div className="mcp-pg-fields">
            {variables.map((name) => (
              <div key={name} className="mcp-pg-field">
                <label htmlFor={`mcp-pg-tpl-${name}`} className="mcp-pg-field-label">
                  {name}
                </label>
                <input
                  id={`mcp-pg-tpl-${name}`}
                  type="text"
                  value={templateValues[name] ?? ""}
                  onChange={(event) => setTemplateValues((current) => ({ ...current, [name]: event.target.value }))}
                  disabled={busy}
                />
              </div>
            ))}
          </div>
        )}
        {selected === "__custom__" && (
          <div className="mcp-pg-field">
            <label htmlFor="mcp-pg-custom-uri" className="mcp-pg-field-label">
              Resource URI
            </label>
            <input id="mcp-pg-custom-uri" type="text" value={customUri} onChange={(event) => setCustomUri(event.target.value)} disabled={busy} spellCheck={false} />
          </div>
        )}
        <p className="kb-subtle">
          URI <code>{uri || "—"}</code>
        </p>
        <div className="mcp-form-actions">
          <button type="button" className="pg-btn primary" onClick={() => void read()} disabled={busy || !uri || Boolean(blocked)}>
            {busy ? "Reading…" : "Read resource"}
          </button>
        </div>
        {readError && (
          <div className="settings-error" role="alert">
            {readError}
          </div>
        )}
        {result && (
          <section className="mcp-pg-result" aria-label="Resource contents">
            <div className="mcp-pg-result-head">
              <span className="mcp-status mcp-status-healthy">
                <span className="mcp-status-dot" aria-hidden="true" />
                Read {formatBytes(result.bytes)}
              </span>
              <span className="kb-subtle">
                {result.durationMs} ms · as {result.policy.role} in {result.policy.projectId}
              </span>
            </div>
            {result.contents.map((content, index) => (
              <ResourceContentView key={`${content.uri}-${index}`} content={content} uri={result.uri} />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function PromptMessageView({ message }: { message: McpPromptGetResult["messages"][number] }) {
  const content = message.content;
  return (
    <div className="mcp-pg-prompt-message">
      <span className="mcp-pg-prompt-role">{message.role}</span>
      {content.type === "text" ? (
        <pre className="mcp-pg-block is-text">{content.text}</pre>
      ) : content.type === "image" && typeof content.data === "string" && content.mimeType?.startsWith("image/") ? (
        <img className="mcp-pg-block is-image" src={`data:${content.mimeType};base64,${content.data}`} alt="Prompt image" />
      ) : content.type === "resource" ? (
        <pre className="mcp-pg-block is-text">{"text" in content.resource ? content.resource.text : `[${content.resource.mimeType ?? "binary"} resource ${content.resource.uri}]`}</pre>
      ) : (
        <pre className="mcp-pg-block">{pretty(content)}</pre>
      )}
    </div>
  );
}

function PromptsPanel({ server, projectId }: CatalogPanelProps) {
  const [prompts, setPrompts] = useState<McpCatalogPrompt[]>([]);
  const [supported, setSupported] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [getError, setGetError] = useState<string | null>(null);
  const [result, setResult] = useState<{ prompt: McpPromptGetResult; durationMs: number } | null>(null);

  const load = useCallback(
    (refresh: boolean) => {
      let cancelled = false;
      setLoading(true);
      setLoadError(null);
      fetchMcpServerPrompts(server.id, { projectId, refresh })
        .then((response) => {
          if (cancelled) return;
          setPrompts(response.prompts);
          setSupported(Boolean(response.capabilities.prompts) || response.prompts.length > 0);
          setUpdatedAt(response.updatedAt);
          setName((current) => (current && response.prompts.some((entry) => entry.name === current) ? current : response.prompts[0]?.name ?? null));
        })
        .catch((error) => {
          if (!cancelled) setLoadError(formatError(error));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    },
    [server.id, projectId]
  );

  useEffect(() => load(false), [load]);

  const prompt = prompts.find((entry) => entry.name === name) ?? null;
  const blocked = prompt?.access && !prompt.access.allowed ? prompt.access : null;

  useEffect(() => {
    setArgs({});
    setErrors({});
    setResult(null);
    setGetError(null);
  }, [name]);

  const render = async () => {
    if (!prompt) return;
    const missing: Record<string, string> = {};
    for (const argument of prompt.arguments ?? []) {
      if (argument.required && !(args[argument.name] ?? "").trim()) missing[argument.name] = "Required";
    }
    setErrors(missing);
    if (Object.keys(missing).length > 0) return;
    setBusy(true);
    setGetError(null);
    try {
      const filled = Object.fromEntries(Object.entries(args).filter(([, value]) => value.trim().length > 0));
      const response = await getMcpServerPrompt(server.id, { name: prompt.name, arguments: filled, ...(projectId ? { projectId } : {}) });
      setResult({ prompt: response.prompt, durationMs: response.durationMs });
    } catch (error) {
      setGetError(formatError(error));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="kb-subtle">Loading prompts…</p>;
  if (loadError) return <div className="settings-error">{loadError}</div>;
  if (!supported || prompts.length === 0) {
    return <p className="kb-subtle">This server does not advertise prompts. Probe it on the Servers tab after it starts offering some.</p>;
  }

  return (
    <div className="mcp-pg-tools">
      <aside className="mcp-pg-toollist" aria-label="Prompts">
        {prompts.map((entry) => (
          <button key={entry.name} type="button" className={entry.name === name ? "kb-item active" : "kb-item"} onClick={() => setName(entry.name)}>
            <div className="mcp-item-head">
              <span className="kb-item-name">{entry.title ?? entry.name}</span>
              {(entry.arguments?.length ?? 0) > 0 && <code className="mcp-pg-field-type">{entry.arguments!.length} args</code>}
            </div>
            {!entry.access.allowed && <span className="mcp-blocked">Blocked for your role</span>}
          </button>
        ))}
        <button type="button" className="kb-link-btn" onClick={() => load(true)}>
          Refresh list{updatedAt ? ` (listed ${new Date(updatedAt).toLocaleTimeString()})` : ""}
        </button>
      </aside>

      {prompt && (
        <div className="mcp-pg-main">
          <header className="mcp-pg-tool-head">
            <h3>{prompt.title ?? prompt.name}</h3>
            {prompt.description && <p className="kb-subtle">{prompt.description}</p>}
            {blocked && (
              <p className="mcp-blocked" role="status">
                {blocked.message ?? "Tool policy blocks this prompt for your role in this project."}
              </p>
            )}
          </header>
          {(prompt.arguments?.length ?? 0) > 0 ? (
            <div className="mcp-pg-fields">
              {prompt.arguments!.map((argument) => (
                <div key={argument.name} className={errors[argument.name] ? "mcp-pg-field has-error" : "mcp-pg-field"}>
                  <span className="mcp-pg-field-label">
                    <label htmlFor={`mcp-pg-arg-${argument.name}`}>{argument.name}</label>
                    {argument.required ? <span className="mcp-pg-field-req" aria-label="required">*</span> : null}
                  </span>
                  {argument.description && <small className="kb-subtle">{argument.description}</small>}
                  <input
                    id={`mcp-pg-arg-${argument.name}`}
                    type="text"
                    value={args[argument.name] ?? ""}
                    onChange={(event) => setArgs((current) => ({ ...current, [argument.name]: event.target.value }))}
                    disabled={busy}
                  />
                  {errors[argument.name] && (
                    <small className="mcp-pg-field-error" role="alert">
                      {errors[argument.name]}
                    </small>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="kb-subtle">This prompt takes no arguments.</p>
          )}
          <div className="mcp-form-actions">
            <button type="button" className="pg-btn primary" onClick={() => void render()} disabled={busy || Boolean(blocked)}>
              {busy ? "Rendering…" : "Preview prompt"}
            </button>
          </div>
          {getError && (
            <div className="settings-error" role="alert">
              {getError}
            </div>
          )}
          {result && (
            <section className="mcp-pg-result" aria-label="Rendered prompt">
              <div className="mcp-pg-result-head">
                <span className="mcp-status mcp-status-healthy">
                  <span className="mcp-status-dot" aria-hidden="true" />
                  {result.prompt.messages.length} message{result.prompt.messages.length === 1 ? "" : "s"}
                </span>
                <span className="kb-subtle">{result.durationMs} ms</span>
              </div>
              {result.prompt.description && <p className="kb-subtle">{result.prompt.description}</p>}
              {result.prompt.messages.map((message, index) => (
                <PromptMessageView key={index} message={message} />
              ))}
              <p className="kb-subtle">
                Use this prompt as the system or user message of an LLM or agent node: pick the server and prompt in the node's
                inspector.
              </p>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** Capability panels; each server shows the panels for what it supports. */
const PLAYGROUND_PANELS = [
  { id: "tools" as const, label: "Tools", Component: ToolsPanel },
  { id: "resources" as const, label: "Resources", Component: ResourcesPanel },
  { id: "prompts" as const, label: "Prompts", Component: PromptsPanel }
];

interface McpPlaygroundPageProps {
  servers: McpRegisteredServer[];
  activeProjectId?: string | null;
  userId?: string;
}

export function McpPlaygroundPage({ servers, activeProjectId, userId }: McpPlaygroundPageProps) {
  const [serverId, setServerId] = useState<string | null>(servers[0]?.id ?? null);
  const [panelId, setPanelId] = useState<(typeof PLAYGROUND_PANELS)[number]["id"]>("tools");

  useEffect(() => {
    setServerId((current) => (current && servers.some((server) => server.id === current) ? current : servers[0]?.id ?? null));
  }, [servers]);

  const server = servers.find((entry) => entry.id === serverId) ?? null;
  const panel = PLAYGROUND_PANELS.find((entry) => entry.id === panelId) ?? PLAYGROUND_PANELS[0]!;

  if (servers.length === 0) {
    return <p className="kb-subtle">No servers registered yet. Register or import one on the Servers tab.</p>;
  }

  return (
    <section className="mcp-pg" aria-label="MCP playground">
      <div className="mcp-pg-bar">
        <label className="mcp-pg-server">
          <span>Server</span>
          <select value={serverId ?? ""} onChange={(event) => setServerId(event.target.value)}>
            {servers.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} · {entry.toolCount} tools
              </option>
            ))}
          </select>
        </label>
        {PLAYGROUND_PANELS.length > 1 && (
          <div className="finops-range" role="tablist" aria-label="Playground panel">
            {PLAYGROUND_PANELS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={entry.id === panelId}
                className={entry.id === panelId ? "finops-range-btn active" : "finops-range-btn"}
                onClick={() => setPanelId(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        )}
        <span className="kb-subtle mcp-pg-note">
          Calls and reads run on the server with its stored credentials, under your role's tool policy, and tool calls count in
          the server's telemetry.
        </span>
      </div>
      {server && <panel.Component key={server.id} server={server} projectId={activeProjectId} userId={userId} />}
    </section>
  );
}
