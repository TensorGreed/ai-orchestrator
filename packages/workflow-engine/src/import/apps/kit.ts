/**
 * Toolkit handed to the per-app import handlers.
 *
 * The converter in `external-builder.ts` owns expression translation, secret
 * placeholders and node construction. App handlers receive those helpers
 * through this kit instead of importing the converter, which keeps the module
 * graph acyclic and the app modules small and table-driven.
 */
import type { WorkflowNode, WorkflowNodeType } from "@ai-orchestrator/shared";
import type { ConversionContext, ConvertedNode, ExpressionScope, NodeHandler, SourceNode } from "../handler-types.js";

export interface AppKit {
  toRecord(value: unknown): Record<string, unknown>;
  toArray(value: unknown): unknown[];
  asString(value: unknown, fallback?: string): string;
  asNumber(value: unknown, fallback: number): number;
  unwrapResourceLocator(value: unknown): unknown;
  slugifyNodeId(name: string): string;
  /** Translates one parameter value (expressions are rewritten and flagged the same way as for core nodes). */
  tpl(raw: unknown, ctx: ConversionContext, scope: ExpressionScope, path: string): string;
  baseNode(source: SourceNode, scope: ExpressionScope, type: WorkflowNodeType, config: Record<string, unknown>): WorkflowNode;
  mapped(node: WorkflowNode, extra?: Partial<ConvertedNode>): ConvertedNode;
  approximated(node: WorkflowNode, reasons: string[], extra?: Partial<ConvertedNode>): ConvertedNode;
  unsupportedPlaceholder(source: SourceNode, scope: ExpressionScope, reason: string): ConvertedNode;
  /**
   * Registers the node's credential as a secretRef placeholder named after
   * what the user has to provide (for example "Slack bot token"). When the
   * export lists no credential, a per-node placeholder is created instead so
   * the secret still shows up in the post-import checklist.
   */
  appSecret(source: SourceNode, ctx: ConversionContext, scope: ExpressionScope, credentialType: string, label: string): { secretId: string };
}

export interface AppRegistration {
  sourceType: string;
  targetType: WorkflowNodeType;
  notes: string;
  handler: NodeHandler;
}

/** A resource-locator value read with its selection mode. */
export interface Locator {
  /** The raw `value` (id, name or URL depending on `mode`), or the plain value for non-locator params. */
  value: string;
  /** `id`, `list`, `url`, `name`, or `""` for a plain value. */
  mode: string;
  /** Display name cached by the source builder when the item was picked from a list. */
  cachedName: string;
}

export function readLocator(kit: AppKit, raw: unknown): Locator {
  const record = kit.toRecord(raw);
  if (record.__rl === true || ("value" in record && "mode" in record)) {
    return {
      value: kit.asString(record.value).trim(),
      mode: kit.asString(record.mode).trim().toLowerCase(),
      cachedName: kit.asString(record.cachedResultName).trim()
    };
  }
  return { value: kit.asString(raw).trim(), mode: "", cachedName: "" };
}

export interface ResolvedId {
  /** The id to put in the config; empty when nothing could be derived. */
  id: string;
  /** Set when the id is missing or had to be approximated; names what to fix after import. */
  reason?: string;
}

/**
 * Resolves a resource locator to an id. `list` and `id` modes carry the id
 * directly; `url` mode is matched against `urlPattern` (first capture group)
 * when one is given. Anything else is kept verbatim and flagged.
 */
export function resolveLocatorId(
  kit: AppKit,
  ctx: ConversionContext,
  scope: ExpressionScope,
  raw: unknown,
  what: string,
  path: string,
  urlPattern?: RegExp
): ResolvedId {
  const locator = readLocator(kit, raw);
  const value = locator.value;
  if (!value) {
    return { id: "", reason: `No ${what} was set; fill it in after import.` };
  }
  if (value.startsWith("=")) {
    return { id: kit.tpl(value, ctx, scope, path) };
  }
  if (locator.mode === "url") {
    const match = urlPattern ? urlPattern.exec(value) : null;
    if (match?.[1]) return { id: match[1] };
    return { id: value, reason: `The ${what} is referenced by URL ('${value}'); replace it with the id after import.` };
  }
  if (locator.mode === "name") {
    return { id: value, reason: `The ${what} is referenced by name ('${value}'); replace it with the id after import.` };
  }
  return { id: value };
}

/** Builds a JSON string whose values are translated templates, for `*Json` config fields. */
export function jsonTemplate(kit: AppKit, ctx: ConversionContext, scope: ExpressionScope, path: string, fields: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = typeof value === "string" ? kit.tpl(value, ctx, scope, `${path}.${key}`) : value;
  }
  return JSON.stringify(out);
}

/** Translates each string in an array (for example Telegram chat ids or Sheets cell values). */
export function translatedList(kit: AppKit, ctx: ConversionContext, scope: ExpressionScope, path: string, values: unknown[]): string[] {
  return values.map((value, index) => kit.tpl(value, ctx, scope, `${path}[${index}]`));
}

/** The `(resource, operation)` pair of a source app node, with the source builder's defaults. */
export function resourceOperation(kit: AppKit, source: SourceNode, defaults: { resource: string; operation: string }): { resource: string; operation: string } {
  return {
    resource: kit.asString(source.parameters.resource).trim() || defaults.resource,
    operation: kit.asString(source.parameters.operation).trim() || defaults.operation
  };
}

export type OperationHandler = (source: SourceNode, ctx: ConversionContext, scope: ExpressionScope, kit: AppKit) => ConvertedNode;

/**
 * Builds a resource/operation dispatcher. Unknown pairs become the standard
 * unsupported placeholder with a reason that names the pair.
 */
export function dispatchOperations(
  kit: AppKit,
  appLabel: string,
  defaults: { resource: string; operation: string },
  table: Record<string, OperationHandler>
): NodeHandler {
  return (source, ctx, scope) => {
    const { resource, operation } = resourceOperation(kit, source, defaults);
    const handler = table[`${resource}/${operation}`];
    if (handler) return handler(source, ctx, scope, kit);
    return kit.unsupportedPlaceholder(
      source,
      scope,
      `${appLabel} resource '${resource}' operation '${operation}' has no L2M equivalent; imported as a disabled placeholder.`
    );
  };
}

/** Lists the keys of `options` that the target node cannot carry, for approximation reasons. */
export function droppedOptions(kit: AppKit, options: unknown, keep: readonly string[]): string[] {
  return Object.keys(kit.toRecord(options)).filter((key) => !keep.includes(key));
}

/** Turns a list of event names from a trigger into a reason when the L2M trigger cannot filter on them. */
export function eventFilterReason(kit: AppKit, events: unknown, what = "Event filters"): string | undefined {
  const names = kit
    .toArray(events)
    .map((event) => kit.asString(event).trim())
    .filter(Boolean);
  if (names.length === 0 || names.includes("*")) return undefined;
  return `${what} (${names.join(", ")}) are not supported; the trigger receives every event sent to its endpoint, so filter downstream.`;
}

/** Finishes a node: mapped when nothing was lost, approximated otherwise. */
export function finish(kit: AppKit, node: WorkflowNode, reasons: Array<string | undefined>): ConvertedNode {
  const kept = reasons.filter((reason): reason is string => Boolean(reason));
  return kept.length ? kit.approximated(node, kept) : kit.mapped(node);
}
