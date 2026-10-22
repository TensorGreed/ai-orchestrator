/**
 * Phase 11.1 — removing secret values from what an audit bundle carries.
 *
 * A `SecretScrubber` holds the secret values of the deployment (in memory
 * only) and replaces them with `[REDACTED]`:
 *
 *   - in a value tree, before it is serialised (every string and every key),
 *     including text payloads inside base64 `data:` URLs;
 *   - in serialised text, as a second pass, both as the raw value and in its
 *     JSON-escaped form (a value with `"`, `\`, newlines or control
 *     characters appears escaped in JSON text);
 *   - in file bytes: text files are decoded, scrubbed and re-encoded; for a
 *     binary file the caller learns whether it contains a value (as UTF-8,
 *     UTF-16LE, UTF-16BE or JSON-escaped bytes) and leaves the file out.
 *
 * Values shorter than `MIN_SCRUB_LENGTH` are ignored: replacing every
 * occurrence of a very short value would mangle unrelated text.
 *
 * A value tree checked against a schema afterwards (the run manifest) can be
 * walked with that schema's `SchemaConstantGuide`: a string at an enum or
 * literal position that is exactly one of the position's constants, and a
 * key the schema declares, are left as they are. They are fixed words of
 * the schema, not secret material, and a secret that happens to equal one
 * (a builder stored `success`) would otherwise break validation of every
 * manifest. The decision is made from the schema alone, before scrubbing;
 * every other string, format-constrained ones included, is scrubbed.
 */

import { runManifestConstantWords, type SchemaConstantGuide } from "@ai-orchestrator/shared";

export const REDACTED = "[REDACTED]";
export const MIN_SCRUB_LENGTH = 6;

const TEXT_MIME = /^(text\/[a-z0-9.+-]+|application\/(json|xml|javascript|x-ndjson|yaml|x-yaml|ld\+json|[a-z0-9.-]+\+(json|xml))|image\/svg\+xml)$/i;
const DATA_URL = /^data:([a-z0-9.+/-]+)((?:;[a-z0-9.-]+=[^;,]*)*);base64,([A-Za-z0-9+/=\s]*)$/i;

/** Whether a MIME type is text the scrubber can rewrite (txt, csv, md, html, json, svg, xml and similar). */
export function isTextMime(mime: string): boolean {
  return TEXT_MIME.test(mime.trim());
}

function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function utf16(value: string, littleEndian: boolean): Buffer {
  const le = Buffer.from(value, "utf16le");
  if (littleEndian) return le;
  const be = Buffer.alloc(le.length);
  for (let index = 0; index + 1 < le.length; index += 2) {
    be[index] = le[index + 1]!;
    be[index + 1] = le[index]!;
  }
  return be;
}

export class SecretScrubber {
  /** Raw values, longest first so a value containing another is replaced whole. */
  private readonly values: string[];
  /** Raw values plus their JSON-escaped forms, longest first. */
  private readonly textForms: string[];
  /** Byte patterns that mark a binary file as carrying a secret. */
  private readonly bytePatterns: Buffer[];
  /** Replacements made since the last `resetHits()`. */
  hits = 0;

  constructor(values: Iterable<string>) {
    const unique = new Set<string>();
    for (const value of values) if (typeof value === "string" && value.length >= MIN_SCRUB_LENGTH) unique.add(value);
    this.values = [...unique].sort((a, b) => b.length - a.length);
    const forms = new Set<string>(this.values);
    for (const value of this.values) forms.add(jsonEscaped(value));
    this.textForms = [...forms].sort((a, b) => b.length - a.length);
    const patterns: Buffer[] = [];
    for (const value of this.values) {
      patterns.push(Buffer.from(value, "utf8"), utf16(value, true), utf16(value, false));
      const escaped = jsonEscaped(value);
      if (escaped !== value) patterns.push(Buffer.from(escaped, "utf8"));
    }
    this.bytePatterns = patterns;
  }

  get size(): number {
    return this.values.length;
  }

  resetHits(): void {
    this.hits = 0;
  }

  private replaceAll(text: string, forms: string[]): string {
    let out = text;
    for (const form of forms) {
      if (!out.includes(form)) continue;
      const parts = out.split(form);
      this.hits += parts.length - 1;
      out = parts.join(REDACTED);
    }
    return out;
  }

  /** A string with every raw value replaced. */
  string(text: string): string {
    if (this.values.length === 0) return text;
    const dataUrl = text.startsWith("data:") ? this.dataUrl(text) : null;
    if (dataUrl !== null) return dataUrl;
    return this.replaceAll(text, this.values);
  }

  /** Serialised text (JSON, JSONL, plain text) with raw and JSON-escaped values replaced. */
  text(text: string): string {
    if (this.values.length === 0) return text;
    return this.replaceAll(text, this.textForms);
  }

