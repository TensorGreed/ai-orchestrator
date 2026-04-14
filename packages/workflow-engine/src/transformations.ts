/**
 * Phase 2 transformation node helpers.
 * Pure functions — easy to unit-test, no workflow-engine context required.
 *
 * Conventions:
 *   - All "list" inputs accept either an array (preferred) or a single object
 *     (treated as a 1-item array) — except where noted.
 *   - Each function throws plain Error; the executor wraps thrown errors in a
 *     WorkflowError with the appropriate ErrorCategory.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

// ---------------------------------------------------------------------------
// utilities
// ---------------------------------------------------------------------------
export function ensureArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

export function getField(item: unknown, field: string): unknown {
  if (!field) return item;
  if (item == null || typeof item !== "object") return undefined;
  if (!field.includes(".")) return (item as Record<string, unknown>)[field];
  let cur: unknown = item;
  for (const part of field.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// 2.1.1 aggregate
// ---------------------------------------------------------------------------
export type AggregateOp = "sum" | "avg" | "min" | "max" | "count" | "concatenate";

export function aggregateItems(
  items: unknown[],
  operation: AggregateOp,
  field?: string,
  options: { groupBy?: string; separator?: string } = {}
): Record<string, unknown> {
  const { groupBy, separator = "," } = options;
  if (groupBy) {
    const groups = new Map<string, unknown[]>();
    for (const item of items) {
      const key = String(getField(item, groupBy) ?? "__null__");
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    }
    const result: Record<string, unknown> = {};
    for (const [key, group] of groups) {
      result[key] = aggregateItems(group, operation, field, { separator }).value;
    }
    return { groups: result, count: items.length };
  }
  if (operation === "count") return { value: items.length, count: items.length };
  if (!field && operation !== "concatenate") {
    throw new Error(`aggregate '${operation}' requires a field`);
  }
  const values = field ? items.map((it) => getField(it, field)) : items;
  if (operation === "concatenate") {
    return { value: values.map((v) => (v == null ? "" : String(v))).join(separator), count: items.length };
  }
  const numbers = values.map(asNumber);
  if (operation === "sum") return { value: numbers.reduce((a, b) => a + b, 0), count: items.length };
  if (operation === "avg") {
    return { value: numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : 0, count: items.length };
  }
  if (operation === "min") return { value: numbers.length ? Math.min(...numbers) : null, count: items.length };
  if (operation === "max") return { value: numbers.length ? Math.max(...numbers) : null, count: items.length };
  throw new Error(`aggregate: unsupported operation '${operation}'`);
}

// ---------------------------------------------------------------------------
// 2.1.2 splitOut
// ---------------------------------------------------------------------------
export function splitOut(items: unknown[], field: string, destinationField?: string): unknown[] {
  if (!field) throw new Error("split_out requires a field");
  const out: unknown[] = [];
  for (const item of items) {
    const arr = ensureArray(getField(item, field));
    for (const element of arr) {
      if (destinationField) {
        out.push({
          ...(item && typeof item === "object" ? (item as Record<string, unknown>) : {}),
          [destinationField]: element
        });
      } else {
        out.push(element);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2.1.3 sort
// ---------------------------------------------------------------------------
export type SortOrder = "asc" | "desc" | "random";

export function sortItems(items: unknown[], opts: { field?: string; order?: SortOrder; expression?: string } = {}): unknown[] {
  const { field, order = "asc", expression } = opts;
  const out = items.slice();
  if (order === "random") {
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  let keyFn: (item: unknown) => unknown;
  if (expression) {
    // eslint-disable-next-line no-new-func
    const fn = new Function("item", "$json", `return (${expression});`) as (item: unknown, j: unknown) => unknown;
    keyFn = (item: unknown) => fn(item, item);
  } else if (field) {
    keyFn = (item: unknown) => getField(item, field);
  } else {
    keyFn = (item: unknown) => item;
  }
  out.sort((a, b) => {
    const va = keyFn(a);
    const vb = keyFn(b);
    if (typeof va === "number" && typeof vb === "number") return va - vb;
    const sa = va == null ? "" : String(va);
    const sb = vb == null ? "" : String(vb);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  if (order === "desc") out.reverse();
  return out;
}

// ---------------------------------------------------------------------------
// 2.1.4 limit
// ---------------------------------------------------------------------------
export function limitItems(items: unknown[], maxItems: number, keep: "first" | "last" = "first"): unknown[] {
  if (!Number.isFinite(maxItems) || maxItems < 0) throw new Error("limit: maxItems must be non-negative");
  if (items.length <= maxItems) return items.slice();
  return keep === "last" ? items.slice(items.length - maxItems) : items.slice(0, maxItems);
}

// ---------------------------------------------------------------------------
// 2.1.5 removeDuplicates
// ---------------------------------------------------------------------------
export function removeDuplicates(items: unknown[], fields?: string[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of items) {
    let key: string;
    if (fields && fields.length) {
      key = JSON.stringify(fields.map((f) => getField(item, f) ?? null));
    } else {
      try { key = JSON.stringify(item); } catch { key = String(item); }
    }
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2.1.6 summarize
// ---------------------------------------------------------------------------
export interface SummarizeField {
  field: string;
  aggregation: AggregateOp;
}

export function summarizeItems(
  items: unknown[],
  fieldsToSummarize: SummarizeField[],
  fieldsToGroupBy?: string[]
): unknown[] {
  if (!fieldsToSummarize.length) throw new Error("summarize: fieldsToSummarize is required");
  const groupKey = (item: unknown): string => {
    if (!fieldsToGroupBy?.length) return "__all__";
    return JSON.stringify(fieldsToGroupBy.map((f) => getField(item, f) ?? null));
  };
  const buckets = new Map<string, { groupValues: Record<string, unknown>; rows: unknown[] }>();
  for (const item of items) {
    const k = groupKey(item);
    let bucket = buckets.get(k);
    if (!bucket) {
      const groupValues: Record<string, unknown> = {};
      if (fieldsToGroupBy) {
        for (const f of fieldsToGroupBy) groupValues[f] = getField(item, f);
      }
      bucket = { groupValues, rows: [] };
      buckets.set(k, bucket);
    }
    bucket.rows.push(item);
  }
  const out: unknown[] = [];
  for (const { groupValues, rows } of buckets.values()) {
    const row: Record<string, unknown> = { ...groupValues };
    for (const { field, aggregation } of fieldsToSummarize) {
      const agg = aggregateItems(rows, aggregation, field);
      row[`${field}_${aggregation}`] = agg.value;
    }
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2.1.7 compareDatasets
// ---------------------------------------------------------------------------
export interface CompareResult {
  added: unknown[];
  removed: unknown[];
  changed: Array<{ key: unknown; a: unknown; b: unknown }>;
  same: unknown[];
}

export function compareDatasets(a: unknown[], b: unknown[], keyField: string): CompareResult {
  const indexA = new Map<string, unknown>();
  const indexB = new Map<string, unknown>();
  for (const item of a) indexA.set(String(getField(item, keyField)), item);
  for (const item of b) indexB.set(String(getField(item, keyField)), item);
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const changed: Array<{ key: unknown; a: unknown; b: unknown }> = [];
  const same: unknown[] = [];
  for (const [key, ia] of indexA) {
    if (!indexB.has(key)) {
      removed.push(ia);
      continue;
    }
    const ib = indexB.get(key);
    if (JSON.stringify(ia) === JSON.stringify(ib)) same.push(ia);
    else changed.push({ key, a: ia, b: ib });
  }
  for (const [key, ib] of indexB) {
    if (!indexA.has(key)) added.push(ib);
  }
  return { added, removed, changed, same };
}

// ---------------------------------------------------------------------------
// 2.1.8 renameKeys
// ---------------------------------------------------------------------------
export function renameKeys(items: unknown[], renames: Array<{ from: string; to: string }>): unknown[] {
  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
    for (const { from, to } of renames) {
      if (from in out) {
        out[to] = out[from];
        delete out[from];
      }
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// 2.1.9 editFields
// ---------------------------------------------------------------------------
export interface EditOp {
  op: "set" | "remove" | "rename";
  field: string;
  value?: unknown;
  newName?: string;
}

export function editFields(items: unknown[], operations: EditOp[]): unknown[] {
  return items.map((item) => {
    const base: Record<string, unknown> =
      item && typeof item === "object" && !Array.isArray(item)
        ? { ...(item as Record<string, unknown>) }
        : { value: item };
    for (const op of operations) {
      if (op.op === "set") base[op.field] = op.value;
      else if (op.op === "remove") delete base[op.field];
      else if (op.op === "rename" && op.newName) {
        if (op.field in base) {
          base[op.newName] = base[op.field];
          delete base[op.field];
        }
      }
    }
    return base;
  });
}

// ---------------------------------------------------------------------------
// 2.1.10 dateTime
// ---------------------------------------------------------------------------
export type DateTimeOp = "format" | "parse" | "add" | "subtract" | "compare" | "now";
export type DateUnit = "ms" | "second" | "minute" | "hour" | "day" | "week" | "month" | "year";

const UNIT_MS: Record<Exclude<DateUnit, "month" | "year">, number> = {
  ms: 1,
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000
};

export function performDateTime(opts: {
  operation: DateTimeOp;
  value?: string;
  format?: string;
  unit?: DateUnit;
  amount?: number;
  compareTo?: string;
  timezone?: string;
}): unknown {
  const { operation, value, format = "iso", unit = "ms", amount = 0, compareTo, timezone } = opts;
  if (operation === "now") return new Date().toISOString();
  const baseDate = value ? new Date(value) : new Date();
  if (Number.isNaN(baseDate.getTime())) throw new Error(`date_time: invalid date '${value}'`);

  if (operation === "parse") return baseDate.toISOString();
  if (operation === "format") {
    if (format === "iso") return baseDate.toISOString();
    if (format === "unix") return Math.floor(baseDate.getTime() / 1000);
    if (format === "unix_ms") return baseDate.getTime();
    if (format === "locale") {
      return new Intl.DateTimeFormat(undefined, timezone ? { timeZone: timezone } : undefined).format(baseDate);
    }
    // Limited token format: YYYY, MM, DD, HH, mm, ss
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return format
      .replace(/YYYY/g, String(baseDate.getUTCFullYear()))
      .replace(/MM/g, pad(baseDate.getUTCMonth() + 1))
      .replace(/DD/g, pad(baseDate.getUTCDate()))
      .replace(/HH/g, pad(baseDate.getUTCHours()))
      .replace(/mm/g, pad(baseDate.getUTCMinutes()))
      .replace(/ss/g, pad(baseDate.getUTCSeconds()));
  }
  if (operation === "add" || operation === "subtract") {
    const sign = operation === "add" ? 1 : -1;
    const next = new Date(baseDate.getTime());
    if (unit === "month") next.setUTCMonth(next.getUTCMonth() + sign * amount);
    else if (unit === "year") next.setUTCFullYear(next.getUTCFullYear() + sign * amount);
    else next.setTime(next.getTime() + sign * amount * UNIT_MS[unit]);
    return next.toISOString();
  }
  if (operation === "compare") {
    if (!compareTo) throw new Error("date_time compare requires compareTo");
    const other = new Date(compareTo);
    if (Number.isNaN(other.getTime())) throw new Error(`date_time: invalid compareTo '${compareTo}'`);
    const diff = baseDate.getTime() - other.getTime();
    return { diffMs: diff, equals: diff === 0, before: diff < 0, after: diff > 0 };
  }
  throw new Error(`date_time: unsupported operation '${operation}'`);
}

// ---------------------------------------------------------------------------
// 2.1.11 crypto
// ---------------------------------------------------------------------------
export type CryptoOp = "hash" | "hmac" | "encrypt" | "decrypt" | "sign" | "verify" | "random";

export function performCrypto(opts: {
  operation: CryptoOp;
  algorithm?: string;
  key?: string;
  iv?: string;
  data?: string;
  encoding?: "hex" | "base64" | "utf8";
  signature?: string;
  bytes?: number;
}): unknown {
  const { operation, algorithm = "sha256", key, iv, data = "", encoding = "hex", signature, bytes = 16 } = opts;
  if (operation === "random") {
    return randomBytes(bytes).toString(encoding === "utf8" ? "hex" : encoding);
  }
  if (operation === "hash") {
    return createHash(algorithm).update(data, "utf8").digest(encoding === "utf8" ? "hex" : encoding);
  }
  if (operation === "hmac" || operation === "sign") {
    if (!key) throw new Error(`${operation}: key is required`);
    return createHmac(algorithm, key).update(data, "utf8").digest(encoding === "utf8" ? "hex" : encoding);
  }
  if (operation === "verify") {
    if (!key || !signature) throw new Error("verify: key and signature are required");
    const computed = createHmac(algorithm, key).update(data, "utf8").digest(encoding === "utf8" ? "hex" : encoding);
    const a = Buffer.from(computed);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  if (operation === "encrypt" || operation === "decrypt") {
    if (!key) throw new Error(`${operation}: key is required`);
    const algo = algorithm === "sha256" ? "aes-256-cbc" : algorithm; // sensible default
    const keyBuf = scryptSync(key, "ai-orchestrator-salt", 32);
    const ivBuf = iv ? Buffer.from(iv, "hex") : Buffer.alloc(16, 0);
    if (operation === "encrypt") {
      const cipher = createCipheriv(algo, keyBuf, ivBuf);
      const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
      return encrypted.toString(encoding === "utf8" ? "base64" : encoding);
    }
    const decipher = createDecipheriv(algo, keyBuf, ivBuf);
    const inputBuf = Buffer.from(data, encoding === "utf8" ? "base64" : encoding);
    const decrypted = Buffer.concat([decipher.update(inputBuf), decipher.final()]);
    return decrypted.toString("utf8");
  }
  throw new Error(`crypto: unsupported operation '${operation}'`);
}

// ---------------------------------------------------------------------------
// 2.1.12 jwt (HS256/HS384/HS512 only)
// ---------------------------------------------------------------------------
export type JwtAlgorithm = "HS256" | "HS384" | "HS512";
const JWT_ALG_TO_HASH: Record<JwtAlgorithm, string> = {
  HS256: "sha256",
  HS384: "sha384",
  HS512: "sha512"
};

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

export function jwtSign(payload: Record<string, unknown>, secret: string, algorithm: JwtAlgorithm = "HS256", expiresInSeconds?: number): string {
  if (!secret) throw new Error("jwt sign: secret is required");
  const header = { alg: algorithm, typ: "JWT" };
  const finalPayload: Record<string, unknown> = { ...payload };
  if (expiresInSeconds && expiresInSeconds > 0) {
    finalPayload.exp = Math.floor(Date.now() / 1000) + Math.floor(expiresInSeconds);
  }
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(finalPayload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = createHmac(JWT_ALG_TO_HASH[algorithm], secret).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

export function jwtDecode(token: string): { header: unknown; payload: unknown; signature: string } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("jwt decode: malformed token");
  return {
    header: JSON.parse(base64UrlDecode(parts[0]).toString("utf8")),
    payload: JSON.parse(base64UrlDecode(parts[1]).toString("utf8")),
    signature: parts[2]
  };
}

export function jwtVerify(token: string, secret: string): { valid: boolean; payload?: unknown; reason?: string } {
  if (!secret) return { valid: false, reason: "secret required" };
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed token" };
  let header: { alg?: string };
  try {
    header = JSON.parse(base64UrlDecode(parts[0]).toString("utf8"));
  } catch {
    return { valid: false, reason: "invalid header" };
  }
  const alg = header.alg as JwtAlgorithm | undefined;
  if (!alg || !(alg in JWT_ALG_TO_HASH)) return { valid: false, reason: `unsupported alg ${alg}` };
  const expected = createHmac(JWT_ALG_TO_HASH[alg], secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = base64UrlDecode(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { valid: false, reason: "signature mismatch" };
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(base64UrlDecode(parts[1]).toString("utf8"));
  } catch {
    return { valid: false, reason: "invalid payload" };
  }
  if (typeof payload.exp === "number" && Math.floor(Date.now() / 1000) > payload.exp) {
    return { valid: false, payload, reason: "token expired" };
  }
  return { valid: true, payload };
}

// ---------------------------------------------------------------------------
// 2.1.13 xml — minimal hand-rolled parser/serializer
// ---------------------------------------------------------------------------
type XmlNode = { tag: string; attributes: Record<string, string>; children: Array<XmlNode | string> };

function parseXmlInternal(input: string): XmlNode {
  let i = 0;
  const len = input.length;
  const skipWs = () => {
    while (i < len && /\s/.test(input[i])) i++;
  };
  const parseTag = (): XmlNode | string | null => {
    skipWs();
    if (i >= len) return null;
    if (input[i] !== "<") {
      // text
      let text = "";
      while (i < len && input[i] !== "<") text += input[i++];
      const trimmed = text.trim();
      return trimmed ? trimmed : null;
    }
    // skip XML declaration / comments
    if (input.startsWith("<?", i)) {
      const end = input.indexOf("?>", i);
      i = end === -1 ? len : end + 2;
      return parseTag();
    }
    if (input.startsWith("<!--", i)) {
      const end = input.indexOf("-->", i);
      i = end === -1 ? len : end + 3;
      return parseTag();
    }
    i++; // consume '<'
    if (input[i] === "/") return null; // closing tag — caller handles
    let name = "";
    while (i < len && !/[\s/>]/.test(input[i])) name += input[i++];
    const attributes: Record<string, string> = {};
    while (i < len && input[i] !== ">" && input[i] !== "/") {
      skipWs();
      if (input[i] === ">" || input[i] === "/") break;
      let attrName = "";
      while (i < len && input[i] !== "=" && !/\s/.test(input[i]) && input[i] !== ">") attrName += input[i++];
      if (input[i] === "=") {
        i++;
        const quote = input[i];
        if (quote === '"' || quote === "'") {
          i++;
          let val = "";
          while (i < len && input[i] !== quote) val += input[i++];
          if (input[i] === quote) i++;
          attributes[attrName] = val;
        }
      } else if (attrName) {
        attributes[attrName] = "";
      }
    }
    let selfClosing = false;
    if (input[i] === "/") {
      selfClosing = true;
      i++;
    }
    if (input[i] === ">") i++;
    const node: XmlNode = { tag: name, attributes, children: [] };
    if (selfClosing) return node;
    while (i < len) {
      skipWs();
      if (input.startsWith("</", i)) {
        // closing
        i += 2;
        let close = "";
        while (i < len && input[i] !== ">") close += input[i++];
        if (input[i] === ">") i++;
        if (close.trim() !== name) throw new Error(`xml: mismatched closing tag </${close}> for <${name}>`);
        return node;
      }
      const child = parseTag();
      if (child !== null) node.children.push(child);
      else if (i >= len) break;
    }
    return node;
  };
  const root = parseTag();
  if (!root || typeof root === "string") throw new Error("xml: no root element");
  return root;
}

function xmlNodeToJson(node: XmlNode): unknown {
  const obj: Record<string, unknown> = {};
  if (Object.keys(node.attributes).length > 0) {
    obj["@attributes"] = node.attributes;
  }
  const childGroups = new Map<string, unknown[]>();
  let textBuffer = "";
  for (const child of node.children) {
    if (typeof child === "string") {
      textBuffer += child;
      continue;
    }
    const value = xmlNodeToJson(child);
    const list = childGroups.get(child.tag) ?? [];
    list.push(value);
    childGroups.set(child.tag, list);
  }
  for (const [tag, list] of childGroups) {
    obj[tag] = list.length === 1 ? list[0] : list;
  }
  if (textBuffer.trim()) {
    if (Object.keys(obj).length === 0) return textBuffer.trim();
    obj["#text"] = textBuffer.trim();
  }
  return obj;
}

export function xmlToJson(xml: string): unknown {
  const root = parseXmlInternal(xml);
  return { [root.tag]: xmlNodeToJson(root) };
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function jsonValueToXml(tag: string, value: unknown): string {
  if (value === null || value === undefined) return `<${tag}/>`;
  if (Array.isArray(value)) return value.map((v) => jsonValueToXml(tag, v)).join("");
  if (typeof value !== "object") return `<${tag}>${escapeXml(String(value))}</${tag}>`;
  const obj = value as Record<string, unknown>;
  const attrs = obj["@attributes"] && typeof obj["@attributes"] === "object"
    ? Object.entries(obj["@attributes"] as Record<string, unknown>).map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`).join("")
    : "";
  const inner: string[] = [];
  for (const [key, child] of Object.entries(obj)) {
    if (key === "@attributes") continue;
    if (key === "#text") {
      inner.push(escapeXml(String(child)));
      continue;
    }
    inner.push(jsonValueToXml(key, child));
  }
  if (!inner.length) return `<${tag}${attrs}/>`;
  return `<${tag}${attrs}>${inner.join("")}</${tag}>`;
}

export function jsonToXml(input: unknown): string {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return jsonValueToXml("root", input);
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 1) {
    const [tag, value] = entries[0];
    return jsonValueToXml(tag, value);
  }
  return jsonValueToXml("root", input);
}

// ---------------------------------------------------------------------------
// 2.1.14 html — minimal selector extraction
// Supports: tag, .class, #id, tag.class, descendant ("a b").
// ---------------------------------------------------------------------------
interface HtmlElement {
  tag: string;
  attributes: Record<string, string>;
  children: Array<HtmlElement | string>;
  text(): string;
  html(): string;
  attr(name: string): string | undefined;
}

function makeHtmlElement(tag: string, attributes: Record<string, string>, children: Array<HtmlElement | string>): HtmlElement {
  return {
    tag,
    attributes,
    children,
    text(): string {
      return children.map((c) => (typeof c === "string" ? c : c.text())).join("");
    },
    html(): string {
      const attrs = Object.entries(attributes).map(([k, v]) => ` ${k}="${v.replace(/"/g, "&quot;")}"`).join("");
      const inner = children.map((c) => (typeof c === "string" ? c : c.html())).join("");
      return `<${tag}${attrs}>${inner}</${tag}>`;
    },
    attr(name: string): string | undefined {
      return attributes[name];
    }
  };
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function parseHtml(input: string): HtmlElement {
  let i = 0;
  const len = input.length;
  const root: HtmlElement = makeHtmlElement("root", {}, []);
  const stack: HtmlElement[] = [root];
  while (i < len) {
    if (input[i] !== "<") {
      let text = "";
      while (i < len && input[i] !== "<") text += input[i++];
      stack[stack.length - 1].children.push(text);
      continue;
    }
    if (input.startsWith("<!--", i)) {
      const end = input.indexOf("-->", i);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (input.startsWith("<!", i) || input.startsWith("<?", i)) {
      const end = input.indexOf(">", i);
      i = end === -1 ? len : end + 1;
      continue;
    }
    if (input[i + 1] === "/") {
      const end = input.indexOf(">", i);
      const closeTag = input.slice(i + 2, end).trim().toLowerCase();
      i = end === -1 ? len : end + 1;
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].tag === closeTag) {
          stack.length = s;
          break;
        }
      }
      continue;
    }
    // open tag
    i++;
    let name = "";
    while (i < len && !/[\s/>]/.test(input[i])) name += input[i++];
    name = name.toLowerCase();
    const attributes: Record<string, string> = {};
    while (i < len && input[i] !== ">" && input[i] !== "/") {
      while (i < len && /\s/.test(input[i])) i++;
      if (input[i] === ">" || input[i] === "/") break;
      let attrName = "";
      while (i < len && input[i] !== "=" && !/\s/.test(input[i]) && input[i] !== ">" && input[i] !== "/") attrName += input[i++];
      if (input[i] === "=") {
        i++;
        const quote = input[i];
        if (quote === '"' || quote === "'") {
          i++;
          let val = "";
          while (i < len && input[i] !== quote) val += input[i++];
          if (input[i] === quote) i++;
          attributes[attrName.toLowerCase()] = val;
        } else {
          let val = "";
          while (i < len && !/[\s>]/.test(input[i])) val += input[i++];
          attributes[attrName.toLowerCase()] = val;
        }
      } else if (attrName) {
        attributes[attrName.toLowerCase()] = "";
      }
    }
    let selfClosing = false;
    if (input[i] === "/") {
      selfClosing = true;
      i++;
    }
    if (input[i] === ">") i++;
    const el = makeHtmlElement(name, attributes, []);
    stack[stack.length - 1].children.push(el);
    if (!selfClosing && !VOID_TAGS.has(name)) {
      stack.push(el);
    }
  }
  return root;
}

interface ParsedSelector {
  tag?: string;
  classes: string[];
  id?: string;
}

function parseSimpleSelector(token: string): ParsedSelector {
  const result: ParsedSelector = { classes: [] };
  let cursor = "";
  let mode: "tag" | "class" | "id" = "tag";
  const flush = () => {
    if (!cursor) return;
    if (mode === "tag") result.tag = cursor.toLowerCase();
    else if (mode === "class") result.classes.push(cursor);
    else result.id = cursor;
    cursor = "";
  };
  for (const ch of token) {
    if (ch === ".") { flush(); mode = "class"; }
    else if (ch === "#") { flush(); mode = "id"; }
    else cursor += ch;
  }
  flush();
  return result;
}

function elementMatches(el: HtmlElement, sel: ParsedSelector): boolean {
  if (sel.tag && sel.tag !== "*" && el.tag !== sel.tag) return false;
  if (sel.id) {
    if (el.attributes.id !== sel.id) return false;
  }
  if (sel.classes.length) {
    const cls = (el.attributes.class ?? "").split(/\s+/);
    for (const c of sel.classes) if (!cls.includes(c)) return false;
  }
  return true;
}

function findAllInElement(el: HtmlElement, sel: ParsedSelector, results: HtmlElement[]): void {
  for (const child of el.children) {
    if (typeof child === "string") continue;
    if (elementMatches(child, sel)) results.push(child);
    findAllInElement(child, sel, results);
  }
}

export function htmlSelect(html: string, selector: string): HtmlElement[] {
  const root = parseHtml(html);
  const tokens = selector.trim().split(/\s+/).map(parseSimpleSelector);
  let current: HtmlElement[] = [root];
  for (const tok of tokens) {
    const next: HtmlElement[] = [];
    for (const el of current) findAllInElement(el, tok, next);
    current = next;
  }
  return current;
}

export interface HtmlSelectorSpec {
  key: string;
  selector: string;
  attribute?: string;
  all?: boolean;
}

export function htmlExtract(html: string, selectors: HtmlSelectorSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of selectors) {
    const els = htmlSelect(html, spec.selector);
    const values = els.map((el) => (spec.attribute ? el.attr(spec.attribute) ?? "" : el.text()));
    out[spec.key] = spec.all ? values : values[0] ?? null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2.1.15 / 2.1.16 — file conversion helpers
// ---------------------------------------------------------------------------
export function toCsv(rows: unknown[]): string {
  if (!rows.length) return "";
  const records = rows.map((r) => (r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : { value: r }));
  const headers = Array.from(new Set(records.flatMap((r) => Object.keys(r))));
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  return [headers.join(","), ...records.map((r) => headers.map((h) => escape(r[h])).join(","))].join("\n");
}

export function fromCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { current.push(field); field = ""; i++; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      current.push(field);
      rows.push(current);
      current = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length || current.length) {
    current.push(field);
    rows.push(current);
  }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).filter((r) => r.length).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = r[idx] ?? ""; });
    return obj;
  });
}

// ---------------------------------------------------------------------------
// 2.1.17 — compression
// ---------------------------------------------------------------------------
export function compressionGzip(data: string, encoding: "utf8" | "base64" = "utf8"): string {
  const input = encoding === "utf8" ? Buffer.from(data, "utf8") : Buffer.from(data, "base64");
  return gzipSync(input).toString("base64");
}

export function compressionGunzip(data: string): string {
  const input = Buffer.from(data, "base64");
  return gunzipSync(input).toString("utf8");
}
