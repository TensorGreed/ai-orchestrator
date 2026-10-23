/**
 * Phase 10.8 — MCP cassettes on the API side.
 *
 *   - recording: a recorder per run, wrapped around the deployment's MCP
 *     registry; once the run ends the scrubbed cassette is stored with the
 *     execution (size-limited by MCP_CASSETTE_MAX_BYTES / _CALLS)
 *   - replay: a registry answering from a stored cassette, plus a server
 *     resolver that uses the identity the cassette recorded, so a replay
 *     needs neither the live server nor its secret
 *   - snapshots: the accepted snapshot of a registry server (the newest one
 *     not waiting behind an unaccepted breaking change) and its export file
 *
 * Phase 15.3: a recorded run also records its model calls (the model
 * tape, `@ai-orchestrator/provider-sdk`) and the session memory it first
 * read (the memory seed). Both are stored in the cassette (`llm: "tape"`),
 * scrubbed like its entries and under the same limits: the tape gets its
 * own MCP_CASSETTE_MAX_BYTES / MCP_CASSETTE_MAX_CALLS budget, the memory
 * seed MCP_CASSETTE_MAX_BYTES. They are pruned with the cassette. A golden
 * run saved from the run copies them.
 */

import { randomUUID } from "node:crypto";
import {
  MCP_CASSETTE_FORMAT,
  MCP_CASSETTE_VERSION,
  MCP_SNAPSHOT_FILE_FORMAT,
  MCP_SNAPSHOT_FILE_VERSION,
  type McpCassette,
  type McpCassetteRecord,
  type McpCassetteSource,
  type McpCassetteSummary,
  type McpReplayMode,
  type McpReplayReport,
  type MCPServerConfig,
  type McpSnapshotFile,
  type Workflow
} from "@ai-orchestrator/shared";
import {
  McpCassetteRecorder,
  createRecordingRegistry,
  createReplayRegistry,
  scrubForCassette,
  type McpCassettePlayer,
  type McpCassetteServerMode,
  type MCPRegistry
} from "@ai-orchestrator/mcp-sdk";
import {
  ModelTapeRecorder,
  createModelTapeRecordingRegistry,
  createModelTapeReplayRegistry,
  type ModelTapePlayer,
  type ModelTapeScrub,
  type ProviderRegistry
} from "@ai-orchestrator/provider-sdk";
import type { AgentSessionMemoryStore } from "@ai-orchestrator/agent-runtime";
import type { ChatMessage, ModelMemorySeed, ModelMemorySeedEntry, ModelTape, ModelTapeMode } from "@ai-orchestrator/shared";
import type { McpServerRecord, McpToolSnapshotRecord, SqliteStore } from "../db/database.js";

/** How far back the accepted-snapshot walk goes before giving up. */
const MAX_SNAPSHOT_WALK = 100;

/**
 * The snapshot runs are judged against: the current one, unless a breaking
 * change is waiting to be accepted, in which case the newest snapshot before
 * it that is not itself an unaccepted breaking change.
 */
export function acceptedSnapshotFor(store: SqliteStore, server: McpServerRecord): McpToolSnapshotRecord | null {
  let snapshotId = server.currentSnapshotId;
  if (server.pendingBreakingSnapshotId) {
    snapshotId = store.getMcpToolSnapshot(server.pendingBreakingSnapshotId)?.previousSnapshotId ?? null;
  }
  let snapshot = snapshotId ? store.getMcpToolSnapshot(snapshotId) : null;
  for (let steps = 0; snapshot && snapshot.breaking && !snapshot.acknowledgedAt && steps < MAX_SNAPSHOT_WALK; steps += 1) {
    snapshot = snapshot.previousSnapshotId ? store.getMcpToolSnapshot(snapshot.previousSnapshotId) : null;
  }
  return snapshot;
}

