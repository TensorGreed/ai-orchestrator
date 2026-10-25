/**
 * Phase 15.6 — "Simulate on recent traffic" in the guard profile editor.
 *
 * One button next to Save replays the most recent recorded runs of the
 * workflows that use this profile twice, model calls from each run's tape:
 * under the current profile and under the editor's current (unsaved)
 * document, and shows one plain sentence first ("Across 50 recent runs in
 * 4 workflows: 3 newly blocked, 7 now masked, 0 no longer blocked"), the
 * detail behind a disclosure. Advanced: simulate a saved version instead.
 * Only profile editors can use it; others see it disabled with the reason.
 * A failed poll is retried with backoff, then the card offers Retry. A
 * running simulation can be canceled by an admin or whoever started it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { GuardProfileVersionView, GuardSimulationView } from "@ai-orchestrator/shared";
import { ApiError, cancelGuardSimulation, fetchGuardSimulation, simulateGuardProfile, type GuardFieldIssue } from "../lib/api";
import {
  actionTransition,
  changeLabel,
  checkpointPlace,
  divergenceText,
  notableCases,
  POLL_MAX_RETRIES,
  pollRetryDelay,
  simulationFinished,
  simulationWorkflowRows,
  topTallies
} from "../lib/guard-simulation";

const POLL_MS = 1000;

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

function issuesOf(err: unknown): GuardFieldIssue[] {
  if (err instanceof ApiError && Array.isArray(err.payload?.issues)) return err.payload!.issues as GuardFieldIssue[];
  return [];
}

/** The button that sits next to Save, and the card under the save row. */
export function useGuardSimulation(profileId: string, options: { pollMs?: number; retryBaseMs?: number } = {}) {
  return useSimulationRunner<{ document: Record<string, unknown> } | { version: number }>((payload) => simulateGuardProfile(profileId, payload), options);
}

/**
 * Starts a simulation with `starter` and polls it to the end (shared by the
 * profile editor and, Phase 16, Preview impact on the Destinations tab).
 */
export function useSimulationRunner<P>(starter: (payload: P) => Promise<{ simulation: GuardSimulationView }>, options: { pollMs?: number; retryBaseMs?: number } = {}) {
  const pollMs = options.pollMs ?? POLL_MS;
  const retryBaseMs = options.retryBaseMs;
  const [simulation, setSimulation] = useState<GuardSimulationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<GuardFieldIssue[]>([]);
  /** Set when polling gave up after retries: the simulation may still be running on the server. */
  const [lost, setLost] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const poll = useCallback(
    (id: string, failures = 0) => {
      const delay = failures === 0 ? pollMs : pollRetryDelay(failures, retryBaseMs);
      timer.current = setTimeout(async () => {
        try {
          const response = await fetchGuardSimulation(id);
          setLost(null);
          setSimulation(response.simulation);
          if (simulationFinished(response.simulation)) setBusy(false);
          else poll(id);
        } catch (err) {
          // A network blip or a deploy: try again a few times, then offer Retry (the simulation keeps running on the server).
          if (failures < POLL_MAX_RETRIES) {
            poll(id, failures + 1);
            return;
          }
          setLost(`Lost touch with the simulation (${errorText(err)}). It may still be running.`);
          setBusy(false);
        }
      }, delay);
    },
    [pollMs, retryBaseMs]
  );

  const retry = useCallback(() => {
    if (!simulation) return;
    if (timer.current) clearTimeout(timer.current);
    setLost(null);
    setBusy(true);
    poll(simulation.id);
  }, [poll, simulation]);

  const starterRef = useRef(starter);
  starterRef.current = starter;
  const start = useCallback(
    async (payload: P) => {
      if (timer.current) clearTimeout(timer.current);
      setBusy(true);
      setError(null);
      setLost(null);
      setIssues([]);
      try {
        const response = await starterRef.current(payload);
        setSimulation(response.simulation);
        if (simulationFinished(response.simulation)) setBusy(false);
        else poll(response.simulation.id);
      } catch (err) {
        setError(errorText(err));
        setIssues(issuesOf(err));
        setBusy(false);
      }
    },
    [poll]
  );

  const cancel = useCallback(async () => {
    if (!simulation) return;
    try {
      const response = await cancelGuardSimulation(simulation.id);
      if (timer.current) clearTimeout(timer.current);
      setSimulation(response.simulation);
      if (simulationFinished(response.simulation)) setBusy(false);
    } catch (err) {
      setError(errorText(err));
    }
  }, [simulation]);

  return { simulation, busy, error, issues, lost, start, retry, cancel };
}

