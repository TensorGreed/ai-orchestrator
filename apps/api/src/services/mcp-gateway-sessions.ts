/**
 * Phase 10.4 — MCP gateway sessions.
 *
 * `initialize` opens a session bound to one client credential and one
 * toolset; its id travels in the `Mcp-Session-Id` header. Each session owns
 * an MCP execution context, so stdio servers the gateway starts for it are
 * scoped to that client session and stopped when the session ends: on
 * DELETE, after `idleMs` without a request, when its client is revoked or
 * its toolset removed, when the session cap evicts it, or at shutdown.
 *
 * In-flight requests are tracked per session so `notifications/cancelled`
 * can abort them.
 */

import crypto from "node:crypto";
import type { MCPExecutionContext } from "@ai-orchestrator/mcp-sdk";
import {
  MCP_TOOL_CALL_LABELS_MAX_CLASSES,
  PROVENANCE_LABELS,
  dataClassNameSchema,
  type DataLabels,
  type McpGatewaySessionLabels,
  type ProvenanceLabel
} from "@ai-orchestrator/shared";
import type { McpProtocolVersion } from "./mcp-gateway-protocol.js";

export interface GatewayInFlight {
  controller: AbortController;
  /** Workflow execution the request started, when it runs a workflow tool. */
  executionId?: string;
  /** Called on cancellation, after the controller aborts. */
  onCancel?: (reason: string) => void | Promise<void>;
}

export interface GatewaySession {
  id: string;
  clientId: string;
  toolsetId: string;
  protocolVersion: McpProtocolVersion;
  clientInfo: { name?: string; version?: string };
  createdAt: number;
  lastSeenAt: number;
  initialized: boolean;
  mcpContext: MCPExecutionContext;
  inFlight: Map<string, GatewayInFlight>;
  /** Read-only tools already audited in this session (first-per-session sampling). */
  auditedReadOnlyTools: Set<string>;
  /**
   * 12.2 — what the session's calls returned, on a toolset that tracks outside content: a high-water mark that only
   * grows, and ends with the session. Never read from the client's request.
   */
  labels: SessionLabelMark;
  /** 12.6 — calls Guard blocked in this session (on this instance), and the latest one (short redacted reason only). */
  guard: SessionGuardBlocks;
}

/** 12.6 — a session's Guard blocks. */
export interface SessionGuardBlocks {
  blocks: number;
  lastBlock: { tool: string; channel: "tool_arguments" | "tool_result"; reason: string; at: number } | null;
}

/** 12.6 — count a Guard block on the session. */
export function noteSessionGuardBlock(session: Pick<GatewaySession, "guard">, block: { tool: string; channel: "tool_arguments" | "tool_result"; reason: string }, now: number = Date.now()): void {
  session.guard.blocks += 1;
  session.guard.lastBlock = { ...block, at: now };
}

/** 12.2 — a session's label high-water mark. */
export interface SessionLabelMark {
  provenance: Set<ProvenanceLabel>;
  dataClasses: Set<string>;
  /** A call returned a result while the toolset did not track: what it carried is unknown. */
  unobserved: boolean;
  /** When the mark first held outside content or sensitive data. */
  raisedAt: number | null;
  /** The first raise has been audited (once per session). */
  raiseAudited: boolean;
}

/** Labels a session never collects: only the server's own scheduler is ever `trusted`. */
const UNCOLLECTED: ReadonlySet<ProvenanceLabel> = new Set<ProvenanceLabel>(["trusted"]);

export function emptySessionLabelMark(): SessionLabelMark {
  return { provenance: new Set(), dataClasses: new Set(), unobserved: false, raisedAt: null, raiseAudited: false };
}

/** The mark counts as raised once it holds outside content or sensitive data (or classes). */
function markRaised(mark: SessionLabelMark): boolean {
  return mark.provenance.has("untrusted_external") || mark.provenance.has("sensitive") || mark.dataClasses.size > 0;
}

/**
 * 12.2 — add a call result's labels to the session's mark (it never goes down). `tracked`: the toolset tracks now;
 * when it does not, the result is only noted as unobserved, so turning tracking on later counts it as outside
 * content. Returns true when this call raised the mark for the first time in the session.
 */
export function raiseSessionLabels(
  mark: SessionLabelMark,
  labels: Pick<DataLabels, "provenance" | "dataClasses">,
  tracked: boolean,
  now: number = Date.now()
): boolean {
  if (!tracked) {
    mark.unobserved = true;
    return false;
  }
  const before = markRaised(mark);
  for (const label of labels.provenance) {
    if (PROVENANCE_LABELS.includes(label) && !UNCOLLECTED.has(label)) mark.provenance.add(label);
  }
  for (const name of labels.dataClasses) {
    if (mark.dataClasses.size >= MCP_TOOL_CALL_LABELS_MAX_CLASSES) break;
    if (dataClassNameSchema.safeParse(name).success) mark.dataClasses.add(name);
  }
  if (!before && markRaised(mark)) {
    mark.raisedAt = now;
    return true;
  }
  return false;
}

