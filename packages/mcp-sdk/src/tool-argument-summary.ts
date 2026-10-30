import { createHmac } from "node:crypto";
import {
  TOOL_ARGUMENT_LENGTH_BUCKETS,
  TOOL_ARGUMENT_SUMMARY_VERSION,
  type ToolArgumentFieldSummary,
  type ToolArgumentLengthBucket,
  type ToolArgumentSummary,
  type ToolArgumentValueType
} from "@ai-orchestrator/shared";
import { CREDENTIAL_NAME_PATTERN } from "./client-features";

/**
 * Phase 12.4 — a safe summary of a tool call's arguments for telemetry
 * (summary format 2).
 *
 * Pure and deterministic for a given hash key: the same arguments (in any key
 * order) and schema give the same summary. It is an ALLOW-LIST: a raw value is
 * stored only when it is safe by construction, and everything else is stored
 * as its shape plus a keyed hash.
 *
 * Kept raw, per argument path:
 *   - null, and booleans outside a sensitive path;
 *   - numbers outside a sensitive path whose integer part has at most six
 *     digits, rounded to four decimals (to one decimal under a location key
 *     such as `lat` / `lng`);
 *   - a string of at most 64 characters the tool's input schema lists in an
 *     `enum` / `const` at that path, when the path is not sensitive;
 *   - a string that is a safe token: NFKC-normalised it matches
 *     `^[a-z][a-z0-9_.-]{0,31}$`, has no run of four digits (any script), does
 *     not end in a `.word` part like a domain or a `first.last` name (trailing
 *     digits included), is not
 *     random-looking (see `looksRandomToolArgument`), and the path is not sensitive.
 *
 * A path is sensitive when the key itself or any ancestor key has a segment
 * (split on case changes, `_`, `-`, `.` and digits) that contains a stem of
 * `TOOL_ARGUMENT_SENSITIVE_STEMS` or equals a word of
 * `TOOL_ARGUMENT_SENSITIVE_SEGMENTS`, or matches the shared credential-name
 * pattern. A sensitive subtree keeps shape and hashes only: never a raw value
 * (numbers included, with their order of magnitude), never a prefix. The one
 * exception: numbers directly under a token-budget key such as `max_tokens`
 * (`TOOL_ARGUMENT_TOKEN_COUNT_KEYS`) follow the normal number rules.
 *
 * Kept as a prefix, outside sensitive paths, for strings that are not tokens:
 * `owner/` of `owner/repo`, `@domain` of an email, scheme and host of a URL
 * (IP hosts become `ip`; a host with more than one label before its
 * registrable domain is reduced to that domain; shared hosting such as
 * `*.github.io` keeps only the suffix), and the root of a file path with any
 * home directory replaced by `~/` plus at most one more segment.
 *
 * Everything else keeps its type, length bucket, data classes and a keyed
 * hash: HMAC-SHA-256 of the NFKC-normalised text (or the number's or
 * boolean's canonical text) under `hashKey`, truncated to 16 bytes, base64url.
 * The key is never stored; the caller derives it from the master key.
 *
 * Object keys are kept in the path only when they are a plain name (an ASCII
 * letter then letters, digits, `_` or `-`, at most 32 characters, no run of
 * four digits, not random-looking, nothing a detector flags); any other key is
 * written `<k:HASH>`.
 *
 * Every string, object key and long number is passed to `detect` (the
 * production-capture DLP scan, injected by the caller so this package stays
 * free of the guard SDK), and the data classes it finds are listed.
 *
 * Caps bound the work on hostile input (depth, paths, array items, keys per
 * object, values visited and characters scanned); reaching one sets
 * `truncated`. A string that could not be scanned within the budget is never
 * kept as a value or prefix.
 */

/** Data classes found in `text` (empty when none). May throw; a throw counts as "not scanned". */
export type ToolArgumentDetector = (text: string) => readonly string[];

export interface SummarizeToolArgumentsOptions {
  detect: ToolArgumentDetector;
  /** The HMAC key for value hashes (at least 16 bytes); the API derives it from the master key. */
  hashKey: Uint8Array;
  /** The tool's JSON Schema for its input, when known; only `enum` / `const` are read. */
  inputSchema?: unknown;
}

