/**
 * MCP 2026-07-28 (G3b) — `notifications/tools/list_changed` on the gateway's `subscriptions/listen` streams.
 *
 * A stream that asked for `toolsListChanged` is watched: when the tool list its caller would get from `tools/list`
 * changes (a toolset edit, a new tool snapshot of a member server, a tool rule or classification that hides or shows a
 * tool, a workflow tool saved or published, the client's role), the stream gets the notification. What decides is a
 * fingerprint of that list, taken when the stream opens and compared again on each check, so a stream is told only
 * about real changes to its own list, and nothing a message says is trusted.
 *
 * When a check runs:
 *   - after a hint: an admin change through this instance's API (onResponse), a tool snapshot or workflow change
 *     announced on the cluster bus as GATEWAY_TOOLS_CHANGED_MESSAGE (every instance gets it, this one included), and
 *     after the bus reconnects (messages may have been lost). Hints within GATEWAY_LIST_CHANGED_DEBOUNCE_MS share one
 *     check.
 *   - every MCP_GATEWAY_LISTEN_CHECK_MS while a stream is watched, as the fallback for lost messages and changes
 *     nothing announces, such as rules written by background jobs or rules whose conditions depend on time (0 turns
 *     it off).
 *
 * Cost: the hub does nothing while no stream is watched (no timer, a hint is dropped); the hints themselves are still
 * published while modern mode is on (one small bus message per change, see app.ts). A check builds one catalog per
 * (toolset, client) pair with watched streams on this instance, from the database, as `tools/list` does; no upstream
 * server is contacted.
 *
 * A stream whose toolset was deleted or disabled, or whose client was revoked, expired or unscoped from the toolset,
 * is ended gracefully (a `complete` result): reconnecting gets the refusal `tools/list` would get.
 */
import crypto from "node:crypto";
import type { ClusterBus, ClusterMessage } from "./cluster-bus.js";

/** The cluster bus `ctl` message that hints at a tool list change: `{ t }`, no payload (receivers re-read). */
export const GATEWAY_TOOLS_CHANGED_MESSAGE = "mcp_tools_changed";
/** `MCP_GATEWAY_LISTEN_CHECK_MS` default: the fallback check of watched streams' tool lists. */
export const DEFAULT_MCP_GATEWAY_LISTEN_CHECK_MS = 30_000;
/** Hints within this window share one check. */
export const GATEWAY_LIST_CHANGED_DEBOUNCE_MS = 250;

/**
 * True for a bus message that hints at a tool list change. Its version and every other field are ignored: it carries
 * nothing and decides nothing (receivers re-read), so a hint from a newer instance during a rolling upgrade still counts.
 */
export function isGatewayToolsChangedMessage(message: ClusterMessage): boolean {
  return message.t === GATEWAY_TOOLS_CHANGED_MESSAGE;
}

/** A fingerprint of a tool list as a caller receives it (descriptors in their served order). */
export function toolListFingerprint(descriptors: readonly unknown[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(descriptors)).digest("base64url");
}

/**
 * Admin API routes whose successful non-GET requests may change a toolset's tool list: toolsets, MCP clients (role,
 * toolsets, revoke), MCP servers (edits, probes, tool classifications and open-world overrides), tool rules, data
 * destinations (read by open-world rules), and users and custom roles (a client's role is capped by its creator's).
 * A match only schedules a check, so a route here that changed nothing costs one check while streams are watched.
 */
const TOOL_LIST_ROUTE_PREFIXES = [
  "/api/mcp/toolsets",
  "/api/mcp/clients",
  "/api/mcp/servers",
  "/api/mcp/policies",
  "/api/data-destinations",
  "/api/users",
  "/api/custom-roles"
] as const;
/** Routes under those prefixes that only read, simulate, call a tool or touch credentials: no tool list changes. */
const TOOL_LIST_READ_ONLY_ROUTES: ReadonlySet<string> = new Set([
  "/api/mcp/policies/simulate",
  "/api/mcp/policies/evaluate",
  "/api/mcp/policies/suggestions/generate",
  "/api/mcp/policies/suggestions/:id/dismiss",
  "/api/data-destinations/preview",
  "/api/mcp/servers/:id/playground/call",
  "/api/mcp/servers/:id/prompts/get",
  "/api/mcp/servers/:id/resources/read",
  "/api/mcp/servers/:id/oauth/connect",
  "/api/mcp/servers/:id/oauth/refresh",
  "/api/mcp/servers/:id/breaker/reset",
  "/api/mcp/clients/:id/rotate",
  "/api/mcp/clients/:id/network",
  "/api/users/invite",
  "/api/users/:id/mfa/reset",
  "/api/users/:id/sessions/revoke"
]);

/** Whether a finished request (method, route template, status) may have changed a toolset's tool list. */
export function isToolListMutation(method: string, routeUrl: string | undefined, statusCode: number): boolean {
  if (!routeUrl || statusCode < 200 || statusCode >= 300) return false;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  if (TOOL_LIST_READ_ONLY_ROUTES.has(routeUrl)) return false;
  return TOOL_LIST_ROUTE_PREFIXES.some((prefix) => routeUrl === prefix || routeUrl.startsWith(`${prefix}/`));
}

