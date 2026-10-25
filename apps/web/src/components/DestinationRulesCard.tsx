/**
 * Phase 16 (p3) — the deployment's destination rules, at the top of
 * Security → Data destinations.
 *
 * One click adds the starter rule ("Keep sensitive data in-house": card
 * numbers, IBANs, SSNs, national ids, credentials, private keys and JWTs stay on this machine or
 * the private network). It starts observing: verdicts are recorded and
 * nothing is stopped, and the banner counts what would have been blocked
 * this week. "Turn on enforcement" makes it act. The full rule editor sits
 * under Advanced. Without rules nothing changes for any workflow.
 */

import { useCallback, useEffect, useState } from "react";
import {
  DESTINATION_TIERS,
  DESTINATION_TIER_LABELS,
  STARTER_DESTINATION_RULE,
  destinationRulesObservingSentence,
  type DestinationRuleView,
  type DestinationRulesStatus,
  type DestinationTier
} from "@ai-orchestrator/shared";
import { ApiError, addStarterDestinationRule, fetchDestinationRules, saveDestinationRules, setDestinationRulesEnforcement, type GuardFieldIssue } from "../lib/api";

const RULE_ACTIONS: Array<{ value: DestinationRuleView["action"]; label: string }> = [
  { value: "block", label: "Block" },
  { value: "require_approval", label: "Wait for approval" },
  { value: "review", label: "Hold for review" },
  { value: "redact", label: "Redact" },
  { value: "mask", label: "Mask" },
  { value: "protect", label: "Protect (profile's provider)" }
];
/** The deployment's rules have no protection provider of their own, so "Protect" is not offered here (it would only block). */
const EDITABLE_RULE_ACTIONS = RULE_ACTIONS.filter((entry) => entry.value !== "protect");

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

function issuesOf(err: unknown): GuardFieldIssue[] {
  if (err instanceof ApiError && Array.isArray(err.payload?.issues)) return err.payload!.issues as GuardFieldIssue[];
  return [];
}

/** One rule in the editor: lists as comma-separated text. */
interface RuleForm {
  name: string;
  dataClasses: string;
  provenance: string;
  maxTier: DestinationTier;
  regions: string;
  action: DestinationRuleView["action"];
  observe: boolean;
}

const list = (text: string) =>
  text
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

export function ruleToForm(rule: DestinationRuleView): RuleForm {
  return {
    name: rule.name ?? "",
    dataClasses: (rule.when.dataClasses ?? []).join(", "),
    provenance: (rule.when.provenance ?? []).join(", "),
    maxTier: rule.allow.maxTier,
    regions: (rule.allow.regions ?? []).join(", "),
    action: rule.action,
    observe: rule.shadow === true
  };
}

export function formToRule(form: RuleForm): Record<string, unknown> {
  const dataClasses = list(form.dataClasses);
  const provenance = list(form.provenance);
  const regions = list(form.regions);
  return {
    ...(form.name.trim() ? { name: form.name.trim() } : {}),
    when: { ...(dataClasses.length ? { dataClasses } : {}), ...(provenance.length ? { provenance } : {}) },
    allow: { maxTier: form.maxTier, ...(regions.length ? { regions } : {}) },
    action: form.action,
    ...(form.observe ? { shadow: true } : {})
  };
}

/** "Card number, IBAN … may go no further than Private network (block)". */
export function describeRule(rule: DestinationRuleView): string {
  const classes = rule.when.dataClasses ?? [];
  const provenance = rule.when.provenance ?? [];
  const subject = [classes.length ? classes.map((entry) => entry.replace(/_/g, " ")).join(", ") : "", provenance.length ? `data from ${provenance.join(", ")}` : ""].filter(Boolean).join("; ") || "Any outgoing data";
  const limit = `may go no further than ${DESTINATION_TIER_LABELS[rule.allow.maxTier].toLowerCase()}${rule.allow.regions?.length ? ` (regions ${rule.allow.regions.join(", ")})` : ""}`;
  const action = RULE_ACTIONS.find((entry) => entry.value === rule.action)?.label.toLowerCase() ?? rule.action;
  return `${subject} ${limit}; otherwise ${action}.`;
}

