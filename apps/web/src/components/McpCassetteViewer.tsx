import { useEffect, useMemo, useState } from "react";
import { deleteMcpCassette, fetchMcpCassette, mcpCassetteExportUrl, type McpCassetteEntry, type McpCassetteRecord, type McpReplayMode } from "../lib/api";

/**
 * Phase 10.8 — what a recorded run's cassette holds: every MCP call in the
 * order it happened, with its arguments and result. Values are scrubbed of
 * secrets before they are stored, so nothing here needs hiding.
 */
export interface McpCassetteViewerProps {
  cassetteId: string;
  onClose: () => void;
  /** Replays the execution the cassette was recorded from; omitted when it cannot be replayed. */
  onReplay?: (mode: McpReplayMode) => void;
  /** Admins only. */
  canDelete?: boolean;
  onDeleted?: () => void;
}

const METHOD_LABELS: Record<string, string> = {
  "server/describe": "initialize",
  "tools/list": "tools/list",
  "tools/call": "tools/call",
  "resources/list": "resources/list",
  "resources/templates/list": "resources/templates/list",
  "resources/read": "resources/read",
  "prompts/list": "prompts/list",
  "prompts/get": "prompts/get"
};

function pretty(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function resultFailed(entry: McpCassetteEntry): boolean {
  if (entry.error) return true;
  const result = entry.result as { ok?: unknown } | undefined;
  return Boolean(result && typeof result === "object" && result.ok === false);
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function McpCassetteViewer({ cassetteId, onClose, onReplay, canDelete = false, onDeleted }: McpCassetteViewerProps) {
  const [record, setRecord] = useState<McpCassetteRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const [showLists, setShowLists] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRecord(null);
    setError(null);
    fetchMcpCassette(cassetteId)
      .then((response) => {
        if (!cancelled) setRecord(response.cassette);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the cassette");
      });
    return () => {
      cancelled = true;
    };
  }, [cassetteId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const serverLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const server of record?.cassette.servers ?? []) {
      labels.set(server.key, server.label ?? server.registryServerId ?? server.adapterId);
    }
    return labels;
  }, [record]);

  const entries = useMemo(() => {
    const all = record?.cassette.entries ?? [];
    return showLists ? all : all.filter((entry) => entry.method !== "tools/list" && entry.method !== "server/describe");
  }, [record, showLists]);
  const hiddenCount = (record?.cassette.entries.length ?? 0) - entries.length;
  const discoveryCount = (record?.cassette.entries ?? []).filter(
    (entry) => entry.method === "tools/list" || entry.method === "server/describe"
  ).length;

  const remove = async () => {
    if (!record || !window.confirm("Delete this cassette? Its run can no longer be replayed.")) return;
    setDeleting(true);
    try {
      await deleteMcpCassette(record.id);
      onDeleted?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the cassette");
      setDeleting(false);
    }
  };

  return (
    <div className="pg-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="pg-modal mcp-cassette-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-cassette-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="pg-modal-header">
          <div>
            <h3 id="mcp-cassette-title" className="pg-modal-title">
              MCP cassette
            </h3>
            {record && (
              <p className="mcp-cassette-meta">
                <span className="mono-cell">{record.id}</span>
                <span>
                  {record.callCount} call{record.callCount === 1 ? "" : "s"} · {record.cassette.servers.length} server
                  {record.cassette.servers.length === 1 ? "" : "s"} · {formatBytes(record.bytes)}
                </span>
                <span>{new Date(record.createdAt).toLocaleString()}</span>
              </p>
            )}
          </div>
          <button type="button" className="pg-btn ghost small" onClick={onClose} aria-label="Close cassette">
            Close
          </button>
        </header>
        <div className="pg-modal-body">
          {error && <div className="error-banner">{error}</div>}
          {!record && !error && <div className="page-hint">Loading cassette…</div>}
          {record && (
            <>
              <div className="mcp-cassette-notes">
                {record.truncated && (
                  <p className="mcp-cassette-note is-warn" role="status">
                    Truncated: the run made more MCP calls than the cassette limit. A strict replay fails at the first call that was not kept.
                  </p>
                )}
                <p className="mcp-cassette-note">
                  Model calls are not recorded. A replay calls the model again, and answers only MCP calls from the cassette.
                </p>
              </div>

              <div className="mcp-cassette-toolbar">
                {onReplay && (
                  <>
                    <button type="button" className="pg-btn small primary" onClick={() => onReplay("strict")}>
                      Replay
                    </button>
                    <button
                      type="button"
                      className="pg-btn small"
                      onClick={() => onReplay("lenient")}
                      title="Calls the cassette does not hold go to the live server instead of failing the run"
                    >
                      Replay, live fallback
                    </button>
                  </>
                )}
                <a className="pg-btn small ghost" href={mcpCassetteExportUrl(record.id)} download={`${record.id}.json`}>
                  Download
                </a>
                {canDelete && (
                  <button type="button" className="pg-btn small ghost danger" onClick={() => void remove()} disabled={deleting}>
                    Delete
                  </button>
                )}
                {discoveryCount > 0 && (
                  <label className="mcp-cassette-lists">
                    <input type="checkbox" checked={showLists} onChange={(event) => setShowLists(event.target.checked)} />
                    Show discovery calls ({discoveryCount})
                  </label>
                )}
              </div>

              {entries.length === 0 ? (
                <div className="page-empty">No calls{hiddenCount > 0 ? " besides discovery" : ""}.</div>
              ) : (
                <ol className="mcp-cassette-entries" aria-label="Recorded MCP calls">
                  {entries.map((entry) => {
                    const open = openSeq === entry.seq;
                    const failed = resultFailed(entry);
                    return (
                      <li key={entry.seq} className={["mcp-cassette-entry", failed && "is-error"].filter(Boolean).join(" ")}>
                        <button
                          type="button"
                          className="mcp-cassette-entry-head"
                          aria-expanded={open}
                          onClick={() => setOpenSeq(open ? null : entry.seq)}
                        >
                          <span className="mono-cell">#{entry.seq}</span>
                          <span className="mcp-cassette-method">{METHOD_LABELS[entry.method] ?? entry.method}</span>
                          <span className="mcp-cassette-name">{entry.name ?? ""}</span>
                          <span className="mcp-cassette-server">{serverLabels.get(entry.server) ?? entry.server}</span>
                          {entry.exchanges && entry.exchanges.length > 0 && (
                            <span className="mcp-cassette-tag" title="Server requests answered during this call">
                              {entry.exchanges.map((exchange) => exchange.kind).join(", ")}
                            </span>
                          )}
                          {failed && <span className="mcp-cassette-tag is-error">error</span>}
                          <span className="mono-cell num">{formatDuration(entry.durationMs)}</span>
                        </button>
                        {open && (
                          <div className="mcp-cassette-entry-body">
                            {entry.args !== undefined && (
                              <div>
                                <span className="pg-eyebrow">Arguments</span>
                                <pre className="result-block">{pretty(entry.args)}</pre>
                              </div>
                            )}
                            {entry.error ? (
                              <div>
                                <span className="pg-eyebrow">Error</span>
                                <pre className="result-block">{entry.error}</pre>
                              </div>
                            ) : (
                              <div>
                                <span className="pg-eyebrow">Result</span>
                                <pre className="result-block">{pretty(entry.result)}</pre>
                              </div>
                            )}
                            {entry.exchanges?.map((exchange, index) => (
                              <div key={index}>
                                <span className="pg-eyebrow">
                                  {exchange.kind === "sampling" ? "Sampling request" : "Elicitation"} · not re-issued on replay
                                </span>
                                <pre className="result-block">{pretty({ request: exchange.request, response: exchange.response ?? exchange.error })}</pre>
                              </div>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
