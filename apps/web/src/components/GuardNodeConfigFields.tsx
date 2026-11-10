/**
 * Phase 12.1 — config fields for the Guard node and the Protection Provider
 * node. Kept out of NodeConfigModal so the modal only routes to them.
 * Protection keys are picked from the secret store; the config only holds
 * `keySecretRef.secretId`, never a key.
 */

import { useEffect, useState } from "react";
import type { GuardProfileSummary, GuardResolutionView } from "@ai-orchestrator/shared";
import { fetchGuardProfiles, fetchGuardWorkflowBinding, type SecretListItem } from "../lib/api";
import { GUARD_EDITOR_CHANNELS } from "../lib/guard-profile-edit";
import { channelLabel } from "../lib/guard-trace";

type Config = Record<string, unknown>;
type SetConfig = (update: (current: Config) => Config) => void;

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

const LABELS = ["trusted", "user", "untrusted_external", "sensitive"] as const;

/**
 * `unavailable`: a provider the shared enum knows (stored configs validate)
 * that cannot run yet. It is not offered in the picker; a node that already
 * uses it shows it with the `unavailable` text.
 */
export const PROTECTION_PROVIDERS: Array<{ value: string; label: string; needsKey: boolean; help: string; oneWay?: boolean; unavailable?: string }> = [
  { value: "mask", label: "Mask", needsKey: false, help: "Replaces all but the last characters. Not reversible." },
  { value: "keyed_hash", label: "Keyed hash (HMAC-SHA256)", needsKey: true, help: "Same input gives the same token, so joins still work. Not reversible." },
  { value: "aes_gcm", label: "Encrypt (AES-256-GCM)", needsKey: true, help: "Reversible with the key; every call gives a new ciphertext." },
  { value: "token_vault", label: "Token vault", needsKey: false, help: "Swaps the value for a token; the value is kept encrypted in the L2M database. Deterministic tokens need a key." },
  {
    value: "surrogate",
    label: "Surrogate (one-way)",
    needsKey: false,
    oneWay: true,
    help: "Swaps each value for a realistic stand-in of the same shape (an email stays an email), keyed by the deployment. One-way: the original can never be revealed; use the token vault if you need it back. Credentials and keys are still fully redacted. Later checks in the same run recognise the stand-ins, so destination rules do not stop them."
  }
];