export function DestinationRulesCard({ canEdit }: { canEdit: boolean }) {
  const [status, setStatus] = useState<DestinationRulesStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const reload = useCallback(async () => {
    try {
      setStatus(await fetchDestinationRules());
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 501) setUnavailable(true);
      else setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (work: () => Promise<DestinationRulesStatus>) => {
    setBusy(true);
    try {
      setStatus(await work());
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (unavailable) return null;
  const rules = status?.rules ?? [];
  const observing = status?.observing;

  return (
    <section className="kb-section guard-dest-rules-card" aria-labelledby="dest-rules-title">
      <div className="mcp-section-head">
        <h4 id="dest-rules-title">Destination rules</h4>
        {status && status.mode !== "off" && (
          <span className={status.mode === "enforcing" ? "guard-chip guard-chip-lock" : "guard-chip guard-chip-shadow"}>{status.mode === "enforcing" ? "Enforcing" : status.mode === "observing" ? "Observing" : "Partly observing"}</span>
        )}
      </div>
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      {status && status.mode === "off" && (
        <div className="page-empty compact guard-dest-starter">
          <p>
            <strong>{STARTER_DESTINATION_RULE.name}</strong>
          </p>
          <p className="kb-subtle">
            Card numbers, IBANs, social security and national id numbers, credentials, private keys and tokens stay on this machine or your private network. It starts by observing: nothing is blocked until you turn on enforcement.
          </p>
          {canEdit ? (
            <button type="button" className="pg-btn" disabled={busy} onClick={() => void act(async () => (await addStarterDestinationRule()))}>
              Add the starter rule
            </button>
          ) : (
            <p className="kb-subtle">An admin can add it.</p>
          )}
        </div>
      )}
      {status && status.mode !== "off" && (
        <>
          {observing && status.mode !== "enforcing" && (
            <div className="info-banner guard-dest-observing" role="status">
              {destinationRulesObservingSentence(observing.wouldBlock)}
            </div>
          )}
          <ul className="guard-dest-rules" aria-label="Rules in force">
            {rules.map((rule, index) => (
              <li key={index}>
                {rule.name && <strong>{rule.name}: </strong>}
                {describeRule(rule)}
                {rule.shadow && <span className="guard-chip guard-chip-shadow">observing</span>}
              </li>
            ))}
          </ul>
          {canEdit && (
            <div className="guard-save-row">
              {status.mode !== "enforcing" ? (
                <button type="button" className="pg-btn" disabled={busy} onClick={() => void act(() => setDestinationRulesEnforcement(true))}>
                  Turn on enforcement
                </button>
              ) : (
                <button type="button" className="pg-btn ghost small" disabled={busy} onClick={() => void act(() => setDestinationRulesEnforcement(false))}>
                  Back to observing
                </button>
              )}
              {!status.hasStarter && (
                <button type="button" className="pg-btn ghost small" disabled={busy} onClick={() => void act(async () => (await addStarterDestinationRule()))}>
                  Add the starter rule
                </button>
              )}
            </div>
          )}
        </>
      )}
      {status && canEdit && (
        <details className="guard-sim-advanced">
          <summary>Advanced</summary>
          <RuleEditor key={`${status.version ?? 0}`} rules={rules} onSave={(next) => saveDestinationRules(next).then((saved) => setStatus(saved))} />
        </details>
      )}
    </section>
  );
}

function RuleEditor({ rules, onSave }: { rules: DestinationRuleView[]; onSave: (rules: Array<Record<string, unknown>>) => Promise<void> }) {
  const [forms, setForms] = useState<RuleForm[]>(() => rules.map(ruleToForm));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<GuardFieldIssue[]>([]);
  const update = (index: number, patch: Partial<RuleForm>) => setForms((current) => current.map((form, at) => (at === index ? { ...form, ...patch } : form)));

  return (
    <form
      className="guard-dest-form guard-dest-rule-editor"
      aria-label="Edit destination rules"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        try {
          await onSave(forms.map(formToRule));
          setError(null);
          setIssues([]);
        } catch (err) {
          setError(errorText(err));
          setIssues(issuesOf(err));
        } finally {
          setSaving(false);
        }
      }}
    >
      <p className="kb-subtle">Rules apply to every workflow, after its own guard profiles. A rule with no data classes or provenance applies to any outgoing data (block, review or wait for approval only).</p>
      {forms.length === 0 && <p className="kb-subtle">No rules. Every workflow runs as before.</p>}
      {forms.map((form, index) => (
        <fieldset key={index} className="guard-dest-rule" aria-label={`Rule ${index + 1}`}>
          <div className="guard-settings-grid">
            <label>
              <span>Name</span>
              <input value={form.name} onChange={(event) => update(index, { name: event.target.value })} placeholder="Keep sensitive data in-house" />
            </label>
            <label>
              <span>Data classes</span>
              <input value={form.dataClasses} onChange={(event) => update(index, { dataClasses: event.target.value })} placeholder="card_number, iban" />
            </label>
            <label>
              <span>Provenance</span>
              <input value={form.provenance} onChange={(event) => update(index, { provenance: event.target.value })} placeholder="sensitive" />
            </label>
            <label>
              <span>Furthest allowed</span>
              <select aria-label="Furthest allowed" value={form.maxTier} onChange={(event) => update(index, { maxTier: event.target.value as DestinationTier })}>
                {DESTINATION_TIERS.map((tier) => (
                  <option key={tier} value={tier}>
                    {DESTINATION_TIER_LABELS[tier]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Regions (vendor and public)</span>
              <input value={form.regions} onChange={(event) => update(index, { regions: event.target.value })} placeholder="eu" />
            </label>
            <label>
              <span>Otherwise</span>
              <select aria-label="Otherwise" value={form.action} onChange={(event) => update(index, { action: event.target.value as RuleForm["action"] })}>
                {(form.action === "protect" ? RULE_ACTIONS : EDITABLE_RULE_ACTIONS).map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="guard-save-row">
            <label className="guard-inline-check">
              <input type="checkbox" checked={form.observe} onChange={(event) => update(index, { observe: event.target.checked })} /> Observe only
            </label>
            <button type="button" className="kb-link-btn guard-dest-remove" onClick={() => setForms((current) => current.filter((_, at) => at !== index))}>
              Remove rule
            </button>
          </div>
        </fieldset>
      ))}
      {error && (
        <div className="settings-error" role="alert">
          {error}
          {issues.length > 0 && (
            <ul className="guard-issues">
              {issues.map((issue, index) => (
                <li key={`${issue.path}-${index}`}>
                  <code>{issue.path}</code> {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="guard-save-row">
        <button
          type="button"
          className="pg-btn ghost small"
          onClick={() => setForms((current) => [...current, { name: "", dataClasses: "", provenance: "", maxTier: "private", regions: "", action: "block", observe: true }])}
        >
          Add rule
        </button>
        <button type="submit" className="pg-btn" disabled={saving}>
          {saving ? "Saving…" : "Save rules"}
        </button>
      </div>
    </form>
  );
}