export function GuardSimulationCard({
  simulation,
  busy,
  error,
  issues,
  lost,
  versions,
  onSimulateVersion,
  onRetry,
  onCancel,
  compared,
  emptyText,
  label = "Simulation on recent traffic"
}: {
  compared?: string;
  emptyText?: string;
  label?: string;
  simulation: GuardSimulationView | null;
  busy: boolean;
  error: string | null;
  issues: GuardFieldIssue[];
  lost?: string | null;
  versions: GuardProfileVersionView[];
  onSimulateVersion: (version: number) => void;
  onRetry?: () => void;
  onCancel?: () => void;
}) {
  const [version, setVersion] = useState<number | null>(versions[0]?.version ?? null);
  useEffect(() => {
    setVersion((current) => current ?? versions[0]?.version ?? null);
  }, [versions]);

  if (!simulation && !busy && !error && !lost) return null;
  return (
    <section className="guard-sim" aria-label={label} aria-busy={busy}>
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
      {lost && (
        <div className="settings-error guard-sim-lost" role="alert">
          {lost}{" "}
          {onRetry && (
            <button type="button" className="pg-btn small" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}
      {busy && (!simulation || !simulationFinished(simulation)) && (
        <p className="guard-sim-running" role="status">
          Simulating on recent traffic…
          {simulation?.progress && simulation.progress.total > 0 ? ` ${simulation.progress.done} of ${simulation.progress.total} runs replayed` : ""}
          {simulation?.canCancel && onCancel && (
            <>
              {" "}
              <button type="button" className="pg-btn small" onClick={onCancel}>
                Cancel
              </button>
            </>
          )}
        </p>
      )}
      {simulation && simulationFinished(simulation) && <SimulationResult simulation={simulation} {...(compared ? { compared } : {})} {...(emptyText ? { emptyText } : {})} />}
      {versions.length > 0 && (
        <details className="guard-sim-advanced">
          <summary>Advanced</summary>
          <div className="guard-sim-version">
            <label>
              <span>Simulate a saved version instead</span>
              <select aria-label="Version to simulate" value={version ?? ""} onChange={(event) => setVersion(Number(event.target.value))}>
                {versions.map((entry) => (
                  <option key={entry.version} value={entry.version}>
                    v{entry.version}
                    {entry.note ? ` · ${entry.note}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="pg-btn small" disabled={busy || version === null} onClick={() => version !== null && onSimulateVersion(version)}>
              Simulate version
            </button>
          </div>
          <p className="kb-subtle">The version you pick is compared with the current profile on the same recorded runs, so you can see what moving to (or back to) it would change.</p>
        </details>
      )}
    </section>
  );
}

export function SimulationResult({ simulation, compared, emptyText }: { simulation: GuardSimulationView; compared?: string; emptyText?: string }) {
  const summary = simulation.summary;
  if (simulation.status === "failed") {
    return (
      <div className="guard-sim-card">
        <p className="guard-sim-sentence">The simulation could not run.</p>
        {simulation.error && <p className="kb-subtle">{simulation.error}</p>}
      </div>
    );
  }
  if (simulation.status === "canceled") {
    return (
      <div className="guard-sim-card">
        <p className="guard-sim-sentence">The simulation was canceled, so it has no result.</p>
        <p className="kb-subtle">Replays for ordinary runs and gates go first, so a simulation can wait behind them. Start it again when you are ready.</p>
      </div>
    );
  }
  if (simulation.status === "interrupted") {
    return (
      <div className="guard-sim-card">
        <p className="guard-sim-sentence">The simulation was interrupted before every run was replayed, so it has no result. Start it again.</p>
        {simulation.error && <p className="kb-subtle">{simulation.error}</p>}
      </div>
    );
  }
  if (!summary || summary.runs === 0) {
    return (
      <div className="guard-sim-card guard-sim-empty">
        <p className="guard-sim-sentence">No recent runs to simulate on yet.</p>
        <p className="kb-subtle">{simulation.emptyReason ?? emptyText ?? "None of the workflows that use this profile has a recorded run."}</p>
      </div>
    );
  }
  const label = simulation.source.kind === "inline" ? "Your unsaved changes" : `Version ${simulation.source.version}`;
  const current = simulation.baseVersion !== null ? `the current profile (version ${simulation.baseVersion})` : "the current profile";
  const rows = simulationWorkflowRows(simulation.workflows ?? []);
  const detectors = topTallies(summary.byDetector);
  const dataClasses = topTallies(summary.byDataClass);
  const destinations = topTallies(summary.byDestination ?? {});
  return (
    <div className="guard-sim-card">
      <p className="guard-sim-sentence" data-testid="guard-sim-sentence">
        {summary.sentence}
      </p>
      <p className="kb-subtle">
        {compared ?? `${label} compared with ${current} on these runs.`} Each run was replayed twice from its recording, so nothing called a model.
      </p>
      <div className="guard-sim-chips">
        <span className={summary.runsNewlyBlocked > 0 ? "guard-chip guard-chip-lock" : "guard-chip"}>{summary.runsNewlyBlocked} newly blocked</span>
        <span className={summary.runsNowMasked > 0 ? "guard-chip guard-chip-profile" : "guard-chip"}>{summary.runsNowMasked} now masked</span>
        <span className={summary.runsNoLongerBlocked > 0 ? "guard-chip guard-chip-warn" : "guard-chip"}>{summary.runsNoLongerBlocked} no longer blocked</span>
        <span className="guard-chip guard-chip-ok">{summary.runsUnchanged} unchanged</span>
        {summary.diverged > 0 && <span className="guard-chip guard-chip-warn">{summary.diverged} diverged</span>}
        {summary.notSimulated > 0 && <span className="guard-chip guard-chip-shadow">{summary.notSimulated} not simulated</span>}
      </div>
      {simulation.error && <p className="kb-subtle">{simulation.error}</p>}
      <details className="guard-sim-details">
        <summary>Details</summary>
        {(detectors.length > 0 || dataClasses.length > 0 || destinations.length > 0) && (
          <div className="guard-sim-tallies">
            {destinations.length > 0 && (
              <div>
                <h5>By destination</h5>
                <ul aria-label="By destination">
                  {destinations.map((entry) => (
                    <li key={entry.key}>
                      {entry.key} {tallyText(entry.tally)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {dataClasses.length > 0 && (
              <div>
                <h5>By data class</h5>
                <ul>
                  {dataClasses.map((entry) => (
                    <li key={entry.key}>
                      <code>{entry.key}</code> {tallyText(entry.tally)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {detectors.length > 0 && (
              <div>
                <h5>By detector</h5>
                <ul>
                  {detectors.map((entry) => (
                    <li key={entry.key}>
                      <code>{entry.key}</code> {tallyText(entry.tally)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <div className="mcp-table-scroll">
          <table className="kb-table guard-sim-table">
            <thead>
              <tr>
                <th>Workflow</th>
                <th className="num">Runs</th>
                <th className="num">Newly blocked</th>
                <th className="num">Now masked</th>
                <th className="num">No longer blocked</th>
                <th className="num">Diverged</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.workflowId}>
                  <td>
                    {row.workflowName}
                    {row.error && <div className="guard-cell-sub">{row.error}</div>}
                  </td>
                  <td className="num">{row.runs}</td>
                  <td className="num">{row.newlyBlocked}</td>
                  <td className="num">{row.nowMasked}</td>
                  <td className="num">{row.noLongerBlocked}</td>
                  <td className="num">{row.diverged}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(simulation.workflows ?? []).map((workflow) => {
          const cases = notableCases(workflow);
          if (cases.length === 0) return null;
          return (
            <div key={workflow.workflowId} className="guard-sim-runs">
              <h5>{workflow.workflowName}</h5>
              <ul>
                {cases.map((entry) => (
                  <li key={entry.recordingId}>
                    <span className="guard-sim-run-name">{entry.recordingName}</span>
                    {entry.checkpoints.map((checkpoint, index) => (
                      <span key={index} className={`guard-sim-change guard-sim-${checkpoint.change}`}>
                        <code>{checkpointPlace(checkpoint)}</code> {changeLabel(checkpoint.change)} ({actionTransition(checkpoint)})
                      </span>
                    ))}
                    {divergenceText(entry) && <span className="guard-sim-change guard-sim-diverged">{divergenceText(entry)}</span>}
                    {entry.outcome === "not_simulated" && entry.reason && <span className="guard-cell-sub">{entry.reason}</span>}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </details>
    </div>
  );
}

function tallyText(tally: { newlyBlocked: number; noLongerBlocked: number; actionChanged: number }): string {
  const parts: string[] = [];
  if (tally.newlyBlocked) parts.push(`${tally.newlyBlocked} newly blocked`);
  if (tally.noLongerBlocked) parts.push(`${tally.noLongerBlocked} no longer blocked`);
  if (tally.actionChanged) parts.push(`${tally.actionChanged} changed`);
  return parts.join(", ");
}
