/**
 * Phase 8.4 — AuditExportService.
 *
 * Bulk export of audit_logs to long-term sinks (SIEM, archive, ECC). Two
 * delivery kinds today:
 *   - `http`  — POST application/x-ndjson body to a URL. The simplest
 *               integration with Splunk HEC, Datadog Logs, Logstash, etc.
 *               Optional `headers` for auth (Bearer tokens, HEC tokens).
 *   - `file`  — append NDJSON to a path on the API container's local FS.
 *               Useful when paired with Filebeat / Vector picking the path
 *               up. Path must live under `/app/apps/api/data/` to keep
 *               container-local writes contained.
 *
 * Cursor-based: each destination remembers `last_export_id`; the next run
 * resumes after that row. `audit_export_runs` records each run for
 * observability; failures are retried on the next interval tick (no
 * exponential backoff yet — destinations don't tend to need it).
 *
 * Hash-chain integrity is preserved end-to-end: each NDJSON record carries
 * `entry_hash` so downstream consumers can re-verify the chain.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import type { Store } from "../db/store.js";

interface AuditExportDestinationConfig {
  /** http kind */
  url?: string;
  /** http kind: extra headers (auth, tenancy). */
  headers?: Record<string, string>;
  /** http kind: HTTP method (default POST). */
  method?: string;
  /** file kind */
  path?: string;
}

/**
 * Phase 13.1 — cluster mode: runs one destination's export under a cluster-wide lock keyed by the destination, so two
 * instances never read the same cursor and ship the same rows. Resolves `{ acquired: false }` when another instance
 * still holds it after `waitMs`.
 */
export type AuditExportLock = <T>(destinationId: string, waitMs: number, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }>;

/** Another instance is exporting this destination right now. */
export class AuditExportBusyError extends Error {
  constructor(destinationId: string) {
    super(`Another instance is exporting audit destination ${destinationId}; try again shortly.`);
    this.name = "AuditExportBusyError";
  }
}

/** How long "Export now" waits for another instance's export of the same destination. */
export const AUDIT_EXPORT_NOW_LOCK_WAIT_MS = 10_000;

interface ExportRunOutcome {
  status: "success" | "failure" | "partial";
  rowsExported: number;
  firstId: string | null;
  lastId: string | null;
  error: string | null;
}

export class AuditExportService {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = new Set<string>();
  private readonly store: Store;
  private readonly checkIntervalMs: number;
  private readonly batchSize: number;
  private readonly safeFsRoot: string;
  private readonly lock: AuditExportLock | undefined;
  private logger?: { info: (msg: string, fields?: Record<string, unknown>) => void; warn: (msg: string, fields?: Record<string, unknown>) => void };

  constructor(store: Store, options: { checkIntervalMs?: number; batchSize?: number; safeFsRoot?: string; lock?: AuditExportLock } = {}) {
    this.store = store;
    this.lock = options.lock;
    this.checkIntervalMs = options.checkIntervalMs ?? 60_000;
    this.batchSize = options.batchSize ?? 500;
    this.safeFsRoot = path.resolve(options.safeFsRoot ?? "apps/api/data");
  }

  setLogger(logger: { info: (msg: string, fields?: Record<string, unknown>) => void; warn: (msg: string, fields?: Record<string, unknown>) => void }): void {
    this.logger = logger;
  }

  /** Whether the periodic export runs here (cluster mode starts it only on the leader). */
  isRunning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.checkIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Iterate enabled destinations and run any whose interval has elapsed since
   * the last successful export. Concurrent invocations of the same
   * destination are guarded by `inFlight`.
   */
  async tick(): Promise<void> {
    const dests = (await this.store.listAuditExportDestinations()).filter((d) => d.enabled);
    const now = Date.now();
    for (const dest of dests) {
      if (this.inFlight.has(dest.id)) continue;
      const lastMs = dest.lastExportAt ? Date.parse(dest.lastExportAt) : 0;
      if (now - lastMs < dest.intervalSeconds * 1000) continue;
      this.inFlight.add(dest.id);
      try {
        // Another instance exporting this destination now: its batch moves the cursor; this tick skips it.
        await this.runDestination(dest.id, { waitMs: 0 });
      } catch (err) {
        if (err instanceof AuditExportBusyError) continue;
        this.logger?.warn("Audit export tick failed", {
          destinationId: dest.id,
          error: err instanceof Error ? err.message : String(err)
        });
      } finally {
        this.inFlight.delete(dest.id);
      }
    }
  }

