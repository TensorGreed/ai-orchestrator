import { useEffect, useMemo, useState } from "react";
import { REPLAY_REPEATS_MAX, type ReplayAggregateRule, type ReplayCompareMode, type ReplayJobEstimate, type ReplayModelMode, type ReplayServerMode, type Workflow } from "@ai-orchestrator/shared";
import { fetchGuardProfiles, fetchMcpServers, fetchWorkflow, type WorkflowVersionSummary } from "../lib/api";
import {
  SERVER_MODE_LABELS,
  formatUsd,
  modelNodesOf,
  parseCandidateFile,
  readNodesOf,
  type ReplayJobForm,
  type ReplayModelOverrideRow
} from "../lib/replay-jobs";

/**
 * Phase 15.3 — the candidate part of the Run replay dialog: what to replay
 * (the draft, a saved version or a workflow file), what to change on top
 * (models, guard profile, MCP modes, live read nodes) and how to compare
 * (live or taped models, recording or baseline rerun, repeats).
 */

interface ReplayCandidateFieldsProps {
  workflowId: string;
  projectId?: string | null;
  versions: WorkflowVersionSummary[];
  form: ReplayJobForm;
  update: (patch: Partial<ReplayJobForm>) => void;
  /** Secrets the user may pick for a model override that switches provider (by reference only). */
  secrets?: Array<{ id: string; name: string; provider: string }>;
}

interface Option {
  id: string;
  label: string;
}

const SERVER_MODES: ReplayServerMode[] = ["strict", "lenient", "live_read_only"];

/** A chosen file's text (FileReader, which every browser and test DOM has). */
function readText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsText(file);
  });
}

