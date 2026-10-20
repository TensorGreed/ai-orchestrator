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
}

export type GatewaySessionEndReason = "deleted" | "idle" | "revoked" | "toolset_removed" | "evicted" | "shutdown";

export interface GatewaySessionManagerOptions {
  idleMs: number;
  maxSessions: number;
  createContext: () => MCPExecutionContext;
  /** Release adapter sessions (stdio children) held by a session's context. */
  closeContext: (context: MCPExecutionContext) => Promise<void>;
  onEnded?: (session: GatewaySession, reason: GatewaySessionEndReason) => void;
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
      auditedReadOnlyTools: new Set()
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
    this.options.onEnded?.(session, reason);
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
