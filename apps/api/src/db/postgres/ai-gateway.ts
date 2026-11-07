/**
 * 12.6b — PostgresStore: the /v1 AI gateway tables (v60). Each function matches the SqliteStore method of the same
 * name; text ordering uses the "C" collation, which compares like SQLite's BINARY.
 */
import type { AiGatewayRequestRecord } from "@ai-orchestrator/shared";
import {
  AI_GATEWAY_REQUEST_COLUMNS,
  AI_GATEWAY_TOTALS_SQL,
  AiGatewayAliasTakenError,
  aiGatewayRequestValues,
  mapAiGatewayRequestRow,
  mapAiGatewayRouteRow,
  mapAiGatewayRouteSetRow,
  mapAiGatewayTotals,
  type AiGatewayResolvedRoute,
  type AiGatewayRouteSetWrite,
  type AiGatewayRouteWrite,
  type AiGatewayStore,
  type AiGatewayUsageFilter
} from "../ai-gateway-store.js";
import type { PgContext } from "./context.js";

type Row = Record<string, unknown>;
type Args<K extends keyof AiGatewayStore> = Parameters<AiGatewayStore[K]>;
type Result<K extends keyof AiGatewayStore> = ReturnType<AiGatewayStore[K]>;

const SET_COLUMNS = `s.id AS s_id, s.name AS s_name, s.description AS s_description, s.project_id AS s_project_id, s.enabled AS s_enabled,
  s.rate_limit_json AS s_rate_limit_json, s.created_by AS s_created_by, s.created_at AS s_created_at, s.updated_at AS s_updated_at`;

function isAliasViolation(error: unknown): boolean {
  const record = error as { code?: unknown; constraint?: unknown } | null;
  return Boolean(record && record.code === "23505" && typeof record.constraint === "string" && record.constraint.includes("alias"));
}

const resolved = (row: Row): AiGatewayResolvedRoute => ({ route: mapAiGatewayRouteRow(row), routeSet: mapAiGatewayRouteSetRow(row, "s_") });

function usageWhere(filter: AiGatewayUsageFilter): { sql: string; params: unknown[] } {
  const params: unknown[] = [filter.from];
  const clauses = ["created_at >= $1::timestamptz"];
  if (filter.clientId) { params.push(filter.clientId); clauses.push(`client_id = $${params.length}`); }
  if (filter.routeSetId) { params.push(filter.routeSetId); clauses.push(`route_set_id = $${params.length}`); }
  return { sql: clauses.join(" AND "), params };
}

export async function listAiGatewayRouteSets(ctx: PgContext): Result<"listAiGatewayRouteSets"> {
  return (await ctx.query<Row>(`SELECT * FROM ai_gateway_route_sets ORDER BY name COLLATE "C", id COLLATE "C"`)).map((row) => mapAiGatewayRouteSetRow(row));
}

export async function getAiGatewayRouteSet(ctx: PgContext, id: string): Result<"getAiGatewayRouteSet"> {
  const row = await ctx.queryOne<Row>(`SELECT * FROM ai_gateway_route_sets WHERE id = $1`, [id]);
  return row ? mapAiGatewayRouteSetRow(row) : null;
}

