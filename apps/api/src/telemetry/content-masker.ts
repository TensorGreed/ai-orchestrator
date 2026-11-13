/**
 * The masker behind optional OpenTelemetry content capture (OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT). It runs off
 * the request path, after a span ended, and only while capture is on. For each span's content it:
 *
 *   1. removes secrets: credential fields and token shapes (as for MCP cassettes), then every secret value this
 *      deployment holds (stored and external-cached secrets, values the secret service stored or read since start-up,
 *      credential environment variables and the OTLP export headers);
 *   2. masks what content rules detect, with keyed surrogates (`maskRecordingSteps`, the masking production capture
 *      uses), the built-in classes plus every dictionary of every content-rule profile, and a key derived from the master
 *      key under its own label, so surrogates are stable across spans but differ from capture's;
 *   3. gives the OpenTelemetry package a final check for secret values, which it runs after truncating.
 *
 * Any failure throws, and the span is exported without its content. Only type imports from the otel package appear
 * here: this module is part of the API's graph while tracing is off, and must not load OpenTelemetry.
 */
import { hkdfSync } from "node:crypto";
import { maskRecordingSteps, type GuardDictionary } from "@ai-orchestrator/guard-sdk";
import { scrubForCassette } from "@ai-orchestrator/mcp-sdk";
import type { ContentMaskPart, ContentMaskResult, ContentMasker } from "@ai-orchestrator/otel";
import { SecretScrubber } from "../services/audit-scrub.js";

/** HKDF info for the content surrogate key (separate from production capture's). */
export const OTEL_CONTENT_SURROGATE_HKDF_INFO = "l2m/otel-content-surrogate/v1";

/** The content surrogate key: HKDF-SHA-256 of the 32-byte master key. Refuses any other key length. */
export function deriveOtelContentSurrogateKey(masterKey: Uint8Array): Uint8Array {
  if (masterKey.length !== 32) throw new Error("Content capture needs the 32-byte master key (SECRET_MASTER_KEY_BASE64).");
  return new Uint8Array(hkdfSync("sha256", masterKey, new Uint8Array(0), OTEL_CONTENT_SURROGATE_HKDF_INFO, 32));
}

/** Read by the otel package as `l2m.content.dropped=<reason>`. */
export class ContentDroppedError extends Error {
  constructor(readonly reason: string) {
    super(`Content dropped: ${reason}`);
    this.name = "ContentDroppedError";
  }
}

export interface OtelContentMaskerOptions {
  key: Uint8Array;
  /** Every stored secret value (decrypted; external secrets from their local cache). */
  storedSecretValues: () => Promise<string[]>;
  /** Credential environment values and the OTLP export header values. */
  otherSecretValues: () => string[];
  /** The deployment's content-rule dictionaries (every profile's). */
  dictionaries: () => Promise<GuardDictionary[]>;
  /** Token-shape redaction for strings (the secret service's). */
  redact?: (value: string) => string;
  /** How long stored values and dictionaries are reused before they are read again. Default 30 s. */
  cacheMs?: number;
  /** How long reading stored values and dictionaries may take before masking fails. Default 10 s. */
  loadTimeoutMs?: number;
  now?: () => number;
}

/** Live secret values kept beside the cached ones (newest kept when there are more). */
const MAX_LIVE_VALUES = 10_000;
const DEFAULT_CACHE_MS = 30_000;
const DEFAULT_LOAD_TIMEOUT_MS = 10_000;
/** Encoded forms are added for values at least this long (shorter ones would match too much text). */
const MIN_ENCODED_FORM_LENGTH = 8;

/**
 * The forms a secret value can take in content: itself, URL-encoded (a query or form argument) and base64 /
 * base64url-encoded (a Basic credential, a token passed on). JSON escaping is handled by the scrubber.
 */
export function secretValueForms(values: Iterable<string>): string[] {
  const forms = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !value) continue;
    forms.add(value);
    if (value.length < MIN_ENCODED_FORM_LENGTH) continue;
    try {
      forms.add(encodeURIComponent(value));
    } catch {
      // A lone surrogate cannot be URL-encoded; the value itself is still scrubbed.
    }
    const base64 = Buffer.from(value, "utf8").toString("base64");
    forms.add(base64);
    forms.add(base64.replace(/=+$/, ""));
    forms.add(Buffer.from(value, "utf8").toString("base64url"));
  }
  return [...forms];
}

/**
 * Passwords in URL-valued environment variables (`postgres://user:pass@host`, `redis://:pass@host`), and those URLs:
 * connection strings are settings, not credential-named variables, yet a tool or code node can echo one.
 */
