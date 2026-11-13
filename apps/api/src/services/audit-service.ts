import { nanoid } from "nanoid";
import type { Store } from "../db/store.js";
import { AUDIT_RETENTION_CHECKPOINT_EVENT, wellFormedAuditText } from "../db/audit-chain.js";

export type AuditOutcome = "success" | "failure" | "denied";

export type AuditCategory =
  | "auth"
  | "mfa"
  | "sso"
  | "api_key"
  | "secret"
  | "external_secret"
  | "workflow"
  | "execution"
  | "project"
  | "rbac"
  | "sharing"
  | "approval"
  | "release"
  /** 13.3 — legal holds (and later data-subject requests). */
  | "data_protection"
  | "system";

export interface AuditActor {
  userId?: string | null;
  email?: string | null;
  type?: "user" | "api_key" | "system";
  ipAddress?: string | null;
  userAgent?: string | null;
  /** 13.2 — the API key the request was made with; stored in the entry's metadata as `actorApiKeyId`. */
  apiKeyId?: string | null;
  /** 13.2 — the key belongs to a service account; stored in the metadata as `actorServiceAccount: true`. */
  serviceAccount?: boolean;
}

/**
 * 13.2 — the metadata stored for an event: the event's own, plus the API key the actor used (when there was one). A
 * non-object metadata value is wrapped as `{ value }` when a key has to be added. The key fields go last, so an
 * event's own metadata cannot spoof them.
 */
function metadataWithActorKey(metadata: unknown, actor: AuditActor): unknown {
  if (!actor.apiKeyId) return metadata;
  const keyFields = { actorApiKeyId: actor.apiKeyId, ...(actor.serviceAccount ? { actorServiceAccount: true } : {}) };
  if (metadata === undefined || metadata === null) return keyFields;
  // A string, number or array is kept under `value`, so the key is never left out.
  if (typeof metadata !== "object" || Array.isArray(metadata)) return { value: metadata, ...keyFields };
  return { ...(metadata as Record<string, unknown>), ...keyFields };
}

export interface AuditEventInput {
  eventType: string;
  category: AuditCategory;
  action: string;
  outcome?: AuditOutcome;
  actor?: AuditActor;
  resourceType?: string;
  resourceId?: string;
  projectId?: string | null;
  metadata?: unknown;
  message?: string;
}

export interface AuditListFilter {
  category?: string;
  eventType?: string;
  outcome?: string;
  actorUserId?: string;
  resourceType?: string;
  resourceId?: string;
  projectId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditLogEntry {
  id: string;
  eventType: string;
  category: string;
  action: string;
  outcome: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorType: string;
  resourceType: string | null;
  resourceId: string | null;
  projectId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
  message: string | null;
  createdAt: string;
}

/**
 * An optional audit field: an empty string (e.g. an empty User-Agent header) is stored as none, and text is made
 * well-formed (lone surrogates and U+0000 → U+FFFD) as the store hashes and stores it, so the entry returned here is
 * the one stored.
 */
function textOrNull(value: string | null | undefined): string | null {
  return value ? wellFormedAuditText(value) : null;
}

/** Where every recorded event also goes (the log streams): one path, so an event is never sent twice or skipped. */
export type AuditStreamSink = (event: AuditEventInput) => Promise<void>;

export class AuditService {
  private stream: AuditStreamSink | undefined;

  constructor(
    private readonly store: Store,
    private readonly options: { enabled: boolean } = { enabled: true }
  ) {}

  isEnabled(): boolean {
    return this.options.enabled;
  }

  /**
   * Sends every event `record` receives to `sink` as well (the log streams), after the write, also with the audit log
   * off (AUDIT_LOG_ENABLED=false), as log streams always received them. Callers record only; they never dispatch
   * themselves.
   */
  setStream(sink: AuditStreamSink | undefined): void {
    this.stream = sink;
  }

  async record(event: AuditEventInput): Promise<AuditLogEntry | null> {
    const entry = this.options.enabled ? await this.write(event) : null;
    await this.emit(event);
    return entry;
  }

  private async emit(event: AuditEventInput): Promise<void> {
    if (!this.stream) return;
    try {
      await this.stream(event);
    } catch {
      // A log stream problem never fails the action being audited (the stream records its own delivery errors).
    }
  }

