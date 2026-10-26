/**
 * Phase 13.1 — PostgresStore: Trigger state for schedule and polling triggers.
 * Plain functions over a PgContext; PostgresStore delegates here. Every method is implemented;
 * UNIMPLEMENTED_METHODS is empty.
 */
import { type Store } from "../store.js";
import { toStr } from "./helpers.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [];

export async function getTriggerState(ctx: PgContext, workflowId: string, nodeId: string): Promise<Record<string, unknown> | null> {
  const rows = await ctx.query<{ state_json: string }>(
    `SELECT state_json FROM trigger_state WHERE workflow_id = $1 AND node_id = $2`,
    [workflowId, nodeId]
  );
  const row = rows[0];
  if (!row) return null;
  try {
    return JSON.parse(toStr(row.state_json)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function saveTriggerState(ctx: PgContext, input: {
  workflowId: string;
  nodeId: string;
  triggerType: string;
  state: Record<string, unknown>;
}): Promise<void> {
  await ctx.query(
    `INSERT INTO trigger_state (workflow_id, node_id, trigger_type, state_json, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workflow_id, node_id) DO UPDATE SET
         state_json = EXCLUDED.state_json,
         trigger_type = EXCLUDED.trigger_type,
         updated_at = EXCLUDED.updated_at`,
    [input.workflowId, input.nodeId, input.triggerType, JSON.stringify(input.state), new Date().toISOString()]
  );
}

export async function deleteTriggerStatesForWorkflow(ctx: PgContext, workflowId: string): Promise<void> {
  await ctx.query(`DELETE FROM trigger_state WHERE workflow_id = $1`, [workflowId]);
}
