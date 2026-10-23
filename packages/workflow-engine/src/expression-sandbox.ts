/**
 * Evaluates user expressions (`{{ }}` templates, Sort node expressions)
 * without host access.
 *
 * Expressions run in a separate V8 realm (`node:vm` context) that is given
 * nothing from the host: no host objects, no host functions, no `process`,
 * `require`, `fetch`, timers or Buffer. Data goes in as a JSON string and the
 * result comes back as a JSON string, so the realm never holds a reference to
 * a host object (every known `vm` escape starts from one). Inside the realm:
 *
 *   - `Error.prepareStackTrace` is locked, so stack frames cannot be inspected;
 *   - WebAssembly, SharedArrayBuffer, Atomics, WeakRef and
 *     FinalizationRegistry are removed (the last two would run callbacks
 *     outside any timeout);
 *   - the legacy RegExp statics (`RegExp.$1`, `lastMatch`, …) are removed, so
 *     one evaluation cannot read what an earlier one matched;
 *   - every evaluation has a time limit, which covers promise jobs too
 *     (`microtaskMode: "afterEvaluate"`).
 *
 * When the runtime supports `vm.constants.DONT_CONTEXTIFY` (Node 22.8+), one
 * realm is created, then deep-frozen (every intrinsic and the global object),
 * and reused: nothing an expression does can be seen by a later one. On older
 * runtimes a fresh realm is created for every evaluation instead.
 *
 * Memory is not bounded: an expression can still allocate until the API
 * process runs out. Code nodes, which run longer programs, can be moved into
 * containers (see code-sandbox.ts); expressions always run here.
 */
import vm from "node:vm";

/** The jmespath subset, as plain JavaScript so it can be built in the realm and in the host from one source. */
export const JMESPATH_SOURCE = String.raw`function jmespath(input, path) {
  if (input == null || !path) return input;
  const tokens = [];
  let i = 0;
  let buffer = "";
  const flush = () => {
    if (buffer.length > 0) {
      tokens.push({ kind: "key", name: buffer });
      buffer = "";
    }
  };
  while (i < path.length) {
    const c = path[i];
    if (c === ".") {
      flush();
      i++;
      continue;
    }
    if (c === "[") {
      flush();
      const close = path.indexOf("]", i);
      if (close === -1) throw new Error("jmespath: unclosed bracket in '" + path + "'");
      const inner = path.slice(i + 1, close).trim();
      if (inner === "*") {
        tokens.push({ kind: "wildcard" });
      } else if (inner.startsWith("?")) {
        const filter = inner.slice(1).trim();
        const m = filter.match(/^([A-Za-z_$][\w$]*)\s*==\s*(.+)$/);
        if (!m) throw new Error("jmespath: unsupported filter '" + filter + "'");
        const raw = m[2].trim();
        let value;
        if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) value = raw.slice(1, -1);
        else if (raw === "true") value = true;
        else if (raw === "false") value = false;
        else if (raw === "null") value = null;
        else if (!Number.isNaN(Number(raw))) value = Number(raw);
        else value = raw;
        tokens.push({ kind: "filter", field: m[1], value });
      } else if (/^-?\d+$/.test(inner)) {
        tokens.push({ kind: "index", index: Number(inner) });
      } else {
        throw new Error("jmespath: unsupported bracket expr '[" + inner + "]'");
      }
      i = close + 1;
      continue;
    }
    buffer += c;
    i++;
  }
  flush();
  let current = input;
  for (const token of tokens) {
    if (current == null) return undefined;
    if (token.kind === "key") {
      if (Array.isArray(current)) current = current.map((item) => (item && typeof item === "object" ? item[token.name] : undefined));
      else current = current && typeof current === "object" ? current[token.name] : undefined;
    } else if (token.kind === "index") {
      if (!Array.isArray(current)) return undefined;
      current = current[token.index < 0 ? current.length + token.index : token.index];
    } else if (token.kind === "wildcard") {
      if (Array.isArray(current)) current = current.slice();
      else current = current && typeof current === "object" ? Object.values(current) : [];
    } else {
      if (!Array.isArray(current)) return [];
      current = current.filter((entry) => entry && typeof entry === "object" && entry[token.field] == token.value);
    }
  }
  return current;
}`;

/**
 * Hardening that every realm gets before any user code runs. Shared with the
 * code node sandbox.
 */
export const REALM_HARDEN_SOURCE = String.raw`(() => {
  "use strict";
  Object.defineProperty(Error, "prepareStackTrace", { value: undefined, writable: false, configurable: false, enumerable: false });
  for (const name of ["WebAssembly", "SharedArrayBuffer", "Atomics", "WeakRef", "FinalizationRegistry"]) {
    try { delete globalThis[name]; } catch (error) { globalThis[name] = undefined; }
  }
  for (const name of ["$1", "$2", "$3", "$4", "$5", "$6", "$7", "$8", "$9", "input", "$_", "lastMatch", "$&", "lastParen", "$+", "leftContext", "$\u0060", "rightContext", "$'"]) {
    try { delete RegExp[name]; } catch (error) { /* not configurable on this runtime */ }
  }
})();`;

