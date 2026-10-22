import type { NodeActivityEvent } from "@ai-orchestrator/shared";
import { describeActivity } from "../lib/run-trace";

type ResolvedFields = Extract<NodeActivityEvent, { kind: "resolved_input" }>["fields"];

/** The values the node used on its latest run, if it reported them. */
export function latestResolvedFields(activity: NodeActivityEvent[] | undefined): ResolvedFields | undefined {
  if (!activity) return undefined;
  for (let index = activity.length - 1; index >= 0; index -= 1) {
    const entry = activity[index]!;
    if (entry.kind === "resolved_input") return entry.fields;
  }
  return undefined;
}

function formatFieldValue(value: string | number | boolean | string[]): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/** Small key/value table of the fields a node resolved for this run. */
export function ResolvedFieldsTable({ fields }: { fields: ResolvedFields }) {
  return (
    <dl className="activity-fields" data-testid="activity-resolved-fields">
      {Object.entries(fields).map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{formatFieldValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function offsetLabel(at: string, startMs: number | null): string {
  const ms = Date.parse(at);
  if (startMs === null || !Number.isFinite(ms)) return "";
  return `+${(Math.max(ms - startMs, 0) / 1000).toFixed(1)}s`;
}

/** Step-by-step list of what a node did: time since it started, a short line, and details where there are any. */
export function NodeActivityList({ activity, startedAt }: { activity?: NodeActivityEvent[]; startedAt?: string }) {
  if (!activity || activity.length === 0) return null;
  const parsedStart = startedAt ? Date.parse(startedAt) : Number.NaN;
  const startMs = Number.isFinite(parsedStart) ? parsedStart : Date.parse(activity[0]!.at);
  return (
    <ol className="activity-list" aria-label="Activity" data-testid="node-activity">
      {activity.map((entry) => (
        <li key={entry.seq} className={`activity-item activity-${entry.kind}`}>
          <span className="activity-time">{offsetLabel(entry.at, Number.isFinite(startMs) ? startMs : null)}</span>
          <div className="activity-body">
            <span className="activity-line">{describeActivity(entry)}</span>
            {entry.kind === "resolved_input" && <ResolvedFieldsTable fields={entry.fields} />}
            {entry.kind === "tool_call" && entry.phase === "start" && entry.argsPreview && (
              <details className="activity-details">
                <summary>Arguments</summary>
                <pre className="result-block">{entry.argsPreview}</pre>
              </details>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
