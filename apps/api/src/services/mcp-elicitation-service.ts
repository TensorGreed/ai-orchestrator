/**
 * Phase 10.5 — MCP elicitation.
 *
 * A tool call on an MCP server can ask the person running the workflow for
 * input (`elicitation/create`). The tool call stays pending inside the run
 * while this service records the request, shows it in Chat and on the Runs
 * page, and resolves the adapter's promise once someone answers (accept with
 * validated content, decline, or cancel), the deadline passes, or the run is
 * canceled.
 *
 * Runs nobody is watching (webhooks, schedules, the queue, gateway calls)
 * decline automatically with a trace entry: a request that waits for a
 * person who is not there would only hold the run until it times out.
 *
 * Requests whose schema asks for anything credential-looking are refused
 * before they reach a person: the protocol says elicitation must never carry
 * secrets.
 *
 * Phase 13.1 — cluster mode (Postgres with HA_ENABLED=true): the instance
 * whose run waits on a request is its holder (`holder_id`). An answer that
 * lands on another instance is checked there (who may answer, what the
 * schema allows) and forwarded to the holder over the cluster bus as an
 * `elicitation_answer` message, sealed with the master key (NOTIFY payloads
 * can appear in Postgres statement logs, and the seal stops a forged one);
 * the holder settles it, so there is still one settle point. A request whose
 * holder stopped (no recent registry heartbeat) is expired, at once when
 * someone answers it and on a periodic sweep; a starting instance expires
 * only requests nobody holds, its own from before a restart and those of
 * stopped instances, never a live replica's.
 */

import { randomUUID } from "node:crypto";
import {
  validateElicitationContent,
  validateElicitationRequest
} from "@ai-orchestrator/mcp-sdk";
import type {
  McpElicitationAction,
  McpElicitationOutcomeSource,
  McpElicitationRequest,
  McpElicitationResult,
  McpElicitationStatus,
  McpElicitationView
} from "@ai-orchestrator/shared";
import type { McpElicitationRecord } from "../db/database.js";
import type { AuditEventInput } from "./audit-service.js";
import type { Store } from "../db/store.js";
import type { ClusterBus, ClusterMessage } from "./cluster-bus.js";
import type { ChallengeSealer } from "./challenge-store.js";

/** Trigger types where a person is in front of the run and can answer. */
export const ATTENDED_TRIGGER_TYPES = new Set(["manual", "manual_stream", "manual_retry", "approval_resume"]);

export function isAttendedTrigger(triggerType: string | undefined): boolean {
  return triggerType !== undefined && ATTENDED_TRIGGER_TYPES.has(triggerType);
}

export interface McpElicitationAsk {
  request: McpElicitationRequest;
  executionId: string;
  workflowId: string;
  workflowName?: string;
  nodeId: string;
  serverId: string;
  registryServerId?: string;
  serverName?: string;
  toolName: string;
  triggerType?: string;
  /** User (id) the run belongs to, when a signed-in person started it. */
  createdBy?: string | null;
  /** How long the request may wait; capped by the service's maximum. */
  timeoutMs?: number;
  /** Aborts the wait when the run is canceled. */
  signal?: AbortSignal;
}

export type McpElicitationAnswer = McpElicitationResult & {
  id: string;
  source: McpElicitationOutcomeSource;
  note?: string;
};

export interface McpElicitationEvent {
  /** `created` when a request starts waiting; `settled` once it has an outcome. */
  phase: "created" | "settled";
  elicitation: McpElicitationView;
}

/** Phase 13.1 — cluster mode: how answers reach the instance holding a request. */
export interface McpElicitationClusterOptions {
  instanceId: string;
  bus: ClusterBus;
  /** Ids of the instances whose registry heartbeat is recent (this one included). */
  liveInstanceIds: () => Promise<ReadonlySet<string>>;
  /** Seals the forwarded answer with the master key. */
  sealer: ChallengeSealer;
  /** How long an answer forwarded to the holder waits for it to settle before the API answers 202. Default 5 s. */
  settleWaitMs?: number;
  settlePollMs?: number;
}

