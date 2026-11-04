/**
 * 13.2 — a gateway client's network settings: the addresses it may call from and the client certificate it must
 * present (SHA-256 fingerprints, several during a rotation, and an optional subject pin). Empty = any address and no
 * certificate, as before. Admins edit; others see the settings.
 */
import { useState } from "react";
import { normalizeCertFingerprint, parseIpAllowlist, splitIpAllowlist } from "@ai-orchestrator/shared";
import { ApiError, type McpClientView, updateMcpClientNetwork } from "../lib/api";

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

/** One line for the client's summary row. */
export function describeClientNetwork(client: Pick<McpClientView, "allowedIps" | "certFingerprints" | "certSubject">): string {
  const addresses = (client.allowedIps ?? []).length;
  const certificates = (client.certFingerprints ?? []).length;
  const parts = [addresses === 0 ? "any address" : `${addresses} address range${addresses === 1 ? "" : "s"}`];
  if (certificates > 0) parts.push(`certificate pinned${certificates > 1 ? ` (${certificates})` : ""}`);
  return parts.join(" · ");
}

function lines(values: readonly string[] | undefined): string {
  return (values ?? []).join("\n");
}

export function ClientNetwork({
  client,
  isAdmin,
  onSaved
}: {
  client: McpClientView;
  isAdmin: boolean;
  onSaved: (client: McpClientView) => void;
}) {
  const [allowedIps, setAllowedIps] = useState(lines(client.allowedIps));
  const [fingerprints, setFingerprints] = useState(lines(client.certFingerprints));
  const [subject, setSubject] = useState(client.certSubject ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const editable = isAdmin && client.status === "active";

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    const addressEntries = splitIpAllowlist(allowedIps);
    const { invalid } = parseIpAllowlist(addressEntries);
    if (invalid.length > 0) {
      setError(`'${invalid[0]}' is not an IP address or CIDR range`);
      return;
    }
    const fingerprintEntries = splitIpAllowlist(fingerprints);
    const badFingerprint = fingerprintEntries.find((entry) => !normalizeCertFingerprint(entry));
    if (badFingerprint) {
      setError(`'${badFingerprint}' is not a SHA-256 certificate fingerprint (64 hex digits)`);
      return;
    }
    const restricting = (client.allowedIps ?? []).length === 0 && addressEntries.length > 0;
    if (restricting && !window.confirm("Only the listed addresses will be able to use this client's token. Continue?")) return;
    setBusy(true);
    try {
      const result = await updateMcpClientNetwork(client.id, {
        allowedIps: addressEntries,
        certFingerprints: fingerprintEntries,
        certSubject: subject.trim() || null
      });
      onSaved(result.client);
      setAllowedIps(lines(result.client.allowedIps));
      setFingerprints(lines(result.client.certFingerprints));
      setSubject(result.client.certSubject ?? "");
      setSaved(true);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="mcp-client-usage mcp-form" aria-label="Client network" onSubmit={(event) => void save(event)}>
      {error && <div className="settings-error">{error}</div>}
      <p className="kb-subtle">
        Leave both lists empty to accept the token from any address with no certificate. With fingerprints listed, a call
        needs the token and one of these certificates, forwarded by the TLS proxy the deployment trusts. List the new
        fingerprint next to the old one while the client rotates, then remove the old one.
      </p>
      <label>
        Allowed addresses (one IP or CIDR range per line)
        <textarea
          aria-label="Allowed addresses"
          rows={3}
          value={allowedIps}
          onChange={(event) => setAllowedIps(event.target.value)}
          placeholder={"10.0.0.0/8\n2001:db8::/32"}
          readOnly={!editable}
        />
      </label>
      <label>
        Client certificate fingerprints (SHA-256, one per line)
        <textarea
          aria-label="Certificate fingerprints"
          rows={2}
          value={fingerprints}
          onChange={(event) => setFingerprints(event.target.value)}
          placeholder="AB:CD:…"
          readOnly={!editable}
        />
      </label>
      <label>
        Certificate subject pin (optional: the CN or an alternative name)
        <input
          type="text"
          aria-label="Certificate subject pin"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="spiffe://example.org/agent"
          readOnly={!editable}
        />
      </label>
      {editable && (
        <div className="kb-form-row mcp-form-actions">
          <button type="submit" className="pg-btn primary" disabled={busy}>
            {busy ? "Saving…" : "Save network settings"}
          </button>
          {saved && (
            <span className="kb-subtle" role="status">
              Saved
            </span>
          )}
        </div>
      )}
    </form>
  );
}
