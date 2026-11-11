/**
 * 13.3 — data-subject requests: subject references, the lookup behind a request, and the export it produces.
 *
 * Subject references. A workflow may name up to three values of a run as the person it is about
 * (`settings.dataProtection.subjectRefs`). When a run's final history is stored, each value is normalised (trimmed,
 * case-folded; a phone number reduced to its digits) and stored as HMAC-SHA256 under the subject key, never as the
 * value. A workflow that lists `{{session_id}}` also references the agent memory sessions its memory nodes keep for
 * that session. Resolving a reference never fails a run: a value that is missing or not text is skipped.
 *
 * The subject key is 32 random bytes made on first use and stored sealed with the master key (purpose `subject-ref`).
 * db:import --source-master-key re-seals it, so references keep matching after a master-key change.
 *
 * A request. An admin gives the person's value once. The request stores its keyed hash; the value itself is kept only
 * sealed, and only while the lookup runs. The lookup:
 *   1. reads what subject references point at (an indexed lookup);
 *   2. unless the admin turned it off, reads every stored run, paused run, approval request, agent memory session and
 *      artifact, cassette, golden run, golden-set case and eval result, matching the value the way the data-subject
 *      lookup does (raw, and as its capture surrogate). Possible matches (a phone without its country code on one side)
 *      are left out of the export and counted;
 *   3. builds a zip: manifest.json (what was searched and what was not), one JSON-lines file per kind, and for a staff
 *      member their identity and authored rows (staff.json). The zip is sealed with the master key and can be
 *      downloaded once, until SUBJECT_EXPORT_TTL_HOURS pass.
 * The lookup runs on the leader under the `subject-requests` lease, a page at a time, and records where it is after
 * every page, so a restart resumes it. A request past its due date sends `data.subject_request_due` once.
 */
import crypto from "node:crypto";
import { deflateRawSync } from "node:zlib";
import {
  SUBJECT_REQUEST_MAX_ROWS,
  SUBJECT_ROW_KINDS,
  subjectRefPath,
  writeZip,
  type ReplayFindSubjectMatch,
  type ReplayFindSubjectQuery,
  type SubjectKind,
  type SubjectRequestCreateInput,
  type SubjectRequestProgress,
  type SubjectRequestStatus,
  type SubjectRequestView,
  type SubjectRefPreviewView,
  type SubjectRowKind,
  type Workflow
} from "@ai-orchestrator/shared";
import type { SubjectStoreKind, SubjectTextRow } from "../db/database.js";
import type { Store } from "../db/store.js";
import {
  SUBJECT_SCAN_KINDS,
  memorySessionRowId,
  parseMemorySessionRowId,
  type SubjectRefWrite,
  type SubjectRequestRecord,
  type SubjectScanKind
} from "../db/subject-store.js";
import { yieldToEventLoop } from "../db/retention-tables.js";
import type { AuditEventInput } from "./audit-service.js";
import type { NotificationEvent } from "./notification-service.js";
import type { SecretService } from "./secret-service.js";

/** The purposes values are sealed with (scripts/db-shared.ts SEALED_COLUMNS lists the first two). */
export const SUBJECT_KEY_PURPOSE = "subject-ref";
export const REQUEST_VALUE_PURPOSE = "subject-request-value";
export const SUBJECT_EXPORT_PURPOSE = "subject-export";

/** The lease one instance holds while it works on requests. */
export const SUBJECT_REQUEST_LEASE = "subject-requests";
/** Rows read per scan page. */
export const SUBJECT_SCAN_PAGE = 50;
export const SUBJECT_REQUEST_DUE_EVENT = "data.subject_request_due";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_SWEEP_MS = 10 * 60_000;
const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
const ORPHAN_REFS_PER_SWEEP = 5_000;
/** Errors in a row before a request fails (a passing page resets the count). */
export const SUBJECT_REQUEST_MAX_ERRORS = 3;
/** Times an export is started before the request fails (a crash while building it cannot loop). */
export const SUBJECT_EXPORT_MAX_ATTEMPTS = 3;
/** Found entries an export reads between lease renewals. */
const EXPORT_RENEW_EVERY = 25;
/** Default byte budget of an export's rows (SUBJECT_EXPORT_MAX_BYTES). */
export const SUBJECT_EXPORT_DEFAULT_MAX_BYTES = 209_715_200;
const MAX_ERROR_LENGTH = 500;

/** The data-subject lookup's own kinds (paged by the store's subjectTextPage), then the request-only kinds. */
const LOOKUP_KINDS: readonly SubjectStoreKind[] = ["recording", "fixture", "eval_result", "execution", "cassette"];
type SourceKind = SubjectStoreKind | SubjectScanKind;
const SCAN_ORDER: readonly SourceKind[] = [...LOOKUP_KINDS, ...SUBJECT_SCAN_KINDS];

const ROW_KIND_OF: Record<SourceKind, SubjectRowKind> = {
  recording: "golden_run",
  fixture: "golden_set_case",
  eval_result: "eval_result",
  execution: "run",
  cassette: "cassette",
  production_execution: "run",
  paused_run: "paused_run",
  approval: "approval",
  memory_session: "memory_session",
  memory_artifact: "memory_artifact",
  cassette_any: "cassette"
};