export interface McpElicitationServiceOptions {
  /** Longest a request waits for a person (ms). */
  timeoutMs: number;
  audit: (event: AuditEventInput) => void | Promise<void>;
  logger?: { info: (msg: string, fields?: Record<string, unknown>) => void; warn: (msg: string, fields?: Record<string, unknown>) => void };
  now?: () => number;
  /** Phase 13.1 — set in cluster mode only; without it the service is exactly the single-instance one. */
  cluster?: McpElicitationClusterOptions;
}

/** Phase 13.1 — the bus message that carries an answer to the holder (its body sealed). */
export const ELICITATION_ANSWER_MESSAGE = "elicitation_answer";
const ELICITATION_ID_MAX_LENGTH = 200;
const SEALED_ANSWER_MAX_LENGTH = 6_500;

interface ForwardedAnswer {
  action: McpElicitationAction;
  content?: Record<string, unknown>;
  actor: { userId: string; email: string };
}

/** What a stopped holder leaves behind: the request can no longer be answered. */
export const ELICITATION_HOLDER_GONE_REASON = "The API instance running this request stopped.";

interface PendingEntry {
  record: McpElicitationRecord;
  resolve: (answer: McpElicitationAnswer) => void;
  timer: NodeJS.Timeout;
  listeners: Array<(event: McpElicitationEvent) => void>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export class McpElicitationAnswerError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 404 | 409,
    readonly details?: string[]
  ) {
    super(message);
    this.name = "McpElicitationAnswerError";
  }
}

const SETTLED_STATUS: Record<McpElicitationAction, Exclude<McpElicitationStatus, "pending">> = {
  accept: "accepted",
  decline: "declined",
  cancel: "cancelled"
};

export function toElicitationView(record: McpElicitationRecord): McpElicitationView {
  const { createdBy: _createdBy, triggerType: _triggerType, holderId: _holderId, ...view } = record;
  return view;
}

function sealPurpose(id: string): string {
  return `${ELICITATION_ANSWER_MESSAGE}:${id}`;
}

export class McpElicitationService {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly executionListeners = new Map<string, Set<(event: McpElicitationEvent) => void>>();

  private readonly unsubscribeBus: (() => void) | null = null;

  constructor(
    private readonly store: Store,
    private readonly options: McpElicitationServiceOptions
  ) {
    const cluster = options.cluster;
    if (cluster) {
      this.unsubscribeBus = cluster.bus.subscribe("ctl", (message) => this.onBusMessage(message));
    }
  }

  /**
   * Requests still marked pending from before a restart cannot be answered any more. Phase 13.1 — in cluster mode
   * only the ones nobody holds, this instance's own (from before a restart under the same id) and those of instances
   * that stopped; a live replica's requests are left alone.
   */
  async expireStale(reason = "The API restarted while the request was waiting."): Promise<number> {
    const cluster = this.options.cluster;
    const live = cluster ? await cluster.liveInstanceIds() : null;
    const stale = (await this.store.listMcpElicitations({ status: "pending", limit: 500 })).filter((entry) => {
      if (this.pending.has(entry.id)) return false;
      if (!cluster || !live) return true;
      const holder = entry.holderId ?? null;
      return holder === null || holder === cluster.instanceId || !live.has(holder);
    });
    for (const entry of stale) {
      await this.store.settleMcpElicitation(entry.id, { status: "expired", reason });
    }
    return stale.length;
  }

