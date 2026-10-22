import { useCallback, useEffect, useState } from "react";
import type { AuditSigningKeysResponse, AuditSigningKeyView } from "@ai-orchestrator/shared";
import { ApiError, fetchAuditSigningKeys, rotateAuditSigningKey } from "../lib/api";
import { CopyButton } from "./McpToolsetsView";

function downloadPem(key: AuditSigningKeyView) {
  const href = URL.createObjectURL(new Blob([key.publicKeyPem], { type: "application/x-pem-file" }));
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `l2m-audit-${key.keyId}.pub.pem`;
  anchor.click();
  URL.revokeObjectURL(href);
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "";
}

/**
 * Phase 11.1 — the deployment's audit signing keys (admins): the active
 * key's id and public key to hand to auditors, retired keys that still
 * verify older bundles, and rotation of a generated key. Only public keys
 * ever reach the browser.
 */
export function AuditSigningKeysSection() {
  const [data, setData] = useState<AuditSigningKeysResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setData(await fetchAuditSigningKeys());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rotate = async () => {
    if (!window.confirm("Rotate the audit signing key? New bundles are signed with the new key; bundles signed before stay verifiable with the retired public key.")) return;
    setRotating(true);
    setError(null);
    setNotice(null);
    try {
      const response = await rotateAuditSigningKey();
      setData(response.keys);
      setNotice(`New signing key ${response.key.keyId} is active. Share its public key with anyone who verifies bundles.`);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
    } finally {
      setRotating(false);
    }
  };

  const active = data?.keys.find((key) => key.keyId === data.activeKeyId) ?? null;
  const retired = data?.keys.filter((key) => key.keyId !== data.activeKeyId) ?? [];

  return (
    <div className="settings-section">
      <h3>Audit signing</h3>
      <p className="settings-help">
        Run manifests and audit bundles are signed with this deployment&apos;s Ed25519 key. Give the public key to auditors so they can run{" "}
        <code>l2m audit verify</code> offline. The private key never leaves the server.
      </p>
      {error && <div className="settings-error">{error}</div>}
      {notice && <div className="settings-highlight">{notice}</div>}
      {!data && !error && <div className="settings-loading">Loading signing keys…</div>}

      {active && (
        <div className="settings-card audit-key-card">
          <h4>Active key</h4>
          <dl className="audit-key-facts">
            <div>
              <dt>Key id</dt>
              <dd>
                <code className="mono-cell">{active.keyId}</code>
              </dd>
            </div>
            <div>
              <dt>Algorithm</dt>
              <dd>{active.algorithm}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{active.source === "env" ? "AUDIT_SIGNING_KEY_BASE64" : "Generated, stored encrypted"}</dd>
            </div>
            <div>
              <dt>Since</dt>
              <dd>{formatDate(active.createdAt)}</dd>
            </div>
          </dl>
          <label className="audit-key-label" htmlFor="audit-public-key">
            Public key (PEM)
          </label>
          <pre id="audit-public-key" className="audit-key-pem">
            {active.publicKeyPem.trim()}
          </pre>
          <div className="settings-actions">
            <CopyButton text={active.publicKeyPem} label="Copy PEM" ariaLabel="Copy public key" />
            <CopyButton text={active.publicKey} label="Copy base64" ariaLabel="Copy public key as base64" />
            <button type="button" className="pg-btn small" onClick={() => downloadPem(active)}>
              Download
            </button>
            {data?.canRotate ? (
              <button type="button" className="pg-btn small ghost danger" onClick={() => void rotate()} disabled={rotating}>
                {rotating ? "Rotating…" : "Rotate key"}
              </button>
            ) : (
              <span className="settings-muted">Set by AUDIT_SIGNING_KEY_BASE64: rotate by changing it and restarting.</span>
            )}
          </div>
        </div>
      )}

      {retired.length > 0 && (
        <div className="settings-card">
          <h4>Retired keys</h4>
          <p className="settings-help">Kept so bundles they signed still verify. Their private keys have been deleted.</p>
          <div className="audit-key-table-wrap">
            <table className="settings-table">
              <thead>
                <tr>
                  <th>Key id</th>
                  <th>Active from</th>
                  <th>Retired</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {retired.map((key) => (
                  <tr key={key.keyId}>
                    <td>
                      <code>{key.keyId}</code>
                    </td>
                    <td>{formatDate(key.createdAt)}</td>
                    <td>{formatDate(key.retiredAt)}</td>
                    <td className="audit-key-row-actions">
                      <CopyButton text={key.publicKeyPem} label="Copy PEM" ariaLabel={`Copy public key ${key.keyId}`} />
                      <button type="button" className="pg-btn small" onClick={() => downloadPem(key)}>
                        Download
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
