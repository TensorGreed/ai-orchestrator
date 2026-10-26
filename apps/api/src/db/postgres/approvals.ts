/**
 * Phase 13.1 — PostgresStore: Approval requests and the atomic claim-and-decide operations.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { StoreNotImplementedError } from "../store-errors.js";
import { type Store } from "../store.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [
  "insertApprovalRequest",
  "getApprovalRequest",
  "getPendingApprovalRequestForExecution",
  "listApprovalRequestsForExecution",
  "listApprovalRequests",
  "listExpiredApprovalRequests",
  "decideApprovalRequest",
  "reopenApprovalRequest",
  "cancelPendingApprovalRequests",
  "claimExecutionAndDecideApproval",
  "releaseExecutionClaimAndReopenApproval"
];

export async function insertApprovalRequest(_ctx: PgContext, ..._args: Parameters<Store["insertApprovalRequest"]>): ReturnType<Store["insertApprovalRequest"]> {
  throw new StoreNotImplementedError("insertApprovalRequest");
}

export async function getApprovalRequest(_ctx: PgContext, ..._args: Parameters<Store["getApprovalRequest"]>): ReturnType<Store["getApprovalRequest"]> {
  throw new StoreNotImplementedError("getApprovalRequest");
}

export async function getPendingApprovalRequestForExecution(_ctx: PgContext, ..._args: Parameters<Store["getPendingApprovalRequestForExecution"]>): ReturnType<Store["getPendingApprovalRequestForExecution"]> {
  throw new StoreNotImplementedError("getPendingApprovalRequestForExecution");
}

export async function listApprovalRequestsForExecution(_ctx: PgContext, ..._args: Parameters<Store["listApprovalRequestsForExecution"]>): ReturnType<Store["listApprovalRequestsForExecution"]> {
  throw new StoreNotImplementedError("listApprovalRequestsForExecution");
}

export async function listApprovalRequests(_ctx: PgContext, ..._args: Parameters<Store["listApprovalRequests"]>): ReturnType<Store["listApprovalRequests"]> {
  throw new StoreNotImplementedError("listApprovalRequests");
}

export async function listExpiredApprovalRequests(_ctx: PgContext, ..._args: Parameters<Store["listExpiredApprovalRequests"]>): ReturnType<Store["listExpiredApprovalRequests"]> {
  throw new StoreNotImplementedError("listExpiredApprovalRequests");
}

export async function decideApprovalRequest(_ctx: PgContext, ..._args: Parameters<Store["decideApprovalRequest"]>): ReturnType<Store["decideApprovalRequest"]> {
  throw new StoreNotImplementedError("decideApprovalRequest");
}

export async function reopenApprovalRequest(_ctx: PgContext, ..._args: Parameters<Store["reopenApprovalRequest"]>): ReturnType<Store["reopenApprovalRequest"]> {
  throw new StoreNotImplementedError("reopenApprovalRequest");
}

export async function cancelPendingApprovalRequests(_ctx: PgContext, ..._args: Parameters<Store["cancelPendingApprovalRequests"]>): ReturnType<Store["cancelPendingApprovalRequests"]> {
  throw new StoreNotImplementedError("cancelPendingApprovalRequests");
}

export async function claimExecutionAndDecideApproval(_ctx: PgContext, ..._args: Parameters<Store["claimExecutionAndDecideApproval"]>): ReturnType<Store["claimExecutionAndDecideApproval"]> {
  throw new StoreNotImplementedError("claimExecutionAndDecideApproval");
}

export async function releaseExecutionClaimAndReopenApproval(_ctx: PgContext, ..._args: Parameters<Store["releaseExecutionClaimAndReopenApproval"]>): ReturnType<Store["releaseExecutionClaimAndReopenApproval"]> {
  throw new StoreNotImplementedError("releaseExecutionClaimAndReopenApproval");
}