  /**
   * Phase 13.1 — cluster mode, periodically: expires the requests whose holder stopped (no recent registry heartbeat).
   * Requests nobody holds or held here are left to expireStale at the next start: here they may still be on their way
   * into this instance's map.
   */
  async expireOrphaned(): Promise<number> {
    const cluster = this.options.cluster;
    if (!cluster) return 0;
    const pending = (await this.store.listMcpElicitations({ status: "pending", limit: 500 })).filter(
      (entry) => entry.holderId && entry.holderId !== cluster.instanceId
    );
    if (pending.length === 0) return 0;
    const live = await cluster.liveInstanceIds();
    let expired = 0;
    for (const entry of pending) {
      if (live.has(entry.holderId!)) continue;
      if (await this.expireHeldElsewhere(entry, ELICITATION_HOLDER_GONE_REASON)) expired += 1;
    }
    return expired;
  }

  private async expireHeldElsewhere(record: McpElicitationRecord, reason: string): Promise<boolean> {
    const settled = await this.store.settleMcpElicitation(record.id, { status: "expired", reason });
    if (!settled) return false;
    await this.options.audit({
      category: "system",
      eventType: "mcp_elicitation.expired",
      action: "expire",
      outcome: "failure",
      actor: { type: "system" },
      resourceType: "mcp_elicitation",
      resourceId: record.id,
      metadata: { executionId: record.executionId, reason, holderId: record.holderId ?? null }
    });
    return true;
  }

  /** Listen for requests of one execution (the Chat stream); returns the unsubscribe. */
  subscribe(executionId: string, listener: (event: McpElicitationEvent) => void): () => void {
    const set = this.executionListeners.get(executionId) ?? new Set();
    set.add(listener);
    this.executionListeners.set(executionId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.executionListeners.delete(executionId);
    };
  }

  async get(id: string): Promise<McpElicitationRecord | null> {
    return await this.store.getMcpElicitation(id);
  }

  async listPending(filter: { executionId?: string } = {}): Promise<McpElicitationRecord[]> {
    return await this.store.listMcpElicitations({ status: "pending", ...filter, limit: 200 });
  }

  async list(filter: { status?: McpElicitationStatus; executionId?: string; limit?: number } = {}): Promise<McpElicitationRecord[]> {
    return await this.store.listMcpElicitations(filter);
  }

  /** Whether this instance holds the pending tool call for the request (answers must land here). */
  isPendingHere(id: string): boolean {
    return this.pending.has(id);
  }

