/**
 * Phase 13.1 — PostgresStore: Data labels and subject-row text paging/erasure.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { StoreNotImplementedError } from "../store-errors.js";
import { type Store } from "../store.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [
  "subjectTextPage",
  "subjectTextRow",
  "countSubjectRows",
  "deleteSubjectRow"
];

export async function subjectTextPage(_ctx: PgContext, ..._args: Parameters<Store["subjectTextPage"]>): ReturnType<Store["subjectTextPage"]> {
  throw new StoreNotImplementedError("subjectTextPage");
}

export async function subjectTextRow(_ctx: PgContext, ..._args: Parameters<Store["subjectTextRow"]>): ReturnType<Store["subjectTextRow"]> {
  throw new StoreNotImplementedError("subjectTextRow");
}

export async function countSubjectRows(_ctx: PgContext, ..._args: Parameters<Store["countSubjectRows"]>): ReturnType<Store["countSubjectRows"]> {
  throw new StoreNotImplementedError("countSubjectRows");
}

export async function deleteSubjectRow(_ctx: PgContext, ..._args: Parameters<Store["deleteSubjectRow"]>): ReturnType<Store["deleteSubjectRow"]> {
  throw new StoreNotImplementedError("deleteSubjectRow");
}
