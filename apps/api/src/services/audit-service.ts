import { nanoid } from "nanoid";
import { SqliteStore } from "../db/database";

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
  | "system";

export interface AuditActor {
  userId?: string | null;
  email?: string | null;
  type?: "user" | "api_key" | "system";
  ipAddress?: string | null;
  userAgent?: string | null;
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

export class AuditService {
  constructor(
    private readonly store: SqliteStore,
    private readonly options: { enabled: boolean } = { enabled: true }
  ) {}

  isEnabled(): boolean {
    return this.options.enabled;
  }

  record(event: AuditEventInput): AuditLogEntry | null {
    if (!this.options.enabled) return null;
    const id = `aud_${nanoid(16)}`;
    const actor = event.actor ?? {};
    const entry = {
      id,
      eventType: event.eventType,
      category: event.category,
      action: event.action,
      outcome: event.outcome ?? "success",
      actorUserId: actor.userId ?? null,
      actorEmail: actor.email ?? null,
      actorType: actor.type ?? "user",
      resourceType: event.resourceType ?? null,
      resourceId: event.resourceId ?? null,
      projectId: event.projectId ?? null,
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: event.metadata,
      message: event.message ?? null
    };
    try {
      this.store.writeAuditLog(entry);
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

  list(filter: AuditListFilter = {}): {
    items: AuditLogEntry[];
    total: number;
    page: number;
    pageSize: number;
  } {
    return this.store.listAuditLogs(filter);
  }

  purge(options: { before: string }): number {
    return this.store.pruneAuditLogs(options);
  }

  exportCsv(filter: AuditListFilter = {}): string {
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
      const result = this.store.listAuditLogs({ ...filter, page, pageSize });
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
