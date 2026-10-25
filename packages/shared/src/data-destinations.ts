import { z } from "zod";
import { dataClassNameSchema } from "./data-labels";

/**
 * Phase 16 — data destinations: where outgoing data goes and how far that is
 * from home. A destination is a model provider, an MCP server, a connector or
 * a plain HTTP host. Each one resolves to a tier:
 *
 *   - local: this machine (loopback)
 *   - private: the organisation's own network (RFC 1918, ULA, link-local, `.internal`, `.local`)
 *   - vendor: a provider under contract (the built-in model providers' default hosts)
 *   - public: anything else, including every destination nobody classified
 *
 * Admins classify destinations in rows (`data_destinations`); built-in rows
 * cover loopback, private ranges and the model providers' default hosts and
 * can be overridden by an admin row. Destinations do nothing on their own: a
 * guard profile's destination rules decide what may go where.
 *
 * Everything here is pure (no DNS, no I/O) so the browser, the API and the
 * engine resolve a destination the same way.
 */

export const DESTINATION_TIERS = ["local", "private", "vendor", "public"] as const;
export type DestinationTier = (typeof DESTINATION_TIERS)[number];
export const destinationTierSchema = z.enum(DESTINATION_TIERS);

export const DESTINATION_KINDS = ["model_provider", "mcp_server", "connector", "http"] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];
export const destinationKindSchema = z.enum(DESTINATION_KINDS);

/** Plain-language names for the tiers, for the UI and verdict reasons. */
export const DESTINATION_TIER_LABELS: Record<DestinationTier, string> = {
  local: "Local (this machine)",
  private: "Private network",
  vendor: "Approved vendor",
  public: "Public"
};

export const DESTINATION_KIND_LABELS: Record<DestinationKind, string> = {
  model_provider: "Model provider",
  mcp_server: "MCP server",
  connector: "Connector",
  http: "Web address"
};

/** Region of a destination nobody tagged. Region rules never allow it unless they list it. */
export const UNKNOWN_REGION = "unknown";

/** Where a call is going, as the caller knows it at call time. */
export interface DestinationRef {
  kind: DestinationKind;
  /** Provider id, MCP server registry id, or connector type. */
  id?: string;
  /**
   * Host name or IP literal of the effective URL, taken from `URL.hostname`
   * (a `:port` or IPv6 brackets are tolerated; anything else that is not a
   * plain host, such as `user@host`, resolves as public).
   */
  host?: string;
}

export interface ResolvedDestination {
  tier: DestinationTier;
  region: string;
  /** Data classes this destination is approved to hold, whatever its tier. */
  holdsDataClasses: string[];
  matchedBy: "row" | "builtin" | "unmatched";
  rowId?: string;
  /** The matching row's name, when one matched. */
  name?: string;
}

/** Tier order from nearest to furthest. A higher rank is stricter (treated as more exposed). */
export function destinationTierRank(tier: DestinationTier): number {
  return DESTINATION_TIERS.indexOf(tier);
}

/** True when `tier` is further out than `maxTier` allows. */
export function destinationTierExceeds(tier: DestinationTier, maxTier: DestinationTier): boolean {
  return destinationTierRank(tier) > destinationTierRank(maxTier);
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

/** A region tag in canonical form: lower case, words joined by `-` (`EU West 1` → `eu-west-1`); empty → `unknown`. */
export function normalizeRegion(value: string | null | undefined): string {
  const tag = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return tag || UNKNOWN_REGION;
}

/** True when `region` is one of `allowed` or sits under one of them by prefix (`eu` covers `eu-west-1`, not `europe`). */
export function regionAllowed(region: string, allowed: readonly string[]): boolean {
  const tag = normalizeRegion(region);
  return allowed.some((entry) => {
    const prefix = normalizeRegion(entry);
    return tag === prefix || tag.startsWith(`${prefix}-`);
  });
}

// ---------------------------------------------------------------------------
// Hosts, wildcards and CIDR ranges
// ---------------------------------------------------------------------------

type IpBytes = { family: 4 | 6; bytes: number[] };

function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function parseIpv6(input: string): number[] | null {
  if (!input.includes(":")) return null;
  let text = input;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    // An embedded IPv4 tail (`::ffff:10.0.0.1`) stands for the last two groups.
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const left = toGroups(halves[0]!);
  const right = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!left || !right) return null;
  const present = left.length + right.length;
  if (halves.length === 1 && present !== 8) return null;
  if (halves.length === 2 && present > 7) return null;
  const groups = [...left, ...Array<number>(8 - present).fill(0), ...right];
  const bytes: number[] = [];
  for (const group of groups) bytes.push(group >> 8, group & 0xff);
  return bytes;
}

/** An IP literal as bytes; IPv4-mapped IPv6 addresses (`::ffff:10.0.0.1`) read as IPv4. */
function parseIp(text: string): IpBytes | null {
  const v4 = parseIpv4(text);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = parseIpv6(text);
  if (!v6 || v6.length !== 16) return null;
  const mapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
  if (mapped) return { family: 4, bytes: v6.slice(12) };
  return { family: 6, bytes: v6 };
}

