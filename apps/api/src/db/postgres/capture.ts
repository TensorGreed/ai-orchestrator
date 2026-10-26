/**
 * Phase 13.1 — PostgresStore: Replay capture settings, captured runs and retention.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { StoreNotImplementedError } from "../store-errors.js";
import { type Store } from "../store.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [
  "listReplayCaptures",
  "countReplayCapturesSince",
  "oldestReplayCaptureIds",
  "pruneReplayCaptures",
  "promoteReplayCapture",
  "getReplayCaptureSettings",
  "saveReplayCaptureSettings",
  "recordReplayCaptureDrop",
  "sumReplayCaptureBytesForWorkflow",
  "oldestReplayCaptures"
];

export async function listReplayCaptures(_ctx: PgContext, ..._args: Parameters<Store["listReplayCaptures"]>): ReturnType<Store["listReplayCaptures"]> {
  throw new StoreNotImplementedError("listReplayCaptures");
}

export async function countReplayCapturesSince(_ctx: PgContext, ..._args: Parameters<Store["countReplayCapturesSince"]>): ReturnType<Store["countReplayCapturesSince"]> {
  throw new StoreNotImplementedError("countReplayCapturesSince");
}

export async function oldestReplayCaptureIds(_ctx: PgContext, ..._args: Parameters<Store["oldestReplayCaptureIds"]>): ReturnType<Store["oldestReplayCaptureIds"]> {
  throw new StoreNotImplementedError("oldestReplayCaptureIds");
}

export async function pruneReplayCaptures(_ctx: PgContext, ..._args: Parameters<Store["pruneReplayCaptures"]>): ReturnType<Store["pruneReplayCaptures"]> {
  throw new StoreNotImplementedError("pruneReplayCaptures");
}

export async function promoteReplayCapture(_ctx: PgContext, ..._args: Parameters<Store["promoteReplayCapture"]>): ReturnType<Store["promoteReplayCapture"]> {
  throw new StoreNotImplementedError("promoteReplayCapture");
}

export async function getReplayCaptureSettings(_ctx: PgContext, ..._args: Parameters<Store["getReplayCaptureSettings"]>): ReturnType<Store["getReplayCaptureSettings"]> {
  throw new StoreNotImplementedError("getReplayCaptureSettings");
}

export async function saveReplayCaptureSettings(_ctx: PgContext, ..._args: Parameters<Store["saveReplayCaptureSettings"]>): ReturnType<Store["saveReplayCaptureSettings"]> {
  throw new StoreNotImplementedError("saveReplayCaptureSettings");
}

export async function recordReplayCaptureDrop(_ctx: PgContext, ..._args: Parameters<Store["recordReplayCaptureDrop"]>): ReturnType<Store["recordReplayCaptureDrop"]> {
  throw new StoreNotImplementedError("recordReplayCaptureDrop");
}

export async function sumReplayCaptureBytesForWorkflow(_ctx: PgContext, ..._args: Parameters<Store["sumReplayCaptureBytesForWorkflow"]>): ReturnType<Store["sumReplayCaptureBytesForWorkflow"]> {
  throw new StoreNotImplementedError("sumReplayCaptureBytesForWorkflow");
}

export async function oldestReplayCaptures(_ctx: PgContext, ..._args: Parameters<Store["oldestReplayCaptures"]>): ReturnType<Store["oldestReplayCaptures"]> {
  throw new StoreNotImplementedError("oldestReplayCaptures");
}