  /**
   * Synchronously run one destination — exposed so admin "Export now"
   * endpoint can drive a destination on demand.
   */
  async runDestination(id: string, options: { waitMs?: number } = {}): Promise<ExportRunOutcome> {
    if (!this.lock) return await this.exportBatch(id);
    const outcome = await this.lock(id, options.waitMs ?? AUDIT_EXPORT_NOW_LOCK_WAIT_MS, async () => await this.exportBatch(id));
    if (!outcome.acquired) throw new AuditExportBusyError(id);
    return outcome.value;
  }

  /** Reads the batch after the destination's cursor, delivers it and records the run (which moves the cursor). */
  private async exportBatch(id: string): Promise<ExportRunOutcome> {
    const dest = await this.store.getAuditExportDestination(id);
    if (!dest) throw new Error(`Audit export destination not found: ${id}`);
    const runId = `aex_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const rows = await this.store.listAuditLogsAfter({ afterId: dest.lastExportId, limit: this.batchSize });
    if (rows.length === 0) {
      const completedAt = new Date().toISOString();
      await this.store.recordAuditExportRun({
        id: runId,
        destinationId: id,
        startedAt,
        completedAt,
        status: "success",
        rowsExported: 0
      });
      return { status: "success", rowsExported: 0, firstId: null, lastId: null, error: null };
    }
    const ndjson = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    let outcome: ExportRunOutcome;
    try {
      if (dest.kind === "http") {
        await this.deliverHttp(dest.config as AuditExportDestinationConfig, ndjson);
      } else if (dest.kind === "file") {
        await this.deliverFile(dest.config as AuditExportDestinationConfig, ndjson);
      } else {
        throw new Error(`Unknown destination kind: ${dest.kind}`);
      }
      outcome = {
        status: "success",
        rowsExported: rows.length,
        firstId: rows[0]!.id,
        lastId: rows[rows.length - 1]!.id,
        error: null
      };
      this.logger?.info("Audit export delivered", {
        destinationId: id,
        rowsExported: rows.length,
        firstId: outcome.firstId,
        lastId: outcome.lastId
      });
    } catch (err) {
      outcome = {
        status: "failure",
        rowsExported: 0,
        firstId: rows[0]!.id,
        lastId: rows[rows.length - 1]!.id,
        error: err instanceof Error ? err.message : String(err)
      };
      this.logger?.warn("Audit export delivery failed", {
        destinationId: id,
        error: outcome.error,
        rowsConsidered: rows.length
      });
    }
    await this.store.recordAuditExportRun({
      id: runId,
      destinationId: id,
      startedAt,
      completedAt: new Date().toISOString(),
      status: outcome.status,
      rowsExported: outcome.rowsExported,
      firstId: outcome.firstId,
      lastId: outcome.lastId,
      error: outcome.error
    });
    return outcome;
  }

  private async deliverHttp(config: AuditExportDestinationConfig, ndjson: string): Promise<void> {
    if (!config.url) throw new Error("http destination missing config.url");
    const res = await fetch(config.url, {
      method: config.method ?? "POST",
      headers: { "content-type": "application/x-ndjson", ...(config.headers ?? {}) },
      body: ndjson
    });
    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  private async deliverFile(config: AuditExportDestinationConfig, ndjson: string): Promise<void> {
    if (!config.path) throw new Error("file destination missing config.path");
    const target = path.resolve(config.path);
    if (!target.startsWith(this.safeFsRoot)) {
      throw new Error(
        `file destination path must live under ${this.safeFsRoot} (got ${target}); ` +
          "this is a sandbox to prevent writes outside the data dir"
      );
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.appendFile(target, ndjson, "utf8");
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
