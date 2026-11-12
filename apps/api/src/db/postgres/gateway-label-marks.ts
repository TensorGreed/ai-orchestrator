/**
 * MCP 2026-07-28 (v71) — PostgresStore: label marks of stateless gateway callers (db/gateway-label-marks.ts). Each
 * function matches the SqliteStore method of the same name. A raise locks the caller's row (`FOR UPDATE`) for the
 * merge, so raises from several instances never lose a label, and writes the result as an upsert, so a sweep that
 * deleted the (expired) row in between cannot make it update nothing.
 */
import {
  LABEL_MARK_INSERT_EMPTY_SQL,
  LABEL_MARK_TOUCH_SQL,
  LABEL_MARK_WRITE_SQL,
  labelMarkTouchParams,
  labelMarkLive,
  labelMarkUpdateParams,
  mapLabelMarkRow,
  mergeLabelMark
} from "../gateway-label-marks.js";
import { toPgPlaceholders } from "../legal-hold-sql.js";
import type { Store } from "../store.js";
import type { PgContext } from "./context.js";

const TOUCH_SQL = toPgPlaceholders(LABEL_MARK_TOUCH_SQL);
const INSERT_EMPTY_SQL = toPgPlaceholders(LABEL_MARK_INSERT_EMPTY_SQL);
const WRITE_SQL = toPgPlaceholders(LABEL_MARK_WRITE_SQL);

export async function readMcpGatewayLabelMark(
  ctx: PgContext,
  ...[key, at]: Parameters<Store["readMcpGatewayLabelMark"]>
): ReturnType<Store["readMcpGatewayLabelMark"]> {
  const row = await ctx.queryOne<Record<string, unknown>>(TOUCH_SQL, labelMarkTouchParams(key, at));
  return row ? mapLabelMarkRow(row) : null;
}

export async function raiseMcpGatewayLabelMark(
  ctx: PgContext,
  ...[input]: Parameters<Store["raiseMcpGatewayLabelMark"]>
): ReturnType<Store["raiseMcpGatewayLabelMark"]> {
  return ctx.withTransaction(async (client) => {
    await client.query(INSERT_EMPTY_SQL, [input.clientId, input.toolsetId, input.scopeKey, input.now, input.expiresAt]);
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM mcp_gateway_label_marks WHERE client_id = $1 AND toolset_id = $2 AND scope_key = $3 FOR UPDATE`,
      [input.clientId, input.toolsetId, input.scopeKey]
    );
    const row = result.rows[0];
    const stored = row ? mapLabelMarkRow(row) : null;
    const { next, firstRaise } = mergeLabelMark(stored && labelMarkLive(stored, input.now) ? stored : null, input);
    await client.query(WRITE_SQL, labelMarkUpdateParams(next));
    return { mark: next, firstRaise };
  });
}

export async function listMcpGatewayLabelMarks(
  ctx: PgContext,
  ...[filter, now]: Parameters<Store["listMcpGatewayLabelMarks"]>
): ReturnType<Store["listMcpGatewayLabelMarks"]> {
  const rows = await ctx.query<Record<string, unknown>>(
    `SELECT * FROM mcp_gateway_label_marks WHERE client_id = $1 AND expires_at > $2 ORDER BY last_seen_at DESC, toolset_id, scope_key`,
    [filter.clientId, now]
  );
  return rows.map(mapLabelMarkRow);
}

export async function sweepMcpGatewayLabelMarks(
  ctx: PgContext,
  ...[now, limit]: Parameters<Store["sweepMcpGatewayLabelMarks"]>
): ReturnType<Store["sweepMcpGatewayLabelMarks"]> {
  const rows = await ctx.query<{ client_id: string }>(
    `DELETE FROM mcp_gateway_label_marks WHERE ctid IN (SELECT ctid FROM mcp_gateway_label_marks WHERE expires_at <= $1 LIMIT $2) RETURNING client_id`,
    [now, limit]
  );
  return rows.length;
}