function ipToString(ip: IpBytes): string {
  if (ip.family === 4) return ip.bytes.join(".");
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((ip.bytes[i]! << 8) | ip.bytes[i + 1]!).toString(16));
  // Compress the longest run of zero groups (two or more).
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== "0") {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === "0") j += 1;
    if (j - i > bestLength && j - i > 1) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  if (bestStart < 0) return groups.join(":");
  return `${groups.slice(0, bestStart).join(":")}::${groups.slice(bestStart + bestLength).join(":")}`;
}

const HOST_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** A DNS name. A last label of digits (or `0x` hex) is refused: it would be an unusual spelling of an IP address. */
function validHostname(host: string): boolean {
  if (!host || host.length > 253) return false;
  const labels = host.split(".");
  if (/^(?:\d+|0x[0-9a-f]*)$/.test(labels[labels.length - 1]!)) return false;
  return labels.every((label) => HOST_LABEL.test(label));
}

/** A port is 1–5 digits and at most 65535 (an empty one is refused). */
function validPort(text: string): boolean {
  return /^\d{1,5}$/.test(text) && Number(text) <= 65535;
}

/**
 * A host in canonical form: lower case, no trailing dot, no brackets or port,
 * IP literals in their canonical spelling. Undefined when it is not a host
 * name: anything that looks like more of a URL or authority (`@`, `/`, `\`,
 * `?`, `#`, whitespace, a port that is not 1–65535, text after `]` other
 * than a port) is refused, so it resolves as public. Callers pass
 * `URL.hostname`, never `URL.host` or the authority.
 */
export function normalizeDestinationHost(value: string | null | undefined): string | undefined {
  let host = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!host) return undefined;
  if (/[@/\\?#\s]/.test(host)) return undefined;
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close < 0) return undefined;
    const rest = host.slice(close + 1);
    if (rest !== "" && !(rest.startsWith(":") && validPort(rest.slice(1)))) return undefined;
    host = host.slice(1, close);
    if (!host.includes(":")) return undefined;
  } else if ((host.match(/:/g) ?? []).length === 1) {
    const colon = host.indexOf(":");
    if (!validPort(host.slice(colon + 1))) return undefined;
    host = host.slice(0, colon);
  }
  host = host.replace(/\.$/, "");
  const ip = parseIp(host);
  if (ip) return ipToString(ip);
  if (host.includes(":")) return undefined;
  return validHostname(host) ? host : undefined;
}

/** The host of a URL in canonical form, or undefined when the text is not a URL with a host. */
export function destinationHostOfUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return normalizeDestinationHost(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

export type HostPattern =
  | { type: "exact"; host: string }
  | { type: "wildcard"; suffix: string }
  | { type: "cidr"; family: 4 | 6; bytes: number[]; prefix: number };

/** Reads a row's host field: an exact host or IP, `*.suffix`, or a CIDR range. Undefined when it is none of these. */
export function parseHostPattern(value: string | null | undefined): HostPattern | undefined {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!text) return undefined;
  if (text.startsWith("*.")) {
    const suffix = text.slice(2).replace(/\.$/, "");
    if (!validHostname(suffix) || parseIp(suffix)) return undefined;
    return { type: "wildcard", suffix };
  }
  const slash = text.indexOf("/");
  if (slash >= 0) {
    const ip = parseIp(text.slice(0, slash));
    const bits = text.slice(slash + 1);
    if (!ip || !/^\d{1,3}$/.test(bits)) return undefined;
    // An IPv4-mapped range (`::ffff:10.0.0.0/104`) is read as the IPv4 range it covers.
    const mappedOffset = ip.family === 4 && text.slice(0, slash).includes(":") ? 96 : 0;
    const prefix = Number(bits) - mappedOffset;
    const max = ip.family === 4 ? 32 : 128;
    if (prefix < 0 || prefix > max) return undefined;
    return { type: "cidr", family: ip.family, bytes: ip.bytes, prefix };
  }
  const host = normalizeDestinationHost(text);
  return host ? { type: "exact", host } : undefined;
}

function cidrContains(pattern: Extract<HostPattern, { type: "cidr" }>, ip: IpBytes): boolean {
  if (pattern.family !== ip.family) return false;
  let remaining = pattern.prefix;
  for (let i = 0; remaining > 0; i += 1) {
    const take = Math.min(8, remaining);
    const mask = (0xff << (8 - take)) & 0xff;
    if ((pattern.bytes[i]! & mask) !== (ip.bytes[i]! & mask)) return false;
    remaining -= take;
  }
  return true;
}

/** A CIDR range in canonical form: the network address (host bits cleared) and the prefix (`10.0.0.1/8` → `10.0.0.0/8`). */
function cidrToString(pattern: Extract<HostPattern, { type: "cidr" }>): string {
  let remaining = pattern.prefix;
  const bytes = pattern.bytes.map((byte) => {
    const take = Math.max(0, Math.min(8, remaining));
    remaining -= 8;
    return byte & ((0xff << (8 - take)) & 0xff);
  });
  return `${ipToString({ family: pattern.family, bytes })}/${pattern.prefix}`;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const targetIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/, "Use letters, digits, '_', '.', ':' and '-' only");

