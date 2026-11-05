/**
 * 12.7 — Security > Benchmark: the red-team corpus that ships with L2M run
 * through a rule set, with detection and false-positive rates per
 * category on the main and held-out splits, the reference workflow suite's
 * attack success, and the trend over the rule set's stored benchmarks.
 *
 * Builders and admins run a benchmark of a rule set's latest saved version
 * (stored); everyone else reads the stored results. A benchmark calls no
 * model and touches no workflow, and nothing it does shows up in the
 * Overview's numbers. The rule set editor's "Benchmark this draft" uses
 * `GuardBenchmarkResultCard` for the unsaved document.
 */

import { useCallback, useEffect, useState } from "react";
import type { GuardBenchmarkListEntry, GuardBenchmarkReport, GuardBenchmarkResponse, GuardProfileSummary } from "@ai-orchestrator/shared";
import { ApiError, fetchGuardBenchmark, fetchGuardBenchmarks, fetchGuardProfiles, runGuardBenchmark } from "../lib/api";
import { benchmarkCategoryRows, benchmarkComparisonLine, benchmarkTrend, canRunBenchmark, percent } from "../lib/guard-benchmark";

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

const fraction = (count: number, of: number) => `${count}/${of}`;

export function GuardBenchmarkView({ role }: { role: string }) {
  const [profiles, setProfiles] = useState<GuardProfileSummary[]>([]);
  const [profileId, setProfileId] = useState("");
  const [history, setHistory] = useState<GuardBenchmarkListEntry[]>([]);
  const [report, setReport] = useState<GuardBenchmarkReport | null>(null);
  const [lastRun, setLastRun] = useState<GuardBenchmarkResponse | null>(null);
  const [withWorkflow, setWithWorkflow] = useState(false);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mayRun = canRunBenchmark(role);

  useEffect(() => {
    fetchGuardProfiles()
      .then((response) => {
        setProfiles(response.profiles);
        setProfileId((current) => current || response.builtInId || response.profiles[0]?.id || "");
      })
      .catch((err) => setError(errorText(err)));
  }, []);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true);
    try {
      const list = (await fetchGuardBenchmarks(id)).benchmarks;
      setHistory(list);
      setReport(list[0] ? (await fetchGuardBenchmark(list[0].id)).report : null);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLastRun(null);
    void load(profileId);
  }, [load, profileId]);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const response = await runGuardBenchmark(profileId, { suites: withWorkflow ? ["profile", "workflow"] : ["profile"] });
      setLastRun(response);
      setReport(response.report);
      setHistory((await fetchGuardBenchmarks(profileId)).benchmarks);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRunning(false);
    }
  };

  const profile = profiles.find((entry) => entry.id === profileId);
  return (
    <div className="guard-overview guard-bench" aria-busy={loading || running}>
      <p className="kb-subtle guard-bench-intro">
        A labelled corpus of attacks and realistic look-alikes, in eleven categories mapped to the OWASP Top 10 for LLM applications. The held-out split was written apart from
        the detectors, so it shows how well they generalise. A benchmark calls no model, reads no workflow data and never shows up in the Overview.
      </p>
      <div className="guard-filters" role="group" aria-label="Benchmark">
        <label>
          <span>Rule set</span>
          <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
            {profiles.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        {mayRun && (
          <>
            <label className="guard-inline-check">
              <input type="checkbox" checked={withWorkflow} onChange={(event) => setWithWorkflow(event.target.checked)} /> Include the reference workflow suite
            </label>
            <button
              type="button"
              className="pg-btn primary"
              disabled={!profileId || running}
              onClick={() => void run()}
              title={`Run the corpus through the latest saved version${profile ? ` (v${profile.latestVersion})` : ""} and store the result`}
            >
              {running ? "Benchmarking…" : "Run benchmark"}
            </button>
          </>
        )}
      </div>

      {error && <div className="settings-error">{error}</div>}
      {lastRun && (
        <p className={lastRun.comparison && !lastRun.comparison.ok ? "guard-bench-compare guard-bench-regressed" : "guard-bench-compare"} role="status">
          {benchmarkComparisonLine(lastRun.comparison, lastRun.baseline)}
        </p>
      )}
      {lastRun?.comparison && lastRun.comparison.failures.length > 0 && (
        <ul className="guard-bench-failures" aria-label="Regressions">
          {lastRun.comparison.failures.map((failure) => (
            <li key={`${failure.category}-${failure.split}-${failure.metric}`}>{failure.message}</li>
          ))}
        </ul>
      )}

      {!report && !loading && (
        <div className="guard-sim-card guard-sim-empty">
          <p className="guard-sim-sentence">No benchmark of this rule set yet.</p>
          <p className="kb-subtle">{mayRun ? "Run one to measure it; it takes a few seconds." : "A builder or an admin can run one."}</p>
        </div>
      )}
      {report && <GuardBenchmarkReportView report={report} />}
      {history.length > 0 && <BenchmarkHistory entries={history} />}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "err" | "warn" }) {
  return (
    <div className={`mcp-stat${tone ? ` guard-stat-${tone}` : ""}`}>
      <div className="mcp-stat-label">{label}</div>
      <div className="mcp-stat-value">{value}</div>
      {hint && <div className="mcp-stat-hint">{hint}</div>}
    </div>
  );
}

