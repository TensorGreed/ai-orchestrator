/**
 * Phase 13.1 — PostgresStore: MCP registry, probes, telemetry, OAuth, elicitations, policies, toolsets and clients.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { StoreNotImplementedError } from "../store-errors.js";
import { type Store } from "../store.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [
  "createMcpServer",
  "updateMcpServer",
  "deleteMcpServer",
  "setMcpServerSandboxStatus",
  "getMcpServer",
  "listMcpServers",
  "recordMcpServerProbe",
  "listMcpServerProbes",
  "getMcpToolSnapshot",
  "listMcpToolSnapshots",
  "acknowledgeMcpBreakingChange",
  "replaceMcpToolCallsForExecution",
  "insertMcpToolCall",
  "listMcpToolCallsForClient",
  "summarizeMcpClientUsage",
  "listMcpToolCalls",
  "getMcpOAuthConnection",
  "upsertMcpOAuthConnection",
  "getMcpUserOAuthConnection",
  "listMcpUserOAuthConnections",
  "upsertMcpUserOAuthConnection",
  "deleteMcpUserOAuthConnection",
  "deleteMcpOAuthConnection",
  "getMcpServerCatalog",
  "upsertMcpServerCatalog",
  "createMcpElicitation",
  "getMcpElicitation",
  "listMcpElicitations",
  "settleMcpElicitation",
  "expireMcpElicitationsForExecution",
  "listExpiredMcpElicitations",
  "listMcpToolPolicies",
  "getMcpToolPolicy",
  "createMcpToolPolicy",
  "updateMcpToolPolicy",
  "deleteMcpToolPolicy",
  "listMcpToolClassifications",
  "setMcpToolClassification",
  "listMcpToolsets",
  "getMcpToolset",
  "getMcpToolsetBySlug",
  "createMcpToolset",
  "updateMcpToolset",
  "deleteMcpToolset",
  "createMcpClient",
  "getMcpClient",
  "findMcpClientByTokenPrefix",
  "listMcpClients",
  "revokeMcpClient",
  "touchMcpClient",
  "listMcpToolCallsForExecution"
];

export async function createMcpServer(_ctx: PgContext, ..._args: Parameters<Store["createMcpServer"]>): ReturnType<Store["createMcpServer"]> {
  throw new StoreNotImplementedError("createMcpServer");
}

export async function updateMcpServer(_ctx: PgContext, ..._args: Parameters<Store["updateMcpServer"]>): ReturnType<Store["updateMcpServer"]> {
  throw new StoreNotImplementedError("updateMcpServer");
}

export async function deleteMcpServer(_ctx: PgContext, ..._args: Parameters<Store["deleteMcpServer"]>): ReturnType<Store["deleteMcpServer"]> {
  throw new StoreNotImplementedError("deleteMcpServer");
}

export async function setMcpServerSandboxStatus(_ctx: PgContext, ..._args: Parameters<Store["setMcpServerSandboxStatus"]>): ReturnType<Store["setMcpServerSandboxStatus"]> {
  throw new StoreNotImplementedError("setMcpServerSandboxStatus");
}

export async function getMcpServer(_ctx: PgContext, ..._args: Parameters<Store["getMcpServer"]>): ReturnType<Store["getMcpServer"]> {
  throw new StoreNotImplementedError("getMcpServer");
}

export async function listMcpServers(_ctx: PgContext, ..._args: Parameters<Store["listMcpServers"]>): ReturnType<Store["listMcpServers"]> {
  throw new StoreNotImplementedError("listMcpServers");
}

export async function recordMcpServerProbe(_ctx: PgContext, ..._args: Parameters<Store["recordMcpServerProbe"]>): ReturnType<Store["recordMcpServerProbe"]> {
  throw new StoreNotImplementedError("recordMcpServerProbe");
}

export async function listMcpServerProbes(_ctx: PgContext, ..._args: Parameters<Store["listMcpServerProbes"]>): ReturnType<Store["listMcpServerProbes"]> {
  throw new StoreNotImplementedError("listMcpServerProbes");
}

export async function getMcpToolSnapshot(_ctx: PgContext, ..._args: Parameters<Store["getMcpToolSnapshot"]>): ReturnType<Store["getMcpToolSnapshot"]> {
  throw new StoreNotImplementedError("getMcpToolSnapshot");
}

export async function listMcpToolSnapshots(_ctx: PgContext, ..._args: Parameters<Store["listMcpToolSnapshots"]>): ReturnType<Store["listMcpToolSnapshots"]> {
  throw new StoreNotImplementedError("listMcpToolSnapshots");
}

export async function acknowledgeMcpBreakingChange(_ctx: PgContext, ..._args: Parameters<Store["acknowledgeMcpBreakingChange"]>): ReturnType<Store["acknowledgeMcpBreakingChange"]> {
  throw new StoreNotImplementedError("acknowledgeMcpBreakingChange");
}

export async function replaceMcpToolCallsForExecution(_ctx: PgContext, ..._args: Parameters<Store["replaceMcpToolCallsForExecution"]>): ReturnType<Store["replaceMcpToolCallsForExecution"]> {
  throw new StoreNotImplementedError("replaceMcpToolCallsForExecution");
}

export async function insertMcpToolCall(_ctx: PgContext, ..._args: Parameters<Store["insertMcpToolCall"]>): ReturnType<Store["insertMcpToolCall"]> {
  throw new StoreNotImplementedError("insertMcpToolCall");
}

export async function listMcpToolCallsForClient(_ctx: PgContext, ..._args: Parameters<Store["listMcpToolCallsForClient"]>): ReturnType<Store["listMcpToolCallsForClient"]> {
  throw new StoreNotImplementedError("listMcpToolCallsForClient");
}

export async function summarizeMcpClientUsage(_ctx: PgContext, ..._args: Parameters<Store["summarizeMcpClientUsage"]>): ReturnType<Store["summarizeMcpClientUsage"]> {
  throw new StoreNotImplementedError("summarizeMcpClientUsage");
}

export async function listMcpToolCalls(_ctx: PgContext, ..._args: Parameters<Store["listMcpToolCalls"]>): ReturnType<Store["listMcpToolCalls"]> {
  throw new StoreNotImplementedError("listMcpToolCalls");
}

export async function getMcpOAuthConnection(_ctx: PgContext, ..._args: Parameters<Store["getMcpOAuthConnection"]>): ReturnType<Store["getMcpOAuthConnection"]> {
  throw new StoreNotImplementedError("getMcpOAuthConnection");
}

export async function upsertMcpOAuthConnection(_ctx: PgContext, ..._args: Parameters<Store["upsertMcpOAuthConnection"]>): ReturnType<Store["upsertMcpOAuthConnection"]> {
  throw new StoreNotImplementedError("upsertMcpOAuthConnection");
}

export async function getMcpUserOAuthConnection(_ctx: PgContext, ..._args: Parameters<Store["getMcpUserOAuthConnection"]>): ReturnType<Store["getMcpUserOAuthConnection"]> {
  throw new StoreNotImplementedError("getMcpUserOAuthConnection");
}

export async function listMcpUserOAuthConnections(_ctx: PgContext, ..._args: Parameters<Store["listMcpUserOAuthConnections"]>): ReturnType<Store["listMcpUserOAuthConnections"]> {
  throw new StoreNotImplementedError("listMcpUserOAuthConnections");
}

export async function upsertMcpUserOAuthConnection(_ctx: PgContext, ..._args: Parameters<Store["upsertMcpUserOAuthConnection"]>): ReturnType<Store["upsertMcpUserOAuthConnection"]> {
  throw new StoreNotImplementedError("upsertMcpUserOAuthConnection");
}

export async function deleteMcpUserOAuthConnection(_ctx: PgContext, ..._args: Parameters<Store["deleteMcpUserOAuthConnection"]>): ReturnType<Store["deleteMcpUserOAuthConnection"]> {
  throw new StoreNotImplementedError("deleteMcpUserOAuthConnection");
}

export async function deleteMcpOAuthConnection(_ctx: PgContext, ..._args: Parameters<Store["deleteMcpOAuthConnection"]>): ReturnType<Store["deleteMcpOAuthConnection"]> {
  throw new StoreNotImplementedError("deleteMcpOAuthConnection");
}

export async function getMcpServerCatalog(_ctx: PgContext, ..._args: Parameters<Store["getMcpServerCatalog"]>): ReturnType<Store["getMcpServerCatalog"]> {
  throw new StoreNotImplementedError("getMcpServerCatalog");
}

export async function upsertMcpServerCatalog(_ctx: PgContext, ..._args: Parameters<Store["upsertMcpServerCatalog"]>): ReturnType<Store["upsertMcpServerCatalog"]> {
  throw new StoreNotImplementedError("upsertMcpServerCatalog");
}

export async function createMcpElicitation(_ctx: PgContext, ..._args: Parameters<Store["createMcpElicitation"]>): ReturnType<Store["createMcpElicitation"]> {
  throw new StoreNotImplementedError("createMcpElicitation");
}

export async function getMcpElicitation(_ctx: PgContext, ..._args: Parameters<Store["getMcpElicitation"]>): ReturnType<Store["getMcpElicitation"]> {
  throw new StoreNotImplementedError("getMcpElicitation");
}

export async function listMcpElicitations(_ctx: PgContext, ..._args: Parameters<Store["listMcpElicitations"]>): ReturnType<Store["listMcpElicitations"]> {
  throw new StoreNotImplementedError("listMcpElicitations");
}

export async function settleMcpElicitation(_ctx: PgContext, ..._args: Parameters<Store["settleMcpElicitation"]>): ReturnType<Store["settleMcpElicitation"]> {
  throw new StoreNotImplementedError("settleMcpElicitation");
}

export async function expireMcpElicitationsForExecution(_ctx: PgContext, ..._args: Parameters<Store["expireMcpElicitationsForExecution"]>): ReturnType<Store["expireMcpElicitationsForExecution"]> {
  throw new StoreNotImplementedError("expireMcpElicitationsForExecution");
}

export async function listExpiredMcpElicitations(_ctx: PgContext, ..._args: Parameters<Store["listExpiredMcpElicitations"]>): ReturnType<Store["listExpiredMcpElicitations"]> {
  throw new StoreNotImplementedError("listExpiredMcpElicitations");
}

export async function listMcpToolPolicies(_ctx: PgContext, ..._args: Parameters<Store["listMcpToolPolicies"]>): ReturnType<Store["listMcpToolPolicies"]> {
  throw new StoreNotImplementedError("listMcpToolPolicies");
}

export async function getMcpToolPolicy(_ctx: PgContext, ..._args: Parameters<Store["getMcpToolPolicy"]>): ReturnType<Store["getMcpToolPolicy"]> {
  throw new StoreNotImplementedError("getMcpToolPolicy");
}

export async function createMcpToolPolicy(_ctx: PgContext, ..._args: Parameters<Store["createMcpToolPolicy"]>): ReturnType<Store["createMcpToolPolicy"]> {
  throw new StoreNotImplementedError("createMcpToolPolicy");
}

export async function updateMcpToolPolicy(_ctx: PgContext, ..._args: Parameters<Store["updateMcpToolPolicy"]>): ReturnType<Store["updateMcpToolPolicy"]> {
  throw new StoreNotImplementedError("updateMcpToolPolicy");
}

export async function deleteMcpToolPolicy(_ctx: PgContext, ..._args: Parameters<Store["deleteMcpToolPolicy"]>): ReturnType<Store["deleteMcpToolPolicy"]> {
  throw new StoreNotImplementedError("deleteMcpToolPolicy");
}

export async function listMcpToolClassifications(_ctx: PgContext, ..._args: Parameters<Store["listMcpToolClassifications"]>): ReturnType<Store["listMcpToolClassifications"]> {
  throw new StoreNotImplementedError("listMcpToolClassifications");
}

export async function setMcpToolClassification(_ctx: PgContext, ..._args: Parameters<Store["setMcpToolClassification"]>): ReturnType<Store["setMcpToolClassification"]> {
  throw new StoreNotImplementedError("setMcpToolClassification");
}

export async function listMcpToolsets(_ctx: PgContext, ..._args: Parameters<Store["listMcpToolsets"]>): ReturnType<Store["listMcpToolsets"]> {
  throw new StoreNotImplementedError("listMcpToolsets");
}

export async function getMcpToolset(_ctx: PgContext, ..._args: Parameters<Store["getMcpToolset"]>): ReturnType<Store["getMcpToolset"]> {
  throw new StoreNotImplementedError("getMcpToolset");
}

export async function getMcpToolsetBySlug(_ctx: PgContext, ..._args: Parameters<Store["getMcpToolsetBySlug"]>): ReturnType<Store["getMcpToolsetBySlug"]> {
  throw new StoreNotImplementedError("getMcpToolsetBySlug");
}

export async function createMcpToolset(_ctx: PgContext, ..._args: Parameters<Store["createMcpToolset"]>): ReturnType<Store["createMcpToolset"]> {
  throw new StoreNotImplementedError("createMcpToolset");
}

export async function updateMcpToolset(_ctx: PgContext, ..._args: Parameters<Store["updateMcpToolset"]>): ReturnType<Store["updateMcpToolset"]> {
  throw new StoreNotImplementedError("updateMcpToolset");
}

export async function deleteMcpToolset(_ctx: PgContext, ..._args: Parameters<Store["deleteMcpToolset"]>): ReturnType<Store["deleteMcpToolset"]> {
  throw new StoreNotImplementedError("deleteMcpToolset");
}

export async function createMcpClient(_ctx: PgContext, ..._args: Parameters<Store["createMcpClient"]>): ReturnType<Store["createMcpClient"]> {
  throw new StoreNotImplementedError("createMcpClient");
}

export async function getMcpClient(_ctx: PgContext, ..._args: Parameters<Store["getMcpClient"]>): ReturnType<Store["getMcpClient"]> {
  throw new StoreNotImplementedError("getMcpClient");
}

export async function findMcpClientByTokenPrefix(_ctx: PgContext, ..._args: Parameters<Store["findMcpClientByTokenPrefix"]>): ReturnType<Store["findMcpClientByTokenPrefix"]> {
  throw new StoreNotImplementedError("findMcpClientByTokenPrefix");
}

export async function listMcpClients(_ctx: PgContext, ..._args: Parameters<Store["listMcpClients"]>): ReturnType<Store["listMcpClients"]> {
  throw new StoreNotImplementedError("listMcpClients");
}

export async function revokeMcpClient(_ctx: PgContext, ..._args: Parameters<Store["revokeMcpClient"]>): ReturnType<Store["revokeMcpClient"]> {
  throw new StoreNotImplementedError("revokeMcpClient");
}

export async function touchMcpClient(_ctx: PgContext, ..._args: Parameters<Store["touchMcpClient"]>): ReturnType<Store["touchMcpClient"]> {
  throw new StoreNotImplementedError("touchMcpClient");
}

export async function listMcpToolCallsForExecution(_ctx: PgContext, ..._args: Parameters<Store["listMcpToolCallsForExecution"]>): ReturnType<Store["listMcpToolCallsForExecution"]> {
  throw new StoreNotImplementedError("listMcpToolCallsForExecution");
}
