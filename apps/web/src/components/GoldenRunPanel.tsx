import { useEffect, useState } from "react";
import {
  createReplayRecording,
  deleteReplayRecording,
  fetchReplayRecording,
  fetchWorkflowVersions,
  runReplay,
  type ReplayMcpMode,
  type ReplayRecordingDetail,
  type ReplayRunRequest,
  type ReplayRunResponse,
  type WorkflowVersionSummary
} from "../lib/api";

/**
 * Phase 15.1 — golden runs on the Runs page: saving a finished run as a
 * golden run, and replaying one against the draft or a saved version with
 * every external read and write answered from the recording.
 */

type ReplayNumberDelta = ReplayRunResponse["diff"]["totals"]["tokens"];
type ReplayToolStep = ReplayRunResponse["diff"]["toolCalls"]["steps"][number];

/** `draft` or a saved version number, as chosen in the candidate select. */
export type ReplayCandidateChoice = "draft" | number;

export function replayRequestFor(candidate: ReplayCandidateChoice, mcpMode: ReplayMcpMode): ReplayRunRequest {
  return candidate === "draft" ? { draft: true, mcpMode } : { version: candidate, mcpMode };
}

/** `+120 (+12%)`, `−0.0031`, `no change`, `—` when either side is unknown. */
export function formatReplayDelta(delta: ReplayNumberDelta, digits = 0): string {
  if (delta.delta === null) return "—";
  if (delta.delta === 0) return "no change";
  const sign = delta.delta > 0 ? "+" : "−";
  const amount = Math.abs(delta.delta).toFixed(digits);
  const pct = delta.pct === null ? "" : ` (${delta.pct > 0 ? "+" : "−"}${Math.abs(Math.round(delta.pct))}%)`;
  return `${sign}${amount}${pct}`;
}

function preview(value: unknown): string {
  if (value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

export function GoldenStarIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.6l1.9 4 4.3.5-3.2 3 .9 4.3L8 11.3l-3.9 2.1.9-4.3-3.2-3 4.3-.5L8 1.6z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.25"
      />
    </svg>
  );
}

// --- save --------------------------------------------------------------------

export interface SaveGoldenRunDialogProps {
  executionId: string;
  workflowName: string;
  /** The run recorded its MCP calls; without them MCP tools cannot be answered in a replay. */
  hasCassette: boolean;
  onClose: () => void;
  onSaved: (recordingId: string) => void;
}

