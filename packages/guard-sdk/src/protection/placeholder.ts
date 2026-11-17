import type { GuardDataClass } from "../types";
import { GuardProtectionError } from "../types";
import type { ProtectionProvider } from "./types";

export const PLACEHOLDER_PROVIDER_ID = "placeholder";

/**
 * Readable placeholders: `[EMAIL_1]`, `[PHONE_2]`, `[CARD_NUMBER_1]`. A placeholder book holds the mapping:
 *
 * - numbering is per data class, in order of first appearance, and stable within one book: the same value of the
 *   same class always gets the same placeholder;
 * - placeholders already in the text being rewritten are reserved (never handed out by that book), so a
 *   `[EMAIL_1]` someone typed is never mistaken for one the book issued, and restoring never replaces it;
 * - a book persisted server-side makes placeholders reversible (the restore tool, a Reveal node in the same run);
 *   an in-memory book lasts one check, so its placeholders read well but cannot be turned back.
 */

/** Matches a placeholder anywhere: an upper-case label, an underscore and a number, in square brackets. */
export const PLACEHOLDER_PATTERN = /\[[A-Z0-9_]{1,64}_\d{1,6}\]/g;

/** At most this many placeholders per data class in one book. */
export const MAX_PLACEHOLDERS_PER_CLASS = 999_999;

/** The label of a data class in its placeholders: upper case, anything but letters and digits as `_`. */
export function placeholderLabel(dataClass: string): string {
  const label = dataClass
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return label || "VALUE";
}

/** Placeholders present in a text (to reserve them before rewriting it). */
export function placeholdersIn(text: string): Set<string> {
  return new Set(text.match(PLACEHOLDER_PATTERN) ?? []);
}

export interface PlaceholderEntry {
  placeholder: string;
  dataClass: string;
  value: string;
}

export interface PlaceholderBook {
  /**
   * The placeholder of this value: the one it already has in this book, or the next free number of its class.
   * `reserved`: placeholders present in the text being rewritten; the book never hands them out (now or later).
   */
  assign(dataClass: GuardDataClass, value: string, reserved?: ReadonlySet<string>): Promise<string>;
  /** The class and value a placeholder this book issued stands for; undefined for anything else. */
  lookup(placeholder: string): Promise<{ dataClass: string; value: string } | undefined>;
}

/** Serialisable state of a book (what the API seals and stores). */
export interface PlaceholderBookState {
  entries: PlaceholderEntry[];
  /** Placeholders seen in rewritten text that the book did not issue: never handed out. */
  reserved: string[];
}

/**
 * A book over in-memory state. The API wraps one per redaction (or per run) and persists `state()` after each new
 * assignment; on its own it lasts as long as the object.
 */
export class InMemoryPlaceholderBook implements PlaceholderBook {
  private readonly byKey = new Map<string, PlaceholderEntry>();
  private readonly byPlaceholder = new Map<string, PlaceholderEntry>();
  private readonly reservedSet = new Set<string>();
  private readonly counters = new Map<string, number>();

  constructor(state?: PlaceholderBookState) {
    for (const entry of state?.entries ?? []) this.remember(entry);
    for (const placeholder of state?.reserved ?? []) this.reservedSet.add(placeholder);
  }

  private remember(entry: PlaceholderEntry): void {
    this.byKey.set(`${entry.dataClass}\u0000${entry.value}`, entry);
    this.byPlaceholder.set(entry.placeholder, entry);
  }

  /** Synchronous assignment; returns whether the book changed (a new entry or a newly reserved placeholder). */
  assignNow(dataClass: string, value: string, reserved?: ReadonlySet<string>): { placeholder: string; changed: boolean } {
    let changed = false;
    for (const placeholder of reserved ?? []) {
      if (this.byPlaceholder.has(placeholder) || this.reservedSet.has(placeholder)) continue;
      this.reservedSet.add(placeholder);
      changed = true;
    }
    const existing = this.byKey.get(`${dataClass}\u0000${value}`);
    if (existing) return { placeholder: existing.placeholder, changed };
    const label = placeholderLabel(dataClass);
    let next = this.counters.get(label) ?? 0;
    let placeholder: string;
    do {
      next += 1;
      if (next > MAX_PLACEHOLDERS_PER_CLASS) throw new GuardProtectionError(PLACEHOLDER_PROVIDER_ID, `More than ${MAX_PLACEHOLDERS_PER_CLASS} placeholders for one data class`);
      placeholder = `[${label}_${next}]`;
    } while (this.byPlaceholder.has(placeholder) || this.reservedSet.has(placeholder));
    this.counters.set(label, next);
    this.remember({ placeholder, dataClass, value });
    return { placeholder, changed: true };
  }

  async assign(dataClass: GuardDataClass, value: string, reserved?: ReadonlySet<string>): Promise<string> {
    return this.assignNow(String(dataClass), value, reserved).placeholder;
  }

  async lookup(placeholder: string): Promise<{ dataClass: string; value: string } | undefined> {
    const entry = this.byPlaceholder.get(placeholder);
    return entry ? { dataClass: entry.dataClass, value: entry.value } : undefined;
  }

  get size(): number {
    return this.byPlaceholder.size;
  }

  state(): PlaceholderBookState {
    return { entries: [...this.byPlaceholder.values()].map((entry) => ({ ...entry })), reserved: [...this.reservedSet].sort() };
  }
}

export interface PlaceholderProviderOptions {
  /** The book to use; without one, each provider instance keeps its own in-memory book (not reversible later). */
  book?: PlaceholderBook;
}

/** Readable, reversible placeholders kept in a placeholder book (see the module comment). */
export function createPlaceholderProvider(options: PlaceholderProviderOptions = {}): ProtectionProvider {
  const book = options.book ?? new InMemoryPlaceholderBook();
  // One check rewrites one text finding by finding: its placeholders are read once.
  let lastText: string | undefined;
  let lastReserved: Set<string> | undefined;
  const reservedIn = (text: string): Set<string> => {
    if (text !== lastText || !lastReserved) {
      lastText = text;
      lastReserved = placeholdersIn(text);
    }
    return lastReserved;
  };
  return {
    id: PLACEHOLDER_PROVIDER_ID,
    description: "Readable placeholders such as [EMAIL_1], numbered per data class; the same value keeps its placeholder, and the map stays on the server.",
    deterministic: true,
    reversible: true,
    dataClasses: "*",
    async protect(value, context) {
      return await book.assign(context.dataClass, value, context.text ? reservedIn(context.text) : undefined);
    },
    async reveal(token, context) {
      const entry = await book.lookup(token);
      if (!entry) throw new GuardProtectionError(PLACEHOLDER_PROVIDER_ID, "Placeholder is not in this redaction");
      if (entry.dataClass !== context.dataClass) throw new GuardProtectionError(PLACEHOLDER_PROVIDER_ID, "Placeholder belongs to another data class");
      return entry.value;
    }
  };
}