/** The export file for a server's accepted snapshot, with its resource and prompt catalog. Null before the first probe. */
export function buildSnapshotFile(store: SqliteStore, server: McpServerRecord): McpSnapshotFile | null {
  const snapshot = acceptedSnapshotFor(store, server);
  if (!snapshot) return null;
  const catalog = store.getMcpServerCatalog(server.id);
  return {
    format: MCP_SNAPSHOT_FILE_FORMAT,
    version: MCP_SNAPSHOT_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    server: { id: server.id, name: server.name, adapterId: server.adapterId },
    snapshot: { id: snapshot.id, hash: snapshot.hash, createdAt: snapshot.createdAt, tools: snapshot.tools },
    ...(catalog
      ? {
          catalog: {
            capabilities: catalog.capabilities,
            resources: catalog.resources,
            resourceTemplates: catalog.resourceTemplates,
            prompts: catalog.prompts
          }
        }
      : {})
  };
}

/**
 * Phase 15.3 — what session memory held for each session a recorded run
 * read, before the run changed it: the first `loadMessages` answer per
 * namespace and session, scrubbed, within a byte budget.
 */
export class MemorySeedCapture {
  private readonly sessions = new Map<string, ModelMemorySeedEntry>();
  private bytes = 0;
  private truncated = false;

  constructor(private readonly options: { maxBytes: number; scrub: (value: unknown) => unknown }) {}

  /** A memory store that records what each session held the first time the run read it. */
  wrap(store: AgentSessionMemoryStore): AgentSessionMemoryStore {
    return {
      loadMessages: async (namespace, sessionId) => {
        const messages = await store.loadMessages(namespace, sessionId);
        this.capture(namespace, sessionId, messages);
        return messages;
      },
      saveMessages: (namespace, sessionId, messages) => store.saveMessages(namespace, sessionId, messages)
    };
  }

  private capture(namespace: string, sessionId: string, messages: ChatMessage[]): void {
    const key = `${namespace}\u0000${sessionId}`;
    if (this.sessions.has(key) || this.truncated) return;
    const entry: ModelMemorySeedEntry = { namespace, sessionId, messages: this.options.scrub(messages) as ChatMessage[] };
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (this.bytes + size > this.options.maxBytes) {
      this.truncated = true;
      return;
    }
    this.bytes += size;
    this.sessions.set(key, entry);
  }

  toSeed(): ModelMemorySeed | null {
    if (this.sessions.size === 0 && !this.truncated) return null;
    return { sessions: [...this.sessions.values()], truncated: this.truncated };
  }
}

export interface McpCassetteRunPlan {
  /** The registry the run uses instead of the deployment's. */
  registry: MCPRegistry;
  /** Replay only: resolves registry servers to the identity the cassette recorded. */
  resolveRegisteredMcpServer?: (registryServerId: string) => MCPServerConfig | Promise<MCPServerConfig>;
  recorder?: McpCassetteRecorder;
  player?: McpCassettePlayer;
  cassetteId?: string;
  /** Phase 15.3 — the provider registry the run uses instead of the deployment's (recording the model tape). */
  providerRegistry?: ProviderRegistry;
  modelRecorder?: ModelTapeRecorder;
  memoryCapture?: MemorySeedCapture;
}

/** Phase 15.3 — options for the MCP side of a golden-run replay. */
export interface OfflineReplayOptions {
  /** Per-server modes, keyed by registry server id or adapter id. */
  serverModes?: Record<string, McpCassetteServerMode>;
  /** For `live_read_only` servers: the deployment's registry, how to resolve a registry server live, and the read-only verdict. */
  liveReads?: {
    registry: MCPRegistry;
    resolve: (registryServerId: string) => MCPServerConfig | Promise<MCPServerConfig>;
    isReadOnlyTool: (input: { config: MCPServerConfig; toolName: string; annotations?: Record<string, unknown> }) => boolean;
  };
}

/** Phase 15.3 — a model replay: the registry answering from a golden run's tape, and its player. */
export interface ModelReplayPlan {
  registry: ProviderRegistry;
  player: ModelTapePlayer;
}

