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
import type { McpPlaygroundCallResponse } from "@ai-orchestrator/shared";
import {
  ApiError,
  callMcpPlaygroundTool,
  fetchMcpServerTools,
  type McpRegisteredServer,
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

/** Capability panels; each server shows the panels for what it supports. */
const PLAYGROUND_PANELS = [{ id: "tools" as const, label: "Tools", Component: ToolsPanel }];

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
          Calls run on the server with its stored credentials, under your role's tool policy, and count in the server's telemetry.
        </span>
      </div>
      {server && <panel.Component key={server.id} server={server} projectId={activeProjectId} userId={userId} />}
    </section>
  );
}
