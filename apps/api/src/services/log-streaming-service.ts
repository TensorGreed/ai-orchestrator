import crypto from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import { nanoid } from "nanoid";
import type { LogStreamDestinationRecord, SqliteStore } from "../db/database";
import type { AuditEventInput } from "./audit-service";

export type LogStreamDestinationType = "syslog" | "webhook" | "sentry";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

export interface LogStreamEvent {
  category: string;
  eventType: string;
  level: LogLevel;
  outcome?: string;
  message?: string;
  actor?: {
    userId?: string | null;
    email?: string | null;
    type?: string | null;
    ipAddress?: string | null;
  } | null;
  resourceType?: string | null;
  resourceId?: string | null;
  projectId?: string | null;
  metadata?: unknown;
  createdAt: string;
}

export interface SyslogConfig {
  host: string;
  port: number;
  transport?: "udp" | "tcp";
  facility?: number;
  appName?: string;
  hostname?: string;
}

export interface WebhookConfig {
  url: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  hmacSecret?: string;
  hmacHeader?: string;
}

export interface SentryConfig {
  dsn: string;
  environment?: string;
  release?: string;
}

export interface LogStreamDestinationPublic {
  id: string;
  name: string;
  type: LogStreamDestinationType | string;
  enabled: boolean;
  categories: string[];
  minLevel: LogLevel | string;
  config: Record<string, unknown>;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  dispatchedCount: number;
  failedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LogStreamAdapter {
  type: LogStreamDestinationType | string;
  send(event: LogStreamEvent, config: Record<string, unknown>): Promise<void>;
}

function parseMasterKey(rawKey?: string): Buffer {
  if (!rawKey) throw new Error("SECRET_MASTER_KEY_BASE64 environment variable is required");
  const key = Buffer.from(rawKey, "base64");
  if (key.length !== 32) throw new Error("SECRET_MASTER_KEY_BASE64 must decode to 32 bytes");
  return key;
}

const SECRET_FIELDS_BY_TYPE: Record<string, string[]> = {
  syslog: [],
  webhook: ["hmacSecret"],
  sentry: ["dsn"]
};

const SECRET_PLACEHOLDER = "__secret__";

export interface LogStreamingOptions {
  enabled?: boolean;
  flushIntervalMs?: number;
  bufferSize?: number;
  retryMaxAttempts?: number;
  eventRetentionDays?: number;
  eventPruneIntervalMs?: number;
}

interface QueueEntry {
  destinationId: string;
  event: LogStreamEvent;
  attempts: number;
}

export class LogStreamingService {
  private readonly key: Buffer;
  private readonly adapters: Map<string, LogStreamAdapter> = new Map();
  private readonly queue: QueueEntry[] = [];
  private readonly flushIntervalMs: number;
  private readonly bufferSize: number;
  private readonly retryMaxAttempts: number;
  private readonly eventRetentionDays: number;
  private readonly eventPruneIntervalMs: number;
  private readonly enabled: boolean;

  private flushTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private stopped = false;

  constructor(
    private readonly store: SqliteStore,
    rawKey: string | undefined,
    options: LogStreamingOptions = {}
  ) {
    this.key = parseMasterKey(rawKey);
    this.enabled = options.enabled !== false;
    this.flushIntervalMs = options.flushIntervalMs ?? 2000;
    this.bufferSize = options.bufferSize ?? 1000;
    this.retryMaxAttempts = options.retryMaxAttempts ?? 3;
    this.eventRetentionDays = options.eventRetentionDays ?? 14;
    this.eventPruneIntervalMs = options.eventPruneIntervalMs ?? 3600000;

    this.registerAdapter(syslogAdapter);
    this.registerAdapter(webhookAdapter);
    this.registerAdapter(sentryAdapter);
  }

