/**
 * Phase 13.1 — PostgresStore: Guard profiles, versions, bindings, events, vault and revision.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { StoreNotImplementedError } from "../store-errors.js";
import { type Store } from "../store.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [
  "listGuardProfiles",
  "getGuardProfile",
  "guardProfileRevision",
  "anyGuardProfileUsesLabels",
  "countObservedDestinationBlocks",
  "getGuardProfileVersion",
  "listGuardProfileVersions",
  "insertGuardProfile",
  "addGuardProfileVersion",
  "deleteGuardProfile",
  "getGuardBinding",
  "listGuardBindingsForProfile",
  "setGuardBinding",
  "insertGuardEvents",
  "listGuardEvents",
  "listGuardEventsForExecution",
  "guardEventStats",
  "getGuardVaultByToken",
  "getGuardVaultByHash",
  "putGuardVault"
];

export async function listGuardProfiles(_ctx: PgContext, ..._args: Parameters<Store["listGuardProfiles"]>): ReturnType<Store["listGuardProfiles"]> {
  throw new StoreNotImplementedError("listGuardProfiles");
}

export async function getGuardProfile(_ctx: PgContext, ..._args: Parameters<Store["getGuardProfile"]>): ReturnType<Store["getGuardProfile"]> {
  throw new StoreNotImplementedError("getGuardProfile");
}

export async function guardProfileRevision(_ctx: PgContext, ..._args: Parameters<Store["guardProfileRevision"]>): ReturnType<Store["guardProfileRevision"]> {
  throw new StoreNotImplementedError("guardProfileRevision");
}

export async function anyGuardProfileUsesLabels(_ctx: PgContext, ..._args: Parameters<Store["anyGuardProfileUsesLabels"]>): ReturnType<Store["anyGuardProfileUsesLabels"]> {
  throw new StoreNotImplementedError("anyGuardProfileUsesLabels");
}

export async function countObservedDestinationBlocks(_ctx: PgContext, ..._args: Parameters<Store["countObservedDestinationBlocks"]>): ReturnType<Store["countObservedDestinationBlocks"]> {
  throw new StoreNotImplementedError("countObservedDestinationBlocks");
}

export async function getGuardProfileVersion(_ctx: PgContext, ..._args: Parameters<Store["getGuardProfileVersion"]>): ReturnType<Store["getGuardProfileVersion"]> {
  throw new StoreNotImplementedError("getGuardProfileVersion");
}

export async function listGuardProfileVersions(_ctx: PgContext, ..._args: Parameters<Store["listGuardProfileVersions"]>): ReturnType<Store["listGuardProfileVersions"]> {
  throw new StoreNotImplementedError("listGuardProfileVersions");
}

export async function insertGuardProfile(_ctx: PgContext, ..._args: Parameters<Store["insertGuardProfile"]>): ReturnType<Store["insertGuardProfile"]> {
  throw new StoreNotImplementedError("insertGuardProfile");
}

export async function addGuardProfileVersion(_ctx: PgContext, ..._args: Parameters<Store["addGuardProfileVersion"]>): ReturnType<Store["addGuardProfileVersion"]> {
  throw new StoreNotImplementedError("addGuardProfileVersion");
}

export async function deleteGuardProfile(_ctx: PgContext, ..._args: Parameters<Store["deleteGuardProfile"]>): ReturnType<Store["deleteGuardProfile"]> {
  throw new StoreNotImplementedError("deleteGuardProfile");
}

export async function getGuardBinding(_ctx: PgContext, ..._args: Parameters<Store["getGuardBinding"]>): ReturnType<Store["getGuardBinding"]> {
  throw new StoreNotImplementedError("getGuardBinding");
}

export async function listGuardBindingsForProfile(_ctx: PgContext, ..._args: Parameters<Store["listGuardBindingsForProfile"]>): ReturnType<Store["listGuardBindingsForProfile"]> {
  throw new StoreNotImplementedError("listGuardBindingsForProfile");
}

export async function setGuardBinding(_ctx: PgContext, ..._args: Parameters<Store["setGuardBinding"]>): ReturnType<Store["setGuardBinding"]> {
  throw new StoreNotImplementedError("setGuardBinding");
}

export async function insertGuardEvents(_ctx: PgContext, ..._args: Parameters<Store["insertGuardEvents"]>): ReturnType<Store["insertGuardEvents"]> {
  throw new StoreNotImplementedError("insertGuardEvents");
}

export async function listGuardEvents(_ctx: PgContext, ..._args: Parameters<Store["listGuardEvents"]>): ReturnType<Store["listGuardEvents"]> {
  throw new StoreNotImplementedError("listGuardEvents");
}

export async function listGuardEventsForExecution(_ctx: PgContext, ..._args: Parameters<Store["listGuardEventsForExecution"]>): ReturnType<Store["listGuardEventsForExecution"]> {
  throw new StoreNotImplementedError("listGuardEventsForExecution");
}

export async function guardEventStats(_ctx: PgContext, ..._args: Parameters<Store["guardEventStats"]>): ReturnType<Store["guardEventStats"]> {
  throw new StoreNotImplementedError("guardEventStats");
}

export async function getGuardVaultByToken(_ctx: PgContext, ..._args: Parameters<Store["getGuardVaultByToken"]>): ReturnType<Store["getGuardVaultByToken"]> {
  throw new StoreNotImplementedError("getGuardVaultByToken");
}

export async function getGuardVaultByHash(_ctx: PgContext, ..._args: Parameters<Store["getGuardVaultByHash"]>): ReturnType<Store["getGuardVaultByHash"]> {
  throw new StoreNotImplementedError("getGuardVaultByHash");
}

export async function putGuardVault(_ctx: PgContext, ..._args: Parameters<Store["putGuardVault"]>): ReturnType<Store["putGuardVault"]> {
  throw new StoreNotImplementedError("putGuardVault");
}
