/**
 * Phase 13.1 — PostgresStore: Knowledge bases and their chunks/search.
 * Plain functions over a PgContext; PostgresStore delegates here.
 *
 * Chunk order: SQLite lists chunks in rowid (insertion) order; Postgres lists them by `seq`, the identity column v40
 * adds (a batch is inserted in its given order, so `seq` follows it). Every chunk of a batch has the batch's time as
 * created_at, as on SQLite.
 *
 * Keyword search: SQLite ranks with FTS5 bm25(); Postgres matches the v19 `content_tsv` column (to_tsvector
 * 'english') with websearch_to_tsquery and ranks with ts_rank_cd. Both min-max normalise to 0..1, best first. The
 * query is tokenised the same way on both (lower-case [a-z0-9] runs of 2+ characters, any of them may match).
 */
import { randomUUID } from "node:crypto";
import type { KnowledgeBaseChunkRecord, KnowledgeBaseRecord } from "../database.js";
import { type Store } from "../store.js";
import { parseJsonSafe, toNum, toStr } from "./helpers.js";
import type { PgContext } from "./context.js";
import { clampLimit, LIMIT_MAX } from "../store-limits.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [];

interface KnowledgeBaseRow {
  id: string;
  name: string;
  description: string | null;
  project_id: string | null;
  embedder_id: string;
  embedder_config_json: string | null;
  dimensions: number;
  chunk_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface KnowledgeBaseChunkRow {
  id: string;
  knowledge_base_id: string;
  source_id: string | null;
  chunk_index: number;
  content: string;
  metadata_json: string | null;
  vector_json: string;
  created_at: string;
}

const KB_COLUMNS = `id, name, description, project_id, embedder_id, embedder_config_json, dimensions, chunk_count, created_by, created_at, updated_at`;

function mapKnowledgeBase(row: KnowledgeBaseRow): KnowledgeBaseRecord {
  return {
    id: toStr(row.id),
    name: toStr(row.name),
    description: row.description ? toStr(row.description) : null,
    projectId: row.project_id ? toStr(row.project_id) : null,
    embedderId: toStr(row.embedder_id),
    embedderConfig: row.embedder_config_json ? ((parseJsonSafe(row.embedder_config_json) as Record<string, unknown>) ?? {}) : {},
    dimensions: toNum(row.dimensions),
    chunkCount: toNum(row.chunk_count),
    createdBy: row.created_by ? toStr(row.created_by) : null,
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

function metadataOf(raw: string | null): Record<string, unknown> | null {
  return raw ? (parseJsonSafe(raw) as Record<string, unknown>) : null;
}

function mapKnowledgeBaseChunk(row: KnowledgeBaseChunkRow): KnowledgeBaseChunkRecord {
  return {
    id: toStr(row.id),
    knowledgeBaseId: toStr(row.knowledge_base_id),
    sourceId: row.source_id ? toStr(row.source_id) : null,
    chunkIndex: toNum(row.chunk_index),
    content: toStr(row.content),
    metadata: metadataOf(row.metadata_json),
    vector: parseJsonSafe(row.vector_json) as number[],
    createdAt: toStr(row.created_at)
  };
}

export async function createKnowledgeBase(ctx: PgContext, input: Parameters<Store["createKnowledgeBase"]>[0]): Promise<void> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO knowledge_bases (
       id, name, description, project_id, embedder_id, embedder_config_json,
       dimensions, chunk_count, created_by, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $9)`,
    [
      input.id,
      input.name,
      input.description ?? null,
      input.projectId ?? null,
      input.embedderId,
      input.embedderConfig ? JSON.stringify(input.embedderConfig) : null,
      input.dimensions ?? 0,
      input.createdBy ?? null,
      now
    ]
  );
}

/** True when the patch had a field to set (as SQLite: also when no row has that id). */
export async function updateKnowledgeBase(ctx: PgContext, id: string, patch: Parameters<Store["updateKnowledgeBase"]>[1]): Promise<boolean> {
  const fields: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    fields.push(`${column} = $${params.length}`);
  };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.description !== undefined) set("description", patch.description);
  if (patch.embedderConfig !== undefined) set("embedder_config_json", JSON.stringify(patch.embedderConfig));
  if (patch.dimensions !== undefined) set("dimensions", patch.dimensions);
  if (fields.length === 0) return false;
  set("updated_at", new Date().toISOString());
  params.push(id);
  await ctx.execute(`UPDATE knowledge_bases SET ${fields.join(", ")} WHERE id = $${params.length}`, params);
  return true;
}

export async function deleteKnowledgeBase(ctx: PgContext, id: string): Promise<boolean> {
  await ctx.withTransaction(async (client) => {
    await client.query(`DELETE FROM knowledge_base_chunks WHERE knowledge_base_id = $1`, [id]);
    await client.query(`DELETE FROM knowledge_bases WHERE id = $1`, [id]);
  });
  return true;
}

export async function getKnowledgeBase(ctx: PgContext, id: string): Promise<KnowledgeBaseRecord | null> {
  const row = await ctx.queryOne<KnowledgeBaseRow>(`SELECT ${KB_COLUMNS} FROM knowledge_bases WHERE id = $1`, [id]);
  return row ? mapKnowledgeBase(row) : null;
}

export async function listKnowledgeBases(ctx: PgContext, filter: { projectId?: string } = {}): Promise<KnowledgeBaseRecord[]> {
  const rows = filter.projectId
    ? await ctx.query<KnowledgeBaseRow>(`SELECT ${KB_COLUMNS} FROM knowledge_bases WHERE project_id = $1 ORDER BY name COLLATE "C", created_at, id COLLATE "C"`, [filter.projectId])
    : await ctx.query<KnowledgeBaseRow>(`SELECT ${KB_COLUMNS} FROM knowledge_bases ORDER BY name COLLATE "C", created_at, id COLLATE "C"`);
  return rows.map(mapKnowledgeBase);
}

/**
 * Bulk insert of pre-embedded chunks. The dimensions lock on the first insert when still 0; later inserts must match.
 * One transaction holding the knowledge base row, so two concurrent first inserts cannot lock different dimensions.
 */
export async function addKnowledgeBaseChunks(ctx: PgContext, input: Parameters<Store["addKnowledgeBaseChunks"]>[0]): Promise<{ inserted: number; dimensions: number }> {
  return ctx.withTransaction(async (client) => {
    const kbRow = (await client.query<KnowledgeBaseRow>(`SELECT ${KB_COLUMNS} FROM knowledge_bases WHERE id = $1 FOR UPDATE`, [input.knowledgeBaseId])).rows[0];
    if (!kbRow) throw new Error(`Knowledge base not found: ${input.knowledgeBaseId}`);
    const kb = mapKnowledgeBase(kbRow);
    if (input.chunks.length === 0) return { inserted: 0, dimensions: kb.dimensions };

    const expectedDims = kb.dimensions > 0 ? kb.dimensions : input.chunks[0]!.vector.length;
    for (const c of input.chunks) {
      if (c.vector.length !== expectedDims) {
        throw new Error(`Vector dimension mismatch: expected ${expectedDims}, got ${c.vector.length} (chunk ${c.chunkIndex})`);
      }
    }

    const now = new Date().toISOString();
    await client.query(
      `INSERT INTO knowledge_base_chunks (id, knowledge_base_id, source_id, chunk_index, content, metadata_json, vector_json, created_at)
       SELECT c.id, $1, c.source_id, c.chunk_index, c.content, c.metadata_json, c.vector_json, $2::timestamptz
         FROM unnest($3::text[], $4::text[], $5::int[], $6::text[], $7::text[], $8::text[])
              WITH ORDINALITY AS c(id, source_id, chunk_index, content, metadata_json, vector_json, ord)
        ORDER BY c.ord`,
      [
        input.knowledgeBaseId,
        now,
        input.chunks.map((c) => c.id ?? `kbc_${randomUUID()}`),
        input.chunks.map((c) => c.sourceId ?? null),
        input.chunks.map((c) => c.chunkIndex),
        input.chunks.map((c) => c.content),
        input.chunks.map((c) => (c.metadata ? JSON.stringify(c.metadata) : null)),
        input.chunks.map((c) => JSON.stringify(c.vector))
      ]
    );
    await client.query(
      `UPDATE knowledge_bases
          SET dimensions = CASE WHEN dimensions = 0 THEN $1 ELSE dimensions END,
              chunk_count = (SELECT COUNT(*) FROM knowledge_base_chunks WHERE knowledge_base_id = $2),
              updated_at = $3
        WHERE id = $2`,
      [expectedDims, input.knowledgeBaseId, now]
    );
    return { inserted: input.chunks.length, dimensions: expectedDims };
  });
}

/** Every chunk of a knowledge base, in insertion order (see the module note). */
export async function listKnowledgeBaseChunks(ctx: PgContext, knowledgeBaseId: string): Promise<KnowledgeBaseChunkRecord[]> {
  const rows = await ctx.query<KnowledgeBaseChunkRow>(
    `SELECT id, knowledge_base_id, source_id, chunk_index, content, metadata_json, vector_json, created_at
       FROM knowledge_base_chunks WHERE knowledge_base_id = $1 ORDER BY seq`,
    [knowledgeBaseId]
  );
  return rows.map(mapKnowledgeBaseChunk);
}

/** The same tokens SQLite's FTS5 query is built from: lower-case [a-z0-9] runs of at least 2 characters. */
export function searchTokens(userQuery: string): string[] {
  return userQuery
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

/** websearch_to_tsquery text matching any token: each token quoted (so `or` stays a word), joined with `or`. */
export function buildWebsearchQuery(userQuery: string): string {
  return searchTokens(userQuery).map((token) => `"${token}"`).join(" or ");
}

export async function bm25SearchKnowledgeBase(ctx: PgContext, input: { knowledgeBaseId: string; query: string; topK: number }): Promise<Array<{
  id: string;
  sourceId: string | null;
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown> | null;
  score: number;
}>> {
  const websearch = buildWebsearchQuery(input.query);
  if (!websearch) return [];
  const limit = Math.min(Math.max(input.topK, 1), 200);
  const rows = await ctx.query<{
    id: string;
    source_id: string | null;
    chunk_index: number;
    content: string;
    metadata_json: string | null;
    raw_score: number;
  }>(
    `SELECT c.id, c.source_id, c.chunk_index, c.content, c.metadata_json, ts_rank_cd(c.content_tsv, q.query) AS raw_score
       FROM knowledge_base_chunks c, websearch_to_tsquery('english', $1) AS q(query)
      WHERE c.knowledge_base_id = $2 AND c.content_tsv @@ q.query
      ORDER BY raw_score DESC, c.seq
      LIMIT $3`,
    [websearch, input.knowledgeBaseId, limit]
  );
  if (rows.length === 0) return [];
  // Higher is better already; min-max normalise to [0, 1] as SQLite does with its negated bm25.
  const scores = rows.map((row) => toNum(row.raw_score));
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  return rows.map((row, index) => ({
    id: toStr(row.id),
    sourceId: row.source_id ? toStr(row.source_id) : null,
    chunkIndex: toNum(row.chunk_index),
    content: toStr(row.content),
    metadata: metadataOf(row.metadata_json),
    score: (scores[index]! - min) / range
  }));
}

/** Preview chunks for the UI: content and metadata, no vectors. */
export async function listKnowledgeBaseChunkPreviews(ctx: PgContext, input: { knowledgeBaseId: string; limit?: number; sourceId?: string }): Promise<Array<{
  id: string; sourceId: string | null; chunkIndex: number; content: string;
  metadata: Record<string, unknown> | null; createdAt: string;
}>> {
  const limit = clampLimit(input.limit, { fallback: 50, max: LIMIT_MAX.knowledgeBaseChunkPreviews });
  const params: unknown[] = [input.knowledgeBaseId];
  let where = `knowledge_base_id = $1`;
  if (input.sourceId) {
    params.push(input.sourceId);
    where += ` AND source_id = $2`;
  }
  params.push(limit);
  const rows = await ctx.query<{
    id: string; source_id: string | null; chunk_index: number; content: string;
    metadata_json: string | null; created_at: string;
  }>(
    `SELECT id, source_id, chunk_index, content, metadata_json, created_at
       FROM knowledge_base_chunks WHERE ${where} ORDER BY chunk_index, seq LIMIT $${params.length}`,
    params
  );
  return rows.map((row) => ({
    id: toStr(row.id),
    sourceId: row.source_id ? toStr(row.source_id) : null,
    chunkIndex: toNum(row.chunk_index),
    content: toStr(row.content),
    metadata: metadataOf(row.metadata_json),
    createdAt: toStr(row.created_at)
  }));
}

/** Deletes one source's chunks and returns how many there were. */
export async function deleteKnowledgeBaseChunksBySource(ctx: PgContext, input: { knowledgeBaseId: string; sourceId: string }): Promise<number> {
  return ctx.withTransaction(async (client) => {
    const deleted = await client.query(
      `DELETE FROM knowledge_base_chunks WHERE knowledge_base_id = $1 AND source_id = $2`,
      [input.knowledgeBaseId, input.sourceId]
    );
    await client.query(
      `UPDATE knowledge_bases SET chunk_count = (SELECT COUNT(*) FROM knowledge_base_chunks WHERE knowledge_base_id = $1), updated_at = $2 WHERE id = $1`,
      [input.knowledgeBaseId, new Date().toISOString()]
    );
    return deleted.rowCount ?? 0;
  });
}

/** Distinct source ids of a knowledge base with chunk counts. */
export async function listKnowledgeBaseSources(ctx: PgContext, knowledgeBaseId: string): Promise<Array<{ sourceId: string; chunkCount: number }>> {
  const rows = await ctx.query<{ source_id: string | null; cnt: string }>(
    `SELECT source_id, COUNT(*) AS cnt FROM knowledge_base_chunks
      WHERE knowledge_base_id = $1 AND source_id IS NOT NULL
      GROUP BY source_id ORDER BY source_id COLLATE "C"`,
    [knowledgeBaseId]
  );
  return rows.map((row) => ({
    sourceId: row.source_id ? toStr(row.source_id) : "(unsourced)",
    chunkCount: toNum(row.cnt)
  }));
}
