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
 * Model calls are not recorded; a replay calls the model live.
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
  type McpCassettePlayer,
  type MCPRegistry
} from "@ai-orchestrator/mcp-sdk";
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

export interface McpCassetteRunPlan {
  /** The registry the run uses instead of the deployment's. */
  registry: MCPRegistry;
  /** Replay only: resolves registry servers to the identity the cassette recorded. */
  resolveRegisteredMcpServer?: (registryServerId: string) => MCPServerConfig | Promise<MCPServerConfig>;
  recorder?: McpCassetteRecorder;
  player?: McpCassettePlayer;
  cassetteId?: string;
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

  /** A recorder plus the registry a recorded run uses. */
  planRecording(base: MCPRegistry): McpCassetteRunPlan {
    const recorder = new McpCassetteRecorder({
      maxBytes: this.options.maxBytes,
      maxEntries: this.options.maxCalls,
      redact: this.options.redact,
      snapshotHashFor: (registryServerId) => {
        const server = this.store.getMcpServer(registryServerId);
        return server ? (acceptedSnapshotFor(this.store, server)?.hash ?? null) : null;
      }
    });
    return { registry: createRecordingRegistry(base, recorder), recorder };
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
  planOfflineReplay(cassette: McpCassette | null, mode: McpReplayMode, cassetteId: string): McpCassetteRunPlan {
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
    const { registry, player } = createReplayRegistry(tape, { mode, redact: this.options.redact });
    const recorded = new Map(tape.servers.filter((server) => server.registryServerId).map((server) => [server.registryServerId!, server] as const));
    const resolveRegisteredMcpServer = async (registryServerId: string): Promise<MCPServerConfig> => {
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
    return this.store.saveMcpCassette({
      id: `mcpcas_${randomUUID()}`,
      executionId: input.executionId,
      workflowId: input.workflow.id,
      workflowName: input.workflow.name,
      projectId: input.workflow.projectId ?? null,
      source: input.source,
      evalRunId: input.evalRunId ?? null,
      fixtureId: input.fixtureId ?? null,
      cassette: input.plan.recorder.toCassette(),
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
