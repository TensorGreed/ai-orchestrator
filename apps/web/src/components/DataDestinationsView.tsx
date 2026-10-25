/**
 * Phase 16 — Security → Data destinations. Admins say how far each place the
 * workflows send data is from home (local, private network, approved
 * vendor, public). Built-in rows are shown greyed and read-only; the "Not
 * classified yet" list comes from configured providers, MCP servers and
 * connectors and offers one-click Classify. Region, approved data classes
 * and a note sit under Advanced. Destinations do nothing until a guard
 * profile has destination rules.
 */

import { useCallback, useEffect, useState } from "react";
import { DESTINATION_KINDS, DESTINATION_KIND_LABELS, DESTINATION_TIERS, DESTINATION_TIER_LABELS, type DataDestinationRow, type UnclassifiedDestination } from "@ai-orchestrator/shared";
import { ApiError, createDataDestination, deleteDataDestination, fetchDataDestinations, fetchUnclassifiedDestinations, updateDataDestination } from "../lib/api";
import { describeMatch, EMPTY_DESTINATION_FORM, formFromRow, formFromSuggestion, inputFromForm, TARGET_ID_LABEL, type DestinationForm } from "../lib/data-destinations";

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

type Editing = { mode: "new"; form: DestinationForm } | { mode: "edit"; id: string; form: DestinationForm };