/** Deep-freezes everything reachable from the global object, then the global itself. */
const REALM_LOCKDOWN_SOURCE = String.raw`(() => {
  "use strict";
  const O = Object, R = Reflect;
  const seen = new Set([globalThis]);
  const freeze = (value) => {
    if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) return;
    seen.add(value);
    for (const key of R.ownKeys(value)) {
      const descriptor = R.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if ("value" in descriptor) freeze(descriptor.value);
      else { freeze(descriptor.get); freeze(descriptor.set); }
    }
    freeze(R.getPrototypeOf(value));
    O.freeze(value);
  };
  for (const key of R.ownKeys(globalThis)) {
    const descriptor = R.getOwnPropertyDescriptor(globalThis, key);
    if (descriptor && "value" in descriptor) freeze(descriptor.value);
    else if (descriptor) { freeze(descriptor.get); freeze(descriptor.set); }
  }
  freeze(R.getPrototypeOf(globalThis));
  O.freeze(globalThis);
  return O.isFrozen(globalThis);
})()`;

/**
 * The evaluator inside the realm. `set` stores the next job (operation,
 * expression, JSON payload); `__l2mRun` runs it and returns a JSON string:
 * `{"u":1}` undefined, `{"d":iso}` a Date, `{"v":value}` anything else,
 * `{"e":message}` an error.
 */
const REALM_EVALUATOR_SOURCE = String.raw`(() => {
  "use strict";
  const parse = JSON.parse, stringify = JSON.stringify, NativeDate = Date, NativeMap = Map, toText = String;
  const jmespath = (${JMESPATH_SOURCE});
  const isEmpty = (value) => {
    if (value === undefined || value === null) return true;
    if (typeof value === "string" || Array.isArray(value)) return value.length === 0;
    if (typeof value === "object") return Object.keys(value).length === 0;
    return false;
  };
  const cache = new NativeMap();
  const compile = (key, build) => {
    let fn = cache.get(key);
    if (!fn) {
      if (cache.size >= 500) cache.clear();
      fn = build();
      cache.set(key, fn);
    }
    return fn;
  };
  const describe = (error) => {
    try {
      if (error && typeof error === "object" && "message" in error) return toText(error.message);
      return toText(error);
    } catch (inner) {
      return "error";
    }
  };
  const encode = (value) => {
    if (value === undefined) return '{"u":1}';
    if (value instanceof NativeDate) return stringify({ d: Number.isNaN(value.getTime()) ? null : value.toISOString() });
    try {
      return stringify({ v: value }, (key, entry) => (typeof entry === "bigint" ? toText(entry) : entry));
    } catch (error) {
      return stringify({ v: toText(value) });
    }
  };
  const buildScope = (ctx) => {
    const input = ctx.input;
    const json = ctx.jsonIsInput ? input : ctx.json === undefined ? input : ctx.json;
    const extras = ctx.extrasIsInput ? input : ctx.extras;
    const nodeOutputs = ctx.nodeOutputs || {};
    const now = new NativeDate();
    const scope = {
      $input: input,
      $json: json,
      $workflow: ctx.workflow,
      $execution: ctx.execution,
      $env: ctx.env,
      $vars: ctx.vars,
      $now: now,
      $today: new NativeDate(now.getFullYear(), now.getMonth(), now.getDate()),
      $itemIndex: ctx.itemIndex,
      $node: (name) => ({ output: nodeOutputs[name] }),
      $if: (cond, a, b) => (cond ? a : b),
      $ifEmpty: (value, fallback) => (isEmpty(value) ? fallback : value),
      $jmespath: jmespath
    };
    if (extras && typeof extras === "object" && !Array.isArray(extras)) {
      for (const key of Object.keys(extras)) {
        if (!(key in scope)) scope[key] = extras[key];
      }
    }
    scope.process = undefined;
    scope.require = undefined;
    scope.global = undefined;
    scope.globalThis = undefined;
    scope.Function = undefined;
    scope.eval = undefined;
    return scope;
  };
  let pending = null;
  const set = (operation, expression, payload) => {
    pending = { operation, expression, payload };
  };
  const run = () => {
    const job = pending;
    pending = null;
    if (!job) return stringify({ e: "no expression" });
    try {
      if (job.operation === "sortKeys") {
        const items = parse(job.payload);
        const fn = compile("sort\u0000" + job.expression, () => new Function("item", "$json", "return (" + job.expression + ");"));
        return encode(items.map((item) => {
          const key = fn(item, item);
          return key instanceof NativeDate ? key.getTime() : key;
        }));
      }
      const fn = compile("expr\u0000" + job.expression, () => new Function("__scope", "with (__scope) { return (" + job.expression + "); }"));
      return encode(fn(buildScope(parse(job.payload))));
    } catch (error) {
      return stringify({ e: describe(error) });
    }
  };
  Object.defineProperty(globalThis, "__l2mRun", { value: run, writable: false, configurable: false, enumerable: false });
  return set;
})()`;