export const TOOL_ARGUMENT_SUMMARY_LIMITS = {
  /** Nesting below the top-level arguments that is still walked. */
  maxDepth: 8,
  /** Distinct paths kept. */
  maxFields: 128,
  /** Elements walked per array (its length is still reported). */
  maxArrayItems: 64,
  /** Keys walked per object, in sorted order. */
  maxKeysPerObject: 64,
  /** Values visited in total. */
  maxNodes: 4_000,
  /** Distinct values, hashes and prefixes kept per path. */
  maxValues: 16,
  maxHashes: 16,
  maxPrefixes: 16,
  /** Longest string hashed; a longer one keeps only its length bucket and classes. */
  maxHashedLength: 2_048,
  /** Longest string reduced to a prefix. */
  maxIdentifierLength: 2_048,
  /** Characters of one string passed to the detector. */
  maxScanChars: 8_192,
  /** Characters passed to the detector in total. */
  scanBudgetChars: 262_144
} as const;

/**
 * Sensitive stems, matched as SUBSTRINGS of each key segment (lower-case), so
 * joined or all-lower-case keys such as `firstname`, `userid`,
 * `emailaddress`, `phonenumber`, `accountno` or `zipcode` count too. This
 * over-matches on purpose (`filename`, `hostname`, `wildcard`, `context`):
 * an over-matched key only hashes values that could otherwise have been kept.
 * `owner` is included: on most tools it holds a person's or an organisation's
 * handle. A repository written `owner/repo` under a key that is not sensitive
 * still keeps `owner/` as its prefix, so starts-with suggestions work on
 * repositories.
 */
export const TOOL_ARGUMENT_SENSITIVE_STEMS: readonly string[] = [
  // credentials
  "pass", "passcode", "passphrase", "password", "secret", "token", "key", "auth", "cred", "cookie", "session",
  "otp", "mfa", "pin", "nonce", "signature", "bearer", "jwt", "private", "cert",
  // codes, financial and national identifiers
  "code", "postal", "zip", "verification", "verify", "security", "ssn", "iban", "card", "cvv", "cvc", "account",
  "acct", "passport",
  // people
  "name", "firstname", "lastname", "surname", "fullname", "nickname", "givenname", "user", "login", "handle",
  "owner", "author", "assignee", "reviewer", "customer", "patient", "employee", "member", "person", "contact",
  "recipient", "sender", "email", "mail", "phone", "mobile", "address", "addr", "street", "postcode", "birth",
  // people's words
  "body", "message", "text", "content", "query", "search", "keyword", "prompt", "comment", "note", "description",
  "title", "subject", "summary"
];

/**
 * Short sensitive words, matched only as a WHOLE segment (also without a
 * plural `s`): as substrings they would hit most keys (`to` in `total`, `q`
 * anywhere, `tax` in `syntax`).
 */
export const TOOL_ARGUMENT_SENSITIVE_SEGMENTS: readonly string[] = [
  "pw", "pwd", "sid", "sig", "tax", "tel", "dob", "to", "cc", "bcc", "from", "q", "uid", "rcpt", "nm", "mrn"
];

/**
 * Whole segments that contain a stem but are known not to hold people's data
 * or secrets, so they are not matched by stem. The shared credential-name
 * pattern and the whole-segment list still apply to them.
 *   - `namespace`: a deployment namespace (`default`, `kube-system`).
 */
export const TOOL_ARGUMENT_SAFE_SEGMENTS: readonly string[] = ["namespace"];

/**
 * Keys whose NUMBERS are kept under the normal number rules although the key
 * names a token: a model's token budget, not a credential. Compared as the
 * whole key, any case. Strings and booleans under them stay hashed, and the
 * exception does not apply under a sensitive ancestor.
 */
export const TOOL_ARGUMENT_TOKEN_COUNT_KEYS: readonly string[] = [
  "max_tokens", "max_output_tokens", "max_completion_tokens", "token_limit", "num_tokens"
];