/**
 * An international host name typed by an admin (`bücher.example`, `*.bücher.example`)
 * is stored in its punycode form, the spelling every URL hostname has. Text that
 * is plain ASCII, or is not a bare host name, is returned unchanged for the
 * normal validation to judge.
 */
function unicodeHostToAscii(value: string | null | undefined): string | null | undefined {
  if (!value || !/[^\x00-\x7f]/.test(value) || /[@/\\?#\s%:\[\]]/.test(value)) return value;
  const wildcard = value.startsWith("*.");
  try {
    const hostname = new URL(`http://${wildcard ? value.slice(2) : value}`).hostname;
    return /[^\x00-\x7f]/.test(hostname) ? value : wildcard ? `*.${hostname}` : hostname;
  } catch {
    return value;
  }
}

const SCRIPTS = ["Latin", "Cyrillic", "Greek", "Armenian", "Hebrew", "Arabic", "Georgian", "Thai", "Devanagari", "Han", "Hiragana", "Katakana", "Hangul"] as const;
const SCRIPT_TESTS = SCRIPTS.map((script) => [script, new RegExp(`\\p{Script=${script}}`, "u")] as const);
const JAPANESE_OR_KOREAN = new Set<string>(["Han", "Hiragana", "Katakana", "Hangul"]);

/**
 * True when one label of a host name mixes alphabets (Latin with Cyrillic, say),
 * which is how lookalike names are made. Han with Japanese kana or Hangul is how
 * those languages are written and is allowed. A letter in a script this list does
 * not know counts as its own alphabet, so it cannot hide among Latin letters.
 */
export function hostMixesAlphabets(host: string): boolean {
  for (const label of host.split(".")) {
    const found = new Set<string>();
    for (const char of label) {
      if (!/\p{L}/u.test(char)) continue;
      found.add(SCRIPT_TESTS.find(([, test]) => test.test(char))?.[0] ?? `other:${char}`);
    }
    if (found.size < 2) continue;
    if ([...found].every((script) => JAPANESE_OR_KOREAN.has(script))) continue;
    return true;
  }
  return false;
}

const MIXED_ALPHABETS_MESSAGE =
  "This host mixes alphabets, which is how lookalike names are made; enter it in one alphabet or as xn-- punycode";

/** What an admin sends to create or change a destination row. */
export const dataDestinationInputSchema = z
  .object({
    name: z.string().trim().min(1, "Give the destination a name").max(120, "Keep the name under 120 characters"),
    kind: destinationKindSchema,
    /** Provider id, MCP server registry id, or connector type. Not used for web addresses. */
    targetId: targetIdSchema.nullish(),
    /** Exact host or IP, `*.suffix`, or a CIDR range such as `10.20.0.0/16`. */
    host: z
      .string()
      .trim()
      .max(260)
      .nullish()
      .refine((value) => !value || !/[^\x00-\x7f]/.test(value) || !hostMixesAlphabets(value), { message: MIXED_ALPHABETS_MESSAGE })
      .transform(unicodeHostToAscii),
    tier: destinationTierSchema,
    region: z.string().trim().max(64).nullish(),
    holdsDataClasses: z.array(dataClassNameSchema).max(50).default([]),
    note: z.string().trim().max(500).nullish()
  })
  .superRefine((value, ctx) => {
    const host = value.host?.trim() || undefined;
    const pattern = host ? parseHostPattern(host) : undefined;
    if (host && !pattern) {
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message: "Enter a host name (api.example.com), a wildcard (*.corp.example) or an IP range (10.0.0.0/8)"
      });
    }
    if (pattern && pattern.type !== "exact" && value.kind !== "http") {
      ctx.addIssue({ code: "custom", path: ["host"], message: "Wildcards and IP ranges are for web addresses; use an exact host here" });
    }
    if (value.kind === "http") {
      if (value.targetId) ctx.addIssue({ code: "custom", path: ["targetId"], message: "A web address is matched by its host only" });
      if (!host) ctx.addIssue({ code: "custom", path: ["host"], message: "A web address needs a host, a wildcard or an IP range" });
    }
    if (value.kind === "model_provider" && !value.targetId) {
      ctx.addIssue({ code: "custom", path: ["targetId"], message: "Choose the model provider (for example openai)" });
    }
    if (value.kind === "connector" && !value.targetId) {
      ctx.addIssue({ code: "custom", path: ["targetId"], message: "Choose the connector type" });
    }
    if (value.kind === "mcp_server" && !value.targetId && !host) {
      ctx.addIssue({ code: "custom", path: ["targetId"], message: "Choose the MCP server or enter its host" });
    }
  });
export type DataDestinationInput = z.input<typeof dataDestinationInputSchema>;

