/**
 * 13.2 — Settings > Access control > Network: the deployment's address allowlists per scope, read-only (they come
 * from NETWORK_ALLOW_* in the environment, so a wrong save here can never lock anyone out), the mode, the
 * break-glass ranges, and which lists this browser's address matches.
 */
import { useEffect, useState } from "react";
import type { NetworkScope, NetworkSettingsView } from "@ai-orchestrator/shared";
import { ApiError, fetchNetworkSettings } from "../lib/api";

const SCOPE_LABELS: Record<NetworkScope, { label: string; hint: string }> = {
  ui: { label: "Studio (UI)", hint: "Signed-in browser traffic, sign-in, SSO callbacks" },
  api: { label: "API", hint: "/api/* with a bearer token or API key" },
  webhook: { label: "Webhooks", hint: "/webhook/*, provider webhooks, workflow MCP endpoints" },
  public: { label: "Public", hint: "Forms, chat, the widget" },
  mcp_gateway: { label: "MCP gateway", hint: "/mcp/*, /v1/*" },
  metrics: { label: "Metrics", hint: "/metrics and the API docs" }
};

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

export function NetworkSettingsTab() {
  const [view, setView] = useState<NetworkSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchNetworkSettings()
      .then((result) => {
        if (!cancelled) setView(result);
      })
      .catch((err) => {
        if (!cancelled) setError(formatError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="settings-section" aria-label="Network">
      <h3>Network</h3>
      <p className="settings-muted">
        Address allowlists per scope, set with the NETWORK_ALLOW_* environment variables and shown here read-only. A scope
        without a list is open. Per-client lists live on each MCP client, per-webhook lists on the webhook trigger.
      </p>
      {error && <div className="settings-error">{error}</div>}
      {!view && !error && <div className="settings-loading">Loading…</div>}
      {view && (
        <>
          <p data-testid="network-your-ip">
            Your address is <code>{view.yourIp}</code>
            {view.matchedScopes.length > 0
              ? `, matched by: ${view.matchedScopes.map((scope) => SCOPE_LABELS[scope].label).join(", ")}`
              : view.active
                ? ", which no list names"
                : ""}
            {view.active && view.breakGlass.matched ? " (a break-glass address)" : ""}.
          </p>
          <p className="settings-muted" data-testid="network-mode">
            {view.active
              ? view.mode === "report"
                ? "Mode: report. Nothing is refused; would-be refusals are logged and audited."
                : "Mode: enforce. Requests from addresses outside a scope's list get 403."
              : "No allowlist is set: every scope is open."}
          </p>
          {view.warnings.map((warning) => (
            <div key={warning} className="settings-error" role="status">
              {warning}
            </div>
          ))}
          <table className="settings-table" aria-label="Network scopes">
            <thead>
              <tr>
                <th>Scope</th>
                <th>Setting</th>
                <th>Allowed addresses</th>
                <th>Your address</th>
              </tr>
            </thead>
            <tbody>
              {view.scopes.map((entry) => (
                <tr key={entry.scope} data-testid={`network-scope-${entry.scope}`}>
                  <td>
                    {SCOPE_LABELS[entry.scope].label}
                    <div className="settings-muted">{SCOPE_LABELS[entry.scope].hint}</div>
                  </td>
                  <td>
                    <code>{entry.env}</code>
                  </td>
                  <td>{entry.ranges.length === 0 ? <span className="settings-muted">Open</span> : entry.ranges.join(", ")}</td>
                  <td>{entry.matched === null ? "—" : entry.matched ? "Allowed" : "Not listed"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="settings-table" aria-label="Network settings">
            <tbody>
              <tr>
                <th scope="row">Break-glass (NETWORK_BREAK_GLASS_CIDRS)</th>
                <td>{view.breakGlass.ranges.length === 0 ? "None" : view.breakGlass.ranges.join(", ")}</td>
              </tr>
              <tr>
                <th scope="row">Trusted proxies (TRUST_PROXY)</th>
                <td>{view.trustProxy.summary}</td>
              </tr>
              <tr>
                <th scope="row">Forwarded client certificates</th>
                <td>
                  {view.clientCertificate.header
                    ? `Header ${view.clientCertificate.header}, from ${view.clientCertificate.proxies.join(", ")}`
                    : "Off (MCP_GATEWAY_CLIENT_CERT_HEADER unset)"}
                </td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