  private async write(event: AuditEventInput): Promise<AuditLogEntry | null> {
    const id = `aud_${nanoid(16)}`;
    const actor = event.actor ?? {};
    const entry = {
      id,
      eventType: wellFormedAuditText(event.eventType),
      category: wellFormedAuditText(event.category),
      action: wellFormedAuditText(event.action),
      outcome: event.outcome ?? "success",
      actorUserId: textOrNull(actor.userId),
      actorEmail: textOrNull(actor.email),
      actorType: actor.type ?? "user",
      resourceType: textOrNull(event.resourceType),
      resourceId: textOrNull(event.resourceId),
      projectId: textOrNull(event.projectId),
      ipAddress: textOrNull(actor.ipAddress),
      userAgent: textOrNull(actor.userAgent),
      metadata: metadataWithActorKey(event.metadata, actor),
      message: textOrNull(event.message)
    };
    try {
      await this.store.writeAuditLog(entry);
    } catch {
      // Never let audit failures cascade.
      return null;
    }
    return {
      ...entry,
      metadata: event.metadata === undefined ? null : event.metadata,
      createdAt: new Date().toISOString()
    };
  }

  async list(filter: AuditListFilter = {}): Promise<{
    items: AuditLogEntry[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    return await this.store.listAuditLogs(filter);
  }

  /** Retention. The checkpoint the store appends (db/audit-chain.ts, "Retention") goes to the log streams too. */
  async purge(options: { before: string }): Promise<number> {
    const started = Date.now();
    const deleted = await this.store.pruneAuditLogs(options);
    if (deleted > 0 && this.stream) {
      const checkpoint = (await this.store.listAuditLogs({ eventType: AUDIT_RETENTION_CHECKPOINT_EVENT, pageSize: 1 })).items[0];
      const meta = (checkpoint?.metadata ?? {}) as { before?: unknown; deleted?: unknown };
      // Only the checkpoint this purge wrote (a purge of unhashed legacy rows writes none).
      if (checkpoint && meta.before === options.before && meta.deleted === deleted && Date.parse(checkpoint.createdAt) >= started - 1000) {
        await this.emit({
          eventType: checkpoint.eventType,
          category: "system",
          action: checkpoint.action,
          outcome: "success",
          actor: { type: "system" },
          resourceType: checkpoint.resourceType ?? undefined,
          metadata: checkpoint.metadata,
          message: checkpoint.message ?? undefined
        });
      }
    }
    return deleted;
  }

  async exportCsv(filter: AuditListFilter = {}): Promise<string> {
    const pageSize = Math.min(500, filter.pageSize ?? 500);
    let page = 1;
    const rows: string[] = [];
    rows.push(
      [
        "id",
        "created_at",
        "category",
        "event_type",
        "action",
        "outcome",
        "actor_user_id",
        "actor_email",
        "actor_type",
        "resource_type",
        "resource_id",
        "project_id",
        "ip_address",
        "user_agent",
        "message",
        "metadata"
      ].join(",")
    );
    while (true) {
      const result = await this.store.listAuditLogs({ ...filter, page, pageSize });
      if (!result.items.length) break;
      for (const item of result.items) {
        rows.push(
          [
            csvEscape(item.id),
            csvEscape(item.createdAt),
            csvEscape(item.category),
            csvEscape(item.eventType),
            csvEscape(item.action),
            csvEscape(item.outcome),
            csvEscape(item.actorUserId ?? ""),
            csvEscape(item.actorEmail ?? ""),
            csvEscape(item.actorType),
            csvEscape(item.resourceType ?? ""),
            csvEscape(item.resourceId ?? ""),
            csvEscape(item.projectId ?? ""),
            csvEscape(item.ipAddress ?? ""),
            csvEscape(item.userAgent ?? ""),
            csvEscape(item.message ?? ""),
            csvEscape(item.metadata === null || item.metadata === undefined ? "" : JSON.stringify(item.metadata))
          ].join(",")
        );
      }
      if (result.items.length < pageSize) break;
      page += 1;
      if (page > 2000) break; // hard safety cap
    }
    return rows.join("\n");
  }
}

function csvEscape(value: string): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