  registerAdapter(adapter: LogStreamAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  start(): void {
    if (!this.enabled || this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    if (typeof this.flushTimer.unref === "function") this.flushTimer.unref();
    if (this.eventRetentionDays > 0) {
      this.pruneTimer = setInterval(() => {
        const before = new Date(Date.now() - this.eventRetentionDays * 86400000).toISOString();
        try {
          this.store.pruneLogStreamEvents({ before });
        } catch {
          // ignore
        }
      }, this.eventPruneIntervalMs);
      if (typeof this.pruneTimer.unref === "function") this.pruneTimer.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    await this.flush();
  }

  // ---------------------------------------------------------------------------
  // Destination CRUD
  // ---------------------------------------------------------------------------

  listDestinations(): LogStreamDestinationPublic[] {
    return this.store.listLogStreamDestinations().map((record) => this.toPublic(record, true));
  }

  getDestination(id: string): LogStreamDestinationPublic | null {
    const record = this.store.getLogStreamDestination(id);
    return record ? this.toPublic(record, true) : null;
  }

  createDestination(input: {
    name: string;
    type: LogStreamDestinationType | string;
    enabled?: boolean;
    categories?: string[];
    minLevel?: LogLevel;
    config: Record<string, unknown>;
    createdBy?: string | null;
  }): LogStreamDestinationPublic {
    this.validateType(input.type);
    this.validateConfig(input.type, input.config);
    const id = `lsd_${nanoid(12)}`;
    const encrypted = this.encryptConfig(input.config);
    this.store.upsertLogStreamDestination({
      id,
      name: input.name,
      type: input.type,
      enabled: input.enabled !== false,
      categories: input.categories ?? [],
      minLevel: input.minLevel ?? "info",
      configIv: encrypted.iv,
      configAuthTag: encrypted.authTag,
      configCiphertext: encrypted.ciphertext,
      createdBy: input.createdBy ?? null
    });
    const created = this.getDestination(id);
    if (!created) throw new Error("failed to create log stream destination");
    return created;
  }

  updateDestination(
    id: string,
    patch: {
      name?: string;
      enabled?: boolean;
      categories?: string[];
      minLevel?: LogLevel;
      config?: Record<string, unknown>;
    }
  ): LogStreamDestinationPublic | null {
    const existing = this.store.getLogStreamDestination(id);
    if (!existing) return null;
    let mergedConfig: Record<string, unknown> | null = null;
    if (patch.config !== undefined) {
      const currentConfig = this.decryptConfig(existing);
      const secretFields = SECRET_FIELDS_BY_TYPE[existing.type] ?? [];
      const incoming: Record<string, unknown> = { ...patch.config };
      for (const field of secretFields) {
        if (incoming[field] === SECRET_PLACEHOLDER || incoming[field] === undefined) {
          if (currentConfig[field] !== undefined) incoming[field] = currentConfig[field];
          else delete incoming[field];
        }
      }
      this.validateConfig(existing.type, incoming);
      mergedConfig = incoming;
    }
    const encrypted = mergedConfig ? this.encryptConfig(mergedConfig) : null;
    this.store.upsertLogStreamDestination({
      id,
      name: patch.name ?? existing.name,
      type: existing.type,
      enabled: patch.enabled === undefined ? existing.enabled : patch.enabled,
      categories: patch.categories ?? existing.categories,
      minLevel: patch.minLevel ?? (existing.minLevel as LogLevel),
      configIv: encrypted ? encrypted.iv : existing.configIv,
      configAuthTag: encrypted ? encrypted.authTag : existing.configAuthTag,
      configCiphertext: encrypted ? encrypted.ciphertext : existing.configCiphertext,
      createdBy: existing.createdBy
    });
    return this.getDestination(id);
  }

  deleteDestination(id: string): boolean {
    return this.store.deleteLogStreamDestination(id);
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  dispatchAudit(event: AuditEventInput & { createdAt?: string }): void {
    if (!this.enabled) return;
    const level: LogLevel = event.outcome === "failure" ? "error" : event.outcome === "denied" ? "warn" : "info";
    const logEvent: LogStreamEvent = {
      category: event.category,
      eventType: event.eventType,
      level,
      outcome: event.outcome,
      message: event.message,
      actor: event.actor
        ? {
            userId: event.actor.userId ?? null,
            email: event.actor.email ?? null,
            type: event.actor.type ?? null,
            ipAddress: event.actor.ipAddress ?? null
          }
        : undefined,
      resourceType: event.resourceType ?? null,
      resourceId: event.resourceId ?? null,
      projectId: event.projectId ?? null,
      metadata: event.metadata,
      createdAt: event.createdAt ?? new Date().toISOString()
    };
    this.dispatch(logEvent);
  }

  dispatch(event: LogStreamEvent): void {
    if (!this.enabled) return;
    const destinations = this.store.listLogStreamDestinations();
    for (const dest of destinations) {
      if (!dest.enabled) continue;
      if (!this.matches(dest, event)) continue;
      if (this.queue.length >= this.bufferSize) {
        this.queue.shift();
      }
      this.queue.push({ destinationId: dest.id, event, attempts: 0 });
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift();
        if (!entry) break;
        await this.send(entry);
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Send a synthetic test event to the destination. Does not persist an event row
   * unless the dispatch fails (so failures are observable via lastError).
   */
  async test(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const record = this.store.getLogStreamDestination(id);
    if (!record) return { ok: false, error: "destination not found" };
    const event: LogStreamEvent = {
      category: "system",
      eventType: "log_stream.test",
      level: "info",
      outcome: "success",
      message: "Test event from ai-orchestrator log streaming",
      resourceType: "log_stream_destination",
      resourceId: id,
      projectId: null,
      createdAt: new Date().toISOString(),
      metadata: { test: true }
    };
    try {
      const config = this.decryptConfig(record);
      const adapter = this.adapters.get(record.type);
      if (!adapter) throw new Error(`no adapter for type '${record.type}'`);
      await adapter.send(event, config);
      this.store.recordLogStreamDispatch({ destinationId: id, success: true });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.recordLogStreamDispatch({ destinationId: id, success: false, error: message });
      return { ok: false, error: message };
    }
  }

  listDeliveryEvents(destinationId: string, limit = 100): Array<{
    id: string;
    destinationId: string;
    category: string;
    eventType: string;
    level: string;
    status: string;
    attempts: number;
    error: string | null;
    createdAt: string;
  }> {
    return this.store
      .listLogStreamEvents({ destinationId, limit })
      .map(({ payload: _payload, ...rest }) => rest);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private validateType(type: string): void {
    if (!this.adapters.has(type)) {
      throw new Error(`unsupported log stream destination type '${type}'`);
    }
  }

  private validateConfig(type: string, config: Record<string, unknown>): void {
    if (type === "syslog") {
      if (typeof config.host !== "string" || !config.host) throw new Error("syslog destination requires 'host'");
      if (typeof config.port !== "number" || !Number.isFinite(config.port)) {
        throw new Error("syslog destination requires numeric 'port'");
      }
    } else if (type === "webhook") {
      if (typeof config.url !== "string" || !/^https?:\/\//.test(config.url)) {
        throw new Error("webhook destination requires http(s) 'url'");
      }
    } else if (type === "sentry") {
      if (typeof config.dsn !== "string" || !/^https?:\/\//.test(config.dsn)) {
        throw new Error("sentry destination requires a valid 'dsn'");
      }
    }
  }

  private matches(dest: LogStreamDestinationRecord, event: LogStreamEvent): boolean {
    if (dest.categories.length > 0 && !dest.categories.includes(event.category)) return false;
    const minLevel = isLogLevel(dest.minLevel) ? dest.minLevel : "info";
    return LEVEL_RANK[event.level] >= LEVEL_RANK[minLevel];
  }

  private async send(entry: QueueEntry): Promise<void> {
    const record = this.store.getLogStreamDestination(entry.destinationId);
    if (!record) return;
    const adapter = this.adapters.get(record.type);
    if (!adapter) {
      this.writeDelivery(entry, "failed", `no adapter for type '${record.type}'`);
      this.store.recordLogStreamDispatch({ destinationId: record.id, success: false, error: `no adapter: ${record.type}` });
      return;
    }
    let config: Record<string, unknown>;
    try {
      config = this.decryptConfig(record);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeDelivery(entry, "failed", `config decryption failed: ${msg}`);
      this.store.recordLogStreamDispatch({ destinationId: record.id, success: false, error: msg });
      return;
    }
    try {
      entry.attempts += 1;
      await adapter.send(entry.event, config);
      this.writeDelivery(entry, "sent", null);
      this.store.recordLogStreamDispatch({ destinationId: record.id, success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (entry.attempts < this.retryMaxAttempts && !this.stopped) {
        this.queue.push(entry);
      } else {
        this.writeDelivery(entry, "failed", message);
        this.store.recordLogStreamDispatch({ destinationId: record.id, success: false, error: message });
      }
    }
  }

  private writeDelivery(entry: QueueEntry, status: "sent" | "failed", error: string | null): void {
    try {
      this.store.writeLogStreamEvent({
        id: `lse_${nanoid(14)}`,
        destinationId: entry.destinationId,
        category: entry.event.category,
        eventType: entry.event.eventType,
        level: entry.event.level,
        status,
        attempts: entry.attempts,
        error,
        payload: status === "failed" ? entry.event : undefined
      });
    } catch {
      // swallow — never cascade from logging
    }
  }

  private encryptConfig(config: Record<string, unknown>): { iv: string; authTag: string; ciphertext: string } {
    const plaintext = JSON.stringify(config);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: encrypted.toString("base64")
    };
  }

  private decryptConfig(record: LogStreamDestinationRecord): Record<string, unknown> {
    if (!record.configIv || !record.configAuthTag || !record.configCiphertext) return {};
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(record.configIv, "base64")
    );
    decipher.setAuthTag(Buffer.from(record.configAuthTag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(record.configCiphertext, "base64")),
      decipher.final()
    ]);
    const parsed = JSON.parse(decrypted.toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  }

  private toPublic(record: LogStreamDestinationRecord, mask: boolean): LogStreamDestinationPublic {
    let config: Record<string, unknown> = {};
    try {
      config = this.decryptConfig(record);
    } catch {
      config = {};
    }
    if (mask) {
      const secretFields = SECRET_FIELDS_BY_TYPE[record.type] ?? [];
      for (const field of secretFields) {
        if (config[field] !== undefined) config[field] = SECRET_PLACEHOLDER;
      }
    }
    return {
      id: record.id,
      name: record.name,
      type: record.type,
      enabled: record.enabled,
      categories: record.categories,
      minLevel: record.minLevel,
      config,
      lastSuccessAt: record.lastSuccessAt,
      lastErrorAt: record.lastErrorAt,
      lastError: record.lastError,
      dispatchedCount: record.dispatchedCount,
      failedCount: record.failedCount,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
  }
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

function levelToSyslogSeverity(level: LogLevel): number {
  switch (level) {
    case "debug":
      return 7;
    case "info":
      return 6;
    case "warn":
      return 4;
    case "error":
      return 3;
    default:
      return 6;
  }
}

function formatSyslogMessage(event: LogStreamEvent, config: SyslogConfig): string {
  const facility = typeof config.facility === "number" ? config.facility : 16; // local0
  const severity = levelToSyslogSeverity(event.level);
  const pri = facility * 8 + severity;
  const hostname = (config.hostname ?? "ai-orchestrator").replace(/\s/g, "-");
  const appName = (config.appName ?? "ai-orchestrator").replace(/\s/g, "-");
  const procId = "-";
  const msgId = event.eventType.replace(/\s/g, "-") || "-";
  const structured = "-";
  const payload = JSON.stringify({
    category: event.category,
    eventType: event.eventType,
    level: event.level,
    outcome: event.outcome ?? null,
    message: event.message ?? null,
    actor: event.actor ?? null,
    resourceType: event.resourceType ?? null,
    resourceId: event.resourceId ?? null,
    projectId: event.projectId ?? null,
    metadata: event.metadata ?? null
  });
  return `<${pri}>1 ${event.createdAt} ${hostname} ${appName} ${procId} ${msgId} ${structured} ${payload}`;
}

const syslogAdapter: LogStreamAdapter = {
  type: "syslog",
  async send(event, rawConfig) {
    const config = rawConfig as unknown as SyslogConfig;
    const message = formatSyslogMessage(event, config);
    const transport = config.transport === "tcp" ? "tcp" : "udp";
    if (transport === "udp") {
      await new Promise<void>((resolve, reject) => {
        const socket = dgram.createSocket("udp4");
        const buf = Buffer.from(message, "utf8");
        socket.send(buf, 0, buf.length, config.port, config.host, (err) => {
          socket.close();
          if (err) reject(err);
          else resolve();
        });
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: config.host, port: config.port }, () => {
          socket.write(`${message}\n`, (err) => {
            socket.end();
            if (err) reject(err);
            else resolve();
          });
        });
        socket.on("error", reject);
        socket.setTimeout(5000, () => {
          socket.destroy(new Error("syslog tcp timeout"));
        });
      });
    }
  }
};

const webhookAdapter: LogStreamAdapter = {
  type: "webhook",
  async send(event, rawConfig) {
    const config = rawConfig as unknown as WebhookConfig;
    const body = JSON.stringify({
      category: event.category,
      eventType: event.eventType,
      level: event.level,
      outcome: event.outcome ?? null,
      message: event.message ?? null,
      actor: event.actor ?? null,
      resourceType: event.resourceType ?? null,
      resourceId: event.resourceId ?? null,
      projectId: event.projectId ?? null,
      metadata: event.metadata ?? null,
      createdAt: event.createdAt
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "ai-orchestrator-log-stream/1.0"
    };
    if (config.headers) {
      for (const [k, v] of Object.entries(config.headers)) headers[k.toLowerCase()] = v;
    }
    if (config.hmacSecret) {
      const sig = crypto.createHmac("sha256", config.hmacSecret).update(body).digest("hex");
      const header = config.hmacHeader ?? "x-ao-signature";
      headers[header.toLowerCase()] = `sha256=${sig}`;
    }
    const method = config.method ?? "POST";
    const response = await fetch(config.url, { method, headers, body });
    if (!response.ok) {
      throw new Error(`webhook responded ${response.status}`);
    }
  }
};

interface ParsedSentryDsn {
  publicKey: string;
  projectId: string;
  storeUrl: string;
}

function parseSentryDsn(dsn: string): ParsedSentryDsn {
  const match = dsn.match(/^https?:\/\/([^@]+)@([^/]+)\/(.+)$/);
  if (!match) throw new Error("invalid Sentry DSN");
  const [, publicKey, host, projectId] = match;
  const protocol = dsn.startsWith("https") ? "https" : "http";
  const storeUrl = `${protocol}://${host}/api/${projectId}/store/`;
  return { publicKey, projectId, storeUrl };
}

const sentryAdapter: LogStreamAdapter = {
  type: "sentry",
  async send(event, rawConfig) {
    const config = rawConfig as unknown as SentryConfig;
    const parsed = parseSentryDsn(config.dsn);
    const sentryLevel = event.level === "warn" ? "warning" : event.level;
    const payload = {
      event_id: crypto.randomBytes(16).toString("hex"),
      timestamp: event.createdAt,
      level: sentryLevel,
      logger: "ai-orchestrator",
      platform: "node",
      environment: config.environment ?? "production",
      release: config.release,
      message: event.message ?? `${event.category}.${event.eventType}`,
      tags: {
        category: event.category,
        event_type: event.eventType,
        outcome: event.outcome ?? "success",
        resource_type: event.resourceType ?? "none"
      },
      extra: {
        actor: event.actor ?? null,
        resourceId: event.resourceId,
        projectId: event.projectId,
        metadata: event.metadata ?? null
      }
    };
    const auth = [
      "Sentry sentry_version=7",
      `sentry_client=ai-orchestrator/1.0`,
      `sentry_timestamp=${Math.floor(Date.now() / 1000)}`,
      `sentry_key=${parsed.publicKey}`
    ].join(", ");
    const response = await fetch(parsed.storeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sentry-auth": auth
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new Error(`sentry responded ${response.status}`);
    }
  }
};
