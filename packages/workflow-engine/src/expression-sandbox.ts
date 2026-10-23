/**
 * Evaluates user expressions (`{{ }}` templates, Sort node expressions)
 * without host access.
 *
 * Every evaluation runs in a fresh QuickJS runtime and context (QuickJS
 * compiled to WebAssembly, see quickjs-sandbox.ts) with a memory limit
 * (EXPRESSION_MEMORY_MB), a stack limit and a time limit
 * (EXPRESSION_TIMEOUT_MS). The context holds only the ECMAScript built-ins:
 * no host object or function, no `process`, `require`, `fetch`, timers,
 * Buffer or `Intl`. Data goes in as a JSON string and the result comes back as
 * a JSON string, and the context is thrown away afterwards, so nothing one
 * evaluation does (a patched prototype, a global) is seen by another.
 *
 * A result larger than EXPRESSION_MAX_RESULT_MB is refused inside the
 * sandbox, and one template's expressions together get at most
 * EXPRESSION_TEMPLATE_BUDGET_MS. When the sandbox itself fails (no instance
 * ready, an instance crashed, the workflow's circuit breaker is open) callers
 * get `ExpressionSandboxError`, which templates rethrow so the node fails
 * instead of rendering an empty value.
 */
import { ErrorCategory, WorkflowError } from "@ai-orchestrator/shared";
import { GuestError, QUICKJS_STACK_BYTES, SandboxFailureError, SandboxTimeoutError, withQuickJs } from "./quickjs-sandbox";

/** The jmespath subset, as plain JavaScript so it can be built in the sandbox and in the host from one source. */
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
 * The evaluator inside the sandbox. `__l2mRun(operation, expression, payload)`
 * runs one job and returns a JSON string: `{"u":1}` undefined, `{"d":iso}` a
 * Date, `{"v":value}` anything else, `{"e":message}` an error. Results longer
 * than `maxChars` become an error. `__l2mRun` and `__l2mSetJmes` are
 * non-writable and non-configurable, and the built-ins it needs are captured
 * before any user code runs.
 *
 * Kept short on purpose: every evaluation compiles it in a fresh context, and
 * QuickJS compile time grows with the source. `$jmespath` is compiled from the
 * source passed to `__l2mSetJmes`, which is only sent when the expression names it.
 */
function evaluatorSource(maxChars: number): string {
  return String.raw`(() => {
  const P = JSON.parse, S = JSON.stringify, D = Date, T = String, K = Object.keys, F = Function, DP = Object.defineProperty, M = ${maxChars};
  let jmSrc = null, jm = null;
  const jmespath = (input, path) => {
    if (!jm) {
      if (typeof jmSrc !== "string") throw new Error("$jmespath is not available here");
      jm = new F("return (" + jmSrc + ");")();
    }
    return jm(input, path);
  };
  const empty = (v) => v == null || (typeof v === "string" || Array.isArray(v) ? v.length === 0 : typeof v === "object" && K(v).length === 0);
  const cap = (text) => (typeof text === "string" && text.length > M ? S({ e: "Expression result is too large (over " + M + " characters)" }) : text);
  const enc = (v) => {
    if (v === undefined) return '{"u":1}';
    if (v instanceof D) return S({ d: Number.isNaN(v.getTime()) ? null : v.toISOString() });
    try { return cap(S({ v }, (k, e) => (typeof e === "bigint" ? T(e) : e))); } catch (e) { return cap(S({ v: T(v) })); }
  };
  const scope = (c) => {
    const input = c.input, outputs = c.nodeOutputs || {}, now = new D();
    const extras = c.extrasIsInput ? input : c.extras;
    const s = {
      $input: input, $json: c.jsonIsInput || c.json === undefined ? input : c.json,
      $workflow: c.workflow, $execution: c.execution, $env: c.env, $vars: c.vars,
      $now: now, $today: new D(now.getFullYear(), now.getMonth(), now.getDate()), $itemIndex: c.itemIndex,
      $node: (name) => ({ output: outputs[name] }), $if: (cond, a, b) => (cond ? a : b),
      $ifEmpty: (v, fallback) => (empty(v) ? fallback : v), $jmespath: jmespath
    };
    if (extras && typeof extras === "object" && !Array.isArray(extras)) for (const k of K(extras)) if (!(k in s)) s[k] = extras[k];
    for (const k of ["process", "require", "global", "globalThis", "Function", "eval"]) s[k] = undefined;
    return s;
  };
  const run = (op, x, p) => {
    try {
      if (op === "sortKeys") {
        const fn = new F("item", "$json", "return (" + x + ");");
        return enc(P(p).map((item) => { const key = fn(item, item); return key instanceof D ? key.getTime() : key; }));
      }
      return enc(new F("__scope", "with (__scope) { return (" + x + "); }")(scope(P(p))));
    } catch (e) {
      let m;
      try { m = e && typeof e === "object" && "message" in e ? T(e.message) : T(e); } catch (inner) { m = "error"; }
      return S({ e: m.slice(0, 2000) });
    }
  };
  DP(globalThis, "__l2mRun", { value: run, writable: false, configurable: false });
  DP(globalThis, "__l2mSetJmes", { value: (source) => { jmSrc = source; }, writable: false, configurable: false });
})();`;
}

