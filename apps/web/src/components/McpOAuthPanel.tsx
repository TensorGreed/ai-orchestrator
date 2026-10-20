/**
 * Phase 10.5 — OAuth 2.1 connection of a registry server. Admins connect the
 * server in a popup (authorization code flow with PKCE run by the API),
 * refresh the token and disconnect; everyone else sees the status only. The
 * tokens themselves never reach the browser.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { McpOAuthConnectionStatus } from "@ai-orchestrator/shared";
import {
  ApiError,
  connectMcpServerOAuth,
  disconnectMcpServerOAuth,
  fetchMcpServerOAuth,
  refreshMcpServerOAuth
} from "../lib/api";

const POPUP_FEATURES = "popup=yes,width=560,height=720";
const POPUP_POLL_MS = 800;

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function stateLabel(status: McpOAuthConnectionStatus): string {
  switch (status.state) {
    case "connected":
      return status.subject ? `Connected as ${status.subject}` : "Connected";
    case "expired":
      return "Token expired";
    case "error":
      return "Connection error";
    default:
      return "Not connected";
  }
}

/** True when a server's connection asks for OAuth. */
export function usesOAuth(adapterId: string, connection: Record<string, unknown> | null | undefined): boolean {
  return adapterId === "http_mcp" && String(connection?.authType ?? "").toLowerCase() === "oauth";
}

export function McpOAuthPanel({ serverId, isAdmin }: { serverId: string; isAdmin: boolean }) {
  const [status, setStatus] = useState<McpOAuthConnectionStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchMcpServerOAuth(serverId);
      setStatus(result.status);
    } catch (err) {
      setError(formatError(err));
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; serverId?: unknown; ok?: unknown; error?: unknown } | null;
      if (!data || data.type !== "l2m:mcp-oauth" || data.serverId !== serverId) return;
      stopPolling();
      setBusy(null);
      if (data.ok !== true) {
        setError(typeof data.error === "string" && data.error ? data.error : "Authorization did not complete.");
      } else {
        setError(null);
      }
      void load();
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      stopPolling();
    };
  }, [serverId, load, stopPolling]);

  const connect = async () => {
    setBusy("connect");
    setError(null);
    try {
      const result = await connectMcpServerOAuth(serverId);
      const popup = window.open(result.authorizationUrl, `l2m-mcp-oauth-${serverId}`, POPUP_FEATURES);
      if (!popup) {
        setBusy(null);
        setError("The browser blocked the sign-in window. Allow popups for this site and try again.");
        return;
      }
      stopPolling();
      pollRef.current = window.setInterval(() => {
        if (popup.closed) {
          stopPolling();
          setBusy(null);
          void load();
        }
      }, POPUP_POLL_MS);
    } catch (err) {
      setBusy(null);
      setError(formatError(err));
    }
  };

  const refresh = async () => {
    setBusy("refresh");
    setError(null);
    try {
      const result = await refreshMcpServerOAuth(serverId);
      setStatus(result.status);
    } catch (err) {
      setError(formatError(err));
      void load();
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect this server? Runs and probes that use it fail until it is connected again.")) return;
    setBusy("disconnect");
    setError(null);
    try {
      const result = await disconnectMcpServerOAuth(serverId);
      setStatus(result.status);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  const copyRedirect = async () => {
    if (!status?.redirectUri) return;
    try {
      await navigator.clipboard.writeText(status.redirectUri);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const connected = status?.state === "connected";

  return (
    <section className="mcp-oauth" aria-label="OAuth connection">
      <div className="mcp-oauth-head">
        <div>
          <h4>OAuth 2.1</h4>
          {status && <span className={`mcp-oauth-state is-${status.state.replace("_", "-")}`}>{stateLabel(status)}</span>}
        </div>
        {isAdmin && (
          <div className="page-actions">
            <button type="button" className="pg-btn primary" onClick={() => void connect()} disabled={busy !== null}>
              {busy === "connect" ? "Waiting for sign-in…" : connected ? "Reconnect" : "Connect"}
            </button>
            {status?.hasRefreshToken && (
              <button type="button" className="pg-btn" onClick={() => void refresh()} disabled={busy !== null}>
                {busy === "refresh" ? "Refreshing…" : "Refresh token"}
              </button>
            )}
            {status && status.state !== "not_connected" && (
              <button type="button" className="pg-btn ghost danger" onClick={() => void disconnect()} disabled={busy !== null}>
                Disconnect
              </button>
            )}
          </div>
        )}
      </div>

      {error && <div className="settings-error">{error}</div>}
      {status?.lastError && status.state === "error" && <div className="settings-error">{status.lastError}</div>}

      {status && (
        <dl className="mcp-oauth-facts">
          <dt>Expires</dt>
          <dd>{formatDate(status.expiresAt)}</dd>
          <dt>Last refresh</dt>
          <dd>{formatDate(status.lastRefreshAt)}</dd>
          <dt>Authorization server</dt>
          <dd>{status.authorizationServer ?? "—"}</dd>
          <dt>Client</dt>
          <dd>
            {status.clientRegistration === "dynamic"
              ? "Registered automatically"
              : status.clientRegistration === "pre_registered"
                ? "Pre-registered client id"
                : "—"}
            {status.clientId ? (
              <>
                {" "}
                · <code>{status.clientId}</code>
              </>
            ) : null}
          </dd>
          <dt>Scope</dt>
          <dd>{status.scope ?? "—"}</dd>
          {status.connectedAt && (
            <>
              <dt>Connected</dt>
              <dd>
                {formatDate(status.connectedAt)}
                {status.connectedBy ? ` by ${status.connectedBy}` : ""}
              </dd>
            </>
          )}
          <dt>Redirect URL</dt>
          <dd className="mcp-oauth-redirect">
            <code>{status.redirectUri}</code>
            <button type="button" className="pg-btn ghost" onClick={() => void copyRedirect()}>
              {copied ? "Copied" : "Copy"}
            </button>
          </dd>
        </dl>
      )}
      {!isAdmin && status && !connected && <p className="kb-subtle">Ask an admin to connect this server.</p>}
    </section>
  );
}
