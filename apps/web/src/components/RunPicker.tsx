import { useEffect, useId, useState } from "react";
import { fetchExecutions, inBackground, type ExecutionHistorySummary } from "../lib/api";

/** Runs listed in the picker. */
export const RUN_PICKER_LIMIT = 10;

export function describeRun(run: { startedAt: string; status: string; triggerType?: string | null }, now = new Date()): string {
  const started = new Date(run.startedAt);
  const valid = Number.isFinite(started.getTime());
  const sameDay = valid && started.toDateString() === now.toDateString();
  const when = !valid ? "unknown time" : sameDay ? started.toLocaleTimeString() : started.toLocaleString();
  return [when, run.status, run.triggerType ?? undefined].filter(Boolean).join(" · ");
}

interface RunPickerProps {
  workflowId: string;
  /** False for a workflow that is not saved yet: it has no run history. */
  enabled: boolean;
  /** The run shown on the canvas now. */
  current: { executionId?: string; startedAt: string; status: string } | null;
  busy?: boolean;
  /** The workflow is shared only with you: the list holds only your own runs. */
  ownRunsOnly?: boolean;
  /** `isLatest` is true for the newest run in the list. */
  onPick: (executionId: string, isLatest: boolean) => void;
}

/** Which run's data the canvas and inspector show: the current one or one of the workflow's recent runs. */
export function RunPicker({ workflowId, enabled, current, busy, ownRunsOnly, onPick }: RunPickerProps) {
  const [runs, setRuns] = useState<ExecutionHistorySummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const id = useId();
  const currentId = current?.executionId;
  const currentStatus = current?.status;

  // Another workflow's runs must never be offered, not even while this one's list loads.
  useEffect(() => {
    setRuns([]);
    setError(null);
  }, [workflowId]);

  useEffect(() => {
    if (!enabled) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    inBackground(() => fetchExecutions({ page: 1, pageSize: RUN_PICKER_LIMIT, workflowId }))
      .then((response) => {
        if (cancelled) return;
        setRuns(response.items);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not list runs");
      });
    return () => {
      cancelled = true;
    };
    // A finished or newly loaded run refreshes the list, and so does opening it.
  }, [enabled, workflowId, currentId, currentStatus, refreshKey]);

  if (!enabled || (runs.length === 0 && !current)) return null;
  const listed = Boolean(currentId && runs.some((run) => run.id === currentId));
  const value = currentId ?? "__current__";
  return (
    <label
      className="run-picker"
      htmlFor={id}
      title={
        ownRunsOnly
          ? "Which run's data the canvas and the node inspector show. This workflow is shared with you, so only your own runs are listed."
          : "Which run's data the canvas and the node inspector show"
      }
    >
      <span className="run-picker-label">{ownRunsOnly ? "Your runs" : "Run data"}</span>
      <select
        id={id}
        className="run-picker-select"
        value={value}
        disabled={busy}
        onFocus={() => setRefreshKey((key) => key + 1)}
        onChange={(event) => {
          const picked = event.target.value;
          if (picked === "__current__") return;
          const isLatest = runs[0]?.id === picked;
          if (picked !== currentId || isLatest) onPick(picked, isLatest);
        }}
      >
        {current && !listed ? <option value={value}>This run · {describeRun(current)}</option> : null}
        {!current ? <option value="__current__">No run loaded</option> : null}
        {runs.map((run, index) => (
          <option key={run.id} value={run.id}>
            {index === 0 ? "Latest · " : ""}
            {describeRun(run)}
          </option>
        ))}
      </select>
      {error ? (
        <span className="run-picker-error" role="status">
          {error}
        </span>
      ) : null}
    </label>
  );
}
