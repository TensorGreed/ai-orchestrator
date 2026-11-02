/**
 * 12.6 — Security → Models: which providers and models the deployment and
 * each project may call. Empty lists allow every model (the default). A
 * project's list can only narrow the deployment's. Admins add and remove
 * entries; builders read the deployment list and their projects' lists;
 * viewers and operators do not see the lists.
 */

import { useCallback, useEffect, useState } from "react";
import { MODEL_ALLOWLIST_ANY_PROVIDER, type ModelAllowlistEntry, type ModelAllowlistScope, type Project } from "@ai-orchestrator/shared";
import { ApiError, addModelAllowlistEntry, fetchModelAllowlist, removeModelAllowlistEntry, type ModelAllowlistListResponse } from "../lib/api";

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

type Providers = ModelAllowlistListResponse["providers"];

/** Shown, and confirmed, when an entry starts an empty list: from then on that list refuses every model it does not match. */
export const FIRST_ENTRY_WARNING = "Only listed models will be allowed; every other model call will be refused.";

function providerName(providers: Providers, id: string): string {
  if (id === MODEL_ALLOWLIST_ANY_PROVIDER) return "Any provider";
  return providers.find((provider) => provider.id === id)?.name ?? id;
}

export interface ModelAllowlistViewProps {
  projects: Project[];
  activeProjectId?: string;
}