export interface McpCassetteServiceOptions {
  maxBytes: number;
  maxCalls: number;
  /** String redaction applied on top of the cassette scrubber (the SecretService value patterns). */
  redact: (value: string) => string;
}

export class McpCassetteService {
  constructor(
    private readonly store: SqliteStore,
    private readonly options: McpCassetteServiceOptions
  ) {}

  /** Scrubs model tape and memory seed values the way cassette entries are scrubbed. */
  tapeScrub(): ModelTapeScrub {
    return (value, secrets) => scrubForCassette(value, { secrets, redact: this.options.redact });
  }

  /**
   * A recorder plus the registry a recorded run uses. With `providers`, the
   * run's model calls and memory reads are recorded too (Phase 15.3).
   */
  planRecording(base: MCPRegistry, providers?: ProviderRegistry): McpCassetteRunPlan {
    const recorder = new McpCassetteRecorder({
      maxBytes: this.options.maxBytes,
      maxEntries: this.options.maxCalls,
      redact: this.options.redact,
      snapshotHashFor: (registryServerId) => {
        const server = this.store.getMcpServer(registryServerId);
        return server ? (acceptedSnapshotFor(this.store, server)?.hash ?? null) : null;
      }
    });
    const plan: McpCassetteRunPlan = { registry: createRecordingRegistry(base, recorder), recorder };
    if (providers) {
      const scrub = this.tapeScrub();
      const modelRecorder = new ModelTapeRecorder({ maxBytes: this.options.maxBytes, maxEntries: this.options.maxCalls, scrub });
      plan.modelRecorder = modelRecorder;
      plan.providerRegistry = createModelTapeRecordingRegistry(providers, modelRecorder);
      plan.memoryCapture = new MemorySeedCapture({ maxBytes: this.options.maxBytes, scrub: (value) => scrub(value, []) });
    }
    return plan;
  }

  /**
   * Phase 15.3 — a registry answering model calls from a golden run's tape.
   * Strict misses fail; lenient misses go to `live` (counted in the report).
   */
  planModelReplay(tape: ModelTape, mode: ModelTapeMode, live: ProviderRegistry): ModelReplayPlan {
    return createModelTapeReplayRegistry(tape, { mode, ...(mode === "lenient" ? { live } : {}), scrub: this.tapeScrub() });
  }

  /**
   * A registry that answers from `record`. Strict replays never reach a live
   * server; lenient ones send calls the cassette never saw to `live`.
   */
  planReplay(
    record: McpCassetteRecord,
    mode: McpReplayMode,
    live: MCPRegistry,
    resolveLive: ((registryServerId: string) => MCPServerConfig | Promise<MCPServerConfig>) | undefined
  ): McpCassetteRunPlan {
    const { registry, player } = createReplayRegistry(record.cassette, {
      mode,
      redact: this.options.redact,
      ...(mode === "lenient" ? { live } : {})
    });
    const recorded = new Map(
      record.cassette.servers
        .filter((server) => server.registryServerId)
        .map((server) => [server.registryServerId!, server] as const)
    );
    const resolveRegisteredMcpServer = async (registryServerId: string): Promise<MCPServerConfig> => {
      const server = recorded.get(registryServerId);
      if (server) {
        return {
          serverId: server.adapterId,
          registryServerId,
          ...(server.label ? { label: server.label } : {}),
          connection: {}
        };
      }
      if (mode === "lenient" && resolveLive) return resolveLive(registryServerId);
      throw new Error(
        `Cassette replay (${mode}): the cassette has no calls to registry server ${registryServerId}. Re-record the cassette or replay in lenient mode.`
      );
    };
    return { registry, resolveRegisteredMcpServer, player, cassetteId: record.id };
  }

