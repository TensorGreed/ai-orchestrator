/**
 * External workflow import.
 *
 * Pure converter that turns an export from an external visual workflow builder
 * (top-level `nodes[]`, `connections{}`, `settings`, `pinData`) into an L2M
 * workflow plus a per-node import report. It has no I/O and no dependency on
 * the executor: the result is a plain workflow object that passes
 * `validateWorkflowGraph`, with every source node accounted for in the report.
 */
import {
  WORKFLOW_SCHEMA_VERSION,
  workflowSchema,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType
} from "@ai-orchestrator/shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ImportNodeStatus = "mapped" | "approximated" | "unsupported";

export interface ImportReportNodeEntry {
  sourceName: string;
  sourceType: string;
  sourceId?: string;
  targetNodeId: string;
  targetType: WorkflowNodeType;
  status: ImportNodeStatus;
  reason: string;
}

export interface ImportReportExpression {
  nodeId: string;
  sourceName: string;
  /** Config path the expression lives at, e.g. `urlTemplate` or `assignments[1].valueTemplate`. */
  path: string;
  /** Original expression body, exactly as it appeared in the export. */
  expression: string;
  reason: string;
}

export interface ImportReportSecret {
  secretId: string;
  credentialType: string;
  credentialName: string;
  nodeIds: string[];
}

export interface ImportReport {
  sourceName: string;
  nodes: ImportReportNodeEntry[];
  unresolvedExpressions: ImportReportExpression[];
  secretsToResolve: ImportReportSecret[];
  /** Workflow variables created as placeholders for `$env` / `$vars` references. */
  variablesToSet: string[];
  warnings: string[];
  summary: {
    total: number;
    mapped: number;
    approximated: number;
    unsupported: number;
  };
}

export interface ExternalWorkflowConversion {
  workflow: Workflow;
  report: ImportReport;
}

export class ExternalWorkflowImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalWorkflowImportError";
  }
}

// ---------------------------------------------------------------------------
// Source shapes (loosely typed on purpose; everything is defensively read)
// ---------------------------------------------------------------------------

interface SourceNode {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  position?: unknown;
  parameters: Record<string, unknown>;
  credentials: Record<string, Record<string, unknown>>;
  disabled: boolean;
  notes?: string;
}

interface SourceConnectionTarget {
  node: string;
  type: string;
  index: number;
}

interface SourceConnection {
  sourceName: string;
  connectionType: string;
  outputIndex: number;
  target: SourceConnectionTarget;
}

interface SourceWorkflow {
  name: string;
  nodes: SourceNode[];
  connections: SourceConnection[];
  settings: Record<string, unknown>;
  pinData: Record<string, unknown>;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Conversion context shared by all node handlers
// ---------------------------------------------------------------------------

interface ExpressionScope {
  nodeId: string;
  sourceName: string;
  /** Id of the node feeding this node's main input, when there is exactly one obvious one. */
  previousNodeId?: string;
}

interface ConvertedNode {
  node: WorkflowNode;
  status: ImportNodeStatus;
  reason: string;
  /** Source output index → L2M sourceHandle for branching nodes. */
  outputHandles?: string[];
  /** Nodes that only make sense as agent attachments and must not be wired into the DAG. */
  attachmentOnly?: boolean;
}

interface ConversionContext {
  source: SourceWorkflow;
  nodeIdByName: Map<string, string>;
  previousNodeIdByName: Map<string, string | undefined>;
  report: ImportReport;
  secrets: Map<string, ImportReportSecret>;
  variables: Set<string>;
  settingsTimezone: string;
}

type NodeHandler = (source: SourceNode, ctx: ConversionContext, scope: ExpressionScope) => ConvertedNode;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

/** Resource-locator values (`{ __rl: true, value, mode }`) collapse to their `value`. */
function unwrapResourceLocator(value: unknown): unknown {
  const record = toRecord(value);
  if (record.__rl === true || ("value" in record && "mode" in record)) {
    return record.value;
  }
  return value;
}

export function slugifyNodeId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
  if (!slug) return "node";
  return /^[0-9]/.test(slug) ? `n_${slug}` : slug;
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function normalizeType(type: string): string {
  return type.trim().toLowerCase();
}

function shortType(type: string): string {
  const index = type.lastIndexOf(".");
  return index >= 0 ? type.slice(index + 1) : type;
}

// ---------------------------------------------------------------------------
// Parsing the raw export
// ---------------------------------------------------------------------------

function parseSource(raw: unknown): SourceWorkflow {
  const root = toRecord(raw);
  if (!Array.isArray(root.nodes)) {
    throw new ExternalWorkflowImportError("External workflow export must contain a top-level 'nodes' array.");
  }

  const nodes: SourceNode[] = [];
  const seenNames = new Set<string>();
  for (const [index, rawNode] of root.nodes.entries()) {
    const record = toRecord(rawNode);
    const type = asString(record.type).trim();
    if (!type) {
      throw new ExternalWorkflowImportError(`Node #${index + 1} has no 'type'.`);
    }
    let name = asString(record.name).trim() || `${shortType(type)} ${index + 1}`;
    while (seenNames.has(name)) {
      name = `${name} (${index + 1})`;
    }
    seenNames.add(name);

    const credentials: Record<string, Record<string, unknown>> = {};
    for (const [credentialType, credential] of Object.entries(toRecord(record.credentials))) {
      credentials[credentialType] = toRecord(credential);
    }

    nodes.push({
      id: typeof record.id === "string" ? record.id : undefined,
      name,
      type,
      typeVersion: typeof record.typeVersion === "number" ? record.typeVersion : undefined,
      position: record.position,
      parameters: toRecord(record.parameters),
      credentials,
      disabled: record.disabled === true,
      notes: typeof record.notes === "string" ? record.notes : undefined
    });
  }

  const connections: SourceConnection[] = [];
  for (const [sourceName, byType] of Object.entries(toRecord(root.connections))) {
    for (const [connectionType, outputs] of Object.entries(toRecord(byType))) {
      for (const [outputIndex, targets] of toArray(outputs).entries()) {
        for (const rawTarget of toArray(targets)) {
          const target = toRecord(rawTarget);
          const targetName = asString(target.node).trim();
          if (!targetName) continue;
          connections.push({
            sourceName,
            connectionType,
            outputIndex,
            target: {
              node: targetName,
              type: asString(target.type, connectionType),
              index: asNumber(target.index, 0)
            }
          });
        }
      }
    }
  }

  const tags = toArray(root.tags)
    .map((tag) => (typeof tag === "string" ? tag : asString(toRecord(tag).name)))
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0 && tag.length <= 64);

  return {
    name: asString(root.name).trim() || "Imported workflow",
    nodes,
    connections,
    settings: toRecord(root.settings),
    pinData: toRecord(root.pinData),
    tags
  };
}

// ---------------------------------------------------------------------------
// Expression translation
// ---------------------------------------------------------------------------

const KNOWN_RUNTIME_REFERENCES = new Set([
  "$now",
  "$today",
  "$if",
  "$ifEmpty",
  "$jmespath",
  "$json",
  "$input",
  "$itemIndex",
  "$workflow",
  "$execution"
]);

interface TranslatedExpression {
  value: string;
  unresolved: string[];
}

interface BodyTranslation {
  body: string;
  simplePath: boolean;
  unresolved: string[];
}

function resolveNodeReference(name: string, ctx: ConversionContext): string | undefined {
  return ctx.nodeIdByName.get(name);
}

/**
 * Translates one expression body (the text between `{{` and `}}`) into the
 * L2M expression dialect. Returns the translated body plus the list of
 * constructs it could not translate; the caller keeps the original verbatim
 * when that list is non-empty.
 */