const LIMITS = TOOL_ARGUMENT_SUMMARY_LIMITS;
const TYPE_ORDER: ToolArgumentValueType[] = ["null", "boolean", "number", "string", "array", "object"];
const SENSITIVE_WHOLE = new Set(TOOL_ARGUMENT_SENSITIVE_SEGMENTS);
const SAFE_SEGMENTS = new Set(TOOL_ARGUMENT_SAFE_SEGMENTS);
const TOKEN_COUNT_KEYS = new Set(TOOL_ARGUMENT_TOKEN_COUNT_KEYS);
const LOCATION_SEGMENTS = new Set(["lat", "lng", "lon", "long", "latitude", "longitude", "geo", "coord", "coordinate"]);
const TOKEN = /^[a-z][a-z0-9_.-]{0,31}$/;
const KEY_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const DIGIT_RUN = /\p{Nd}{4,}/u;
/** A domain (`example.com`) or a `first.last` name, with or without trailing digits (`john.s`, `john.smith1`). */
const DOMAIN_TAIL = /[a-z0-9]\.[a-z]{2,63}$|[a-z]\.[a-z]+\d*$/;
/** Longest schema `enum` / `const` string kept as it is. */
const MAX_ENUM_LENGTH = 64;
/** Prefixes of well-known API keys and tokens; a value starting with one is never a token. */
const SECRET_PREFIX = /^(?:(?:sk|pk|rk)[-_]|xox[a-z]?-|gh[pousr]_|github_pat_|glpat-|akia|asia|npm_|hf_|xai-)/;
const URL_SHAPE = /^[a-z][a-z0-9+.-]{0,15}:\/\/\S/i;
const EMAIL_SHAPE = /^[^\s@]{1,64}@([A-Za-z0-9.-]{1,253})$/;
/** `owner/repo`: the owner has a letter (so dates and fractions are not repositories) and no dots. */
const REPO_SHAPE = /^((?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9_-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
const PATH_ROOT = /^(\/|~[\\/]|\.\.?[\\/]|[A-Za-z]:[\\/])/;
const PATH_SEGMENT = /^(?=[^/]*[A-Za-z])[A-Za-z0-9_.-]{1,32}$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** Shared hosting, where the label before the suffix is a customer's (often a person's) name. */
const SHARED_HOST_SUFFIXES = [
  "github.io",
  "gitlab.io",
  "pages.dev",
  "netlify.app",
  "vercel.app",
  "herokuapp.com",
  "azurewebsites.net",
  "blogspot.com",
  "wordpress.com",
  "s3.amazonaws.com",
  "ngrok.io",
  "ngrok-free.app"
];
/** Second-level labels of two-letter country suffixes (`co.uk`, `com.au`). */
const COUNTRY_SECOND_LEVEL = new Set(["co", "com", "net", "org", "ac", "gov", "edu", "ne", "or", "go"]);

/** Lower-case segments of a key: split on case changes and on anything that is not a letter (`_`, `-`, `.`, digits). */
export function toolArgumentKeySegments(key: string): string[] {
  return key
    .normalize("NFKC")
    .replace(/([\p{Ll}\p{Nd}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
}

function hasSegment(set: ReadonlySet<string>, segments: string[]): boolean {
  return segments.some((segment) => set.has(segment) || (segment.length > 2 && segment.endsWith("s") && set.has(segment.slice(0, -1))));
}

function hasSensitiveStem(segments: string[]): boolean {
  return segments.some(
    (segment) => !SAFE_SEGMENTS.has(segment) && TOOL_ARGUMENT_SENSITIVE_STEMS.some((stem) => segment.includes(stem))
  );
}

/** True when a value under `key` must never be kept raw. */
export function isSensitiveToolArgumentKey(key: string): boolean {
  if (CREDENTIAL_NAME_PATTERN.test(key)) return true;
  const segments = toolArgumentKeySegments(key);
  return hasSegment(SENSITIVE_WHOLE, segments) || hasSensitiveStem(segments);
}

/** True for a model token-budget key (`max_tokens`, ...), whose numbers are kept. */
export function isToolArgumentTokenCountKey(key: string): boolean {
  return TOKEN_COUNT_KEYS.has(key.normalize("NFKC").toLowerCase());
}

function isLocationKey(key: string): boolean {
  return hasSegment(LOCATION_SEGMENTS, toolArgumentKeySegments(key));
}

/**
 * True for a location key (`lat`, `lng`, `geo`, ...): numbers under it, or
 * under any key below it, are kept rounded to one decimal.
 */
export function isToolArgumentLocationKey(key: string): boolean {
  return isLocationKey(key);
}

/**
 * Ids, hashes, keys and passphrases, on lower-case text. Random-looking when
 * it starts with a known secret prefix, or any part between `_`, `-` or `.`:
 *   - is longer than 16 characters;
 *   - is 12 or more hex characters;
 *   - is 8 or more characters and mixes letters and digits;
 *   - is 8 or more letters with fewer than one vowel in four.
 */
export function looksRandomToolArgument(text: string): boolean {
  if (SECRET_PREFIX.test(text)) return true;
  for (const part of text.split(/[_.\-]+/)) {
    if (part.length > 16) return true;
    if (part.length >= 12 && /^[0-9a-f]+$/.test(part)) return true;
    if (part.length >= 8 && /[a-z]/.test(part) && /[0-9]/.test(part)) return true;
    const letters = part.replace(/[^a-z]/g, "");
    if (letters.length >= 8 && (letters.match(/[aeiouy]/g)?.length ?? 0) * 4 < letters.length) return true;
  }
  return false;
}

/** Rule 1 of the format: a short lower-case token that cannot carry a name, number, domain or secret. */
export function isSafeToolArgumentToken(normalized: string): boolean {
  return TOKEN.test(normalized) && !DIGIT_RUN.test(normalized) && !DOMAIN_TAIL.test(normalized) && !looksRandomToolArgument(normalized);
}

/**
 * A key looks random when the whole key, lower-cased and split only on `_`,
 * `-` and `.`, has a secret prefix, a part of 12 or more hex characters or a
 * part of 8 or more characters mixing letters and digits (hex digests, UUIDs,
 * `a1b2c3d4...` ids) or a part of 8 or more letters with fewer than one vowel
 * in four (`dCARfVVVOoMQX`; acronym-heavy names such as `XMLHttpRequest` are
 * hashed too, which only costs readability). Its words (split on case changes too, digits kept) then
 * go through `looksRandomToolArgument`, so a word longer than 16 characters or
 * with fewer than one vowel in four is random; splitting on case changes for
 * those rules keeps long camelCase names (`includeArchivedRepositories`)
 * readable. Last, for random mixed-case letters (`TKlYVFDFZEJz...`), a key
 * whose case words hold 10 or more letters is random when three or more words
 * have at most two letters or the words average under three letters; and,
 * without its upper-case runs of two or more letters (acronyms such as
 * `HTTP`), a key with 8 or more letters left is random when fewer than one in
 * four of them is `a`, `e`, `i`, `o` or `u`. Short mixed-case random keys can
 * still pass; the docs list this under Limits.
 */
export function looksRandomToolArgumentKey(key: string): boolean {
  const normalized = key.normalize("NFKC");
  const whole = normalized.toLowerCase();
  if (SECRET_PREFIX.test(whole)) return true;
  for (const part of whole.split(/[_.\-]+/)) {
    if (part.length >= 12 && /^[0-9a-f]+$/.test(part)) return true;
    if (part.length >= 8 && /[a-z]/.test(part) && /[0-9]/.test(part)) return true;
    const letters = part.replace(/[^a-z]/g, "");
    if (letters.length >= 8 && (letters.match(/[aeiouy]/g)?.length ?? 0) * 4 < letters.length) return true;
  }
  const cased = normalized
    .replace(/([\p{Ll}\p{Nd}])(\p{Lu})/gu, "$1_$2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1_$2");
  if (looksRandomToolArgument(cased.toLowerCase())) return true;
  const words = cased.split(/[^A-Za-z]+/).filter((word) => word.length > 0);
  const wordLetters = words.join("").length;
  if (wordLetters >= 10 && (words.filter((word) => word.length <= 2).length >= 3 || words.length * 3 > wordLetters)) return true;
  const letters = normalized.replace(/[A-Z]{2,}/g, "").replace(/[^A-Za-z]/g, "");
  return letters.length >= 8 && (letters.match(/[aeiou]/gi)?.length ?? 0) * 4 < letters.length;
}

function isPlainKeyName(key: string): boolean {
  if (!KEY_NAME.test(key) || DIGIT_RUN.test(key)) return false;
  return !looksRandomToolArgumentKey(key);
}

/** The keyed hash of one value: HMAC-SHA-256 of its NFKC-normalised text, first 16 bytes, base64url. */
export function hashToolArgumentValue(value: string | number | boolean, hashKey: Uint8Array): string {
  if (hashKey.length < 16) throw new Error("The tool argument hash key must be at least 16 bytes.");
  const text = typeof value === "string" ? value.normalize("NFKC") : String(Object.is(value, -0) ? 0 : value);
  return createHmac("sha256", hashKey).update(text, "utf8").digest().subarray(0, 16).toString("base64url");
}

/** The length bucket for a string of `length` characters. */
export function toolArgumentLengthBucket(length: number): ToolArgumentLengthBucket {
  if (length <= 0) return "0";
  if (length <= 8) return "1-8";
  if (length <= 32) return "9-32";
  if (length <= 128) return "33-128";
  if (length <= 512) return "129-512";
  if (length <= 2048) return "513-2048";
  return "2049+";
}

function hostLabelSafe(label: string): boolean {
  return !DIGIT_RUN.test(label) && !looksRandomToolArgument(label);
}

/** The host part of a prefix: `ip`, the host, its registrable domain or `*.suffix`; null when unusable. */
function hostPrefix(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || IPV4.test(host)) return "ip";
  const labels = host.split(".");
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  for (const suffix of SHARED_HOST_SUFFIXES) {
    if (host === suffix) return host;
    if (host.endsWith(`.${suffix}`)) return `*.${suffix}`;
  }
  if (labels.length === 1) return hostLabelSafe(host) ? host : null;
  const last = labels[labels.length - 1]!;
  const suffixLength = labels.length >= 3 && last.length === 2 && COUNTRY_SECOND_LEVEL.has(labels[labels.length - 2]!) ? 2 : 1;
  if (labels.length <= suffixLength) return null;
  const registrable = labels.slice(-(suffixLength + 1));
  const suffix = labels.slice(-suffixLength).join(".");
  if (!hostLabelSafe(registrable[0]!)) return `*.${suffix}`;
  const left = labels.slice(0, -(suffixLength + 1));
  if (left.length === 1 && hostLabelSafe(left[0]!)) return host;
  return registrable.join(".");
}

/** Root plus at most one segment, never the last one; home directories become `~/`. */
function pathPrefix(text: string): string | null {
  const root = PATH_ROOT.exec(text);
  if (!root) return null;
  let rootText = root[1]!.replace(/\\/g, "/");
  let segments = text.slice(root[1]!.length).split(/[\\/]+/).filter((segment) => segment.length > 0);
  const first = segments[0]?.toLowerCase();
  const drive = /^[a-z]:\/$/i.test(rootText);
  if (rootText.startsWith("~")) {
    rootText = "~/";
  } else if ((rootText === "/" && (first === "home" || first === "users")) || (drive && first === "users")) {
    rootText = "~/";
    segments = segments.slice(2);
  } else if (drive && first === "documents and settings") {
    rootText = "~/";
    segments = segments.slice(2);
  } else if (rootText === "/" && first === "root") {
    rootText = "~/";
    segments = segments.slice(1);
  } else if (drive) {
    rootText = rootText.toUpperCase();
  }
  const next = segments[0];
  if (segments.length >= 2 && next !== undefined) {
    const lower = next.toLowerCase();
    if (PATH_SEGMENT.test(next) && !DIGIT_RUN.test(next) && !DOMAIN_TAIL.test(lower) && !looksRandomToolArgument(lower)) {
      return `${rootText}${next}/`;
    }
  }
  return rootText;
}

/** The stable prefix of an identifier-like string, or null when it is not one. */
function identifierPrefix(text: string): string | null {
  if (URL_SHAPE.test(text)) {
    try {
      const url = new URL(text);
      if (!url.hostname) return null;
      const host = hostPrefix(url.hostname);
      return host === null ? null : `${url.protocol.toLowerCase()}//${host}`;
    } catch {
      return null;
    }
  }
  const email = EMAIL_SHAPE.exec(text);
  if (email) return emailPrefix(email[1]!);
  const repo = REPO_SHAPE.exec(text);
  if (repo) {
    const owner = repo[1]!.toLowerCase();
    return DIGIT_RUN.test(owner) || looksRandomToolArgument(owner) ? null : `${owner}/`;
  }
  return pathPrefix(text);
}

function emailPrefix(domain: string): string | null {
  const host = hostPrefix(domain);
  return host === null ? null : `@${host}`;
}

type Kept = string | number | boolean;

interface FieldAccumulator {
  types: Set<ToolArgumentValueType>;
  count: number;
  values: Map<string, Kept>;
  valuesOverflow: boolean;
  min: number | null;
  max: number | null;
  mag: number | null;
  hashes: Set<string>;
  hashesOverflow: boolean;
  prefixes: Set<string>;
  prefixesOverflow: boolean;
  classes: Set<string>;
  lenIndex: number;
  items: number;
  keys: number;
}

interface ScanResult {
  classes: string[];
  /** False when the string was not (fully) scanned: too long, out of budget, or the detector threw. */
  complete: boolean;
}

/** What the keys above a value say about it. */
interface PathContext {
  sensitive: boolean;
  location: boolean;
  /** Under a token-budget key (`max_tokens`) with no sensitive ancestor: numbers follow the normal rules. */
  tokenCount: boolean;
}

type SchemaNode = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** A schema node with the branches of its combinators, a few levels deep. */
function expandSchema(node: unknown, depth = 0, out: SchemaNode[] = []): SchemaNode[] {
  if (!isRecord(node) || out.length >= 32) return out;
  out.push(node);
  if (depth >= 3) return out;
  for (const combinator of ["anyOf", "oneOf", "allOf"]) {
    const branches = ownValue(node, combinator);
    if (Array.isArray(branches)) {
      for (const branch of branches.slice(0, 16)) expandSchema(branch, depth + 1, out);
    }
  }
  return out;
}

function childSchemas(nodes: SchemaNode[], segment: string | null): SchemaNode[] {
  const out: SchemaNode[] = [];
  for (const node of nodes) {
    let child: unknown;
    if (segment === null) {
      child = ownValue(node, "items");
    } else {
      const properties = ownValue(node, "properties");
      child = isRecord(properties) ? ownValue(properties, segment) : undefined;
      if (child === undefined) {
        const additional = ownValue(node, "additionalProperties");
        if (isRecord(additional)) child = additional;
      }
    }
    expandSchema(child, 0, out);
    if (out.length >= 32) break;
  }
  return out;
}

function schemaAllows(nodes: SchemaNode[], value: string): boolean {
  for (const node of nodes) {
    const options = ownValue(node, "enum");
    if (Array.isArray(options) && options.includes(value)) return true;
    if (ownValue(node, "const") === value) return true;
  }
  return false;
}

function compareKept(a: Kept, b: Kept): number {
  const order = (value: Kept) => (typeof value === "boolean" ? 0 : typeof value === "number" ? 1 : 2);
  const byType = order(a) - order(b);
  if (byType !== 0) return byType;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Summarise one tool call's arguments. Never throws for any JSON value, and
 * never returns argument text other than kept values and prefixes.
 */
export function summarizeToolArguments(args: unknown, options: SummarizeToolArgumentsOptions): ToolArgumentSummary {
  const fields = new Map<string, FieldAccumulator>();
  let truncated = false;
  let nodes = 0;
  let scanned = 0;
  const hash = (value: string | number | boolean) => hashToolArgumentValue(value, options.hashKey);

  const scan = (text: string): ScanResult => {
    if (text.length > LIMITS.maxScanChars || scanned + text.length > LIMITS.scanBudgetChars) {
      truncated = true;
      // A long string is still scanned up to the per-string cap while budget remains, for its classes.
      const head = text.slice(0, LIMITS.maxScanChars);
      if (scanned + head.length > LIMITS.scanBudgetChars) return { classes: [], complete: false };
      scanned += head.length;
      try {
        return { classes: [...options.detect(head)], complete: false };
      } catch {
        return { classes: [], complete: false };
      }
    }
    scanned += text.length;
    try {
      return { classes: [...options.detect(text)], complete: true };
    } catch {
      return { classes: [], complete: false };
    }
  };

  const fieldFor = (path: string): FieldAccumulator | null => {
    const existing = fields.get(path);
    if (existing) return existing;
    if (fields.size >= LIMITS.maxFields) {
      truncated = true;
      return null;
    }
    const created: FieldAccumulator = {
      types: new Set(),
      count: 0,
      values: new Map(),
      valuesOverflow: false,
      min: null,
      max: null,
      mag: null,
      hashes: new Set(),
      hashesOverflow: false,
      prefixes: new Set(),
      prefixesOverflow: false,
      classes: new Set(),
      lenIndex: -1,
      items: -1,
      keys: -1
    };
    fields.set(path, created);
    return created;
  };

  const keep = (field: FieldAccumulator, value: Kept) => {
    if (field.valuesOverflow) return;
    const key = `${typeof value}:${String(value)}`;
    if (field.values.has(key)) return;
    if (field.values.size >= LIMITS.maxValues) {
      field.valuesOverflow = true;
      field.values.clear();
      return;
    }
    field.values.set(key, value);
  };

  const addHash = (field: FieldAccumulator, value: string | number | boolean) => {
    if (field.hashesOverflow) return;
    const digest = hash(value);
    if (field.hashes.has(digest)) return;
    if (field.hashes.size >= LIMITS.maxHashes) {
      field.hashesOverflow = true;
      field.hashes.clear();
      return;
    }
    field.hashes.add(digest);
  };

  const addPrefix = (field: FieldAccumulator, prefix: string) => {
    if (field.prefixesOverflow || field.prefixes.has(prefix)) return;
    if (field.prefixes.size >= LIMITS.maxPrefixes) {
      field.prefixesOverflow = true;
      field.prefixes.clear();
      return;
    }
    field.prefixes.add(prefix);
  };

  const addLength = (field: FieldAccumulator, length: number) => {
    field.lenIndex = Math.max(field.lenIndex, TOOL_ARGUMENT_LENGTH_BUCKETS.indexOf(toolArgumentLengthBucket(length)));
  };

  /** A prefix is kept only when the detector finds nothing in it. */
  const addCleanPrefix = (field: FieldAccumulator, prefix: string | null) => {
    if (prefix === null) return;
    const prefixScan = scan(prefix);
    if (prefixScan.complete && prefixScan.classes.length === 0) addPrefix(field, prefix);
  };

  const summarizeString = (field: FieldAccumulator, text: string, schema: SchemaNode[], context: PathContext) => {
    const normalized = text.length <= LIMITS.maxScanChars ? text.normalize("NFKC") : text;
    const result = scan(normalized);
    for (const dataClass of result.classes) field.classes.add(dataClass);
    if (result.complete && !context.sensitive) {
      if (result.classes.length === 0) {
        if (text === "" || (text.length <= MAX_ENUM_LENGTH && schemaAllows(schema, text))) {
          keep(field, text);
          return;
        }
        if (isSafeToolArgumentToken(normalized)) {
          keep(field, normalized);
          return;
        }
      }
      if (normalized.length <= LIMITS.maxIdentifierLength && !/\s/.test(normalized)) {
        if (result.classes.length === 0) {
          addCleanPrefix(field, identifierPrefix(normalized));
        } else if (result.classes.includes("email")) {
          const email = EMAIL_SHAPE.exec(normalized);
          if (email) addCleanPrefix(field, emailPrefix(email[1]!));
        }
      }
    }
    addLength(field, text.length);
    if (text.length <= LIMITS.maxHashedLength) addHash(field, text);
  };

  const summarizeNumber = (field: FieldAccumulator, value: number, context: PathContext) => {
    if (!Number.isFinite(value)) return;
    let number = Object.is(value, -0) ? 0 : value;
    if (context.location) number = Math.round(number * 10) / 10;
    const magnitude = Math.abs(number);
    if ((context.sensitive && !context.tokenCount) || magnitude >= 1e6) {
      // Seven or more integer digits may be a card, account, phone or national number written as a JSON number.
      const order = magnitude < 1 ? 0 : Math.floor(Math.log10(magnitude));
      field.mag = field.mag === null ? order : Math.max(field.mag, order);
      if (magnitude >= 1e6 && magnitude < 1e21) {
        for (const dataClass of scan(String(Math.trunc(magnitude))).classes) field.classes.add(dataClass);
      }
      addHash(field, number);
      return;
    }
    const kept = Math.round(number * 1e4) / 1e4;
    const normalized = Object.is(kept, -0) ? 0 : kept;
    keep(field, normalized);
    field.min = field.min === null ? normalized : Math.min(field.min, normalized);
    field.max = field.max === null ? normalized : Math.max(field.max, normalized);
  };

  const segmentFor = (key: string): string => {
    if (isPlainKeyName(key)) {
      const result = scan(key);
      if (result.complete && result.classes.length === 0) return key;
    }
    return `<k:${hash(key)}>`;
  };

  const walk = (value: unknown, path: string, depth: number, schema: SchemaNode[], context: PathContext): void => {
    if (value === undefined || typeof value === "function" || typeof value === "symbol") return;
    nodes += 1;
    if (nodes > LIMITS.maxNodes) {
      truncated = true;
      return;
    }
    const field = fieldFor(path);
    if (!field) return;
    field.count += 1;

    if (value === null) {
      field.types.add("null");
      return;
    }
    if (typeof value === "boolean") {
      field.types.add("boolean");
      if (context.sensitive) addHash(field, value);
      else keep(field, value);
      return;
    }
    if (typeof value === "number" || typeof value === "bigint") {
      field.types.add("number");
      if (typeof value === "number") summarizeNumber(field, value, context);
      return;
    }
    if (typeof value === "string") {
      field.types.add("string");
      summarizeString(field, value, schema, context);
      return;
    }
    if (Array.isArray(value)) {
      field.types.add("array");
      field.items = Math.max(field.items, value.length);
      if (depth >= LIMITS.maxDepth) {
        if (value.length > 0) truncated = true;
        return;
      }
      if (value.length > LIMITS.maxArrayItems) truncated = true;
      const itemSchema = childSchemas(schema, null);
      const limit = Math.min(value.length, LIMITS.maxArrayItems);
      for (let index = 0; index < limit; index += 1) {
        walk(value[index], `${path}[]`, depth + 1, itemSchema, context);
      }
      return;
    }
    if (typeof value === "object") {
      field.types.add("object");
      walkObject(value as Record<string, unknown>, path, depth, schema, field, context);
    }
  };

  const walkObject = (
    value: Record<string, unknown>,
    path: string,
    depth: number,
    schema: SchemaNode[],
    field: FieldAccumulator | null,
    context: PathContext
  ): void => {
    let keys = Object.keys(value);
    if (field) field.keys = Math.max(field.keys, keys.length);
    if (depth >= LIMITS.maxDepth) {
      if (keys.length > 0) truncated = true;
      return;
    }
    // Bound the sort on a huge object; the summary is marked truncated then anyway.
    if (keys.length > LIMITS.maxKeysPerObject * 16) keys = keys.slice(0, LIMITS.maxKeysPerObject * 16);
    keys.sort(compareText);
    if (keys.length > LIMITS.maxKeysPerObject) {
      truncated = true;
      keys = keys.slice(0, LIMITS.maxKeysPerObject);
    }
    for (const key of keys) {
      let child: unknown;
      try {
        child = value[key];
      } catch {
        truncated = true;
        continue;
      }
      const segment = segmentFor(key);
      const childPath = path ? `${path}.${segment}` : segment;
      // Sensitivity and location are inherited: a value under `password.value` or `geo.point.x` is still one.
      const childContext: PathContext = {
        sensitive: context.sensitive || isSensitiveToolArgumentKey(key),
        location: context.location || isLocationKey(key),
        tokenCount: !context.sensitive && isToolArgumentTokenCountKey(key)
      };
      walk(child, childPath, depth + 1, childSchemas(schema, key), childContext);
    }
  };

  const rootSchema = expandSchema(options.inputSchema);
  const rootContext: PathContext = { sensitive: false, location: false, tokenCount: false };
  if (isRecord(args)) {
    walkObject(args, "", 0, rootSchema, null, rootContext);
  } else if (args !== undefined && args !== null) {
    walk(args, "$", 0, rootSchema, rootContext);
  }

  const entries: Array<[string, ToolArgumentFieldSummary]> = [...fields.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([path, field]) => [path, finishField(field)]);
  return {
    v: TOOL_ARGUMENT_SUMMARY_VERSION,
    fields: Object.fromEntries(entries),
    ...(truncated ? { truncated: true as const } : {})
  };
}

function finishField(field: FieldAccumulator): ToolArgumentFieldSummary {
  const types = TYPE_ORDER.filter((type) => field.types.has(type));
  const summary: ToolArgumentFieldSummary = types.length === 1 ? { type: types[0]! } : { type: "mixed", types };
  if (field.count > 1) summary.count = field.count;
  if (field.values.size > 0) summary.values = [...field.values.values()].sort(compareKept);
  if (field.min !== null && field.max !== null) {
    summary.min = field.min;
    summary.max = field.max;
  }
  if (field.mag !== null) summary.mag = field.mag;
  if (field.hashes.size > 0) summary.hashes = [...field.hashes].sort(compareText);
  if (field.prefixes.size > 0) summary.prefixes = [...field.prefixes].sort(compareText);
  if (field.valuesOverflow || field.hashesOverflow || field.prefixesOverflow) summary.more = true;
  if (field.classes.size > 0) summary.classes = [...field.classes].sort(compareText);
  if (field.lenIndex >= 0) summary.len = TOOL_ARGUMENT_LENGTH_BUCKETS[field.lenIndex];
  if (field.items >= 0) summary.items = field.items;
  if (field.keys >= 0) summary.keys = field.keys;
  return summary;
}
