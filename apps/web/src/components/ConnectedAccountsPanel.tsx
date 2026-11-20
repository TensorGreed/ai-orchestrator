/**
 * Secrets page: connected accounts. Each provider shows whether this deployment has its own OAuth app set up (with
 * the exact redirect URL to register), a Connect button that signs in in a popup, and the accounts already connected
 * with their state, scopes and token expiry. Tokens never reach the browser.
 */
import { useCallback, useEffect, useState } from "react";
import type { ConnectedAccountProviderView } from "@ai-orchestrator/shared";
import {
  deleteConnectApp,
  disconnectConnectedAccount,
  fetchConnectProviders,
  refreshConnectedAccount,
  saveConnectApp,
  type SecretListItem
} from "../lib/api";
import { connectAccountInPopup, connectedAccountSummary, isConnectedAccount, providerLabel } from "../lib/connect-account";

interface Props {
  projectId?: string;
  secrets: SecretListItem[];
  /** Reload the secrets list after a change. */
  onChanged: () => Promise<void> | void;
}

interface AppDraft {
  providerId: string;
  scope: "project" | "instance";
  clientId: string;
  clientSecret: string;
  tenant: string;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function ConnectedAccountsPanel({ projectId, secrets, onChanged }: Props) {
  const [providers, setProviders] = useState<ConnectedAccountProviderView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AppDraft | null>(null);
  const [scopePicks, setScopePicks] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchConnectProviders(projectId);
      setProviders(result.providers);
      setLoadError(null);
    } catch (error) {
      setLoadError(errorText(error, "Could not load providers."));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const accounts = secrets.filter(isConnectedAccount);

  const run = async (key: string, action: () => Promise<string | null>) => {
    setBusy(key);
    setMessage(null);
    try {
      const text = await action();
      if (text) setMessage({ kind: "ok", text });
    } catch (error) {
      setMessage({ kind: "error", text: errorText(error, "That did not work.") });
    } finally {
      setBusy(null);
    }
  };

  const scopeSetsFor = (provider: ConnectedAccountProviderView) =>
    scopePicks[provider.id] ?? provider.scopeSets.filter((set) => set.default).map((set) => set.id);

  const connect = (provider: ConnectedAccountProviderView, reconnectSecretId?: string) =>
    run(`connect:${reconnectSecretId ?? provider.id}`, async () => {
      const result = await connectAccountInPopup({
        providerId: provider.id,
        ...(projectId ? { projectId } : {}),
        ...(provider.scopeSets.length > 0 && !reconnectSecretId ? { scopeSets: scopeSetsFor(provider) } : {}),
        ...(reconnectSecretId ? { reconnectSecretId } : {})
      });
      await onChanged();
      // The window closed without a word: the sign-in may have finished anyway, and the reloaded list shows it.
      if (result.closed) return result.error ?? `The ${provider.label} sign-in window closed.`;
      if (!result.ok) throw new Error(result.error ?? `${provider.label} was not connected.`);
      return reconnectSecretId ? `${provider.label} reconnected.` : `${provider.label} connected. Pick it in a node's credential field.`;
    });

  const openSetup = (provider: ConnectedAccountProviderView) => {
    setMessage(null);
    setDraft({
      providerId: provider.id,
      scope: provider.appScope ?? (provider.canConfigureInstance ? "instance" : "project"),
      clientId: provider.clientId ?? "",
      clientSecret: "",
      tenant: provider.tenant ?? ""
    });
  };

  const saveSetup = (provider: ConnectedAccountProviderView, current: AppDraft) =>
    run(`setup:${provider.id}`, async () => {
      await saveConnectApp(provider.id, {
        projectId: current.scope === "project" ? (projectId ?? "default") : null,
        clientId: current.clientId.trim(),
        ...(current.clientSecret ? { clientSecret: current.clientSecret } : {}),
        ...(provider.id === "microsoft" ? { tenant: current.tenant.trim() } : {})
      });
      setDraft(null);
      await load();
      return `${provider.label} app saved.`;
    });

  const removeSetup = (provider: ConnectedAccountProviderView) =>
    run(`setup:${provider.id}`, async () => {
      if (!window.confirm(`Remove the ${provider.label} app? Accounts already connected stop renewing until it is set up again.`)) return null;
      await deleteConnectApp(provider.id, provider.appScope === "project" ? (projectId ?? "default") : null);
      setDraft(null);
      await load();
      return `${provider.label} app removed.`;
    });

  const providerById = new Map((providers ?? []).map((provider) => [provider.id as string, provider]));

  return (
    <article className="secrets-card pg-card connected-accounts" aria-label="Connected accounts">
      <div className="secrets-card-header">
        <h3 className="pg-card-title">Connected accounts</h3>
        <span className="pg-count">{accounts.length}</span>
      </div>
      <p className="kb-subtle">
        Sign in to a service once; nodes use the account like any secret and L2M renews its token. Each service needs an
        OAuth app of your own, set up once.
      </p>
      {loadError && (
        <div className="cfg-tip" role="alert">
          {loadError}
        </div>
      )}
      {message && (
        <div className={message.kind === "error" ? "cfg-tip connected-message is-error" : "cfg-tip connected-message"} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </div>
      )}

      {accounts.length > 0 && (
        <div className="secret-list connected-account-list">
          {accounts.map((secret) => {
            const view = secret.connection;
            const provider = view ? providerById.get(view.providerId) : undefined;
            const needsReconnect = view?.status === "needs_reconnect";
            return (
              <div key={secret.id} className="secret-item connected-account" data-testid={`connected-account-${secret.id}`}>
                <div className="secret-item-copy">
                  <strong>{secret.name}</strong>
                  <span className="pg-pill">{view ? providerLabel(view.providerId) : "Account"}</span>
                  <span className={needsReconnect ? "data-label-chip is-sensitive" : "data-label-chip"}>{needsReconnect ? "Needs reconnect" : "Connected"}</span>
                  {view && <span className="kb-subtle connected-account-summary">{connectedAccountSummary(view)}</span>}
                  {view && view.scopes.length > 0 && (
                    <span className="kb-subtle connected-account-scopes" title={view.scopes.join(" ")}>
                      Scopes: {view.scopes.join(", ")}
                    </span>
                  )}
                </div>
                <div className="secret-item-actions">
                  {needsReconnect && provider ? (
                    <button type="button" className="pg-btn small primary" disabled={busy !== null} onClick={() => void connect(provider, secret.id)}>
                      Reconnect
                    </button>
                  ) : (
                    view?.refreshable && (
                      <button
                        type="button"
                        className="pg-btn small"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(`refresh:${secret.id}`, async () => {
                            try {
                              await refreshConnectedAccount(secret.id);
                            } finally {
                              // A refused refresh marks the account Needs reconnect; show that either way.
                              await onChanged();
                            }
                            return `${secret.name}: token renewed.`;
                          })
                        }
                      >
                        Refresh
                      </button>
                    )
                  )}
                  <button
                    type="button"
                    className="pg-btn small ghost"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`disconnect:${secret.id}`, async () => {
                        if (!window.confirm(`Disconnect ${secret.name}? Nodes that use it stop working until another account is picked.`)) return null;
                        const result = await disconnectConnectedAccount(secret.id);
                        await onChanged();
                        return result.revoked ? `${secret.name} disconnected and revoked.` : `${secret.name} disconnected.`;
                      })
                    }
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="connected-provider-list">
        {(providers ?? []).map((provider) => {
          const canSetUp = provider.canConfigureProject || provider.canConfigureInstance;
          const editing = draft?.providerId === provider.id ? draft : null;
          return (
            <div key={provider.id} className="connected-provider" data-testid={`connect-provider-${provider.id}`}>
              <div className="connected-provider-row">
                <strong>{provider.label}</strong>
                <span className="kb-subtle">
                  {provider.configured ? (provider.appScope === "project" ? "App set up for this project" : "App set up for all projects") : "No app set up yet"}
                </span>
                <div className="secret-item-actions">
                  {canSetUp && (
                    <button type="button" className="pg-btn small ghost" disabled={busy !== null} onClick={() => (editing ? setDraft(null) : openSetup(provider))}>
                      {provider.configured ? "App settings" : "Set up app"}
                    </button>
                  )}
                  {provider.configured && (
                    <button type="button" className="pg-btn small primary" disabled={busy !== null} onClick={() => void connect(provider)}>
                      Connect {provider.label}
                    </button>
                  )}
                </div>
              </div>
              {provider.configured && provider.scopeSets.length > 0 && (
                <fieldset className="connected-scope-sets">
                  <legend className="kb-subtle">Ask for</legend>
                  {provider.scopeSets.map((set) => {
                    const picked = scopeSetsFor(provider);
                    return (
                      <label key={set.id} title={set.description}>
                        <input
                          type="checkbox"
                          checked={picked.includes(set.id)}
                          onChange={(event) =>
                            setScopePicks((current) => ({
                              ...current,
                              [provider.id]: event.target.checked ? [...picked, set.id] : picked.filter((id) => id !== set.id)
                            }))
                          }
                        />{" "}
                        {set.label}
                      </label>
                    );
                  })}
                </fieldset>
              )}
              {!provider.configured && !canSetUp && <div className="kb-subtle">Ask an admin to set up the {provider.label} app.</div>}
              {editing && (
                <div className="connected-setup" aria-label={`${provider.label} app`}>
                  <ol className="connected-setup-steps">
                    {provider.setupSteps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                  <label htmlFor={`connect-redirect-${provider.id}`}>Redirect URL</label>
                  <div className="connected-redirect">
                    <input id={`connect-redirect-${provider.id}`} readOnly value={provider.redirectUrl} onFocus={(event) => event.target.select()} />
                    <button type="button" className="pg-btn small" onClick={() => void navigator.clipboard?.writeText(provider.redirectUrl)}>
                      Copy
                    </button>
                  </div>
                  <a href={provider.consoleUrl} target="_blank" rel="noreferrer noopener">
                    Open the {provider.label} developer console
                  </a>
                  {provider.canConfigureProject && provider.canConfigureInstance && (
                    <>
                      <label htmlFor={`connect-scope-${provider.id}`}>Use this app for</label>
                      <select
                        id={`connect-scope-${provider.id}`}
                        value={editing.scope}
                        onChange={(event) => setDraft({ ...editing, scope: event.target.value as AppDraft["scope"] })}
                      >
                        <option value="instance">All projects</option>
                        <option value="project">This project only</option>
                      </select>
                    </>
                  )}
                  <label htmlFor={`connect-client-id-${provider.id}`}>Client ID</label>
                  <input id={`connect-client-id-${provider.id}`} value={editing.clientId} autoComplete="off" onChange={(event) => setDraft({ ...editing, clientId: event.target.value })} />
                  <label htmlFor={`connect-client-secret-${provider.id}`}>Client secret</label>
                  <input
                    id={`connect-client-secret-${provider.id}`}
                    type="password"
                    autoComplete="off"
                    value={editing.clientSecret}
                    placeholder={provider.configured ? "Leave blank to keep the saved one" : ""}
                    onChange={(event) => setDraft({ ...editing, clientSecret: event.target.value })}
                  />
                  {provider.id === "microsoft" && (
                    <>
                      <label htmlFor={`connect-tenant-${provider.id}`}>Tenant</label>
                      <input
                        id={`connect-tenant-${provider.id}`}
                        value={editing.tenant}
                        placeholder="common"
                        onChange={(event) => setDraft({ ...editing, tenant: event.target.value })}
                      />
                    </>
                  )}
                  <div className="page-actions">
                    <button
                      type="button"
                      className="pg-btn primary"
                      disabled={busy !== null || !editing.clientId.trim() || (!provider.configured && !editing.clientSecret)}
                      onClick={() => void saveSetup(provider, editing)}
                    >
                      Save app
                    </button>
                    {provider.configured && (
                      <button type="button" className="pg-btn ghost" disabled={busy !== null} onClick={() => void removeSetup(provider)}>
                        Remove app
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </article>
  );
}