const MB = 1024 * 1024;

/** Defaults for EXPRESSION_TIMEOUT_MS, EXPRESSION_MEMORY_MB, EXPRESSION_MAX_RESULT_MB and EXPRESSION_TEMPLATE_BUDGET_MS. */
export const EXPRESSION_SANDBOX_DEFAULTS = { timeoutMs: 1000, memoryMb: 64, maxResultMb: 8, templateBudgetMs: 5000 } as const;

let settings: { timeoutMs: number; memoryBytes: number; maxResultChars: number; templateBudgetMs: number } = {
  timeoutMs: EXPRESSION_SANDBOX_DEFAULTS.timeoutMs,
  memoryBytes: EXPRESSION_SANDBOX_DEFAULTS.memoryMb * MB,
  maxResultChars: EXPRESSION_SANDBOX_DEFAULTS.maxResultMb * MB,
  templateBudgetMs: EXPRESSION_SANDBOX_DEFAULTS.templateBudgetMs
};
let evaluatorPrelude = evaluatorSource(settings.maxResultChars);

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Sets the limits (API startup): EXPRESSION_TIMEOUT_MS and EXPRESSION_MEMORY_MB
 * per evaluation, EXPRESSION_MAX_RESULT_MB per result and
 * EXPRESSION_TEMPLATE_BUDGET_MS for one template's expressions together.
 */
export function configureExpressionSandbox(options: { timeoutMs?: number; memoryMb?: number; maxResultMb?: number; templateBudgetMs?: number }): void {
  if (positive(options.timeoutMs)) settings = { ...settings, timeoutMs: Math.floor(options.timeoutMs) };
  if (positive(options.memoryMb)) settings = { ...settings, memoryBytes: Math.floor(options.memoryMb * MB) };
  if (positive(options.templateBudgetMs)) settings = { ...settings, templateBudgetMs: Math.floor(options.templateBudgetMs) };
  if (positive(options.maxResultMb)) {
    settings = { ...settings, maxResultChars: Math.floor(options.maxResultMb * MB) };
    evaluatorPrelude = evaluatorSource(settings.maxResultChars);
  }
}

/** The limits in force, for startup logs. */
export function expressionSandboxLimits(): { timeoutMs: number; memoryMb: number; maxResultMb: number; templateBudgetMs: number; engine: "quickjs-wasm" } {
  return {
    timeoutMs: settings.timeoutMs,
    memoryMb: Math.round(settings.memoryBytes / MB),
    maxResultMb: Math.round(settings.maxResultChars / MB),
    templateBudgetMs: settings.templateBudgetMs,
    engine: "quickjs-wasm"
  };
}

/**
 * The sandbox itself failed, so an expression has no value: no instance was
 * ready (retryable), an instance crashed on this expression, or this
 * workflow's circuit breaker is open. Templates rethrow it instead of
 * rendering "", so an IF, Switch, URL or prompt never sees a silent empty
 * value.
 */
export class ExpressionSandboxError extends WorkflowError {
  constructor(message: string, retryable: boolean) {
    super(
      `expression sandbox error: ${message}`,
      ErrorCategory.UNKNOWN,
      retryable,
      { sandbox: "expression" },
      retryable
        ? "The expression sandbox was briefly unavailable. Run the workflow again (or enable Retry on Fail for this node)."
        : "An expression in this node crashed the expression sandbox (for example a result nested thousands of levels deep). Simplify the expression."
    );
    this.name = "ExpressionSandboxError";
  }
}

