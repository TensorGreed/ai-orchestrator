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
 *
 * MCP 2026-07-28 has no sessions: a modern request carries everything it
 * needs. The gateway still keeps per-caller state for modern calls (upstream
 * stdio servers, the read-only audit sampling, content-rule block counts and
 * the 12.2 label mark), in a principal state keyed by the caller's client
 * credential and toolset (and the user its token acts for). Nothing in a
 * request names or replaces it: it lives as long as a session
 * would (idle expiry, revoke, toolset removal, the cap, shutdown) and it
 * counts against the same cap as sessions, which evicts idle legacy sessions
 * first and an idle principal state that holds outside content last.
 *
 * The principal state's label mark is a local view only: on a toolset that
 * tracks outside content, the mark that decides is stored in the database
 * (v71, `mcp_gateway_label_marks`), keyed the same way and shared by every
 * instance, so it survives eviction, the idle sweep of this instance and a
 * call answered by another instance (mcp-gateway-routes.ts). A caller's legacy
 * sessions keep their own marks; on a tracking toolset a new one starts from the
 * stored mark, so opening a session never clears it.
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

/** A modern protocol version (2026-07-28 and later); modern callers have principal states, not sessions. */
export type McpModernGatewayVersion = string;

export interface GatewayInFlight {
  controller: AbortController;
  /** Workflow execution the request started, when it runs a workflow tool. */
  executionId?: string;
  /** Called on cancellation, after the controller aborts. */
  onCancel?: (reason: string) => void | Promise<void>;
  /**
   * MCP 2026-07-28 — a modern request holds its principal state from lookup to response: the entry only keeps the
   * state from being evicted or swept while the request runs; there is no call to cancel.
   */
  holdOnly?: true;
}

export interface GatewaySession {
  id: string;
  /**
   * `legacy`: opened by `initialize`, named by `Mcp-Session-Id`. `modern`: the principal state of 2026-07-28 callers,
   * found by `principalScope` only and never by id (a client can never name it in a request).
   */
  era: "legacy" | "modern";
  /** Modern only: the caller the state belongs to (client credential, toolset and the user its token acts for). */
  principalScope?: string;
  /** Modern only: the user its token acts for, or '' (the third part of its stored label mark's key). */
  markScopeKey?: string;
  /**
   * Modern only: when this instance last noted in the stored mark that a result went back while the toolset did not
   * track (at most once per half idle window).
   */
  unobservedNotedAt?: number;
  clientId: string;
  toolsetId: string;
  /** A legacy session's negotiated version; a principal state's version of its latest request. */
  protocolVersion: McpProtocolVersion | McpModernGatewayVersion;
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
  /**
   * MCP 2026-07-28 — a principal's upstream servers must be stopped (a cancelled call may still run there), but other
   * calls of the same principal are using them: they are stopped once no call is in flight.
   */
  closeWhenDrained?: boolean;
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

/** The principal scope of a modern caller: who it is, never anything from its request beyond the credential. */
export function gatewayPrincipalScope(input: { clientId: string; toolsetId: string; userId?: string | null }): string {
  return `client:${input.clientId}/toolset:${input.toolsetId}${input.userId ? `/user:${input.userId}` : ""}`;
}

export class GatewaySessionManager {
  private readonly sessions = new Map<string, GatewaySession>();
  /** Principal scope → id of its state in `sessions`. */
  private readonly principals = new Map<string, string>();
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

  /** Room for one more session or principal state: the least recently used idle one is closed past the cap. */
  /**
   * Room for one more session or principal state. Past the cap the least recently used idle entry is closed, in this
   * order: legacy sessions, then principal states without outside content, then the others. A caller cannot shed its
   * principal mark by opening sessions.
   */
  private async makeRoom(): Promise<void> {
    if (this.sessions.size < this.options.maxSessions) return;
    const rank = (session: GatewaySession) => (session.era === "legacy" ? 0 : markRaised(session.labels) || session.labels.unobserved ? 2 : 1);
    const idle = [...this.sessions.values()]
      .filter((session) => session.inFlight.size === 0)
      .sort((a, b) => rank(a) - rank(b) || a.lastSeenAt - b.lastSeenAt)[0];
    if (!idle) throw new GatewaySessionLimitError(this.options.maxSessions);
    await this.end(idle.id, "evicted");
  }

