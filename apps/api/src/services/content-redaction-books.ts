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

/** A run's book that cannot be used: another owner's row under its id, or a row this deployment cannot open. */
export class PlaceholderBookUnavailableError extends Error {}

/** How long a lookup may answer from the last read of the row before it reads it again. */
export const PLACEHOLDER_BOOK_LOOKUP_FRESH_MS = 1_000;

/**
 * A workflow run's placeholder book: one sealed row per run (a run resumed on another instance finds what it wrote
 * before). The row is the authority:
 * - a new placeholder is written before it is used, conditionally on the row's version: a writer that lost a race (a
 *   resumed run racing the original) re-reads the row, which holds everything both wrote, and numbers again from there,
 *   so no mapping is overwritten; after PLACEHOLDER_BOOK_WRITE_ATTEMPTS lost races it gives up (fail closed);
 * - a lookup answers from a read of the row at most PLACEHOLDER_BOOK_LOOKUP_FRESH_MS old, so a row a data-subject
 *   deletion removed (or that expired) reveals nothing more, even in a run still in progress; a placeholder with this
 *   book's tag that it does not know is looked up in a fresh read once more;
 * - once the row this book wrote is gone, the book starts again empty under a new tag and never writes the old
 *   mappings back;
 * - another owner's row under the same id, or a row this deployment cannot open, fails closed
 *   (PlaceholderBookUnavailableError): nothing is written over it and nothing is revealed from it.
 * A write that fails takes the new placeholder back and throws (the rule set's fallback then applies). Calls are
 * serialised per instance.
 */
export class PersistedPlaceholderBook implements PlaceholderBook {
  private inner: InMemoryPlaceholderBook | undefined;
  private saved: PlaceholderBookState = PersistedPlaceholderBook.emptyState();
  private createdAt: string | undefined;
  /** The row's version as last read or written; null: no row (yet, or any more). */
  private version: number | null = null;
  private loadedAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: ContentRedactionStore,
    private readonly sealer: ContentRedactionSealer,
    private readonly owner: RedactionOwner,
    private readonly ttlMs: number,
    private readonly clock: () => Date = () => new Date()
  ) {}

  /** A new book gets a random tag, so placeholders from outside the run never match the ones it issues. */
  private static emptyState(): PlaceholderBookState {
    return { entries: [], reserved: [], tag: newPlaceholderTag((size) => new Uint8Array(randomBytes(size))) };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Reads the row into the book (always when `fresh`, else only the first time). */
  private async load(fresh = false): Promise<InMemoryPlaceholderBook> {
    if (this.inner && !fresh) return this.inner;
    const now = this.clock();
    const row = await this.store.getContentRedaction(this.owner.id, now.toISOString());
    if (row) {
      if (row.scope !== this.owner.scope || row.projectId !== this.owner.projectId) {
        throw new PlaceholderBookUnavailableError("Another owner's redaction map uses this run's id; no placeholder is issued or revealed");
      }
      let opened: PlaceholderBookState;
      try {
        opened = openRedactionMap(this.sealer, row.entriesSealed).book;
      } catch {
        throw new PlaceholderBookUnavailableError("The run's placeholder map cannot be opened with this deployment's key");
      }
      this.saved = opened;
      this.version = row.version ?? 0;
      this.createdAt = row.createdAt;
    } else if (this.version !== null || !this.inner) {
      // Never written, or written and since deleted (a data-subject deletion) or expired: start again, empty, under a
      // new tag. The old mappings are dropped from memory too and never written back.
      this.saved = PersistedPlaceholderBook.emptyState();
      this.version = null;
      this.createdAt = undefined;
    }
    this.inner = new InMemoryPlaceholderBook(this.saved);
    this.loadedAt = now.getTime();
    return this.inner;
  }

  async assign(dataClass: GuardDataClass, value: string, reserved?: ReadonlySet<string>): Promise<string> {
    return await this.serial(async () => {
      let book = await this.load(this.clock().getTime() - this.loadedAt > PLACEHOLDER_BOOK_LOOKUP_FRESH_MS);
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
        // Another writer got there first, or the row went: start again from what the store holds now.
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
      try {
        const stale = !this.inner || this.clock().getTime() - this.loadedAt > PLACEHOLDER_BOOK_LOOKUP_FRESH_MS;
        const found = await (await this.load(stale)).lookup(placeholder);
        // Not known here: another instance of the run may have issued it since this one last read the row (one more
        // read, only for a placeholder carrying this book's tag).
        if (found || stale || !this.saved.tag || !placeholder.endsWith(`.${this.saved.tag}]`)) return found;
        return await (await this.load(true)).lookup(placeholder);
      } catch (error) {
        // A book that cannot be used reveals nothing: the placeholder stays as it is.
        if (error instanceof PlaceholderBookUnavailableError) return undefined;
        throw error;
      }
    });
  }
}

/** The row id of a run's placeholder book (a sub-workflow in another project gets its own). */
export function runPlaceholderBookId(executionId: string, projectId: string | null, runProjectId: string | null): string {
  return projectId === runProjectId ? `run:${executionId}` : `run:${executionId}:${projectId ?? ""}`;
}