/** A stored (or built-in) destination row as the API returns it. */
export const dataDestinationRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: destinationKindSchema,
  targetId: z.string().nullable().default(null),
  host: z.string().nullable().default(null),
  tier: destinationTierSchema,
  region: z.string().default(UNKNOWN_REGION),
  holdsDataClasses: z.array(z.string()).default([]),
  note: z.string().nullable().default(null),
  builtIn: z.boolean().default(false),
  createdAt: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
  createdBy: z.string().nullable().default(null),
  updatedBy: z.string().nullable().default(null)
});
export type DataDestinationRow = z.output<typeof dataDestinationRowSchema>;

/** Canonical stored form of validated input: trimmed, host normalised, region tagged, classes sorted and unique. */
export function normalizeDataDestinationInput(input: z.output<typeof dataDestinationInputSchema>): Pick<
  DataDestinationRow,
  "name" | "kind" | "targetId" | "host" | "tier" | "region" | "holdsDataClasses" | "note"
> {
  const pattern = input.host ? parseHostPattern(input.host) : undefined;
  let host: string | null = null;
  if (pattern?.type === "exact") host = pattern.host;
  else if (pattern?.type === "wildcard") host = `*.${pattern.suffix}`;
  else if (pattern?.type === "cidr") host = cidrToString(pattern);
  return {
    name: input.name.trim(),
    kind: input.kind,
    targetId: input.kind === "http" ? null : input.targetId?.trim() || null,
    host,
    tier: input.tier,
    region: normalizeRegion(input.region),
    holdsDataClasses: [...new Set(input.holdsDataClasses)].sort(),
    note: input.note?.trim() || null
  };
}

function builtin(id: string, name: string, host: string, tier: DestinationTier): DataDestinationRow {
  return {
    id: `builtin:${id}`,
    name,
    kind: "http",
    targetId: null,
    host,
    tier,
    region: UNKNOWN_REGION,
    holdsDataClasses: [],
    note: null,
    builtIn: true,
    createdAt: null,
    updatedAt: null,
    createdBy: null,
    updatedBy: null
  };
}

/**
 * Read-only rows every deployment has. An admin row for the same host or
 * range, or a more specific one, overrides them. The vendor hosts are the
 * built-in default base URLs of the model provider adapters (provider-sdk);
 * Azure OpenAI has no default, so its standard resource domain stands in.
 */
export const BUILTIN_DESTINATIONS: readonly DataDestinationRow[] = Object.freeze([
  builtin("localhost", "This machine (localhost)", "localhost", "local"),
  builtin("localhost-names", "This machine (*.localhost)", "*.localhost", "local"),
  builtin("loopback-v4", "Loopback (127.0.0.0/8)", "127.0.0.0/8", "local"),
  builtin("loopback-v6", "Loopback (::1)", "::1/128", "local"),
  builtin("rfc1918-10", "Private network (10.0.0.0/8)", "10.0.0.0/8", "private"),
  builtin("rfc1918-172", "Private network (172.16.0.0/12)", "172.16.0.0/12", "private"),
  builtin("rfc1918-192", "Private network (192.168.0.0/16)", "192.168.0.0/16", "private"),
  builtin("ula", "Private network (fc00::/7)", "fc00::/7", "private"),
  builtin("link-local-v4", "Link-local (169.254.0.0/16)", "169.254.0.0/16", "private"),
  builtin("link-local-v6", "Link-local (fe80::/10)", "fe80::/10", "private"),
  builtin("internal", "Internal names (*.internal)", "*.internal", "private"),
  builtin("local-names", "Local names (*.local)", "*.local", "private"),
  builtin("openai", "OpenAI", "api.openai.com", "vendor"),
  builtin("anthropic", "Anthropic", "api.anthropic.com", "vendor"),
  builtin("gemini", "Google Gemini", "generativelanguage.googleapis.com", "vendor"),
  builtin("azure-openai", "Azure OpenAI", "*.openai.azure.com", "vendor")
]) as readonly DataDestinationRow[];

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** How specific a match is: exact id (4) > exact host (3) > wildcard (2) > CIDR (1); `detail` breaks ties inside a class. */
interface MatchStrength {
  rank: number;
  detail: number;
}

function matchRow(row: DataDestinationRow, ref: DestinationRef, host: string | undefined, ip: IpBytes | null): MatchStrength | null {
  if (row.kind !== ref.kind && row.kind !== "http") return null;
  const pattern = row.host ? parseHostPattern(row.host) : undefined;
  const hostMatch = (): MatchStrength | null => {
    if (!pattern || !host) return null;
    if (pattern.type === "exact") return pattern.host === host ? { rank: 3, detail: 0 } : null;
    if (pattern.type === "wildcard") return !ip && host.endsWith(`.${pattern.suffix}`) ? { rank: 2, detail: pattern.suffix.length } : null;
    return ip && cidrContains(pattern, ip) ? { rank: 1, detail: pattern.prefix } : null;
  };
  if (row.kind !== "http" && row.targetId) {
    if (!ref.id || ref.id !== row.targetId) return null;
    if (row.host) return hostMatch() ? { rank: 4, detail: 1 } : null;
    return { rank: 4, detail: 0 };
  }
  return hostMatch();
}