export function GuardNodeFields({ config, setConfig, workflowId, attachedAsPort }: { config: Config; setConfig: SetConfig; workflowId?: string; attachedAsPort: boolean }) {
  const [profiles, setProfiles] = useState<GuardProfileSummary[]>([]);
  const [effective, setEffective] = useState<GuardResolutionView | null>(null);
  const [overrideText, setOverrideText] = useState(() => (config.profileOverride ? JSON.stringify(config.profileOverride, null, 2) : ""));
  const [overrideError, setOverrideError] = useState<string | null>(null);

  useEffect(() => {
    fetchGuardProfiles()
      .then((response) => setProfiles(response.profiles))
      .catch(() => setProfiles([]));
  }, []);

  useEffect(() => {
    if (!workflowId) return;
    fetchGuardWorkflowBinding(workflowId)
      .then((response) => setEffective(response.effective))
      .catch(() => setEffective(null));
  }, [workflowId]);

  const profileId = str(config.profileId, "effective");
  const labels = Array.isArray(config.labels) ? config.labels.map(String) : [];

  return (
    <>
      {attachedAsPort && (
        <div className="cfg-tip">
          Attached to an agent&apos;s content rules port: this rule set checks the agent&apos;s prompt, tool arguments, tool results, model output and final answer (and its workers&apos;). Channel and input field apply only when the node runs as a workflow step.
        </div>
      )}
      <div className="cfg-field">
        <label className="cfg-label" htmlFor="guard-profile-select">
          Rule set
        </label>
        <select id="guard-profile-select" className="cfg-input" value={profileId} onChange={(event) => setConfig((current) => ({ ...current, profileId: event.target.value }))}>
          <option value="effective">Effective rule set (workflow / project binding)</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} · v{profile.latestVersion}
            </option>
          ))}
          {profileId !== "effective" && !profiles.some((profile) => profile.id === profileId) && <option value={profileId}>{profileId}</option>}
        </select>
        {effective && (
          <div className="cfg-help guard-effective" data-testid="guard-effective">
            Effective here:{" "}
            {effective.stack.length === 0
              ? "no automatic rule set"
              : effective.stack.map((ref) => `${ref.name ?? ref.profileId} v${ref.version}`).join(" then ")}
            {effective.enforced ? " (first one enforced by an admin; it always runs)" : ""}
          </div>
        )}
      </div>
      {!attachedAsPort && (
        <>
          <div className="cfg-field">
            <label className="cfg-label" htmlFor="guard-channel-select">
              Channel
            </label>
            <select id="guard-channel-select" className="cfg-input" value={str(config.channel, "prompt")} onChange={(event) => setConfig((current) => ({ ...current, channel: event.target.value }))}>
              {GUARD_EDITOR_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {channelLabel(channel)}
                </option>
              ))}
            </select>
          </div>
          <div className="cfg-field">
            <label className="cfg-label" htmlFor="guard-input-field">
              Input field
            </label>
            <input
              id="guard-input-field"
              className="cfg-input"
              value={str(config.inputField)}
              placeholder="user_prompt"
              onChange={(event) => setConfig((current) => ({ ...current, inputField: event.target.value }))}
            />
            <div className="cfg-help">The field of the incoming item to check. Empty checks the whole item.</div>
          </div>
          <fieldset className="cfg-field">
            <legend className="cfg-label">Trust labels</legend>
            {LABELS.map((label) => (
              <label key={label} className="guard-check">
                <input
                  type="checkbox"
                  checked={labels.includes(label)}
                  onChange={(event) =>
                    setConfig((current) => {
                      const currentLabels = Array.isArray(current.labels) ? current.labels.map(String) : [];
                      const next = event.target.checked ? [...new Set([...currentLabels, label])] : currentLabels.filter((entry) => entry !== label);
                      return { ...current, labels: next };
                    })
                  }
                />
                <span>{label.replace(/_/g, " ")}</span>
              </label>
            ))}
          </fieldset>
        </>
      )}
      <div className="cfg-field">
        <label className="cfg-label" htmlFor="guard-approval-message">
          Approval message
        </label>
        <textarea
          id="guard-approval-message"
          className="cfg-input"
          rows={2}
          value={str(config.approvalMessage)}
          placeholder="A content rule needs approval before this content is used."
          onChange={(event) => setConfig((current) => ({ ...current, approvalMessage: event.target.value }))}
        />
        <div className="cfg-help">Used when a rule asks for approval. The approver sees masked evidence only.</div>
      </div>
      <div className="cfg-field">
        <label className="cfg-label" htmlFor="guard-timeout">
          Approval timeout (minutes)
        </label>
        <input
          id="guard-timeout"
          type="number"
          min={1}
          className="cfg-input"
          value={num(config.timeoutMinutes, 1440)}
          onChange={(event) => setConfig((current) => ({ ...current, timeoutMinutes: Math.max(1, Number(event.target.value) || 1) }))}
        />
      </div>
      <div className="cfg-field">
        <label className="cfg-label" htmlFor="guard-override">
          Rule set override (JSON, optional)
        </label>
        <textarea
          id="guard-override"
          className="cfg-input cfg-code"
          rows={5}
          value={overrideText}
          placeholder='{ "channels": { "prompt": { "actions": { "email": { "action": "mask" } } } } }'
          onChange={(event) => {
            const text = event.target.value;
            setOverrideText(text);
            if (!text.trim()) {
              setOverrideError(null);
              setConfig((current) => {
                const next = { ...current };
                delete next.profileOverride;
                return next;
              });
              return;
            }
            try {
              const parsed = JSON.parse(text) as unknown;
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Must be a JSON object");
              setOverrideError(null);
              setConfig((current) => ({ ...current, profileOverride: parsed }));
            } catch (err) {
              setOverrideError(err instanceof Error ? err.message : "Not valid JSON");
            }
          }}
        />
        {overrideError ? <div className="cfg-error">{overrideError}</div> : <div className="cfg-help">Merged over the chosen rule set for this node only. An enforced project rule set still runs first.</div>}
      </div>
    </>
  );
}