  /**
   * Handle one `elicitation/create`. Resolves when a person answers, the
   * deadline passes, the run is canceled, or straight away for unattended
   * runs and refused schemas.
   */
  async ask(input: McpElicitationAsk): Promise<McpElicitationAnswer> {
    const now = this.options.now ?? Date.now;
    const id = `elc_${randomUUID()}`;
    const base = {
      id,
      executionId: input.executionId,
      workflowId: input.workflowId,
      ...(input.workflowName ? { workflowName: input.workflowName } : {}),
      nodeId: input.nodeId,
      serverId: input.serverId,
      ...(input.registryServerId ? { registryServerId: input.registryServerId } : {}),
      ...(input.serverName ? { serverName: input.serverName } : {}),
      toolName: input.toolName,
      message: input.request.message,
      requestedSchema: input.request.requestedSchema,
      createdBy: input.createdBy ?? null,
      triggerType: input.triggerType ?? null
    };
    const auditBase = {
      category: "system" as const,
      action: "elicit",
      actor: { type: "system" as const },
      resourceType: "mcp_elicitation",
      resourceId: id
    };
    const metadata = {
      executionId: input.executionId,
      workflowId: input.workflowId,
      nodeId: input.nodeId,
      serverId: input.serverId,
      registryServerId: input.registryServerId ?? null,
      toolName: input.toolName,
      triggerType: input.triggerType ?? null
    };

    // The adapters validate before relaying, but the rule that secrets never
    // travel through elicitation is enforced here again, where the record is made.
    let refusal: string | null = null;
    try {
      validateElicitationRequest(input.request);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    if (refusal) {
      const expiresAt = new Date(now()).toISOString();
      const record = await this.store.createMcpElicitation({ ...base, expiresAt });
      await this.store.settleMcpElicitation(record.id, { status: "auto_declined", reason: refusal });
      await this.options.audit({ ...auditBase, eventType: "mcp_elicitation.refused", outcome: "denied", metadata: { ...metadata, reason: refusal } });
      this.options.logger?.warn("MCP elicitation refused", { id, reason: refusal });
      this.emit(input.executionId, { phase: "settled", elicitation: toElicitationView((await this.store.getMcpElicitation(record.id))!) });
      return Promise.resolve({ id, action: "decline", source: "refused", note: refusal });
    }

    if (!isAttendedTrigger(input.triggerType)) {
      const note = `Unattended run (${input.triggerType ?? "unknown trigger"}): nobody can answer, declined automatically.`;
      const expiresAt = new Date(now()).toISOString();
      const record = await this.store.createMcpElicitation({ ...base, expiresAt });
      await this.store.settleMcpElicitation(record.id, { status: "auto_declined", reason: note });
      await this.options.audit({ ...auditBase, eventType: "mcp_elicitation.auto_declined", outcome: "success", metadata });
      this.emit(input.executionId, { phase: "settled", elicitation: toElicitationView((await this.store.getMcpElicitation(record.id))!) });
      return Promise.resolve({ id, action: "decline", source: "unattended", note });
    }

    const timeoutMs = Math.max(1_000, Math.min(this.options.timeoutMs, input.timeoutMs ?? this.options.timeoutMs));
    const expiresAt = new Date(now() + timeoutMs).toISOString();
    const record = await this.store.createMcpElicitation({
      ...base,
      expiresAt,
      ...(this.options.cluster ? { holderId: this.options.cluster.instanceId } : {})
    });
    await this.options.audit({ ...auditBase, eventType: "mcp_elicitation.requested", outcome: "success", metadata: { ...metadata, expiresAt } });

    // A timeout or an abort settles the request in the background; a failed write is logged.
    const settleLater = (outcome: Parameters<McpElicitationService["finish"]>[1], answer: McpElicitationAnswer) => {
      this.finish(id, outcome, answer).catch((error: unknown) => {
        this.options.logger?.warn("MCP elicitation could not be settled", { id, error: error instanceof Error ? error.message : String(error) });
      });
    };
    return new Promise<McpElicitationAnswer>((resolve) => {
      const entry: PendingEntry = {
        record,
        resolve,
        listeners: [],
        timer: setTimeout(() => {
          settleLater({ status: "expired", reason: `No answer within ${Math.round(timeoutMs / 1000)} s.` }, {
            id,
            action: "decline",
            source: "timeout",
            note: `No answer within ${Math.round(timeoutMs / 1000)} s; declined.`
          });
        }, timeoutMs),
        signal: input.signal
      };
      entry.timer.unref?.();
      if (input.signal) {
        const onAbort = () => {
          settleLater({ status: "expired", reason: "The run was canceled while waiting." }, {
            id,
            action: "cancel",
            source: "timeout",
            note: "The run was canceled while the request was waiting."
          });
        };
        if (input.signal.aborted) {
          clearTimeout(entry.timer);
          onAbort();
          return;
        }
        input.signal.addEventListener("abort", onAbort, { once: true });
        entry.onAbort = onAbort;
      }
      this.pending.set(id, entry);
      this.emit(input.executionId, { phase: "created", elicitation: toElicitationView(record) });
    });
  }

  /**
   * A person's answer. Accepts validate the content against the requested
   * schema; the first answer wins. Only the person whose run it is, or an
   * operator or admin, may answer.
   */
  async answer(
    id: string,
    answer: { action: McpElicitationAction; content?: Record<string, unknown> },
    actor: { userId: string; email: string; role: string }
  ): Promise<McpElicitationRecord> {
    const record = await this.store.getMcpElicitation(id);
    if (!record) {
      throw new McpElicitationAnswerError("Elicitation request not found.", 404);
    }
    if (record.status !== "pending") {
      throw new McpElicitationAnswerError(`This request was already ${record.status.replace("_", " ")}.`, 409);
    }
    const privileged = actor.role === "admin" || actor.role === "operator";
    if (!privileged && record.createdBy && record.createdBy !== actor.userId) {
      throw new McpElicitationAnswerError("Only the person who started the run, or an operator, can answer this request.", 403);
    }
    const entry = this.pending.get(id);
    if (!entry && !this.options.cluster) {
      throw new McpElicitationAnswerError("This request is not waiting on this API instance any more; the run may have ended.", 409);
    }
    let content: Record<string, string | number | boolean> | undefined;
    if (answer.action === "accept") {
      const checked = validateElicitationContent(record.requestedSchema, answer.content ?? {});
      const problems = Object.entries(checked.errors).map(([field, problem]) => `${field}: ${problem}`);
      if (problems.length > 0) {
        throw new McpElicitationAnswerError("The answer does not match what the server asked for.", 400, problems);
      }
      content = checked.content;
    }
    if (!entry) {
      return await this.forwardAnswer(record, { action: answer.action, ...(content ? { content } : {}), actor: { userId: actor.userId, email: actor.email } });
    }
    return await this.settleAnswer(record, answer.action, content, actor);
  }

  /** The single settle point for a person's answer on the holder, then its audit (never the answer itself). */
  private async settleAnswer(
    record: McpElicitationRecord,
    action: McpElicitationAction,
    content: Record<string, string | number | boolean> | undefined,
    actor: { userId: string; email: string }
  ): Promise<McpElicitationRecord> {
    const id = record.id;
    const settled = await this.finish(
      id,
      { status: SETTLED_STATUS[action], answeredBy: actor.email },
      { id, action, ...(content ? { content } : {}), source: "user" }
    );
    await this.options.audit({
      category: "system",
      eventType: `mcp_elicitation.${SETTLED_STATUS[action]}`,
      action,
      outcome: "success",
      actor: { userId: actor.userId, email: actor.email, type: "user" },
      resourceType: "mcp_elicitation",
      resourceId: id,
      metadata: {
        executionId: record.executionId,
        workflowId: record.workflowId,
        nodeId: record.nodeId,
        toolName: record.toolName,
        serverId: record.serverId,
        // The answer itself is not audited; it may carry personal data.
        fields: content ? Object.keys(content) : []
      }
    });
    return settled ?? (await this.store.getMcpElicitation(id))!;
  }

  /**
   * Phase 13.1 — cluster mode, an answer on an instance that does not hold the request: a stopped holder means the
   * request expires now; otherwise the answer goes to the holder over the bus and this waits briefly for it to settle.
   * Returns the record as it then stands (still `pending` when the holder has not settled it yet).
   */
  private async forwardAnswer(record: McpElicitationRecord, answer: ForwardedAnswer): Promise<McpElicitationRecord> {
    const cluster = this.options.cluster!;
    const holder = record.holderId ?? null;
    const live = holder && holder !== cluster.instanceId ? await cluster.liveInstanceIds() : null;
    if (!holder || holder === cluster.instanceId || !live?.has(holder)) {
      await this.expireHeldElsewhere(record, ELICITATION_HOLDER_GONE_REASON);
      throw new McpElicitationAnswerError("This request expired: the API instance running it stopped, so the run cannot take an answer any more.", 409);
    }
    const sealed = cluster.sealer.sealValue(sealPurpose(record.id), JSON.stringify(answer));
    if (sealed.length > SEALED_ANSWER_MAX_LENGTH) {
      throw new McpElicitationAnswerError("This answer is too large to pass to the API instance running the request.", 400);
    }
    try {
      await cluster.bus.publish("ctl", { t: ELICITATION_ANSWER_MESSAGE, id: record.id, sealed });
    } catch (error) {
      this.options.logger?.warn("MCP elicitation answer could not be forwarded", { id: record.id, error: error instanceof Error ? error.message : String(error) });
      throw new McpElicitationAnswerError("The answer could not be passed to the API instance running the request. Try again.", 409);
    }
    const deadline = Date.now() + (cluster.settleWaitMs ?? 5_000);
    for (;;) {
      const current = await this.store.getMcpElicitation(record.id);
      if (!current || current.status !== "pending" || Date.now() >= deadline) return current ?? record;
      await new Promise((resolve) => setTimeout(resolve, cluster.settlePollMs ?? 100));
    }
  }

  /** Phase 13.1 — an answer another instance forwarded: settled here only if this instance holds the request. */
  private async onBusMessage(message: ClusterMessage): Promise<void> {
    if (message.t !== ELICITATION_ANSWER_MESSAGE) return;
    const id = typeof message.id === "string" && message.id.length > 0 && message.id.length <= ELICITATION_ID_MAX_LENGTH ? message.id : null;
    const sealed = typeof message.sealed === "string" && message.sealed.length <= SEALED_ANSWER_MAX_LENGTH ? message.sealed : null;
    if (!id || !sealed) return;
    const entry = this.pending.get(id);
    if (!entry) return;
    let answer: ForwardedAnswer;
    try {
      answer = JSON.parse(this.options.cluster!.sealer.openValue(sealPurpose(id), sealed)) as ForwardedAnswer;
    } catch {
      this.options.logger?.warn("Ignored an elicitation answer on the cluster bus that does not open", { id });
      return;
    }
    if (!answer || !(answer.action in SETTLED_STATUS) || typeof answer.actor?.email !== "string" || typeof answer.actor?.userId !== "string") return;
    // Checked once more where the request is held: the answering instance validated it against the same schema.
    let content: Record<string, string | number | boolean> | undefined;
    if (answer.action === "accept") {
      const checked = validateElicitationContent(entry.record.requestedSchema, answer.content ?? {});
      if (Object.keys(checked.errors).length > 0) {
        this.options.logger?.warn("Ignored a forwarded elicitation answer that does not match the schema", { id });
        return;
      }
      content = checked.content;
    }
    await this.settleAnswer(entry.record, answer.action, content, answer.actor);
  }

  /** Expire every request an execution still has waiting (the run ended without answering them). */
  async releaseExecution(executionId: string, reason: string): Promise<number> {
    let count = 0;
    for (const [id, entry] of this.pending) {
      if (entry.record.executionId !== executionId) continue;
      await this.finish(id, { status: "expired", reason }, { id, action: "cancel", source: "timeout", note: reason });
      count += 1;
    }
    return count;
  }

  async stop(): Promise<void> {
    this.unsubscribeBus?.();
    for (const [id] of this.pending) {
      await this.finish(id, { status: "expired", reason: "The API is shutting down." }, { id, action: "cancel", source: "timeout", note: "The API is shutting down." });
    }
  }

  private async finish(
    id: string,
    outcome: { status: Exclude<McpElicitationStatus, "pending">; answeredBy?: string | null; reason?: string | null },
    answer: McpElicitationAnswer
  ): Promise<McpElicitationRecord | null> {
    const entry = this.pending.get(id);
    if (!entry) return null;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
    await this.store.settleMcpElicitation(id, outcome);
    if (outcome.status === "expired") {
      await this.options.audit({
        category: "system",
        eventType: "mcp_elicitation.expired",
        action: "expire",
        outcome: "failure",
        actor: { type: "system" },
        resourceType: "mcp_elicitation",
        resourceId: id,
        metadata: { executionId: entry.record.executionId, reason: outcome.reason ?? null }
      });
    }
    const settled = await this.store.getMcpElicitation(id);
    if (settled) this.emit(entry.record.executionId, { phase: "settled", elicitation: toElicitationView(settled) });
    entry.resolve(answer);
    return settled;
  }

  private emit(executionId: string, event: McpElicitationEvent): void {
    const listeners = this.executionListeners.get(executionId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        this.options.logger?.warn("MCP elicitation listener failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}
