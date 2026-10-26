/**
 * Phase 13.1 — PostgresStore: Replay recordings, golden runs and sets, replay candidates and MCP cassettes (tapes).
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { StoreNotImplementedError } from "../store-errors.js";
import { type Store } from "../store.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [
  "saveMcpCassette",
  "getMcpCassetteSummary",
  "getMcpCassette",
  "getMcpCassetteForExecution",
  "listMcpCassettesForEvalRun",
  "listMcpCassettes",
  "mcpCassetteBadgesForExecutions",
  "deleteMcpCassette",
  "saveReplayRecording",
  "getReplayRecordingSummary",
  "getReplayRecording",
  "listReplayRecordings",
  "sumReplayRecordingBytesForWorkflow",
  "sumReplayRecordingBytes",
  "findReplayRecordingIdForExecution",
  "countReplayRecordingsForWorkflow",
  "replayGoldenBadgesForExecutions",
  "deleteReplayRecording",
  "saveReplayRecordingChecked",
  "promoteReplayCaptureToGoldenSet",
  "importGoldenSet"
];

export async function saveMcpCassette(_ctx: PgContext, ..._args: Parameters<Store["saveMcpCassette"]>): ReturnType<Store["saveMcpCassette"]> {
  throw new StoreNotImplementedError("saveMcpCassette");
}

export async function getMcpCassetteSummary(_ctx: PgContext, ..._args: Parameters<Store["getMcpCassetteSummary"]>): ReturnType<Store["getMcpCassetteSummary"]> {
  throw new StoreNotImplementedError("getMcpCassetteSummary");
}

export async function getMcpCassette(_ctx: PgContext, ..._args: Parameters<Store["getMcpCassette"]>): ReturnType<Store["getMcpCassette"]> {
  throw new StoreNotImplementedError("getMcpCassette");
}

export async function getMcpCassetteForExecution(_ctx: PgContext, ..._args: Parameters<Store["getMcpCassetteForExecution"]>): ReturnType<Store["getMcpCassetteForExecution"]> {
  throw new StoreNotImplementedError("getMcpCassetteForExecution");
}

export async function listMcpCassettesForEvalRun(_ctx: PgContext, ..._args: Parameters<Store["listMcpCassettesForEvalRun"]>): ReturnType<Store["listMcpCassettesForEvalRun"]> {
  throw new StoreNotImplementedError("listMcpCassettesForEvalRun");
}

export async function listMcpCassettes(_ctx: PgContext, ..._args: Parameters<Store["listMcpCassettes"]>): ReturnType<Store["listMcpCassettes"]> {
  throw new StoreNotImplementedError("listMcpCassettes");
}

export async function mcpCassetteBadgesForExecutions(_ctx: PgContext, ..._args: Parameters<Store["mcpCassetteBadgesForExecutions"]>): ReturnType<Store["mcpCassetteBadgesForExecutions"]> {
  throw new StoreNotImplementedError("mcpCassetteBadgesForExecutions");
}

export async function deleteMcpCassette(_ctx: PgContext, ..._args: Parameters<Store["deleteMcpCassette"]>): ReturnType<Store["deleteMcpCassette"]> {
  throw new StoreNotImplementedError("deleteMcpCassette");
}

export async function saveReplayRecording(_ctx: PgContext, ..._args: Parameters<Store["saveReplayRecording"]>): ReturnType<Store["saveReplayRecording"]> {
  throw new StoreNotImplementedError("saveReplayRecording");
}

export async function getReplayRecordingSummary(_ctx: PgContext, ..._args: Parameters<Store["getReplayRecordingSummary"]>): ReturnType<Store["getReplayRecordingSummary"]> {
  throw new StoreNotImplementedError("getReplayRecordingSummary");
}

export async function getReplayRecording(_ctx: PgContext, ..._args: Parameters<Store["getReplayRecording"]>): ReturnType<Store["getReplayRecording"]> {
  throw new StoreNotImplementedError("getReplayRecording");
}

export async function listReplayRecordings(_ctx: PgContext, ..._args: Parameters<Store["listReplayRecordings"]>): ReturnType<Store["listReplayRecordings"]> {
  throw new StoreNotImplementedError("listReplayRecordings");
}

export async function sumReplayRecordingBytesForWorkflow(_ctx: PgContext, ..._args: Parameters<Store["sumReplayRecordingBytesForWorkflow"]>): ReturnType<Store["sumReplayRecordingBytesForWorkflow"]> {
  throw new StoreNotImplementedError("sumReplayRecordingBytesForWorkflow");
}

export async function sumReplayRecordingBytes(_ctx: PgContext, ..._args: Parameters<Store["sumReplayRecordingBytes"]>): ReturnType<Store["sumReplayRecordingBytes"]> {
  throw new StoreNotImplementedError("sumReplayRecordingBytes");
}

export async function findReplayRecordingIdForExecution(_ctx: PgContext, ..._args: Parameters<Store["findReplayRecordingIdForExecution"]>): ReturnType<Store["findReplayRecordingIdForExecution"]> {
  throw new StoreNotImplementedError("findReplayRecordingIdForExecution");
}

export async function countReplayRecordingsForWorkflow(_ctx: PgContext, ..._args: Parameters<Store["countReplayRecordingsForWorkflow"]>): ReturnType<Store["countReplayRecordingsForWorkflow"]> {
  throw new StoreNotImplementedError("countReplayRecordingsForWorkflow");
}

export async function replayGoldenBadgesForExecutions(_ctx: PgContext, ..._args: Parameters<Store["replayGoldenBadgesForExecutions"]>): ReturnType<Store["replayGoldenBadgesForExecutions"]> {
  throw new StoreNotImplementedError("replayGoldenBadgesForExecutions");
}

export async function deleteReplayRecording(_ctx: PgContext, ..._args: Parameters<Store["deleteReplayRecording"]>): ReturnType<Store["deleteReplayRecording"]> {
  throw new StoreNotImplementedError("deleteReplayRecording");
}

export async function saveReplayRecordingChecked(_ctx: PgContext, ..._args: Parameters<Store["saveReplayRecordingChecked"]>): ReturnType<Store["saveReplayRecordingChecked"]> {
  throw new StoreNotImplementedError("saveReplayRecordingChecked");
}

export async function promoteReplayCaptureToGoldenSet(_ctx: PgContext, ..._args: Parameters<Store["promoteReplayCaptureToGoldenSet"]>): ReturnType<Store["promoteReplayCaptureToGoldenSet"]> {
  throw new StoreNotImplementedError("promoteReplayCaptureToGoldenSet");
}

export async function importGoldenSet(_ctx: PgContext, ..._args: Parameters<Store["importGoldenSet"]>): ReturnType<Store["importGoldenSet"]> {
  throw new StoreNotImplementedError("importGoldenSet");
}