export function environmentUrlSecrets(env: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  for (const raw of Object.values(env)) {
    if (typeof raw !== "string" || !raw.includes("@") || !raw.includes("://")) continue;
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      continue;
    }
    if (!url.password) continue;
    values.push(raw.trim());
    try {
      values.push(decodeURIComponent(url.password));
    } catch {
      // Not valid percent-encoding: the raw form below still covers it.
    }
    values.push(url.password);
  }
  return values;
}

interface Loaded {
  at: number;
  scrubber: SecretScrubber;
  dictionaries: GuardDictionary[];
  liveVersion: number;
}

export class OtelContentMasker {
  private readonly live = new Set<string>();
  private liveVersion = 0;
  private loaded: Loaded | null = null;
  private loading: Promise<Loaded> | null = null;
  private stored: { at: number; values: string[]; dictionaries: GuardDictionary[] } | null = null;

  constructor(private readonly options: OtelContentMaskerOptions) {}

  /** Secret values the secret service just stored or read: scrubbed from the next span on. */
  addSecretValues(values: readonly string[]): void {
    let added = false;
    for (const value of values) {
      if (typeof value !== "string" || !value || this.live.has(value)) continue;
      this.live.add(value);
      added = true;
    }
    while (this.live.size > MAX_LIVE_VALUES) {
      const oldest = this.live.values().next().value;
      if (oldest === undefined) break;
      this.live.delete(oldest);
    }
    if (added) this.liveVersion += 1;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The scrubber and dictionaries, with every live value known when it is called (else it throws: fail closed). */
  private async load(): Promise<Loaded> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const version = this.liveVersion;
      const loaded = await this.loadOnce();
      if (loaded.liveVersion >= version) return loaded;
    }
    throw new ContentDroppedError("masking_failed");
  }

  private async loadOnce(): Promise<Loaded> {
    const now = this.now();
    const ttl = this.options.cacheMs ?? DEFAULT_CACHE_MS;
    if (this.loaded && now - this.loaded.at < ttl && this.loaded.liveVersion === this.liveVersion) return this.loaded;
    if (this.loading) return await this.loading;
    const loadTimeoutMs = this.options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    // A stuck read fails every waiting call at once, so their content is let go instead of held until it settles.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ContentDroppedError("timeout")), loadTimeoutMs);
      timer.unref?.();
    });
    const read = async (): Promise<[string[], GuardDictionary[]]> => await Promise.all([this.options.storedSecretValues(), this.options.dictionaries()]);
    this.loading = (async () => {
      try {
        // Stored values and dictionaries are read again after the cache time; live values rebuild the scrubber at once.
        if (!this.stored || now - this.stored.at >= ttl) {
          const [values, dictionaries] = await Promise.race([read(), timeout]);
          this.stored = { at: now, values, dictionaries };
        }
        const liveVersion = this.liveVersion;
        const scrubber = new SecretScrubber(secretValueForms([...this.stored.values, ...this.options.otherSecretValues(), ...this.live]));
        this.loaded = { at: this.stored.at, scrubber, dictionaries: this.stored.dictionaries, liveVersion };
        return this.loaded;
      } finally {
        clearTimeout(timer);
        this.loading = null;
      }
    })();
    return await this.loading;
  }

  private scrub(value: unknown, scrubber: SecretScrubber): unknown {
    const redact = this.options.redact;
    const shaped = scrubForCassette(value, redact ? { redact } : {});
    const tree = scrubber.tree(shaped);
    // A second pass over the serialised text catches JSON-escaped forms; text it breaks fails to parse and is dropped.
    return JSON.parse(scrubber.text(JSON.stringify(tree) ?? "null")) as unknown;
  }

  /** The `ContentMasker` the otel package calls. */
  readonly mask: ContentMasker = async (parts: readonly ContentMaskPart[], { deadline }): Promise<ContentMaskResult> => {
    const loaded = await this.load();
    // A call that waited past its deadline does no work: its content is dropped anyway.
    if (this.now() > deadline) throw new ContentDroppedError("timeout");
    const scrubbed = parts.map((part) => ({ id: part.id, value: this.scrub(part.value, loaded.scrubber) }));
    const steps = maskRecordingSteps(scrubbed, { key: this.options.key, dictionaries: loaded.dictionaries });
    let masked: ContentMaskPart[] | null = null;
    for (;;) {
      const next = steps.next();
      if (next.done) {
        masked = next.value.parts.map((part) => ({ id: part.id, value: part.value }));
        break;
      }
      if (this.now() > deadline) throw new ContentDroppedError("timeout");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const scrubber = loaded.scrubber;
    return {
      parts: masked,
      containsSecret: (text: string) => scrubber.text(text) !== text || scrubForCassette(text) !== text
    };
  };
}