export function ReplayCandidateFields({ workflowId, projectId, versions, form, update, secrets = [] }: ReplayCandidateFieldsProps) {
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [profiles, setProfiles] = useState<Array<Option & { latestVersion: number }>>([]);
  const [servers, setServers] = useState<Option[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWorkflow(workflowId)
      .then((loaded) => !cancelled && setWorkflow(loaded))
      .catch(() => {
        // Without the workflow, overrides can still name nodes by id.
      });
    fetchGuardProfiles()
      .then((response) => !cancelled && setProfiles(response.profiles.map((profile) => ({ id: profile.id, label: profile.name, latestVersion: profile.latestVersion }))))
      .catch(() => {
        // Guard profiles are optional.
      });
    fetchMcpServers(projectId ?? undefined)
      .then((response) => !cancelled && setServers(response.servers.map((server) => ({ id: server.id, label: server.name }))))
      .catch(() => {
        // MCP modes per server are optional.
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, projectId]);

  // The uploaded file is the candidate when chosen, so its nodes are the ones to change.
  const target = form.candidate === "file" && form.candidateFile ? (form.candidateFile.workflow as unknown as Workflow) : workflow;
  const modelNodes = useMemo(() => modelNodesOf(target), [target]);
  const readNodes = useMemo(() => readNodesOf(target), [target]);
  const profile = profiles.find((entry) => entry.id === form.guardProfileId);

  const setRow = (index: number, patch: Partial<ReplayModelOverrideRow>) =>
    update({ modelOverrides: form.modelOverrides.map((row, at) => (at === index ? { ...row, ...patch } : row)) });

  const onFile = async (file: File | undefined) => {
    setFileError(null);
    if (!file) {
      update({ candidateFile: null });
      return;
    }
    let text: string;
    try {
      text = await readText(file);
    } catch {
      setFileError(`${file.name} could not be read.`);
      update({ candidateFile: null });
      return;
    }
    const parsed = parseCandidateFile(file.name, text, workflowId);
    if (!parsed.ok) {
      setFileError(parsed.error);
      update({ candidateFile: null });
      return;
    }
    update({ candidateFile: parsed.file });
  };

  return (
    <>
      <fieldset className="evals-scorers replay-candidate">
        <legend>Candidate</legend>
        <div className="evals-form-grid">
          <label>
            <span>Replay</span>
            <select
              autoFocus
              aria-label="Candidate"
              value={typeof form.candidate === "number" ? String(form.candidate) : form.candidate}
              onChange={(event) => {
                const value = event.target.value;
                update({ candidate: value === "draft" || value === "file" ? value : Number(value) });
              }}
            >
              <option value="draft">Draft (as saved now)</option>
              {versions.map((version) => (
                <option key={version.version} value={String(version.version)}>
                  Version {version.version}
                  {version.changeNote ? ` · ${version.changeNote}` : ""}
                </option>
              ))}
              <option value="file">Workflow file…</option>
            </select>
          </label>
          {form.candidate === "file" && (
            <label>
              <span>Workflow file (never saved)</span>
              <input type="file" accept="application/json,.json" aria-label="Workflow file" onChange={(event) => void onFile(event.target.files?.[0])} />
            </label>
          )}
        </div>
        {fileError && (
          <div className="error-banner" role="alert">
            {fileError}
          </div>
        )}
        {form.candidateFile && form.candidate === "file" && <p className="golden-note">Replaying {form.candidateFile.name}.</p>}

        <div className="replay-override-block">
          <span className="pg-eyebrow">Models</span>
          {form.modelOverrides.map((row, index) => (
            <div key={index} className="replay-override-row">
              <select aria-label={`Model override ${index + 1} node`} value={row.nodeId} onChange={(event) => setRow(index, { nodeId: event.target.value })}>
                <option value="">Every node of the provider</option>
                {modelNodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name} · {node.providerId}/{node.model}
                  </option>
                ))}
              </select>
              <input aria-label={`Model override ${index + 1} provider`} placeholder={row.nodeId ? "Same provider" : "Provider id"} value={row.provider} onChange={(event) => setRow(index, { provider: event.target.value })} />
              <input aria-label={`Model override ${index + 1} model`} placeholder="Model" value={row.model} onChange={(event) => setRow(index, { model: event.target.value })} />
              {row.nodeId && row.provider.trim() && (
                <select
                  aria-label={`Model override ${index + 1} secret`}
                  title="A node with its own key or base URL needs the secret to use with the new provider; its old key is never sent to another provider."
                  value={row.secretId ?? ""}
                  onChange={(event) => setRow(index, { secretId: event.target.value })}
                >
                  <option value="">Node's own credentials</option>
                  {secrets.map((secret) => (
                    <option key={secret.id} value={secret.id}>
                      {secret.name} · {secret.provider}
                    </option>
                  ))}
                </select>
              )}
              <button type="button" className="pg-btn ghost small" aria-label={`Remove model override ${index + 1}`} onClick={() => update({ modelOverrides: form.modelOverrides.filter((_, at) => at !== index) })}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" className="pg-btn small" onClick={() => update({ modelOverrides: [...form.modelOverrides, { nodeId: modelNodes[0]?.id ?? "", provider: "", model: "" }] })}>
            Add model override
          </button>
        </div>

        <div className="evals-form-grid">
          <label>
            <span>Guard profile</span>
            <select aria-label="Guard profile" value={form.guardProfileId} onChange={(event) => update({ guardProfileId: event.target.value, guardProfileVersion: "" })}>
              <option value="">As bound to the workflow</option>
              {profiles.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          {form.guardProfileId && (
            <label>
              <span>Version</span>
              <select aria-label="Guard profile version" value={form.guardProfileVersion} onChange={(event) => update({ guardProfileVersion: event.target.value })}>
                <option value="">Latest{profile ? ` (v${profile.latestVersion})` : ""}</option>
                {profile &&
                  Array.from({ length: profile.latestVersion }, (_, at) => profile.latestVersion - at).map((version) => (
                    <option key={version} value={String(version)}>
                      v{version}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </div>

        {servers.length > 0 && (
          <div className="replay-override-block">
            <span className="pg-eyebrow">MCP servers</span>
            <p className="golden-note">Live reads only sends read-only tool calls to the live server; writes and unknown tools are always answered from the golden run.</p>
            {servers.map((server) => (
              <label key={server.id} className="replay-override-row">
                <span>{server.label}</span>
                <select
                  aria-label={`MCP mode for ${server.label}`}
                  value={form.mcpServers[server.id] ?? ""}
                  onChange={(event) => {
                    const next = { ...form.mcpServers };
                    if (event.target.value) next[server.id] = event.target.value as ReplayServerMode;
                    else delete next[server.id];
                    update({ mcpServers: next });
                  }}
                >
                  <option value="">Job default</option>
                  {SERVER_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {SERVER_MODE_LABELS[mode]}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}

        {readNodes.length > 0 && (
          <div className="replay-override-block">
            <span className="pg-eyebrow">Read live</span>
            <p className="golden-note">
              These nodes only read data; checked ones read it live instead of the golden run's answer. Triggers, browsers, raw queries and nodes that write are never run live. A job with live reads is not release proof.
            </p>
            {readNodes.map((node) => (
              <label key={node.id} className="evals-check">
                <input
                  type="checkbox"
                  checked={form.liveReadNodes.includes(node.id)}
                  onChange={(event) =>
                    update({ liveReadNodes: event.target.checked ? [...form.liveReadNodes, node.id] : form.liveReadNodes.filter((id) => id !== node.id) })
                  }
                />
                <span>{node.name}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset className="evals-scorers replay-comparison">
        <legend>Comparison</legend>
        <div className="evals-form-grid">
          <label title="Replay answers each model call from the golden run's model tape: no model is called. Golden runs saved from runs without Record calls have no tape.">
            <span>Model calls</span>
            <select aria-label="Model calls" value={form.models} onChange={(event) => update({ models: event.target.value as ReplayModelMode })}>
              <option value="live">Live models</option>
              <option value="replay">From the model tape</option>
            </select>
          </label>
          <label title="A baseline rerun replays the golden run's own version under the same settings, so model drift since the recording is not blamed on the candidate.">
            <span>Compare with</span>
            <select aria-label="Compare with" value={form.compare} onChange={(event) => update({ compare: event.target.value as ReplayCompareMode })}>
              <option value="recording">The recording</option>
              <option value="baseline_rerun">A baseline rerun</option>
            </select>
          </label>
          <label>
            <span>Repeats (1–{REPLAY_REPEATS_MAX})</span>
            <input aria-label="Repeats" inputMode="numeric" value={form.repeats} onChange={(event) => update({ repeats: event.target.value })} />
          </label>
          <label>
            <span>A case passes when</span>
            <select aria-label="Aggregate" value={form.aggregate} disabled={Number(form.repeats) <= 1} onChange={(event) => update({ aggregate: event.target.value as ReplayAggregateRule })}>
              <option value="all">Every repeat passes</option>
              <option value="majority">Most repeats pass</option>
              <option value="any">Any repeat passes</option>
            </select>
          </label>
        </div>
      </fieldset>
    </>
  );
}

/** What the job would run and cost, shown before it starts. */
export function ReplayEstimatePanel({ estimate }: { estimate: ReplayJobEstimate }) {
  return (
    <section className="replay-estimate" aria-label="Estimate" aria-live="polite">
      <span className="pg-eyebrow">Estimate</span>
      <p className="replay-estimate-numbers">
        <span>
          <strong>{estimate.cases}</strong> case{estimate.cases === 1 ? "" : "s"} × <strong>{estimate.runsPerCase}</strong> run{estimate.runsPerCase === 1 ? "" : "s"}
        </span>
        <span>
          <strong>{estimate.modelCallsEstimate}</strong> model call{estimate.modelCallsEstimate === 1 ? "" : "s"}
        </span>
        <span className="mono-cell">
          {formatUsd(estimate.estimatedCostUsd)}
          {estimate.costUnknown ? "+" : ""}
        </span>
        {estimate.executions !== undefined && (
          <span className={estimate.maxExecutions !== undefined && estimate.executions > estimate.maxExecutions ? "is-over" : undefined}>
            <strong>{estimate.executions}</strong> execution{estimate.executions === 1 ? "" : "s"}
            {estimate.maxExecutions !== undefined ? ` of ${estimate.maxExecutions} allowed` : ""}
          </span>
        )}
      </p>
      {estimate.warnings.map((warning) => (
        <div key={warning} className="golden-note is-warn">
          {warning}
        </div>
      ))}
    </section>
  );
}
