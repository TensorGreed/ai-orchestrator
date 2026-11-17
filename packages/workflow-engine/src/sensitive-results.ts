import {
  parseSensitiveValuesMarker,
  UNVERIFIED_SENSITIVE_PLACEHOLDER,
  type DataLabels,
  type MCPToolResult,
  type SensitiveValuesMarker
} from "@ai-orchestrator/shared";
import type { MCPRegistry, MCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import { currentLabelScope } from "./data-labels";
import { REVEAL_REDACTION_MIN_LENGTH, type RevealRedactor } from "./reveal-redaction";

/**
 * Sensitive values in MCP tool results (see sensitive-values-marker.ts in shared).
 *
 * A tool result whose `_meta` lists sensitive values (L2M's gateway `restore_sensitive_data`) is handled like a
 * Reveal node's output: the run's own nodes get the values, and the run's redactor puts them back as their tokens in
 * everything the run keeps or sends (history, live events, the paused state, session stores). A marker this
 * deployment signed puts back the listed tokens; any other marker only masks more (a fixed placeholder, and only for
 * values found in that result). Either way the calling node's labels say sensitive.
 */

/** Says whether a marker was signed by this deployment (the API checks the signature). */
export type SensitiveValuesVerifier = (marker: SensitiveValuesMarker) => boolean;

const SENSITIVE: DataLabels = { provenance: ["sensitive"], dataClasses: [], source: "propagated" };

function textOf(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Registers the values a result's marker lists with the run's redactor. Returns whether the result carried a marker
 * (usable or not). A value is registered only when it appears in the result (as text, or escaped inside JSON).
 */
export function protectSensitiveResult(result: MCPToolResult, redactor: RevealRedactor, verify?: SensitiveValuesVerifier): boolean {
  if (result.sensitiveValues === undefined) return false;
  const marker = parseSensitiveValuesMarker(result.sensitiveValues);
  if (!marker) return true;
  let trusted = false;
  if (marker.complete && typeof marker.sig === "string" && verify) {
    try {
      trusted = verify({ v: marker.v, values: marker.values, sig: marker.sig }) === true;
    } catch {
      trusted = false;
    }
  }
  const haystack = [textOf(result.output), textOf(result.content), textOf(result.structured), result.error ?? ""].join("\u0000");
  for (const entry of marker.values) {
    if (entry.value.length < REVEAL_REDACTION_MIN_LENGTH) continue;
    const escaped = JSON.stringify(entry.value).slice(1, -1);
    if (!haystack.includes(entry.value) && !haystack.includes(escaped)) continue;
    if (trusted) redactor.add(entry.value, entry.token);
    else redactor.add(entry.value, UNVERIFIED_SENSITIVE_PLACEHOLDER, { unverified: true });
  }
  return true;
}

const OBSERVED: unique symbol = Symbol("l2m.sensitiveResultsObserved");

/**
 * The registry with every adapter's `invokeTool` result checked for a sensitive values marker (`protectSensitiveResult`)
 * before anyone else sees it: MCP Tool nodes, agents' tool calls and sub-workflows all call through it.
 */
export function observeSensitiveResults(registry: MCPRegistry, redactor: RevealRedactor, verify?: SensitiveValuesVerifier): MCPRegistry {
  if ((registry as unknown as Record<symbol, unknown>)[OBSERVED]) return registry;
  const wrapped = new WeakMap<MCPServerAdapter, MCPServerAdapter>();
  const wrap = (adapter: MCPServerAdapter): MCPServerAdapter => {
    const known = wrapped.get(adapter);
    if (known) return known;
    const proxy = new Proxy(adapter, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function" || property === "constructor") return value;
        if (property !== "invokeTool") return value.bind(target);
        return async (...args: Parameters<MCPServerAdapter["invokeTool"]>) => {
          const result = await (value as MCPServerAdapter["invokeTool"]).apply(target, args);
          if (result && typeof result === "object" && protectSensitiveResult(result, redactor, verify)) {
            currentLabelScope()?.add(SENSITIVE);
          }
          return result;
        };
      }
    });
    wrapped.set(adapter, proxy);
    return proxy;
  };
  return new Proxy(registry, {
    get(target, property) {
      if (property === OBSERVED) return true;
      if (property === "get") return (serverId: string) => wrap(target.get(serverId));
      if (property === "tryGet") {
        return (serverId: string) => {
          const adapter = target.tryGet(serverId);
          return adapter ? wrap(adapter) : adapter;
        };
      }
      if (property === "list") return () => target.list().map(wrap);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