export function DataDestinationsView() {
  const [rows, setRows] = useState<DataDestinationRow[]>([]);
  const [builtIns, setBuiltIns] = useState<DataDestinationRow[]>([]);
  const [unclassified, setUnclassified] = useState<UnclassifiedDestination[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  const reload = useCallback(async () => {
    try {
      const [list, pending] = await Promise.all([fetchDataDestinations(), fetchUnclassifiedDestinations()]);
      setRows(list.destinations);
      setBuiltIns(list.builtIns);
      setCanEdit(list.canEdit);
      setUnclassified(pending.destinations);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (row: DataDestinationRow) => {
    if (!window.confirm(`Remove the destination '${row.name}'? Calls to it count as public again unless a built-in row covers them.`)) return;
    try {
      await deleteDataDestination(row.id);
      await reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="guard-destinations">
      <p className="page-hint">
        Say how far each place your workflows send data is from home. A guard profile&apos;s destination rules can then keep sensitive data in-house. Destinations do nothing until a profile has destination rules.
      </p>
      {error && <div className="settings-error">{error}</div>}

      <section className="kb-section" aria-labelledby="dest-classified">
        <div className="mcp-section-head">
          <h4 id="dest-classified">
            Your destinations <span className="kb-subtle">{rows.length}</span>
          </h4>
          {canEdit && !editing && (
            <button type="button" className="pg-btn small" onClick={() => setEditing({ mode: "new", form: { ...EMPTY_DESTINATION_FORM } })}>
              Add destination
            </button>
          )}
        </div>
        {editing && (
          <DestinationEditor
            key={editing.mode === "edit" ? editing.id : `new-${editing.form.host}-${editing.form.targetId}`}
            title={editing.mode === "edit" ? "Edit destination" : "Add destination"}
            initial={editing.form}
            onCancel={() => setEditing(null)}
            onSave={async (form) => {
              const input = inputFromForm(form);
              if (editing.mode === "edit") await updateDataDestination(editing.id, input);
              else await createDataDestination(input);
              setEditing(null);
              await reload();
            }}
          />
        )}
        {loaded && rows.length === 0 ? (
          <div className="page-empty compact guard-dest-empty">
            <p>No destinations classified yet.</p>
            <p className="kb-subtle">
              That is fine: destinations do nothing until a guard profile has destination rules, so every workflow runs exactly as before. The built-in rows below already cover this machine, private networks and the main model providers.
            </p>
          </div>
        ) : (
          rows.length > 0 && (
            <div className="mcp-table-scroll">
              <table className="kb-table guard-dest-table" aria-label="Your destinations">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Matches</th>
                    <th>Tier</th>
                    <th>Region</th>
                    <th>Approved classes</th>
                    {canEdit && <th aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.name}</td>
                      <td className="mono-cell">{describeMatch(row)}</td>
                      <td>
                        <TierChip tier={row.tier} />
                      </td>
                      <td className="muted-cell">{row.region}</td>
                      <td className="muted-cell">{row.holdsDataClasses.length ? row.holdsDataClasses.join(", ") : "—"}</td>
                      {canEdit && (
                        <td className="guard-dest-actions">
                          <button type="button" className="kb-link-btn" onClick={() => setEditing({ mode: "edit", id: row.id, form: formFromRow(row) })}>
                            Edit
                          </button>
                          <button type="button" className="kb-link-btn guard-dest-remove" onClick={() => void remove(row)}>
                            Remove
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </section>

      <section className="kb-section" aria-labelledby="dest-unclassified">
        <div className="mcp-section-head">
          <h4 id="dest-unclassified">
            Not classified yet <span className="kb-subtle">{unclassified.length}</span>
          </h4>
        </div>
        {unclassified.length === 0 ? (
          <p className="kb-subtle">{loaded ? "Every provider, MCP server and connector your workflows use is covered by a destination or a built-in row." : "Loading…"}</p>
        ) : (
          <>
            <p className="kb-subtle">Found in your workflows and MCP servers. Nothing covers them, so they count as public.{canEdit ? "" : " Ask an admin to classify them."}</p>
            <ul className="guard-dest-pending" aria-label="Not classified yet">
              {unclassified.map((entry) => (
                <li key={`${entry.kind}:${entry.targetId ?? ""}:${entry.host ?? ""}`}>
                  <div>
                    <span className="mono-cell">{describeMatch(entry)}</span>
                    <span className="guard-cell-sub">Seen in {entry.seenIn.join("; ")}</span>
                  </div>
                  {canEdit && (
                    <button type="button" className="pg-btn small" aria-label={`Classify ${describeMatch(entry)}`} onClick={() => setEditing({ mode: "new", form: formFromSuggestion(entry) })}>
                      Classify
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="kb-section" aria-labelledby="dest-builtin">
        <div className="mcp-section-head">
          <h4 id="dest-builtin">Built-in</h4>
          <span className="kb-subtle">Read-only. Add a destination for the same host to override one.</span>
        </div>
        <div className="mcp-table-scroll">
          <table className="kb-table guard-dest-table guard-dest-builtin" aria-label="Built-in destinations">
            <thead>
              <tr>
                <th>Name</th>
                <th>Matches</th>
                <th>Tier</th>
                <th>Region</th>
              </tr>
            </thead>
            <tbody>
              {builtIns.map((row) => (
                <tr key={row.id} aria-disabled="true">
                  <td>
                    {row.name} <span className="guard-chip">built-in</span>
                  </td>
                  <td className="mono-cell">{describeMatch(row)}</td>
                  <td>
                    <TierChip tier={row.tier} />
                  </td>
                  <td className="muted-cell">{row.region}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function TierChip({ tier }: { tier: DataDestinationRow["tier"] }) {
  return <span className={`guard-dest-tier guard-dest-tier-${tier}`}>{DESTINATION_TIER_LABELS[tier]}</span>;
}

function DestinationEditor({ title, initial, onSave, onCancel }: { title: string; initial: DestinationForm; onSave: (form: DestinationForm) => Promise<void>; onCancel: () => void }) {
  const [form, setForm] = useState<DestinationForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<DestinationForm>) => setForm((current) => ({ ...current, ...patch }));
  const targetLabel = TARGET_ID_LABEL[form.kind];

  return (
    <form
      className="guard-dest-form"
      aria-label={title}
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        try {
          await onSave(form);
        } catch (err) {
          setError(errorText(err));
        } finally {
          setSaving(false);
        }
      }}
    >
      <h5>{title}</h5>
      <div className="guard-settings-grid">
        <label>
          <span>Name</span>
          <input value={form.name} onChange={(event) => set({ name: event.target.value })} placeholder="Corporate network" />
        </label>
        <label>
          <span>Kind</span>
          <select aria-label="Kind" value={form.kind} onChange={(event) => set({ kind: event.target.value as DestinationForm["kind"] })}>
            {DESTINATION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {DESTINATION_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>
        {targetLabel && (
          <label>
            <span>{targetLabel}</span>
            <input value={form.targetId} onChange={(event) => set({ targetId: event.target.value })} placeholder={form.kind === "model_provider" ? "openai" : ""} />
          </label>
        )}
        <label>
          <span>{form.kind === "http" ? "Host, wildcard or IP range" : "Host (optional)"}</span>
          <input value={form.host} onChange={(event) => set({ host: event.target.value })} placeholder={form.kind === "http" ? "*.corp.example or 10.0.0.0/8" : "api.example.com"} />
        </label>
        <label>
          <span>Tier</span>
          <select aria-label="Tier" value={form.tier} onChange={(event) => set({ tier: event.target.value as DestinationForm["tier"] })}>
            {DESTINATION_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {DESTINATION_TIER_LABELS[tier]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <details className="guard-sim-advanced">
        <summary>Advanced</summary>
        <div className="guard-settings-grid">
          <label>
            <span>Region</span>
            <input value={form.region} onChange={(event) => set({ region: event.target.value })} placeholder="eu-west-1" />
          </label>
          <label className="guard-span-2">
            <span>Approved data classes (allowed here whatever the tier)</span>
            <input value={form.holds} onChange={(event) => set({ holds: event.target.value })} placeholder="email, phone" />
          </label>
          <label className="guard-span-2">
            <span>Note</span>
            <input value={form.note} onChange={(event) => set({ note: event.target.value })} />
          </label>
        </div>
      </details>
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      <div className="guard-save-row">
        <button type="submit" className="pg-btn" disabled={saving}>
          {saving ? "Saving…" : "Save destination"}
        </button>
        <button type="button" className="pg-btn ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
