import { nanoid } from "nanoid";
import type { Store } from "../db/store.js";
import { wellFormedAuditText } from "../db/audit-chain.js";

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

/**
 * An optional audit field: an empty string (e.g. an empty User-Agent header) is stored as none, and text is made
 * well-formed (lone surrogates and U+0000 → U+FFFD) as the store hashes and stores it, so the entry returned here is
 * the one stored.
 */
function textOrNull(value: string | null | undefined): string | null {
  return value ? wellFormedAuditText(value) : null;
}

export class AuditService {
  constructor(
    private readonly store: Store,
    private readonly options: { enabled: boolean } = { enabled: true }
  ) {}

  isEnabled(): boolean {
    return this.options.enabled;
  }

  async record(event: AuditEventInput): Promise<AuditLogEntry | null> {
    if (!this.options.enabled) return null;
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
      metadata: event.metadata,
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

  async purge(options: { before: string }): Promise<number> {
    return await this.store.pruneAuditLogs(options);
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