  /** Whether bytes carry a value as UTF-8, UTF-16 (either byte order) or JSON-escaped text. */
  containsSecret(bytes: Uint8Array): boolean {
    if (this.values.length === 0 || bytes.length === 0) return false;
    const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return this.bytePatterns.some((pattern) => pattern.length > 0 && haystack.includes(pattern));
  }

  /**
   * File bytes as they may go into a bundle: text is scrubbed and re-encoded;
   * binary content carrying a value is refused (`null`).
   */
  bytes(data: Uint8Array, mime: string): Uint8Array | null {
    if (this.values.length === 0) return data;
    if (isTextMime(mime)) {
      let decoded: string | null = null;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        decoded = null;
      }
      if (decoded !== null) {
        const before = this.hits;
        const scrubbed = this.text(decoded);
        return this.hits === before ? data : new TextEncoder().encode(scrubbed);
      }
    }
    if (this.containsSecret(data)) {
      this.hits += 1;
      return null;
    }
    return data;
  }

  /** A base64 data URL with its payload scrubbed, `[REDACTED]` for a binary payload carrying a value, or null when not a data URL. */
  private dataUrl(text: string): string | null {
    const match = DATA_URL.exec(text);
    if (!match) return null;
    const mime = match[1]!.toLowerCase();
    const data = new Uint8Array(Buffer.from(match[3]!.replace(/\s+/g, ""), "base64"));
    const scrubbed = this.bytes(data, mime);
    if (scrubbed === null) return REDACTED;
    if (scrubbed === data) return text;
    return `data:${match[1]}${match[2] ?? ""};base64,${Buffer.from(scrubbed).toString("base64")}`;
  }

  /**
   * A value tree with every string and key scrubbed. Objects are rebuilt
   * without a prototype so an own `__proto__` key survives as data. With a
   * `guide`, a string equal to one of its position's schema constants and a
   * key the schema declares at that position are kept.
   */
  tree(value: unknown, options: { guide?: SchemaConstantGuide } = {}): unknown {
    if (this.values.length === 0) return value;
    return this.walk(value, 0, options.guide);
  }

  private walk(value: unknown, depth: number, guide: SchemaConstantGuide | undefined): unknown {
    if (typeof value === "string") return guide?.constants?.has(value) ? value : this.string(value);
    if (depth > 64 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((entry) => this.walk(entry, depth + 1, guide?.element));
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      const declared = guide?.keys?.get(key);
      const name = declared ? key : this.replaceAll(key, this.values);
      out[name] = this.walk((value as Record<string, unknown>)[key], depth + 1, declared ?? guide?.rest);
    }
    return out;
  }
}

export const SCRUB_EXEMPTION_WARNING =
  "This value is a common word used in run records, such as a status or field name. It will not be hidden there; choose a more unique value.";

/**
 * Save-time warnings for a secret value: one when the value is, or is part
 * of, a word the run manifest schema fixes (an enum or literal constant, or
 * a field name), since manifests keep those words as they are. Values too
 * short to be scrubbed never warn. The value itself is never part of a warning.
 */
export function scrubExemptionWarnings(value: string): string[] {
  if (typeof value !== "string" || value.length < MIN_SCRUB_LENGTH) return [];
  for (const word of runManifestConstantWords()) if (word.includes(value)) return [SCRUB_EXEMPTION_WARNING];
  return [];
}

/** Environment variable names that hold credentials (provider API keys, tokens, passwords, keys). */
const CREDENTIAL_ENV_NAME = /(API_KEY|APIKEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|KEY_BASE64|CREDENTIALS?|CONNECTION_STRING)/i;
/** Settings that only mention a credential in their name (TTL, limits, flags, names, paths). */
const SETTING_ENV_NAME = /(_MS|_SECONDS|_HOURS|_DAYS|_TTL|_ENABLED|_MODE|_NAME|_PATH|_DIR|_FILE|_ROOT|_URL|_ID|_HEADER|_TOKENS|_LIMIT|_SIZE|_COUNT|_BYTES)$/i;
/** Values that are plainly not credentials: numbers and booleans. */
const PLAIN_SETTING_VALUE = /^(\d+(\.\d+)?|true|false|yes|no|on|off)$/i;

/**
 * Credential values L2M can read from its environment: provider API keys
 * (OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, AZURE_OPENAI_API_KEY,
 * vector-store keys and similar), passwords and master keys. Both the parsed
 * config and the raw environment are read, since some adapters read the
 * environment directly.
 */
export function environmentSecretValues(...sources: Array<Record<string, unknown> | undefined>): string[] {
  const values = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const [name, value] of Object.entries(source)) {
      if (typeof value !== "string" || value.length < MIN_SCRUB_LENGTH) continue;
      if (!CREDENTIAL_ENV_NAME.test(name) || SETTING_ENV_NAME.test(name) || PLAIN_SETTING_VALUE.test(value.trim())) continue;
      values.add(value);
    }
  }
  return [...values];
}
