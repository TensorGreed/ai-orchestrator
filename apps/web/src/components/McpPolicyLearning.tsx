/**
 * Phase 12.4 — policies learned from real runs (admin only), shown on the MCP "Policies" view:
 *
 * - SimulationReport: what a draft did to the recorded calls of the last 7 or 30 days, by bucket, rule and workflow
 *   or client, with example calls that show their argument SUMMARY only. Undetermined calls (the summary cannot say)
 *   are counted apart, never as allowed or denied.
 * - PolicySimulatePanel: "What would this have done in the last 7 days?" for the rule being edited.
 * - PolicySuggestions: "Suggest rules", then per suggestion Preview impact, Accept (adds the rules in shadow) or
 *   Dismiss; accepted suggestions show their shadow hits and Enforce.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  McpPolicyShadowHits,
  McpPolicySimulationBucketName,
  McpPolicySimulationRequest,
  McpPolicySimulationResult,
  McpPolicySuggestion,
  McpPolicySuggestionGenerateResult,
  McpToolPolicyRule,
  ToolArgumentSummary
} from "@ai-orchestrator/shared";
import {
  ApiError,
  decideMcpPolicySuggestion,
  fetchMcpPolicySuggestions,
  generateMcpPolicySuggestions,
  simulateMcpToolPolicies
} from "../lib/api";
import { describeConditions } from "./McpPolicyConditionsEditor";

const BUCKET_LABELS: Record<McpPolicySimulationBucketName, string> = {
  newly_denied: "Newly denied",
  newly_needs_approval: "Newly needs approval",
  no_longer_denied: "No longer denied",
  no_longer_needs_approval: "No longer needs approval",
  unchanged: "Unchanged",
  undetermined: "Undetermined",
  not_summarised: "Not summarised"
};

const BUCKET_HELP: Partial<Record<McpPolicySimulationBucketName, string>> = {
  undetermined: "The argument summary cannot say how the draft decides these calls (for example a hashed or dropped value).",
  not_summarised: "Recorded without an argument summary (summaries were off, or the call predates them)."
};

const BUCKET_ORDER: McpPolicySimulationBucketName[] = [
  "newly_denied",
  "newly_needs_approval",
  "no_longer_denied",
  "no_longer_needs_approval",
  "undetermined",
  "not_summarised",
  "unchanged"
];

const EFFECT_WORDS: Record<string, string> = { allow: "allowed", deny: "denied", require_approval: "needs approval" };

/** Days without a shadow change before a rule reads as ready to enforce (matches the API). */
export const ENFORCE_QUIET_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** One line per summarised argument: kept values, or what is known about the others. Never a raw argument. */
export function summaryLines(summary: ToolArgumentSummary | null): string[] {
  if (!summary) return [];
  const lines = Object.entries(summary.fields).map(([path, field]) => {
    const parts: string[] = [];
    if (field.values?.length) parts.push(field.values.map((value) => JSON.stringify(value)).join(", "));
    if (field.hashes?.length) parts.push(`${field.hashes.length} hashed value${field.hashes.length === 1 ? "" : "s"}`);
    if (field.prefixes?.length) parts.push(`prefix ${field.prefixes.join(", ")}`);
    if (field.classes?.length) parts.push(`contains ${field.classes.join(", ")}`);
    if (field.len) parts.push(`text of ${field.len} chars`);
    if (field.mag !== undefined) parts.push(`number around 1e${field.mag}`);
    if (field.items !== undefined) parts.push(`${field.items} items`);
    if (field.keys !== undefined) parts.push(`${field.keys} keys`);
    if (field.more) parts.push("too many values to keep");
    if (field.adj) parts.push("kept in a normalised form");
    if (parts.length === 0) parts.push(field.type);
    return `${path}: ${parts.join("; ")}`;
  });
  if (summary.truncated) lines.push("(summary truncated)");
  return lines;
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function SimulationReport({ result, ruleNames }: { result: McpPolicySimulationResult; ruleNames?: Map<string, string> }) {
  const [open, setOpen] = useState<McpPolicySimulationBucketName | null>(null);
  const changedRules = result.rules.filter(
    (row) => row.newlyDenied + row.newlyNeedsApproval + row.noLongerDenied + row.noLongerNeedsApproval + row.undetermined > 0
  );
  const name = (id: string | null) => (id ? ruleNames?.get(id) ?? result.rules.find((row) => row.ruleId === id)?.name ?? id : "default");
  return (
    <div className="mcp-sim-report" aria-label="Simulation result">
      <p className="kb-subtle">
        {result.scanned.toLocaleString()} calls from the last {result.windowDays} days.
        {result.capped && (
          <strong>
            {" "}
            {result.cappedReason === "work_budget"
              ? `Stopped early: these rules need more evaluation work than one simulation may do. Only calls since ${result.oldestScannedAt ? when(result.oldestScannedAt) : "the newest"} were read; narrow it with fewer rules or a filter.`
              : `Stopped at ${result.scanCap.toLocaleString()} calls: only calls since ${result.oldestScannedAt ? when(result.oldestScannedAt) : "the newest"} were read.`}
          </strong>
        )}
      </p>
      <ul className="mcp-sim-buckets">
        {BUCKET_ORDER.map((bucket) => (
          <li key={bucket} className={`mcp-sim-bucket mcp-sim-${bucket}`}>
            <button
              type="button"
              className="pg-btn ghost"
              aria-expanded={open === bucket}
              disabled={result.counts[bucket] === 0}
              onClick={() => setOpen(open === bucket ? null : bucket)}
              title={BUCKET_HELP[bucket]}
            >
              <span className="mcp-sim-count">{result.counts[bucket].toLocaleString()}</span> {BUCKET_LABELS[bucket]}
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <div className="mcp-sim-examples">
          <h5>
            {BUCKET_LABELS[open]}: {result.examples[open].length < result.counts[open] ? `first ${result.examples[open].length} of ` : ""}
            {result.counts[open].toLocaleString()}
          </h5>
          {BUCKET_HELP[open] && <p className="kb-subtle">{BUCKET_HELP[open]}</p>}
          <ul aria-label={`${BUCKET_LABELS[open]} examples`}>
            {result.examples[open].map((example) => (
              <li key={example.callId} className="mcp-sim-example">
                <div>
                  <code>{example.toolName}</code> on {example.serverName ?? example.serverId} ·{" "}
                  {example.source === "gateway" ? `client ${example.clientName ?? example.clientId ?? "unknown"}` : `workflow ${example.workflowName ?? example.workflowId}`}
                  {example.role ? ` · ${example.role}` : ""} · {when(example.startedAt)}
                </div>
                {(example.currentEffect || example.draftEffect) && (
                  <div className="kb-subtle">
                    Now {example.currentEffect ? EFFECT_WORDS[example.currentEffect] : "undetermined"} ({name(example.currentRuleId)}), draft{" "}
                    {example.draftEffect ? EFFECT_WORDS[example.draftEffect] : "undetermined"} ({name(example.draftRuleId)})
                  </div>
                )}
                {example.reason && <div className="kb-subtle">{example.reason}</div>}
                {example.summary && (
                  <ul className="mcp-sim-summary" aria-label="Argument summary">
                    {summaryLines(example.summary).map((line) => (
                      <li key={line}>
                        <code>{line}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {changedRules.length > 0 && (
        <table className="mcp-sim-table">
          <caption>By rule</caption>
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Matched</th>
              <th scope="col">Newly denied</th>
              <th scope="col">Newly needs approval</th>
              <th scope="col">No longer blocked</th>
              <th scope="col">Undetermined</th>
            </tr>
          </thead>
          <tbody>
            {changedRules.map((row) => (
              <tr key={row.ruleId}>
                <td>
                  {row.name ?? row.ruleId}
                  {row.presence === "current" ? " (removed)" : row.presence === "draft" ? " (new)" : ""}
                </td>
                <td>{row.matched}</td>
                <td>{row.newlyDenied}</td>
                <td>{row.newlyNeedsApproval}</td>
                <td>{row.noLongerDenied + row.noLongerNeedsApproval}</td>
                <td>{row.undetermined}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result.groups.length > 0 && (
        <table className="mcp-sim-table">
          <caption>By workflow or gateway client{result.groupsCapped ? " (the 100 with the most changes)" : ""}</caption>
          <thead>
            <tr>
              <th scope="col">Caller</th>
              <th scope="col">Newly denied</th>
              <th scope="col">Newly needs approval</th>
              <th scope="col">No longer blocked</th>
              <th scope="col">Undetermined</th>
              <th scope="col">Unchanged</th>
            </tr>
          </thead>
          <tbody>
            {result.groups.slice(0, 20).map((group) => (
              <tr key={`${group.kind}:${group.id}`}>
                <td>
                  {group.kind === "client" ? "Client " : ""}
                  {group.name ?? group.id}
                </td>
                <td>{group.counts.newly_denied}</td>
                <td>{group.counts.newly_needs_approval}</td>
                <td>{group.counts.no_longer_denied + group.counts.no_longer_needs_approval}</td>
                <td>{group.counts.undetermined}</td>
                <td>{group.counts.unchanged}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** "What would this have done?" for a draft built on demand (null when the form has an error, shown by the caller). */
export function PolicySimulatePanel({ buildRequest }: { buildRequest: () => Omit<McpPolicySimulationRequest, "windowDays"> | { error: string } }) {
  const [windowDays, setWindowDays] = useState<7 | 30>(7);
  const [result, setResult] = useState<McpPolicySimulationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    const request = buildRequest();
    if ("error" in request) {
      setError(request.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult((await simulateMcpToolPolicies({ ...request, windowDays })).simulation);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcp-sim-panel" aria-label="Simulate rule">
      <div className="mcp-sim-panel-head">
        <button type="button" className="pg-btn ghost" onClick={() => void run()} disabled={busy}>
          {busy ? "Simulating…" : `What would this have done in the last ${windowDays} days?`}
        </button>
        <label className="mcp-sim-window">
          Window
          <select aria-label="Simulation window" value={windowDays} onChange={(event) => setWindowDays(Number(event.target.value) === 30 ? 30 : 7)}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </label>
      </div>
      <p className="kb-subtle">
        Replays nothing: compares the rule, as if enforced, with the current rules on the calls recorded in that window, from
        their argument summaries.
      </p>
      {error && <div className="settings-error">{error}</div>}
      {result && <SimulationReport result={result} />}
    </div>
  );
}

const SKIP_REASONS: Record<string, string> = {
  too_few_calls: "too few calls",
  would_loosen: "would loosen an existing rule",
  dismissed_before: "dismissed before",
  already_accepted: "already accepted",
  already_in_place: "already in place",
  glob_tool_name: "a tool name has a *"
};

function scopeLabel(suggestion: Pick<McpPolicySuggestion, "scopeKind" | "scopeName" | "scopeId">): string {
  return `${suggestion.scopeKind === "client" ? "Gateway client" : "Workflow"} ${suggestion.scopeName ?? suggestion.scopeId}`;
}

function generationText(result: McpPolicySuggestionGenerateResult): string {
  if (result.notGenerated === "scan_capped") {
    return `Nothing suggested: the last ${result.windowDays} days hold more than ${result.scanned.toLocaleString()} calls, more than one scan reads, and rules are never suggested from part of the calls (a tool used earlier would be denied).`;
  }
  const parts = [`Read ${result.scanned.toLocaleString()} calls from the last ${result.windowDays} days`];
  if (result.capped) parts.push("stopped at the scan cap, so the oldest calls were not read");
  parts.push(`${result.created} new, ${result.updated} changed, ${result.unchanged} unchanged`);
  const reasons = new Map<string, number>();
  for (const skip of result.skipped) reasons.set(skip.reason, (reasons.get(skip.reason) ?? 0) + 1);
  if (reasons.size > 0) {
    parts.push(`no suggestion for ${[...reasons].map(([reason, count]) => `${count} (${SKIP_REASONS[reason] ?? reason})`).join(", ")}`);
  }
  return `${parts.join("; ")}.`;
}

export function PolicySuggestions({
  rules,
  shadowHits,
  onRulesChanged
}: {
  rules: McpToolPolicyRule[];
  shadowHits: McpPolicyShadowHits | null;
  onRulesChanged: () => void;
}) {
  const [open, setOpen] = useState<McpPolicySuggestion[]>([]);
  const [accepted, setAccepted] = useState<McpPolicySuggestion[]>([]);
  const [generated, setGenerated] = useState<McpPolicySuggestionGenerateResult | null>(null);
  const [previews, setPreviews] = useState<Record<string, McpPolicySimulationResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Accepted suggestions still in shadow, however old: the newest-first list is capped.
      const [openResult, acceptedResult] = await Promise.all([fetchMcpPolicySuggestions("open"), fetchMcpPolicySuggestions("accepted", { inShadow: true })]);
      setOpen(openResult.suggestions);
      setAccepted(acceptedResult.suggestions);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const generate = () =>
    act("generate", async () => {
      const { result } = await generateMcpPolicySuggestions();
      setGenerated(result);
      await load();
    });

  const preview = (suggestion: McpPolicySuggestion) =>
    act(`preview:${suggestion.id}`, async () => {
      const draft = [
        ...rules.map((rule) => ({ keep: rule.id })),
        ...suggestion.rules.map((rule) => ({ ...rule, mode: "enforce" as const }))
      ];
      const { simulation } = await simulateMcpToolPolicies({ windowDays: 30, rules: draft, filters: { serverId: suggestion.serverId } });
      setPreviews((current) => ({ ...current, [suggestion.id]: simulation }));
    });

  const decide = (suggestion: McpPolicySuggestion, action: "accept" | "dismiss" | "enforce") =>
    act(`${action}:${suggestion.id}`, async () => {
      if (action === "enforce") {
        const quiet = enforceReadiness(suggestion, shadowHits);
        if (!quiet.ready && !window.confirm(`${quiet.text} Enforce these rules anyway?`)) return;
      }
      await decideMcpPolicySuggestion(suggestion.id, action, suggestion.fingerprint);
      await load();
      if (action !== "dismiss") onRulesChanged();
    });

  const pendingEnforce = accepted.filter((suggestion) =>
    suggestion.acceptedRuleIds.some((id) => rules.find((rule) => rule.id === id)?.mode === "shadow")
  );

  return (
    <section className="kb-section mcp-suggestions" aria-label="Rule suggestions">
      <div className="mcp-section-head">
        <h4>Least privilege from real runs</h4>
        <button type="button" className="pg-btn" onClick={() => void generate()} disabled={busy !== null}>
          {busy === "generate" ? "Suggesting…" : "Suggest rules"}
        </button>
      </div>
      <p className="kb-subtle">
        Proposes, per workflow and gateway client with at least 20 calls in the last 30 days, an allow for each tool it used
        and a deny for the other tools on that server. Never for admins, never from playground calls. Accepting adds the
        rules in shadow mode; enforce them once they stop changing outcomes.
      </p>
      {error && <div className="settings-error">{error}</div>}
      {generated && (
        <p className="kb-subtle" role="status">
          {generationText(generated)}
        </p>
      )}
      {open.length === 0 && pendingEnforce.length === 0 && <p className="kb-subtle">No open suggestions.</p>}
      <ul className="mcp-suggestion-list">
        {open.map((suggestion) => (
          <li key={suggestion.id} className="mcp-suggestion" aria-label={`Suggestion for ${scopeLabel(suggestion)}`}>
            <div className="mcp-rule-head">
              <span className="mcp-rule-name">
                {suggestion.evidence.updates ? "Update accepted rules: " : ""}
                {scopeLabel(suggestion)} on {suggestion.serverName ?? suggestion.serverId}
              </span>
              <span className="mcp-flag mcp-flag-neutral">
                {suggestion.callCount} calls, {suggestion.windowDays} days
              </span>
            </div>
            {suggestion.evidence.updates && (
              <p className="kb-subtle">
                It started using {suggestion.evidence.updates.addedTools.map((tool) => `'${tool}'`).join(", ")} after its suggested rules were accepted. Accepting
                adds {suggestion.evidence.updates.addedTools.length === 1 ? "an allow" : "allows"} in shadow next to them, so the accepted deny does not block{" "}
                {suggestion.evidence.updates.addedTools.length === 1 ? "it" : "them"}.
              </p>
            )}
            <ul className="mcp-suggestion-rules" aria-label="Suggested rules">
              {suggestion.rules.map((rule, index) => (
                <li key={index}>
                  <strong>{rule.effect === "allow" ? "Allow" : "Deny"}</strong> <code>{rule.effect === "deny" ? "every other tool" : rule.toolPattern}</code>
                  {describeConditions(rule.conditions) && (
                    <>
                      {" "}
                      when <code>{describeConditions(rule.conditions)}</code>
                    </>
                  )}
                </li>
              ))}
            </ul>
            <details className="mcp-suggestion-evidence">
              <summary>Evidence</summary>
              <p className="kb-subtle">
                Built from {suggestion.evidence.calls} calls that reached the server (of {suggestion.evidence.scopeCalls} recorded), by{" "}
                {suggestion.evidence.roles.join(", ") || "no role"}.
                {suggestion.evidence.unknownRoleCalls ? ` ${suggestion.evidence.unknownRoleCalls} of them had no recorded role.` : ""}
                {suggestion.evidence.capped ? " The scan stopped at its cap; older calls were not read." : ""}
                {suggestion.evidence.inlineAdapter
                  ? ` The server is configured inline on nodes, so these rules apply to every inline server of the '${suggestion.serverId}' adapter, with their tools taken together.`
                  : ""}
              </p>
              <ul>
                {suggestion.evidence.tools.map((tool) => (
                  <li key={tool.toolName}>
                    <code>{tool.toolName}</code>: {tool.calls} calls
                    {tool.constraints.map((constraint) => (
                      <span key={constraint.path}>
                        {" "}
                        · {constraint.path}{" "}
                        {constraint.kind === "max" ? `at most ${constraint.limit} (seen up to ${constraint.observedMax})` : `one of ${constraint.values?.map((value) => JSON.stringify(value)).join(", ")}`}
                      </span>
                    ))}
                    {tool.skipped.length > 0 && (
                      <span className="kb-subtle"> · no constraint on {tool.skipped.map((entry) => `${entry.path} (${entry.reason.replace(/_/g, " ")})`).join(", ")}</span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
            <div className="mcp-rule-actions">
              <button type="button" className="pg-btn ghost" onClick={() => void preview(suggestion)} disabled={busy !== null}>
                {busy === `preview:${suggestion.id}` ? "Previewing…" : "Preview impact"}
              </button>
              <button type="button" className="pg-btn primary" onClick={() => void decide(suggestion, "accept")} disabled={busy !== null}>
                Accept in shadow mode
              </button>
              <button type="button" className="pg-btn ghost" onClick={() => void decide(suggestion, "dismiss")} disabled={busy !== null}>
                Dismiss
              </button>
            </div>
            {previews[suggestion.id] && <SimulationReport result={previews[suggestion.id]!} />}
          </li>
        ))}
        {pendingEnforce.map((suggestion) => {
          const readiness = enforceReadiness(suggestion, shadowHits);
          return (
            <li key={suggestion.id} className="mcp-suggestion is-accepted" aria-label={`Accepted suggestion for ${scopeLabel(suggestion)}`}>
              <div className="mcp-rule-head">
                <span className="mcp-rule-name">
                  {scopeLabel(suggestion)} on {suggestion.serverName ?? suggestion.serverId}
                </span>
                <span className="mcp-flag mcp-flag-shadow">In shadow</span>
              </div>
              <p className="kb-subtle">{readiness.text}</p>
              <div className="mcp-rule-actions">
                <button
                  type="button"
                  className={readiness.ready ? "pg-btn primary" : "pg-btn ghost"}
                  onClick={() => void decide(suggestion, "enforce")}
                  disabled={busy !== null}
                >
                  {readiness.ready ? "Enforce suggestion" : "Enforce suggestion now"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Ready once the accepted rules, enforced together, would have changed no outcome over the last 7 days, and were in
 * shadow that long. Never ready on partial evidence (the hit scan stopped at its cap).
 */
export function enforceReadiness(
  suggestion: Pick<McpPolicySuggestion, "id" | "decidedAt">,
  shadowHits: McpPolicyShadowHits | null
): { ready: boolean; text: string } {
  const group = shadowHits?.groups.find((entry) => entry.suggestionId === suggestion.id);
  const wouldChange = group?.wouldChange ?? 0;
  const matched = group?.matched ?? 0;
  const since = suggestion.decidedAt ? Date.parse(suggestion.decidedAt) : Number.NaN;
  const days = Number.isNaN(since) ? 0 : Math.floor((Date.now() - since) / DAY_MS);
  if (!shadowHits) return { ready: false, text: "Shadow hits are not loaded yet." };
  if (shadowHits.capped) {
    return {
      ready: false,
      text: `Not ready (scan capped): the last ${ENFORCE_QUIET_DAYS} days hold more decided calls than one scan reads, so these counts are partial (${matched} calls matched, ${wouldChange} would change).`
    };
  }
  if (wouldChange > 0) {
    return { ready: false, text: `In the last ${ENFORCE_QUIET_DAYS} days these rules would have changed ${wouldChange} of the ${matched} calls they matched.` };
  }
  if (days < ENFORCE_QUIET_DAYS) {
    return {
      ready: false,
      text: `In shadow for ${days} day${days === 1 ? "" : "s"}, no outcome changed yet (${matched} calls matched). Ready after ${ENFORCE_QUIET_DAYS} quiet days.`
    };
  }
  return { ready: true, text: `No outcome changed in the last ${ENFORCE_QUIET_DAYS} days (${matched} calls matched). Ready to enforce.` };
}
