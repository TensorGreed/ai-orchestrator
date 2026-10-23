/**
 * Phase 15.1 — the stores a replay runs against.
 *
 * A replay must leave no trace in the deployment's state: session memory,
 * the session tool cache and session artifacts live in memory for the one
 * replay and are dropped with it, knowledge-base writes are refused (reads
 * go to the real store; retrieval nodes are stubbed by the replay plan
 * anyway), and an MCP server's question for a person is declined at once.
 *
 * Phase 15.3: session memory can be seeded with what the golden run's
 * sessions held when it started (its memory seed), so an agent with
 * memory sees the same history it saw then.
 */

import { randomUUID } from "node:crypto";
import type { AgentSessionMemoryStore, AgentSessionToolDataStore, AgentSessionToolRecord } from "@ai-orchestrator/agent-runtime";
import type { McpElicitationResult, ModelMemorySeed } from "@ai-orchestrator/shared";
import type { AgentSessionArtifactRecord, AgentSessionArtifactStore, KnowledgeBaseStore } from "@ai-orchestrator/workflow-engine";

export const REPLAY_KB_WRITE_REFUSED = "Knowledge base writes are not allowed in a replay.";

export interface ReplaySandbox {
  memoryStore: AgentSessionMemoryStore;
  toolDataStore: AgentSessionToolDataStore;
  sessionArtifactStore: AgentSessionArtifactStore;
  /** Elicitation handler: never asks a person. */
  onMcpElicitation: () => Promise<McpElicitationResult>;
  wrapKnowledgeBaseStore: (store: KnowledgeBaseStore) => KnowledgeBaseStore;
  /** What the replay wrote into its own stores (for tests and diagnostics). */
  stats: () => { memoryWrites: number; toolCacheWrites: number; artifactWrites: number };
}

const sessionKey = (namespace: string, sessionId: string) => `${namespace}\u0000${sessionId}`;

export function createReplaySandbox(seed?: ModelMemorySeed | null): ReplaySandbox {
  const memory = new Map<string, unknown[]>();
  for (const session of seed?.sessions ?? []) {
    if (typeof session.namespace === "string" && typeof session.sessionId === "string" && Array.isArray(session.messages)) {
      memory.set(sessionKey(session.namespace, session.sessionId), structuredClone(session.messages));
    }
  }
  const toolCalls = new Map<string, AgentSessionToolRecord[]>();
  const artifacts = new Map<string, AgentSessionArtifactRecord>();
  let memoryWrites = 0;
  let toolCacheWrites = 0;
  let artifactWrites = 0;

  const memoryStore: AgentSessionMemoryStore = {
    loadMessages: async (namespace, sessionId) => structuredClone((memory.get(sessionKey(namespace, sessionId)) ?? []) as Awaited<ReturnType<AgentSessionMemoryStore["loadMessages"]>>),
    saveMessages: async (namespace, sessionId, messages) => {
      memoryWrites += 1;
      memory.set(sessionKey(namespace, sessionId), structuredClone(messages));
    }
  };

  const toolDataStore: AgentSessionToolDataStore = {
    saveToolCall: async (input) => {
      toolCacheWrites += 1;
      const record: AgentSessionToolRecord = { id: `replay_tool_${randomUUID()}`, ...input, createdAt: new Date().toISOString() };
      const key = sessionKey(input.namespace, input.sessionId);
      toolCalls.set(key, [...(toolCalls.get(key) ?? []), record]);
      return record;
    },
    listToolCalls: async (input) =>
      (toolCalls.get(sessionKey(input.namespace, input.sessionId)) ?? [])
        .filter((record) => !input.toolName || record.toolName === input.toolName)
        .slice(-(input.limit ?? 50))
        .reverse()
        .map(({ output: _output, ...rest }) => rest),
    getToolCall: async (input) => (toolCalls.get(sessionKey(input.namespace, input.sessionId)) ?? []).find((record) => record.id === input.id) ?? null
  };

  const sessionArtifactStore: AgentSessionArtifactStore = {
    saveArtifact: async (input) => {
      artifactWrites += 1;
      const key = `${sessionKey(input.namespace, input.sessionId)}\u0000${input.artifactKey}`;
      const now = new Date().toISOString();
      const record: AgentSessionArtifactRecord = { ...input, createdAt: artifacts.get(key)?.createdAt ?? now, updatedAt: now };
      artifacts.set(key, record);
      return record;
    },
    loadArtifact: async (input) => artifacts.get(`${sessionKey(input.namespace, input.sessionId)}\u0000${input.artifactKey}`) ?? null
  };

  return {
    memoryStore,
    toolDataStore,
    sessionArtifactStore,
    onMcpElicitation: async () => ({ action: "decline" }),
    wrapKnowledgeBaseStore: (store) => ({
      addKnowledgeBaseChunks: () => {
        throw new Error(REPLAY_KB_WRITE_REFUSED);
      },
      listKnowledgeBaseChunks: (knowledgeBaseId) => store.listKnowledgeBaseChunks(knowledgeBaseId),
      ...(store.bm25SearchKnowledgeBase ? { bm25SearchKnowledgeBase: (input: Parameters<NonNullable<KnowledgeBaseStore["bm25SearchKnowledgeBase"]>>[0]) => store.bm25SearchKnowledgeBase!(input) } : {}),
      getKnowledgeBase: (id) => store.getKnowledgeBase(id)
    }),
    stats: () => ({ memoryWrites, toolCacheWrites, artifactWrites })
  };
}
