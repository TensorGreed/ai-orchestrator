import { createHash } from "node:crypto";
import type { RevealClassSummary, RevealRefusalReason } from "@ai-orchestrator/shared";
import { scanDlp } from "../detectors/dlp";
import { GuardProtectionError } from "../types";
import { createAesGcmProvider } from "./aes-gcm";
import type { TokenVaultRecord, TokenVaultStorage } from "./token-vault";
import type { KeyResolver } from "./types";

/**
 * Phase 12 coverage — reveal: protection tokens turned back into values.
 *
 * Only tokens the deployment can prove it issued are revealed:
 * - token vault tokens, found by shape (`tok_<class>_<16 base64url>`) or, for format-preserving tokens (they look
 *   like real values), by the data detectors of the classes asked for, then an exact lookup in the vault;
 * - encrypted values (`enc:<keyId>:<payload>`) under a key the caller allows, for a data class the caller allows
 *   (the class is bound into the ciphertext, so a value only opens under its own class).
 * A vault token issued in another project is refused; one issued before tokens were scoped to a project only when
 * the caller says so (an admin's run). Everything refused stays as it is. Results carry counts and token hashes,
 * never values.
 */

export const REVEAL_DEFAULT_MAX_TOKENS = 1_000;
const HASH_LIST_LIMIT = 50;

/** What the caller's reveal rules say about one data class: undefined when no rule allows it. */
export interface RevealGrant {
  rule: NonNullable<RevealClassSummary["rule"]>;
  /** The rule asks a person to approve the reveal first. */
  requireApproval?: boolean;
}

export interface RevealTokensOptions {
  /** The token vault; without it vault tokens are refused as unknown. */
  vault?: TokenVaultStorage;
  /** Resolves allowed encryption keys (secret ids). */
  keys?: KeyResolver;
  /** Key ids (secret ids) whose encrypted values may be opened; empty: encrypted values are refused. */
  allowedKeyIds?: readonly string[];
  /** The rule decision for a data class. */
  grant(dataClass: string): RevealGrant | undefined;
  /** Data classes some rule allows this caller: encrypted values are tried under these only. */
  allowedClasses: readonly string[];
  /** The run's project; a vault token issued in another project is refused. */
  projectId: string | null | undefined;
  /** Vault tokens issued before tokens were scoped to a project may be revealed (an admin's run). */
  allowUnscoped: boolean;
  /** Data classes whose format-preserving vault tokens are looked for. */
  formatPreservingClasses?: readonly string[];
  /** Vault token prefix (default `tok`). */
  vaultPrefix?: string;
  /** Distinct tokens one call may look at (default 1000); more fails the call. */
  maxTokens?: number;
}

export interface RevealTokensResult {
  content: unknown;
  revealed: RevealClassSummary[];
  refused: RevealClassSummary[];
  /** Data classes revealed (sorted). */
  revealedClasses: string[];
  /** Hashes of revealed tokens whose rule asks for approval (sorted); empty when none does. */
  approvalTokenHashes: string[];
}

