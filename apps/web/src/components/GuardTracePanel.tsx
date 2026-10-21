import { useEffect, useMemo, useState } from "react";
import type { GuardEventView } from "@ai-orchestrator/shared";
import { fetchExecutionGuardEvents } from "../lib/api";
import {
  actionLabel,
  channelLabel,
  extractGuardTrace,
  traceFromEvents,
  type GuardTraceNode,
  type GuardTraceVerdict
} from "../lib/guard-trace";

/**
 * Phase 12.1 — the guard verdicts of one run: per guard node and per agent
 * step, the action, a shadow badge when shadow-mode rules would have done
 * more, masked evidence, detector timings and the profiles (with version)
 * that applied. Built from node outputs; nodes with guard events but no
 * trace in their output (a failed agent) are rebuilt from the events.
 */
export function GuardTracePanel({ executionId, nodeResults }: { executionId: string; nodeResults: unknown[] }) {
  const [events, setEvents] = useState<GuardEventView[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchExecutionGuardEvents(executionId)
      .then((response) => {
        if (!cancelled) setEvents(response.events);
      })
      .catch((err: unknown) => {
        // Events only fill in nodes without a trace in their output; the trace still shows without them.
        if (!cancelled && err) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [executionId]);

  const nodes = useMemo(() => {
    const fromOutputs = extractGuardTrace(nodeResults);
    const known = new Set(fromOutputs.map((node) => node.nodeId));
    return [...fromOutputs, ...traceFromEvents(events ?? [], known)];
  }, [events, nodeResults]);

  if (nodes.length === 0) {
    return null;
  }

  const verdictCount = nodes.reduce((acc, node) => acc + node.verdicts.length, 0);
  return (
    <section className="guard-trace" aria-label="Guard verdicts">
      <header className="guard-trace-head">
        <span className="pg-eyebrow">Guard</span>
        <span className="guard-trace-count">
          {verdictCount} verdict{verdictCount === 1 ? "" : "s"} · {nodes.length} node{nodes.length === 1 ? "" : "s"}
        </span>
      </header>
      {nodes.map((node) => (
        <GuardTraceNodeCard key={node.nodeId} node={node} />
      ))}
    </section>
  );
}

function sourceLabel(source: string | undefined): string | null {
  switch (source) {
    case "port":
      return "guard port";
    case "enforced":
      return "enforced by project";
    case "workflow":
      return "workflow binding";
    case "project":
      return "project binding";
    case "instance":
      return "instance default";
    case "none":
      return "no profile";
    default:
      return source ?? null;
  }
}

function GuardTraceNodeCard({ node }: { node: GuardTraceNode }) {
  const source = sourceLabel(node.source);
  return (
    <div className="guard-trace-node">
      <div className="guard-trace-node-head">
        <span className="mono-cell">{node.nodeId}</span>
        <span className="guard-chip guard-chip-muted">{node.placement === "agent" ? "agent" : "guard node"}</span>
        {source && <span className="guard-chip guard-chip-muted">{source}</span>}
        {node.profiles.map((profile) => (
          <span key={`${profile.profileId}@${profile.version}`} className="guard-chip guard-chip-profile" title={profile.hash ? `hash ${profile.hash}` : undefined}>
            {profile.name ?? profile.profileId} v{profile.version}
          </span>
        ))}
        {node.spotlighting && <span className="guard-chip guard-chip-muted">spotlighting: {node.spotlighting}</span>}
        {node.canary && <span className="guard-chip guard-chip-muted">canary planted</span>}
      </div>
      <ol className="guard-trace-verdicts">
        {node.verdicts.map((verdict) => (
          <GuardVerdictRow key={verdict.key} verdict={verdict} />
        ))}
      </ol>
    </div>
  );
}

function GuardVerdictRow({ verdict }: { verdict: GuardTraceVerdict }) {
  const [open, setOpen] = useState(verdict.action !== "allow");
  const showShadow = verdict.shadowAction !== "allow" && verdict.shadowAction !== verdict.action;
  const slowest = [...verdict.timings].sort((a, b) => b.durationMs - a.durationMs).slice(0, 4);
  return (
    <li className={`guard-verdict guard-verdict-${verdict.action}`}>
      <button type="button" className="guard-verdict-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="execution-row-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        {typeof verdict.iteration === "number" && <span className="mono-cell guard-verdict-step">step {verdict.iteration}</span>}
        <span className="guard-verdict-channel">{channelLabel(verdict.channel)}</span>
        {verdict.toolName && <span className="mono-cell guard-verdict-tool">{verdict.toolName}</span>}
        <span className={`guard-action guard-action-${verdict.action}`}>{actionLabel(verdict.action)}</span>
        {verdict.approved && <span className="guard-chip guard-chip-ok">approved</span>}
        {showShadow && (
          <span className="guard-chip guard-chip-shadow" title="Shadow-mode rules are recorded but not enforced">
            shadow: would {actionLabel(verdict.shadowAction).toLowerCase()}
          </span>
        )}
        {verdict.budgetExceeded && (
          <span className="guard-chip guard-chip-warn" title={`Skipped by the latency budget: ${verdict.skippedDetectors.join(", ") || "none"}`}>
            budget exceeded
          </span>
        )}
        <span className="mono-cell guard-verdict-latency">{verdict.latencyMs} ms</span>
      </button>
      {open && (
        <div className="guard-verdict-body">
          {verdict.findings.length === 0 ? (
            <p className="guard-verdict-clean">No findings.</p>
          ) : (
            <ul className="guard-findings">
              {verdict.findings.map((finding, index) => (
                <li key={`${finding.detectorId}-${index}`} className="guard-finding">
                  <span className="mono-cell">{finding.detectorId}</span>
                  <span className="guard-chip guard-chip-muted">
                    {finding.category}
                    {finding.dataClass ? ` / ${finding.dataClass}` : ""}
                  </span>
                  <span className="mono-cell">score {finding.score.toFixed(2)}</span>
                  {finding.effective && (
                    <span className={`guard-action guard-action-${finding.effective}`}>
                      {actionLabel(finding.effective)}
                      {finding.requested && finding.requested !== finding.effective ? ` (asked ${actionLabel(finding.requested).toLowerCase()})` : ""}
                    </span>
                  )}
                  {finding.shadow && <span className="guard-chip guard-chip-shadow">shadow</span>}
                  {finding.evidence && <code className="guard-evidence">{finding.evidence}</code>}
                  {finding.message && <span className="guard-finding-message">{finding.message}</span>}
                </li>
              ))}
            </ul>
          )}
          {slowest.length > 0 && (
            <div className="guard-timings" aria-label="Detector timings">
              {slowest.map((timing) => (
                <span key={timing.detectorId} className={`guard-timing guard-timing-${timing.status}`}>
                  {timing.detectorId} <b>{timing.durationMs} ms</b>
                  {timing.status !== "ran" ? ` · ${timing.status.replace(/_/g, " ")}` : ""}
                </span>
              ))}
            </div>
          )}
          {verdict.skippedDetectors.length > 0 && (
            <p className="guard-verdict-note">Skipped by the latency budget: {verdict.skippedDetectors.join(", ")}</p>
          )}
        </div>
      )}
    </li>
  );
}