/** What the lookup never reads; the manifest and the docs list it. */
export const SUBJECT_EXPORT_NOT_COVERED = [
  "Logs, metrics, traces and log-streaming destinations (outside the database)",
  "The audit log (security logging; a staff export lists the person's own entries)",
  "Tool-call telemetry (argument summaries) and rule events (masked evidence only)",
  "Usage and cost events",
  "Knowledge bases (ingested documents)",
  "Backups already written, model providers and MCP servers (outside this deployment)"
];

/** One row a request found: its kind, id, where it is stored, and how it was found. */
interface FoundRow {
  k: SubjectRowKind;
  id: string;
  /** Source: a store kind, or `memory_ref` (a memory session found by reference: the session and its artifacts). */
  s: SourceKind | "memory_ref";
  /** Found by a subject reference (`r`) or by the search (`s`). */
  by: "r" | "s";
}

/** The lookup's state, stored in `progress_json` after every page. */
interface LookupState {
  phase: SubjectRequestProgress["phase"];
  kindIndex: number;
  cursor: string | null;
  rowsSearched: number;
  possible: number;
  truncated: boolean;
  /** Why the export holds fewer rows than were found: the row limit, or the byte budget. */
  truncatedBy?: "rows" | "bytes";
  found: FoundRow[];
  classesTried?: string[];
  /** Errors in a row (reset by a passing page). */
  errors: number;
  /** Times the export was started. */
  exportAttempts: number;
}

/** Sealing with the master key (SecretService). */
export type SubjectSecrets = Pick<SecretService, "sealValue" | "openValue">;

export interface SubjectRequestServiceOptions {
  store: Store;
  secrets: SubjectSecrets;
  /** The data-subject lookup's matching for one value (ReplayCaptureService.subjectMatcher). */
  matcher: (query: ReplayFindSubjectQuery) => Promise<{ classesTried: string[]; match: (row: SubjectTextRow) => ReplayFindSubjectMatch | null }>;
  /** A reversible token's original value, or null (the token vault). */
  revealToken?: (token: string) => Promise<string | null>;
  instanceId: string;
  isLeader: () => boolean;
  dueDays: number;
  exportTtlHours: number;
  /** Most bytes of rows in one export (uncompressed); more are left out and the manifest says so. */
  exportMaxBytes?: number;
  audit?: (event: AuditEventInput) => Promise<unknown>;
  notify?: (event: NotificationEvent) => Promise<void>;
  logger?: { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void };
  redact?: (text: string) => string;
  now?: () => Date;
  pollMs?: number;
  sweepMs?: number;
  leaseTtlMs?: number;
}

export class SubjectRequestError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "not_found" | "unavailable" | "conflict"
  ) {
    super(message);
    this.name = "SubjectRequestError";
  }
}

/**
 * The form a value is hashed in: Unicode-normalised, trimmed and case-folded, inner whitespace collapsed; a phone
 * number (digits, separators and an optional leading `+` or `00`) reduced to its digits, `+` kept.
 */
export function normalizeSubjectValue(value: string): string {
  const text = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (/^(?:\+|00)?[\d\s().-]+$/.test(text)) {
    const digits = text.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      if (text.startsWith("+")) return `+${digits}`;
      if (text.startsWith("00")) return `+${digits.slice(2)}`;
      return digits;
    }
  }
  return text.toLowerCase();
}

/** A value as a preview shows it: its first and last character, the rest hidden. */
export function maskSubjectSample(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= 2) return "•".repeat(chars.length);
  return `${chars[0]}${"•".repeat(Math.min(8, chars.length - 2))}${chars[chars.length - 1]}`;
}

/** The value at a subject reference's path in a run's context, as text; null when missing or not a scalar. */
export function resolveSubjectRef(context: Record<string, unknown>, expression: string): string | null {
  const path = subjectRefPath(expression);
  if (!path) return null;
  let current: unknown = context;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === "string") return current.trim() ? current : null;
  if (typeof current === "number" && Number.isFinite(current)) return String(current);
  if (typeof current === "bigint") return current.toString();
  return null;
}

/** What a run offers its subject references. */
export interface SubjectRunContext {
  input?: unknown;
  output?: unknown;
  customData?: unknown;
  sessionId?: string | null;
  triggeredBy?: string | null;
}

export function subjectContextOf(run: SubjectRunContext): Record<string, unknown> {
  return {
    input: run.input ?? null,
    output: run.output ?? null,
    customData: run.customData ?? null,
    session_id: run.sessionId ?? null,
    triggeredBy: run.triggeredBy ?? null
  };
}

