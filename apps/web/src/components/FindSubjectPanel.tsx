/**
 * Phase 15.6 — Evaluations → Golden sets, admins only: find one person's
 * data in golden runs, captured runs, golden-set cases and replay results,
 * and delete it.
 *
 * Certain matches are ticked; possible matches (a phone whose national
 * digits agree but one side has no country code, so it may be another
 * person's number) are listed apart and never ticked for you. Deleting a
 * possible match sends its explicit confirmation; the server refuses it
 * otherwise.
 */

import { useState } from "react";
import { REPLAY_FIND_SUBJECT_COUNTRIES, type ReplayFindSubjectMatch, type ReplayFindSubjectQuery, type ReplayFindSubjectResult } from "@ai-orchestrator/shared";
import { ApiError, deleteReplaySubject, findReplaySubject } from "../lib/api";
import {
  splitSubjectMatches,
  subjectDeleteTargets,
  subjectKey,
  subjectKindLabel,
  subjectQuery,
  subjectReadAsOffered,
  subjectSearchedAs,
  type SubjectReadAs
} from "../lib/replay-capture";

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError || err instanceof Error) return err.message || fallback;
  return fallback;
}

export function FindSubjectPanel() {
  const [value, setValue] = useState("");
  const [readAs, setReadAs] = useState<SubjectReadAs>("text");
  const [country, setCountry] = useState("");
  const [query, setQuery] = useState<ReplayFindSubjectQuery | null>(null);
  const [result, setResult] = useState<ReplayFindSubjectResult | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const offered = subjectReadAsOffered(value);

  const search = async () => {
    if (!value.trim()) return;
    const next = subjectQuery(value, readAs, country);
    setBusy(true);
    setError(null);
    setNotice(null);
    setConfirming(false);
    try {
      const found = await findReplaySubject(next);
      setQuery(next);
      setResult(found);
      // Certain matches start ticked; possible matches never do.
      setTicked(new Set(splitSubjectMatches(found.matches).exact.map(subjectKey)));
    } catch (err) {
      setResult(null);
      setError(errorText(err, "Could not search"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!result || !query) return;
    const targets = subjectDeleteTargets(result.matches, ticked);
    if (targets.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await deleteReplaySubject(query, targets);
      const deleted = outcome.removed.length;
      const skipped = outcome.skipped.length;
      setNotice(`Deleted ${deleted} ${deleted === 1 ? "row" : "rows"}${skipped > 0 ? `; ${skipped} skipped (gone, or no longer holding the value)` : ""}.`);
      const gone = new Set(outcome.removed.map(subjectKey));
      setResult({ ...result, matches: result.matches.filter((match) => !gone.has(subjectKey(match))) });
      setTicked(new Set());
      setConfirming(false);
    } catch (err) {
      setError(errorText(err, "Could not delete"));
    } finally {
      setBusy(false);
    }
  };

  const groups = result ? splitSubjectMatches(result.matches) : null;
  const count = result ? subjectDeleteTargets(result.matches, ticked).length : 0;
  const toggle = (match: ReplayFindSubjectMatch) =>
    setTicked((current) => {
      const next = new Set(current);
      const key = subjectKey(match);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section className="release-card subject-panel" aria-labelledby="subject-title">
      <header className="release-card-head">
        <h4 id="subject-title" className="capture-inbox-title">
          Find a person's data
        </h4>
      </header>
      <p className="capture-help">
        Search golden runs, captured runs, golden-set cases and replay results for one email address, phone number, card or other value, stored as typed or masked. Nothing is
        deleted until you confirm. The value is never stored or logged.
      </p>
      <form
        className="subject-form"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <div className="cfg-field">
          <label className="cfg-label" htmlFor="subject-value">
            Value
          </label>
          <input id="subject-value" className="cfg-input" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} />
        </div>
        {offered && (
          <div className="cfg-field">
            <label className="cfg-label" htmlFor="subject-read-as">
              Read as
            </label>
            <select id="subject-read-as" className="cfg-input" value={readAs} onChange={(event) => setReadAs(event.target.value as SubjectReadAs)}>
              <option value="text">Text</option>
              <option value="phone">Phone number</option>
            </select>
          </div>
        )}
        {offered && readAs === "phone" && (
          <div className="cfg-field">
            <label className="cfg-label" htmlFor="subject-country">
              Country
            </label>
            <select id="subject-country" className="cfg-input" value={country} onChange={(event) => setCountry(event.target.value)}>
              <option value="">Unknown</option>
              {REPLAY_FIND_SUBJECT_COUNTRIES.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.name} (+{entry.callingCode})
                </option>
              ))}
            </select>
          </div>
        )}
        <button type="submit" className="pg-btn small primary" disabled={busy || !value.trim()}>
          {busy && !confirming ? "Searching…" : "Search"}
        </button>
      </form>
      {error && (
        <div className="approvals-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="approvals-notice" role="status">
          {notice}
        </div>
      )}
      {result && groups && (
        <>
          <p className="settings-help">
            {subjectSearchedAs(result)}. {result.matches.length === 0 ? "Nothing found." : `${groups.exact.length} certain, ${groups.possible.length} possible.`}
          </p>
          {groups.exact.length > 0 && (
            <div className="subject-group">
              <h5 className="subject-group-title">Matches</h5>
              <ul className="capture-list" aria-label="Matches">
                {groups.exact.map((match) => (
                  <SubjectRow key={subjectKey(match)} match={match} ticked={ticked.has(subjectKey(match))} onToggle={() => toggle(match)} />
                ))}
              </ul>
            </div>
          )}
          {groups.possible.length > 0 && (
            <div className="subject-group">
              <h5 className="subject-group-title">Possible matches (no country code in the data)</h5>
              <p className="capture-help">
                These hold the same digits without a country code, so they may be another person's number. They are not selected. Select one only after checking it is this
                person's.
              </p>
              <ul className="capture-list" aria-label="Possible matches">
                {groups.possible.map((match) => (
                  <SubjectRow key={subjectKey(match)} match={match} ticked={ticked.has(subjectKey(match))} onToggle={() => toggle(match)} />
                ))}
              </ul>
            </div>
          )}
          {result.matches.length > 0 && (
            <div className="subject-confirm">
              {!confirming ? (
                <button type="button" className="pg-btn small danger" disabled={busy || count === 0} onClick={() => setConfirming(true)}>
                  Delete selected ({count})
                </button>
              ) : (
                <>
                  <span className="capture-help" role="status">
                    Permanently delete {count} {count === 1 ? "row" : "rows"}? A golden run takes its golden-set cases and results with it.
                  </span>
                  <button type="button" className="pg-btn small danger" disabled={busy} onClick={() => void remove()}>
                    {busy ? "Deleting…" : "Delete"}
                  </button>
                  <button type="button" className="pg-btn small ghost" disabled={busy} onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </>
              )}
            </div>
          )}
          <details className="capture-advanced">
            <summary>What this searches</summary>
            <ul className="capture-help">
              {result.covered.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
            <p className="capture-help">Not searched (these follow their own retention):</p>
            <ul className="capture-help">
              {result.notCovered.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}

function SubjectRow({ match, ticked, onToggle }: { match: ReplayFindSubjectMatch; ticked: boolean; onToggle: () => void }) {
  const hit = match.hits[0];
  const stored = match.hits.find((entry) => entry.storedCallingCode)?.storedCallingCode;
  return (
    <li className="subject-row">
      <input type="checkbox" aria-label={`Select ${match.name}`} checked={ticked} onChange={onToggle} />
      <span className="subject-row-main">
        <span className="capture-row-title">{match.name}</span>
        <span className="capture-row-sub">
          {subjectKindLabel(match.kind)} · in {match.fields.join(", ")}
          {match.matchedAs.includes("raw") ? " · stored as typed" : " · stored masked"}
          {stored ? ` · stored with +${stored}` : ""}
        </span>
        {hit && <span className="subject-excerpt">{hit.excerpt}</span>}
      </span>
    </li>
  );
}