/** True for a failure of the sandbox itself (inside or outside a session), which must never be rendered as an empty value. */
export function isExpressionSandboxFailure(error: unknown): boolean {
  return error instanceof ExpressionSandboxError || error instanceof SandboxFailureError;
}

/** Decodes `__l2mRun`'s answer. Anything but the plain shape it builds is the guest's doing (a patched toJSON, say), so it is a guest error. */
function decode(raw: unknown): unknown {
  if (typeof raw !== "string") throw new GuestError("Expression returned an invalid result");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GuestError("Expression returned an invalid result");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new GuestError("Expression returned an invalid result");
  const answer = parsed as { u?: unknown; d?: unknown; v?: unknown; e?: unknown };
  if (typeof answer.e === "string") throw new GuestError(answer.e);
  if (answer.u === 1) return undefined;
  if (Object.prototype.hasOwnProperty.call(answer, "d")) {
    if (answer.d === null) return new Date(Number.NaN);
    if (typeof answer.d === "string") return new Date(answer.d);
    throw new GuestError("Expression returned an invalid result");
  }
  if (!Object.prototype.hasOwnProperty.call(answer, "v")) throw new GuestError("Expression returned an invalid result");
  return answer.v;
}

/** Evaluates one expression per call against a serialized payload, all in one sandbox session. */
export type SandboxEvaluate = (operation: "expr" | "sortKeys", expression: string, payload: string) => unknown;

/** The error callers see: the expression's own message, a timeout, or a sandbox failure. */
function publicError(error: unknown): unknown {
  if (error instanceof SandboxFailureError) return new ExpressionSandboxError(error.message, error.retryable);
  if (error instanceof GuestError || error instanceof SandboxTimeoutError) return new Error(error.message);
  return error;
}

/**
 * Opens one sandbox session (a fresh QuickJS runtime and context) for
 * `body`, which may evaluate several expressions in it — one template's
 * expressions, which share an author and a payload. Each evaluation has its
 * own time limit (all of them together at most EXPRESSION_TEMPLATE_BUDGET_MS)
 * and re-parses its payload, so one cannot change the data another sees. The
 * session is disposed when `body` returns.
 */
export function withExpressionSandbox<R>(body: (evaluate: SandboxEvaluate) => R): R {
  const prelude = evaluatorPrelude;
  try {
    return withQuickJs(
      { memoryBytes: settings.memoryBytes, stackBytes: QUICKJS_STACK_BYTES, timeoutMs: settings.timeoutMs, sessionBudgetMs: settings.templateBudgetMs },
      (session) => {
      session.evaluateTrusted(prelude, "l2m-expression-prelude.js");
      let jmespathLoaded = false;
      return body((operation, expression, payload) => {
        try {
          session.resetDeadline(settings.timeoutMs);
          if (!jmespathLoaded && expression.includes("jmespath")) {
            // A trusted, non-writable setter: earlier expressions in the session cannot intercept it.
            session.callGlobal("__l2mSetJmes", [JMESPATH_SOURCE]);
            jmespathLoaded = true;
          }
          return decode(session.callGlobal("__l2mRun", [operation, expression, payload]));
        } catch (error) {
          // Inside the session, guest errors and timeouts stay typed so they never retire the instance.
          if (error instanceof GuestError || error instanceof SandboxTimeoutError || error instanceof SandboxFailureError) throw error;
          throw new SandboxFailureError(error instanceof Error ? error.message : String(error));
        }
      });
      }
    );
  } catch (error) {
    throw publicError(error);
  }
}

function run(operation: "expr" | "sortKeys", expression: string, payload: string): unknown {
  return withExpressionSandbox((evaluate) => evaluate(operation, expression, payload));
}

/** JSON for the sandbox: cycles become "[Circular]", BigInts strings, Dates ISO strings. */
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

/** Evaluates one expression against a serialized payload in its own session. Throws the expression's own error message. */
export function evaluateInSandbox(expression: string, serializedPayload: string): unknown {
  return run("expr", expression, serializedPayload);
}

/** The Sort node's key for each item (`item` and `$json` are the item); Dates come back as epoch ms. */
export function sortKeysInSandbox(expression: string, items: unknown[]): unknown[] {
  const keys = run("sortKeys", expression, toSandboxJson(items));
  return Array.isArray(keys) ? keys : [];
}