/** One report: totals per split, the category table and the workflow suite. */
export function GuardBenchmarkReportView({ report }: { report: GuardBenchmarkReport }) {
  const rows = benchmarkCategoryRows(report);
  const main = report.totals.find((entry) => entry.split === "main");
  const heldout = report.totals.find((entry) => entry.split === "heldout");
  const cell = (result: (typeof rows)[number]["main"], kind: "detected" | "flagged") => {
    if (!result) return <td className="num kb-subtle">–</td>;
    const ids = kind === "detected" ? result.missed : result.flagged.map((entry) => entry.id);
    const title = ids.length > 0 ? `${kind === "detected" ? "Missed" : "Flagged"}: ${ids.join(", ")}` : undefined;
    return (
      <td className="num" {...(title ? { title } : {})}>
        {kind === "detected" ? fraction(result.detected, result.attacks) : fraction(result.falsePositives, result.benign)}
      </td>
    );
  };
  return (
    <>
      <div className="mcp-stats" aria-label="Benchmark totals">
        {main && <Stat label="Detected · main" value={percent(main.detectionRate)} hint={`${fraction(main.detected, main.attacks)} attacks`} />}
        {main && <Stat label="False positives · main" value={percent(main.falsePositiveRate)} hint={`${fraction(main.falsePositives, main.benign)} benign`} {...(main.falsePositiveRate > 0.1 ? { tone: "warn" as const } : {})} />}
        {heldout && <Stat label="Detected · held-out" value={percent(heldout.detectionRate)} hint={`${fraction(heldout.detected, heldout.attacks)} attacks`} />}
        {heldout && <Stat label="False positives · held-out" value={percent(heldout.falsePositiveRate)} hint={`${fraction(heldout.falsePositives, heldout.benign)} benign`} {...(heldout.falsePositiveRate > 0.1 ? { tone: "warn" as const } : {})} />}
        <Stat label="Latency p95" value={`${report.latency.p95Ms.toFixed(1)} ms`} hint={`p50 ${report.latency.p50Ms.toFixed(1)} ms`} />
      </div>
      <p className="kb-subtle guard-bench-meta">
        {report.profile.name ?? report.profile.id} {report.profile.version === "draft" ? "(unsaved draft)" : `v${report.profile.version}`} · measured {formatWhen(report.generatedAt)} · corpus{" "}
        <code>{report.corpus.hash.slice(0, 12)}</code>
      </p>
      <section className="kb-section" aria-labelledby="guard-bench-categories">
        <div className="mcp-section-head">
          <h4 id="guard-bench-categories">By category</h4>
          <span className="kb-subtle">Hover a count for the item ids</span>
        </div>
        <div className="mcp-table-scroll">
          <table className="kb-table guard-bench-table">
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">OWASP LLM</th>
                <th scope="col" className="num">Detected · main</th>
                <th scope="col" className="num">False positives · main</th>
                <th scope="col" className="num">Detected · held-out</th>
                <th scope="col" className="num">False positives · held-out</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.category}>
                  <th scope="row">
                    {row.label}
                    <div className="guard-cell-sub">{row.channel.replace(/_/g, " ")}</div>
                  </th>
                  <td>{row.owasp.join(", ")}</td>
                  {cell(row.main, "detected")}
                  {cell(row.main, "flagged")}
                  {cell(row.heldout, "detected")}
                  {cell(row.heldout, "flagged")}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {report.workflow && (
        <section className="kb-section" aria-labelledby="guard-bench-workflow">
          <div className="mcp-section-head">
            <h4 id="guard-bench-workflow">Reference workflow suite</h4>
            <span className="kb-subtle">An agent with a document reader and two write tools, driven by a scripted model that obeys any instruction it reads</span>
          </div>
          <div className="mcp-table-scroll">
            <table className="kb-table guard-bench-table">
              <thead>
                <tr>
                  <th scope="col">Configuration</th>
                  <th scope="col">Split</th>
                  <th scope="col" className="num">Attacks that succeeded</th>
                  <th scope="col" className="num">Paused for approval</th>
                  <th scope="col" className="num">Benign runs disturbed</th>
                </tr>
              </thead>
              <tbody>
                {report.workflow.results.map((result) => (
                  <tr key={`${result.configuration}-${result.split}`}>
                    <th scope="row">{result.configuration === "guard" ? "Rule set" : "Content rules + approval for untrusted writes"}</th>
                    <td>{result.split === "heldout" ? "held-out" : result.split}</td>
                    <td className="num" {...(result.succeeded.length > 0 ? { title: `Succeeded: ${result.succeeded.join(", ")}` } : {})}>
                      {fraction(result.attackSucceeded, result.attacks)}
                    </td>
                    <td className="num">{result.pausedForApproval}</td>
                    <td className="num">{fraction(result.falsePositives, result.benign)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function BenchmarkHistory({ entries }: { entries: GuardBenchmarkListEntry[] }) {
  const trend = benchmarkTrend(entries);
  return (
    <section className="kb-section" aria-labelledby="guard-bench-history">
      <div className="mcp-section-head">
        <h4 id="guard-bench-history">Trend by version</h4>
        <span className="kb-subtle">The newest {entries.length} stored benchmark{entries.length === 1 ? "" : "s"}</span>
      </div>
      <div className="mcp-table-scroll">
        <table className="kb-table guard-bench-table" aria-label="Benchmark history">
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Measured</th>
              <th scope="col">Detected</th>
              <th scope="col">False positives</th>
              <th scope="col" className="num">Held-out detected</th>
              <th scope="col" className="num">Workflow attack success</th>
            </tr>
          </thead>
          <tbody>
            {[...trend].reverse().map((point) => (
              <tr key={point.id}>
                <th scope="row">
                  {point.label}
                  {point.corpusChanged && <div className="guard-cell-sub">corpus changed</div>}
                </th>
                <td>{formatWhen(point.createdAt)}</td>
                <td>
                  <RateBar rate={point.detectionRate} tone="ok" />
                </td>
                <td>
                  <RateBar rate={point.falsePositiveRate} tone="warn" />
                </td>
                <td className="num">{point.heldoutDetectionRate === null ? "–" : percent(point.heldoutDetectionRate)}</td>
                <td className="num">{point.attackSuccessRate === null ? "–" : percent(point.attackSuccessRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RateBar({ rate, tone }: { rate: number; tone: "ok" | "warn" }) {
  return (
    <span className="guard-bench-rate">
      <span className="guard-bench-track" aria-hidden="true">
        <i className={`guard-bench-fill guard-bench-fill-${tone}`} style={{ width: `${Math.max(0, Math.min(1, rate)) * 100}%` }} />
      </span>
      <span className="num">{percent(rate)}</span>
    </span>
  );
}

/** The rule set editor's draft result: the totals and how they compare with the latest stored benchmark. */
export function GuardBenchmarkResultCard({ result, error, busy }: { result: GuardBenchmarkResponse | null; error: string | null; busy: boolean }) {
  if (busy) return <div className="guard-sim-card" role="status">Benchmarking the draft…</div>;
  if (error) return <div className="settings-error">{error}</div>;
  if (!result) return null;
  const main = result.report.totals.find((entry) => entry.split === "main");
  const heldout = result.report.totals.find((entry) => entry.split === "heldout");
  const regressed = result.comparison !== null && !result.comparison.ok;
  return (
    <div className="guard-sim-card" data-testid="guard-bench-draft">
      <p className="guard-sim-sentence">
        {main ? `Detects ${percent(main.detectionRate)} of attacks with ${percent(main.falsePositiveRate)} false positives` : "Benchmarked"}
        {heldout ? ` (held-out: ${percent(heldout.detectionRate)} and ${percent(heldout.falsePositiveRate)}).` : "."}
      </p>
      <p className={regressed ? "guard-bench-compare guard-bench-regressed" : "kb-subtle"}>
        {benchmarkComparisonLine(result.comparison, result.baseline)} The draft was not saved and its result is not stored.
      </p>
      {regressed && (
        <ul className="guard-bench-failures" aria-label="Regressions">
          {result.comparison!.failures.map((failure) => (
            <li key={`${failure.category}-${failure.split}-${failure.metric}`}>{failure.message}</li>
          ))}
        </ul>
      )}
      <details className="guard-sim-details">
        <summary>By category</summary>
        <GuardBenchmarkReportView report={result.report} />
      </details>
    </div>
  );
}
