/**
 * Phase 10.1 — MCP server registry health probes.
 *
 * Each probe opens a short-lived session against a registered server, runs
 * `initialize` + `tools/list` through the server's adapter, records latency
 * and outcome, and snapshots the tool schemas whenever their hash changes.
 * A snapshot whose diff against the previous one is breaking becomes the
 * server's pending breaking change; servers with `blockOnBreakingChange`
 * refuse to run until someone accepts it.
 *
 * The background loop only probes on the leader instance (HA deployments) and
 * is off entirely when MCP_PROBE_INTERVAL_MS is 0. "Probe now" from the API
 * works regardless.
 *
 * Phase 10.7 — probes bypass rate limits and the circuit breaker (they are
 * how an admin finds out whether a paused server is back), record what the
 * sandbox check found, and probe a delegated server with one user's own
 * connection: the user who pressed "Probe now", or for background probes the
 * user who registered the server. Without such a connection a background
 * probe is skipped rather than recorded as down.
 */

import { randomUUID } from "node:crypto";
import type { McpListChangedEvent, MCPServerConfig, McpSandboxStatus, McpServerCatalog, SecretReference } from "@ai-orchestrator/shared";
import {
  diffToolSnapshots,
  hashToolSnapshot,
  normalizeToolSnapshot,
  type MCPExecutionContext,
  type MCPRegistry
} from "@ai-orchestrator/mcp-sdk";
import type {
  McpServerProbeRecord,
  McpServerRecord,
  McpServerStatus,
  McpToolSnapshotRecord
} from "../db/database.js";
import type { Store } from "../db/store.js";

type Logger = {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
};

export interface McpProbeOutcome {
  server: McpServerRecord;
  probe: McpServerProbeRecord;
  /** Present when the probe saw a tool schema different from the current snapshot. */
  snapshot?: McpToolSnapshotRecord;
  /** Phase 10.5 — resources, templates and prompts the server advertised (informational, never part of the tool hash). */
  catalog?: McpServerCatalog;
}

/** Phase 10.5 — how long after a `list_changed` notification the re-probe runs; bursts collapse into one. */
export const LIST_CHANGED_REPROBE_DELAY_MS = 2_000;

export interface McpLatencyStats {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Share of failed probes among the sampled ones, 0..1. */
  errorRate: number | null;
}

/** Probes looked at when deciding between healthy and degraded. */
const STATUS_WINDOW = 5;

export function serverConfigFromRecord(server: McpServerRecord): MCPServerConfig {
  return {
    serverId: server.adapterId,
    registryServerId: server.id,
    label: server.name,
    connection: server.connection,
    sampling: server.sampling,
    secretRef: server.secretId ? ({ secretId: server.secretId } satisfies SecretReference) : undefined,
    // Phase 10.7 — runtime safety.
    ...(server.adapterId === "stdio_mcp" && server.sandbox ? { sandbox: server.sandbox } : {}),
    limits: server.limits,
    credentialMode: server.credentialMode,
    delegatedFallback: server.delegatedFallback
  };
}

