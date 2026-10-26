/**
 * Phase 13.1 — PostgresStore: Audit log, log streaming, audit export, signing keys and execution manifests.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { StoreNotImplementedError } from "../store-errors.js";
import { type Store } from "../store.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [
  "writeAuditLog",
  "verifyAuditChain",
  "listAuditLogs",
  "pruneAuditLogs",
  "listLogStreamDestinations",
  "getLogStreamDestination",
  "upsertLogStreamDestination",
  "deleteLogStreamDestination",
  "recordLogStreamDispatch",
  "writeLogStreamEvent",
  "listLogStreamEvents",
  "pruneLogStreamEvents",
  "createAuditExportDestination",
  "updateAuditExportDestination",
  "deleteAuditExportDestination",
  "listAuditExportDestinations",
  "getAuditExportDestination",
  "listAuditLogsAfter",
  "recordAuditExportRun",
  "listAuditExportRuns",
  "getExecutionManifest",
  "saveExecutionRunContext",
  "saveExecutionManifest",
  "listAuditLogsForExecution",
  "pruneExecutionManifests",
  "listAuditSigningKeys",
  "getAuditSigningKey",
  "getActiveAuditSigningKey",
  "activateAuditSigningKey"
];

export async function writeAuditLog(_ctx: PgContext, ..._args: Parameters<Store["writeAuditLog"]>): ReturnType<Store["writeAuditLog"]> {
  throw new StoreNotImplementedError("writeAuditLog");
}

export async function verifyAuditChain(_ctx: PgContext, ..._args: Parameters<Store["verifyAuditChain"]>): ReturnType<Store["verifyAuditChain"]> {
  throw new StoreNotImplementedError("verifyAuditChain");
}

export async function listAuditLogs(_ctx: PgContext, ..._args: Parameters<Store["listAuditLogs"]>): ReturnType<Store["listAuditLogs"]> {
  throw new StoreNotImplementedError("listAuditLogs");
}

export async function pruneAuditLogs(_ctx: PgContext, ..._args: Parameters<Store["pruneAuditLogs"]>): ReturnType<Store["pruneAuditLogs"]> {
  throw new StoreNotImplementedError("pruneAuditLogs");
}

export async function listLogStreamDestinations(_ctx: PgContext, ..._args: Parameters<Store["listLogStreamDestinations"]>): ReturnType<Store["listLogStreamDestinations"]> {
  throw new StoreNotImplementedError("listLogStreamDestinations");
}

export async function getLogStreamDestination(_ctx: PgContext, ..._args: Parameters<Store["getLogStreamDestination"]>): ReturnType<Store["getLogStreamDestination"]> {
  throw new StoreNotImplementedError("getLogStreamDestination");
}

export async function upsertLogStreamDestination(_ctx: PgContext, ..._args: Parameters<Store["upsertLogStreamDestination"]>): ReturnType<Store["upsertLogStreamDestination"]> {
  throw new StoreNotImplementedError("upsertLogStreamDestination");
}

export async function deleteLogStreamDestination(_ctx: PgContext, ..._args: Parameters<Store["deleteLogStreamDestination"]>): ReturnType<Store["deleteLogStreamDestination"]> {
  throw new StoreNotImplementedError("deleteLogStreamDestination");
}

export async function recordLogStreamDispatch(_ctx: PgContext, ..._args: Parameters<Store["recordLogStreamDispatch"]>): ReturnType<Store["recordLogStreamDispatch"]> {
  throw new StoreNotImplementedError("recordLogStreamDispatch");
}

export async function writeLogStreamEvent(_ctx: PgContext, ..._args: Parameters<Store["writeLogStreamEvent"]>): ReturnType<Store["writeLogStreamEvent"]> {
  throw new StoreNotImplementedError("writeLogStreamEvent");
}

export async function listLogStreamEvents(_ctx: PgContext, ..._args: Parameters<Store["listLogStreamEvents"]>): ReturnType<Store["listLogStreamEvents"]> {
  throw new StoreNotImplementedError("listLogStreamEvents");
}

export async function pruneLogStreamEvents(_ctx: PgContext, ..._args: Parameters<Store["pruneLogStreamEvents"]>): ReturnType<Store["pruneLogStreamEvents"]> {
  throw new StoreNotImplementedError("pruneLogStreamEvents");
}

export async function createAuditExportDestination(_ctx: PgContext, ..._args: Parameters<Store["createAuditExportDestination"]>): ReturnType<Store["createAuditExportDestination"]> {
  throw new StoreNotImplementedError("createAuditExportDestination");
}

export async function updateAuditExportDestination(_ctx: PgContext, ..._args: Parameters<Store["updateAuditExportDestination"]>): ReturnType<Store["updateAuditExportDestination"]> {
  throw new StoreNotImplementedError("updateAuditExportDestination");
}

export async function deleteAuditExportDestination(_ctx: PgContext, ..._args: Parameters<Store["deleteAuditExportDestination"]>): ReturnType<Store["deleteAuditExportDestination"]> {
  throw new StoreNotImplementedError("deleteAuditExportDestination");
}

export async function listAuditExportDestinations(_ctx: PgContext, ..._args: Parameters<Store["listAuditExportDestinations"]>): ReturnType<Store["listAuditExportDestinations"]> {
  throw new StoreNotImplementedError("listAuditExportDestinations");
}

export async function getAuditExportDestination(_ctx: PgContext, ..._args: Parameters<Store["getAuditExportDestination"]>): ReturnType<Store["getAuditExportDestination"]> {
  throw new StoreNotImplementedError("getAuditExportDestination");
}

export async function listAuditLogsAfter(_ctx: PgContext, ..._args: Parameters<Store["listAuditLogsAfter"]>): ReturnType<Store["listAuditLogsAfter"]> {
  throw new StoreNotImplementedError("listAuditLogsAfter");
}

export async function recordAuditExportRun(_ctx: PgContext, ..._args: Parameters<Store["recordAuditExportRun"]>): ReturnType<Store["recordAuditExportRun"]> {
  throw new StoreNotImplementedError("recordAuditExportRun");
}

export async function listAuditExportRuns(_ctx: PgContext, ..._args: Parameters<Store["listAuditExportRuns"]>): ReturnType<Store["listAuditExportRuns"]> {
  throw new StoreNotImplementedError("listAuditExportRuns");
}

export async function getExecutionManifest(_ctx: PgContext, ..._args: Parameters<Store["getExecutionManifest"]>): ReturnType<Store["getExecutionManifest"]> {
  throw new StoreNotImplementedError("getExecutionManifest");
}

export async function saveExecutionRunContext(_ctx: PgContext, ..._args: Parameters<Store["saveExecutionRunContext"]>): ReturnType<Store["saveExecutionRunContext"]> {
  throw new StoreNotImplementedError("saveExecutionRunContext");
}

export async function saveExecutionManifest(_ctx: PgContext, ..._args: Parameters<Store["saveExecutionManifest"]>): ReturnType<Store["saveExecutionManifest"]> {
  throw new StoreNotImplementedError("saveExecutionManifest");
}

export async function listAuditLogsForExecution(_ctx: PgContext, ..._args: Parameters<Store["listAuditLogsForExecution"]>): ReturnType<Store["listAuditLogsForExecution"]> {
  throw new StoreNotImplementedError("listAuditLogsForExecution");
}

export async function pruneExecutionManifests(_ctx: PgContext, ..._args: Parameters<Store["pruneExecutionManifests"]>): ReturnType<Store["pruneExecutionManifests"]> {
  throw new StoreNotImplementedError("pruneExecutionManifests");
}

export async function listAuditSigningKeys(_ctx: PgContext, ..._args: Parameters<Store["listAuditSigningKeys"]>): ReturnType<Store["listAuditSigningKeys"]> {
  throw new StoreNotImplementedError("listAuditSigningKeys");
}

export async function getAuditSigningKey(_ctx: PgContext, ..._args: Parameters<Store["getAuditSigningKey"]>): ReturnType<Store["getAuditSigningKey"]> {
  throw new StoreNotImplementedError("getAuditSigningKey");
}

export async function getActiveAuditSigningKey(_ctx: PgContext, ..._args: Parameters<Store["getActiveAuditSigningKey"]>): ReturnType<Store["getActiveAuditSigningKey"]> {
  throw new StoreNotImplementedError("getActiveAuditSigningKey");
}

export async function activateAuditSigningKey(_ctx: PgContext, ..._args: Parameters<Store["activateAuditSigningKey"]>): ReturnType<Store["activateAuditSigningKey"]> {
  throw new StoreNotImplementedError("activateAuditSigningKey");
}