/** What a scope's tool list is now: its fingerprint, or `gone` when the caller may no longer list it. */
export type ToolListScopeState = { kind: "list"; fingerprint: string } | { kind: "gone" };

/** The (toolset, client) pair a stream lists tools as; streams of one scope see one list. */
export interface ToolListScope {
  toolsetId: string;
  clientId: string;
}

/** One watched listen stream. */
export interface ToolListWatcher {
  scope: ToolListScope;
  /** The fingerprint of the list the stream was last told about (or opened with). */
  fingerprint: string;
  /** Sends `notifications/tools/list_changed` on the stream. */
  onChanged(): void;
  /** Ends the stream gracefully. */
  onGone(): void;
}

export interface GatewayListChangedHubOptions {
  /** Reads a scope's current tool list (from the database, as `tools/list` would). */
  state(scope: ToolListScope): Promise<ToolListScopeState>;
  /** The fallback check's period while streams are watched; 0 = none. */
  checkMs: number;
  debounceMs?: number;
  /** Hints from other instances (and this one) arrive on its `ctl` topic; a reconnect also hints. Absent: local only. */
  bus?: Pick<ClusterBus, "subscribe" | "onResync">;
  logger: { warn: (fields: Record<string, unknown>, message: string) => void };
}

/** The watched listen streams of one instance, and the checks that tell them about tool list changes. */
export class GatewayListChangedHub {
  private readonly watchers = new Set<ToolListWatcher>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private periodicTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private stopped = false;
  private hints = 0;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(private readonly options: GatewayListChangedHubOptions) {
    if (options.bus) {
      this.unsubscribe.push(
        options.bus.subscribe("ctl", (message) => {
          if (isGatewayToolsChangedMessage(message)) this.hint();
        }),
        options.bus.onResync(() => this.hint())
      );
    }
  }

  /** Streams watched on this instance. */
  get size(): number {
    return this.watchers.size;
  }

  /**
   * Counts hints, including those dropped while nothing is watched. A stream reads it before it takes its first
   * fingerprint and again once watched: a different value means a hint arrived in between, and it asks for a check.
   */
  get generation(): number {
    return this.hints;
  }

  /** Watches a stream until the returned function is called. */
  watch(watcher: ToolListWatcher): () => void {
    if (this.stopped) return () => undefined;
    this.watchers.add(watcher);
    if (!this.periodicTimer && this.options.checkMs > 0) {
      this.periodicTimer = setInterval(() => this.hint(), this.options.checkMs);
      this.periodicTimer.unref?.();
    }
    return () => {
      this.watchers.delete(watcher);
      if (this.watchers.size === 0) this.idle();
    };
  }

  /** Something may have changed: check watched streams soon (hints close together share one check). */
  hint(): void {
    if (this.stopped) return;
    this.hints += 1;
    if (this.watchers.size === 0 || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.check();
    }, this.options.debounceMs ?? GATEWAY_LIST_CHANGED_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  /** Checks every watched stream now; a check asked for while one runs runs once more after it. */
  async check(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return await this.running;
    }
    // promise-ok: kept so a hint during a check runs it again instead of overlapping; cleared when it settles
    this.running = (async () => {
      do {
        this.rerun = false;
        await this.checkOnce();
      } while (this.rerun && !this.stopped);
    })().finally(() => {
      this.running = null;
    });
    return await this.running;
  }

  stop(): void {
    this.stopped = true;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.watchers.clear();
    this.idle();
  }

  private idle(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.debounceTimer = null;
    this.periodicTimer = null;
  }

  private async checkOnce(): Promise<void> {
    const scopes = new Map<string, { scope: ToolListScope; watchers: ToolListWatcher[] }>();
    for (const watcher of this.watchers) {
      const key = `${watcher.scope.toolsetId}\u0000${watcher.scope.clientId}`;
      const entry = scopes.get(key);
      if (entry) entry.watchers.push(watcher);
      else scopes.set(key, { scope: watcher.scope, watchers: [watcher] });
    }
    // One scope at a time: a check is a background job, and this keeps its database load to one catalog build.
    for (const { scope, watchers } of scopes.values()) {
      if (this.stopped) return;
      let state: ToolListScopeState;
      try {
        state = await this.options.state(scope);
      } catch (error) {
        // Nothing is sent on a failed read; the next hint or periodic check tries again.
        this.options.logger.warn({ toolsetId: scope.toolsetId, err: error instanceof Error ? error.message : String(error) }, "Could not check an MCP gateway tool list for changes");
        continue;
      }
      for (const watcher of watchers) {
        if (!this.watchers.has(watcher)) continue;
        if (state.kind === "gone") {
          watcher.onGone();
        } else if (state.fingerprint !== watcher.fingerprint) {
          watcher.fingerprint = state.fingerprint;
          watcher.onChanged();
        }
      }
    }
  }
}
