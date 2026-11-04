/**
 * 12.6b — SqliteStore's AI gateway tables (v57). Each function matches the Store method of the same name; SqliteStore
 * delegates to them. The tables are created in SqliteStore.migrate (ensureAiGatewaySchema).
 */
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import type { AiGatewayRequestRecord, AiGatewayRoute, AiGatewayRouteSet } from "@ai-orchestrator/shared";
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
} from "./ai-gateway-store.js";

type Row = Record<string, unknown>;

export function ensureAiGatewaySchema(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_gateway_route_sets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      project_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      rate_limit_json TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_gateway_routes (
      id TEXT PRIMARY KEY,
      route_set_id TEXT NOT NULL,
      alias TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      base_url TEXT,
      secret_id TEXT,
      extra_json TEXT NOT NULL DEFAULT '{}',
      defaults_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_gateway_routes_set ON ai_gateway_routes(route_set_id);
    CREATE TABLE IF NOT EXISTS ai_gateway_client_grants (
      client_id TEXT NOT NULL,
      route_set_id TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (client_id, route_set_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_gateway_grants_set ON ai_gateway_client_grants(route_set_id);
    CREATE TABLE IF NOT EXISTS ai_gateway_requests (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      client_id TEXT NOT NULL,
      route_set_id TEXT NOT NULL,
      route_id TEXT NOT NULL,
      project_id TEXT,
      alias TEXT NOT NULL,
      kind TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      stream INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      http_status INTEGER NOT NULL,
      finish_reason TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      guard_outcome TEXT NOT NULL DEFAULT 'none',
      error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ai_gateway_requests_created ON ai_gateway_requests(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_gateway_requests_client_created ON ai_gateway_requests(client_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_gateway_requests_set_created ON ai_gateway_requests(route_set_id, created_at DESC);
  `);
}

/** The set's columns, prefixed `s_`, for joins with a route row. */
const SET_COLUMNS = `s.id AS s_id, s.name AS s_name, s.description AS s_description, s.project_id AS s_project_id, s.enabled AS s_enabled,
  s.rate_limit_json AS s_rate_limit_json, s.created_by AS s_created_by, s.created_at AS s_created_at, s.updated_at AS s_updated_at`;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: ai_gateway_routes\.alias/.test(error.message);
}

function usageWhere(filter: AiGatewayUsageFilter): { sql: string; params: unknown[] } {
  const clauses = ["created_at >= ?"];
  const params: unknown[] = [filter.from];
  if (filter.clientId) { clauses.push("client_id = ?"); params.push(filter.clientId); }
  if (filter.routeSetId) { clauses.push("route_set_id = ?"); params.push(filter.routeSetId); }
  return { sql: clauses.join(" AND "), params };
}

export function sqliteAiGatewayStore(db: BetterSqlite3Database): AiGatewayStore {
  const all = <T extends Row>(sql: string, params: unknown[] = []): T[] => db.prepare(sql).all(...params) as T[];
  const one = <T extends Row>(sql: string, params: unknown[] = []): T | null => (db.prepare(sql).get(...params) as T | undefined) ?? null;
  const run = (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params);

  const getSet = (id: string): AiGatewayRouteSet | null => {
    const row = one(`SELECT * FROM ai_gateway_route_sets WHERE id = ?`, [id]);
    return row ? mapAiGatewayRouteSetRow(row) : null;
  };
  const getRoute = (id: string): AiGatewayRoute | null => {
    const row = one(`SELECT * FROM ai_gateway_routes WHERE id = ?`, [id]);
    return row ? mapAiGatewayRouteRow(row) : null;
  };
  const resolved = (row: Row): AiGatewayResolvedRoute => ({ route: mapAiGatewayRouteRow(row), routeSet: mapAiGatewayRouteSetRow(row, "s_") });

  return {
    async listAiGatewayRouteSets() {
      return all(`SELECT * FROM ai_gateway_route_sets ORDER BY name COLLATE BINARY, id`).map((row) => mapAiGatewayRouteSetRow(row));
    },
    async getAiGatewayRouteSet(id) {
      return getSet(id);
    },
    async createAiGatewayRouteSet(input) {
      const now = new Date().toISOString();
      run(
        `INSERT INTO ai_gateway_route_sets (id, name, description, project_id, enabled, rate_limit_json, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.name, input.description, input.projectId, input.enabled ? 1 : 0, input.rateLimit ? JSON.stringify(input.rateLimit) : null, input.createdBy, now, now]
      );
      return getSet(input.id)!;
    },
    async updateAiGatewayRouteSet(id, patch: Partial<AiGatewayRouteSetWrite>) {
      if (!getSet(id)) return null;
      const fields: string[] = [];
      const params: unknown[] = [];
      if (patch.name !== undefined) { fields.push("name = ?"); params.push(patch.name); }
      if (patch.description !== undefined) { fields.push("description = ?"); params.push(patch.description); }
      if (patch.projectId !== undefined) { fields.push("project_id = ?"); params.push(patch.projectId); }
      if (patch.enabled !== undefined) { fields.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
      if (patch.rateLimit !== undefined) { fields.push("rate_limit_json = ?"); params.push(patch.rateLimit ? JSON.stringify(patch.rateLimit) : null); }
      fields.push("updated_at = ?");
      params.push(new Date().toISOString(), id);
      run(`UPDATE ai_gateway_route_sets SET ${fields.join(", ")} WHERE id = ?`, params);
      return getSet(id);
    },
    async deleteAiGatewayRouteSet(id) {
      if (!getSet(id)) return false;
      db.transaction(() => {
        run(`DELETE FROM ai_gateway_client_grants WHERE route_set_id = ?`, [id]);
        run(`DELETE FROM ai_gateway_routes WHERE route_set_id = ?`, [id]);
        run(`DELETE FROM ai_gateway_route_sets WHERE id = ?`, [id]);
      })();
      return true;
    },
    async listAiGatewayRoutes(routeSetId) {
      const rows = routeSetId
        ? all(`SELECT * FROM ai_gateway_routes WHERE route_set_id = ? ORDER BY alias COLLATE BINARY`, [routeSetId])
        : all(`SELECT * FROM ai_gateway_routes ORDER BY alias COLLATE BINARY`);
      return rows.map(mapAiGatewayRouteRow);
    },
    async getAiGatewayRoute(id) {
      return getRoute(id);
    },
    async createAiGatewayRoute(input) {
      const now = new Date().toISOString();
      try {
        run(
          `INSERT INTO ai_gateway_routes (id, route_set_id, alias, kind, provider_id, model, base_url, secret_id, extra_json, defaults_json, enabled, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            now,
            now
          ]
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw new AiGatewayAliasTakenError(input.alias);
        throw error;
      }
      return getRoute(input.id)!;
    },
    async updateAiGatewayRoute(id, patch: Partial<AiGatewayRouteWrite>) {
      if (!getRoute(id)) return null;
      const fields: string[] = [];
      const params: unknown[] = [];
      if (patch.alias !== undefined) { fields.push("alias = ?"); params.push(patch.alias); }
      if (patch.kind !== undefined) { fields.push("kind = ?"); params.push(patch.kind); }
      if (patch.providerId !== undefined) { fields.push("provider_id = ?"); params.push(patch.providerId); }
      if (patch.model !== undefined) { fields.push("model = ?"); params.push(patch.model); }
      if (patch.baseUrl !== undefined) { fields.push("base_url = ?"); params.push(patch.baseUrl); }
      if (patch.secretId !== undefined) { fields.push("secret_id = ?"); params.push(patch.secretId); }
      if (patch.extra !== undefined) { fields.push("extra_json = ?"); params.push(JSON.stringify(patch.extra)); }
      if (patch.defaults !== undefined) { fields.push("defaults_json = ?"); params.push(JSON.stringify(patch.defaults)); }
      if (patch.enabled !== undefined) { fields.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
      fields.push("updated_at = ?");
      params.push(new Date().toISOString(), id);
      try {
        run(`UPDATE ai_gateway_routes SET ${fields.join(", ")} WHERE id = ?`, params);
      } catch (error) {
        if (isUniqueViolation(error)) throw new AiGatewayAliasTakenError(patch.alias ?? "");
        throw error;
      }
      return getRoute(id);
    },
    async deleteAiGatewayRoute(id) {
      return run(`DELETE FROM ai_gateway_routes WHERE id = ?`, [id]).changes > 0;
    },
    async listAiGatewayClientGrants(clientId) {
      return all<{ route_set_id: string }>(`SELECT route_set_id FROM ai_gateway_client_grants WHERE client_id = ? ORDER BY created_at, route_set_id`, [clientId]).map(
        (row) => String(row.route_set_id)
      );
    },
    async setAiGatewayClientGrants(clientId, routeSetIds, createdBy) {
      const wanted = [...new Set(routeSetIds)];
      db.transaction(() => {
        const current = new Set(all<{ route_set_id: string }>(`SELECT route_set_id FROM ai_gateway_client_grants WHERE client_id = ?`, [clientId]).map((row) => String(row.route_set_id)));
        for (const id of current) if (!wanted.includes(id)) run(`DELETE FROM ai_gateway_client_grants WHERE client_id = ? AND route_set_id = ?`, [clientId, id]);
        const now = new Date().toISOString();
        for (const id of wanted) {
          if (!current.has(id)) run(`INSERT INTO ai_gateway_client_grants (client_id, route_set_id, created_by, created_at) VALUES (?, ?, ?, ?)`, [clientId, id, createdBy, now]);
        }
      })();
      return await this.listAiGatewayClientGrants(clientId);
    },
    async listAllAiGatewayClientGrants() {
      return all<{ client_id: string; route_set_id: string }>(`SELECT client_id, route_set_id FROM ai_gateway_client_grants ORDER BY client_id, created_at, route_set_id`).map((row) => ({
        clientId: String(row.client_id),
        routeSetId: String(row.route_set_id)
      }));
    },
    async resolveAiGatewayRoute(clientId, alias) {
      const row = one(
        `SELECT r.*, ${SET_COLUMNS}
           FROM ai_gateway_routes r
           JOIN ai_gateway_route_sets s ON s.id = r.route_set_id
           JOIN ai_gateway_client_grants g ON g.route_set_id = s.id AND g.client_id = ?
          WHERE r.alias = ? AND r.enabled = 1 AND s.enabled = 1`,
        [clientId, alias]
      );
      return row ? resolved(row) : null;
    },
    async listAiGatewayRoutesForClient(clientId) {
      return all(
        `SELECT r.*, ${SET_COLUMNS}
           FROM ai_gateway_routes r
           JOIN ai_gateway_route_sets s ON s.id = r.route_set_id
           JOIN ai_gateway_client_grants g ON g.route_set_id = s.id AND g.client_id = ?
          WHERE r.enabled = 1 AND s.enabled = 1
          ORDER BY r.alias COLLATE BINARY`,
        [clientId]
      ).map(resolved);
    },
    async insertAiGatewayRequest(record: AiGatewayRequestRecord) {
      run(
        `INSERT INTO ai_gateway_requests (${AI_GATEWAY_REQUEST_COLUMNS.join(", ")}) VALUES (${AI_GATEWAY_REQUEST_COLUMNS.map(() => "?").join(", ")})`,
        aiGatewayRequestValues(record)
      );
    },
    async listAiGatewayRequests(filter) {
      const where = usageWhere(filter);
      return all(`SELECT * FROM ai_gateway_requests WHERE ${where.sql} ORDER BY created_at DESC, id DESC LIMIT ?`, [...where.params, filter.limit]).map(mapAiGatewayRequestRow);
    },
    async summarizeAiGatewayUsage(filter) {
      const where = usageWhere(filter);
      const totals = mapAiGatewayTotals(one(`SELECT ${AI_GATEWAY_TOTALS_SQL} FROM ai_gateway_requests WHERE ${where.sql}`, where.params));
      const byAlias = all(
        `SELECT alias, provider_id, model, ${AI_GATEWAY_TOTALS_SQL} FROM ai_gateway_requests WHERE ${where.sql}
          GROUP BY alias, provider_id, model ORDER BY requests DESC, alias COLLATE BINARY LIMIT 200`,
        where.params
      ).map((row) => ({ ...mapAiGatewayTotals(row), alias: String(row.alias), providerId: String(row.provider_id), model: String(row.model) }));
      const byClient = all(
        `SELECT client_id, ${AI_GATEWAY_TOTALS_SQL} FROM ai_gateway_requests WHERE ${where.sql} GROUP BY client_id ORDER BY requests DESC, client_id LIMIT 200`,
        where.params
      ).map((row) => ({ ...mapAiGatewayTotals(row), clientId: String(row.client_id) }));
      return { totals, byAlias, byClient };
    }
  };
}
