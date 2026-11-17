/**
 * v76 — sealed redaction maps (`content_redactions`): the placeholder book of a workflow run, and the map a redact
 * tool call leaves for a later restore. The map is JSON sealed with the master key (SecretService.sealValue, purpose
 * `content-redaction-map`, bound as authenticated data); the store keeps only the sealed text, the owner columns,
 * counts and class names. Nothing here logs or returns a value.
 */

import { InMemoryPlaceholderBook, type GuardDataClass, type PlaceholderBook, type PlaceholderBookState } from "@ai-orchestrator/guard-sdk";
import type { ContentRedactionRecord, ContentRedactionScope, ContentRedactionStore } from "../db/content-redaction-store.js";

/** The purpose a map is sealed under (db-shared.ts SEALED_COLUMNS re-seals it on import). */
export const CONTENT_REDACTION_PURPOSE = "content-redaction-map";

export interface ContentRedactionSealer {
  sealValue(purpose: string, plaintext: string): string;
  openValue(purpose: string, sealed: string): string;
}

/** What a sealed map holds: the placeholder book and the vault tokens a `token` redaction issued (no values). */
export interface ContentRedactionMap {
  book: PlaceholderBookState;
  tokens: Array<{ token: string; dataClass: string }>;
}

export function sealRedactionMap(sealer: ContentRedactionSealer, map: ContentRedactionMap): string {
  return sealer.sealValue(CONTENT_REDACTION_PURPOSE, JSON.stringify({ v: 1, book: map.book, tokens: map.tokens }));
}

/** The map of a sealed row; throws when it cannot be opened (another master key, a damaged row). */
export function openRedactionMap(sealer: ContentRedactionSealer, sealed: string): ContentRedactionMap {
  const parsed = JSON.parse(sealer.openValue(CONTENT_REDACTION_PURPOSE, sealed)) as { v?: number; book?: PlaceholderBookState; tokens?: ContentRedactionMap["tokens"] };
  if (parsed.v !== 1) throw new Error("Unknown redaction map format");
  const book = parsed.book ?? { entries: [], reserved: [] };
  return {
    book: {
      entries: Array.isArray(book.entries) ? book.entries.filter((entry) => typeof entry?.placeholder === "string" && typeof entry.value === "string" && typeof entry.dataClass === "string") : [],
      reserved: Array.isArray(book.reserved) ? book.reserved.filter((entry): entry is string => typeof entry === "string") : []
    },
    tokens: Array.isArray(parsed.tokens) ? parsed.tokens.filter((entry) => typeof entry?.token === "string" && typeof entry.dataClass === "string") : []
  };
}

/** Class names of a map (placeholders and tokens), sorted. */
export function redactionClasses(map: ContentRedactionMap): string[] {
  return [...new Set([...map.book.entries.map((entry) => entry.dataClass), ...map.tokens.map((entry) => entry.dataClass)])].sort();
}

export interface RedactionOwner {
  id: string;
  scope: ContentRedactionScope;
  clientId: string | null;
  toolsetId: string | null;
  projectId: string | null;
  executionId: string | null;
}

/** Writes a map as one row (insert or replace), expiring `ttlMs` from `now`. */
export async function storeRedactionMap(
  store: ContentRedactionStore,
  sealer: ContentRedactionSealer,
  owner: RedactionOwner,
  map: ContentRedactionMap,
  options: { now: Date; ttlMs: number; createdAt?: string }
): Promise<ContentRedactionRecord> {
  const at = options.now.toISOString();
  const record: ContentRedactionRecord = {
    ...owner,
    entriesSealed: sealRedactionMap(sealer, map),
    entryCount: map.book.entries.length + map.tokens.length,
    classes: redactionClasses(map),
    createdAt: options.createdAt ?? at,
    updatedAt: at,
    expiresAt: new Date(options.now.getTime() + options.ttlMs).toISOString()
  };
  await store.putContentRedaction(record);
  return record;
}

/**
 * A workflow run's placeholder book: read from its row on first use (a run resumed on another instance finds what it
 * wrote before), and written back after each new placeholder, before the placeholder is used. A write that fails takes
 * the new placeholder back and throws (the rule set's fallback then applies). Calls are serialised.
 */
export class PersistedPlaceholderBook implements PlaceholderBook {
  private inner: InMemoryPlaceholderBook | undefined;
  private saved: PlaceholderBookState = { entries: [], reserved: [] };
  private createdAt: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: ContentRedactionStore,
    private readonly sealer: ContentRedactionSealer,
    private readonly owner: RedactionOwner,
    private readonly ttlMs: number,
    private readonly clock: () => Date = () => new Date()
  ) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<InMemoryPlaceholderBook> {
    if (this.inner) return this.inner;
    const row = await this.store.getContentRedaction(this.owner.id, this.clock().toISOString());
    // Another owner's row under the same id is never read (ids are per run and project).
    if (row && row.scope === this.owner.scope && row.projectId === this.owner.projectId) {
      try {
        this.saved = openRedactionMap(this.sealer, row.entriesSealed).book;
        this.createdAt = row.createdAt;
      } catch {
        // Sealed under another master key or damaged: its placeholders cannot be turned back, and a new one starts.
        this.saved = { entries: [], reserved: [] };
      }
    }
    this.inner = new InMemoryPlaceholderBook(this.saved);
    return this.inner;
  }

  async assign(dataClass: GuardDataClass, value: string, reserved?: ReadonlySet<string>): Promise<string> {
    return await this.serial(async () => {
      const book = await this.load();
      const assigned = book.assignNow(String(dataClass), value, reserved);
      if (!assigned.changed) return assigned.placeholder;
      const state = book.state();
      try {
        const now = this.clock();
        const record = await storeRedactionMap(this.store, this.sealer, this.owner, { book: state, tokens: [] }, { now, ttlMs: this.ttlMs, ...(this.createdAt ? { createdAt: this.createdAt } : {}) });
        this.createdAt = record.createdAt;
        this.saved = state;
      } catch (error) {
        this.inner = new InMemoryPlaceholderBook(this.saved);
        throw error;
      }
      return assigned.placeholder;
    });
  }

  async lookup(placeholder: string): Promise<{ dataClass: string; value: string } | undefined> {
    return await this.serial(async () => await (await this.load()).lookup(placeholder));
  }
}

/** The row id of a run's placeholder book (a sub-workflow in another project gets its own). */
export function runPlaceholderBookId(executionId: string, projectId: string | null, runProjectId: string | null): string {
  return projectId === runProjectId ? `run:${executionId}` : `run:${executionId}:${projectId ?? ""}`;
}