function compareCandidates(
  a: { strength: MatchStrength; row: DataDestinationRow },
  b: { strength: MatchStrength; row: DataDestinationRow }
): number {
  if (a.strength.rank !== b.strength.rank) return b.strength.rank - a.strength.rank;
  if (a.strength.detail !== b.strength.detail) return b.strength.detail - a.strength.detail;
  // An admin row overrides a built-in one that matches as specifically.
  if (a.row.builtIn !== b.row.builtIn) return a.row.builtIn ? 1 : -1;
  // Equally specific rows of the same origin: the stricter tier wins.
  return destinationTierRank(b.row.tier) - destinationTierRank(a.row.tier);
}

export const UNMATCHED_DESTINATION: Readonly<ResolvedDestination> = Object.freeze({
  tier: "public",
  region: UNKNOWN_REGION,
  holdsDataClasses: [],
  matchedBy: "unmatched"
}) as Readonly<ResolvedDestination>;

function resolvedFrom(row: DataDestinationRow): ResolvedDestination {
  return {
    tier: row.tier,
    region: normalizeRegion(row.region),
    holdsDataClasses: [...row.holdsDataClasses],
    matchedBy: row.builtIn ? "builtin" : "row",
    rowId: row.id,
    name: row.name
  };
}

function matchingRows(
  ref: DestinationRef,
  host: string | undefined,
  rows: readonly DataDestinationRow[]
): Array<{ strength: MatchStrength; row: DataDestinationRow }> {
  const ip = host ? parseIp(host) : null;
  const seen = new Set<string>();
  const candidates: Array<{ strength: MatchStrength; row: DataDestinationRow }> = [];
  for (const row of [...rows, ...BUILTIN_DESTINATIONS]) {
    if (row.builtIn) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
    }
    const strength = matchRow(row, ref, host, ip);
    if (strength) candidates.push({ strength, row });
  }
  candidates.sort(compareCandidates);
  return candidates;
}

function bestMatch(
  ref: DestinationRef,
  host: string | undefined,
  rows: readonly DataDestinationRow[]
): { strength: MatchStrength; row: DataDestinationRow } | undefined {
  return matchingRows(ref, host, rows)[0];
}

/**
 * The strictest of several resolutions: its tier, only the data classes every
 * one of them is approved to hold, and its region only when every resolution
 * of that tier agrees (else unknown). The first of equally strict ones names it.
 */
function strictestOf(hops: readonly ResolvedDestination[]): { result: ResolvedDestination; hopIndex: number } {
  let hopIndex = 0;
  hops.forEach((hop, index) => {
    if (destinationTierRank(hop.tier) > destinationTierRank(hops[hopIndex]!.tier)) hopIndex = index;
  });
  const strictest = hops[hopIndex]!;
  const sameTier = hops.filter((hop) => hop.tier === strictest.tier);
  const region = sameTier.every((hop) => hop.region === strictest.region) ? strictest.region : UNKNOWN_REGION;
  const holdsDataClasses = strictest.holdsDataClasses.filter((dataClass) => hops.every((hop) => hop.holdsDataClasses.includes(dataClass)));
  return { result: { ...strictest, region, holdsDataClasses }, hopIndex };
}

/**
 * The tier, region and approved data classes of a destination. Admin `rows`
 * are considered with the built-in rows; the most specific match wins
 * (exact id > exact host > longest wildcard suffix > narrowest CIDR), an
 * admin row beats an equally specific built-in, and among equally specific
 * rows the stricter tier wins. A destination nothing matches is public.
 *
 * A row matched by id alone (a provider id, MCP server id or connector type
 * with no host) can only make a call stricter: the host is set by whoever
 * builds the workflow, not by the admin. When the call has a host, the result
 * is the strictest of the id rows and the host's own resolution (built-ins,
 * host rows, else public), with only the classes all of them approve and a
 * region only when the host's own result and every id row
 * agree; on a tie the host's resolution names the result. A host that is
 * given (even empty) but is not a plain host name resolves as public.
 */
export function resolveDestination(ref: DestinationRef, rows: readonly DataDestinationRow[]): ResolvedDestination {
  const hostGiven = ref.host !== undefined && ref.host !== null;
  const host = normalizeDestinationHost(ref.host);
  const candidates = matchingRows(ref, host, rows);
  const best = candidates[0];
  const idOnly = best !== undefined && best.strength.rank === 4 && best.strength.detail === 0;
  if (best && !(idOnly && hostGiven)) return resolvedFrom(best.row);
  if (!best) return { ...UNMATCHED_DESTINATION, holdsDataClasses: [] };
  // Id-only rows against a call with a host: the strictest of all of them and the host's own result.
  const idRows = candidates
    .filter((candidate) => candidate.strength.rank === 4 && candidate.strength.detail === 0)
    .map((candidate) => resolvedFrom(candidate.row));
  const hostBest = host ? bestMatch({ kind: ref.kind, host }, host, rows) : undefined;
  const byHost = hostBest ? resolvedFrom(hostBest.row) : { ...UNMATCHED_DESTINATION, holdsDataClasses: [] };
  const all = [byHost, ...idRows];
  const { result } = strictestOf(all);
  // A region tag is the host's to claim: an id row never supplies one.
  return all.every((hop) => hop.region === result.region) ? result : { ...result, region: UNKNOWN_REGION };
}

