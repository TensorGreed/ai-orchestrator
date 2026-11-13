/**
 * Phase 8.4 — AuditExportService.
 *
 * Bulk export of audit_logs to long-term sinks (SIEM, archive, ECC). Two
 * delivery kinds today:
 *   - `http`  — POST application/x-ndjson body to a URL. The simplest
 *               integration with Splunk HEC, Datadog Logs, Logstash, etc.
 *               Optional `headers` for auth (Bearer tokens, HEC tokens),
 *               stored sealed with the master key (`headersSealed`, see
 *               AUDIT_EXPORT_HEADERS_PURPOSE) and shown masked.
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
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type { Store } from "../db/store.js";
import type { SecretService } from "./secret-service.js";

interface AuditExportDestinationConfig {
  /** http kind */
  url?: string;
  /** http kind: extra headers (auth, tenancy), as stored by releases before they were sealed (sealStoredHeaders). */
  headers?: Record<string, string>;
  /** http kind: the extra headers as JSON, sealed with the master key (purpose AUDIT_EXPORT_HEADERS_PURPOSE). */
  headersSealed?: string;
  /** http kind: HTTP method (default POST). */
  method?: string;
  /** file kind */
  path?: string;
}

/** The SecretService purpose the header values are sealed with (db-shared.ts JSON_SEALED_FIELDS re-seals it). */
export const AUDIT_EXPORT_HEADERS_PURPOSE = "audit-export-headers";

/** What a header value reads as in an API answer; sending it back on an update keeps the stored value. */
export const AUDIT_EXPORT_SECRET_PLACEHOLDER = "__secret__";

/** SecretService's sealing with the master key (the purpose bound as authenticated data). */
export type AuditExportSealer = Pick<SecretService, "sealValue" | "openValue">;

type StoredDestination = NonNullable<Awaited<ReturnType<Store["getAuditExportDestination"]>>>;

/** A destination as the API returns it: header values masked, never the sealed blob. */
export type AuditExportDestinationView = StoredDestination;

