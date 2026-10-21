/**
 * Phase 10.3 — MCP changes feed: schema snapshots and diffs (breaking ones
 * first-class), breaking-change acceptances, status transitions, policy and
 * classification edits, toolset and client events, OAuth, sampling settings
 * and the resource/prompt lists, newest first. Filters by server and kind;
 * each entry links to the page that owns it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  fetchMcpChanges,
  fetchMcpServers,
  type McpChangeItem,
  type McpChangeKind,
  type McpRegisteredServer
} from "../lib/api";
import {
  MCP_CHANGE_KINDS,
  MCP_CHANGE_KIND_LABEL,
  changeLinkLabel,
  changeLinkTarget,
  changeSeverityLabel,
  type McpNavTarget
} from "../lib/mcp-control-plane";
import { ChangeList } from "./McpServersPage";

const PAGE_SIZE = 200;

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

function dayOf(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : date.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

export interface McpChangesPageProps {
  isAdmin: boolean;
  activeProjectId?: string | null;
  /** Narrows the feed to one server when the page opens. */
  initialServerId?: string | null;
  onNavigate: (target: McpNavTarget) => void;
}

export function McpChangesPage({ isAdmin, activeProjectId, initialServerId, onNavigate }: McpChangesPageProps) {
  const [servers, setServers] = useState<McpRegisteredServer[]>([]);
  const [serverId, setServerId] = useState(initialServerId ?? "");
  const [kinds, setKinds] = useState<McpChangeKind[]>([]);
  const [breakingOnly, setBreakingOnly] = useState(false);
  const [items, setItems] = useState<McpChangeItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMcpServers(activeProjectId ?? undefined)
      .then((result) => setServers(result.servers))
      .catch(() => {
        // The server filter only lists names; the feed still loads without it.
      });
  }, [activeProjectId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchMcpChanges({ serverId: serverId || null, kinds, limit: PAGE_SIZE });
      setItems(result.items);
      setTotal(result.total);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [serverId, kinds]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const shown = useMemo(() => (breakingOnly ? items.filter((item) => item.severity === "breaking") : items), [items, breakingOnly]);
  const groups = useMemo(() => {
    const byDay: Array<{ day: string; items: McpChangeItem[] }> = [];
    for (const item of shown) {
      const day = dayOf(item.at);
      const last = byDay[byDay.length - 1];
      if (last && last.day === day) last.items.push(item);
      else byDay.push({ day, items: [item] });
    }
    return byDay;
  }, [shown]);

  const toggleKind = (kind: McpChangeKind) =>
    setKinds((current) => (current.includes(kind) ? current.filter((entry) => entry !== kind) : [...current, kind]));

  return (
    <section className="mcp-page mcp-changes-page page-pane" aria-busy={loading}>
      <header className="page-head">
        <div className="page-head-copy">
          <h2 className="page-title">MCP changes</h2>
          <p className="page-sub">
            What changed across the MCP fleet, newest first: tool schemas, status, policy, toolsets, clients, OAuth and sampling.
            {isAdmin ? " You see who made each change." : " Who made each change is visible to admins in the audit log."}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="pg-btn" onClick={() => void refresh()} disabled={loading}>
            Refresh
          </button>
        </div>
      </header>

      {error && <div className="settings-error">{error}</div>}

      <div className="mcp-tool-filters" role="group" aria-label="Filter changes">
        <select aria-label="Server" value={serverId} onChange={(event) => setServerId(event.target.value)}>
          <option value="">All servers</option>
          {servers.map((server) => (
            <option key={server.id} value={server.id}>
              {server.name}
            </option>
          ))}
        </select>
        <div className="mcp-tool-flags" role="group" aria-label="Kinds">
          <button
            type="button"
            className={breakingOnly ? "mcp-flag-toggle is-on" : "mcp-flag-toggle"}
            aria-pressed={breakingOnly}
            onClick={() => setBreakingOnly((value) => !value)}
          >
            Breaking only
          </button>
          {MCP_CHANGE_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={kinds.includes(kind) ? "mcp-flag-toggle is-on" : "mcp-flag-toggle"}
              aria-pressed={kinds.includes(kind)}
              onClick={() => toggleKind(kind)}
            >
              {MCP_CHANGE_KIND_LABEL[kind]}
            </button>
          ))}
          {(kinds.length > 0 || serverId || breakingOnly) && (
            <button
              type="button"
              className="kb-link-btn"
              onClick={() => {
                setKinds([]);
                setServerId("");
                setBreakingOnly(false);
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      <p className="kb-subtle" aria-live="polite">
        {loading && items.length === 0
          ? "Loading…"
          : `${shown.length} change${shown.length === 1 ? "" : "s"}${total > items.length ? ` (newest ${items.length} of ${total})` : ""}`}
      </p>

      {!loading && shown.length === 0 ? (
        <div className="page-empty compact">No changes match these filters.</div>
      ) : (
        <div className="mcp-feed">
          {groups.map((group) => (
            <section key={group.day} className="mcp-feed-day" aria-label={group.day}>
              <h3 className="mcp-feed-day-title">{group.day}</h3>
              <ol className="mcp-feed-list">
                {group.items.map((item) => (
                  <FeedEntry key={item.id} item={item} onNavigate={onNavigate} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function FeedEntry({ item, onNavigate }: { item: McpChangeItem; onNavigate: (target: McpNavTarget) => void }) {
  const [open, setOpen] = useState(item.severity === "breaking" && item.detail === "Waiting for review");
  const target = changeLinkTarget(item.link);
  const linkLabel = changeLinkLabel(item.link);
  const hasChanges = Boolean(item.changes && item.changes.length > 0);
  return (
    <li className={`mcp-feed-item is-${item.severity}`}>
      <div className="mcp-feed-head">
        <span className={`mcp-sev mcp-sev-${item.severity}`}>{changeSeverityLabel(item)}</span>
        <span className="mcp-feed-kind">{MCP_CHANGE_KIND_LABEL[item.kind]}</span>
        <time className="kb-subtle" dateTime={item.at}>
          {new Date(item.at).toLocaleTimeString()}
        </time>
      </div>
      <p className="mcp-feed-title">{item.title}</p>
      {(item.detail || item.actor) && (
        <p className="kb-subtle mcp-feed-detail">
          {item.detail}
          {item.detail && item.actor ? " · " : ""}
          {item.actor ? `by ${item.actor}` : ""}
        </p>
      )}
      <div className="mcp-feed-actions">
        {hasChanges && (
          <button type="button" className="kb-link-btn" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? "Hide diff" : `Show diff (${item.changes!.length})`}
          </button>
        )}
        {target && linkLabel && (
          <button type="button" className="kb-link-btn" onClick={() => onNavigate(target)}>
            {linkLabel}
          </button>
        )}
      </div>
      {open && hasChanges && <ChangeList changes={item.changes!} />}
    </li>
  );
}
