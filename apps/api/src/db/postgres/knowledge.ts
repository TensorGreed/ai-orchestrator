/**
 * Phase 13.1 — PostgresStore: Knowledge bases and their chunks/search.
 * Plain functions over a PgContext; PostgresStore delegates here. Methods that are not implemented yet throw
 * StoreNotImplementedError and are listed in UNIMPLEMENTED_METHODS (remove both together when implementing one).
 */
import { StoreNotImplementedError } from "../store-errors.js";
import { type Store } from "../store.js";
import type { PgContext } from "./context.js";

export const UNIMPLEMENTED_METHODS: readonly (keyof Store)[] = [
  "createKnowledgeBase",
  "updateKnowledgeBase",
  "deleteKnowledgeBase",
  "getKnowledgeBase",
  "listKnowledgeBases",
  "addKnowledgeBaseChunks",
  "listKnowledgeBaseChunks",
  "bm25SearchKnowledgeBase",
  "listKnowledgeBaseChunkPreviews",
  "deleteKnowledgeBaseChunksBySource",
  "listKnowledgeBaseSources"
];

export async function createKnowledgeBase(_ctx: PgContext, ..._args: Parameters<Store["createKnowledgeBase"]>): ReturnType<Store["createKnowledgeBase"]> {
  throw new StoreNotImplementedError("createKnowledgeBase");
}

export async function updateKnowledgeBase(_ctx: PgContext, ..._args: Parameters<Store["updateKnowledgeBase"]>): ReturnType<Store["updateKnowledgeBase"]> {
  throw new StoreNotImplementedError("updateKnowledgeBase");
}

export async function deleteKnowledgeBase(_ctx: PgContext, ..._args: Parameters<Store["deleteKnowledgeBase"]>): ReturnType<Store["deleteKnowledgeBase"]> {
  throw new StoreNotImplementedError("deleteKnowledgeBase");
}

export async function getKnowledgeBase(_ctx: PgContext, ..._args: Parameters<Store["getKnowledgeBase"]>): ReturnType<Store["getKnowledgeBase"]> {
  throw new StoreNotImplementedError("getKnowledgeBase");
}

export async function listKnowledgeBases(_ctx: PgContext, ..._args: Parameters<Store["listKnowledgeBases"]>): ReturnType<Store["listKnowledgeBases"]> {
  throw new StoreNotImplementedError("listKnowledgeBases");
}

export async function addKnowledgeBaseChunks(_ctx: PgContext, ..._args: Parameters<Store["addKnowledgeBaseChunks"]>): ReturnType<Store["addKnowledgeBaseChunks"]> {
  throw new StoreNotImplementedError("addKnowledgeBaseChunks");
}

export async function listKnowledgeBaseChunks(_ctx: PgContext, ..._args: Parameters<Store["listKnowledgeBaseChunks"]>): ReturnType<Store["listKnowledgeBaseChunks"]> {
  throw new StoreNotImplementedError("listKnowledgeBaseChunks");
}

export async function bm25SearchKnowledgeBase(_ctx: PgContext, ..._args: Parameters<Store["bm25SearchKnowledgeBase"]>): ReturnType<Store["bm25SearchKnowledgeBase"]> {
  throw new StoreNotImplementedError("bm25SearchKnowledgeBase");
}

export async function listKnowledgeBaseChunkPreviews(_ctx: PgContext, ..._args: Parameters<Store["listKnowledgeBaseChunkPreviews"]>): ReturnType<Store["listKnowledgeBaseChunkPreviews"]> {
  throw new StoreNotImplementedError("listKnowledgeBaseChunkPreviews");
}

export async function deleteKnowledgeBaseChunksBySource(_ctx: PgContext, ..._args: Parameters<Store["deleteKnowledgeBaseChunksBySource"]>): ReturnType<Store["deleteKnowledgeBaseChunksBySource"]> {
  throw new StoreNotImplementedError("deleteKnowledgeBaseChunksBySource");
}

export async function listKnowledgeBaseSources(_ctx: PgContext, ..._args: Parameters<Store["listKnowledgeBaseSources"]>): ReturnType<Store["listKnowledgeBaseSources"]> {
  throw new StoreNotImplementedError("listKnowledgeBaseSources");
}