export function GuardProtectionFields({ config, setConfig, secrets }: { config: Config; setConfig: SetConfig; secrets: SecretListItem[] }) {
  const providerId = str(config.providerId, "token_vault");
  const provider = PROTECTION_PROVIDERS.find((entry) => entry.value === providerId) ?? PROTECTION_PROVIDERS.find((entry) => entry.value === "token_vault")!;
  const keySecretId = str((config.keySecretRef as { secretId?: unknown } | undefined)?.secretId);
  const dataClasses = config.dataClasses === "*" ? ["*"] : Array.isArray(config.dataClasses) ? config.dataClasses.map(String) : [];
  const [classText, setClassText] = useState(dataClasses.join(", "));

  return (
    <>
      <div className="cfg-field">
        <label className="cfg-label" htmlFor="guard-protect-provider">
          Provider
        </label>
        <select id="guard-protect-provider" className="cfg-input" value={providerId} onChange={(event) => setConfig((current) => ({ ...current, providerId: event.target.value }))}>
          {PROTECTION_PROVIDERS.filter((entry) => !entry.unavailable || entry.value === providerId).map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
        {provider.unavailable ? (
          <div className="cfg-help cfg-help-warn" role="status">
            {provider.unavailable}
          </div>
        ) : (
          <div className="cfg-help">
            {provider.oneWay && <span className="guard-chip guard-chip-warn">One-way</span>} {provider.help}
          </div>
        )}
      </div>
      <div className="cfg-field">
        <label className="cfg-label" htmlFor="guard-protect-classes">
          Data classes
        </label>
        <input
          id="guard-protect-classes"
          className="cfg-input"
          value={classText}
          placeholder="email, phone, card_number"
          onChange={(event) => {
            setClassText(event.target.value);
            const next = event.target.value
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean);
            setConfig((current) => ({ ...current, dataClasses: next.includes("*") ? "*" : next }));
          }}
        />
        <div className="cfg-help">Findings of these data classes use this provider when a rule says Protect. Use * for every class.</div>
      </div>
      {(provider.needsKey || (providerId === "token_vault" && bool(config.deterministic, false))) && (
        <div className="cfg-field">
          <label className="cfg-label" htmlFor="guard-protect-key">
            Key (from Secrets)
          </label>
          <select
            id="guard-protect-key"
            className="cfg-input"
            value={keySecretId}
            onChange={(event) =>
              setConfig((current) => {
                const next = { ...current };
                if (event.target.value) next.keySecretRef = { secretId: event.target.value };
                else delete next.keySecretRef;
                return next;
              })
            }
          >
            <option value="">Choose a secret…</option>
            {secrets.map((secret) => (
              <option key={secret.id} value={secret.id}>
                {secret.name}
              </option>
            ))}
          </select>
          <div className="cfg-help">{keySecretId ? "The key is read from the secret store at run time and never stored in the workflow." : "Without a key this provider is unavailable and the rule set's fallback applies (block by default)."}</div>
        </div>
      )}
      {providerId === "token_vault" && (
        <label className="guard-check">
          <input type="checkbox" checked={bool(config.deterministic, false)} onChange={(event) => setConfig((current) => ({ ...current, deterministic: event.target.checked }))} />
          <span>Deterministic (same value, same token)</span>
        </label>
      )}
      {providerId === "token_vault" && (
        <label className="guard-check">
          <input type="checkbox" checked={bool(config.formatPreserving, false)} onChange={(event) => setConfig((current) => ({ ...current, formatPreserving: event.target.checked }))} />
          <span>Format-preserving tokens</span>
        </label>
      )}
      <label className="guard-check">
        <input type="checkbox" checked={bool(config.protectMatches, true)} onChange={(event) => setConfig((current) => ({ ...current, protectMatches: event.target.checked }))} />
        <span>Turn allow, mask and redact rules for these classes into Protect (block, review and approval rules stay)</span>
      </label>
    </>
  );
}

/**
 * Phase 12 coverage — config fields for the Reveal node: the rule set whose reveal rules apply, the field to reveal,
 * the encryption keys it may use, the classes of format-preserving tokens to look for, and what a refused token does.
 * Keys are picked from the secret store; the config holds secret ids only.
 */