export function ModelAllowlistView({ projects, activeProjectId }: ModelAllowlistViewProps) {
  const [entries, setEntries] = useState<ModelAllowlistEntry[]>([]);
  const [providers, setProviders] = useState<Providers>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [projectId, setProjectId] = useState(activeProjectId ?? projects[0]?.id ?? "default");

  const reload = useCallback(async () => {
    try {
      const list = await fetchModelAllowlist();
      setEntries(list.entries);
      setProviders(list.providers);
      setCanEdit(list.canEdit);
      setError(null);
      setForbidden(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError(errorText(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (entry: ModelAllowlistEntry) => {
    const sameList = entries.filter((row) => row.scope === entry.scope && row.projectId === entry.projectId);
    const last = sameList.length === 1;
    const question = last
      ? `Remove ${providerName(providers, entry.providerId)} ${entry.modelGlob}? It is the last entry, so this list stops limiting models.`
      : `Remove ${providerName(providers, entry.providerId)} ${entry.modelGlob}? Models only it allowed will be refused.`;
    if (!window.confirm(question)) return;
    try {
      await removeModelAllowlistEntry(entry.id);
      await reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  /** False when the admin cancels starting an empty list. */
  const add = async (scope: ModelAllowlistScope, input: { providerId: string; modelGlob: string; note: string }): Promise<boolean> => {
    const listEmpty = scope === "deployment" ? deployment.length === 0 : project.length === 0;
    if (listEmpty && !window.confirm(`${FIRST_ENTRY_WARNING} Add ${providerName(providers, input.providerId)} ${input.modelGlob}?`)) return false;
    await addModelAllowlistEntry({
      scope,
      ...(scope === "project" ? { projectId } : {}),
      providerId: input.providerId,
      modelGlob: input.modelGlob,
      ...(input.note.trim() ? { note: input.note.trim() } : {})
    });
    await reload();
    return true;
  };

  const deployment = entries.filter((entry) => entry.scope === "deployment");
  const project = entries.filter((entry) => entry.scope === "project" && entry.projectId === projectId);
  const projectName = projects.find((entry) => entry.id === projectId)?.name ?? projectId;
  const otherProjects = new Set(entries.filter((entry) => entry.scope === "project" && entry.projectId !== projectId).map((entry) => entry.projectId));

  if (forbidden) {
    return (
      <div className="guard-models">
        <p className="kb-subtle">Only builders and admins can see the model allowlists.</p>
      </div>
    );
  }

  return (
    <div className="guard-models">
      <p className="page-hint">
        A model call is allowed when it matches the deployment list and the project's list; an empty list allows every model, and a project list can
        only narrow the deployment list, never widen it.
      </p>
      {!canEdit && loaded && <p className="kb-subtle">Read-only: only an admin changes these lists, and you see the lists of your projects.</p>}
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}

      <section className="kb-section" aria-labelledby="models-deployment">
        <div className="mcp-section-head">
          <h4 id="models-deployment">
            Deployment <span className="kb-subtle">{deployment.length}</span>
          </h4>
        </div>
        <EntryTable
          label="Deployment models"
          entries={deployment}
          providers={providers}
          canEdit={canEdit}
          loaded={loaded}
          emptyText="No deployment list: every provider and model is allowed (unless a project list narrows it)."
          onRemove={remove}
        />
        {canEdit && (
          <EntryForm
            label="Add a deployment entry"
            providers={providers}
            {...(deployment.length === 0 ? { hint: FIRST_ENTRY_WARNING } : {})}
            onAdd={(input) => add("deployment", input)}
          />
        )}
      </section>

      <section className="kb-section" aria-labelledby="models-project">
        <div className="mcp-section-head">
          <h4 id="models-project">Project override</h4>
          <label className="guard-models-project">
            <span className="kb-subtle">Project</span>
            <select aria-label="Project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {(projects.length > 0 ? projects : [{ id: "default", name: "Default" } as Project]).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                  {otherProjects.has(entry.id) ? " (has a list)" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <EntryTable
          label={`Models for ${projectName}`}
          entries={project}
          providers={providers}
          canEdit={canEdit}
          loaded={loaded}
          emptyText={`No list for ${projectName}: its workflows may call whatever the deployment list allows.`}
          onRemove={remove}
        />
        {canEdit && (
          <EntryForm
            label={`Add an entry for ${projectName}`}
            providers={providers}
            {...(project.length === 0 ? { hint: `In ${projectName}, only listed models will be allowed; every other model call there will be refused.` } : {})}
            onAdd={(input) => add("project", input)}
          />
        )}
      </section>
    </div>
  );
}

function EntryTable(props: {
  label: string;
  entries: ModelAllowlistEntry[];
  providers: Providers;
  canEdit: boolean;
  loaded: boolean;
  emptyText: string;
  onRemove: (entry: ModelAllowlistEntry) => void | Promise<void>;
}) {
  if (!props.loaded) return <p className="kb-subtle">Loading…</p>;
  if (props.entries.length === 0) return <p className="kb-subtle">{props.emptyText}</p>;
  return (
    <div className="mcp-table-scroll">
      <table className="kb-table" aria-label={props.label}>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Model pattern</th>
            <th>Note</th>
            <th>Added</th>
            {props.canEdit && <th aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {props.entries.map((entry) => (
            <tr key={entry.id}>
              <td>{providerName(props.providers, entry.providerId)}</td>
              <td className="mono-cell">{entry.modelGlob}</td>
              <td className="muted-cell">{entry.note ?? "—"}</td>
              <td className="muted-cell">
                {new Date(entry.createdAt).toLocaleDateString()}
                {entry.createdBy ? ` · ${entry.createdBy}` : ""}
              </td>
              {props.canEdit && (
                <td>
                  <button
                    type="button"
                    className="kb-link-btn"
                    aria-label={`Remove ${providerName(props.providers, entry.providerId)} ${entry.modelGlob}`}
                    onClick={() => void props.onRemove(entry)}
                  >
                    Remove
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EntryForm(props: { label: string; providers: Providers; hint?: string; onAdd: (input: { providerId: string; modelGlob: string; note: string }) => Promise<boolean> }) {
  const [providerId, setProviderId] = useState(MODEL_ALLOWLIST_ANY_PROVIDER);
  const [modelGlob, setModelGlob] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = props.providers.length > 0 ? props.providers : [{ id: MODEL_ALLOWLIST_ANY_PROVIDER, name: "Any provider" }];

  return (
    <form
      className="guard-dest-form"
      aria-label={props.label}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!modelGlob.trim()) {
          setError("Enter a model name or pattern, for example gpt-4o* or *.");
          return;
        }
        setSaving(true);
        try {
          if (await props.onAdd({ providerId, modelGlob: modelGlob.trim(), note })) {
            setModelGlob("");
            setNote("");
          }
          setError(null);
        } catch (err) {
          setError(errorText(err));
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="guard-settings-grid">
        <label>
          <span>Provider</span>
          <select aria-label="Provider" value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            {options.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Model pattern</span>
          <input aria-label="Model pattern" value={modelGlob} onChange={(event) => setModelGlob(event.target.value)} placeholder="gpt-4o* (* any text, ? one character)" />
        </label>
        <label className="guard-span-2">
          <span>Note (optional)</span>
          <input aria-label="Note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why this model is allowed" />
        </label>
      </div>
      {props.hint && <p className="kb-subtle">{props.hint}</p>}
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      <div className="guard-dest-actions">
        <button type="submit" className="pg-btn small" disabled={saving}>
          {saving ? "Adding…" : "Add"}
        </button>
      </div>
    </form>
  );
}