/** First 16 hex characters of the sha256 of a token: what events and approvals carry instead of the token. */
export function revealTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Vault token pattern for a prefix: the class (data class name characters) then 16 base64url characters. */
export function vaultTokenPattern(prefix = "tok"): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(prefix)}_[A-Za-z0-9_.:-]{1,64}_[A-Za-z0-9_-]{16}(?![A-Za-z0-9_-])`, "g");
}

/** Encrypted value pattern: `enc:<keyId>:<base64url of iv, ciphertext and tag>` (at least 28 bytes). */
export const ENCRYPTED_TOKEN_PATTERN = /(?<![A-Za-z0-9_:.-])enc:([A-Za-z0-9_.-]{1,128}):([A-Za-z0-9_-]{38,})(?![A-Za-z0-9_-])/g;

type Outcome =
  | { kind: "revealed"; dataClass: string; value: string; grant: RevealGrant }
  | { kind: "refused"; dataClass?: string; reason: RevealRefusalReason }
  | { kind: "ignored" };

interface Span {
  start: number;
  end: number;
  token: string;
  /** Shape-found tokens are reported when unknown; detector-found candidates that are not tokens are real values. */
  source: "vault_shape" | "encrypted" | "format_preserving";
  dataClass?: string;
}

function findSpans(text: string, options: RevealTokensOptions): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(vaultTokenPattern(options.vaultPrefix))) {
    spans.push({ start: match.index, end: match.index + match[0].length, token: match[0], source: "vault_shape" });
  }
  for (const match of text.matchAll(ENCRYPTED_TOKEN_PATTERN)) {
    spans.push({ start: match.index, end: match.index + match[0].length, token: match[0], source: "encrypted" });
  }
  const classes = new Set(options.formatPreservingClasses ?? []);
  if (classes.size > 0) {
    for (const match of scanDlp(text)) {
      if (!classes.has(String(match.dataClass))) continue;
      spans.push({ start: match.span.start, end: match.span.end, token: text.slice(match.span.start, match.span.end), source: "format_preserving", dataClass: String(match.dataClass) });
    }
  }
  // Earlier and longer spans win; overlapping later ones are dropped.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  let end = -1;
  for (const span of spans) {
    if (span.start < end) continue;
    kept.push(span);
    end = span.end;
  }
  return kept;
}

export async function revealTokens(content: unknown, options: RevealTokensOptions): Promise<RevealTokensResult> {
  const maxTokens = options.maxTokens ?? REVEAL_DEFAULT_MAX_TOKENS;
  const allowedKeys = new Set(options.allowedKeyIds ?? []);
  const aes = options.keys ? createAesGcmProvider({ keys: options.keys }) : undefined;
  const outcomes = new Map<string, Promise<Outcome>>();

  const vaultOutcome = (record: TokenVaultRecord | undefined, expectedClass: string | undefined, source: Span["source"]): Outcome => {
    if (!record) return source === "vault_shape" ? { kind: "refused", reason: "unknown_token" } : { kind: "ignored" };
    if (expectedClass && record.dataClass !== expectedClass) return { kind: "ignored" };
    const dataClass = String(record.dataClass);
    if (record.projectId) {
      if (record.projectId !== options.projectId) return { kind: "refused", dataClass, reason: "other_project" };
    } else if (!options.allowUnscoped) {
      return { kind: "refused", dataClass, reason: "unscoped_token" };
    }
    const grant = options.grant(dataClass);
    if (!grant) return { kind: "refused", dataClass, reason: "no_rule" };
    return { kind: "revealed", dataClass, value: record.value, grant };
  };

  const encryptedOutcome = async (token: string): Promise<Outcome> => {
    const keyId = token.split(":")[1] ?? "";
    if (!aes || !allowedKeys.has(keyId)) return { kind: "refused", reason: "key_not_allowed" };
    for (const dataClass of options.allowedClasses) {
      const grant = options.grant(dataClass);
      if (!grant) continue;
      try {
        const value = await aes.reveal!(token, { dataClass });
        return { kind: "revealed", dataClass, value, grant };
      } catch (error) {
        if (!(error instanceof GuardProtectionError)) throw error;
      }
    }
    return { kind: "refused", reason: "not_decryptable" };
  };

  const outcomeOf = (span: Span): Promise<Outcome> => {
    const key = `${span.source}\u0000${span.dataClass ?? ""}\u0000${span.token}`;
    let pending = outcomes.get(key);
    if (!pending) {
      if (outcomes.size >= maxTokens) {
        throw new GuardProtectionError("reveal", `More than ${maxTokens} distinct tokens in one reveal; split the content`);
      }
      pending =
        span.source === "encrypted"
          ? encryptedOutcome(span.token)
          : options.vault
            ? options.vault.getByToken(span.token).then((record) => vaultOutcome(record, span.dataClass, span.source))
            : Promise.resolve<Outcome>(span.source === "vault_shape" ? { kind: "refused", reason: "unknown_token" } : { kind: "ignored" });
      outcomes.set(key, pending);
    }
    return pending;
  };

  const revealed = new Map<string, { count: number; hashes: Set<string>; rule: RevealGrant["rule"] }>();
  const refused = new Map<string, { dataClass?: string; reason: RevealRefusalReason; count: number; hashes: Set<string> }>();
  const approvalHashes = new Set<string>();

  const revealText = async (text: string): Promise<string> => {
    const spans = findSpans(text, options);
    if (spans.length === 0) return text;
    let out = "";
    let cursor = 0;
    for (const span of spans) {
      const outcome = await outcomeOf(span);
      if (outcome.kind === "ignored") continue;
      const hash = revealTokenHash(span.token);
      if (outcome.kind === "refused") {
        const key = `${outcome.dataClass ?? ""}\u0000${outcome.reason}`;
        const entry = refused.get(key) ?? { ...(outcome.dataClass ? { dataClass: outcome.dataClass } : {}), reason: outcome.reason, count: 0, hashes: new Set<string>() };
        entry.count += 1;
        entry.hashes.add(hash);
        refused.set(key, entry);
        continue;
      }
      const entry = revealed.get(outcome.dataClass) ?? { count: 0, hashes: new Set<string>(), rule: outcome.grant.rule };
      entry.count += 1;
      entry.hashes.add(hash);
      revealed.set(outcome.dataClass, entry);
      if (outcome.grant.requireApproval) approvalHashes.add(hash);
      out += text.slice(cursor, span.start) + outcome.value;
      cursor = span.end;
    }
    return out + text.slice(cursor);
  };

  const walk = async (value: unknown, depth: number): Promise<unknown> => {
    if (typeof value === "string") return await revealText(value);
    if (depth > 32 || !value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const next: unknown[] = [];
      for (const item of value) next.push(await walk(item, depth + 1));
      return next;
    }
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) next[key] = await walk(item, depth + 1);
    return next;
  };

  const out = await walk(content, 0);
  const hashes = (set: Set<string>) => [...set].sort().slice(0, HASH_LIST_LIMIT);
  return {
    content: out,
    revealed: [...revealed.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dataClass, entry]) => ({ dataClass, count: entry.count, tokenHashes: hashes(entry.hashes), rule: entry.rule })),
    refused: [...refused.values()]
      .sort((a, b) => (a.dataClass ?? "").localeCompare(b.dataClass ?? "") || a.reason.localeCompare(b.reason))
      .map((entry) => ({ ...(entry.dataClass ? { dataClass: entry.dataClass } : {}), count: entry.count, tokenHashes: hashes(entry.hashes), reason: entry.reason })),
    revealedClasses: [...revealed.keys()].sort(),
    approvalTokenHashes: [...approvalHashes].sort()
  };
}
