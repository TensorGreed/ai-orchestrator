/**
 * 12.7 — PostgresStore: stored content rules benchmarks (`guard_benchmarks`, v59). Each function matches the SqliteStore method
 * of the same name (shapes, newest-first order with the id as tie-break, the per-profile cap).
 */
import { mapGuardBenchmarkRow, type GuardBenchmarkStoredRecord } from "../database.js";
import type { PgContext } from "./context.js";

type Row = Record<string, unknown>;

export async function insertGuardBenchmark(ctx: PgContext, record: GuardBenchmarkStoredRecord, options: { keep: number }): Promise<void> {
  await ctx.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO guard_benchmarks (id, profile_id, profile_version, profile_hash, corpus_hash, suites_json, detection_rate, false_positive_rate, report_json, created_by, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        record.id,
        record.profileId,
        record.profileVersion,
        record.profileHash,
        record.corpusHash,
        JSON.stringify(record.suites),
        record.detectionRate,
        record.falsePositiveRate,
        JSON.stringify(record.report),
        record.createdBy,
        record.createdByUserId,
        record.createdAt
      ]
    );
    // Keep the rule set's newest `keep` benchmarks.
    await client.query(
      `DELETE FROM guard_benchmarks WHERE profile_id = $1 AND id NOT IN (
         SELECT id FROM guard_benchmarks WHERE profile_id = $1 ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT $2
       )`,
      [record.profileId, Math.max(1, options.keep)]
    );
  });
}

export async function listGuardBenchmarks(ctx: PgContext, options: { profileId: string; limit?: number }): Promise<GuardBenchmarkStoredRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const rows = await ctx.query<Row>(`SELECT * FROM guard_benchmarks WHERE profile_id = $1 ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT $2`, [options.profileId, limit]);
  return rows.map(mapGuardBenchmarkRow);
}

export async function getGuardBenchmark(ctx: PgContext, id: string): Promise<GuardBenchmarkStoredRecord | null> {
  const row = await ctx.queryOne<Row>(`SELECT * FROM guard_benchmarks WHERE id = $1`, [id]);
  return row ? mapGuardBenchmarkRow(row) : null;
}