export interface ResolvedRedirectChain extends ResolvedDestination {
  /** Every hop, in order. */
  hops: ResolvedDestination[];
  /** Index of the hop the result was taken from. */
  hopIndex: number;
}

/**
 * A request that was redirected is judged by its strictest hop: the result is
 * that hop's tier, with only the data classes every hop is approved to hold.
 * When hops of that tier disagree on the region, the region is unknown. An
 * empty chain is unmatched (public).
 */
export function resolveRedirectChain(refs: readonly DestinationRef[], rows: readonly DataDestinationRow[]): ResolvedRedirectChain {
  const hops = refs.map((ref) => resolveDestination(ref, rows));
  if (hops.length === 0) return { ...UNMATCHED_DESTINATION, holdsDataClasses: [], hops: [], hopIndex: -1 };
  const { result, hopIndex } = strictestOf(hops);
  return { ...result, hops, hopIndex };
}

// ---------------------------------------------------------------------------
// "Not classified yet"
// ---------------------------------------------------------------------------

/** A destination the deployment is configured to reach that no admin row covers yet. */
export interface UnclassifiedDestination {
  kind: DestinationKind;
  targetId?: string;
  host?: string;
  /** Where it was found, for the UI ("Workflow Support bot · node Ask model", "MCP server github"). */
  seenIn: string[];
  /** Set when the call goes over the network but its host cannot be read from the settings. */
  hostUnknown?: "unreadable" | "secret";
  /** What it resolves to today (a built-in row or public). */
  current: ResolvedDestination;
  /** A ready-made row for one-click Classify. */
  suggestion: { name: string; kind: DestinationKind; targetId: string | null; host: string | null; tier: DestinationTier };
}

/** A place the deployment is configured to send data, found in its settings (never in traffic). */
export interface ConfiguredDestination {
  ref: DestinationRef;
  seenIn: string;
  /** The host is kept in a secret (never read here); the call is judged as public until classified. */
  hostInSecret?: boolean;
}

/**
 * The ref for a call that goes over the network. `host` is the host read from
 * the settings, or undefined when it cannot be read (templated, malformed, in
 * a secret): the ref then carries an empty host, which resolves as public, so
 * an id row can never stand in for a host nobody knows. Calls that send nothing
 * over the network have no ref at all (do not call this for them).
 */
export function networkDestinationRef(kind: DestinationKind, id: string | undefined, host: string | undefined): DestinationRef {
  return { kind, ...(id ? { id } : {}), host: host ?? "" };
}

const MAX_SEEN_IN = 5;

/**
 * Configured destinations no row covers: they count as public today. Grouped
 * by kind, id and host, sorted by kind then name, each with a suggested row
 * for one-click Classify: the host is filled in whenever one is known (a row
 * without a host can only make calls stricter) and the tier starts at public,
 * the tier the destination has today; the admin picks a looser one on purpose.
 */
export function findUnclassifiedDestinations(configured: readonly ConfiguredDestination[], rows: readonly DataDestinationRow[]): UnclassifiedDestination[] {
  const groups = new Map<string, UnclassifiedDestination>();
  for (const entry of configured) {
    const host = normalizeDestinationHost(entry.ref.host);
    const targetId = entry.ref.kind === "http" ? undefined : entry.ref.id?.trim() || undefined;
    if (!host && !targetId) continue;
    // A host that was given but cannot be read stays "unknown" (public), never "no host".
    const hostUnknown: UnclassifiedDestination["hostUnknown"] =
      !host && entry.ref.host !== undefined && entry.ref.host !== null ? (entry.hostInSecret ? "secret" : "unreadable") : undefined;
    const key = `${entry.ref.kind}\u0000${targetId ?? ""}\u0000${host ?? ""}\u0000${hostUnknown ?? ""}`;
    const existing = groups.get(key);
    if (existing) {
      if (!existing.seenIn.includes(entry.seenIn) && existing.seenIn.length < MAX_SEEN_IN) existing.seenIn.push(entry.seenIn);
      continue;
    }
    const ref: DestinationRef = { kind: entry.ref.kind, ...(targetId ? { id: targetId } : {}), ...(host ? { host } : hostUnknown ? { host: "" } : {}) };
    const current = resolveDestination(ref, rows);
    if (current.matchedBy !== "unmatched") continue;
    const suggestedKind: DestinationKind = entry.ref.kind === "connector" && !targetId ? "http" : entry.ref.kind;
    groups.set(key, {
      kind: entry.ref.kind,
      ...(targetId ? { targetId } : {}),
      ...(host ? { host } : {}),
      ...(hostUnknown ? { hostUnknown } : {}),
      seenIn: [entry.seenIn],
      current,
      suggestion: {
        name: host ?? targetId!,
        kind: suggestedKind,
        targetId: suggestedKind === "http" ? null : targetId ?? null,
        host: host ?? null,
        // The tier it has today: the admin picks a looser one on purpose.
        tier: "public"
      }
    });
  }
  return [...groups.values()].sort(
    (a, b) => DESTINATION_KINDS.indexOf(a.kind) - DESTINATION_KINDS.indexOf(b.kind) || a.suggestion.name.localeCompare(b.suggestion.name)
  );
}