export async function createAiGatewayRouteSet(ctx: PgContext, ...[input]: Args<"createAiGatewayRouteSet">): Result<"createAiGatewayRouteSet"> {
  const now = new Date().toISOString();
  const row = await ctx.queryOne<Row>(
    `INSERT INTO ai_gateway_route_sets (id, name, description, project_id, enabled, rate_limit_json, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
    [input.id, input.name, input.description, input.projectId, input.enabled ? 1 : 0, input.rateLimit ? JSON.stringify(input.rateLimit) : null, input.createdBy, now]
  );
  return mapAiGatewayRouteSetRow(row!);
}

export async function updateAiGatewayRouteSet(ctx: PgContext, id: string, patch: Partial<AiGatewayRouteSetWrite>): Result<"updateAiGatewayRouteSet"> {
  const fields: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    fields.push(`${column} = $${params.length}`);
  };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.description !== undefined) set("description", patch.description);
  if (patch.projectId !== undefined) set("project_id", patch.projectId);
  if (patch.enabled !== undefined) set("enabled", patch.enabled ? 1 : 0);
  if (patch.rateLimit !== undefined) set("rate_limit_json", patch.rateLimit ? JSON.stringify(patch.rateLimit) : null);
  set("updated_at", new Date().toISOString());
  params.push(id);
  const row = await ctx.queryOne<Row>(`UPDATE ai_gateway_route_sets SET ${fields.join(", ")} WHERE id = $${params.length} RETURNING *`, params);
  return row ? mapAiGatewayRouteSetRow(row) : null;
}

export async function deleteAiGatewayRouteSet(ctx: PgContext, id: string): Result<"deleteAiGatewayRouteSet"> {
  return await ctx.withTransaction(async (client) => {
    await client.query(`DELETE FROM ai_gateway_client_grants WHERE route_set_id = $1`, [id]);
    await client.query(`DELETE FROM ai_gateway_routes WHERE route_set_id = $1`, [id]);
    const deleted = await client.query(`DELETE FROM ai_gateway_route_sets WHERE id = $1`, [id]);
    return (deleted.rowCount ?? 0) > 0;
  });
}

export async function listAiGatewayRoutes(ctx: PgContext, routeSetId?: string): Result<"listAiGatewayRoutes"> {
  const rows = routeSetId
    ? await ctx.query<Row>(`SELECT * FROM ai_gateway_routes WHERE route_set_id = $1 ORDER BY alias COLLATE "C"`, [routeSetId])
    : await ctx.query<Row>(`SELECT * FROM ai_gateway_routes ORDER BY alias COLLATE "C"`);
  return rows.map(mapAiGatewayRouteRow);
}

export async function getAiGatewayRoute(ctx: PgContext, id: string): Result<"getAiGatewayRoute"> {
  const row = await ctx.queryOne<Row>(`SELECT * FROM ai_gateway_routes WHERE id = $1`, [id]);
  return row ? mapAiGatewayRouteRow(row) : null;
}

export async function createAiGatewayRoute(ctx: PgContext, ...[input]: Args<"createAiGatewayRoute">): Result<"createAiGatewayRoute"> {
  const now = new Date().toISOString();
  try {
    const row = await ctx.queryOne<Row>(
      `INSERT INTO ai_gateway_routes (id, route_set_id, alias, kind, provider_id, model, base_url, secret_id, extra_json, defaults_json, enabled, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13) RETURNING *`,
      [
        input.id,
        input.routeSetId,
        input.alias,
        input.kind,
        input.providerId,
        input.model,
        input.baseUrl,
        input.secretId,
        JSON.stringify(input.extra),
        JSON.stringify(input.defaults),
        input.enabled ? 1 : 0,
        input.createdBy,
        now
      ]
    );
    return mapAiGatewayRouteRow(row!);
  } catch (error) {
    if (isAliasViolation(error)) throw new AiGatewayAliasTakenError(input.alias);
    throw error;
  }
}

export async function updateAiGatewayRoute(ctx: PgContext, id: string, patch: Partial<AiGatewayRouteWrite>): Result<"updateAiGatewayRoute"> {
  const fields: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    fields.push(`${column} = $${params.length}`);
  };
  if (patch.alias !== undefined) set("alias", patch.alias);
  if (patch.kind !== undefined) set("kind", patch.kind);
  if (patch.providerId !== undefined) set("provider_id", patch.providerId);
  if (patch.model !== undefined) set("model", patch.model);
  if (patch.baseUrl !== undefined) set("base_url", patch.baseUrl);
  if (patch.secretId !== undefined) set("secret_id", patch.secretId);
  if (patch.extra !== undefined) set("extra_json", JSON.stringify(patch.extra));
  if (patch.defaults !== undefined) set("defaults_json", JSON.stringify(patch.defaults));
  if (patch.enabled !== undefined) set("enabled", patch.enabled ? 1 : 0);
  set("updated_at", new Date().toISOString());
  params.push(id);
  try {
    const row = await ctx.queryOne<Row>(`UPDATE ai_gateway_routes SET ${fields.join(", ")} WHERE id = $${params.length} RETURNING *`, params);
    return row ? mapAiGatewayRouteRow(row) : null;
  } catch (error) {
    if (isAliasViolation(error)) throw new AiGatewayAliasTakenError(patch.alias ?? "");
    throw error;
  }
}

export async function deleteAiGatewayRoute(ctx: PgContext, id: string): Result<"deleteAiGatewayRoute"> {
  const rows = await ctx.query<Row>(`DELETE FROM ai_gateway_routes WHERE id = $1 RETURNING id`, [id]);
  return rows.length > 0;
}

export async function listAiGatewayClientGrants(ctx: PgContext, clientId: string): Result<"listAiGatewayClientGrants"> {
  const rows = await ctx.query<{ route_set_id: string }>(
    `SELECT route_set_id FROM ai_gateway_client_grants WHERE client_id = $1 ORDER BY created_at, route_set_id COLLATE "C"`,
    [clientId]
  );
  return rows.map((row) => String(row.route_set_id));
}

export async function setAiGatewayClientGrants(ctx: PgContext, clientId: string, routeSetIds: string[], createdBy: string | null): Result<"setAiGatewayClientGrants"> {
  const wanted = [...new Set(routeSetIds)];
  await ctx.withTransaction(async (client) => {
    await client.query(`DELETE FROM ai_gateway_client_grants WHERE client_id = $1 AND NOT (route_set_id = ANY($2::text[]))`, [clientId, wanted]);
    const now = new Date().toISOString();
    for (const id of wanted) {
      await client.query(
        `INSERT INTO ai_gateway_client_grants (client_id, route_set_id, created_by, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (client_id, route_set_id) DO NOTHING`,
        [clientId, id, createdBy, now]
      );
    }
  });
  return await listAiGatewayClientGrants(ctx, clientId);
}

export async function listAllAiGatewayClientGrants(ctx: PgContext): Result<"listAllAiGatewayClientGrants"> {
  const rows = await ctx.query<{ client_id: string; route_set_id: string }>(
    `SELECT client_id, route_set_id FROM ai_gateway_client_grants ORDER BY client_id COLLATE "C", created_at, route_set_id COLLATE "C"`
  );
  return rows.map((row) => ({ clientId: String(row.client_id), routeSetId: String(row.route_set_id) }));
}

export async function resolveAiGatewayRoute(ctx: PgContext, clientId: string, alias: string): Result<"resolveAiGatewayRoute"> {
  const row = await ctx.queryOne<Row>(
    `SELECT r.*, ${SET_COLUMNS}
       FROM ai_gateway_routes r
       JOIN ai_gateway_route_sets s ON s.id = r.route_set_id
       JOIN ai_gateway_client_grants g ON g.route_set_id = s.id AND g.client_id = $1
      WHERE r.alias = $2 AND r.enabled = 1 AND s.enabled = 1`,
    [clientId, alias]
  );
  return row ? resolved(row) : null;
}

export async function listAiGatewayRoutesForClient(ctx: PgContext, clientId: string): Result<"listAiGatewayRoutesForClient"> {
  const rows = await ctx.query<Row>(
    `SELECT r.*, ${SET_COLUMNS}
       FROM ai_gateway_routes r
       JOIN ai_gateway_route_sets s ON s.id = r.route_set_id
       JOIN ai_gateway_client_grants g ON g.route_set_id = s.id AND g.client_id = $1
      WHERE r.enabled = 1 AND s.enabled = 1
      ORDER BY r.alias COLLATE "C"`,
    [clientId]
  );
  return rows.map(resolved);
}

export async function insertAiGatewayRequest(ctx: PgContext, record: AiGatewayRequestRecord): Result<"insertAiGatewayRequest"> {
  await ctx.execute(
    `INSERT INTO ai_gateway_requests (${AI_GATEWAY_REQUEST_COLUMNS.join(", ")}) VALUES (${AI_GATEWAY_REQUEST_COLUMNS.map((_, index) => `$${index + 1}`).join(", ")})`,
    aiGatewayRequestValues(record)
  );
}

export async function listAiGatewayRequests(ctx: PgContext, ...[filter]: Args<"listAiGatewayRequests">): Result<"listAiGatewayRequests"> {
  const where = usageWhere(filter);
  const rows = await ctx.query<Row>(
    `SELECT * FROM ai_gateway_requests WHERE ${where.sql} ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT $${where.params.length + 1}`,
    [...where.params, filter.limit]
  );
  return rows.map(mapAiGatewayRequestRow);
}

export async function summarizeAiGatewayUsage(ctx: PgContext, ...[filter]: Args<"summarizeAiGatewayUsage">): Result<"summarizeAiGatewayUsage"> {
  const where = usageWhere(filter);
  const totals = mapAiGatewayTotals(await ctx.queryOne<Row>(`SELECT ${AI_GATEWAY_TOTALS_SQL} FROM ai_gateway_requests WHERE ${where.sql}`, where.params));
  const byAlias = (
    await ctx.query<Row>(
      `SELECT alias, provider_id, model, ${AI_GATEWAY_TOTALS_SQL} FROM ai_gateway_requests WHERE ${where.sql}
        GROUP BY alias, provider_id, model ORDER BY requests DESC, alias COLLATE "C" LIMIT 200`,
      where.params
    )
  ).map((row) => ({ ...mapAiGatewayTotals(row), alias: String(row.alias), providerId: String(row.provider_id), model: String(row.model) }));
  const byClient = (
    await ctx.query<Row>(
      `SELECT client_id, ${AI_GATEWAY_TOTALS_SQL} FROM ai_gateway_requests WHERE ${where.sql} GROUP BY client_id ORDER BY requests DESC, client_id COLLATE "C" LIMIT 200`,
      where.params
    )
  ).map((row) => ({ ...mapAiGatewayTotals(row), clientId: String(row.client_id) }));
  return { totals, byAlias, byClient };
}
