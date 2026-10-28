/**
 * Phase 13.1 — runs the queue owns are never reconciled as inline runs. A live queue job (pending or running) carries
 * the execution id it runs in its payload (`executionId`); its row id differs whenever one run has several jobs (an
 * approval resume, `<executionId>:<requestId>:<decidedAt>`) or the job id is derived from something else (cron and
 * trigger dispatch ids). The guard keys on the payload's execution id, with the row id as a fallback for jobs written
 * before payloads carried it. Queue-consumed runs belong to the queue's own lease, reaper and worker-loss policy.
 */

/** LIKE patterns (backslash escape) that preselect queue rows whose payload may name one of `executionIds`. */
export function payloadExecutionIdPatterns(executionIds: readonly string[]): string[] {
  return executionIds.map((id) => `%"executionId":${JSON.stringify(id).replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
}

/**
 * The ids among `candidates` that a live queue job runs. `rows` are live queue rows (preselected or not). A payload
 * that is not valid JSON but was preselected for an id counts as holding it: skipping a reconcile is the safe side
 * (the run stays running until the long interrupted-run cutoff), failing a run the queue still owns is not.
 */
export function executionIdsHeldByQueue(
  candidates: readonly string[],
  rows: ReadonlyArray<{ id: string; payloadJson: string | null }>
): Set<string> {
  const wanted = new Set(candidates);
  const held = new Set<string>();
  for (const row of rows) {
    if (wanted.has(row.id)) held.add(row.id);
    let parsed: unknown;
    try {
      parsed = row.payloadJson ? JSON.parse(row.payloadJson) : null;
    } catch {
      for (const id of wanted) if (row.payloadJson?.includes(JSON.stringify(id))) held.add(id);
      continue;
    }
    const executionId = parsed && typeof parsed === "object" ? (parsed as { executionId?: unknown }).executionId : undefined;
    if (typeof executionId === "string" && wanted.has(executionId)) held.add(executionId);
  }
  return held;
}
