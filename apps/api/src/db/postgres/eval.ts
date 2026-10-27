/**
 * Phase 13.1 — PostgresStore: Eval datasets, fixtures, runs and results.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { StoreNotImplementedError } from "../store-errors.js";
import { type Store } from "../store.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [
  "createEvalDataset",
  "listEvalDatasets",
  "getEvalDataset",
  "deleteEvalDataset",
  "createEvalFixture",
  "listEvalFixtures",
  "getEvalFixture",
  "findEvalFixtureByRecording",
  "getEvalFixtureDatasetId",
  "deleteEvalFixture",
  "setEvalFixtureRequired",
  "createEvalRun",
  "updateEvalRunProgress",
  "pruneEvalRuns",
  "finalizeEvalRun",
  "updateEvalRunSummary",
  "listEvalRuns",
  "getEvalRun",
  "recordEvalResult",
  "listEvalResults",
  "getEvalResult",
  "evalFixtureIdsForRecording",
  "evalRunIdsForResults",
  "deleteEvalFixturesForRecording"
];

export async function createEvalDataset(_ctx: PgContext, ..._args: Parameters<Store["createEvalDataset"]>): ReturnType<Store["createEvalDataset"]> {
  throw new StoreNotImplementedError("createEvalDataset");
}

export async function listEvalDatasets(_ctx: PgContext, ..._args: Parameters<Store["listEvalDatasets"]>): ReturnType<Store["listEvalDatasets"]> {
  throw new StoreNotImplementedError("listEvalDatasets");
}

export async function getEvalDataset(_ctx: PgContext, ..._args: Parameters<Store["getEvalDataset"]>): ReturnType<Store["getEvalDataset"]> {
  throw new StoreNotImplementedError("getEvalDataset");
}

export async function deleteEvalDataset(_ctx: PgContext, ..._args: Parameters<Store["deleteEvalDataset"]>): ReturnType<Store["deleteEvalDataset"]> {
  throw new StoreNotImplementedError("deleteEvalDataset");
}

export async function createEvalFixture(_ctx: PgContext, ..._args: Parameters<Store["createEvalFixture"]>): ReturnType<Store["createEvalFixture"]> {
  throw new StoreNotImplementedError("createEvalFixture");
}

export async function listEvalFixtures(_ctx: PgContext, ..._args: Parameters<Store["listEvalFixtures"]>): ReturnType<Store["listEvalFixtures"]> {
  throw new StoreNotImplementedError("listEvalFixtures");
}

export async function getEvalFixture(_ctx: PgContext, ..._args: Parameters<Store["getEvalFixture"]>): ReturnType<Store["getEvalFixture"]> {
  throw new StoreNotImplementedError("getEvalFixture");
}

export async function findEvalFixtureByRecording(_ctx: PgContext, ..._args: Parameters<Store["findEvalFixtureByRecording"]>): ReturnType<Store["findEvalFixtureByRecording"]> {
  throw new StoreNotImplementedError("findEvalFixtureByRecording");
}

export async function getEvalFixtureDatasetId(_ctx: PgContext, ..._args: Parameters<Store["getEvalFixtureDatasetId"]>): ReturnType<Store["getEvalFixtureDatasetId"]> {
  throw new StoreNotImplementedError("getEvalFixtureDatasetId");
}

export async function deleteEvalFixture(_ctx: PgContext, ..._args: Parameters<Store["deleteEvalFixture"]>): ReturnType<Store["deleteEvalFixture"]> {
  throw new StoreNotImplementedError("deleteEvalFixture");
}

export async function setEvalFixtureRequired(_ctx: PgContext, ..._args: Parameters<Store["setEvalFixtureRequired"]>): ReturnType<Store["setEvalFixtureRequired"]> {
  throw new StoreNotImplementedError("setEvalFixtureRequired");
}

export async function createEvalRun(_ctx: PgContext, ..._args: Parameters<Store["createEvalRun"]>): ReturnType<Store["createEvalRun"]> {
  throw new StoreNotImplementedError("createEvalRun");
}

export async function updateEvalRunProgress(_ctx: PgContext, ..._args: Parameters<Store["updateEvalRunProgress"]>): ReturnType<Store["updateEvalRunProgress"]> {
  throw new StoreNotImplementedError("updateEvalRunProgress");
}

export async function pruneEvalRuns(_ctx: PgContext, ..._args: Parameters<Store["pruneEvalRuns"]>): ReturnType<Store["pruneEvalRuns"]> {
  throw new StoreNotImplementedError("pruneEvalRuns");
}

export async function finalizeEvalRun(_ctx: PgContext, ..._args: Parameters<Store["finalizeEvalRun"]>): ReturnType<Store["finalizeEvalRun"]> {
  throw new StoreNotImplementedError("finalizeEvalRun");
}

export async function updateEvalRunSummary(_ctx: PgContext, ..._args: Parameters<Store["updateEvalRunSummary"]>): ReturnType<Store["updateEvalRunSummary"]> {
  throw new StoreNotImplementedError("updateEvalRunSummary");
}

export async function listEvalRuns(_ctx: PgContext, ..._args: Parameters<Store["listEvalRuns"]>): ReturnType<Store["listEvalRuns"]> {
  throw new StoreNotImplementedError("listEvalRuns");
}

export async function getEvalRun(_ctx: PgContext, ..._args: Parameters<Store["getEvalRun"]>): ReturnType<Store["getEvalRun"]> {
  throw new StoreNotImplementedError("getEvalRun");
}

export async function recordEvalResult(_ctx: PgContext, ..._args: Parameters<Store["recordEvalResult"]>): ReturnType<Store["recordEvalResult"]> {
  throw new StoreNotImplementedError("recordEvalResult");
}

export async function listEvalResults(_ctx: PgContext, ..._args: Parameters<Store["listEvalResults"]>): ReturnType<Store["listEvalResults"]> {
  throw new StoreNotImplementedError("listEvalResults");
}

export async function getEvalResult(_ctx: PgContext, ..._args: Parameters<Store["getEvalResult"]>): ReturnType<Store["getEvalResult"]> {
  throw new StoreNotImplementedError("getEvalResult");
}

export async function evalFixtureIdsForRecording(_ctx: PgContext, ..._args: Parameters<Store["evalFixtureIdsForRecording"]>): ReturnType<Store["evalFixtureIdsForRecording"]> {
  throw new StoreNotImplementedError("evalFixtureIdsForRecording");
}

export async function evalRunIdsForResults(_ctx: PgContext, ..._args: Parameters<Store["evalRunIdsForResults"]>): ReturnType<Store["evalRunIdsForResults"]> {
  throw new StoreNotImplementedError("evalRunIdsForResults");
}

export async function deleteEvalFixturesForRecording(_ctx: PgContext, ..._args: Parameters<Store["deleteEvalFixturesForRecording"]>): ReturnType<Store["deleteEvalFixturesForRecording"]> {
  throw new StoreNotImplementedError("deleteEvalFixturesForRecording");
}