export function SaveGoldenRunDialog({ executionId, workflowName, hasCassette, onClose, onSaved }: SaveGoldenRunDialogProps) {
  const [name, setName] = useState(`${workflowName} baseline`);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose);

  const save = async () => {
    if (!name.trim()) {
      setError("Give the golden run a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await createReplayRecording({ executionId, name: name.trim(), ...(notes.trim() ? { notes: notes.trim() } : {}) });
      onSaved(response.recording.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the golden run");
      setSaving(false);
    }
  };

  return (
    <div className="pg-modal-backdrop" role="presentation" onClick={onClose}>
      <div className="pg-modal golden-save-modal" role="dialog" aria-modal="true" aria-labelledby="golden-save-title" onClick={(event) => event.stopPropagation()}>
        <header className="pg-modal-header">
          <div>
            <h3 id="golden-save-title" className="pg-modal-title">
              Save as golden run
            </h3>
            <p className="golden-meta">
              <span className="mono-cell">{executionId.slice(0, 8)}</span>
              <span>{workflowName}</span>
            </p>
          </div>
          <button type="button" className="pg-btn ghost small" onClick={onClose} aria-label="Close">
            Close
          </button>
        </header>
        <form
          className="pg-modal-body golden-save-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="golden-note">
            Copies this run's input, every node's result and its recorded MCP calls, scrubbed of secrets. A golden run is kept until you delete it; run history
            retention does not remove it. In a replay, nodes that reach outside (Slack, email, HTTP, databases, sub-workflows) and code nodes are answered from it
            instead of running. Expressions inside the nodes that do run are still evaluated and can make network calls until expression sandboxing lands.
          </p>
          {!hasCassette && (
            <p className="golden-note is-warn" role="status">
              This run did not record its MCP calls, so a replay cannot answer MCP tools. Run with <strong>Record MCP calls</strong> on and save that run instead if
              the workflow uses MCP.
            </p>
          )}
          <label>
            <span>Name</span>
            <input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          <label>
            <span>Notes</span>
            <textarea value={notes} maxLength={2000} rows={3} placeholder="What this run proves" onChange={(event) => setNotes(event.target.value)} />
          </label>
          {error && <div className="error-banner">{error}</div>}
          <div className="golden-actions">
            <button type="button" className="pg-btn small ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="pg-btn small primary" disabled={saving}>
              {saving ? "Saving…" : "Save golden run"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- replay result -------------------------------------------------------------

const VERDICT_LABELS: Record<ReplayRunResponse["verdict"], string> = {
  pass: "Pass",
  fail: "Fail",
  error: "Could not complete"
};

function ToolLane({ step }: { step: ReplayToolStep }) {
  const changed = step.kind !== "matched" || step.argsChanged || step.outcomeChanged;
  const describe = (call: ReplayToolStep["baseline"]) =>
    call ? (
      <>
        <span className="golden-tool-name">{call.tool}</span>
        <span className="golden-tool-server">{call.server}</span>
        <span className="mono-cell golden-tool-outcome">{call.outcome}</span>
      </>
    ) : (
      <span className="golden-tool-empty">—</span>
    );
  return (
    <li className={`golden-tool-step is-${step.kind}${changed ? " is-changed" : ""}`}>
      <span className="golden-tool-cell">{describe(step.baseline)}</span>
      <span className="golden-tool-kind">
        {step.kind === "matched" ? (step.argsChanged ? "args changed" : step.outcomeChanged ? "outcome changed" : "same") : step.kind === "inserted" ? "new" : "missing"}
      </span>
      <span className="golden-tool-cell">{describe(step.candidate)}</span>
    </li>
  );
}

export function ReplayResultView({ result }: { result: ReplayRunResponse }) {
  const { diff } = result;
  const steps = diff.toolCalls.steps;
  return (
    <section className="golden-result" aria-label="Replay result">
      <div className="golden-verdict-row">
        <span className={`golden-verdict is-${result.verdict}`}>{VERDICT_LABELS[result.verdict]}</span>
        <span className="golden-meta">
          <span>
            against the {result.candidate.kind === "version" ? `saved version ${result.candidate.version}` : "draft"}
          </span>
          <span className="mono-cell">replay {result.executionId.slice(0, 8)}</span>
          <span>
            status {diff.status.baseline} → {diff.status.candidate}
          </span>
        </span>
      </div>
      {result.reasons.length > 0 && (
        <ul className="golden-reasons">
          {result.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      {diff.health.length > 0 && (
        <div className="golden-section">
          <span className="pg-eyebrow">Replay health</span>
          <ul className="golden-health">
            {diff.health.map((warning, index) => (
              <li key={`${warning.kind}-${warning.nodeId ?? ""}-${index}`} className={warning.blocking ? "is-blocking" : undefined}>
                <span className="mono-cell">{warning.kind.replace(/_/g, " ")}</span>
                {warning.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="golden-section">
        <span className="pg-eyebrow">Output</span>
        {diff.output.equal ? (
          <p className="golden-note">Same as the golden run{diff.output.ignored > 0 ? ` (${diff.output.ignored} ignored difference${diff.output.ignored === 1 ? "" : "s"})` : ""}.</p>
        ) : (
          <div className="golden-table-wrap">
            <table className="golden-diff-table">
              <thead>
                <tr>
                  <th scope="col">Path</th>
                  <th scope="col">Golden run</th>
                  <th scope="col">Replay</th>
                </tr>
              </thead>
              <tbody>
                {diff.output.changes.map((change) => (
                  <tr key={`${change.path}-${change.kind}`} className={`is-${change.kind}`}>
                    <td className="mono-cell">{change.path || "(output)"}</td>
                    <td className="golden-diff-old">{change.kind === "added" ? "—" : preview(change.baseline)}</td>
                    <td className="golden-diff-new">{change.kind === "removed" ? "—" : preview(change.candidate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="golden-section">
        <span className="pg-eyebrow">
          Tool calls · {diff.toolCalls.baselineCount} → {diff.toolCalls.candidateCount}
        </span>
        {steps.length === 0 ? (
          <p className="golden-note">No tool calls in either run.</p>
        ) : (
          <>
            <div className="golden-tool-head" aria-hidden="true">
              <span>Golden run</span>
              <span />
              <span>Replay</span>
            </div>
            <ol className="golden-tool-lanes">
              {steps.map((step, index) => (
                <ToolLane key={index} step={step} />
              ))}
            </ol>
          </>
        )}
      </div>

      <dl className="golden-totals">
        <div>
          <dt>Tokens</dt>
          <dd>{formatReplayDelta(diff.totals.tokens)}</dd>
        </div>
        <div>
          <dt>Cost (USD)</dt>
          <dd>{formatReplayDelta(diff.totals.costUsd, 4)}</dd>
        </div>
        <div>
          <dt>Model calls</dt>
          <dd>{formatReplayDelta(diff.models.callDelta)}</dd>
        </div>
        <div>
          <dt>Path</dt>
          <dd>
            {diff.path.added.length === 0 && diff.path.removed.length === 0 && diff.path.statusChanges.length === 0
              ? "no change"
              : [
                  diff.path.added.length > 0 ? `+${diff.path.added.join(", ")}` : "",
                  diff.path.removed.length > 0 ? `−${diff.path.removed.join(", ")}` : "",
                  diff.path.statusChanges.length > 0 ? `${diff.path.statusChanges.length} status change${diff.path.statusChanges.length === 1 ? "" : "s"}` : ""
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </dd>
        </div>
      </dl>
    </section>
  );
}

// --- viewer --------------------------------------------------------------------

export interface GoldenRunViewerProps {
  recordingId: string;
  /** Builders (and admins) replay and delete; viewers and operators only read. */
  canReplay: boolean;
  onClose: () => void;
  onChanged?: () => void;
}

export function GoldenRunViewer({ recordingId, canReplay, onClose, onChanged }: GoldenRunViewerProps) {
  const [recording, setRecording] = useState<ReplayRecordingDetail | null>(null);
  const [versions, setVersions] = useState<WorkflowVersionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<ReplayCandidateChoice>("draft");
  const [mcpMode, setMcpMode] = useState<ReplayMcpMode>("strict");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ReplayRunResponse | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEscape(onClose);

  useEffect(() => {
    let cancelled = false;
    setRecording(null);
    setResult(null);
    setError(null);
    fetchReplayRecording(recordingId)
      .then((response) => {
        if (cancelled) return;
        setRecording(response.recording);
        if (canReplay) {
          fetchWorkflowVersions(response.recording.workflowId)
            .then((list) => {
              if (!cancelled) setVersions(list.versions);
            })
            .catch(() => {
              // Saved versions are optional; the draft is always a candidate.
            });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the golden run");
      });
    return () => {
      cancelled = true;
    };
  }, [recordingId, canReplay]);

  const replay = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await runReplay(recordingId, replayRequestFor(candidate, mcpMode)));
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The replay could not run");
    } finally {
      setRunning(false);
    }
  };

  const remove = async () => {
    if (!recording || !window.confirm(`Delete the golden run "${recording.name}"? Replays against it will no longer be possible.`)) return;
    setDeleting(true);
    try {
      await deleteReplayRecording(recording.id);
      onChanged?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the golden run");
      setDeleting(false);
    }
  };

  const nodeCount = recording ? Object.keys(recording.nodes).length : 0;

  return (
    <div className="pg-modal-backdrop" role="presentation" onClick={onClose}>
      <div className="pg-modal golden-modal" role="dialog" aria-modal="true" aria-labelledby="golden-title" onClick={(event) => event.stopPropagation()}>
        <header className="pg-modal-header">
          <div>
            <h3 id="golden-title" className="pg-modal-title">
              <span className="golden-title-icon">
                <GoldenStarIcon />
              </span>
              {recording?.name ?? "Golden run"}
            </h3>
            {recording && (
              <p className="golden-meta">
                <span className="mono-cell">{recording.id.slice(0, 12)}</span>
                <span>
                  from run <span className="mono-cell">{recording.sourceExecutionId?.slice(0, 8) ?? "—"}</span> ({recording.sourceStatus})
                </span>
                <span>
                  {nodeCount} node{nodeCount === 1 ? "" : "s"} · {recording.mcpCallCount} MCP call{recording.mcpCallCount === 1 ? "" : "s"} · {formatBytes(recording.bytes)}
                </span>
                <span>{new Date(recording.createdAt).toLocaleString()}</span>
              </p>
            )}
          </div>
          <div className="golden-header-actions">
            {canReplay && recording && (
              <button type="button" className="pg-btn small ghost danger" onClick={() => void remove()} disabled={deleting}>
                Delete
              </button>
            )}
            <button type="button" className="pg-btn ghost small" onClick={onClose} aria-label="Close golden run">
              Close
            </button>
          </div>
        </header>
        <div className="pg-modal-body">
          {!recording && !error && <div className="page-hint">Loading golden run…</div>}
          {recording && (
            <>
              {recording.notes && <p className="golden-note">{recording.notes}</p>}
              <div className="golden-notes">
                <p className="golden-note">
                  A replay runs the candidate on this input. Slack, email, HTTP calls, databases, queues, sub-workflows and code nodes are answered from the recording
                  instead of running; knowledge-base writes are refused; approvals and waits are skipped; session memory starts empty and is thrown away. Models
                  run live. Expressions inside the nodes that do run are still evaluated and can make network calls until expression sandboxing lands.
                </p>
                <p className="golden-note">
                  A replay could not complete if it reaches a node the golden run never saw, or a code node whose code changed: neither is run, so neither can be
                  judged.
                </p>
                {recording.capabilities.mcp === "none" && (
                  <p className="golden-note is-warn" role="status">
                    No MCP calls were recorded with this run; MCP tools cannot be answered in a replay.
                  </p>
                )}
                {recording.truncated && (
                  <p className="golden-note is-warn" role="status">
                    Some large node outputs were cut to fit the size limit. A replay that has to use one cannot complete, because the nodes after it would see a placeholder.
                  </p>
                )}
              </div>
              {canReplay && (
                <div className="golden-toolbar">
                  <label>
                    <span>Candidate</span>
                    <select
                      value={candidate === "draft" ? "draft" : String(candidate)}
                      onChange={(event) => setCandidate(event.target.value === "draft" ? "draft" : Number(event.target.value))}
                    >
                      <option value="draft">Draft (as saved now)</option>
                      {versions.map((version) => (
                        <option key={version.version} value={String(version.version)}>
                          Version {version.version}
                          {version.changeNote ? ` · ${version.changeNote}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label title="Strict answers each recorded MCP call once. Lenient reuses the last answer when the candidate repeats a call more often than recorded. Neither reaches a live server.">
                    <span>MCP calls</span>
                    <select value={mcpMode} onChange={(event) => setMcpMode(event.target.value as ReplayMcpMode)}>
                      <option value="strict">Strict</option>
                      <option value="lenient">Lenient: reuse repeats</option>
                    </select>
                  </label>
                  <button type="button" className="pg-btn small primary" onClick={() => void replay()} disabled={running}>
                    {running ? "Replaying…" : "Replay"}
                  </button>
                </div>
              )}
            </>
          )}
          {error && <div className="error-banner">{error}</div>}
          {result && <ReplayResultView result={result} />}
        </div>
      </div>
    </div>
  );
}
