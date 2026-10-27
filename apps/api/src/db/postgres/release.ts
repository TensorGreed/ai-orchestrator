/**
 * Phase 13.1 — PostgresStore: Releases, publishing, gate admission and required cases.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { StoreNotImplementedError } from "../store-errors.js";
import { type Store } from "../store.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [
  "getPublishedVersion",
  "isWorkflowVersionPinned",
  "getReleaseGate",
  "upsertReleaseGate",
  "listWorkflowReleases",
  "hasReleasedVersion",
  "listReplayRunIdsForHash",
  "setEvalRunSetSnapshot",
  "getEvalRunSetSnapshot",
  "setExecutionRelease",
  "getExecutionRelease",
  "listReleasedVersionHashes",
  "listEnabledReleaseGateWorkflowIds",
  "timeOutExpiredReleaseApprovalRequests",
  "listPendingReleaseApprovalRequests",
  "insertReleaseApprovalRequest",
  "getReleaseApprovalRequest",
  "listReleaseApprovalRequests",
  "decideReleaseApprovalRequest",
  "setReleaseGateAdmission",
  "insertGateCaseRequest",
  "getGateCaseRequest",
  "listPendingGateCaseRequests",
  "listGateCaseRequests",
  "timeOutExpiredGateCaseRequests",
  "decideGateCaseRequest",
  "markEvalRunsReleaseIneligible",
  "publishWorkflowVersion",
  "saveReleaseGate",
  "updateReleaseGateCases",
  "approveReleaseRequestAndPublish"
];

export async function getPublishedVersion(_ctx: PgContext, ..._args: Parameters<Store["getPublishedVersion"]>): ReturnType<Store["getPublishedVersion"]> {
  throw new StoreNotImplementedError("getPublishedVersion");
}

export async function isWorkflowVersionPinned(_ctx: PgContext, ..._args: Parameters<Store["isWorkflowVersionPinned"]>): ReturnType<Store["isWorkflowVersionPinned"]> {
  throw new StoreNotImplementedError("isWorkflowVersionPinned");
}

export async function getReleaseGate(_ctx: PgContext, ..._args: Parameters<Store["getReleaseGate"]>): ReturnType<Store["getReleaseGate"]> {
  throw new StoreNotImplementedError("getReleaseGate");
}

export async function upsertReleaseGate(_ctx: PgContext, ..._args: Parameters<Store["upsertReleaseGate"]>): ReturnType<Store["upsertReleaseGate"]> {
  throw new StoreNotImplementedError("upsertReleaseGate");
}

export async function listWorkflowReleases(_ctx: PgContext, ..._args: Parameters<Store["listWorkflowReleases"]>): ReturnType<Store["listWorkflowReleases"]> {
  throw new StoreNotImplementedError("listWorkflowReleases");
}

export async function hasReleasedVersion(_ctx: PgContext, ..._args: Parameters<Store["hasReleasedVersion"]>): ReturnType<Store["hasReleasedVersion"]> {
  throw new StoreNotImplementedError("hasReleasedVersion");
}

export async function listReplayRunIdsForHash(_ctx: PgContext, ..._args: Parameters<Store["listReplayRunIdsForHash"]>): ReturnType<Store["listReplayRunIdsForHash"]> {
  throw new StoreNotImplementedError("listReplayRunIdsForHash");
}

export async function setEvalRunSetSnapshot(_ctx: PgContext, ..._args: Parameters<Store["setEvalRunSetSnapshot"]>): ReturnType<Store["setEvalRunSetSnapshot"]> {
  throw new StoreNotImplementedError("setEvalRunSetSnapshot");
}

export async function getEvalRunSetSnapshot(_ctx: PgContext, ..._args: Parameters<Store["getEvalRunSetSnapshot"]>): ReturnType<Store["getEvalRunSetSnapshot"]> {
  throw new StoreNotImplementedError("getEvalRunSetSnapshot");
}

export async function setExecutionRelease(_ctx: PgContext, ..._args: Parameters<Store["setExecutionRelease"]>): ReturnType<Store["setExecutionRelease"]> {
  throw new StoreNotImplementedError("setExecutionRelease");
}

export async function getExecutionRelease(_ctx: PgContext, ..._args: Parameters<Store["getExecutionRelease"]>): ReturnType<Store["getExecutionRelease"]> {
  throw new StoreNotImplementedError("getExecutionRelease");
}

export async function listReleasedVersionHashes(_ctx: PgContext, ..._args: Parameters<Store["listReleasedVersionHashes"]>): ReturnType<Store["listReleasedVersionHashes"]> {
  throw new StoreNotImplementedError("listReleasedVersionHashes");
}

export async function listEnabledReleaseGateWorkflowIds(_ctx: PgContext, ..._args: Parameters<Store["listEnabledReleaseGateWorkflowIds"]>): ReturnType<Store["listEnabledReleaseGateWorkflowIds"]> {
  throw new StoreNotImplementedError("listEnabledReleaseGateWorkflowIds");
}

export async function timeOutExpiredReleaseApprovalRequests(_ctx: PgContext, ..._args: Parameters<Store["timeOutExpiredReleaseApprovalRequests"]>): ReturnType<Store["timeOutExpiredReleaseApprovalRequests"]> {
  throw new StoreNotImplementedError("timeOutExpiredReleaseApprovalRequests");
}

export async function listPendingReleaseApprovalRequests(_ctx: PgContext, ..._args: Parameters<Store["listPendingReleaseApprovalRequests"]>): ReturnType<Store["listPendingReleaseApprovalRequests"]> {
  throw new StoreNotImplementedError("listPendingReleaseApprovalRequests");
}

export async function insertReleaseApprovalRequest(_ctx: PgContext, ..._args: Parameters<Store["insertReleaseApprovalRequest"]>): ReturnType<Store["insertReleaseApprovalRequest"]> {
  throw new StoreNotImplementedError("insertReleaseApprovalRequest");
}

export async function getReleaseApprovalRequest(_ctx: PgContext, ..._args: Parameters<Store["getReleaseApprovalRequest"]>): ReturnType<Store["getReleaseApprovalRequest"]> {
  throw new StoreNotImplementedError("getReleaseApprovalRequest");
}

export async function listReleaseApprovalRequests(_ctx: PgContext, ..._args: Parameters<Store["listReleaseApprovalRequests"]>): ReturnType<Store["listReleaseApprovalRequests"]> {
  throw new StoreNotImplementedError("listReleaseApprovalRequests");
}

export async function decideReleaseApprovalRequest(_ctx: PgContext, ..._args: Parameters<Store["decideReleaseApprovalRequest"]>): ReturnType<Store["decideReleaseApprovalRequest"]> {
  throw new StoreNotImplementedError("decideReleaseApprovalRequest");
}

export async function setReleaseGateAdmission(_ctx: PgContext, ..._args: Parameters<Store["setReleaseGateAdmission"]>): ReturnType<Store["setReleaseGateAdmission"]> {
  throw new StoreNotImplementedError("setReleaseGateAdmission");
}

export async function insertGateCaseRequest(_ctx: PgContext, ..._args: Parameters<Store["insertGateCaseRequest"]>): ReturnType<Store["insertGateCaseRequest"]> {
  throw new StoreNotImplementedError("insertGateCaseRequest");
}

export async function getGateCaseRequest(_ctx: PgContext, ..._args: Parameters<Store["getGateCaseRequest"]>): ReturnType<Store["getGateCaseRequest"]> {
  throw new StoreNotImplementedError("getGateCaseRequest");
}

export async function listPendingGateCaseRequests(_ctx: PgContext, ..._args: Parameters<Store["listPendingGateCaseRequests"]>): ReturnType<Store["listPendingGateCaseRequests"]> {
  throw new StoreNotImplementedError("listPendingGateCaseRequests");
}

export async function listGateCaseRequests(_ctx: PgContext, ..._args: Parameters<Store["listGateCaseRequests"]>): ReturnType<Store["listGateCaseRequests"]> {
  throw new StoreNotImplementedError("listGateCaseRequests");
}

export async function timeOutExpiredGateCaseRequests(_ctx: PgContext, ..._args: Parameters<Store["timeOutExpiredGateCaseRequests"]>): ReturnType<Store["timeOutExpiredGateCaseRequests"]> {
  throw new StoreNotImplementedError("timeOutExpiredGateCaseRequests");
}

export async function decideGateCaseRequest(_ctx: PgContext, ..._args: Parameters<Store["decideGateCaseRequest"]>): ReturnType<Store["decideGateCaseRequest"]> {
  throw new StoreNotImplementedError("decideGateCaseRequest");
}

export async function markEvalRunsReleaseIneligible(_ctx: PgContext, ..._args: Parameters<Store["markEvalRunsReleaseIneligible"]>): ReturnType<Store["markEvalRunsReleaseIneligible"]> {
  throw new StoreNotImplementedError("markEvalRunsReleaseIneligible");
}

export async function publishWorkflowVersion(_ctx: PgContext, ..._args: Parameters<Store["publishWorkflowVersion"]>): ReturnType<Store["publishWorkflowVersion"]> {
  throw new StoreNotImplementedError("publishWorkflowVersion");
}

export async function saveReleaseGate(_ctx: PgContext, ..._args: Parameters<Store["saveReleaseGate"]>): ReturnType<Store["saveReleaseGate"]> {
  throw new StoreNotImplementedError("saveReleaseGate");
}

export async function updateReleaseGateCases(_ctx: PgContext, ..._args: Parameters<Store["updateReleaseGateCases"]>): ReturnType<Store["updateReleaseGateCases"]> {
  throw new StoreNotImplementedError("updateReleaseGateCases");
}

export async function approveReleaseRequestAndPublish(_ctx: PgContext, ..._args: Parameters<Store["approveReleaseRequestAndPublish"]>): ReturnType<Store["approveReleaseRequestAndPublish"]> {
  throw new StoreNotImplementedError("approveReleaseRequestAndPublish");
}
