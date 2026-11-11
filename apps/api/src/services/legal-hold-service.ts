/**
 * 13.3 — legal holds: place, release, list, and the holds on a workflow, project or run (for the "Held" badge).
 *
 * A hold keeps data from deletion; it never changes who may read it. The store enforces it on every purge and every
 * delete that removes held data (db/legal-hold-sql.ts); this service validates what a hold names, resolves a
 * data-subject hold to the rows the lookup finds now, and audits and announces each change
 * (`data.legal_hold_changed`). Holds are never released automatically: `endsAt` is a review date.
 */
import crypto from "node:crypto";
import {
  LEGAL_HOLD_CHANGED_EVENT,
  type LegalHoldItemKind,
  type LegalHoldItemView,
  type LegalHoldPlaceInput,
  type LegalHoldRef,
  type LegalHoldStatus,
  type LegalHoldView,
  type ReplayFindSubjectQuery,
  type ReplayFindSubjectResult
} from "@ai-orchestrator/shared";
import type { Store } from "../db/store.js";
import type { LegalHoldTarget } from "../db/legal-hold-sql.js";
import type { AuditEventInput } from "./audit-service.js";
import type { NotificationEvent } from "./notification-service.js";

/** A request the service refuses: 400 (invalid), 404 (not found) or 503 (the lookup is not available). */
export class LegalHoldRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 503
  ) {
    super(message);
    this.name = "LegalHoldRequestError";
  }
}

export interface LegalHoldActor {
  userId: string | null;
  email: string | null;
}

export interface LegalHoldServiceOptions {
  store: Store;
  /** Records an audit event (the routes pass one bound to the request, with its actor). */
  audit?: (event: Omit<AuditEventInput, "actor">) => Promise<unknown>;
  notify?: (event: NotificationEvent) => Promise<unknown>;
  /** The data-subject lookup (absent when production capture is unavailable). */
  findSubject?: (query: ReplayFindSubjectQuery) => Promise<ReplayFindSubjectResult>;
  now?: () => Date;
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
}

/** What `GET /api/legal-holds/status` answers: held or not, and by which holds (names only for hold managers). */
export interface LegalHoldStatusView {
  held: boolean;
  holds: LegalHoldRef[];
}

export class LegalHoldService {
  private readonly now: () => Date;