/** Phase 10.7 — a probe that could not run (a delegated server nobody can probe as). */
export class McpProbeSkippedError extends Error {
  readonly statusCode = 409;
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function latencyStats(probes: McpServerProbeRecord[]): McpLatencyStats {
  if (probes.length === 0) {
    return { samples: 0, p50Ms: null, p95Ms: null, errorRate: null };
  }
  const latencies = probes
    .filter((probe) => probe.ok)
    .map((probe) => probe.latencyMs)
    .sort((a, b) => a - b);
  return {
    samples: probes.length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    errorRate: probes.filter((probe) => !probe.ok).length / probes.length
  };
}

/** `recent` is newest first and already includes the probe being recorded. */
export function deriveStatus(recent: Array<Pick<McpServerProbeRecord, "ok">>): McpServerStatus {
  if (recent.length === 0) return "unknown";
  if (!recent[0].ok) return "down";
  return recent.slice(0, STATUS_WINDOW).every((probe) => probe.ok) ? "healthy" : "degraded";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Probe timed out after ${timeoutMs} ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class McpProbeService {
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Map<string, Promise<McpProbeOutcome>>();
  private logger?: Logger;

  private readonly reprobeTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: Store,
    private readonly mcpRegistry: MCPRegistry,
    private readonly deps: {
      resolveSecret: (secretRef?: SecretReference) => Promise<string | undefined>;
      isLeader: () => boolean;
      /** Phase 10.7 — what the sandbox launcher thinks of a stdio server (no process is started). */
      checkSandbox?: (config: MCPServerConfig) => McpSandboxStatus;
      /** Phase 10.7 — whose own connection probes a delegated server; null when nobody usable. */
      delegatedProbeUser?: (server: McpServerRecord, requestedBy?: string | null) => Promise<string | null>;
    },
    private readonly options: {
      /** Default interval for servers without an override; 0 disables the background loop. */
      defaultIntervalMs: number;
      /** How often the loop looks for due servers. */
      tickMs?: number;
      probeTimeoutMs?: number;
      keepProbes?: number;
      /** Phase 10.5 — debounce for re-probes after `list_changed` notifications. */
      listChangedDelayMs?: number;
    }
  ) {}

  /**
   * Phase 10.5 — a session saw `notifications/{tools,resources,prompts}/list_changed`
   * for a registry server. The next probe refreshes the tool snapshot and the
   * catalog; notifications that arrive within the debounce window share it.
   */
  onListChanged(event: McpListChangedEvent): void {
    const serverId = event.registryServerId;
    if (!serverId) return;
    if (this.reprobeTimers.has(serverId)) return;
    const reprobe = async () => {
      if (!(await this.store.getMcpServer(serverId))) return;
      await this.probe(serverId);
    };
    const timer = setTimeout(() => {
      this.reprobeTimers.delete(serverId);
      reprobe().catch((err) => {
        this.logger?.warn("MCP re-probe after list_changed failed", {
          serverId,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }, this.options.listChangedDelayMs ?? LIST_CHANGED_REPROBE_DELAY_MS);
    timer.unref?.();
    this.reprobeTimers.set(serverId, timer);
    this.logger?.info("MCP server list changed; re-probe scheduled", { serverId, kind: event.kind });
  }

  /** Servers with a re-probe waiting (tests and shutdown). */
  pendingReprobes(): string[] {
    return [...this.reprobeTimers.keys()];
  }

  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  get defaultIntervalMs(): number {
    return this.options.defaultIntervalMs;
  }

  start(): void {
    if (this.timer || this.options.defaultIntervalMs <= 0) return;
    const tickMs = this.options.tickMs ?? Math.min(30_000, this.options.defaultIntervalMs);
    this.timer = setInterval(() => {
      void this.tick();
    }, tickMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    for (const timer of this.reprobeTimers.values()) clearTimeout(timer);
    this.reprobeTimers.clear();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Probe every enabled server whose interval has elapsed. Leader only. */
  async tick(now = Date.now()): Promise<void> {
    if (!this.deps.isLeader()) return;
    for (const server of await this.store.listMcpServers()) {
      if (!server.probeEnabled || this.inFlight.has(server.id)) continue;
      if (server.credentialMode === "delegated" && !(await this.deps.delegatedProbeUser?.(server))) continue;
      const intervalMs = server.probeIntervalMs ?? this.options.defaultIntervalMs;
      if (intervalMs <= 0) continue;
      const lastMs = server.lastProbeAt ? Date.parse(server.lastProbeAt) : 0;
      if (now - lastMs < intervalMs) continue;
      try {
        await this.probe(server.id);
      } catch (err) {
        this.logger?.warn("MCP probe tick failed", {
          serverId: server.id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  /**
   * Probe one server now. Concurrent calls for the same server share one probe.
   * `requestedBy` (a user id) probes a delegated server with that user's own connection.
   */
  probe(serverId: string, requestedBy?: string | null): Promise<McpProbeOutcome> {
    const running = this.inFlight.get(serverId);
    if (running) return running;
    const pending = this.runProbe(serverId, requestedBy ?? null).finally(() => {
      this.inFlight.delete(serverId);
    });
    this.inFlight.set(serverId, pending);
    return pending;
  }

  async latency(serverId: string, samples = 100): Promise<McpLatencyStats> {
    return latencyStats(await this.store.listMcpServerProbes(serverId, samples));
  }

  private async runProbe(serverId: string, requestedBy: string | null): Promise<McpProbeOutcome> {
    const server = await this.store.getMcpServer(serverId);
    if (!server) {
      throw new Error(`MCP server not found: ${serverId}`);
    }
    let serverConfig: MCPServerConfig = serverConfigFromRecord(server);
    if (server.credentialMode === "delegated") {
      const userId = (await this.deps.delegatedProbeUser?.(server, requestedBy)) ?? null;
      if (!userId) {
        throw new McpProbeSkippedError(
          `MCP server '${server.name}' uses each user's own account. Connect yours under My connections, then probe again.`
        );
      }
      serverConfig = { ...serverConfig, delegatedUser: { userId, source: "user" } };
    }
    if (server.adapterId === "stdio_mcp" && this.deps.checkSandbox) {
      try {
        await this.store.setMcpServerSandboxStatus(server.id, this.deps.checkSandbox(serverConfig));
      } catch (err) {
        this.logger?.warn("MCP sandbox check failed", { serverId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const startedAt = new Date();
    const started = performance.now();
    const context: MCPExecutionContext = {
      resolveSecret: this.deps.resolveSecret,
      runtimeState: new Map<string, unknown>(),
      bypassRuntimeLimits: true
    };
    const adapter = this.mcpRegistry.tryGet(server.adapterId);
    let tools: Array<{ name: string; description?: string; inputSchema?: unknown }> | null = null;
    let error: string | null = null;
    let catalog: McpServerCatalog | undefined;

    if (!adapter) {
      error = `Unknown MCP adapter: ${server.adapterId}`;
    } else {
      const closeSessions = async () => {
        try {
          await adapter.closeSessions?.(context);
        } catch (closeErr) {
          this.logger?.warn("Failed to close MCP probe session", {
            serverId,
            error: closeErr instanceof Error ? closeErr.message : String(closeErr)
          });
        }
      };
      const timeoutMs = this.options.probeTimeoutMs ?? 30_000;
      const discovery = adapter.discoverTools(serverConfig, context);
      try {
        tools = await withTimeout(discovery, timeoutMs);
        catalog = await withTimeout(captureCatalog(adapter, serverConfig, context), timeoutMs);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        // A timed-out discovery can still finish opening a session; close that too.
        void discovery.then(closeSessions, closeSessions);
      } finally {
        await closeSessions();
      }
    }

    const latencyMs = Math.round(performance.now() - started);
    let snapshot: McpToolSnapshotRecord | undefined;
    let snapshotId = server.currentSnapshotId;

    if (tools) {
      const entries = normalizeToolSnapshot(tools);
      const hash = hashToolSnapshot(entries);
      const previous = server.currentSnapshotId ? await this.store.getMcpToolSnapshot(server.currentSnapshotId) : null;
      if (!previous || previous.hash !== hash) {
        // The first snapshot is the baseline, so it is never breaking.
        const diff = previous ? diffToolSnapshots(previous.tools, entries) : { changes: [], breaking: false };
        snapshot = {
          id: `mcpsnap_${randomUUID()}`,
          serverId,
          hash,
          tools: entries,
          toolCount: entries.length,
          previousSnapshotId: previous?.id ?? null,
          changes: diff.changes,
          breaking: diff.breaking,
          acknowledgedAt: null,
          acknowledgedBy: null,
          createdAt: startedAt.toISOString()
        };
        snapshotId = snapshot.id;
      }
    }

    const probe: McpServerProbeRecord = {
      id: `mcpprobe_${randomUUID()}`,
      serverId,
      startedAt: startedAt.toISOString(),
      ok: tools !== null,
      latencyMs,
      toolCount: tools?.length ?? 0,
      error,
      snapshotId: tools ? snapshotId : null
    };
    const status = deriveStatus([probe, ...await this.store.listMcpServerProbes(serverId, STATUS_WINDOW - 1)]);

    await this.store.recordMcpServerProbe({
      probe,
      status,
      snapshot,
      keepProbes: this.options.keepProbes ?? 500
    });
    if (catalog) {
      await this.store.upsertMcpServerCatalog(serverId, catalog);
    }

    if (snapshot?.breaking) {
      this.logger?.warn("MCP server tool schema changed in a breaking way", {
        serverId,
        changes: snapshot.changes.filter((change) => change.breaking).length
      });
    }

    const updated = await this.store.getMcpServer(serverId);
    if (!updated) {
      throw new Error(`MCP server disappeared during probe: ${serverId}`);
    }
    return { server: updated, probe, snapshot, ...(catalog ? { catalog } : {}) };
  }
}

/**
 * Phase 10.5 — list what the server advertises beyond tools. Only the lists
 * the server's capabilities announce are requested; a failing list leaves
 * that part empty rather than failing the probe, since the tool snapshot is
 * what health is judged on.
 */
export async function captureCatalog(
  adapter: ReturnType<MCPRegistry["get"]>,
  serverConfig: MCPServerConfig,
  context: MCPExecutionContext
): Promise<McpServerCatalog> {
  const capabilities = (await adapter.describeServer?.(serverConfig, context)) ?? {};
  const quiet = async <T>(run: (() => Promise<T>) | undefined, fallback: T): Promise<T> => {
    if (!run) return fallback;
    try {
      return await run();
    } catch {
      return fallback;
    }
  };
  const wantsResources = Boolean(capabilities.resources) && typeof adapter.listResources === "function";
  const wantsPrompts = Boolean(capabilities.prompts) && typeof adapter.listPrompts === "function";
  return {
    capabilities,
    resources: wantsResources ? await quiet(() => adapter.listResources!(serverConfig, context), []) : [],
    resourceTemplates:
      wantsResources && typeof adapter.listResourceTemplates === "function"
        ? await quiet(() => adapter.listResourceTemplates!(serverConfig, context), [])
        : [],
    prompts: wantsPrompts ? await quiet(() => adapter.listPrompts!(serverConfig, context), []) : [],
    updatedAt: new Date().toISOString()
  };
}
