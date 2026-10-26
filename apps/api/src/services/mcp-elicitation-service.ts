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

export interface McpElicitationServiceOptions {
  /** Longest a request waits for a person (ms). */
  timeoutMs: number;
  audit: (event: AuditEventInput) => void | Promise<void>;
  logger?: { info: (msg: string, fields?: Record<string, unknown>) => void; warn: (msg: string, fields?: Record<string, unknown>) => void };
  now?: () => number;
}

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
  const { createdBy: _createdBy, triggerType: _triggerType, ...view } = record;
  return view;
}

export class McpElicitationService {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly executionListeners = new Map<string, Set<(event: McpElicitationEvent) => void>>();

  constructor(
    private readonly store: Store,
    private readonly options: McpElicitationServiceOptions
  ) {}

  /** Requests still marked pending from before a restart cannot be answered any more. */
  async expireStale(reason = "The API restarted while the request was waiting."): Promise<number> {
    const stale = (await this.store.listMcpElicitations({ status: "pending", limit: 500 })).filter((entry) => !this.pending.has(entry.id));
    for (const entry of stale) {
      await this.store.settleMcpElicitation(entry.id, { status: "expired", reason });
    }
    return stale.length;
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
    const record = await this.store.createMcpElicitation({ ...base, expiresAt });
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
    if (!entry) {
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
    const settled = await this.finish(
      id,
      { status: SETTLED_STATUS[answer.action], answeredBy: actor.email },
      { id, action: answer.action, ...(content ? { content } : {}), source: "user" }
    );
    await this.options.audit({
      category: "system",
      eventType: `mcp_elicitation.${SETTLED_STATUS[answer.action]}`,
      action: answer.action,
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