// ---------------------------------------------------------------------------
// Call-time refs (Phase 16, p3): one mapping from settings to a destination,
// shared by the "not classified yet" list and the engine's checks, so a call
// and its classification always agree.
// ---------------------------------------------------------------------------

/**
 * Connectors that always call one vendor API: the host each one calls,
 * whatever else its settings hold.
 */
export const CONNECTOR_FIXED_HOSTS: Readonly<Record<string, string>> = Object.freeze({
  github_action: "api.github.com",
  google_sheets_read: "sheets.googleapis.com",
  google_sheets_append: "sheets.googleapis.com",
  google_sheets_update: "sheets.googleapis.com",
  google_calendar_create_event: "www.googleapis.com",
  google_calendar_list_events: "www.googleapis.com",
  notion_create_page: "api.notion.com",
  notion_query_database: "api.notion.com",
  airtable_create_record: "api.airtable.com",
  airtable_list_records: "api.airtable.com",
  airtable_update_record: "api.airtable.com",
  hubspot_create_contact: "api.hubapi.com",
  hubspot_get_contact: "api.hubapi.com",
  stripe_create_customer: "api.stripe.com",
  stripe_create_charge: "api.stripe.com",
  telegram_send_message: "api.telegram.org",
  twilio_send_sms: "api.twilio.com"
});