type RealmSetter = (operation: string, expression: string, payload: string) => void;

interface Realm {
  context: vm.Context;
  set: RealmSetter;
}

const RUN_SCRIPT = new vm.Script("__l2mRun()", { filename: "l2m-expression" });

const dontContextify: unknown = (vm.constants as Record<string, unknown> | undefined)?.DONT_CONTEXTIFY;

let settings = { timeoutMs: 1000 };
let sharedRealm: Realm | null = null;

/** Sets the time limit for one expression evaluation (API startup, from EXPRESSION_TIMEOUT_MS). */
export function configureExpressionSandbox(options: { timeoutMs?: number }): void {
  if (typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    settings = { ...settings, timeoutMs: Math.floor(options.timeoutMs) };
  }
}

/** True when one frozen realm is reused; false when every evaluation gets a fresh one. */
export function expressionRealmIsShared(): boolean {
  return dontContextify !== undefined;
}

/** A new realm with nothing from the host in it: an ordinary global where the runtime allows, else a null-prototype one. */
export function createBareContext(): vm.Context {
  const options = { microtaskMode: "afterEvaluate" as const, codeGeneration: { strings: true, wasm: false } };
  return dontContextify !== undefined
    ? vm.createContext(dontContextify as vm.Context, options)
    : vm.createContext(Object.create(null) as vm.Context, options);
}

function createRealm(lockdown: boolean): Realm {
  const context = createBareContext();
  vm.runInContext(REALM_HARDEN_SOURCE, context);
  const set = vm.runInContext(REALM_EVALUATOR_SOURCE, context) as RealmSetter;
  if (lockdown && vm.runInContext(REALM_LOCKDOWN_SOURCE, context) !== true) {
    throw new Error("Expression sandbox could not be locked down");
  }
  return { context, set };
}

function realm(): Realm {
  if (!expressionRealmIsShared()) return createRealm(false);
  if (!sharedRealm) sharedRealm = createRealm(true);
  return sharedRealm;
}

function decode(raw: unknown): unknown {
  if (typeof raw !== "string") throw new Error("Expression sandbox returned an invalid result");
  const parsed = JSON.parse(raw) as { u?: 1; d?: string | null; v?: unknown; e?: string };
  if (typeof parsed.e === "string") throw new Error(parsed.e);
  if (parsed.u === 1) return undefined;
  if ("d" in parsed) return parsed.d === null ? new Date(Number.NaN) : new Date(parsed.d as string);
  return parsed.v;
}

function run(operation: string, expression: string, payload: string): unknown {
  const current = realm();
  current.set(operation, expression, payload);
  let raw: unknown;
  try {
    raw = RUN_SCRIPT.runInContext(current.context, { timeout: settings.timeoutMs });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    // A realm interrupted mid-run may hold a half-finished job; start a new one.
    if (current === sharedRealm) sharedRealm = null;
    if (code === "ERR_SCRIPT_EXECUTION_TIMEOUT") throw new Error(`timed out after ${settings.timeoutMs}ms`);
    throw new Error(error instanceof Error ? error.message : "Expression sandbox failed");
  }
  return decode(raw);
}

/** JSON for the realm: cycles become "[Circular]", BigInts strings, Dates ISO strings. */
export function toSandboxJson(value: unknown): string {
  const ancestors: unknown[] = [];
  const text = JSON.stringify(value === undefined ? null : value, function (this: unknown, _key: string, entry: unknown) {
    if (typeof entry === "bigint") return entry.toString();
    if (typeof entry !== "object" || entry === null) return entry;
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (ancestors.includes(entry)) return "[Circular]";
    ancestors.push(entry);
    return entry;
  });
  return text ?? "null";
}

export interface SandboxExpressionPayload {
  input: unknown;
  json?: unknown;
  extras?: unknown;
  workflow: { id: string; name: string };
  execution: { id: string; customData: Record<string, unknown> };
  env: Record<string, string | undefined>;
  vars: Record<string, unknown>;
  itemIndex: number;
  nodeOutputs: Record<string, unknown>;
}

/** Serializes a payload once; `$json` and extras that are the input itself are sent once. */
export function serializeExpressionPayload(payload: SandboxExpressionPayload): string {
  const jsonIsInput = payload.json === undefined || payload.json === payload.input;
  const extrasIsInput = payload.extras !== undefined && payload.extras === payload.input;
  return toSandboxJson({
    ...payload,
    json: jsonIsInput ? undefined : payload.json,
    jsonIsInput,
    extras: extrasIsInput ? undefined : payload.extras,
    extrasIsInput
  });
}

/** Evaluates one expression against a serialized payload. Throws the expression's own error message. */
export function evaluateInSandbox(expression: string, serializedPayload: string): unknown {
  return run("expr", expression, serializedPayload);
}

/** The Sort node's key for each item (`item` and `$json` are the item); Dates come back as epoch ms. */
export function sortKeysInSandbox(expression: string, items: unknown[]): unknown[] {
  const keys = run("sortKeys", expression, toSandboxJson(items));
  return Array.isArray(keys) ? keys : [];
}
