/**
 * Phase 13.1 — PostgresStore: Guard simulations.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { StoreNotImplementedError } from "../store-errors.js";
import { type Store } from "../store.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [
  "insertGuardSimulation",
  "updateGuardSimulation",
  "getGuardSimulation",
  "listGuardSimulations",
  "listRunningGuardSimulations",
  "pruneGuardSimulations"
];

export async function insertGuardSimulation(_ctx: PgContext, ..._args: Parameters<Store["insertGuardSimulation"]>): ReturnType<Store["insertGuardSimulation"]> {
  throw new StoreNotImplementedError("insertGuardSimulation");
}

export async function updateGuardSimulation(_ctx: PgContext, ..._args: Parameters<Store["updateGuardSimulation"]>): ReturnType<Store["updateGuardSimulation"]> {
  throw new StoreNotImplementedError("updateGuardSimulation");
}

export async function getGuardSimulation(_ctx: PgContext, ..._args: Parameters<Store["getGuardSimulation"]>): ReturnType<Store["getGuardSimulation"]> {
  throw new StoreNotImplementedError("getGuardSimulation");
}

export async function listGuardSimulations(_ctx: PgContext, ..._args: Parameters<Store["listGuardSimulations"]>): ReturnType<Store["listGuardSimulations"]> {
  throw new StoreNotImplementedError("listGuardSimulations");
}

export async function listRunningGuardSimulations(_ctx: PgContext, ..._args: Parameters<Store["listRunningGuardSimulations"]>): ReturnType<Store["listRunningGuardSimulations"]> {
  throw new StoreNotImplementedError("listRunningGuardSimulations");
}

export async function pruneGuardSimulations(_ctx: PgContext, ..._args: Parameters<Store["pruneGuardSimulations"]>): ReturnType<Store["pruneGuardSimulations"]> {
  throw new StoreNotImplementedError("pruneGuardSimulations");
}