/** The session id of a run's input (`session_id` or `sessionId`), or of its custom data. */
export function runSessionId(input: unknown, customData?: unknown): string | null {
  for (const source of [input, customData]) {
    if (source && typeof source === "object" && !Array.isArray(source)) {
      const record = source as Record<string, unknown>;
      for (const key of ["session_id", "sessionId"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  }
  return null;
}

const SESSION_TEMPLATE = /^\{\{\s*session_id\s*\}\}$/;
const MEMORY_NODE_TYPES = new Set(["local_memory", "session_artifact_load", "session_artifact_save"]);

/**
 * The memory namespaces a workflow keeps per session id: its Simple Memory and session artifact nodes whose session
 * id is the run's (`{{session_id}}`, the default) and whose namespace is fixed (the default `<workflow>:<node>`, or a
 * namespace without `{{ }}`). A namespace built from run data cannot be known here and is left to the search.
 */
export function memoryNamespacesOf(workflow: Pick<Workflow, "id" | "nodes">): string[] {
  const namespaces = new Set<string>();
  for (const node of workflow.nodes ?? []) {
    if (!MEMORY_NODE_TYPES.has(node.type)) continue;
    const config = (node.config ?? {}) as Record<string, unknown>;
    const sessionTemplate = typeof config.sessionIdTemplate === "string" && config.sessionIdTemplate.trim() ? config.sessionIdTemplate.trim() : "{{session_id}}";
    if (!SESSION_TEMPLATE.test(sessionTemplate)) continue;
    const namespace = typeof config.namespace === "string" && config.namespace.trim() ? config.namespace.trim() : `${workflow.id}:${node.id}`;
    if (namespace.includes("{{")) continue;
    namespaces.add(namespace);
  }
  return [...namespaces].sort();
}

const TOKEN_PATTERN = /\btok_[a-z][a-z_]*_[A-Za-z0-9_-]{16}(?![A-Za-z0-9_-])/g;

function parseField(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function emptyState(): LookupState {
  return { phase: "references", kindIndex: 0, cursor: null, rowsSearched: 0, possible: 0, truncated: false, found: [], errors: 0, exportAttempts: 0 };
}

function readState(progress: Record<string, unknown>): LookupState {
  const base = emptyState();
  const phase = progress.phase;
  return {
    phase: phase === "scan" || phase === "export" || phase === "finished" ? phase : "references",
    kindIndex: typeof progress.kindIndex === "number" ? progress.kindIndex : base.kindIndex,
    cursor: typeof progress.cursor === "string" ? progress.cursor : null,
    rowsSearched: typeof progress.rowsSearched === "number" ? progress.rowsSearched : 0,
    possible: typeof progress.possible === "number" ? progress.possible : 0,
    truncated: progress.truncated === true,
    ...(progress.truncatedBy === "rows" || progress.truncatedBy === "bytes" ? { truncatedBy: progress.truncatedBy } : {}),
    errors: typeof progress.errors === "number" ? progress.errors : 0,
    exportAttempts: typeof progress.exportAttempts === "number" ? progress.exportAttempts : 0,
    found: Array.isArray(progress.found)
      ? (progress.found as FoundRow[]).filter((row) => row && typeof row.id === "string" && (SUBJECT_ROW_KINDS as readonly string[]).includes(row.k))
      : [],
    ...(Array.isArray(progress.classesTried) ? { classesTried: progress.classesTried.map(String) } : {})
  };
}

function countsOf(found: FoundRow[]): Partial<Record<SubjectRowKind, number>> {
  const counts: Partial<Record<SubjectRowKind, number>> = {};
  for (const row of found) counts[row.k] = (counts[row.k] ?? 0) + 1;
  return counts;
}

export class SubjectRequestService {
  private readonly now: () => Date;
  private key: Buffer | null = null;
  private keyLoading: Promise<Buffer> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private working: Promise<void> | null = null;
  private lastSweepAt = Number.NEGATIVE_INFINITY;
  private stopped = false;

  constructor(private readonly options: SubjectRequestServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------------------
  // The subject key and hashing
  // ---------------------------------------------------------------------------

  /** The subject key, made and stored sealed on first use. */
  async subjectKey(): Promise<Buffer> {
    if (this.key) return this.key;
    if (this.keyLoading === null) {
      this.keyLoading = (async () => {
        const { store, secrets } = this.options;
        const sealed =
          (await store.getSubjectRefKey()) ??
          (await store.initSubjectRefKey(secrets.sealValue(SUBJECT_KEY_PURPOSE, crypto.randomBytes(32).toString("base64")), this.now().toISOString()));
        let opened: string;
        try {
          opened = secrets.openValue(SUBJECT_KEY_PURPOSE, sealed);
        } catch {
          throw new SubjectRequestError(
            "The subject key cannot be opened with the current master key. Restore it with db:import --source-master-key.",
            "unavailable"
          );
        }
        const key = Buffer.from(opened, "base64");
        if (key.length !== 32) throw new SubjectRequestError("The stored subject key is not 32 bytes", "unavailable");
        this.key = key;
        return key;
      })().finally(() => {
        this.keyLoading = null;
      });
    }
    return await this.keyLoading;
  }

  /** The keyed hash a value is stored and looked up by. */
  async hashValue(value: string): Promise<string> {
    const key = await this.subjectKey();
    return crypto.createHmac("sha256", key).update(`subject-ref:v1\u0000${normalizeSubjectValue(value)}`).digest("hex");
  }

  // ---------------------------------------------------------------------------
  // References written with runs
  // ---------------------------------------------------------------------------

  /**
   * Stores the subject references of one finished run. Never throws: a reference that does not resolve is skipped,
   * and a failure is logged without the value.
   */
  async recordRunRefs(input: { executionId: string; workflow: Pick<Workflow, "id" | "nodes" | "settings" | "projectId">; run: SubjectRunContext }): Promise<number> {
    const expressions = input.workflow.settings?.dataProtection?.subjectRefs ?? [];
    if (expressions.length === 0) return 0;
    try {
      const context = subjectContextOf(input.run);
      const createdAt = this.now().toISOString();
      const projectId = input.workflow.projectId ?? null;
      const refs: SubjectRefWrite[] = [];
      for (const expression of expressions) {
        const value = resolveSubjectRef(context, expression);
        if (value === null) continue;
        const hash = await this.hashValue(value);
        refs.push({ hash, kind: "run", rowId: input.executionId, projectId, workflowId: input.workflow.id, createdAt });
        if (subjectRefPath(expression) === "session_id") {
          for (const namespace of memoryNamespacesOf(input.workflow)) {
            refs.push({ hash, kind: "memory_session", rowId: memorySessionRowId(namespace, value.trim()), projectId, workflowId: input.workflow.id, createdAt });
          }
        }
      }
      if (refs.length > 0) await this.options.store.addSubjectRefs(refs);
      return refs.length;
    } catch (error) {
      this.options.logger?.warn({ executionId: input.executionId, workflowId: input.workflow.id, error: this.message(error) }, "Could not store a run's subject references");
      return 0;
    }
  }

  /** How subject reference expressions resolve on a workflow's latest runs (values masked). */
  async previewRefs(input: { workflowId: string; subjectRefs: string[]; runs: Array<SubjectRunContext> }): Promise<SubjectRefPreviewView> {
    return {
      runs: input.runs.length,
      refs: input.subjectRefs.map((expression) => {
        let resolved = 0;
        let sample: string | null = null;
        for (const run of input.runs) {
          const value = resolveSubjectRef(subjectContextOf(run), expression);
          if (value === null) continue;
          resolved += 1;
          sample ??= maskSubjectSample(value.trim());
        }
        return { expression, resolved, sample };
      })
    };
  }

  // ---------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------

  async create(input: SubjectRequestCreateInput, actor: { id: string; email: string }): Promise<SubjectRequestView> {
    const value = input.value.trim();
    if (input.subjectKind === "staff" && !value.includes("@")) {
      throw new SubjectRequestError("A staff member is looked up by their email address.", "invalid");
    }
    // Checks the value can be searched (a short free-text value cannot) before anything is stored.
    if (input.scan) {
      try {
        await this.options.matcher({ value });
      } catch (error) {
        throw new SubjectRequestError(error instanceof Error ? error.message : "The value cannot be searched", "invalid");
      }
    }
    const now = this.now();
    const record: SubjectRequestRecord = {
      id: `dsr_${crypto.randomUUID()}`,
      type: input.type,
      subjectKind: input.subjectKind,
      queryHash: await this.hashValue(value),
      valueSealed: this.options.secrets.sealValue(REQUEST_VALUE_PURPOSE, value),
      scan: input.scan,
      revealTokens: input.revealTokens,
      status: "searching",
      dueAt: new Date(now.getTime() + this.options.dueDays * DAY_MS).toISOString(),
      dueNotifiedAt: null,
      counts: {},
      progress: { ...emptyState() },
      deferred: [],
      createdBy: actor.email,
      createdByUserId: actor.id,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      error: null
    };
    await this.options.store.createSubjectRequest(record);
    this.kick();
    return await this.viewOf(record);
  }

  async list(limit = 100): Promise<SubjectRequestView[]> {
    const records = await this.options.store.listSubjectRequests({ limit });
    return await Promise.all(records.map(async (record) => await this.viewOf(record)));
  }

  async get(id: string): Promise<SubjectRequestView | null> {
    const record = await this.options.store.getSubjectRequest(id);
    return record ? await this.viewOf(record) : null;
  }

  /**
   * The export's one download: the zip, or an error saying why not (not ready, already downloaded, expired). The file
   * is cleared from the database as it is handed out.
   */
  async download(id: string, actor: { email: string }): Promise<{ bytes: Buffer; filename: string; request: SubjectRequestView }> {
    const record = await this.options.store.getSubjectRequest(id);
    if (!record) throw new SubjectRequestError("Request not found", "not_found");
    const at = this.now().toISOString();
    const sealed = await this.options.store.claimSubjectExport({ requestId: id, by: actor.email, at });
    if (sealed === null) {
      const existing = await this.options.store.getSubjectExport(id);
      if (!existing) throw new SubjectRequestError("The export is not ready yet.", "conflict");
      if (existing.downloadedAt) throw new SubjectRequestError("The export was already downloaded; it can be downloaded once. Make a new request.", "conflict");
      throw new SubjectRequestError("The export expired before it was downloaded. Make a new request.", "conflict");
    }
    const bytes = Buffer.from(this.options.secrets.openValue(SUBJECT_EXPORT_PURPOSE, sealed), "base64");
    await this.options.store.updateSubjectRequest(id, { status: "done", updatedAt: at });
    const updated = (await this.options.store.getSubjectRequest(id)) ?? record;
    return { bytes, filename: `subject-export-${id}.zip`, request: await this.viewOf(updated) };
  }

  async viewOf(record: SubjectRequestRecord): Promise<SubjectRequestView> {
    const state = readState(record.progress);
    const exported = record.status === "searching" || record.status === "failed" ? null : await this.options.store.getSubjectExport(record.id);
    const now = this.now();
    const open = record.status === "searching" || record.status === "ready";
    const scanTotal = record.scan ? SCAN_ORDER.length : 0;
    return {
      id: record.id,
      type: record.type,
      subjectKind: record.subjectKind,
      status: record.status,
      scan: record.scan,
      revealTokens: record.revealTokens,
      counts: record.status === "searching" ? countsOf(state.found) : (record.counts as Partial<Record<SubjectRowKind, number>>),
      foundByReference:
        record.status === "searching" ? state.found.filter((row) => row.by === "r").length : Number((record.progress as { foundByReference?: number }).foundByReference ?? 0),
      truncated: state.truncated,
      progress: {
        phase: state.phase,
        kindsDone: state.phase === "references" ? 0 : state.phase === "scan" ? Math.min(state.kindIndex, scanTotal) : scanTotal,
        kindsTotal: scanTotal,
        rowsSearched: state.rowsSearched
      },
      dueAt: record.dueAt,
      overdue: open && Date.parse(record.dueAt) < now.getTime(),
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      error: record.error,
      export: exported
        ? {
            bytes: exported.bytes,
            expiresAt: exported.expiresAt,
            downloadedAt: exported.downloadedAt,
            downloadedBy: exported.downloadedBy,
            available: exported.stored && !exported.downloadedAt && Date.parse(exported.expiresAt) > now.getTime()
          }
        : null
    };
  }

  // ---------------------------------------------------------------------------
  // The background loop (leader only, under the lease)
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => this.kick(), this.options.pollMs ?? DEFAULT_POLL_MS);
    this.timer.unref?.();
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.idle();
  }

  async idle(): Promise<void> {
    await this.working?.catch(() => undefined);
  }

  /** Works on pending requests now, in the background, unless this instance already is. */
  kick(): void {
    if (this.stopped || this.working !== null) return;
    this.working = this.work()
      .catch((error: unknown) => {
        this.options.logger?.warn({ error: this.message(error) }, "Data-subject request work failed");
      })
      .finally(() => {
        this.working = null;
      });
  }

  /** One pass: the sweep when it is due, then every request still searching. Exposed for tests. */
  async work(): Promise<void> {
    if (this.stopped || !this.options.isLeader()) return;
    const { store, instanceId } = this.options;
    const lease = { leaseName: SUBJECT_REQUEST_LEASE, holderId: instanceId, ttlMs: this.options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS };
    if (!(await store.tryAcquireLease(lease))) return;
    try {
      if (this.now().getTime() - this.lastSweepAt >= (this.options.sweepMs ?? DEFAULT_SWEEP_MS)) {
        this.lastSweepAt = this.now().getTime();
        await this.sweep();
      }
      const pending = await store.listSubjectRequests({ limit: 50, statuses: ["searching"] });
      // Oldest first.
      let first = true;
      for (const record of pending.reverse()) {
        if (this.stopped) break;
        // Keeps the lease (and leadership) between requests, not only between scan pages.
        if (!first && !(await this.renew(lease))) break;
        first = false;
        await this.process(record, async () => await this.renew(lease));
      }
    } finally {
      try {
        await store.releaseLease(SUBJECT_REQUEST_LEASE, instanceId);
      } catch {
        // It expires on its own.
      }
    }
  }

  /** Expired exports, orphaned references and overdue requests. */
  async sweep(): Promise<void> {
    const { store } = this.options;
    const now = this.now();
    try {
      for (const requestId of await store.expireSubjectExports(now.toISOString())) {
        await store.updateSubjectRequest(requestId, { status: "expired", updatedAt: now.toISOString() }, "ready");
      }
    } catch (error) {
      this.options.logger?.warn({ error: this.message(error) }, "Could not expire data-subject exports");
    }
    try {
      // A restore leaves exports out: a `ready` request without one can never be downloaded.
      const orphaned = await store.expireReadySubjectRequestsWithoutExport(now.toISOString());
      if (orphaned.length > 0) this.options.logger?.info({ requests: orphaned.length }, "Expired data-subject requests whose export is gone");
    } catch (error) {
      this.options.logger?.warn({ error: this.message(error) }, "Could not expire data-subject requests without an export");
    }
    try {
      const pruned = await store.pruneOrphanSubjectRefs(ORPHAN_REFS_PER_SWEEP);
      if (pruned > 0) this.options.logger?.info({ pruned }, "Removed subject references whose rows are gone");
    } catch (error) {
      this.options.logger?.warn({ error: this.message(error) }, "Could not remove orphaned subject references");
    }
    try {
      for (const record of await store.listOverdueSubjectRequests(now.toISOString(), 500)) {
        const claimed = await store.updateSubjectRequest(record.id, { dueNotifiedAt: now.toISOString(), updatedAt: now.toISOString() }, record.status);
        if (!claimed) continue;
        await this.options.notify?.({
          type: SUBJECT_REQUEST_DUE_EVENT,
          workflowId: "",
          workflowName: "",
          timestamp: now.toISOString(),
          subjectRequest: { requestId: record.id, type: record.type, subjectKind: record.subjectKind, status: record.status, dueAt: record.dueAt }
        });
        await this.options.audit?.({
          category: "data_protection",
          eventType: "data_subject.request_overdue",
          action: "notify",
          actor: { type: "system" },
          resourceType: "subject_request",
          resourceId: record.id,
          metadata: { requestId: record.id, dueAt: record.dueAt, status: record.status }
        });
      }
    } catch (error) {
      this.options.logger?.warn({ error: this.message(error) }, "Could not check overdue data-subject requests");
    }
  }

  /**
   * Runs one request's lookup from where it stopped to its export. Returns early when the lease is lost. An error
   * leaves the request searching until it has failed SUBJECT_REQUEST_MAX_ERRORS times in a row; a value that cannot
   * be opened, or an export started too often, fails it at once.
   */
  private async process(initial: SubjectRequestRecord, renew: () => Promise<boolean>): Promise<void> {
    const { store, secrets } = this.options;
    const state = readState(initial.progress);
    // What is stored: an error writes its count onto this, never a page read halfway.
    let saved: LookupState = structuredClone(state);
    const save = async (): Promise<boolean> => {
      state.errors = 0;
      const ok = await store.updateSubjectRequest(initial.id, { progress: { ...state }, updatedAt: this.now().toISOString() }, "searching");
      if (ok) saved = structuredClone(state);
      return ok;
    };
    let permanent = false;
    try {
      if (!initial.valueSealed) {
        permanent = true;
        throw new Error("The request's value is no longer stored");
      }
      let value: string;
      try {
        value = secrets.openValue(REQUEST_VALUE_PURPOSE, initial.valueSealed);
      } catch {
        permanent = true;
        throw new Error("The request's value cannot be opened with the current master key");
      }
      const seen = new Set(state.found.map((row) => `${row.k}:${row.id}`));
      const add = (row: FoundRow): void => {
        const key = `${row.k}:${row.id}`;
        if (seen.has(key)) return;
        if (state.found.length >= SUBJECT_REQUEST_MAX_ROWS) {
          state.truncated = true;
          state.truncatedBy = "rows";
          return;
        }
        seen.add(key);
        state.found.push(row);
      };

      if (state.phase === "references") {
        const refs = await store.listSubjectRefs(initial.queryHash, SUBJECT_REQUEST_MAX_ROWS + 1);
        for (const ref of refs) {
          if (ref.kind === "run") add({ k: "run", id: ref.rowId, s: "production_execution", by: "r" });
          else add({ k: "memory_session", id: ref.rowId, s: "memory_ref", by: "r" });
        }
        state.phase = initial.scan ? "scan" : "export";
        if (!(await save())) return;
      }

      if (state.phase === "scan") {
        const matcher = await this.options.matcher({ value });
        state.classesTried = matcher.classesTried;
        while (state.kindIndex < SCAN_ORDER.length) {
          if (this.stopped) return;
          const kind = SCAN_ORDER[state.kindIndex]!;
          const page = await this.page(kind, state.cursor);
          for (const row of page.rows) {
            state.rowsSearched += 1;
            const match = matcher.match(row);
            if (!match) continue;
            if (match.certainty !== "exact") {
              state.possible += 1;
              continue;
            }
            add({ k: ROW_KIND_OF[kind], id: row.id, s: kind, by: "s" });
          }
          if (page.next === null || page.rows.length < SUBJECT_SCAN_PAGE) {
            state.kindIndex += 1;
            state.cursor = null;
          } else {
            state.cursor = page.next;
          }
          if (!(await save())) return;
          if (!(await renew())) return;
          await yieldToEventLoop();
        }
        state.phase = "export";
        if (!(await save())) return;
      }

      if (state.phase === "export") {
        if (state.exportAttempts >= SUBJECT_EXPORT_MAX_ATTEMPTS) {
          permanent = true;
          throw new Error(`The export could not be built in ${SUBJECT_EXPORT_MAX_ATTEMPTS} attempts`);
        }
        // Counted before the build, so a crash while building is counted too.
        state.exportAttempts += 1;
        if (!(await save())) return;
        await this.buildExport(initial, value, state, renew);
      }
    } catch (error) {
      const message = this.message(error).slice(0, MAX_ERROR_LENGTH);
      const errors = saved.errors + 1;
      if (!permanent && errors < SUBJECT_REQUEST_MAX_ERRORS) {
        this.options.logger?.warn({ requestId: initial.id, error: message, errors }, "A data-subject request hit an error; it will be retried");
        await store
          .updateSubjectRequest(initial.id, { progress: { ...saved, errors }, updatedAt: this.now().toISOString() }, "searching")
          .catch(() => false);
        return;
      }
      this.options.logger?.warn({ requestId: initial.id, error: message }, "A data-subject request failed");
      const failed = await store.updateSubjectRequest(
        initial.id,
        { status: "failed", valueSealed: null, progress: { ...saved, found: [], errors }, error: message, updatedAt: this.now().toISOString() },
        "searching"
      );
      if (!failed) return;
      await this.options.audit?.({
        category: "data_protection",
        eventType: "data_subject.request_failed",
        action: "export",
        outcome: "failure",
        actor: { type: "system" },
        resourceType: "subject_request",
        resourceId: initial.id,
        metadata: { requestId: initial.id, error: message }
      });
    }
  }

  private async page(kind: SourceKind, cursor: string | null): Promise<{ rows: SubjectTextRow[]; next: string | null }> {
    const { store } = this.options;
    if ((LOOKUP_KINDS as readonly string[]).includes(kind)) {
      const after = cursor === null ? 0 : Number(cursor);
      const page = await store.subjectTextPage(kind as SubjectStoreKind, Number.isFinite(after) ? after : 0, SUBJECT_SCAN_PAGE);
      return { rows: page.rows, next: page.lastRowid === null ? null : String(page.lastRowid) };
    }
    return await store.subjectScanPage(kind as SubjectScanKind, cursor, SUBJECT_SCAN_PAGE);
  }

  /** The rows of one found entry (a memory session found by reference gives the session and its artifacts). */
  private async rowsOf(found: FoundRow): Promise<SubjectTextRow[]> {
    const { store } = this.options;
    if (found.s === "memory_ref") {
      const key = parseMemorySessionRowId(found.id);
      return key ? await store.memorySessionSubjectRows(key.namespace, key.sessionId) : [];
    }
    if ((LOOKUP_KINDS as readonly string[]).includes(found.s)) {
      const row = await store.subjectTextRow(found.s as SubjectStoreKind, found.id);
      return row ? [row] : [];
    }
    const row = await store.subjectScanRow(found.s as SubjectScanKind, found.id);
    return row ? [row] : [];
  }

  private async buildExport(record: SubjectRequestRecord, value: string, state: LookupState, renew: () => Promise<boolean>): Promise<void> {
    const { store, secrets } = this.options;
    const maxBytes = this.options.exportMaxBytes ?? SUBJECT_EXPORT_DEFAULT_MAX_BYTES;
    const lines = new Map<SubjectRowKind, string[]>();
    const written = new Set<string>();
    const counts: Partial<Record<SubjectRowKind, number>> = {};
    let foundByReference = 0;
    let totalBytes = 0;
    let full = false;
    let index = 0;
    for (const found of state.found) {
      if (full) break;
      // Keeps the lease while a large export is read; another instance takes over when it is lost.
      if (index > 0 && index % EXPORT_RENEW_EVERY === 0 && !(await renew())) return;
      index += 1;
      for (const row of await this.rowsOf(found)) {
        const kind = found.s === "memory_ref" ? ROW_KIND_OF[row.kind as unknown as SubjectScanKind] ?? found.k : found.k;
        const key = `${kind}:${row.id}`;
        if (written.has(key)) continue;
        const fields: Record<string, unknown> = {};
        for (const [field, text] of Object.entries(row.texts)) fields[field] = parseField(text);
        const line = JSON.stringify({
          kind,
          id: row.id,
          workflowId: row.workflowId,
          projectId: row.projectId,
          name: row.name,
          status: row.status,
          foundBy: found.by === "r" ? "reference" : "search",
          fields
        });
        const lineBytes = Buffer.byteLength(line) + 1;
        if (totalBytes + lineBytes > maxBytes) {
          state.truncated = true;
          state.truncatedBy = "bytes";
          full = true;
          break;
        }
        totalBytes += lineBytes;
        written.add(key);
        counts[kind] = (counts[kind] ?? 0) + 1;
        if (found.by === "r") foundByReference += 1;
        const list = lines.get(kind) ?? [];
        list.push(line);
        lines.set(kind, list);
      }
      await yieldToEventLoop();
    }
    const staff = record.subjectKind === "staff" ? await store.staffSubjectRows(value) : null;
    const generatedAt = this.now().toISOString();

    const files: Array<{ path: string; text: string }> = [];
    for (const kind of SUBJECT_ROW_KINDS) {
      const list = lines.get(kind);
      if (list && list.length > 0) files.push({ path: `${kind}.jsonl`, text: `${list.join("\n")}\n` });
    }
    if (staff) files.push({ path: "staff.json", text: `${JSON.stringify(staff, null, 2)}\n` });

    // Only the subject's own tokens are revealed: a found row often holds other people's values too, and those stay
    // tokenised (counted as tokensKeptForOthers).
    let tokensRevealed: number | false = false;
    let tokensKeptForOthers = 0;
    if (record.revealTokens) {
      tokensRevealed = 0;
      const subject = normalizeSubjectValue(value);
      const tokens = new Set<string>();
      for (const file of files) for (const match of file.text.matchAll(TOKEN_PATTERN)) tokens.add(match[0]);
      const values = new Map<string, string>();
      for (const token of tokens) {
        const original = (await this.options.revealToken?.(token)) ?? null;
        if (original !== null && normalizeSubjectValue(original) === subject) values.set(token, original);
      }
      for (const file of files) {
        file.text = file.text.replace(TOKEN_PATTERN, (token) => {
          const original = values.get(token);
          if (original === undefined) {
            tokensKeptForOthers += 1;
            return token;
          }
          tokensRevealed = (tokensRevealed as number) + 1;
          // Inside JSON text: the original value as a JSON string body.
          return JSON.stringify(original).slice(1, -1);
        });
      }
    }

    const manifest = {
      format: "l2m-subject-export",
      version: 1,
      requestId: record.id,
      type: record.type,
      subjectKind: record.subjectKind as SubjectKind,
      requestedAt: record.createdAt,
      generatedAt,
      searched: {
        subjectReferences: true,
        storedData: record.scan,
        stores: record.scan ? SCAN_ORDER.map((kind) => ROW_KIND_OF[kind]).filter((kind, index, all) => all.indexOf(kind) === index) : [],
        rowsSearched: state.rowsSearched,
        matchedAs: state.classesTried ?? []
      },
      counts,
      foundByReference,
      possibleMatchesLeftOut: state.possible,
      truncated: state.truncated,
      ...(state.truncatedBy ? { truncatedBy: state.truncatedBy } : {}),
      maxRows: SUBJECT_REQUEST_MAX_ROWS,
      maxBytes,
      tokensRevealed,
      ...(record.revealTokens ? { tokensKeptForOthers } : {}),
      files: files.map((file) => file.path),
      notCovered: [
        ...(record.scan ? [] : ["Stored data of workflows without subject references (the search of stored data was turned off)"]),
        ...SUBJECT_EXPORT_NOT_COVERED
      ]
    };
    const encoder = new TextEncoder();
    const zip = writeZip(
      [{ path: "manifest.json", data: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`) }, ...files.map((file) => ({ path: file.path, data: encoder.encode(file.text) }))],
      { deflateRaw: (data) => deflateRawSync(data), modifiedAt: new Date(generatedAt) }
    );
    const bytes = Buffer.from(zip);
    const expiresAt = new Date(this.now().getTime() + this.options.exportTtlHours * HOUR_MS).toISOString();
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    // The export row and the switch to `ready` in one transaction, only while the request is still searching: a worker
    // that lost the lease can never store a second export or re-open a downloaded one.
    const ready = await store.completeSubjectRequest(
      record.id,
      {
        status: "ready",
        valueSealed: null,
        counts: counts as Record<string, number>,
        // The found list is not kept once the export exists: only the counts and where the lookup ended.
        progress: {
          phase: "finished",
          kindIndex: state.kindIndex,
          cursor: null,
          rowsSearched: state.rowsSearched,
          possible: state.possible,
          truncated: state.truncated,
          ...(state.truncatedBy ? { truncatedBy: state.truncatedBy } : {}),
          found: [],
          foundByReference
        },
        updatedAt: generatedAt
      },
      {
        id: `dsx_${crypto.randomUUID()}`,
        requestId: record.id,
        sealedBlob: secrets.sealValue(SUBJECT_EXPORT_PURPOSE, bytes.toString("base64")),
        bytes: bytes.length,
        sha256,
        createdAt: generatedAt,
        expiresAt
      }
    );
    if (!ready) return;
    this.options.logger?.info({ requestId: record.id, rows: written.size, bytes: bytes.length }, "Data-subject export ready");
    await this.options.audit?.({
      category: "data_protection",
      eventType: "data_subject.export_ready",
      action: "export",
      actor: { type: "system" },
      resourceType: "subject_request",
      resourceId: record.id,
      metadata: {
        requestId: record.id,
        counts,
        foundByReference,
        possibleMatchesLeftOut: state.possible,
        truncated: state.truncated,
        ...(state.truncatedBy ? { truncatedBy: state.truncatedBy } : {}),
        bytes: bytes.length,
        sha256,
        tokensRevealed,
        ...(record.revealTokens ? { tokensKeptForOthers } : {}),
        expiresAt
      }
    });
  }

  private async renew(lease: { leaseName: string; holderId: string; ttlMs: number }): Promise<boolean> {
    if (this.stopped || !this.options.isLeader()) return false;
    try {
      return await this.options.store.tryAcquireLease(lease);
    } catch {
      return false;
    }
  }

  private message(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return this.options.redact ? this.options.redact(text) : text;
  }
}

/** Whether a status can still change (the lookup runs, or the export waits for its download). */
export function subjectRequestOpen(status: SubjectRequestStatus): boolean {
  return status === "searching" || status === "ready";
}