  /**
   * Phase 15.1 — a replay registry for a golden run's copied cassette that
   * never reaches a live server, in either mode: `lenient` only lets a call
   * made more often than recorded reuse its last answer. A run without a
   * cassette gets an empty one, so every
   * MCP call fails instead of going live.
   */
  planOfflineReplay(cassette: McpCassette | null, mode: McpReplayMode, cassetteId: string, options: OfflineReplayOptions = {}): McpCassetteRunPlan {
    const tape: McpCassette = cassette ?? {
      format: MCP_CASSETTE_FORMAT,
      version: MCP_CASSETTE_VERSION,
      recordedAt: new Date(0).toISOString(),
      servers: [],
      entries: [],
      truncated: false,
      bytes: 0,
      llm: "not_recorded"
    };
    const serverModes = options.serverModes && Object.keys(options.serverModes).length > 0 ? options.serverModes : undefined;
    const liveReads = serverModes && Object.values(serverModes).includes("live_read_only") ? options.liveReads : undefined;
    const { registry, player } = createReplayRegistry(tape, {
      mode,
      redact: this.options.redact,
      ...(serverModes ? { serverModes } : {}),
      ...(liveReads ? { liveReads: liveReads.registry, isReadOnlyTool: liveReads.isReadOnlyTool } : {})
    });
    const recorded = new Map(tape.servers.filter((server) => server.registryServerId).map((server) => [server.registryServerId!, server] as const));
    const resolveRegisteredMcpServer = async (registryServerId: string): Promise<MCPServerConfig> => {
      // A live-read server needs its real connection for the reads that go live; its key stays `registry:<id>`.
      if (liveReads && serverModes?.[registryServerId] === "live_read_only") return liveReads.resolve(registryServerId);
      const server = recorded.get(registryServerId);
      if (!server) {
        throw new Error(`Golden run replay: the recording has no calls to registry server ${registryServerId}, and replays never call a live server.`);
      }
      return { serverId: server.adapterId, registryServerId, ...(server.label ? { label: server.label } : {}), connection: {} };
    };
    return { registry, resolveRegisteredMcpServer, player, cassetteId };
  }

  /** Store what a recorded run captured. Returns null when there was nothing to record into. */
  persist(input: {
    plan: McpCassetteRunPlan;
    executionId: string | null;
    workflow: Pick<Workflow, "id" | "name" | "projectId">;
    source: McpCassetteSource;
    evalRunId?: string | null;
    fixtureId?: string | null;
    createdBy: string | null;
  }): McpCassetteSummary | null {
    if (!input.plan.recorder) return null;
    const cassette: McpCassette = input.plan.recorder.toCassette();
    if (input.plan.modelRecorder) {
      cassette.llm = "tape";
      cassette.models = input.plan.modelRecorder.toTape();
      const seed = input.plan.memoryCapture?.toSeed();
      if (seed) cassette.memorySeed = seed;
    }
    return this.store.saveMcpCassette({
      id: `mcpcas_${randomUUID()}`,
      executionId: input.executionId,
      workflowId: input.workflow.id,
      workflowName: input.workflow.name,
      projectId: input.workflow.projectId ?? null,
      source: input.source,
      evalRunId: input.evalRunId ?? null,
      fixtureId: input.fixtureId ?? null,
      cassette,
      createdBy: input.createdBy
    });
  }

  report(plan: McpCassetteRunPlan): McpReplayReport | null {
    return plan.player && plan.cassetteId ? plan.player.report(plan.cassetteId) : null;
  }
}

/**
 * A strict replay that met calls the cassette could not answer is a failed
 * run, even when an agent carried on after its tool error. The run's own
 * status is kept when it already failed.
 */
export function applyReplayOutcome<T extends { status: string; error?: string }>(result: T, report: McpReplayReport | null): T {
  if (!report || report.mode !== "strict" || report.unmatched.length === 0 || result.status === "error") return result;
  const count = report.unmatched.length;
  return {
    ...result,
    status: "error",
    error: `Replay diverged from the cassette: ${count} MCP call${count === 1 ? "" : "s"} had no recorded answer. ${report.unmatched[0].reason}`
  };
}
