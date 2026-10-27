/**
 * Phase 13.1 — PostgresStore: Store lifecycle, git sync, leases, variables, usage and budgets, notification configs.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { StoreNotImplementedError } from "../store-errors.js";
import { type Store } from "../store.js";
import { toNum, toStr } from "./helpers.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [
  "storageLocation",
  "getSchemaMarker",
  "getGitConfig",
  "upsertGitConfig",
  "deleteGitConfig",
  "recordGitSync",
  "getLease",
  "tryAcquireLease",
  "releaseLease",
  "listLeases",
  "listVariables",
  "getVariable",
  "upsertVariable",
  "deleteVariable",
  "findVariableByKey",
  "writeUsageEvent",
  "queryUsageRollup",
  "queryUsageTotals",
  "listUsageEvents",
  "createBudget",
  "updateBudget",
  "deleteBudget",
  "getBudget",
  "listBudgets",
  "recordBudgetAlert",
  "getLatestBudgetAlert",
  "listBudgetAlerts"
];

export async function listNotificationConfigs(ctx: PgContext): Promise<Array<{
  id: string; channel: string; enabled: boolean;
  config: Record<string, unknown>; events: string[];
  createdAt: string; updatedAt: string;
}>> {
  const rows = await ctx.query<{
    id: string; channel: string; enabled: number;
    config_json: string; events: string;
    created_at: string; updated_at: string;
  }>(`SELECT id, channel, enabled, config_json, events, created_at, updated_at FROM notification_configs ORDER BY created_at`);
  return rows.map(r => ({
    id: toStr(r.id),
    channel: toStr(r.channel),
    enabled: toNum(r.enabled) === 1,
    config: JSON.parse(toStr(r.config_json) || "{}"),
    events: JSON.parse(toStr(r.events) || '["execution.failure"]'),
    createdAt: toStr(r.created_at),
    updatedAt: toStr(r.updated_at)
  }));
}

export async function upsertNotificationConfig(ctx: PgContext, input: {
  id: string; channel: string; enabled: boolean;
  config: Record<string, unknown>; events: string[];
}): Promise<void> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO notification_configs (id, channel, enabled, config_json, events, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(id) DO UPDATE SET channel=EXCLUDED.channel, enabled=EXCLUDED.enabled,
         config_json=EXCLUDED.config_json, events=EXCLUDED.events, updated_at=EXCLUDED.updated_at`,
    [input.id, input.channel, input.enabled ? 1 : 0,
     JSON.stringify(input.config), JSON.stringify(input.events), now, now]
  );
}

export async function deleteNotificationConfig(ctx: PgContext, id: string): Promise<boolean> {
  const result = await ctx.pool.query(`DELETE FROM notification_configs WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function storageLocation(_ctx: PgContext, ..._args: Parameters<Store["storageLocation"]>): ReturnType<Store["storageLocation"]> {
  throw new StoreNotImplementedError("storageLocation");
}

export async function getSchemaMarker(_ctx: PgContext, ..._args: Parameters<Store["getSchemaMarker"]>): ReturnType<Store["getSchemaMarker"]> {
  throw new StoreNotImplementedError("getSchemaMarker");
}

export async function getGitConfig(_ctx: PgContext, ..._args: Parameters<Store["getGitConfig"]>): ReturnType<Store["getGitConfig"]> {
  throw new StoreNotImplementedError("getGitConfig");
}

export async function upsertGitConfig(_ctx: PgContext, ..._args: Parameters<Store["upsertGitConfig"]>): ReturnType<Store["upsertGitConfig"]> {
  throw new StoreNotImplementedError("upsertGitConfig");
}

export async function deleteGitConfig(_ctx: PgContext, ..._args: Parameters<Store["deleteGitConfig"]>): ReturnType<Store["deleteGitConfig"]> {
  throw new StoreNotImplementedError("deleteGitConfig");
}

export async function recordGitSync(_ctx: PgContext, ..._args: Parameters<Store["recordGitSync"]>): ReturnType<Store["recordGitSync"]> {
  throw new StoreNotImplementedError("recordGitSync");
}

export async function getLease(_ctx: PgContext, ..._args: Parameters<Store["getLease"]>): ReturnType<Store["getLease"]> {
  throw new StoreNotImplementedError("getLease");
}

export async function tryAcquireLease(_ctx: PgContext, ..._args: Parameters<Store["tryAcquireLease"]>): ReturnType<Store["tryAcquireLease"]> {
  throw new StoreNotImplementedError("tryAcquireLease");
}

export async function releaseLease(_ctx: PgContext, ..._args: Parameters<Store["releaseLease"]>): ReturnType<Store["releaseLease"]> {
  throw new StoreNotImplementedError("releaseLease");
}

export async function listLeases(_ctx: PgContext, ..._args: Parameters<Store["listLeases"]>): ReturnType<Store["listLeases"]> {
  throw new StoreNotImplementedError("listLeases");
}

export async function listVariables(_ctx: PgContext, ..._args: Parameters<Store["listVariables"]>): ReturnType<Store["listVariables"]> {
  throw new StoreNotImplementedError("listVariables");
}

export async function getVariable(_ctx: PgContext, ..._args: Parameters<Store["getVariable"]>): ReturnType<Store["getVariable"]> {
  throw new StoreNotImplementedError("getVariable");
}

export async function upsertVariable(_ctx: PgContext, ..._args: Parameters<Store["upsertVariable"]>): ReturnType<Store["upsertVariable"]> {
  throw new StoreNotImplementedError("upsertVariable");
}

export async function deleteVariable(_ctx: PgContext, ..._args: Parameters<Store["deleteVariable"]>): ReturnType<Store["deleteVariable"]> {
  throw new StoreNotImplementedError("deleteVariable");
}

export async function findVariableByKey(_ctx: PgContext, ..._args: Parameters<Store["findVariableByKey"]>): ReturnType<Store["findVariableByKey"]> {
  throw new StoreNotImplementedError("findVariableByKey");
}

export async function writeUsageEvent(_ctx: PgContext, ..._args: Parameters<Store["writeUsageEvent"]>): ReturnType<Store["writeUsageEvent"]> {
  throw new StoreNotImplementedError("writeUsageEvent");
}

export async function queryUsageRollup(_ctx: PgContext, ..._args: Parameters<Store["queryUsageRollup"]>): ReturnType<Store["queryUsageRollup"]> {
  throw new StoreNotImplementedError("queryUsageRollup");
}

export async function queryUsageTotals(_ctx: PgContext, ..._args: Parameters<Store["queryUsageTotals"]>): ReturnType<Store["queryUsageTotals"]> {
  throw new StoreNotImplementedError("queryUsageTotals");
}

export async function listUsageEvents(_ctx: PgContext, ..._args: Parameters<Store["listUsageEvents"]>): ReturnType<Store["listUsageEvents"]> {
  throw new StoreNotImplementedError("listUsageEvents");
}

export async function createBudget(_ctx: PgContext, ..._args: Parameters<Store["createBudget"]>): ReturnType<Store["createBudget"]> {
  throw new StoreNotImplementedError("createBudget");
}

export async function updateBudget(_ctx: PgContext, ..._args: Parameters<Store["updateBudget"]>): ReturnType<Store["updateBudget"]> {
  throw new StoreNotImplementedError("updateBudget");
}

export async function deleteBudget(_ctx: PgContext, ..._args: Parameters<Store["deleteBudget"]>): ReturnType<Store["deleteBudget"]> {
  throw new StoreNotImplementedError("deleteBudget");
}

export async function getBudget(_ctx: PgContext, ..._args: Parameters<Store["getBudget"]>): ReturnType<Store["getBudget"]> {
  throw new StoreNotImplementedError("getBudget");
}

export async function listBudgets(_ctx: PgContext, ..._args: Parameters<Store["listBudgets"]>): ReturnType<Store["listBudgets"]> {
  throw new StoreNotImplementedError("listBudgets");
}

export async function recordBudgetAlert(_ctx: PgContext, ..._args: Parameters<Store["recordBudgetAlert"]>): ReturnType<Store["recordBudgetAlert"]> {
  throw new StoreNotImplementedError("recordBudgetAlert");
}

export async function getLatestBudgetAlert(_ctx: PgContext, ..._args: Parameters<Store["getLatestBudgetAlert"]>): ReturnType<Store["getLatestBudgetAlert"]> {
  throw new StoreNotImplementedError("getLatestBudgetAlert");
}

export async function listBudgetAlerts(_ctx: PgContext, ..._args: Parameters<Store["listBudgetAlerts"]>): ReturnType<Store["listBudgetAlerts"]> {
  throw new StoreNotImplementedError("listBudgetAlerts");
}
