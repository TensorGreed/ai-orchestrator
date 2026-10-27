/**
 * Phase 13.1 — PostgresStore: Data destinations and destination rules.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { StoreNotImplementedError } from "../store-errors.js";
import { type Store } from "../store.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [
  "listWorkflowConfigsForDestinations",
  "listDataDestinations",
  "getDataDestination",
  "findDataDestinationByMatch",
  "insertDataDestination",
  "updateDataDestination",
  "deleteDataDestination"
];

export async function listWorkflowConfigsForDestinations(_ctx: PgContext, ..._args: Parameters<Store["listWorkflowConfigsForDestinations"]>): ReturnType<Store["listWorkflowConfigsForDestinations"]> {
  throw new StoreNotImplementedError("listWorkflowConfigsForDestinations");
}

export async function listDataDestinations(_ctx: PgContext, ..._args: Parameters<Store["listDataDestinations"]>): ReturnType<Store["listDataDestinations"]> {
  throw new StoreNotImplementedError("listDataDestinations");
}

export async function getDataDestination(_ctx: PgContext, ..._args: Parameters<Store["getDataDestination"]>): ReturnType<Store["getDataDestination"]> {
  throw new StoreNotImplementedError("getDataDestination");
}

export async function findDataDestinationByMatch(_ctx: PgContext, ..._args: Parameters<Store["findDataDestinationByMatch"]>): ReturnType<Store["findDataDestinationByMatch"]> {
  throw new StoreNotImplementedError("findDataDestinationByMatch");
}

export async function insertDataDestination(_ctx: PgContext, ..._args: Parameters<Store["insertDataDestination"]>): ReturnType<Store["insertDataDestination"]> {
  throw new StoreNotImplementedError("insertDataDestination");
}

export async function updateDataDestination(_ctx: PgContext, ..._args: Parameters<Store["updateDataDestination"]>): ReturnType<Store["updateDataDestination"]> {
  throw new StoreNotImplementedError("updateDataDestination");
}

export async function deleteDataDestination(_ctx: PgContext, ..._args: Parameters<Store["deleteDataDestination"]>): ReturnType<Store["deleteDataDestination"]> {
  throw new StoreNotImplementedError("deleteDataDestination");
}