export function GuardRevealFields({ config, setConfig, secrets }: { config: Config; setConfig: SetConfig; secrets: SecretListItem[] }) {
  const [profiles, setProfiles] = useState<GuardProfileSummary[]>([]);
  const profileId = str(config.profileId, "effective");
  const keyIds = Array.isArray(config.keySecretRefs)
    ? config.keySecretRefs.map((ref) => str((ref as { secretId?: unknown } | null)?.secretId)).filter(Boolean)
    : [];
  const classes = Array.isArray(config.formatPreservingClasses) ? config.formatPreservingClasses.map(String) : [];
  const [classText, setClassText] = useState(classes.join(", "));

  useEffect(() => {
    fetchGuardProfiles()
      .then((response) => setProfiles(response.profiles))
      .catch(() => setProfiles([]));
  }, []);

  return (
    <>
      <div className="cfg-tip">
        Turns protected tokens in one field back into the original values, only for the data classes the rule set&apos;s reveal rules allow whoever started
        the run. Nobody may reveal unless a rule says so. Webhook, chat and schedule runs never match role or user rules. Revealed values count as sensitive
        again, so destination rules decide where they may go. Replays never reveal.
      </div>
      <div className="cfg-field">
        <label className="cfg-label" htmlFor="guard-reveal-profile">
          Rule set
        </label>
        <select id="guard-reveal-profile" className="cfg-input" value={profileId} onChange={(event) => setConfig((current) => ({ ...current, profileId: event.target.value }))}>
          <option value="effective">Effective rule set (workflow / project binding)</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} · v{profile.latestVersion}
            </option>
          ))}
          {profileId !== "effective" && !profiles.some((profile) => profile.id === profileId) && <option value={profileId}>{profileId}</option>}
        </select>
        <div className="cfg-help">Its reveal rules decide who may reveal which data classes. Only an admin can write reveal rules.</div>
      </div>
      <div className="cfg-field">
        <label className="cfg-label" htmlFor="guard-reveal-field">
          Field to reveal
        </label>
        <input id="guard-reveal-field" className="cfg-input" value={str(config.inputField, "text")} placeholder="text" onChange={(event) => setConfig((current) => ({ ...current, inputField: event.target.value }))} />
        <div className="cfg-help">The field of the incoming item. Tokens in nested values are revealed too.</div>
      </div>
      <fieldset className="cfg-field">
        <legend className="cfg-label">Encryption keys it may use</legend>
        {secrets.length === 0 && <div className="cfg-help">No secrets yet. Token vault tokens need no key.</div>}
        {secrets.map((secret) => (
          <label key={secret.id} className="guard-check">
            <input
              type="checkbox"
              checked={keyIds.includes(secret.id)}
              onChange={(event) =>
                setConfig((current) => {
                  const next = event.target.checked ? [...new Set([...keyIds, secret.id])] : keyIds.filter((id) => id !== secret.id);
                  return { ...current, keySecretRefs: next.map((secretId) => ({ secretId })) };
                })
              }
            />
            <span>{secret.name}</span>
          </label>
        ))}
        <div className="cfg-help">Only for values protected with Encrypt (AES-256-GCM). Values encrypted under other keys stay as they are.</div>
      </fieldset>
      <div className="cfg-field">
        <label className="cfg-label" htmlFor="guard-reveal-fp">
          Format-preserving token classes
        </label>
        <input
          id="guard-reveal-fp"
          className="cfg-input"
          value={classText}
          placeholder="card_number, phone"
          onChange={(event) => {
            setClassText(event.target.value);
            const next = event.target.value
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean);
            setConfig((current) => ({ ...current, formatPreservingClasses: next }));
          }}
        />
        <div className="cfg-help">Format-preserving tokens look like real values; list their classes to look them up in the vault. Empty finds tok_ tokens only.</div>
      </div>
      <div className="cfg-field">
        <label className="cfg-label" htmlFor="guard-reveal-refused">
          When a token may not be revealed
        </label>
        <select id="guard-reveal-refused" className="cfg-input" value={str(config.onRefused, "keep")} onChange={(event) => setConfig((current) => ({ ...current, onRefused: event.target.value }))}>
          <option value="keep">Keep it protected and continue</option>
          <option value="fail">Fail the step (nothing is revealed)</option>
        </select>
      </div>
      <div className="cfg-field">
        <label className="cfg-label" htmlFor="guard-reveal-approval">
          Approval message
        </label>
        <textarea
          id="guard-reveal-approval"
          className="cfg-input"
          rows={2}
          value={str(config.approvalMessage)}
          placeholder="Approve revealing these values?"
          onChange={(event) => setConfig((current) => ({ ...current, approvalMessage: event.target.value }))}
        />
        <div className="cfg-help">Used when a reveal rule asks for approval. The approver sees data classes and counts, never values.</div>
      </div>
      <div className="cfg-field">
        <label className="cfg-label" htmlFor="guard-reveal-timeout">
          Approval timeout (minutes)
        </label>
        <input
          id="guard-reveal-timeout"
          type="number"
          min={1}
          className="cfg-input"
          value={num(config.timeoutMinutes, 1440)}
          onChange={(event) => setConfig((current) => ({ ...current, timeoutMinutes: Math.max(1, Number(event.target.value) || 1) }))}
        />
      </div>
    </>
  );
}