  private newState(input: {
    era: GatewaySession["era"];
    principalScope?: string;
    markScopeKey?: string;
    clientId: string;
    toolsetId: string;
    protocolVersion: GatewaySession["protocolVersion"];
    clientInfo: { name?: string; version?: string };
  }): GatewaySession {
    const now = this.now();
    return {
      id: crypto.randomUUID(),
      era: input.era,
      ...(input.principalScope !== undefined ? { principalScope: input.principalScope } : {}),
      ...(input.markScopeKey !== undefined ? { markScopeKey: input.markScopeKey } : {}),
      clientId: input.clientId,
      toolsetId: input.toolsetId,
      protocolVersion: input.protocolVersion,
      clientInfo: input.clientInfo,
      createdAt: now,
      lastSeenAt: now,
      initialized: input.era === "modern",
      mcpContext: this.options.createContext(),
      inFlight: new Map(),
      auditedReadOnlyTools: new Set(),
      labels: emptySessionLabelMark(),
      guard: { blocks: 0, lastBlock: null }
    };
  }

  async create(input: {
    clientId: string;
    toolsetId: string;
    protocolVersion: McpProtocolVersion;
    clientInfo: { name?: string; version?: string };
  }): Promise<GatewaySession> {
    await this.makeRoom();
    const session = this.newState({ era: "legacy", ...input });
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * The principal state of a modern caller, created on its first request (`created: true`) and touched on every
   * later one, which also records the version and client info of the latest request (display only). Counts against
   * the same cap as sessions; throws `GatewaySessionLimitError` when it is reached and nothing is idle.
   */
  async principal(input: {
    principalScope: string;
    /** The user the caller's token acts for, or ''. */
    markScopeKey?: string;
    clientId: string;
    toolsetId: string;
    protocolVersion: McpModernGatewayVersion;
    clientInfo: { name?: string; version?: string };
  }): Promise<{ state: GatewaySession; created: boolean }> {
    const existing = this.principalState(input.principalScope);
    if (existing) {
      existing.protocolVersion = input.protocolVersion;
      if (input.clientInfo.name !== undefined || input.clientInfo.version !== undefined) existing.clientInfo = input.clientInfo;
      this.touch(existing);
      return { state: existing, created: false };
    }
    await this.makeRoom();
    // Another request of the same caller may have created it while the cap made room.
    const raced = this.principalState(input.principalScope);
    if (raced) {
      raced.protocolVersion = input.protocolVersion;
      if (input.clientInfo.name !== undefined || input.clientInfo.version !== undefined) raced.clientInfo = input.clientInfo;
      this.touch(raced);
      return { state: raced, created: false };
    }
    const state = this.newState({ era: "modern", ...input });
    this.sessions.set(state.id, state);
    this.principals.set(input.principalScope, state.id);
    return { state, created: true };
  }

  /** The principal state of a modern caller, when it has one. */
  principalState(principalScope: string): GatewaySession | undefined {
    const id = this.principals.get(principalScope);
    return id === undefined ? undefined : this.sessions.get(id);
  }

  count(predicate: (session: GatewaySession) => boolean): number {
    let total = 0;
    for (const session of this.sessions.values()) {
      if (predicate(session)) total += 1;
    }
    return total;
  }

  /** A legacy session by its `Mcp-Session-Id`. Principal states are never returned: no request can name one. */
  get(id: string): GatewaySession | undefined {
    const session = this.sessions.get(id);
    return session?.era === "legacy" ? session : undefined;
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
    if (session.principalScope !== undefined && this.principals.get(session.principalScope) === id) this.principals.delete(session.principalScope);
    const entries = [...session.inFlight.values()];
    session.inFlight.clear();
    for (const entry of entries) {
      if (entry.controller.signal.aborted) continue;
      entry.controller.abort(`MCP session ended (${reason})`);
      // A principal state's calls are cancelled for real (a workflow run stops), since its caller cannot cancel them
      // any more. Legacy sessions keep their behaviour: the controller only.
      if (session.era === "modern" && entry.onCancel) {
        try {
          await entry.onCancel(`MCP caller state ended (${reason})`);
        } catch {
          // Best effort: the context is closed next anyway.
        }
      }
    }
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