/** A bad destination config or path (the routes answer 400). */
export class AuditExportConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditExportConfigError";
  }
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

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
  private readonly sealer: AuditExportSealer | undefined;
  private logger?: { info: (msg: string, fields?: Record<string, unknown>) => void; warn: (msg: string, fields?: Record<string, unknown>) => void };

  constructor(
    store: Store,
    options: { checkIntervalMs?: number; batchSize?: number; safeFsRoot?: string; lock?: AuditExportLock; sealer?: AuditExportSealer } = {}
  ) {
    this.store = store;
    this.lock = options.lock;
    this.sealer = options.sealer;
    this.checkIntervalMs = options.checkIntervalMs ?? 60_000;
    this.batchSize = options.batchSize ?? 500;
    this.safeFsRoot = path.resolve(options.safeFsRoot ?? "apps/api/data");
  }

  setLogger(logger: { info: (msg: string, fields?: Record<string, unknown>) => void; warn: (msg: string, fields?: Record<string, unknown>) => void }): void {
    this.logger = logger;
  }

  // ---------------------------------------------------------------------------
  // Destinations as the API sees them: header values sealed at rest, masked on read
  // ---------------------------------------------------------------------------

  async listDestinations(): Promise<AuditExportDestinationView[]> {
    return (await this.store.listAuditExportDestinations()).map((dest) => this.toView(dest));
  }

  async getDestination(id: string): Promise<AuditExportDestinationView | null> {
    const dest = await this.store.getAuditExportDestination(id);
    return dest ? this.toView(dest) : null;
  }

  async createDestination(input: {
    id: string;
    name: string;
    kind: "http" | "file";
    config: Record<string, unknown>;
    intervalSeconds?: number;
    enabled?: boolean;
    createdBy?: string | null;
  }): Promise<AuditExportDestinationView> {
    const config = this.storedConfig(input.kind, input.config, {});
    await this.store.createAuditExportDestination({ ...input, config });
    const created = await this.getDestination(input.id);
    if (!created) throw new Error("failed to create audit export destination");
    return created;
  }

  /**
   * Replaces the config when `patch.config` is given. A header whose value is AUDIT_EXPORT_SECRET_PLACEHOLDER keeps
   * the stored value of the header of the same name.
   */
  async updateDestination(
    id: string,
    patch: { name?: string; config?: Record<string, unknown>; intervalSeconds?: number; enabled?: boolean }
  ): Promise<AuditExportDestinationView | null> {
    const existing = await this.store.getAuditExportDestination(id);
    if (!existing) return null;
    const next: typeof patch = {};
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.intervalSeconds !== undefined) next.intervalSeconds = patch.intervalSeconds;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.config !== undefined) {
      next.config = this.storedConfig(existing.kind, patch.config, this.headersOf(existing.config as AuditExportDestinationConfig));
    }
    await this.store.updateAuditExportDestination(id, next);
    return await this.getDestination(id);
  }

  /**
   * Seals the header values of destinations written before they were sealed (stored as plain `headers`). Run once at
   * start-up; idempotent, and each row is rewritten only with its own values. Returns how many rows it sealed.
   */
  async sealStoredHeaders(): Promise<number> {
    if (!this.sealer) return 0;
    let sealed = 0;
    for (const dest of await this.store.listAuditExportDestinations()) {
      const config = dest.config as AuditExportDestinationConfig;
      if (config.headers === undefined) continue;
      const { headers, ...rest } = config;
      const plain = isStringRecord(headers) ? headers : {};
      // A row that already has sealed headers keeps them; the plain copy is dropped either way.
      const merged = config.headersSealed ? this.headersOf(config) : plain;
      await this.store.updateAuditExportDestination(dest.id, { config: { ...rest, ...this.sealHeaders(merged) } });
      sealed += 1;
    }
    if (sealed > 0) this.logger?.info("Sealed audit export destination headers stored in plain text", { destinations: sealed });
    return sealed;
  }

  /** The config to store: validated, headers sealed (a placeholder keeps `previous`'s value of that header). */
  private storedConfig(kind: string, input: Record<string, unknown>, previous: Record<string, string>): Record<string, unknown> {
    const { headers: rawHeaders, headersSealed: _ignored, ...rest } = input as AuditExportDestinationConfig & Record<string, unknown>;
    if (kind === "http") {
      if (typeof rest.url !== "string" || !/^https?:\/\//i.test(rest.url)) throw new AuditExportConfigError("http destination requires an http(s) config.url");
      if (rest.method !== undefined && (typeof rest.method !== "string" || !/^[A-Z]+$/.test(rest.method))) {
        throw new AuditExportConfigError("config.method must be an HTTP method such as POST");
      }
    } else if (kind === "file") {
      if (typeof rest.path !== "string" || !rest.path) throw new AuditExportConfigError("file destination requires config.path");
      if (rawHeaders !== undefined) throw new AuditExportConfigError("file destination takes no headers");
      this.lexicalTarget(rest.path);
      return rest;
    }
    if (rawHeaders === undefined) return rest;
    if (!rawHeaders || typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) throw new AuditExportConfigError("config.headers must be an object of strings");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (!HEADER_NAME.test(name)) throw new AuditExportConfigError(`config.headers: "${name}" is not a valid header name`);
      if (typeof value !== "string") throw new AuditExportConfigError(`config.headers.${name} must be a string`);
      if (value === AUDIT_EXPORT_SECRET_PLACEHOLDER) {
        const kept = Object.entries(previous).find(([key]) => key.toLowerCase() === name.toLowerCase());
        if (!kept) throw new AuditExportConfigError(`config.headers.${name}: no stored value to keep; send the value`);
        headers[name] = kept[1];
      } else {
        if (/[\r\n\0]/.test(value)) throw new AuditExportConfigError(`config.headers.${name} must not contain line breaks`);
        headers[name] = value;
      }
    }
    return { ...rest, ...this.sealHeaders(headers) };
  }

  private sealHeaders(headers: Record<string, string>): { headersSealed?: string } {
    if (Object.keys(headers).length === 0) return {};
    if (!this.sealer) throw new AuditExportConfigError("Header values need the master key (SECRET_MASTER_KEY_BASE64) to be stored");
    return { headersSealed: this.sealer.sealValue(AUDIT_EXPORT_HEADERS_PURPOSE, JSON.stringify(headers)) };
  }

  /** The stored header values (sealed, or plain from before they were sealed). */
  private headersOf(config: AuditExportDestinationConfig): Record<string, string> {
    if (typeof config.headersSealed === "string" && config.headersSealed) {
      if (!this.sealer) throw new Error("audit export destination headers are sealed; the master key is needed to open them");
      const parsed: unknown = JSON.parse(this.sealer.openValue(AUDIT_EXPORT_HEADERS_PURPOSE, config.headersSealed));
      return isStringRecord(parsed) ? parsed : {};
    }
    return isStringRecord(config.headers) ? config.headers : {};
  }

  private toView(dest: StoredDestination): AuditExportDestinationView {
    const { headers: _plain, headersSealed: _sealed, ...rest } = dest.config as AuditExportDestinationConfig & Record<string, unknown>;
    let names: string[];
    try {
      names = Object.keys(this.headersOf(dest.config as AuditExportDestinationConfig));
    } catch {
      // Sealed under another key: the names cannot be shown either.
      return { ...dest, config: { ...rest, headersUnreadable: true } };
    }
    const config = names.length > 0 ? { ...rest, headers: Object.fromEntries(names.map((name) => [name, AUDIT_EXPORT_SECRET_PLACEHOLDER])) } : rest;
    return { ...dest, config };
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
      error: outcome.error,
      // Phase 13.1 — cluster mode: the cursor moves only from the value read under the lock. If the lock was lost with
      // its connection and another instance shipped meanwhile, this record fails loudly instead of moving it back.
      ...(this.lock ? { cursorFrom: dest.lastExportId } : {})
    });
    return outcome;
  }

  private async deliverHttp(config: AuditExportDestinationConfig, ndjson: string): Promise<void> {
    if (!config.url) throw new Error("http destination missing config.url");
    const res = await fetch(config.url, {
      method: config.method ?? "POST",
      headers: { "content-type": "application/x-ndjson", ...this.headersOf(config) },
      body: ndjson
    });
    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  /**
   * Appends under the root only: the path must resolve inside it (a sibling such as `<root>-x` is outside), every
   * directory on the way must stay inside it once symlinks are resolved, and the file itself must not be a symlink
   * (opened with O_NOFOLLOW where the platform has it).
   */
  private async deliverFile(config: AuditExportDestinationConfig, ndjson: string): Promise<void> {
    if (!config.path) throw new Error("file destination missing config.path");
    const target = this.lexicalTarget(config.path);
    await fs.mkdir(this.safeFsRoot, { recursive: true });
    const realRoot = await fs.realpath(this.safeFsRoot);
    // The deepest directory that exists must already be inside the root before anything is created under it.
    let existing = path.dirname(target);
    for (;;) {
      try {
        await fs.stat(existing);
        break;
      } catch {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        existing = parent;
      }
    }
    this.assertInside(realRoot, await fs.realpath(existing), config.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const realDir = await fs.realpath(path.dirname(target));
    this.assertInside(realRoot, realDir, config.path);
    const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(path.join(realDir, path.basename(target)), flags, 0o640);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`file destination path ${config.path} is a symlink; refusing to follow it`);
      throw err;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`file destination path ${config.path} is not a regular file`);
      await handle.appendFile(ndjson, "utf8");
    } finally {
      await handle.close();
    }
  }

  /** `configured` resolved, and inside the root by path (no symlinks resolved yet); throws otherwise. */
  private lexicalTarget(configured: string): string {
    const target = path.resolve(configured);
    if (!isInside(this.safeFsRoot, target)) {
      throw new AuditExportConfigError(
        `file destination path must live under ${this.safeFsRoot} (got ${target}); ` +
          "this is a sandbox to prevent writes outside the data dir"
      );
    }
    return target;
  }

  private assertInside(realRoot: string, realPath: string, configured: string): void {
    if (realPath !== realRoot && !isInside(realRoot, realPath)) {
      throw new Error(`file destination path ${configured} leaves ${this.safeFsRoot} through a symlink; refusing to write there`);
    }
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * What the audit log keeps about a destination config: its kind-neutral shape, never a value. A header value can be
 * an ingestion token, and a URL can carry a credential (user info or a query token).
 */
export function auditExportConfigSummary(config: Record<string, unknown>): Record<string, unknown> {
  const headers = config.headers && typeof config.headers === "object" && !Array.isArray(config.headers) ? Object.keys(config.headers).sort() : undefined;
  let urlHost: string | undefined;
  if (typeof config.url === "string") {
    try {
      urlHost = new URL(config.url).host;
    } catch {
      urlHost = undefined;
    }
  }
  return {
    configKeys: Object.keys(config).filter((key) => key !== "headersSealed").sort(),
    ...(urlHost ? { urlHost } : {}),
    ...(headers ? { headerNames: headers } : {})
  };
}

/** Whether `child` is strictly inside `parent` (both absolute and resolved): never `parent` itself or a sibling. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.values(value as object).every((item) => typeof item === "string");
}
