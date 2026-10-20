/**
 * Phase 10.6 — status of the deployment-local MCP catalog (MCP_CATALOG_FILE):
 * which file, merge or exclusive, whether enforcement is on, and validation
 * errors so an operator sees a broken file without reading server logs.
 */

import { useCallback, useEffect, useState } from "react";
import type { McpCatalogStatus } from "@ai-orchestrator/shared";
import { ApiError, fetchMcpCatalog, reloadMcpCatalog } from "../lib/api";

export function McpCatalogBanner({ isAdmin }: { isAdmin: boolean }) {
  const [status, setStatus] = useState<McpCatalogStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMcpCatalog()
      .then((response) => {
        if (!cancelled) setStatus(response.status);
      })
      .catch(() => {
        // Viewers cannot read the catalog status; the banner stays hidden.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reload = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus((await reloadMcpCatalog()).status);
    } catch (reloadError) {
      setError(reloadError instanceof ApiError || reloadError instanceof Error ? reloadError.message : "Reload failed");
    } finally {
      setBusy(false);
    }
  }, []);

  if (!status || !status.configured) return null;
  const problem = status.state === "error" || status.state === "partial";

  return (
    <section className={problem ? "mcp-catalog is-problem" : "mcp-catalog"} aria-label="MCP catalog">
      <div className="mcp-catalog-head">
        <span>
          <strong>Catalog</strong> <code>{status.fileName}</code> · {status.approvedCount} approved of {status.entryCount} ·{" "}
          {status.mode === "exclusive" ? "catalog only" : "merged with built-in presets"}
          {status.enforce && <span className="mcp-flag">Enforced for stdio servers</span>}
        </span>
        {isAdmin && (
          <button type="button" className="pg-btn ghost small" onClick={() => void reload()} disabled={busy}>
            {busy ? "Reloading…" : "Reload"}
          </button>
        )}
      </div>
      {status.state === "error" && (
        <p className="mcp-catalog-msg">
          The catalog file could not be used{status.loadedAt ? "; the last good version stays in use" : ""}.
        </p>
      )}
      {status.errors.length > 0 && (
        <ul className="mcp-catalog-errors">
          {status.errors.slice(0, 8).map((issue, index) => (
            <li key={index}>
              {issue.index !== null && <code>servers[{issue.index}]{issue.entryId ? ` (${issue.entryId})` : ""}</code>}{" "}
              {issue.path && <code>{issue.path}</code>} {issue.message}
            </li>
          ))}
          {status.errors.length > 8 && <li>…and {status.errors.length - 8} more</li>}
        </ul>
      )}
      {error && <p className="mcp-blocked">{error}</p>}
    </section>
  );
}