  constructor(private readonly options: LegalHoldServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async list(options: { status?: LegalHoldStatus } = {}): Promise<LegalHoldView[]> {
    return await this.options.store.listLegalHolds(options);
  }

  async get(id: string): Promise<LegalHoldView | null> {
    return await this.options.store.getLegalHold(id);
  }

  async items(id: string, page: { offset: number; limit: number }): Promise<{ items: LegalHoldItemView[]; total: number } | null> {
    if (!(await this.options.store.getLegalHold(id))) return null;
    return await this.options.store.listLegalHoldItems(id, page);
  }

  /** The active holds that keep a workflow, a project or a run. */
  async on(target: { workflowId?: string; projectId?: string; executionId?: string }): Promise<LegalHoldRef[]> {
    const store = this.options.store;
    const targets: LegalHoldTarget[] = [];
    if (target.workflowId) targets.push({ kind: "workflow", id: target.workflowId });
    if (target.projectId) targets.push({ kind: "project", id: target.projectId });
    if (target.executionId) targets.push({ kind: "row", table: "execution_history", id: target.executionId });
    const seen = new Map<string, LegalHoldRef>();
    for (const one of targets) for (const hold of await store.legalHoldsOn(one)) seen.set(hold.id, hold);
    return [...seen.values()];
  }

  /** Places a hold. A subject hold holds the rows the data-subject lookup finds now (never the value itself). */
  async place(input: LegalHoldPlaceInput, actor: LegalHoldActor): Promise<LegalHoldView> {
    const store = this.options.store;
    const id = `lh_${crypto.randomUUID()}`;
    let scopeId = id;
    let items: Array<{ kind: LegalHoldItemKind; rowId: string }> = [];
    let found: { runs?: number; missingRuns?: number; rows?: Partial<Record<LegalHoldItemKind, number>> } = {};
    switch (input.scopeType) {
      case "project": {
        const project = await store.getProject(input.scopeId!);
        if (!project) throw new LegalHoldRequestError("Project not found", 404);
        scopeId = project.id;
        break;
      }
      case "workflow": {
        const workflow = await store.getWorkflow(input.scopeId!);
        if (!workflow) throw new LegalHoldRequestError("Workflow not found", 404);
        scopeId = workflow.id;
        break;
      }
      case "runs": {
        const ids = [...new Set(input.executionIds ?? [])];
        const existing: string[] = [];
        for (const executionId of ids) if (await store.getExecutionHistory(executionId)) existing.push(executionId);
        if (existing.length === 0) throw new LegalHoldRequestError("None of these runs exists.", 404);
        items = existing.map((rowId) => ({ kind: "execution" as const, rowId }));
        found = { runs: existing.length, missingRuns: ids.length - existing.length };
        break;
      }
      case "subject": {
        if (!this.options.findSubject) {
          throw new LegalHoldRequestError("The data-subject lookup is not available on this server (it needs SECRET_MASTER_KEY_BASE64).", 503);
        }
        let result: ReplayFindSubjectResult;
        try {
          result = await this.options.findSubject(input.subject!);
        } catch (error) {
          throw new LegalHoldRequestError(error instanceof Error ? error.message : "The value could not be looked up.", 400);
        }
        const unique = new Map<string, { kind: LegalHoldItemKind; rowId: string }>();
        for (const match of result.matches) unique.set(`${match.kind}:${match.id}`, { kind: match.kind, rowId: match.id });
        items = [...unique.values()];
        if (items.length === 0) throw new LegalHoldRequestError("The lookup found no stored rows for this value, so there is nothing to hold.", 400);
        const rows: Partial<Record<LegalHoldItemKind, number>> = {};
        for (const item of items) rows[item.kind] = (rows[item.kind] ?? 0) + 1;
        found = { rows };
        break;
      }
    }
    const hold = await store.placeLegalHold({
      id,
      name: input.name,
      reason: input.reason,
      matterRef: input.matterRef?.trim() ? input.matterRef.trim() : null,
      scopeType: input.scopeType,
      scopeId,
      endsAt: input.endsAt ? new Date(input.endsAt).toISOString() : null,
      createdBy: actor.email,
      createdAt: this.now().toISOString(),
      items
    });
    await this.record("place", hold, { ...found });
    return hold;
  }

  /** Releases an active hold; null when there is none. A hold already released is returned unchanged. */
  async release(id: string, reason: string, actor: LegalHoldActor): Promise<{ hold: LegalHoldView; changed: boolean } | null> {
    const before = await this.options.store.getLegalHold(id);
    if (!before) return null;
    if (before.status !== "active") return { hold: before, changed: false };
    const hold = await this.options.store.releaseLegalHold({ id, releasedBy: actor.email, reason, releasedAt: this.now().toISOString() });
    if (!hold) return null;
    const changed = hold.status === "released" && hold.releasedAt !== before.releasedAt;
    if (changed) await this.record("release", hold, {});
    return { hold, changed };
  }

  private async record(change: "place" | "release", hold: LegalHoldView, extra: Record<string, unknown>): Promise<void> {
    const scope = hold.scopeType === "project" || hold.scopeType === "workflow" ? { scopeId: hold.scopeId } : {};
    await this.options.audit?.({
      category: "data_protection",
      eventType: change === "place" ? "legal_hold.placed" : "legal_hold.released",
      action: change === "place" ? "create" : "release",
      outcome: "success",
      resourceType: "legal_hold",
      resourceId: hold.id,
      projectId: hold.scopeType === "project" ? hold.scopeId : null,
      metadata: {
        name: hold.name,
        scopeType: hold.scopeType,
        ...scope,
        matterRef: hold.matterRef,
        endsAt: hold.endsAt,
        itemCount: hold.itemCount,
        ...(change === "release" ? { releaseReason: hold.releaseReason } : { reason: hold.reason }),
        ...extra
      },
      message: `Legal hold "${hold.name}" ${change === "place" ? "placed" : "released"}`
    });
    try {
      await this.options.notify?.({
        type: LEGAL_HOLD_CHANGED_EVENT,
        workflowId: hold.scopeType === "workflow" ? hold.scopeId : "",
        workflowName: "",
        timestamp: this.now().toISOString(),
        legalHold: {
          change: change === "place" ? "placed" : "released",
          id: hold.id,
          name: hold.name,
          scopeType: hold.scopeType,
          scopeId: hold.scopeType === "project" || hold.scopeType === "workflow" ? hold.scopeId : null,
          itemCount: hold.itemCount,
          by: change === "place" ? hold.createdBy : hold.releasedBy
        }
      });
    } catch (error) {
      this.options.logger?.warn({ holdId: hold.id, error: error instanceof Error ? error.message : String(error) }, "Failed to send the legal hold notification");
    }
  }
}
