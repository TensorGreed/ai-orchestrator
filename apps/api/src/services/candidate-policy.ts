/**
 * Phase 15.6 — captured candidates and golden-run paths.
 *
 * A production capture is a *candidate* recording until a builder promotes
 * it. Every public golden-run path (adding to a golden set, a single replay,
 * replay jobs and estimates over golden sets, golden-set export) refuses it
 * through `candidateRefusal`. A server-internal caller that is meant to see
 * recent traffic, candidates included (a guard policy simulation), passes
 * `{ allowCandidates: true }`; nothing a request body sets reaches that flag.
 */

/** Why a candidate is refused on a golden-run path. */
export const CANDIDATE_REFUSAL = "This is a captured run waiting in the inbox; promote it from the Captured runs inbox first.";

export interface CandidatePolicy {
  /** Server-internal callers only (never from a request body). */
  allowCandidates?: boolean;
}

/** The refusal message for a recording on a golden-run path, or null when it may be used. */
export function candidateRefusal(recording: { status?: string } | null | undefined, policy: CandidatePolicy = {}): string | null {
  if (!recording || policy.allowCandidates === true) return null;
  return recording.status === "candidate" ? CANDIDATE_REFUSAL : null;
}