function translateExpressionBody(body: string, ctx: ConversionContext, scope: ExpressionScope): BodyTranslation {
  const unresolved: string[] = [];
  let text = body;

  const nodeRef = (name: string): string | undefined => {
    const id = resolveNodeReference(name, ctx);
    if (!id) {
      unresolved.push(`unknown node reference '${name}'`);
      return undefined;
    }
    return `results.${id}`;
  };

  // $('Name').item.json / .first().json / .last().json / .json
  text = text.replace(
    /\$\(\s*(['"])(.*?)\1\s*\)\s*\.(?:item\.json|first\(\)\.json|last\(\)\.json|json)/g,
    (match, _quote: string, name: string) => nodeRef(name) ?? match
  );
  // $('Name').all() has no single-item equivalent.
  text = text.replace(/\$\(\s*(['"])(.*?)\1\s*\)\s*\.all\(\)/g, (match, _quote: string, name: string) => {
    unresolved.push(`item list access on node '${name}' ($(...).all())`);
    return match;
  });
  // $node["Name"].json / $node['Name'].json / $node.Name.json
  text = text.replace(
    /\$node\s*\[\s*(['"])(.*?)\1\s*\]\s*\.json/g,
    (match, _quote: string, name: string) => nodeRef(name) ?? match
  );
  text = text.replace(/\$node\.([A-Za-z_][A-Za-z0-9_]*)\.json/g, (match, name: string) => nodeRef(name) ?? match);
  // $items("Name")[0].json
  text = text.replace(
    /\$items\(\s*(['"])(.*?)\1\s*\)\s*\[\s*0\s*\]\s*\.json/g,
    (match, _quote: string, name: string) => nodeRef(name) ?? match
  );

  // Current-item references resolve to the feeding node when there is one;
  // otherwise `$json` is already the merged context in the L2M engine.
  const previousRef = scope.previousNodeId ? `results.${scope.previousNodeId}` : "$json";
  text = text.replace(/\$input\.(?:item\.json|first\(\)\.json|last\(\)\.json)/g, previousRef);
  text = text.replace(/\$input\.all\(\)/g, (match) => {
    unresolved.push("item list access ($input.all())");
    return match;
  });
  text = text.replace(/\$json\b/g, previousRef);

  // Environment and workflow variables become workflow variables.
  text = text.replace(/\$(?:env|vars)\s*\[\s*(['"])(.*?)\1\s*\]/g, (_match, _quote: string, name: string) => {
    ctx.variables.add(name);
    return `vars.${name}`;
  });
  text = text.replace(/\$(?:env|vars)\.([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    ctx.variables.add(name);
    return `vars.${name}`;
  });

  // Workflow / execution metadata.
  text = text.replace(/\$workflow\.(id|name)\b/g, "workflow.$1");
  text = text.replace(/\$execution\.id\b/g, "execution.id");

  // Date helpers: the source exposes a rich date object, L2M exposes a plain Date.
  text = text.replace(/\$(now|today)\.toISO\(\)/g, "$$$1.toISOString()");
  text = text.replace(/\$(now|today)\.toISODate\(\)/g, "$$$1.toISOString().slice(0, 10)");
  text = text.replace(/\$(now|today)\.toMillis\(\)/g, "$$$1.getTime()");
  text = text.replace(/\$(now|today)\.toSeconds\(\)/g, "Math.floor($$$1.getTime() / 1000)");
  text = text.replace(/\$(now|today)\.(toFormat|plus|minus|startOf|endOf|setZone|diff)\(/g, (match, _name: string, method: string) => {
    unresolved.push(`date helper .${method}() has no direct equivalent`);
    return match;
  });
  text = text.replace(/\$(now|today)(?![\w.(])/g, "$$$1.toISOString()");

  // Anything else that still starts with `$` is a runtime we do not provide.
  for (const match of text.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*/g)) {
    const token = match[0];
    if (!KNOWN_RUNTIME_REFERENCES.has(token)) {
      unresolved.push(`unsupported runtime reference '${token}'`);
    }
  }

  const trimmed = text.trim();
  return {
    body: trimmed,
    simplePath: /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*$/.test(trimmed),
    unresolved: [...new Set(unresolved)]
  };
}

/**
 * Translates a parameter value. Expression strings (leading `=`) have each
 * `{{ ... }}` body translated; plain strings are kept as literals. Untranslatable
 * bodies are kept verbatim and reported.
 */
function translateTemplate(
  raw: unknown,
  ctx: ConversionContext,
  scope: ExpressionScope,
  path: string
): TranslatedExpression {
  if (typeof raw !== "string") {
    return { value: asString(raw), unresolved: [] };
  }
  if (!raw.startsWith("=")) {
    return { value: raw, unresolved: [] };
  }

  const unresolved: string[] = [];
  const value = raw.slice(1).replace(/{{\s*([\s\S]+?)\s*}}/g, (_match, body: string) => {
    const translated = translateExpressionBody(body, ctx, scope);
    if (translated.unresolved.length > 0) {
      unresolved.push(...translated.unresolved);
      ctx.report.unresolvedExpressions.push({
        nodeId: scope.nodeId,
        sourceName: scope.sourceName,
        path,
        expression: body.trim(),
        reason: translated.unresolved.join("; ")
      });
      return `{{ ${body.trim()} }}`;
    }
    return translated.simplePath ? `{{${translated.body}}}` : `{{ ${translated.body} }}`;
  });

  return { value, unresolved };
}

/** Convenience wrapper returning only the translated string. */
function tpl(raw: unknown, ctx: ConversionContext, scope: ExpressionScope, path: string): string {
  return translateTemplate(raw, ctx, scope, path).value;
}

interface JsOperand {
  expression: string;
  /** True when part of the operand was kept verbatim because it could not be translated. */
  verbatim: boolean;
}

function escapeTemplateLiteral(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/**
 * Converts a parameter value into a JavaScript expression usable inside an
 * L2M `{{ ... }}` body (for IF / Switch conditions). Untranslatable bodies are
 * kept verbatim, reported, and flagged on the returned operand.
 */
function toJsOperand(raw: unknown, ctx: ConversionContext, scope: ExpressionScope, path: string): JsOperand {
  if (typeof raw === "number" || typeof raw === "boolean") return { expression: String(raw), verbatim: false };
  if (raw === null || raw === undefined) return { expression: "undefined", verbatim: false };
  if (typeof raw !== "string") return { expression: JSON.stringify(raw), verbatim: false };
  if (!raw.startsWith("=")) return { expression: JSON.stringify(raw), verbatim: false };

  let verbatim = false;
  const translateBody = (body: string): string => {
    const translated = translateExpressionBody(body, ctx, scope);
    if (translated.unresolved.length > 0) {
      verbatim = true;
      ctx.report.unresolvedExpressions.push({
        nodeId: scope.nodeId,
        sourceName: scope.sourceName,
        path,
        expression: body.trim(),
        reason: translated.unresolved.join("; ")
      });
      return body.trim();
    }
    return translated.body;
  };

  const source = raw.slice(1);
  const single = source.match(/^\s*{{\s*([\s\S]+?)\s*}}\s*$/);
  if (single) {
    const body = translateBody(single[1]);
    const simplePath = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*$/.test(body);
    return { expression: simplePath ? body : `(${body})`, verbatim };
  }

  const pattern = /{{\s*([\s\S]+?)\s*}}/g;
  let literal = "`";
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    literal += escapeTemplateLiteral(source.slice(cursor, match.index));
    literal += `\${${translateBody(match[1])}}`;
    cursor = (match.index ?? 0) + match[0].length;
  }
  literal += escapeTemplateLiteral(source.slice(cursor)) + "`";
  return { expression: literal, verbatim };
}

// ---------------------------------------------------------------------------
// Conditions (IF / Switch / Filter)
// ---------------------------------------------------------------------------

interface SourceCondition {
  leftValue: unknown;
  rightValue: unknown;
  type: string;
  operation: string;
}

interface ParsedConditions {
  conditions: SourceCondition[];
  combinator: "and" | "or";
}

/** Supports both the structured (v2) conditions block and the legacy per-type lists. */
function parseConditions(raw: unknown): ParsedConditions | undefined {
  const record = toRecord(raw);
  if (Array.isArray(record.conditions)) {
    const conditions = record.conditions.map((entry) => {
      const condition = toRecord(entry);
      const operator = toRecord(condition.operator);
      return {
        leftValue: condition.leftValue,
        rightValue: condition.rightValue,
        type: asString(operator.type, "string"),
        operation: asString(operator.operation, "equals")
      };
    });
    return { conditions, combinator: record.combinator === "or" ? "or" : "and" };
  }

  const legacyTypes = ["string", "number", "boolean", "dateTime"] as const;
  const conditions: SourceCondition[] = [];
  for (const type of legacyTypes) {
    for (const entry of toArray(record[type])) {
      const condition = toRecord(entry);
      conditions.push({
        leftValue: condition.value1,
        rightValue: condition.value2,
        type,
        operation: asString(condition.operation, "equal")
      });
    }
  }
  if (conditions.length === 0) return undefined;
  return { conditions, combinator: "and" };
}

interface ConditionBuild {
  expression: string;
  approximations: string[];
}

function buildConditionExpression(
  parsed: ParsedConditions,
  ctx: ConversionContext,
  scope: ExpressionScope,
  path: string
): ConditionBuild | undefined {
  const approximations: string[] = [];
  const clauses: string[] = [];

  for (const [index, condition] of parsed.conditions.entries()) {
    const leftOperand = toJsOperand(condition.leftValue, ctx, scope, `${path}[${index}].leftValue`);
    const rightOperand = toJsOperand(condition.rightValue, ctx, scope, `${path}[${index}].rightValue`);
    const left = leftOperand.expression;
    const right = rightOperand.expression;
    if (leftOperand.verbatim || rightOperand.verbatim) {
      approximations.push(`condition #${index + 1} keeps an untranslated expression verbatim`);
    }

    const operation = condition.operation.replace(/^not(?=[A-Z])/, "not").trim();
    const isLiteral = (operand: string) => /^(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false)$/.test(operand);
    const str = (operand: string) => (isLiteral(operand) ? (operand.startsWith('"') ? operand : `"${operand}"`) : `String(${operand} ?? "")`);
    const num = (operand: string) => `Number(${operand})`;
    const date = (operand: string) => `new Date(${operand}).getTime()`;
    const isEmpty = (operand: string) =>
      `(${operand} === undefined || ${operand} === null || ${operand} === "" || (Array.isArray(${operand}) && ${operand}.length === 0))`;
    const exists = (operand: string) => `(${operand} !== undefined && ${operand} !== null)`;

    let clause: string;
    switch (operation) {
      case "equals":
      case "equal":
        clause =
          condition.type === "number"
            ? `${num(left)} === ${num(right)}`
            : condition.type === "boolean"
              ? `${str(left)} === ${str(right)}`
              : condition.type === "dateTime"
                ? `${date(left)} === ${date(right)}`
                : `${str(left)} === ${str(right)}`;
        break;
      case "notEquals":
      case "notEqual":
        clause =
          condition.type === "number"
            ? `${num(left)} !== ${num(right)}`
            : condition.type === "dateTime"
              ? `${date(left)} !== ${date(right)}`
              : `${str(left)} !== ${str(right)}`;
        break;
      case "contains":
        clause =
          condition.type === "array"
            ? `(Array.isArray(${left}) && ${left}.includes(${right}))`
            : `${str(left)}.includes(${str(right)})`;
        break;
      case "notContains":
        clause =
          condition.type === "array"
            ? `!(Array.isArray(${left}) && ${left}.includes(${right}))`
            : `!${str(left)}.includes(${str(right)})`;
        break;
      case "startsWith":
        clause = `${str(left)}.startsWith(${str(right)})`;
        break;
      case "notStartsWith":
        clause = `!${str(left)}.startsWith(${str(right)})`;
        break;
      case "endsWith":
        clause = `${str(left)}.endsWith(${str(right)})`;
        break;
      case "notEndsWith":
        clause = `!${str(left)}.endsWith(${str(right)})`;
        break;
      case "regex":
        clause = `new RegExp(${str(right)}).test(${str(left)})`;
        break;
      case "notRegex":
        clause = `!new RegExp(${str(right)}).test(${str(left)})`;
        break;
      case "gt":
      case "larger":
      case "after":
        clause = condition.type === "dateTime" || operation === "after" ? `${date(left)} > ${date(right)}` : `${num(left)} > ${num(right)}`;
        break;
      case "gte":
      case "largerEqual":
      case "afterOrEquals":
        clause =
          condition.type === "dateTime" || operation === "afterOrEquals"
            ? `${date(left)} >= ${date(right)}`
            : `${num(left)} >= ${num(right)}`;
        break;
      case "lt":
      case "smaller":
      case "before":
        clause = condition.type === "dateTime" || operation === "before" ? `${date(left)} < ${date(right)}` : `${num(left)} < ${num(right)}`;
        break;
      case "lte":
      case "smallerEqual":
      case "beforeOrEquals":
        clause =
          condition.type === "dateTime" || operation === "beforeOrEquals"
            ? `${date(left)} <= ${date(right)}`
            : `${num(left)} <= ${num(right)}`;
        break;
      case "exists":
      case "isNotEmpty":
      case "notEmpty":
        clause = operation === "exists" ? exists(left) : `!${isEmpty(left)}`;
        break;
      case "notExists":
      case "isEmpty":
      case "empty":
        clause = operation === "notExists" ? `!${exists(left)}` : isEmpty(left);
        break;
      case "true":
        clause = `(${left} === true || ${str(left)} === "true")`;
        break;
      case "false":
        clause = `(${left} === false || ${str(left)} === "false")`;
        break;
      case "lengthEquals":
        clause = `(Array.isArray(${left}) && ${left}.length === ${num(right)})`;
        break;
      case "lengthNotEquals":
        clause = `(Array.isArray(${left}) && ${left}.length !== ${num(right)})`;
        break;
      case "lengthGt":
        clause = `(Array.isArray(${left}) && ${left}.length > ${num(right)})`;
        break;
      case "lengthGte":
        clause = `(Array.isArray(${left}) && ${left}.length >= ${num(right)})`;
        break;
      case "lengthLt":
        clause = `(Array.isArray(${left}) && ${left}.length < ${num(right)})`;
        break;
      case "lengthLte":
        clause = `(Array.isArray(${left}) && ${left}.length <= ${num(right)})`;
        break;
      default:
        approximations.push(`operator '${condition.type}:${condition.operation}' approximated as string equality`);
        clause = `${str(left)} === ${str(right)}`;
    }
    clauses.push(`(${clause})`);
  }

  if (clauses.length === 0) return undefined;
  const expression = clauses.length === 1 ? clauses[0] : clauses.join(parsed.combinator === "or" ? " || " : " && ");
  return { expression, approximations: [...new Set(approximations)] };
}

const FILTER_OPERATOR_MAP: Record<string, string> = {
  equals: "eq",
  equal: "eq",
  notEquals: "neq",
  notEqual: "neq",
  gt: "gt",
  larger: "gt",
  gte: "gte",
  largerEqual: "gte",
  lt: "lt",
  smaller: "lt",
  lte: "lte",
  smallerEqual: "lte",
  contains: "contains",
  notContains: "not_contains",
  startsWith: "starts_with",
  endsWith: "ends_with",
  empty: "is_empty",
  isEmpty: "is_empty",
  notEmpty: "is_not_empty",
  isNotEmpty: "is_not_empty",
  regex: "regex",
  exists: "is_not_empty",
  notExists: "is_empty"
};

// ---------------------------------------------------------------------------
// Credentials → secretRef placeholders
// ---------------------------------------------------------------------------

function registerSecret(source: SourceNode, nodeId: string, ctx: ConversionContext): { secretId: string } | undefined {
  const entries = Object.entries(source.credentials);
  if (entries.length === 0) return undefined;

  let first: { secretId: string } | undefined;
  for (const [credentialType, credential] of entries) {
    const credentialName = asString(credential.name).trim() || credentialType;
    const secretId = `import-${slugifyNodeId(credentialType)}-${slugifyNodeId(credentialName)}`;
    const existing = ctx.secrets.get(secretId);
    if (existing) {
      if (!existing.nodeIds.includes(nodeId)) existing.nodeIds.push(nodeId);
    } else {
      ctx.secrets.set(secretId, { secretId, credentialType, credentialName, nodeIds: [nodeId] });
    }
    first ??= { secretId };
  }
  return first;
}

/** Placeholder for a credential the export references implicitly (none listed on the node). */
function placeholderSecret(ctx: ConversionContext, nodeId: string, credentialType: string, credentialName: string): { secretId: string } {
  const secretId = `import-${slugifyNodeId(credentialType)}-${nodeId}`;
  if (!ctx.secrets.has(secretId)) {
    ctx.secrets.set(secretId, { secretId, credentialType, credentialName, nodeIds: [nodeId] });
  }
  return { secretId };
}

// ---------------------------------------------------------------------------
// Node handlers
// ---------------------------------------------------------------------------

function readPosition(value: unknown): { x: number; y: number } {
  if (Array.isArray(value) && value.length >= 2) {
    return { x: asNumber(value[0], 0), y: asNumber(value[1], 0) };
  }
  const record = toRecord(value);
  return { x: asNumber(record.x, 0), y: asNumber(record.y, 0) };
}

function baseNode(source: SourceNode, scope: ExpressionScope, type: WorkflowNodeType, config: Record<string, unknown>): WorkflowNode {
  const node: WorkflowNode = {
    id: scope.nodeId,
    type,
    name: source.name,
    position: readPosition(source.position),
    config
  };
  if (source.disabled) node.disabled = true;
  return node;
}

function mapped(node: WorkflowNode, extra: Partial<ConvertedNode> = {}): ConvertedNode {
  return { node, status: "mapped", reason: "Mapped directly.", ...extra };
}

function approximated(node: WorkflowNode, reasons: string[], extra: Partial<ConvertedNode> = {}): ConvertedNode {
  return { node, status: "approximated", reason: reasons.join(" "), ...extra };
}

function unsupportedPlaceholder(source: SourceNode, scope: ExpressionScope, reason: string): ConvertedNode {
  const credentialNames: Record<string, string> = {};
  for (const [credentialType, credential] of Object.entries(source.credentials)) {
    credentialNames[credentialType] = asString(credential.name).trim() || credentialType;
  }
  const node = baseNode(source, scope, "noop_node", {
    label: `Unsupported: ${source.type}`,
    importedFrom: {
      type: source.type,
      typeVersion: source.typeVersion,
      parameters: source.parameters,
      credentials: credentialNames,
      notes: source.notes
    }
  });
  node.disabled = true;
  return { node, status: "unsupported", reason };
}

// --- Triggers ---------------------------------------------------------------

const manualTrigger: NodeHandler = (source, _ctx, scope) =>
  mapped(baseNode(source, scope, "manual_trigger", { label: source.name }));

const webhookTrigger: NodeHandler = (source, ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  const method = asString(params.httpMethod, "POST").toUpperCase();
  const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
  const config: Record<string, unknown> = {
    path: asString(params.path).trim() || slugifyNodeId(source.name),
    method: allowedMethods.has(method) ? method : "POST",
    authMode: "none"
  };
  if (!allowedMethods.has(method)) reasons.push(`HTTP method '${method}' is not supported; defaulted to POST.`);

  const responseMode = asString(params.responseMode, "onReceived");
  if (responseMode === "lastNode" || responseMode === "responseNode" || responseMode === "onReceived") {
    config.responseMode = responseMode;
  }
  const options = toRecord(params.options);
  if (options.responseCode !== undefined) config.responseCode = asNumber(options.responseCode, 200);

  const authentication = asString(params.authentication, "none");
  if (authentication === "headerAuth") {
    config.authMode = "bearer_token";
    config.authHeaderName = "authorization";
    config.secretRef = registerSecret(source, scope.nodeId, ctx) ?? placeholderSecret(ctx, scope.nodeId, "httpHeaderAuth", source.name);
    reasons.push("Header authentication approximated as bearer_token on the 'authorization' header.");
  } else if (authentication !== "none") {
    registerSecret(source, scope.nodeId, ctx);
    reasons.push(`Authentication '${authentication}' has no equivalent; the webhook was imported without auth.`);
  }

  const node = baseNode(source, scope, "webhook_input", config);
  return reasons.length ? approximated(node, reasons) : mapped(node);
};

function intervalToCron(interval: Record<string, unknown>): { cron: string; reason?: string } {
  const field = asString(interval.field, "hours");
  const minute = Math.min(59, Math.max(0, Math.floor(asNumber(interval.triggerAtMinute, 0))));
  const hour = Math.min(23, Math.max(0, Math.floor(asNumber(interval.triggerAtHour, 0))));
  switch (field) {
    case "cronExpression":
      return { cron: asString(interval.expression).trim() || "0 * * * *" };
    case "seconds": {
      return { cron: "* * * * *", reason: "Second-level intervals are not supported; approximated as every minute." };
    }
    case "minutes": {
      const every = Math.max(1, Math.floor(asNumber(interval.minutesInterval, 1)));
      return { cron: every === 1 ? "* * * * *" : `*/${every} * * * *` };
    }
    case "hours": {
      const every = Math.max(1, Math.floor(asNumber(interval.hoursInterval, 1)));
      return { cron: every === 1 ? `${minute} * * * *` : `${minute} */${every} * * *` };
    }
    case "days": {
      const every = Math.max(1, Math.floor(asNumber(interval.daysInterval, 1)));
      return every === 1
        ? { cron: `${minute} ${hour} * * *` }
        : { cron: `${minute} ${hour} */${every} * *`, reason: `Every ${every} days approximated with a day-of-month step.` };
    }
    case "weeks": {
      const days = toArray(interval.triggerAtDay)
        .map((day) => Math.floor(asNumber(day, 0)))
        .filter((day) => day >= 0 && day <= 6);
      const dayList = days.length ? days.join(",") : "1";
      const every = Math.max(1, Math.floor(asNumber(interval.weeksInterval, 1)));
      return every === 1
        ? { cron: `${minute} ${hour} * * ${dayList}` }
        : { cron: `${minute} ${hour} * * ${dayList}`, reason: `Every ${every} weeks approximated as weekly.` };
    }
    case "months": {
      const dayOfMonth = Math.min(31, Math.max(1, Math.floor(asNumber(interval.triggerAtDayOfMonth, 1))));
      const every = Math.max(1, Math.floor(asNumber(interval.monthsInterval, 1)));
      return { cron: every === 1 ? `${minute} ${hour} ${dayOfMonth} * *` : `${minute} ${hour} ${dayOfMonth} */${every} *` };
    }
    default:
      return { cron: "0 * * * *", reason: `Unknown interval field '${field}'; defaulted to hourly.` };
  }
}

const scheduleTrigger: NodeHandler = (source, ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  let cron = "0 * * * *";

  const intervals = toArray(toRecord(params.rule).interval);
  if (intervals.length > 0) {
    const converted = intervalToCron(toRecord(intervals[0]));
    cron = converted.cron;
    if (converted.reason) reasons.push(converted.reason);
    if (intervals.length > 1) reasons.push(`Only the first of ${intervals.length} schedule rules was imported.`);
  } else {
    const legacyItems = toArray(toRecord(params.triggerTimes).item);
    if (legacyItems.length > 0) {
      const item = toRecord(legacyItems[0]);
      const mode = asString(item.mode, "everyHour");
      const minute = Math.floor(asNumber(item.minute, 0));
      const hour = Math.floor(asNumber(item.hour, 0));
      if (mode === "custom") cron = asString(item.cronExpression).trim() || cron;
      else if (mode === "everyMinute") cron = "* * * * *";
      else if (mode === "everyHour") cron = `${minute} * * * *`;
      else if (mode === "everyDay") cron = `${minute} ${hour} * * *`;
      else if (mode === "everyWeek") cron = `${minute} ${hour} * * ${Math.floor(asNumber(item.weekday, 1))}`;
      else if (mode === "everyMonth") cron = `${minute} ${hour} ${Math.floor(asNumber(item.dayOfMonth, 1))} * *`;
      else reasons.push(`Unknown schedule mode '${mode}'; defaulted to hourly.`);
      if (legacyItems.length > 1) reasons.push(`Only the first of ${legacyItems.length} trigger times was imported.`);
    } else {
      reasons.push("No schedule rule found; defaulted to hourly.");
    }
  }

  const fieldCount = cron.split(/\s+/).filter(Boolean).length;
  if (fieldCount < 5 || fieldCount > 6) {
    reasons.push(`Cron expression '${cron}' is not a 5 or 6 field expression; defaulted to hourly.`);
    cron = "0 * * * *";
  }

  const node = baseNode(source, scope, "schedule_trigger", {
    cronExpression: cron,
    timezone: ctx.settingsTimezone,
    active: !source.disabled
  });
  return reasons.length ? approximated(node, reasons) : mapped(node);
};

const chatTrigger: NodeHandler = (source, ctx, scope) => {
  const params = source.parameters;
  const options = toRecord(params.options);
  const isPublic = params.public === true;
  const config: Record<string, unknown> = {
    path: asString(params.webhookId).trim() || slugifyNodeId(source.name),
    authMode: isPublic ? "public" : "session",
    persistMessages: options.loadPreviousSession !== "notSupported",
    sessionNamespace: slugifyNodeId(ctx.source.name)
  };
  const initialMessages = asString(params.initialMessages).trim();
  if (initialMessages) config.welcomeMessage = initialMessages;
  return mapped(baseNode(source, scope, "chat_trigger", config));
};

const errorTrigger: NodeHandler = (source, _ctx, scope) => mapped(baseNode(source, scope, "error_trigger", {}));

const FORM_FIELD_TYPES: Record<string, string> = {
  text: "text",
  textarea: "textarea",
  email: "email",
  number: "number",
  dropdown: "select",
  checkbox: "checkbox",
  password: "text",
  date: "text"
};

const formTrigger: NodeHandler = (source, _ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  const fields = toArray(toRecord(params.formFields).values).map((raw, index) => {
    const field = toRecord(raw);
    const label = asString(field.fieldLabel).trim() || `field_${index + 1}`;
    const sourceType = asString(field.fieldType, "text");
    const type = FORM_FIELD_TYPES[sourceType];
    if (!type) reasons.push(`Form field '${label}' of type '${sourceType}' approximated as text.`);
    const entry: Record<string, unknown> = {
      name: slugifyNodeId(label),
      label,
      type: type ?? "text",
      required: field.requiredField === true
    };
    const placeholder = asString(field.placeholder).trim();
    if (placeholder) entry.placeholder = placeholder;
    const options = toArray(toRecord(field.fieldOptions).values)
      .map((option) => asString(toRecord(option).option).trim())
      .filter(Boolean);
    if (options.length) entry.options = options;
    return entry;
  });

  const config: Record<string, unknown> = {
    path: asString(params.formPath).trim() || slugifyNodeId(source.name),
    title: asString(params.formTitle).trim() || source.name,
    fields,
    authMode: "public"
  };
  const description = asString(params.formDescription).trim();
  if (description) config.description = description;
  const options = toRecord(params.options);
  const submitLabel = asString(options.buttonLabel).trim();
  if (submitLabel) config.submitLabel = submitLabel;
  const successMessage = asString(options.formSubmittedText).trim();
  if (successMessage) config.successMessage = successMessage;

  const node = baseNode(source, scope, "form_trigger", config);
  return reasons.length ? approximated(node, reasons) : mapped(node);
};

const rssTrigger: NodeHandler = (source, ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  const config: Record<string, unknown> = {
    feedUrl: tpl(params.feedUrl, ctx, scope, "feedUrl"),
    pollIntervalSeconds: 300,
    active: !source.disabled
  };
  const pollItems = toArray(toRecord(params.pollTimes).item);
  if (pollItems.length > 0) {
    const item = toRecord(pollItems[0]);
    const mode = asString(item.mode, "everyMinute");
    if (mode === "everyMinute") config.pollIntervalSeconds = 60;
    else if (mode === "everyHour") config.pollIntervalSeconds = 3600;
    else if (mode === "everyX") {
      const value = Math.max(1, Math.floor(asNumber(item.value, 5)));
      config.pollIntervalSeconds = asString(item.unit, "minutes") === "hours" ? value * 3600 : value * 60;
    } else {
      reasons.push(`Poll schedule '${mode}' approximated as every 5 minutes.`);
    }
  }
  const node = baseNode(source, scope, "rss_trigger", config);
  return reasons.length ? approximated(node, reasons) : mapped(node);
};

const imapTrigger: NodeHandler = (source, ctx, scope) => {
  const params = source.parameters;
  const secretRef = registerSecret(source, scope.nodeId, ctx);
  const config: Record<string, unknown> = {
    host: "",
    port: 993,
    secure: true,
    user: "",
    mailbox: asString(params.mailbox).trim() || "INBOX",
    pollIntervalSeconds: 60
  };
  if (secretRef) config.secretRef = secretRef;
  const node = baseNode(source, scope, "imap_email_trigger", config);
  return approximated(node, [
    "IMAP host, port and user live in the source credential and must be filled in after import."
  ]);
};

// --- Core nodes -------------------------------------------------------------

function keyValuePairs(raw: unknown, ctx: ConversionContext, scope: ExpressionScope, path: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [index, entry] of toArray(toRecord(raw).parameters).entries()) {
    const pair = toRecord(entry);
    const name = asString(pair.name).trim();
    if (!name) continue;
    result[name] = tpl(pair.value, ctx, scope, `${path}[${index}].value`);
  }
  return result;
}

const httpRequest: NodeHandler = (source, ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
  const rawMethod = asString(params.method ?? params.requestMethod, "GET").toUpperCase();
  const method = allowedMethods.has(rawMethod) ? rawMethod : "GET";
  if (!allowedMethods.has(rawMethod)) reasons.push(`HTTP method '${rawMethod}' is not supported; defaulted to GET.`);

  let urlTemplate = tpl(params.url, ctx, scope, "url");
  if (params.sendQuery === true) {
    const query = keyValuePairs(params.queryParameters, ctx, scope, "queryParameters");
    const pairs = Object.entries(query).map(([key, value]) => `${encodeURIComponent(key)}=${value}`);
    if (pairs.length) {
      urlTemplate += (urlTemplate.includes("?") ? "&" : "?") + pairs.join("&");
      reasons.push("Query parameters were appended to the URL template.");
    }
  }

  const config: Record<string, unknown> = { method, urlTemplate: urlTemplate || "https://", responseType: "json" };
  if (!urlTemplate) reasons.push("The request had no URL; set urlTemplate after import.");

  if (params.sendHeaders === true) {
    const headers = keyValuePairs(params.headerParameters, ctx, scope, "headerParameters");
    if (Object.keys(headers).length) config.headersTemplate = JSON.stringify(headers, null, 2);
  } else if (typeof params.headerParametersJson === "string") {
    config.headersTemplate = tpl(params.headerParametersJson, ctx, scope, "headerParametersJson");
  }

  if (params.sendBody === true) {
    const specifyBody = asString(params.specifyBody, "keypair");
    if (specifyBody === "json" || typeof params.jsonBody === "string") {
      config.bodyTemplate = tpl(params.jsonBody, ctx, scope, "jsonBody");
    } else {
      const body = keyValuePairs(params.bodyParameters, ctx, scope, "bodyParameters");
      config.bodyTemplate = JSON.stringify(body, null, 2);
      if (asString(params.contentType, "json") !== "json") {
        reasons.push(`Body content type '${asString(params.contentType)}' approximated as JSON.`);
      }
    }
  } else if (typeof params.bodyParametersJson === "string") {
    config.bodyTemplate = tpl(params.bodyParametersJson, ctx, scope, "bodyParametersJson");
  }

  const options = toRecord(params.options);
  if (options.timeout !== undefined) config.timeoutMs = Math.max(1, Math.floor(asNumber(options.timeout, 15000)));
  const responseFormat = asString(toRecord(toRecord(options.response).response).responseFormat);
  if (responseFormat === "text" || responseFormat === "file") {
    config.responseType = "text";
    if (responseFormat === "file") reasons.push("Binary responses are not supported; responseType set to text.");
  }

  const authentication = asString(params.authentication, "none");
  const secretRef = registerSecret(source, scope.nodeId, ctx);
  if (secretRef) {
    config.secretRef = secretRef;
    if (authentication !== "none") {
      reasons.push(`Authentication '${authentication}' was mapped to a secretRef placeholder; verify how the secret is applied.`);
    }
  }

  const node = baseNode(source, scope, "http_request", config);
  return reasons.length ? approximated(node, reasons) : mapped(node);
};

function buildJavaScriptShim(ctx: ConversionContext): string {
  const nodeIds: Record<string, string> = {};
  for (const [name, id] of ctx.nodeIdByName.entries()) nodeIds[name] = id;
  return [
    "// Compatibility shim added by the external workflow import.",
    `const __nodeIds = ${JSON.stringify(nodeIds)};`,
    "const __results = (input && typeof input === 'object' && input.results && typeof input.results === 'object') ? input.results : {};",
    "const __asItems = (value) => (Array.isArray(value) ? value : [value]).map((json) => ({ json }));",
    "const __nodeOutput = (name) => __results[__nodeIds[name] ?? name] ?? {};",
    "const $json = input;",
    "const $input = { all: () => __asItems(input), first: () => ({ json: input }), last: () => ({ json: input }), item: { json: input } };",
    "const $ = (name) => ({ item: { json: __nodeOutput(name) }, first: () => ({ json: __nodeOutput(name) }), last: () => ({ json: __nodeOutput(name) }), all: () => __asItems(__nodeOutput(name)) });",
    "const $node = new Proxy({}, { get: (_target, name) => ({ json: __nodeOutput(String(name)) }) });",
    "const $items = (name) => __asItems(__nodeOutput(name));",
    "const $now = new Date();",
    "const __userResult = await (async () => {"
  ].join("\n");
}

const JAVASCRIPT_SHIM_FOOTER = [
  "})();",
  "if (Array.isArray(__userResult)) {",
  "  const __plain = __userResult.map((item) => (item && typeof item === 'object' && 'json' in item ? item.json : item));",
  "  return __plain.length === 1 && __plain[0] && typeof __plain[0] === 'object' ? __plain[0] : { items: __plain };",
  "}",
  "return __userResult && typeof __userResult === 'object' && 'json' in __userResult ? __userResult.json : __userResult;"
].join("\n");

const codeNode: NodeHandler = (source, ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  const language = asString(params.language, "javaScript") === "python" ? "python" : "javascript";
  const mode = asString(params.mode, "runOnceForAllItems") === "runOnceForEachItem" ? "runOnceForEachItem" : "runOnceForAllItems";
  const config: Record<string, unknown> = { language, mode };

  if (language === "python") {
    const code = asString(params.pythonCode).trim();
    config.code = code || "return items";
    reasons.push("Python code was kept verbatim; the L2M runner exposes `items` instead of the source item helpers.");
    if (!code) reasons.push("The node had no code; a pass-through body was generated.");
  } else {
    const code = asString(params.jsCode ?? params.functionCode).trim();
    config.code = code ? `${buildJavaScriptShim(ctx)}\n${code}\n${JAVASCRIPT_SHIM_FOOTER}` : "return input;";
    reasons.push("JavaScript code was wrapped with a compatibility shim for $json, $input, $(...) and item-list return values.");
    if (!code) reasons.push("The node had no code; a pass-through body was generated.");
  }

  return approximated(baseNode(source, scope, "code_node", config), reasons);
};

const setNode: NodeHandler = (source, ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  const assignments: Array<{ key: string; valueTemplate: string }> = [];

  const mode = asString(params.mode, "manual");
  if (mode === "raw") {
    const rawJson = asString(params.jsonOutput).trim();
    let parsed: Record<string, unknown> | undefined;
    if (rawJson && !rawJson.startsWith("=")) {
      try {
        parsed = toRecord(JSON.parse(rawJson));
      } catch {
        parsed = undefined;
      }
    }
    if (parsed) {
      for (const [key, value] of Object.entries(parsed)) {
        assignments.push({ key, valueTemplate: typeof value === "string" ? value : JSON.stringify(value) });
      }
    } else if (rawJson) {
      assignments.push({ key: "json", valueTemplate: tpl(rawJson, ctx, scope, "jsonOutput") });
      reasons.push("Raw JSON output could not be split into fields; it was assigned to the 'json' key.");
    }
  } else {
    const modern = toArray(toRecord(params.assignments).assignments);
    for (const [index, entry] of modern.entries()) {
      const assignment = toRecord(entry);
      const key = asString(assignment.name).trim();
      if (!key) continue;
      const value = assignment.value;
      const valueTemplate =
        typeof value === "string"
          ? tpl(value, ctx, scope, `assignments[${index}].value`)
          : value === undefined || value === null
            ? ""
            : JSON.stringify(value);
      assignments.push({ key, valueTemplate });
    }

    const legacy = toRecord(params.values);
    for (const type of ["string", "number", "boolean"]) {
      for (const [index, entry] of toArray(legacy[type]).entries()) {
        const assignment = toRecord(entry);
        const key = asString(assignment.name).trim();
        if (!key) continue;
        assignments.push({ key, valueTemplate: tpl(assignment.value, ctx, scope, `values.${type}[${index}].value`) });
      }
    }
  }

  if (assignments.length === 0) {
    assignments.push({ key: "imported", valueTemplate: "true" });
    reasons.push("The node had no field assignments; a placeholder assignment was added.");
  }
  if (params.includeOtherFields === false || params.keepOnlySet === true) {
    reasons.push("'Keep only set fields' is not supported; other fields are passed through.");
  }

  const node = baseNode(source, scope, "set_node", { assignments });
  return reasons.length ? approximated(node, reasons) : mapped(node);
};

const ifNode: NodeHandler = (source, ctx, scope) => {
  const parsed = parseConditions(source.parameters.conditions);
  const reasons: string[] = [];
  let condition = "";

  if (parsed) {
    const built = buildConditionExpression(parsed, ctx, scope, "conditions");
    if (built) {
      condition = `{{ ${built.expression} }}`;
      reasons.push(...built.approximations);
    } else {
      condition = "{{ true }}";
      reasons.push("The IF node had no usable conditions; it always takes the true branch.");
    }
  } else {
    condition = "{{ true }}";
    reasons.push("The IF node had no conditions; it always takes the true branch.");
  }

  const node = baseNode(source, scope, "if_node", { condition, trueLabel: "true", falseLabel: "false" });
  const converted = reasons.length ? approximated(node, reasons) : mapped(node);
  converted.outputHandles = ["true", "false"];
  return converted;
};

const switchNode: NodeHandler = (source, ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  const cases: Array<{ value: string; label: string }> = [];
  const outputHandles: string[] = [];
  let switchValue = "";
  const usedLabels = new Set<string>();

  const uniqueLabel = (candidate: string, index: number): string => {
    let label = candidate.trim() || `output_${index}`;
    if (label === "default") label = `output_${index}`;
    while (usedLabels.has(label)) label = `${label}_${index}`;
    usedLabels.add(label);
    return label;
  };

  const rules = toArray(toRecord(params.rules).values);
  if (rules.length > 0) {
    const branches: Array<{ label: string; expression: string }> = [];
    let sameLeft: string | undefined;
    let allSimpleEquals = true;
    const simpleCases: Array<{ label: string; value: string }> = [];

    for (const [index, rawRule] of rules.entries()) {
      const rule = toRecord(rawRule);
      const label = uniqueLabel(rule.renameOutput === true ? asString(rule.outputKey) : "", index);
      outputHandles.push(label);
      const parsed = parseConditions(rule.conditions);
      if (!parsed) {
        allSimpleEquals = false;
        branches.push({ label, expression: "false" });
        reasons.push(`Rule #${index + 1} had no conditions and never matches.`);
        continue;
      }

      const only = parsed.conditions.length === 1 ? parsed.conditions[0] : undefined;
      const leftOperand = only ? toJsOperand(only.leftValue, ctx, scope, `rules.values[${index}].leftValue`) : undefined;
      if (
        only &&
        (only.operation === "equals" || only.operation === "equal") &&
        only.type !== "array" &&
        leftOperand &&
        !leftOperand.verbatim &&
        typeof only.rightValue !== "object" &&
        !(typeof only.rightValue === "string" && only.rightValue.startsWith("=")) &&
        (sameLeft === undefined || sameLeft === leftOperand.expression)
      ) {
        sameLeft = leftOperand.expression;
        simpleCases.push({ label, value: asString(only.rightValue) });
      } else {
        allSimpleEquals = false;
      }

      const built = buildConditionExpression(parsed, ctx, scope, `rules.values[${index}].conditions`);
      if (built) {
        branches.push({ label, expression: built.expression });
        reasons.push(...built.approximations);
      } else {
        allSimpleEquals = false;
        branches.push({ label, expression: "false" });
        reasons.push(`Rule #${index + 1} uses expressions that could not be translated and never matches.`);
      }
    }

    if (allSimpleEquals && sameLeft) {
      switchValue = /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(sameLeft) ? `{{${sameLeft}}}` : `{{ ${sameLeft} }}`;
      for (const entry of simpleCases) cases.push({ value: entry.value, label: entry.label });
    } else {
      const ternary = branches.reduceRight(
        (fallback, branch) => `(${branch.expression}) ? ${JSON.stringify(branch.label)} : ${fallback}`,
        '"default"'
      );
      switchValue = `{{ ${ternary} }}`;
      for (const branch of branches) cases.push({ value: branch.label, label: branch.label });
      reasons.push("Rules were compiled into a routing expression that yields the matching output label.");
    }
  } else {
    const legacyRules = toArray(toRecord(params.rules).rules);
    const legacyMode = asString(params.mode, "rules");
    if (legacyMode === "rules" && legacyRules.length > 0) {
      switchValue = tpl(params.value1, ctx, scope, "value1");
      for (const [index, rawRule] of legacyRules.entries()) {
        const rule = toRecord(rawRule);
        const label = uniqueLabel(asString(rule.outputKey), index);
        outputHandles.push(label);
        cases.push({ value: tpl(rule.value2, ctx, scope, `rules.rules[${index}].value2`), label });
        const operation = asString(rule.operation, "equal");
        if (operation !== "equal" && operation !== "equals") {
          reasons.push(`Rule #${index + 1} operator '${operation}' approximated as equality.`);
        }
      }
    } else {
      switchValue = tpl(params.output ?? params.value1, ctx, scope, "output") || '{{ "default" }}';
      const outputs = Math.max(1, Math.floor(asNumber(params.outputsAmount ?? params.outputsCount, 1)));
      for (let index = 0; index < outputs; index += 1) {
        const label = uniqueLabel(String(index), index);
        outputHandles.push(label);
        cases.push({ value: String(index), label });
      }
      reasons.push("Expression-mode switch approximated: the expression must evaluate to the output index.");
    }
  }

  const options = toRecord(params.options);
  const fallbackOutput = options.fallbackOutput;
  if (typeof fallbackOutput === "number") {
    reasons.push(`Fallback routed to output #${fallbackOutput + 1} is mirrored on the default handle.`);
  }
  outputHandles.push("default");

  if (cases.length === 0) {
    cases.push({ value: "default", label: "output_0" });
    reasons.push("The switch had no rules; a single placeholder case was created.");
  }

  const node = baseNode(source, scope, "switch_node", { switchValue, cases, defaultLabel: "default" });
  const converted = reasons.length ? approximated(node, reasons) : mapped(node);
  converted.outputHandles = outputHandles;
  return converted;
};

const mergeNode: NodeHandler = (source, _ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  const sourceMode = asString(params.mode, "append");
  const config: Record<string, unknown> = { mode: "append" };

  if (sourceMode === "append") {
    config.mode = "append";
  } else if (sourceMode === "chooseBranch") {
    config.mode = "choose_branch";
  } else if (sourceMode === "combine") {
    const combineBy = asString(params.combineBy ?? params.combinationMode, "combineByFields");
    if (combineBy === "combineByFields" || combineBy === "mergeByFields") {
      const fields = toArray(toRecord(params.mergeByFields).values);
      const first = toRecord(fields[0]);
      const field1 = asString(first.field1).trim();
      const field2 = asString(first.field2).trim();
      const stringKeys = asString(params.fieldsToMatchString).split(",").map((key) => key.trim()).filter(Boolean);
      const combineKey = field1 || stringKeys[0] || "id";
      config.mode = "combine_by_key";
      config.combineKey = combineKey;
      if (!field1 && !stringKeys.length) reasons.push("No match field found; combineKey defaulted to 'id'.");
      if (field2 && field2 !== field1) reasons.push(`Different match fields ('${field1}' / '${field2}') approximated with '${field1}'.`);
      if (fields.length > 1 || stringKeys.length > 1) reasons.push("Only the first match field was imported.");
    } else {
      reasons.push(`Combine mode '${combineBy}' approximated as append.`);
    }
  } else {
    reasons.push(`Merge mode '${sourceMode}' approximated as append.`);
  }

  const node = baseNode(source, scope, "merge_node", config);
  return reasons.length ? approximated(node, reasons) : mapped(node);
};

const splitOutNode: NodeHandler = (source, ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  const fields = tpl(params.fieldToSplitOut, ctx, scope, "fieldToSplitOut")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  const config: Record<string, unknown> = { field: fields[0] ?? "items" };
  if (fields.length === 0) reasons.push("No field to split out was set; defaulted to 'items'.");
  if (fields.length > 1) reasons.push("Only the first field to split out was imported.");
  const destination = asString(toRecord(params.options).destinationFieldName).trim();
  if (destination) config.destinationField = destination;
  const node = baseNode(source, scope, "split_out_node", config);
  return reasons.length ? approximated(node, reasons) : mapped(node);
};

const aggregateNode: NodeHandler = (source, ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  const config: Record<string, unknown> = { operation: "concatenate", inputKey: "items" };
  const aggregateMode = asString(params.aggregate, "individualFields");
  if (aggregateMode === "aggregateAllItemData") {
    reasons.push("Aggregating all item data approximated as concatenating the whole item list.");
  } else {
    const fields = toArray(toRecord(params.fieldsToAggregate).fieldToAggregate);
    const first = toRecord(fields[0]);
    const field = tpl(first.fieldToAggregate, ctx, scope, "fieldsToAggregate.fieldToAggregate[0]").trim();
    if (field) config.field = field;
    else reasons.push("No field to aggregate was set.");
    if (fields.length > 1) reasons.push("Only the first aggregated field was imported.");
  }
  config.separator = ",";
  reasons.push("Collecting values into an array is approximated with the concatenate operation.");
  return approximated(baseNode(source, scope, "aggregate_node", config), reasons);
};

const filterNode: NodeHandler = (source, ctx, scope) => {
  const parsed = parseConditions(source.parameters.conditions);
  const reasons: string[] = [];
  const conditions: Array<{ field: string; operator: string; value?: string }> = [];

  if (parsed) {
    for (const [index, condition] of parsed.conditions.entries()) {
      const left = translateTemplate(condition.leftValue, ctx, scope, `conditions[${index}].leftValue`);
      const match = left.value.match(/^{{\s*([A-Za-z_$][A-Za-z0-9_.$-]*)\s*}}$/);
      let field: string;
      if (match && left.unresolved.length === 0) {
        field = match[1].replace(/^\$json\./, "");
      } else {
        field = left.value;
        reasons.push(`Condition #${index + 1} compares an expression rather than a field path; verify it after import.`);
      }
      const operator = FILTER_OPERATOR_MAP[condition.operation];
      if (!operator) reasons.push(`Operator '${condition.operation}' approximated as equality.`);
      if (condition.operation === "exists" || condition.operation === "notExists") {
        reasons.push(`Operator '${condition.operation}' approximated with an emptiness check.`);
      }
      const entry: { field: string; operator: string; value?: string } = { field, operator: operator ?? "eq" };
      if (condition.rightValue !== undefined && condition.rightValue !== null) {
        entry.value = tpl(condition.rightValue, ctx, scope, `conditions[${index}].rightValue`);
      }
      conditions.push(entry);
    }
  } else {
    reasons.push("The filter had no conditions; it passes everything through.");
  }

  const node = baseNode(source, scope, "filter_node", {
    conditions,
    combineWith: parsed?.combinator === "or" ? "OR" : "AND",
    passMode: "pass"
  });
  const converted = reasons.length ? approximated(node, reasons) : mapped(node);
  converted.outputHandles = ["pass", "filtered"];
  return converted;
};

const sortNode: NodeHandler = (source, ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  const type = asString(params.type, "simple");
  const config: Record<string, unknown> = { inputKey: "items", order: "asc" };

  if (type === "random") {
    config.order = "random";
  } else if (type === "code") {
    config.expression = asString(params.code).trim();
    reasons.push("Custom sort code was kept as the sort expression and must be reviewed.");
  } else {
    const fields = toArray(toRecord(params.sortFieldsUi).sortField);
    const first = toRecord(fields[0]);
    const field = tpl(first.fieldName, ctx, scope, "sortFieldsUi.sortField[0].fieldName").trim();
    if (field) config.field = field;
    else reasons.push("No sort field was set.");
    config.order = asString(first.order, "ascending") === "descending" ? "desc" : "asc";
    if (fields.length > 1) reasons.push("Only the first sort field was imported.");
  }

  const node = baseNode(source, scope, "sort_node", config);
  return reasons.length ? approximated(node, reasons) : mapped(node);
};

const limitNode: NodeHandler = (source, _ctx, scope) => {
  const params = source.parameters;
  const node = baseNode(source, scope, "limit_node", {
    maxItems: Math.max(1, Math.floor(asNumber(params.maxItems, 1))),
    keep: asString(params.keep, "firstItems") === "lastItems" ? "last" : "first",
    inputKey: "items"
  });
  return mapped(node);
};

const UNIT_TO_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000
};

const waitNode: NodeHandler = (source, _ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  const resume = asString(params.resume, "timeInterval");
  const config: Record<string, unknown> = { resumeMode: "timer", delayMs: 1000, maxDelayMs: 30_000 };

  if (resume === "timeInterval") {
    const amount = Math.max(0, asNumber(params.amount, 1));
    const unit = asString(params.unit, "seconds");
    const delayMs = Math.floor(amount * (UNIT_TO_MS[unit] ?? 1000));
    config.delayMs = delayMs;
    config.maxDelayMs = Math.max(30_000, delayMs);
  } else if (resume === "webhook") {
    config.resumeMode = "webhook";
    config.resumeWebhookPath = asString(toRecord(params.options).webhookSuffix).trim() || scope.nodeId;
  } else if (resume === "specificTime") {
    config.resumeMode = "datetime";
    config.resumeAt = asString(params.dateTime).trim();
    if (!config.resumeAt) reasons.push("No resume time was set; fill in resumeAt after import.");
  } else {
    reasons.push(`Resume mode '${resume}' is not supported; approximated as a one second timer.`);
  }

  const node = baseNode(source, scope, "wait_node", config);
  return reasons.length ? approximated(node, reasons) : mapped(node);
};

const noOpNode: NodeHandler = (source, _ctx, scope) => mapped(baseNode(source, scope, "noop_node", { label: source.name }));

const stopAndErrorNode: NodeHandler = (source, ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  const config: Record<string, unknown> = { errorCode: "WORKFLOW_STOPPED" };
  if (asString(params.errorType, "errorMessage") === "errorObject") {
    const raw = asString(params.errorObject).trim();
    let parsed: Record<string, unknown> | undefined;
    if (raw && !raw.startsWith("=")) {
      try {
        parsed = toRecord(JSON.parse(raw));
      } catch {
        parsed = undefined;
      }
    }
    config.message = asString(parsed?.message).trim() || tpl(raw, ctx, scope, "errorObject") || "Workflow stopped.";
    const code = asString(parsed?.code ?? parsed?.errorCode).trim();
    if (code) config.errorCode = code;
    reasons.push("Error object approximated with message and errorCode.");
  } else {
    config.message = tpl(params.errorMessage, ctx, scope, "errorMessage") || "Workflow stopped.";
  }
  const node = baseNode(source, scope, "stop_and_error", config);
  return reasons.length ? approximated(node, reasons) : mapped(node);
};

const executeWorkflowNode: NodeHandler = (source, ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  const workflowId = asString(unwrapResourceLocator(params.workflowId)).trim();
  const config: Record<string, unknown> = {
    workflowId: workflowId || "replace-with-workflow-id",
    mode: toRecord(params.options).waitForSubWorkflow === false ? "async" : "sync",
    inputMapping: {}
  };
  if (!workflowId) reasons.push("No workflow id was set; replace the placeholder after import.");
  else reasons.push(`Workflow id '${workflowId}' refers to the source system; point it at the imported child workflow.`);

  const sourceKind = asString(params.source, "database");
  if (sourceKind !== "database") reasons.push(`Sub-workflow source '${sourceKind}' is not supported; only referenced workflows can be called.`);
  if (asString(params.mode, "once") === "each") reasons.push("Per-item execution approximated as a single call.");

  const inputs = toArray(toRecord(params.workflowInputs).value);
  const inputMapping: Record<string, string> = {};
  for (const entry of inputs) {
    const input = toRecord(entry);
    const name = asString(input.name).trim();
    if (!name) continue;
    const value = asString(input.value).trim();
    const simple = value.match(/^=\s*{{\s*\$json\.([A-Za-z0-9_.]+)\s*}}\s*$/);
    inputMapping[simple ? simple[1] : name] = name;
    if (!simple && value) reasons.push(`Input '${name}' uses a value expression that could not become a key mapping.`);
  }
  if (Object.keys(inputMapping).length) config.inputMapping = inputMapping;

  return approximated(baseNode(source, scope, "execute_workflow", config), reasons);
};

const STICKY_COLORS: Record<number, string> = { 1: "yellow", 2: "blue", 3: "pink", 4: "green", 5: "purple", 6: "gray", 7: "blue" };

const stickyNote: NodeHandler = (source, _ctx, scope) => {
  const params = source.parameters;
  const node = baseNode(source, scope, "sticky_note", {
    content: asString(params.content),
    color: STICKY_COLORS[Math.floor(asNumber(params.color, 1))] ?? "yellow",
    fontSize: 14,
    width: asNumber(params.width, 240),
    height: asNumber(params.height, 160)
  });
  return mapped(node);
};

// --- AI nodes ---------------------------------------------------------------

function readModelOptions(params: Record<string, unknown>): { model: string; temperature?: number; maxTokens?: number; baseUrl?: string } {
  const options = toRecord(params.options);
  const model = asString(unwrapResourceLocator(params.model ?? params.modelName)).trim();
  const result: { model: string; temperature?: number; maxTokens?: number; baseUrl?: string } = { model };
  if (options.temperature !== undefined) result.temperature = Math.min(2, Math.max(0, asNumber(options.temperature, 0.2)));
  const maxTokens = options.maxTokens ?? options.maxOutputTokens ?? options.maxTokensToSample;
  if (maxTokens !== undefined && asNumber(maxTokens, -1) > 0) result.maxTokens = Math.floor(asNumber(maxTokens, 1024));
  const baseUrl = asString(options.baseURL ?? options.baseUrl).trim();
  if (baseUrl) result.baseUrl = baseUrl;
  return result;
}

function chatModelHandler(
  targetType: WorkflowNodeType,
  defaults: { model: string; baseUrl?: string },
  extraReason?: string
): NodeHandler {
  return (source, ctx, scope) => {
    const reasons: string[] = [];
    const options = readModelOptions(source.parameters);
    const config: Record<string, unknown> = {
      model: options.model || defaults.model,
      promptKey: "prompt",
      systemPromptKey: "system_prompt"
    };
    if (!options.model) reasons.push(`No model was set; defaulted to '${defaults.model}'.`);
    if (options.temperature !== undefined) config.temperature = options.temperature;
    if (options.maxTokens !== undefined) config.maxTokens = options.maxTokens;
    const baseUrl = options.baseUrl ?? defaults.baseUrl;
    if (baseUrl) config.baseUrl = baseUrl;
    const secretRef = registerSecret(source, scope.nodeId, ctx);
    if (secretRef) config.secretRef = secretRef;
    if (extraReason) reasons.push(extraReason);

    const node = baseNode(source, scope, targetType, config);
    const converted = reasons.length ? approximated(node, reasons) : mapped(node);
    converted.attachmentOnly = true;
    return converted;
  };
}

const azureChatModel: NodeHandler = (source, ctx, scope) => {
  const options = readModelOptions(source.parameters);
  const secretRef = registerSecret(source, scope.nodeId, ctx) ?? placeholderSecret(ctx, scope.nodeId, "azureOpenAiApi", source.name);
  const config: Record<string, unknown> = {
    endpoint: "https://replace-me.openai.azure.com",
    deployment: options.model || "gpt-4o-mini",
    apiVersion: "2024-10-21",
    secretRef,
    promptKey: "prompt",
    systemPromptKey: "system_prompt"
  };
  if (options.temperature !== undefined) config.temperature = options.temperature;
  if (options.maxTokens !== undefined) config.maxTokens = options.maxTokens;
  const converted = approximated(baseNode(source, scope, "azure_openai_chat_model", config), [
    "The Azure endpoint lives in the source credential; set endpoint after import."
  ]);
  converted.attachmentOnly = true;
  return converted;
};

const genericChatModel: NodeHandler = (source, ctx, scope) => {
  const handler = chatModelHandler(
    "openai_compatible_chat_model",
    { model: "replace-me", baseUrl: "https://replace-me.invalid/v1" },
    `Chat model '${shortType(source.type)}' has no dedicated node; approximated as an OpenAI-compatible endpoint.`
  );
  return handler(source, ctx, scope);
};

const AGENT_TYPES: Record<string, string> = {
  toolsAgent: "tools",
  conversationalAgent: "tools",
  openAiFunctionsAgent: "tools",
  reActAgent: "react",
  planAndExecuteAgent: "plan-and-execute",
  sqlAgent: "sql"
};

const aiAgent: NodeHandler = (source, ctx, scope) => {
  const params = source.parameters;
  const options = toRecord(params.options);
  const reasons: string[] = [];

  const promptType = asString(params.promptType, "auto");
  const userPromptTemplate =
    promptType === "define" && typeof params.text === "string"
      ? tpl(params.text, ctx, scope, "text")
      : "{{user_prompt}}";
  if (promptType !== "define") reasons.push("Automatic prompt input approximated with the {{user_prompt}} template.");

  const agentKind = asString(params.agent, "toolsAgent");
  const agentType = AGENT_TYPES[agentKind];
  if (!agentType) reasons.push(`Agent type '${agentKind}' approximated as the tools agent.`);

  const config: Record<string, unknown> = {
    agentType: agentType ?? "tools",
    systemPromptTemplate: tpl(options.systemMessage, ctx, scope, "options.systemMessage") || "{{system_prompt}}",
    userPromptTemplate,
    sessionIdTemplate: "{{session_id}}",
    maxIterations: Math.max(1, Math.floor(asNumber(options.maxIterations, 10))),
    toolCallingEnabled: true
  };

  const node = baseNode(source, scope, "agent_orchestrator", config);
  return reasons.length ? approximated(node, reasons) : mapped(node);
};

const simpleMemory: NodeHandler = (source, ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  const config: Record<string, unknown> = {
    namespace: slugifyNodeId(ctx.source.name),
    sessionIdTemplate: "{{session_id}}",
    maxMessages: Math.max(1, Math.floor(asNumber(params.contextWindowLength, 20))),
    persistToolMessages: false
  };
  if (asString(params.sessionIdType, "fromInput") === "customKey") {
    config.sessionIdTemplate = tpl(params.sessionKey, ctx, scope, "sessionKey") || "{{session_id}}";
  }
  const kind = shortType(source.type);
  if (kind !== "memoryBufferWindow") reasons.push(`Memory '${kind}' approximated with the local Simple Memory store.`);
  const node = baseNode(source, scope, "local_memory", config);
  const converted = reasons.length ? approximated(node, reasons) : mapped(node);
  converted.attachmentOnly = true;
  return converted;
};

const mcpClientTool: NodeHandler = (source, ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  const endpoint = tpl(params.endpointUrl ?? params.sseEndpoint, ctx, scope, "endpointUrl").trim();
  const transport = asString(params.serverTransport, "httpStreamable");
  const include = asString(params.include, "all");
  const includeTools = toArray(params.includeTools).map((tool) => asString(tool).trim()).filter(Boolean);

  const config: Record<string, unknown> = {
    serverId: slugifyNodeId(source.name),
    toolName: "__all__",
    argsTemplate: "{}",
    connection: {
      endpoint: endpoint || "http://replace-me/mcp",
      transport: "http_streamable",
      authType: "none"
    }
  };
  if (!endpoint) reasons.push("No endpoint URL was set; replace the placeholder after import.");
  if (transport === "sse") reasons.push("SSE transport is not supported; the connection was set to HTTP streamable.");
  if (include === "selected" && includeTools.length > 0) {
    config.allowedTools = includeTools;
    if (includeTools.length === 1) config.toolName = includeTools[0];
  } else if (include === "except") {
    reasons.push("Tool exclusion lists are not supported; all tools are exposed.");
  }

  const authentication = asString(params.authentication, "none");
  const secretRef = registerSecret(source, scope.nodeId, ctx);
  if (secretRef) {
    config.secretRef = secretRef;
    (config.connection as Record<string, unknown>).authType = authentication === "bearerAuth" ? "bearer" : "none";
    if (authentication === "headerAuth") reasons.push("Header authentication is not supported for MCP; verify the auth settings.");
  }

  const node = baseNode(source, scope, "mcp_tool", config);
  const converted = reasons.length ? approximated(node, reasons) : mapped(node);
  converted.attachmentOnly = true;
  return converted;
};

function inferJsonSchema(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return { type: "array", items: value.length ? inferJsonSchema(value[0]) : {} };
  }
  if (value && typeof value === "object") {
    const properties: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      properties[key] = inferJsonSchema(entry);
    }
    return { type: "object", properties, required: Object.keys(properties) };
  }
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (value === null) return { type: "null" };
  return { type: "string" };
}

const structuredOutputParser: NodeHandler = (source, _ctx, scope) => {
  const params = source.parameters;
  const reasons: string[] = [];
  let jsonSchema = "{}";
  const schemaType = asString(params.schemaType, "fromJson");
  if (schemaType === "manual") {
    const raw = asString(params.inputSchema).trim();
    try {
      jsonSchema = JSON.stringify(JSON.parse(raw));
    } catch {
      jsonSchema = raw || "{}";
      reasons.push("The manual schema is not valid JSON; it was kept verbatim.");
    }
  } else {
    const raw = asString(params.jsonSchemaExample).trim();
    try {
      jsonSchema = JSON.stringify(inferJsonSchema(JSON.parse(raw)));
      reasons.push("The JSON schema was inferred from the example output.");
    } catch {
      reasons.push("The example output is not valid JSON; an empty schema was used.");
    }
  }

  const node = baseNode(source, scope, "output_parser", {
    mode: "json_schema",
    parsingMode: "lenient",
    jsonSchema,
    inputKey: "answer",
    maxRetries: params.autoFix === true ? 2 : 0
  });
  reasons.push("The parser runs as a step after the agent rather than inside it.");
  return approximated(node, reasons);
};

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

const BASE = "n8n-nodes-base.";
const LANGCHAIN = "@n8n/n8n-nodes-langchain.";

const NODE_HANDLERS: Record<string, NodeHandler> = {
  [`${BASE}manualtrigger`]: manualTrigger,
  [`${BASE}webhook`]: webhookTrigger,
  [`${BASE}scheduletrigger`]: scheduleTrigger,
  [`${BASE}cron`]: scheduleTrigger,
  [`${BASE}interval`]: scheduleTrigger,
  [`${LANGCHAIN}chattrigger`]: chatTrigger,
  [`${BASE}errortrigger`]: errorTrigger,
  [`${BASE}formtrigger`]: formTrigger,
  [`${BASE}rssfeedreadtrigger`]: rssTrigger,
  [`${BASE}emailreadimap`]: imapTrigger,
  [`${BASE}httprequest`]: httpRequest,
  [`${BASE}code`]: codeNode,
  [`${BASE}function`]: codeNode,
  [`${BASE}set`]: setNode,
  [`${BASE}if`]: ifNode,
  [`${BASE}switch`]: switchNode,
  [`${BASE}merge`]: mergeNode,
  [`${BASE}splitout`]: splitOutNode,
  [`${BASE}itemlists`]: splitOutNode,
  [`${BASE}aggregate`]: aggregateNode,
  [`${BASE}filter`]: filterNode,
  [`${BASE}sort`]: sortNode,
  [`${BASE}limit`]: limitNode,
  [`${BASE}wait`]: waitNode,
  [`${BASE}noop`]: noOpNode,
  [`${BASE}stopanderror`]: stopAndErrorNode,
  [`${BASE}executeworkflow`]: executeWorkflowNode,
  [`${BASE}stickynote`]: stickyNote,
  [`${LANGCHAIN}lmchatopenai`]: chatModelHandler("openai_chat_model", { model: "gpt-4o-mini" }),
  [`${LANGCHAIN}lmopenai`]: chatModelHandler("openai_chat_model", { model: "gpt-4o-mini" }, "Completion model approximated as a chat model."),
  [`${LANGCHAIN}lmchatanthropic`]: chatModelHandler("anthropic_chat_model", { model: "claude-3-5-sonnet-latest" }),
  [`${LANGCHAIN}lmchatgooglegemini`]: chatModelHandler("google_gemini_chat_model", { model: "gemini-2.5-flash" }),
  [`${LANGCHAIN}lmchatollama`]: chatModelHandler("ollama_chat_model", { model: "llama3.1", baseUrl: "http://localhost:11434/v1" }),
  [`${LANGCHAIN}lmollama`]: chatModelHandler("ollama_chat_model", { model: "llama3.1", baseUrl: "http://localhost:11434/v1" }),
  [`${LANGCHAIN}lmchatazureopenai`]: azureChatModel,
  [`${LANGCHAIN}lmchatopenrouter`]: chatModelHandler("openai_compatible_chat_model", { model: "openai/gpt-4o-mini", baseUrl: "https://openrouter.ai/api/v1" }),
  [`${LANGCHAIN}lmchatgroq`]: chatModelHandler("openai_compatible_chat_model", { model: "llama-3.1-8b-instant", baseUrl: "https://api.groq.com/openai/v1" }),
  [`${LANGCHAIN}lmchatmistralcloud`]: chatModelHandler("openai_compatible_chat_model", { model: "mistral-small-latest", baseUrl: "https://api.mistral.ai/v1" }),
  [`${LANGCHAIN}lmchatdeepseek`]: chatModelHandler("openai_compatible_chat_model", { model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" }),
  [`${LANGCHAIN}lmchatxaigrok`]: chatModelHandler("openai_compatible_chat_model", { model: "grok-2", baseUrl: "https://api.x.ai/v1" }),
  [`${LANGCHAIN}agent`]: aiAgent,
  [`${LANGCHAIN}memorybufferwindow`]: simpleMemory,
  [`${LANGCHAIN}memorypostgreschat`]: simpleMemory,
  [`${LANGCHAIN}memoryredischat`]: simpleMemory,
  [`${LANGCHAIN}memorymongodbchat`]: simpleMemory,
  [`${LANGCHAIN}memoryzep`]: simpleMemory,
  [`${LANGCHAIN}memorymotorhead`]: simpleMemory,
  [`${LANGCHAIN}memoryxata`]: simpleMemory,
  [`${LANGCHAIN}mcpclienttool`]: mcpClientTool,
  [`${LANGCHAIN}outputparserstructured`]: structuredOutputParser
};

function resolveHandler(type: string): NodeHandler | undefined {
  const normalized = normalizeType(type);
  const direct = NODE_HANDLERS[normalized];
  if (direct) return direct;
  if (normalized.startsWith(`${LANGCHAIN}lmchat`)) return genericChatModel;
  return undefined;
}

/** Source types the converter knows how to map, for documentation and coverage tables. */
export const EXTERNAL_IMPORT_SUPPORTED_TYPES: readonly string[] = Object.freeze(Object.keys(NODE_HANDLERS));

// ---------------------------------------------------------------------------
// Edge building
// ---------------------------------------------------------------------------

const ATTACHMENT_CONNECTION_TYPES: Record<string, { handle: "chat_model" | "memory" | "tool"; targetTypes: Set<string> }> = {
  ai_languagemodel: {
    handle: "chat_model",
    targetTypes: new Set([
      "llm_call",
      "openai_chat_model",
      "anthropic_chat_model",
      "ollama_chat_model",
      "openai_compatible_chat_model",
      "ai_gateway_chat_model",
      "azure_openai_chat_model",
      "google_gemini_chat_model"
    ])
  },
  ai_memory: { handle: "memory", targetTypes: new Set(["local_memory"]) },
  ai_tool: { handle: "tool", targetTypes: new Set(["mcp_tool"]) }
};

// ---------------------------------------------------------------------------
// Standalone expression translation
// ---------------------------------------------------------------------------

export interface ExternalExpressionContext {
  /** Source node name → L2M node id, for `$('Name')` / `$node["Name"]` references. */
  nodeIdByName?: Record<string, string>;
  /** L2M id of the node feeding the current node, for `$json` / `$input` references. */
  previousNodeId?: string;
  nodeId?: string;
  sourceName?: string;
}

export interface ExternalExpressionTranslation {
  value: string;
  unresolved: ImportReportExpression[];
  /** Workflow variables referenced through `$env` / `$vars`. */
  variables: string[];
}

/** Translates a single parameter value the way the converter does for node configs. */
export function translateExternalExpression(raw: string, context: ExternalExpressionContext = {}): ExternalExpressionTranslation {
  const report: ImportReport = {
    sourceName: "",
    nodes: [],
    unresolvedExpressions: [],
    secretsToResolve: [],
    variablesToSet: [],
    warnings: [],
    summary: { total: 0, mapped: 0, approximated: 0, unsupported: 0 }
  };
  const ctx: ConversionContext = {
    source: { name: "", nodes: [], connections: [], settings: {}, pinData: {}, tags: [] },
    nodeIdByName: new Map(Object.entries(context.nodeIdByName ?? {})),
    previousNodeIdByName: new Map(),
    report,
    secrets: new Map(),
    variables: new Set(),
    settingsTimezone: "UTC"
  };
  const scope: ExpressionScope = {
    nodeId: context.nodeId ?? "node",
    sourceName: context.sourceName ?? "node",
    previousNodeId: context.previousNodeId
  };
  const translated = translateTemplate(raw, ctx, scope, "value");
  return { value: translated.value, unresolved: report.unresolvedExpressions, variables: [...ctx.variables].sort() };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function convertExternalWorkflow(raw: unknown): ExternalWorkflowConversion {
  const source = parseSource(raw);

  const report: ImportReport = {
    sourceName: source.name,
    nodes: [],
    unresolvedExpressions: [],
    secretsToResolve: [],
    variablesToSet: [],
    warnings: [],
    summary: { total: source.nodes.length, mapped: 0, approximated: 0, unsupported: 0 }
  };

  // Stable, unique node ids derived from the source names.
  const nodeIdByName = new Map<string, string>();
  const usedIds = new Set<string>(["import_output"]);
  for (const node of source.nodes) {
    let id = slugifyNodeId(node.name);
    let suffix = 2;
    while (usedIds.has(id)) id = `${slugifyNodeId(node.name)}_${suffix++}`;
    usedIds.add(id);
    nodeIdByName.set(node.name, id);
  }

  // The node feeding each node's first main input, used for `$json` translation.
  const previousNodeIdByName = new Map<string, string | undefined>();
  const mainParentsByName = new Map<string, string[]>();
  for (const connection of source.connections) {
    if (normalizeType(connection.connectionType) !== "main") continue;
    const parents = mainParentsByName.get(connection.target.node) ?? [];
    parents.push(connection.sourceName);
    mainParentsByName.set(connection.target.node, parents);
  }
  for (const node of source.nodes) {
    const parents = mainParentsByName.get(node.name) ?? [];
    previousNodeIdByName.set(node.name, parents.length ? nodeIdByName.get(parents[0]) : undefined);
  }

  const rawTimezone = asString(source.settings.timezone).trim();
  const settingsTimezone = rawTimezone && rawTimezone !== "DEFAULT" && isValidTimeZone(rawTimezone) ? rawTimezone : "UTC";
  if (rawTimezone && settingsTimezone === "UTC" && rawTimezone !== "UTC" && rawTimezone !== "DEFAULT") {
    report.warnings.push(`Workflow timezone '${rawTimezone}' is not a valid IANA zone; schedules use UTC.`);
  }

  const ctx: ConversionContext = {
    source,
    nodeIdByName,
    previousNodeIdByName,
    report,
    secrets: new Map(),
    variables: new Set(),
    settingsTimezone
  };

  // Convert every node.
  const converted = new Map<string, ConvertedNode>();
  const nodes: WorkflowNode[] = [];
  for (const sourceNode of source.nodes) {
    const nodeId = nodeIdByName.get(sourceNode.name)!;
    const scope: ExpressionScope = {
      nodeId,
      sourceName: sourceNode.name,
      previousNodeId: previousNodeIdByName.get(sourceNode.name)
    };
    const handler = resolveHandler(sourceNode.type);
    const result = handler
      ? handler(sourceNode, ctx, scope)
      : unsupportedPlaceholder(sourceNode, scope, `Node type '${sourceNode.type}' has no L2M equivalent; imported as a disabled placeholder.`);

    converted.set(sourceNode.name, result);
    nodes.push(result.node);
    report.nodes.push({
      sourceName: sourceNode.name,
      sourceType: sourceNode.type,
      sourceId: sourceNode.id,
      targetNodeId: nodeId,
      targetType: result.node.type,
      status: result.status,
      reason: result.reason
    });
    report.summary[result.status] += 1;
  }

  // Build edges.
  const edges: WorkflowEdge[] = [];
  const attachmentTargets = new Set<string>();
  const parserByAgent = new Map<string, string>();
  let edgeCounter = 0;
  const nextEdgeId = (prefix: string) => `${prefix}_${++edgeCounter}`;

  for (const connection of source.connections) {
    const from = converted.get(connection.sourceName);
    const to = converted.get(connection.target.node);
    if (!from || !to) {
      report.warnings.push(
        `Connection from '${connection.sourceName}' to '${connection.target.node}' references a node that does not exist and was dropped.`
      );
      continue;
    }

    const connectionType = normalizeType(connection.connectionType);
    if (connectionType === "main") {
      const edge: WorkflowEdge = { id: nextEdgeId("edge"), source: from.node.id, target: to.node.id };
      if (from.outputHandles) {
        edge.sourceHandle = from.outputHandles[connection.outputIndex] ?? from.outputHandles[from.outputHandles.length - 1];
        if (from.node.type === "switch_node") {
          const fallback = toRecord(toRecord(source.nodes.find((n) => n.name === connection.sourceName)?.parameters).options).fallbackOutput;
          if (typeof fallback === "number" && fallback === connection.outputIndex) {
            edges.push({ id: nextEdgeId("edge"), source: from.node.id, target: to.node.id, sourceHandle: "default" });
          }
        }
      } else if (connection.outputIndex > 0) {
        report.warnings.push(
          `'${connection.sourceName}' output #${connection.outputIndex + 1} has no equivalent handle; the edge to '${connection.target.node}' was connected to the main output.`
        );
      }
      if (to.node.type === "merge_node") edge.label = `input ${connection.target.index + 1}`;
      edges.push(edge);
      continue;
    }

    // Sub-node connections point from the sub-node to the agent; L2M attachment edges point the other way.
    const attachment = ATTACHMENT_CONNECTION_TYPES[connectionType];
    if (attachment) {
      if (to.node.type !== "agent_orchestrator" && to.node.type !== "supervisor_node") {
        report.warnings.push(
          `'${connection.sourceName}' is attached to '${connection.target.node}', which did not import as an agent; the attachment was dropped.`
        );
        continue;
      }
      if (!attachment.targetTypes.has(from.node.type)) {
        report.warnings.push(
          `'${connection.sourceName}' (${from.node.type}) cannot be attached to '${connection.target.node}' as ${attachment.handle}; the attachment was dropped.`
        );
        continue;
      }
      edges.push({ id: nextEdgeId(`edge_${attachment.handle}`), source: to.node.id, target: from.node.id, sourceHandle: attachment.handle });
      attachmentTargets.add(from.node.id);
      continue;
    }

    if (connectionType === "ai_outputparser") {
      if (to.node.type === "agent_orchestrator" && from.node.type === "output_parser") {
        parserByAgent.set(to.node.id, from.node.id);
      } else {
        report.warnings.push(
          `Output parser connection from '${connection.sourceName}' to '${connection.target.node}' could not be applied and was dropped.`
        );
      }
      continue;
    }

    report.warnings.push(
      `Connection type '${connection.connectionType}' from '${connection.sourceName}' to '${connection.target.node}' is not supported and was dropped.`
    );
  }

  // An attached output parser becomes a step between the agent and its downstream nodes.
  for (const [agentId, parserId] of parserByAgent.entries()) {
    for (const edge of edges) {
      if (edge.source === agentId && !edge.sourceHandle) edge.source = parserId;
    }
    edges.push({ id: nextEdgeId("edge"), source: agentId, target: parserId });
  }

  // Wire every DAG leaf into a single Output node so the workflow validates and returns a result.
  // Sub-nodes (anything the source wires through a non-main connection) are never DAG leaves,
  // even when they imported as placeholders.
  const subNodeIds = new Set<string>();
  for (const connection of source.connections) {
    if (normalizeType(connection.connectionType) === "main") continue;
    const id = nodeIdByName.get(connection.sourceName);
    if (id) subNodeIds.add(id);
  }
  const outgoing = new Set(
    edges
      .filter((edge) => !edge.sourceHandle || !["chat_model", "memory", "tool", "worker"].includes(edge.sourceHandle))
      .map((edge) => edge.source)
  );
  const leaves = nodes.filter((node) => {
    const info = converted.get(node.name);
    if (node.type === "sticky_note" || info?.attachmentOnly || attachmentTargets.has(node.id) || subNodeIds.has(node.id)) return false;
    if (node.type === "stop_and_error") return false;
    return !outgoing.has(node.id);
  });
  const maxX = nodes.reduce((max, node) => Math.max(max, node.position.x), 0);
  const avgY = leaves.length ? leaves.reduce((sum, node) => sum + node.position.y, 0) / leaves.length : 0;
  nodes.push({
    id: "import_output",
    type: "output",
    name: "Output",
    position: { x: maxX + 280, y: Math.round(avgY) },
    config: { outputKey: "result" }
  });
  for (const leaf of leaves) {
    edges.push({ id: nextEdgeId("edge"), source: leaf.id, target: "import_output" });
  }

  // Pinned data keyed by the new node ids.
  const pinnedData: Record<string, unknown> = {};
  for (const [name, items] of Object.entries(source.pinData)) {
    const nodeId = nodeIdByName.get(name);
    if (!nodeId) continue;
    const list = toArray(items).map((item) => {
      const record = toRecord(item);
      return "json" in record ? record.json : item;
    });
    pinnedData[nodeId] = list.length === 1 ? list[0] : list;
  }

  // Workflow variables for `$env` / `$vars` references.
  const variables: Record<string, string> = {};
  for (const name of [...ctx.variables].sort()) variables[name] = "";
  report.variablesToSet = Object.keys(variables);
  report.secretsToResolve = [...ctx.secrets.values()];

  if (source.settings.errorWorkflow) {
    report.warnings.push("The source error workflow setting was not imported; configure errorWorkflowId after import.");
  }

  const workflow: Workflow = workflowSchema.parse({
    id: `wf-import-${slugifyNodeId(source.name)}`,
    name: source.name,
    description: `Imported from an external workflow export (${report.summary.mapped} mapped, ${report.summary.approximated} approximated, ${report.summary.unsupported} unsupported).`,
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    workflowVersion: 1,
    ...(Object.keys(variables).length ? { variables } : {}),
    nodes,
    edges,
    ...(Object.keys(pinnedData).length ? { pinnedData } : {}),
    ...(source.tags.length ? { tags: source.tags } : {})
  });

  return { workflow, report };
}