/**
 * 12.2 — the labels a call in a tracking session is checked with: the client's own request (`user`) plus the mark.
 * Results that came back while the toolset did not track count as outside content now (fail closed); the second
 * value is true when that just raised the mark.
 */
export function sessionCallLabels(mark: SessionLabelMark, now: number = Date.now()): { labels: DataLabels; raised: boolean } {
  let raised = false;
  if (mark.unobserved) {
    mark.unobserved = false;
    raised = raiseSessionLabels(mark, { provenance: ["untrusted_external"], dataClasses: [] }, true, now);
  }
  const provenance = PROVENANCE_LABELS.filter((label) => label === "user" || mark.provenance.has(label));
  return { labels: { provenance, dataClasses: [...mark.dataClasses].sort(), source: "propagated" }, raised };
}

/** 12.2 — the mark as the admin API shows it. */
export function sessionLabelsView(mark: SessionLabelMark): McpGatewaySessionLabels {
  return {
    provenance: PROVENANCE_LABELS.filter((label) => mark.provenance.has(label)),
    dataClasses: [...mark.dataClasses].sort()
  };
}

export type GatewaySessionEndReason = "deleted" | "idle" | "revoked" | "toolset_removed" | "evicted" | "shutdown";

export interface GatewaySessionManagerOptions {
  idleMs: number;
  maxSessions: number;
  createContext: () => MCPExecutionContext;
  /** Release adapter sessions (stdio children) held by a session's context. */
  closeContext: (context: MCPExecutionContext) => Promise<void>;
  onEnded?: (session: GatewaySession, reason: GatewaySessionEndReason) => void | Promise<void>;
  now?: () => number;
}

export class GatewaySessionLimitError extends Error {
  constructor(max: number) {
    super(`The MCP gateway has ${max} open sessions and none is idle; try again later.`);
    this.name = "GatewaySessionLimitError";
  }
}

export class GatewaySessionManager {
  private readonly sessions = new Map<string, GatewaySession>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly options: GatewaySessionManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Periodic idle sweep; the timer does not keep the process alive. */
  start(): void {
    if (this.sweepTimer) return;
    const interval = Math.max(1_000, Math.min(60_000, Math.floor(this.options.idleMs / 2)));
    this.sweepTimer = setInterval(() => {
      void this.sweepIdle();
    }, interval);
    this.sweepTimer.unref?.();
  }

  get size(): number {
    return this.sessions.size;
  }

  async create(input: {
    clientId: string;
    toolsetId: string;
    protocolVersion: McpProtocolVersion;
    clientInfo: { name?: string; version?: string };
  }): Promise<GatewaySession> {
    if (this.sessions.size >= this.options.maxSessions) {
      const idle = [...this.sessions.values()]
        .filter((session) => session.inFlight.size === 0)
        .sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
      if (!idle) throw new GatewaySessionLimitError(this.options.maxSessions);
      await this.end(idle.id, "evicted");
    }
    const now = this.now();
    const session: GatewaySession = {
      id: crypto.randomUUID(),
      clientId: input.clientId,
      toolsetId: input.toolsetId,
      protocolVersion: input.protocolVersion,
      clientInfo: input.clientInfo,
      createdAt: now,
      lastSeenAt: now,
      initialized: false,
      mcpContext: this.options.createContext(),
      inFlight: new Map(),
      auditedReadOnlyTools: new Set(),
      labels: emptySessionLabelMark(),
      guard: { blocks: 0, lastBlock: null }
    };
    this.sessions.set(session.id, session);
    return session;
  }

  count(predicate: (session: GatewaySession) => boolean): number {
    let total = 0;
    for (const session of this.sessions.values()) {
      if (predicate(session)) total += 1;
    }
    return total;
  }

  get(id: string): GatewaySession | undefined {
    return this.sessions.get(id);
  }

  /** The open sessions a predicate selects, oldest first. */
  list(predicate: (session: GatewaySession) => boolean): GatewaySession[] {
    return [...this.sessions.values()].filter(predicate).sort((a, b) => a.createdAt - b.createdAt);
  }

  touch(session: GatewaySession): void {
    session.lastSeenAt = this.now();
  }

  /** Abort every in-flight request, stop the session's stdio servers and forget it. */
  async end(id: string, reason: GatewaySessionEndReason): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    for (const entry of session.inFlight.values()) {
      entry.controller.abort(`MCP session ended (${reason})`);
    }
    session.inFlight.clear();
    await this.options.closeContext(session.mcpContext);
    await this.options.onEnded?.(session, reason);
    return true;
  }

  async endWhere(predicate: (session: GatewaySession) => boolean, reason: GatewaySessionEndReason): Promise<number> {
    const ids = [...this.sessions.values()].filter(predicate).map((session) => session.id);
    for (const id of ids) {
      await this.end(id, reason);
    }
    return ids.length;
  }

  /** Close sessions idle for longer than `idleMs`; sessions with a request in flight are kept. */
  async sweepIdle(): Promise<number> {
    const cutoff = this.now() - this.options.idleMs;
    return this.endWhere((session) => session.inFlight.size === 0 && session.lastSeenAt < cutoff, "idle");
  }

  async closeAll(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    await this.endWhere(() => true, "shutdown");
  }
}
