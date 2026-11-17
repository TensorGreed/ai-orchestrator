/**
 * v76 — sealed redaction maps (`content_redactions`): the placeholder book of a workflow run, and the map a redact
 * tool call leaves for a later restore. The map is JSON sealed with the master key (SecretService.sealValue, purpose
 * `content-redaction-map`, bound as authenticated data); the store keeps only the sealed text, the owner columns,
 * counts and class names. Nothing here logs or returns a value.
 */

import { randomBytes } from "node:crypto";
import { InMemoryPlaceholderBook, newPlaceholderTag, type GuardDataClass, type PlaceholderBook, type PlaceholderBookState } from "@ai-orchestrator/guard-sdk";
import type { ContentRedactionRecord, ContentRedactionScope, ContentRedactionStore } from "../db/content-redaction-store.js";

/** The purpose a map is sealed under. The table is not exported (db-shared.ts NOT_EXPORTED_TABLES), so no re-seal. */
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
      reserved: Array.isArray(book.reserved) ? book.reserved.filter((entry): entry is string => typeof entry === "string") : [],
      ...(typeof book.tag === "string" ? { tag: book.tag } : {})
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

/** How often a book write that lost a race reloads and tries again before it gives up (fail closed). */
export const PLACEHOLDER_BOOK_WRITE_ATTEMPTS = 5;

/**
 * A workflow run's placeholder book: read from its row on first use (a run resumed on another instance finds what it
 * wrote before), and written back after each new placeholder, before the placeholder is used. Writes are conditional on
 * the row's version: a writer that lost a race (another instance writing the same run's book) reloads the row, which
 * holds everything both wrote, and assigns again from there, so no mapping is ever overwritten. A write that still fails
 * takes the new placeholder back and throws (the rule set's fallback then applies). A placeholder this instance does not
 * know is looked up in the row once more before it is treated as unknown. Calls are serialised per instance.
 */
export class PersistedPlaceholderBook implements PlaceholderBook {
  private inner: InMemoryPlaceholderBook | undefined;
  /** A new book gets a random tag, so placeholders from outside the run never match the ones it issues. */
  private saved: PlaceholderBookState = { entries: [], reserved: [], tag: newPlaceholderTag((size) => new Uint8Array(randomBytes(size))) };
  private createdAt: string | undefined;
  /** The row's version as last read or written; null: no row yet. */
  private version: number | null = null;
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

  /** Reads the row into the book (always, when `fresh`; else only the first time). */
  private async load(fresh = false): Promise<InMemoryPlaceholderBook> {
    if (this.inner && !fresh) return this.inner;
    const row = await this.store.getContentRedaction(this.owner.id, this.clock().toISOString());
    // Another owner's row under the same id is never read (ids are per run and project).
    if (row && row.scope === this.owner.scope && row.projectId === this.owner.projectId) {
      this.version = row.version ?? 0;
      this.createdAt = row.createdAt;
      try {
        this.saved = openRedactionMap(this.sealer, row.entriesSealed).book;
      } catch {
        // Sealed under another master key or damaged: its placeholders cannot be turned back. The next write replaces
        // the row (at its version) with a book under the fresh tag, so the old placeholders are never reissued.
        this.saved = { entries: [], reserved: [], tag: newPlaceholderTag((size) => new Uint8Array(randomBytes(size))) };
      }
    } else if (!row) {
      this.version = null;
    }
    this.inner = new InMemoryPlaceholderBook(this.saved);
    return this.inner;
  }

  async assign(dataClass: GuardDataClass, value: string, reserved?: ReadonlySet<string>): Promise<string> {
    return await this.serial(async () => {
      let book = await this.load();
      for (let attempt = 1; ; attempt += 1) {
        const assigned = book.assignNow(String(dataClass), value, reserved);
        if (!assigned.changed) return assigned.placeholder;
        const state = book.state();
        const now = this.clock();
        const at = now.toISOString();
        const record: ContentRedactionRecord = {
          ...this.owner,
          entriesSealed: sealRedactionMap(this.sealer, { book: state, tokens: [] }),
          entryCount: state.entries.length,
          classes: redactionClasses({ book: state, tokens: [] }),
          createdAt: this.createdAt ?? at,
          updatedAt: at,
          expiresAt: new Date(now.getTime() + this.ttlMs).toISOString()
        };
        let written: number | null;
        try {
          written = await this.store.writeContentRedactionIfVersion(record, this.version);
        } catch (error) {
          this.inner = new InMemoryPlaceholderBook(this.saved);
          throw error;
        }
        if (written !== null) {
          this.version = written;
          this.createdAt = record.createdAt;
          this.saved = state;
          return assigned.placeholder;
        }
        // Another writer got there first: start again from what the row holds now.
        if (attempt >= PLACEHOLDER_BOOK_WRITE_ATTEMPTS) {
          this.inner = new InMemoryPlaceholderBook(this.saved);
          throw new Error("The run's placeholder book kept changing under concurrent writes; the placeholder was not issued");
        }
        book = await this.load(true);
      }
    });
  }

  async lookup(placeholder: string): Promise<{ dataClass: string; value: string } | undefined> {
    return await this.serial(async () => {
      const known = await (await this.load()).lookup(placeholder);
      if (known) return known;
      // Another instance of the run may have issued it since this one last read the row.
      return await (await this.load(true)).lookup(placeholder);
    });
  }
}

/** The row id of a run's placeholder book (a sub-workflow in another project gets its own). */
export function runPlaceholderBookId(executionId: string, projectId: string | null, runProjectId: string | null): string {
  return projectId === runProjectId ? `run:${executionId}` : `run:${executionId}:${projectId ?? ""}`;
}