/** A host from a URL or a bare host value; templated or unreadable values give nothing. */
export function destinationHostOfSetting(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  if (text.includes("{{")) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return destinationHostOfUrl(text);
  return text.includes("/") ? undefined : normalizeDestinationHost(text);
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textSetting(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value.trim() : "";
}

/** The host of a URL built exactly as a handler builds it (so odd values that move the authority are seen as they are). */
function hostOfBuiltUrl(url: string): string | undefined {
  if (url.includes("{{")) return undefined;
  return destinationHostOfUrl(url);
}

/**
 * What a connector's address comes from: a fixed vendor host, the host its
 * settings name, nothing at all (a stub with no network), or an unknown host.
 * `undefined` = an unknown host (public); `null` = sends nothing.
 */
type AddressOf = (config: Record<string, unknown>, secretAddress: string | undefined) => string | undefined | null;

const fromKey = (key: string): AddressOf => (config) => destinationHostOfSetting(config[key]);

/** connector-sdk adapters (connector_source and the dedicated nodes), by connector id: their real address keys only. */
const CONNECTOR_SDK_ADDRESS: Readonly<Record<string, AddressOf>> = {
  "google-drive": (config) => (textSetting(config, "baseUrl") ? destinationHostOfSetting(config.baseUrl) : "www.googleapis.com"),
  // Demo stubs: they return sample rows and open no connection.
  "sql-db": () => null,
  "nosql-db": () => null,
  "azure-storage": (config) => {
    if (textSetting(config, "endpoint")) return destinationHostOfSetting(config.endpoint);
    const account = textSetting(config, "accountName");
    // Without an endpoint or an account the address can come from the secret: unknown.
    return account ? hostOfBuiltUrl(`https://${account}.blob.core.windows.net/`) : undefined;
  },
  "azure-cosmos-db": fromKey("endpoint"),
  "azure-monitor": (config) => {
    const operation = textSetting(config, "operation") || "query_logs";
    if (operation === "query_logs") return "api.loganalytics.io";
    if (operation === "query_metrics") return hostOfBuiltUrl(`https://management.azure.com${textSetting(config, "resourceId")}/x`);
    const path = textSetting(config, "path");
    if (/^https?:\/\//i.test(path)) return hostOfBuiltUrl(path);
    return hostOfBuiltUrl(`https://management.azure.com${path.startsWith("/") ? "" : "/"}${path}`);
  },
  "azure-ai-search": fromKey("endpoint"),
  qdrant: fromKey("endpoint")
};

/** Dedicated connector nodes that run a connector-sdk adapter on their whole settings. */
const CONNECTOR_SDK_NODES: Readonly<Record<string, string>> = {
  google_drive_source: "google-drive",
  azure_storage: "azure-storage",
  azure_cosmos_db: "azure-cosmos-db",
  azure_monitor_http: "azure-monitor",
  azure_ai_search_vector_store: "azure-ai-search",
  qdrant_vector_store: "qdrant"
};

/** Each connector node type: exactly the settings its handler builds its address from. */
const CONNECTOR_ADDRESS: Readonly<Record<string, AddressOf>> = {
  // Webhook mode (the default) posts to the webhook URL; bot mode always calls slack.com.
  slack_send_message: (config) => ((textSetting(config, "authType") || "webhook") === "webhook" ? destinationHostOfSetting(config.webhookUrl) : "slack.com"),
  discord_send_message: fromKey("webhookUrl"),
  // The webhook URL, else the whole secret value is the URL.
  teams_send_message: (config, secretAddress) => (textSetting(config, "webhookUrl") ? destinationHostOfSetting(config.webhookUrl) : destinationHostOfSetting(secretAddress)),
  smtp_send_email: fromKey("host"),
  postgres_query: fromKey("host"),
  mysql_query: fromKey("host"),
  // The secret's connection URI wins over the settings'.
  mongo_operation: (config, secretAddress) => {
    if (plainRecord(config.secretRef)?.secretId) return destinationHostOfSetting(secretAddress);
    return destinationHostOfSetting(config.uri);
  },
  redis_command: (config) => (textSetting(config, "url") ? destinationHostOfSetting(config.url) : "localhost"),
  jira_create_issue: fromKey("baseUrl"),
  jira_search_issues: fromKey("baseUrl"),
  salesforce_create_record: fromKey("instanceUrl"),
  salesforce_query: fromKey("instanceUrl"),
  aws_s3_put_object: s3Address,
  aws_s3_get_object: s3Address,
  aws_s3_list_objects: s3Address,
  connector_source: (config) => {
    const address = CONNECTOR_SDK_ADDRESS[textSetting(config, "connectorId")];
    if (!address) return undefined;
    return address(plainRecord(config.connectorConfig) ?? config, undefined);
  }
};

function s3Address(config: Record<string, unknown>): string | undefined {
  const bucket = textSetting(config, "bucket");
  const region = textSetting(config, "region");
  if (!bucket || !region) return undefined;
  return hostOfBuiltUrl(`https://${bucket}.s3.${region}.amazonaws.com/`);
}

/** Connector node types whose address can come from their secret (the engine passes the secret's value for the host only). */
export function connectorAddressInSecret(nodeType: string, config: Record<string, unknown>): boolean {
  if (nodeType === "mongo_operation") return Boolean(plainRecord(config.secretRef)?.secretId);
  if (nodeType === "teams_send_message") return !textSetting(config, "webhookUrl") && Boolean(plainRecord(config.secretRef)?.secretId);
  return false;
}

/**
 * Where a connector node sends its requests: the host its handler really
 * calls, read only from the settings that handler uses for its address (a
 * fixed vendor host for connectors that always call one API). Any other key,
 * however URL-like, is ignored. An unknown type or an address that cannot be
 * read (a template, a missing value) is an unknown host: public. Null for a
 * connector that sends nothing (a demo stub). `secretAddress` is the
 * secret's value for connectors whose address lives in their secret
 * (`connectorAddressInSecret`); it is read for the host only.
 */
export function connectorDestinationRef(nodeType: string, config: Record<string, unknown>, secretAddress?: string): DestinationRef | null {
  const fixed = CONNECTOR_FIXED_HOSTS[nodeType];
  if (fixed) return networkDestinationRef("connector", nodeType, fixed);
  const sdk = CONNECTOR_SDK_NODES[nodeType];
  const address = sdk ? CONNECTOR_SDK_ADDRESS[sdk] : CONNECTOR_ADDRESS[nodeType];
  const host = address ? address(config, secretAddress) : undefined;
  if (host === null) return null;
  return networkDestinationRef("connector", nodeType, host);
}

/** MCP adapters that talk to a local process over stdio (no network endpoint). */
export const MCP_STDIO_ADAPTERS: ReadonlySet<string> = new Set(["stdio_mcp"]);

/** MCP adapters that send nothing over the network. */
export const MCP_ADAPTERS_WITHOUT_NETWORK: ReadonlySet<string> = new Set(["mock-mcp"]);

/**
 * Where an MCP server's calls go: null for an adapter with no network (the
 * mock server), otherwise the registry id and the host of its endpoint
 * (unknown when the endpoint is missing or unreadable: public).
 */
export function mcpServerDestinationRef(server: { serverId?: string; adapterId?: string; registryServerId?: string; connection?: unknown }): DestinationRef | null {
  const adapter = server.adapterId ?? server.serverId ?? "";
  if (MCP_ADAPTERS_WITHOUT_NETWORK.has(adapter)) return null;
  // A stdio server is a local process with no network endpoint: what L2M sends it stays on this machine
  // (the built-in loopback row makes it local). Its own outbound traffic is outside L2M's view.
  if (MCP_STDIO_ADAPTERS.has(adapter)) return networkDestinationRef("mcp_server", server.registryServerId, "localhost");
  return networkDestinationRef("mcp_server", server.registryServerId, destinationHostOfSetting(plainRecord(server.connection)?.endpoint));
}

/** A destination as a verdict carries it: never a path, query or credential. */
export interface GuardDestinationSummary {
  kind: DestinationKind;
  id?: string;
  host?: string;
  tier: DestinationTier;
  region: string;
  /** The classifying row's name, when a row matched. */
  name?: string;
  matchedBy: ResolvedDestination["matchedBy"];
}

/** "api.example.com (public)", "OpenAI (vendor)": how copy names a destination. */
export function describeDestinationSummary(destination: Pick<GuardDestinationSummary, "name" | "host" | "id" | "tier">): string {
  const label = destination.name ?? (destination.host || destination.id || "an unknown host");
  return `${label} (${destination.tier})`;
}
