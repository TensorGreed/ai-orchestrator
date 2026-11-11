/**
 * Phase 12.1 — guard profiles and bindings.
 *
 * Profiles: list, versions, diff between versions, per-channel detectors,
 * thresholds and actions, shadow toggles, export and import. Every save is a
 * new immutable version; the built-in profile is read-only (duplicate it).
 * Bindings: the project's binding (an admin can enforce a profile, which
 * builders then cannot change) and a workflow's override, with the profiles
 * that apply to agent traffic in evaluation order.
 * Phase 15.6: profile editors can simulate the editor's changes (or a saved
 * version) on recent recorded runs before saving. 12.7: and benchmark the
 * editor's draft on the red-team corpus ("Benchmark this draft").
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { GuardBenchmarkResponse, GuardBindingMode, GuardProfileSummary, GuardProfileVersionView, GuardResolutionView, Project, WorkflowListItem } from "@ai-orchestrator/shared";
import {
  ApiError,
  createGuardProfile,
  deleteGuardProfile,
  fetchGuardDetectors,
  fetchGuardProfile,
  fetchGuardProfileDiff,
  fetchGuardProfileVersions,
  fetchGuardProfiles,
  fetchGuardProjectBinding,
  fetchGuardWorkflowBinding,
  guardProfileExportUrl,
  importGuardProfile,
  runGuardBenchmark,
  updateGuardProfile,
  updateGuardProjectBinding,
  updateGuardWorkflowBinding,
  type GuardDetectorInfo,
  type GuardFieldIssue,
  type GuardProfileChange,
  type GuardProjectBindingView,
  type GuardWorkflowBindingResponse
} from "../lib/api";
import {
  GUARD_EDITOR_ACTIONS,
  GUARD_EDITOR_CHANNELS,
  channelOf,
  duplicateDocument,
  setActionRule,
  setCanaries,
  setLabelTracking,
  setChannelEnabled,
  setDefaultAction,
  setDetector,
  setDetectorOptions,
  setRuleStreamBuffer,
  setLatencyBudget,
  setProtectionFallback,
  setShadowForAction,
  setSpotlighting,
  setTopLevel,
  destinationRuleLines,
  suggestProfileId,
  revealRuleLine,
  revealRulesOf,
  setRevealRules,
  type GuardDocument,
  type RevealRuleView
} from "../lib/guard-profile-edit";
import { actionLabel, channelLabel } from "../lib/guard-trace";
import { GuardSimulationCard, useGuardSimulation } from "./GuardSimulationPanel";
import { simulateDenial } from "../lib/guard-simulation";
import { benchmarkDraftDenial } from "../lib/guard-benchmark";
import { GuardBenchmarkResultCard } from "./GuardBenchmarkView";
import { OutputCheckOptions } from "./OutputCheckOptions";
import { OUTPUT_CHECK_CATEGORY, isOutputCheck, type OutputCheckId } from "../lib/output-check-edit";

type Role = "admin" | "builder" | "operator" | "viewer";

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

function issuesOf(err: unknown): GuardFieldIssue[] {
  if (err instanceof ApiError && Array.isArray(err.payload?.issues)) return err.payload!.issues as GuardFieldIssue[];
  return [];
}

export function GuardProfilesView({ projects, workflows, activeProjectId, role }: { projects: Project[]; workflows: WorkflowListItem[]; activeProjectId: string; role: Role }) {
  const canEdit = role === "admin" || role === "builder";
  const [profiles, setProfiles] = useState<GuardProfileSummary[]>([]);
  const [autoApply, setAutoApply] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detectors, setDetectors] = useState<GuardDetectorInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const reload = useCallback(async (select?: string) => {
    try {
      const response = await fetchGuardProfiles();
      setProfiles(response.profiles);
      setAutoApply(response.autoApply);
      setSelectedId((current) => select ?? current ?? response.profiles[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    fetchGuardDetectors()
      .then((response) => setDetectors(response.detectors))
      .catch(() => setDetectors([]));
  }, [reload]);

  return (
    <div className="guard-profiles">
      {error && <div className="settings-error">{error}</div>}
      <GuardBindingsPanel projects={projects} workflows={workflows} activeProjectId={activeProjectId} role={role} profiles={profiles} autoApply={autoApply} />
      <div className="guard-profiles-layout">
        <aside className="kb-section guard-profile-list" aria-label="Rule sets">
          <div className="mcp-section-head">
            <h4>Rule sets</h4>
            {canEdit && (
              <button type="button" className="kb-link-btn" onClick={() => setImportOpen((value) => !value)}>
                {importOpen ? "Close import" : "Import JSON"}
              </button>
            )}
          </div>
          {importOpen && canEdit && <ImportBox onImported={(id) => { setImportOpen(false); void reload(id); }} />}
          <ul>
            {profiles.map((profile) => (
              <li key={profile.id}>
                <button type="button" className={profile.id === selectedId ? "guard-profile-item active" : "guard-profile-item"} aria-current={profile.id === selectedId} onClick={() => setSelectedId(profile.id)}>
                  <span className="guard-profile-name">{profile.name}</span>
                  <span className="mono-cell guard-cell-sub">
                    {profile.id} · v{profile.latestVersion}
                    {profile.builtIn ? " · built-in" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        {selectedId ? (
          <GuardProfileEditor
            key={selectedId}
            profileId={selectedId}
            detectors={detectors}
            canEdit={canEdit}
            role={role}
            takenIds={new Set(profiles.map((profile) => profile.id))}
            onChanged={(id) => void reload(id)}
            onDeleted={() => {
              setSelectedId(null);
              void reload();
            }}
          />
        ) : (
          <div className="page-empty">Select a rule set.</div>
        )}
      </div>
    </div>
  );
}

function ImportBox({ onImported }: { onImported: (id: string) => void }) {
  const [text, setText] = useState("");
  const [issues, setIssues] = useState<GuardFieldIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="guard-import">
      <textarea aria-label="Rule set JSON" rows={6} value={text} placeholder='{ "id": "my-rules", "name": "…", "version": "1", "channels": { … } }' onChange={(event) => setText(event.target.value)} />
      <IssueList issues={issues} error={error} />
      <button
        type="button"
        className="pg-btn small primary"
        disabled={!text.trim()}
        onClick={async () => {
          try {
            const response = await importGuardProfile({ text });
            setIssues([]);
            setError(null);
            onImported(response.profile.id);
          } catch (err) {
            setIssues(issuesOf(err));
            setError(errorText(err));
          }
        }}
      >
        Import
      </button>
    </div>
  );
}

function IssueList({ issues, error }: { issues: GuardFieldIssue[]; error: string | null }) {
  if (!error && issues.length === 0) return null;
  return (
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
  );
}

function GuardProfileEditor({
  profileId,
  detectors,
  canEdit,
  role,
  takenIds,
  onChanged,
  onDeleted
}: {
  profileId: string;
  detectors: GuardDetectorInfo[];
  canEdit: boolean;
  role: Role;
  takenIds: Set<string>;
  onChanged: (id: string) => void;
  onDeleted: () => void;
}) {
  const [summary, setSummary] = useState<GuardProfileSummary | null>(null);
  const [document, setDocument] = useState<GuardDocument | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [versions, setVersions] = useState<GuardProfileVersionView[]>([]);
  const [channel, setChannel] = useState<string>("prompt");
  const [note, setNote] = useState("");
  const [issues, setIssues] = useState<GuardFieldIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [busy, setBusy] = useState(false);
  const simulation = useGuardSimulation(profileId);
  // 12.7 — "Benchmark this draft": the corpus through the editor's document; returned, never stored.
  const [benchmark, setBenchmark] = useState<GuardBenchmarkResponse | null>(null);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);
  const [benchmarking, setBenchmarking] = useState(false);
  useEffect(() => {
    setBenchmark(null);
    setBenchmarkError(null);
  }, [profileId]);

  const load = useCallback(async () => {
    try {
      const [detail, history] = await Promise.all([fetchGuardProfile(profileId), fetchGuardProfileVersions(profileId)]);
      setSummary(detail.profile);
      setDocument(detail.latest.document);
      setSaved(JSON.stringify(detail.latest.document));
      setJsonText(JSON.stringify(detail.latest.document, null, 2));
      setVersions(history.versions);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!summary || !document) {
    return <div className="kb-section">{error ? <div className="settings-error">{error}</div> : <p className="kb-subtle">Loading…</p>}</div>;
  }

  const readOnly = !canEdit || summary.builtIn;
  // Phase 15.6 — who may simulate: the same rule as saving (admins also on the built-in profile, through a saved version).
  const simulateBlocked = simulateDenial(role, summary);
  const benchmarkBlocked = benchmarkDraftDenial(role, summary);
  const dirty = JSON.stringify(document) !== saved;
  const update = (next: GuardDocument) => {
    setDocument(next);
    setJsonText(JSON.stringify(next, null, 2));
    setMessage(null);
  };
  const view = channelOf(document, channel);
  const channelDetectors = detectors.filter((detector) => detector.channels.includes(channel));
  const shadow = (document.shadow && typeof document.shadow === "object" ? document.shadow : {}) as Record<string, boolean>;
  const budget = (document.latencyBudget ?? {}) as { ms?: number; onExceeded?: string };
  const protection = (document.protection ?? {}) as { fallback?: string };
  const spotlighting = (document.spotlighting ?? null) as { mode?: string; hardenSystemPrompt?: boolean } | null;
  const canaries = Boolean((document.canaries as { enabled?: boolean } | undefined)?.enabled);
  const tracksLabels = document.labels === "propagated";

  const save = async () => {
    let next = document;
    if (jsonMode) {
      try {
        next = JSON.parse(jsonText) as GuardDocument;
      } catch {
        setIssues([{ path: "(json)", message: "Not valid JSON" }]);
        setError("Invalid rule set");
        return;
      }
    }
    setBusy(true);
    try {
      const response = await updateGuardProfile(profileId, { document: next, ...(note.trim() ? { note: note.trim() } : {}) });
      setIssues([]);
      setError(null);
      setNote("");
      setMessage(response.changed ? `Saved as version ${response.version.version}` : "No changes to save");
      await load();
      onChanged(profileId);
    } catch (err) {
      setIssues(issuesOf(err));
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const simulate = () => {
    let next = document;
    if (jsonMode) {
      try {
        next = JSON.parse(jsonText) as GuardDocument;
      } catch {
        setIssues([{ path: "(json)", message: "Not valid JSON" }]);
        setError("Invalid rule set");
        return;
      }
    }
    void simulation.start({ document: next as Record<string, unknown> });
  };

  const benchmarkDraft = async () => {
    let next = document;
    if (jsonMode) {
      try {
        next = JSON.parse(jsonText) as GuardDocument;
      } catch {
        setIssues([{ path: "(json)", message: "Not valid JSON" }]);
        setError("Invalid rule set");
        return;
      }
    }
    setBenchmarking(true);
    setBenchmarkError(null);
    try {
      setBenchmark(await runGuardBenchmark(profileId, { document: next as Record<string, unknown> }));
      setIssues([]);
    } catch (err) {
      setBenchmark(null);
      setIssues(issuesOf(err));
      setBenchmarkError(errorText(err));
    } finally {
      setBenchmarking(false);
    }
  };

  const duplicate = async () => {
    const name = `${summary.name} (copy)`;
    const id = suggestProfileId(name, takenIds);
    try {
      await createGuardProfile({ id, document: duplicateDocument(document, id, name), note: `Duplicated from ${summary.id} v${summary.latestVersion}` });
      onChanged(id);
    } catch (err) {
      setIssues(issuesOf(err));
      setError(errorText(err));
    }
  };

  return (
    <div className="guard-editor">
      <section className="kb-section">
        <div className="mcp-section-head guard-editor-head">
          <div>
            <h4>{summary.name}</h4>
            <span className="mono-cell guard-cell-sub">
              {summary.id} · v{summary.latestVersion} · {summary.hash.slice(0, 12)}
            </span>
          </div>
          <div className="guard-editor-actions">
            {summary.builtIn && <span className="guard-chip guard-chip-muted">built-in · read-only</span>}
            <a className="pg-btn small" href={guardProfileExportUrl(profileId)} download>
              Export
            </a>
            {canEdit && (
              <button type="button" className="pg-btn small" onClick={() => void duplicate()}>
                Duplicate
              </button>
            )}
            {canEdit && !summary.builtIn && (
              <button
                type="button"
                className="pg-btn small ghost danger"
                onClick={async () => {
                  if (!window.confirm(`Delete rule set '${summary.name}' and all its versions?`)) return;
                  try {
                    await deleteGuardProfile(profileId);
                    onDeleted();
                  } catch (err) {
                    setError(errorText(err));
                  }
                }}
              >
                Delete
              </button>
            )}
          </div>
        </div>
        {summary.builtIn && <p className="kb-subtle">The built-in rule set ships with L2M and cannot be edited. Duplicate it to make a rule set you can change.</p>}

        <div className="guard-settings-grid">
          <label>
            <span>Name</span>
            <input value={String(document.name ?? "")} disabled={readOnly} onChange={(event) => update(setTopLevel(document, "name", event.target.value))} />
          </label>
          <label className="guard-span-2">
            <span>Description</span>
            <input value={String(document.description ?? "")} disabled={readOnly} onChange={(event) => update(setTopLevel(document, "description", event.target.value))} />
          </label>
          <label>
            <span>Latency budget (ms)</span>
            <input
              type="number"
              min={1}
              value={budget.ms ?? 2000}
              disabled={readOnly}
              onChange={(event) => update(setLatencyBudget(document, { ms: Math.max(1, Number(event.target.value) || 1) }))}
            />
          </label>
          <label>
            <span>When over budget</span>
            <select value={budget.onExceeded ?? "fail_closed"} disabled={readOnly} onChange={(event) => update(setLatencyBudget(document, { onExceeded: event.target.value }))}>
              <option value="fail_closed">Fail closed (block)</option>
              <option value="fail_open">Fail open (allow)</option>
            </select>
          </label>
          <label>
            <span>No protection provider</span>
            <select value={protection.fallback ?? "block"} disabled={readOnly} onChange={(event) => update(setProtectionFallback(document, event.target.value))}>
              {["block", "redact", "mask", "review", "allow"].map((action) => (
                <option key={action} value={action}>
                  {actionLabel(action)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Spotlighting</span>
            <select
              value={spotlighting?.mode ?? "off"}
              disabled={readOnly}
              onChange={(event) => update(setSpotlighting(document, event.target.value as "off" | "delimiters" | "datamark", spotlighting?.hardenSystemPrompt ?? true))}
            >
              <option value="off">Off</option>
              <option value="delimiters">Delimiters</option>
              <option value="datamark">Datamark</option>
            </select>
          </label>
          <label className="guard-check">
            <input type="checkbox" checked={canaries} disabled={readOnly} onChange={(event) => update(setCanaries(document, event.target.checked))} />
            <span>Plant canaries in agent system prompts</span>
          </label>
          <div className="guard-span-2 guard-label-tracking">
            <label className="guard-check">
              <input type="checkbox" role="switch" checked={tracksLabels} disabled={readOnly} onChange={(event) => update(setLabelTracking(document, event.target.checked))} />
              <span>Track where data came from</span>
            </label>
            <p className="kb-subtle">
              Off by default. Notes where each step's data came from and what it contains, shows it on runs, and lets checks treat web, webhook and tool
              content as outside content even after it is copied into a prompt.
            </p>
          </div>
        </div>

        <fieldset className="guard-shadow" disabled={readOnly}>
          <legend>Shadow mode (record what would happen, let content through)</legend>
          {GUARD_EDITOR_ACTIONS.filter((action) => action !== "allow").map((action) => (
            <label key={action} className="guard-check">
              <input type="checkbox" checked={shadow[action] === true} onChange={(event) => update(setShadowForAction(document, action, event.target.checked))} />
              <span>{actionLabel(action)}</span>
            </label>
          ))}
        </fieldset>
        <DestinationRulesSummary document={document} />
        <RevealRulesSection document={document} role={role} readOnly={readOnly} onChange={update} />
      </section>

      <section className="kb-section">
        <div className="finops-range guard-channel-tabs" role="tablist" aria-label="Channels">
          {GUARD_EDITOR_CHANNELS.map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={channel === entry}
              className={channel === entry ? "finops-range-btn active" : "finops-range-btn"}
              onClick={() => setChannel(entry)}
            >
              {channelLabel(entry)}
              {!channelOf(document, entry) ? " (off)" : ""}
            </button>
          ))}
        </div>
        <label className="guard-check">
          <input type="checkbox" checked={Boolean(view)} disabled={readOnly} onChange={(event) => update(setChannelEnabled(document, channel, event.target.checked))} />
          <span>Check the {channelLabel(channel).toLowerCase()} channel</span>
        </label>
        {view && (
          <div className="guard-channel">
            <div className="mcp-table-scroll">
              <table className="kb-table guard-detector-table">
                <thead>
                  <tr>
                    <th>Detector</th>
                    <th>Tier</th>
                    <th className="num">Threshold</th>
                  </tr>
                </thead>
                <tbody>
                  {channelDetectors.map((detector) => {
                    const entry = view.detectors.find((item) => item.id === detector.id);
                    return (
                      <tr key={detector.id}>
                        <td>
                          <label className="guard-check" title={detector.description}>
                            <input type="checkbox" checked={Boolean(entry)} disabled={readOnly} onChange={(event) => update(setDetector(document, channel, detector.id, event.target.checked))} />
                            <span className="mono-cell">{detector.id}</span>
                          </label>
                        </td>
                        <td className="muted-cell">{detector.tier}</td>
                        <td className="num">
                          <input
                            type="number"
                            className="guard-threshold"
                            aria-label={`Threshold for ${detector.id}`}
                            min={0}
                            max={1}
                            step={0.05}
                            value={entry?.threshold ?? 0.5}
                            disabled={readOnly || !entry}
                            onChange={(event) => update(setDetector(document, channel, detector.id, true, Math.min(1, Math.max(0, Number(event.target.value) || 0))))}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {view.detectors
              .filter((entry) => isOutputCheck(entry.id))
              .map((entry) => (
                <OutputCheckOptions
                  key={`${summary.id}:${channel}:${entry.id}`}
                  detectorId={entry.id as OutputCheckId}
                  options={entry.options ?? {}}
                  readOnly={readOnly}
                  buffered={view.actions[OUTPUT_CHECK_CATEGORY[entry.id as OutputCheckId]]?.stream === "buffer"}
                  onChange={(options) => update(setDetectorOptions(document, channel, entry.id, options))}
                  onBuffered={(buffered) => update(setRuleStreamBuffer(document, channel, OUTPUT_CHECK_CATEGORY[entry.id as OutputCheckId], buffered))}
                />
              ))}
            <ActionRules
              key={channel}
              rules={view.actions}
              defaultAction={view.defaultAction.action}
              readOnly={readOnly}
              categories={[...new Set(channelDetectors.flatMap((detector) => detector.categories))]}
              onRule={(key, rule) => update(setActionRule(document, channel, key, rule))}
              onDefault={(action) => update(setDefaultAction(document, channel, action))}
            />
          </div>
        )}
        <label className="guard-check guard-json-toggle">
          <input type="checkbox" checked={jsonMode} onChange={(event) => setJsonMode(event.target.checked)} />
          <span>Edit as JSON</span>
        </label>
        {jsonMode && <textarea className="guard-json" aria-label="Rule set document" rows={16} value={jsonText} readOnly={readOnly} onChange={(event) => setJsonText(event.target.value)} />}
        <IssueList issues={issues} error={error} />
        {message && <p className="guard-saved" role="status">{message}</p>}
        {canEdit && (!readOnly || summary.builtIn) && (
          <div className="guard-save-row">
            {!readOnly && <input aria-label="Version note" placeholder="Version note (optional)" value={note} onChange={(event) => setNote(event.target.value)} />}
            <button
              type="button"
              className="pg-btn"
              disabled={simulation.busy || simulateBlocked !== null}
              aria-disabled={simulateBlocked !== null}
              title={
                simulateBlocked ??
                "Replay recent recorded runs of the workflows that use this rule set under the current rule set and with these settings; nothing is saved and no model is called"
              }
              onClick={simulate}
            >
              {simulation.busy ? "Simulating…" : "Simulate on recent traffic"}
            </button>
            {benchmarkBlocked === null && (
              <button
                type="button"
                className="pg-btn"
                disabled={benchmarking}
                title="Run the red-team corpus through the rule set with these settings and compare it with the latest stored benchmark; nothing is saved and no model is called"
                onClick={() => void benchmarkDraft()}
              >
                {benchmarking ? "Benchmarking…" : "Benchmark this draft"}
              </button>
            )}
            {!readOnly && (
              <button type="button" className="pg-btn primary" disabled={busy || (!dirty && !jsonMode)} onClick={() => void save()}>
                {dirty || jsonMode ? "Save new version" : "Saved"}
              </button>
            )}
          </div>
        )}
        {canEdit && simulateBlocked && (!readOnly || summary.builtIn) && <p className="kb-subtle guard-sim-denied">{simulateBlocked}</p>}
        {canEdit && benchmarkBlocked === null && <GuardBenchmarkResultCard result={benchmark} error={benchmarkError} busy={benchmarking} />}
        {canEdit && !simulateBlocked && (
          <GuardSimulationCard
            simulation={simulation.simulation}
            busy={simulation.busy}
            error={simulation.error}
            issues={simulation.issues}
            lost={simulation.lost}
            versions={versions}
            onSimulateVersion={(version) => void simulation.start({ version })}
            onRetry={simulation.retry}
            onCancel={() => void simulation.cancel()}
          />
        )}
      </section>

      <VersionHistory profileId={profileId} versions={versions} />
    </div>
  );
}

function ActionRules({
  rules,
  defaultAction,
  readOnly,
  categories,
  onRule,
  onDefault
}: {
  rules: Record<string, { action: string; shadow?: boolean }>;
  defaultAction: string;
  readOnly: boolean;
  categories: string[];
  onRule: (key: string, rule: { action: string; shadow?: boolean } | null) => void;
  onDefault: (action: string) => void;
}) {
  const [newKey, setNewKey] = useState("");
  const keys = Object.keys(rules);
  const suggestions = categories.filter((category) => !keys.includes(category));
  return (
    <div className="guard-rules">
      <div className="mcp-table-scroll">
        <table className="kb-table">
          <thead>
            <tr>
              <th>Category or data class</th>
              <th>Action</th>
              <th>Shadow</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key}>
                <td className="mono-cell">{key}</td>
                <td>
                  <select aria-label={`Action for ${key}`} value={rules[key]!.action} disabled={readOnly} onChange={(event) => onRule(key, { action: event.target.value, shadow: rules[key]!.shadow })}>
                    {GUARD_EDITOR_ACTIONS.map((action) => (
                      <option key={action} value={action}>
                        {actionLabel(action)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Shadow mode for ${key}`}
                    checked={rules[key]!.shadow === true}
                    disabled={readOnly}
                    onChange={(event) => onRule(key, { action: rules[key]!.action, shadow: event.target.checked })}
                  />
                </td>
                <td>
                  {!readOnly && (
                    <button type="button" className="kb-link-btn" aria-label={`Remove rule for ${key}`} onClick={() => onRule(key, null)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
            <tr>
              <td className="muted-cell">Anything else</td>
              <td>
                <select aria-label="Default action" value={defaultAction} disabled={readOnly} onChange={(event) => onDefault(event.target.value)}>
                  {GUARD_EDITOR_ACTIONS.map((action) => (
                    <option key={action} value={action}>
                      {actionLabel(action)}
                    </option>
                  ))}
                </select>
              </td>
              <td />
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <div className="guard-add-rule">
          <input aria-label="New rule key" list="guard-rule-keys" placeholder="category or data class (e.g. email)" value={newKey} onChange={(event) => setNewKey(event.target.value)} />
          <datalist id="guard-rule-keys">
            {[...suggestions, "email", "phone", "credential", "card_number", "iban", "national_id"].filter((key) => !keys.includes(key)).map((key) => (
              <option key={key} value={key} />
            ))}
          </datalist>
          <button
            type="button"
            className="pg-btn small"
            disabled={!newKey.trim() || keys.includes(newKey.trim())}
            onClick={() => {
              onRule(newKey.trim(), { action: "review" });
              setNewKey("");
            }}
          >
            Add rule
          </button>
        </div>
      )}
    </div>
  );
}

function VersionHistory({ profileId, versions }: { profileId: string; versions: GuardProfileVersionView[] }) {
  const latest = versions[0]?.version ?? 1;
  const [from, setFrom] = useState<number>(Math.max(1, latest - 1));
  const [to, setTo] = useState<number>(latest);
  const [changes, setChanges] = useState<GuardProfileChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFrom(Math.max(1, latest - 1));
    setTo(latest);
    setChanges(null);
  }, [latest]);

  return (
    <section className="kb-section" aria-label="Versions">
      <div className="mcp-section-head">
        <h4>Versions</h4>
      </div>
      <div className="mcp-table-scroll">
        <table className="kb-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Hash</th>
              <th>Note</th>
              <th>When</th>
              <th>From</th>
              <th>To</th>
              <th aria-label="Export" />
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => (
              <tr key={version.version}>
                <td className="mono-cell">v{version.version}</td>
                <td className="mono-cell">{version.hash.slice(0, 12)}</td>
                <td>{version.note ?? <span className="kb-subtle">—</span>}</td>
                <td className="muted-cell">{new Date(version.createdAt).toLocaleString()}</td>
                <td>
                  <input type="radio" name="guard-diff-from" aria-label={`Compare from v${version.version}`} checked={from === version.version} onChange={() => setFrom(version.version)} />
                </td>
                <td>
                  <input type="radio" name="guard-diff-to" aria-label={`Compare to v${version.version}`} checked={to === version.version} onChange={() => setTo(version.version)} />
                </td>
                <td>
                  <a className="kb-link-btn" href={guardProfileExportUrl(profileId, version.version)} download>
                    Export
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {versions.length > 1 && (
        <button
          type="button"
          className="pg-btn small"
          disabled={from === to}
          onClick={async () => {
            try {
              const diff = await fetchGuardProfileDiff(profileId, from, to);
              setChanges(diff.changes);
              setError(null);
            } catch (err) {
              setError(errorText(err));
            }
          }}
        >
          Compare v{from} → v{to}
        </button>
      )}
      {error && <div className="settings-error">{error}</div>}
      {changes && (
        <ul className="guard-diff" aria-label="Changes">
          {changes.length === 0 && <li className="kb-subtle">No differences.</li>}
          {changes.map((change) => (
            <li key={`${change.kind}-${change.path}`} className={`guard-diff-${change.kind}`}>
              <span className="guard-diff-kind">{change.kind}</span>
              <code>{change.path}</code>
              {change.kind !== "added" && <code className="guard-diff-before">{JSON.stringify(change.before)}</code>}
              {change.kind !== "removed" && <code className="guard-diff-after">{JSON.stringify(change.after)}</code>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ResolutionChain({ effective }: { effective: GuardResolutionView }) {
  return (
    <div className="guard-resolution">
      <span className="kb-subtle">Agents run with</span>
      {effective.stack.length === 0 ? (
        <span className="guard-chip guard-chip-muted">no automatic rule set</span>
      ) : (
        effective.stack.map((ref, index) => (
          <span key={`${ref.profileId}-${index}`} className={index === 0 && effective.enforced ? "guard-chip guard-chip-lock" : "guard-chip guard-chip-profile"}>
            {index > 0 ? "then " : ""}
            {ref.name ?? ref.profileId} v{ref.version}
            {index === 0 && effective.enforced ? " · enforced" : ""}
          </span>
        ))
      )}
      <span className="kb-subtle guard-chain">
        {effective.chain.map((level) => `${level.level}: ${level.mode}${level.profileId ? ` (${level.profileId})` : ""}`).join(" → ")}
      </span>
    </div>
  );
}

function GuardBindingsPanel({
  projects,
  workflows,
  activeProjectId,
  role,
  profiles,
  autoApply
}: {
  projects: Project[];
  workflows: WorkflowListItem[];
  activeProjectId: string;
  role: Role;
  profiles: GuardProfileSummary[];
  autoApply: boolean;
}) {
  const isAdmin = role === "admin";
  const canEdit = role === "admin" || role === "builder";
  const [projectId, setProjectId] = useState(activeProjectId);
  const [project, setProject] = useState<{ binding: GuardProjectBindingView; effective: GuardResolutionView } | null>(null);
  const [workflowId, setWorkflowId] = useState("");
  const [workflow, setWorkflow] = useState<GuardWorkflowBindingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<GuardFieldIssue[]>([]);

  const projectWorkflows = useMemo(() => workflows.filter((entry) => (entry.projectId ?? "default") === projectId), [projectId, workflows]);

  useEffect(() => {
    fetchGuardProjectBinding(projectId)
      .then((response) => {
        setProject(response);
        setError(null);
      })
      .catch((err) => setError(errorText(err)));
  }, [projectId]);

  useEffect(() => {
    if (!workflowId) {
      setWorkflow(null);
      return;
    }
    fetchGuardWorkflowBinding(workflowId)
      .then(setWorkflow)
      .catch((err) => setError(errorText(err)));
  }, [workflowId, project]);

  const locked = project?.binding.mode === "enforced";
  const projectReadOnly = !canEdit || (locked && !isAdmin);

  const saveProject = async (mode: GuardBindingMode, profileId: string | null) => {
    try {
      const response = await updateGuardProjectBinding(projectId, { mode, profileId });
      setProject(response);
      setIssues([]);
      setError(null);
    } catch (err) {
      setIssues(issuesOf(err));
      setError(errorText(err));
    }
  };

  const saveWorkflow = async (mode: "inherit" | "override", profileId: string | null) => {
    if (!workflowId) return;
    try {
      setWorkflow(await updateGuardWorkflowBinding(workflowId, { mode, profileId }));
      setIssues([]);
      setError(null);
    } catch (err) {
      setIssues(issuesOf(err));
      setError(errorText(err));
    }
  };

  const profileOptions = profiles.map((profile) => (
    <option key={profile.id} value={profile.id}>
      {profile.name} (v{profile.latestVersion})
    </option>
  ));

  return (
    <section className="kb-section guard-bindings" aria-label="Bindings">
      <div className="mcp-section-head">
        <h4>Bindings</h4>
        <span className="kb-subtle">{autoApply ? "Unbound projects use the built-in default rule set." : "Automatic rule sets are off (GUARD_AUTO_APPLY=false)."}</span>
      </div>
      <div className="guard-binding-grid">
        <div className={`guard-binding${locked ? " guard-binding-locked" : ""}`}>
          <label>
            <span>Project</span>
            <select value={projectId} onChange={(event) => { setProjectId(event.target.value); setWorkflowId(""); }}>
              {projects.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
              {projects.length === 0 && <option value="default">Default Project</option>}
            </select>
          </label>
          {project && (
            <>
              <label>
                <span>Mode</span>
                <select
                  value={project.binding.mode}
                  disabled={projectReadOnly}
                  onChange={(event) => {
                    const mode = event.target.value as GuardBindingMode;
                    void saveProject(mode, mode === "inherit" ? null : project.binding.profileId ?? profiles[0]?.id ?? null);
                  }}
                >
                  <option value="inherit">Inherit (instance default)</option>
                  <option value="override">Override</option>
                  <option value="enforced" disabled={!isAdmin}>
                    Enforced{isAdmin ? "" : " (admins only)"}
                  </option>
                </select>
              </label>
              {project.binding.mode !== "inherit" && (
                <label>
                  <span>Rule set</span>
                  <select value={project.binding.profileId ?? ""} disabled={projectReadOnly} onChange={(event) => void saveProject(project.binding.mode, event.target.value)}>
                    {profileOptions}
                  </select>
                </label>
              )}
              {locked && (
                <p className="guard-lock-note" role="note">
                  <span aria-hidden="true">🔒</span> Enforced by an admin. It runs first for every agent in this project; workflows and Content Rules nodes can add stricter checks but cannot remove it.
                </p>
              )}
              <ResolutionChain effective={project.effective} />
            </>
          )}
        </div>
        <div className="guard-binding">
          <label>
            <span>Workflow</span>
            <select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}>
              <option value="">Choose a workflow…</option>
              {projectWorkflows.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          {workflow && (
            <>
              <label>
                <span>Mode</span>
                <select
                  value={workflow.binding.mode === "override" ? "override" : "inherit"}
                  disabled={!canEdit}
                  onChange={(event) => {
                    const mode = event.target.value as "inherit" | "override";
                    void saveWorkflow(mode, mode === "inherit" ? null : workflow.binding.profileId ?? profiles[0]?.id ?? null);
                  }}
                >
                  <option value="inherit">Inherit (project)</option>
                  <option value="override">Override</option>
                </select>
              </label>
              {workflow.binding.mode === "override" && (
                <label>
                  <span>Rule set</span>
                  <select value={workflow.binding.profileId ?? ""} disabled={!canEdit} onChange={(event) => void saveWorkflow("override", event.target.value)}>
                    {profileOptions}
                  </select>
                </label>
              )}
              <ResolutionChain effective={workflow.effective} />
            </>
          )}
        </div>
      </div>
      <IssueList issues={issues} error={error} />
    </section>
  );
}

/** Phase 16 — the profile's destination rules, read-only (edit them as JSON). Nothing shows when the profile has none. */
function DestinationRulesSummary({ document }: { document: Record<string, unknown> }) {
  const rules = destinationRuleLines(document);
  if (rules.length === 0) return null;
  return (
    <div className="guard-dest-rules-block" aria-label="Destination rules">
      <h5>Destination rules</h5>
      <ol className="guard-dest-rules">
        {rules.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ol>
      <p className="kb-subtle">Where data may go, by the tiers on the Data destinations tab. Change them with Edit as JSON.</p>
    </div>
  );
}

const REVEAL_ROLES = ["admin", "builder", "operator", "viewer"] as const;
const splitList = (text: string): string[] =>
  text
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * Phase 12 coverage — who may turn protected tokens back into values (Reveal nodes). Nobody may unless a rule says so.
 * Only admins may add, change or remove reveal rules; others see them read-only. Nothing shows for a non-admin when
 * the rule set has none.
 */
export function RevealRulesSection({
  document,
  role,
  readOnly,
  onChange
}: {
  document: GuardDocument;
  role: Role;
  readOnly: boolean;
  onChange: (next: GuardDocument) => void;
}) {
  const rules = revealRulesOf(document);
  const isAdmin = role === "admin";
  const editable = isAdmin && !readOnly;
  const [draft, setDraft] = useState({ name: "", dataClasses: "", roles: [] as string[], users: "", serviceAccounts: "", workflows: "", requireApproval: false });
  if (rules.length === 0 && !editable) return null;
  const draftRule: RevealRuleView = {
    ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
    dataClasses: splitList(draft.dataClasses),
    roles: draft.roles,
    users: splitList(draft.users),
    serviceAccounts: splitList(draft.serviceAccounts),
    workflows: splitList(draft.workflows),
    requireApproval: draft.requireApproval
  };
  const draftReady = draftRule.dataClasses.length > 0 && draftRule.roles.length + draftRule.users.length + draftRule.serviceAccounts.length > 0;
  return (
    <div className="guard-dest-rules-block" aria-label="Reveal rules">
      <h5>Reveal rules</h5>
      {rules.length === 0 ? (
        <p className="kb-subtle">No reveal rules: no Reveal node can turn this rule set&apos;s protected values back into the original.</p>
      ) : (
        <ol className="guard-dest-rules">
          {rules.map((rule, index) => (
            <li key={index}>
              {revealRuleLine(rule)}
              {editable && (
                <button type="button" className="pg-btn small ghost danger" aria-label={`Remove reveal rule ${index + 1}`} onClick={() => onChange(setRevealRules(document, rules.filter((_, at) => at !== index)))}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="kb-subtle">
        Roles and users match only runs a signed-in person started. Webhook, chat, schedule and gateway runs never match them; name a service account to allow an unattended run.
        Revealed values count as sensitive again, so destination rules decide where they may go.
      </p>
      {!isAdmin && rules.length > 0 && (
        <p className="guard-lock-note" role="note">
          Only an admin can change reveal rules or save this rule set while it has them.
        </p>
      )}
      {editable && (
        <fieldset className="guard-reveal-form">
          <legend>Add a reveal rule</legend>
          <label>
            <span>Name (optional)</span>
            <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <label>
            <span>Data classes</span>
            <input aria-label="Reveal data classes" placeholder="card_number, email" value={draft.dataClasses} onChange={(event) => setDraft({ ...draft, dataClasses: event.target.value })} />
          </label>
          <div role="group" aria-label="Reveal roles">
            {REVEAL_ROLES.map((entry) => (
              <label key={entry} className="guard-check">
                <input
                  type="checkbox"
                  checked={draft.roles.includes(entry)}
                  onChange={(event) => setDraft({ ...draft, roles: event.target.checked ? [...draft.roles, entry] : draft.roles.filter((value) => value !== entry) })}
                />
                <span>{entry}</span>
              </label>
            ))}
          </div>
          <label>
            <span>User ids</span>
            <input value={draft.users} onChange={(event) => setDraft({ ...draft, users: event.target.value })} />
          </label>
          <label>
            <span>Service account ids</span>
            <input value={draft.serviceAccounts} onChange={(event) => setDraft({ ...draft, serviceAccounts: event.target.value })} />
          </label>
          <label>
            <span>Only in workflows (ids, optional)</span>
            <input value={draft.workflows} onChange={(event) => setDraft({ ...draft, workflows: event.target.value })} />
          </label>
          <label className="guard-check">
            <input type="checkbox" checked={draft.requireApproval} onChange={(event) => setDraft({ ...draft, requireApproval: event.target.checked })} />
            <span>A person approves each reveal first</span>
          </label>
          <button
            type="button"
            className="pg-btn small"
            disabled={!draftReady}
            title={draftReady ? undefined : "Name at least one data class and one role, user or service account"}
            onClick={() => {
              onChange(setRevealRules(document, [...rules, draftRule]));
              setDraft({ name: "", dataClasses: "", roles: [], users: "", serviceAccounts: "", workflows: "", requireApproval: false });
            }}
          >
            Add reveal rule
          </button>
        </fieldset>
      )}
    </div>
  );
}
