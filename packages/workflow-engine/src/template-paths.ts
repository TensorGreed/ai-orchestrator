/**
 * Checks the `{{ }}` paths of a workflow's settings against what the steps before each node output (the shared node
 * output lists, `NODE_OUTPUT_SPECS`). Describe it sends what this finds back to the model to repair, so a drafted
 * webhook does not answer `{{response}}` when its LLM Call outputs `answer`.
 *
 * Only what is certain is reported: a path is checked only when every step it can read from has a closed output list.
 * - `{{results.<id>.<field>}}`: the node `<id>` must exist, and when its output is closed, have `<field>`.
 * - `{{<field>}}`: when every step connected straight in has a closed output, one of them must have `<field>`.
 *   Run-wide names (`webhook`, `user_prompt`, `vars`, `item`...) and the parents' ids are always readable.
 * Expressions (anything but a plain dotted path) are not checked, nor are nodes in a loop body (they read the item),
 * a Filter's conditions (they read each item), nodes with an input mapping, code, a disabled step (it passes its
 * input on) or a step's output after an error (it carries the failed item).
 * A run's input is spread into every node's data too, so plain `{{<field>}}` paths are only checked when the
 * workflow's triggers say what that input holds: a Webhook Input (its body is under `webhook`), a Schedule Trigger,
 * or a Form Trigger (its fields). A manual, chat, MCP or sub-workflow trigger takes any input: not checked.
 */
import {
  RESERVED_NODE_IDS,
  nodeOutputAliases,
  nodeOutputFieldNames,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode
} from "@ai-orchestrator/shared";

export interface TemplatePathIssue {
  nodeId: string;
  /** Where in the node's settings the template is (`bodyTemplate`, `assignments.0.valueTemplate`). */
  setting: string;
  /** The template as written, with its braces. */
  template: string;
  message: string;
}

const TEMPLATE_BODY = /{{\s*([\s\S]+?)\s*}}/g;
const SIMPLE_PATH = /^[A-Za-z0-9_.-]+$/;
/** Settings that hold code or schemas, not templates. */
const NOT_TEMPLATE_KEYS = new Set(["code", "script", "jsonSchema", "extractionSchema", "inputSchema", "outputSchema"]);
/** Agent port handles: an edge on one attaches a node, it is not a step. */
const ATTACHMENT_HANDLES = new Set(["chat_model", "memory", "tool", "worker", "guard", "protection"]);
/** Names every node's template data holds besides its parents' fields (engine `buildTemplateData`, run globals). */
const RUN_WIDE_NAMES = new Set([...RESERVED_NODE_IDS, "images"]);
/** Node types whose settings are not templates. */
const NOT_TEMPLATE_TYPES = new Set(["code_node"]);
/** Nodes whose plain paths read each item they filter, not their parents' output. */
const PER_ITEM_TYPES = new Set(["filter_node"]);
/** What the API adds to a run's input for any trigger (`trigger_node_id`, the schedule's, the form's). */
const TRIGGER_INPUT_NAMES = [
  "trigger_type",
  "trigger_node_id",
  "input_trigger_type",
  "scheduled_at",
  "schedule_node_id",
  "cron_expression",
  "timezone",
  "form_path",
  "form_submission"
];
/** Triggers whose run input is known (beyond the names above): the webhook's body is under `webhook`. */
const KNOWN_INPUT_TRIGGERS = new Set(["webhook_input", "schedule_trigger", "form_trigger"]);

/** The names a run's input holds, or null when a trigger takes any input (plain paths are then not checked). */
function runInputNames(nodes: readonly WorkflowNode[], hasIncoming: (id: string) => boolean): Set<string> | null {
  const names = new Set(TRIGGER_INPUT_NAMES);
  for (const node of nodes) {
    if (hasIncoming(node.id)) continue;
    if (!KNOWN_INPUT_TRIGGERS.has(node.type)) return null;
    if (node.type !== "form_trigger") continue;
    const fields = isRecord(node.config) ? (node.config as Record<string, unknown>).fields : undefined;
    for (const field of Array.isArray(fields) ? fields : []) {
      if (isRecord(field) && typeof field.name === "string") names.add(field.name);
    }
  }
  return names;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function templatesIn(value: unknown, path: string, out: Array<{ setting: string; body: string }>): void {
  if (typeof value === "string") {
    if (!value.includes("{{")) return;
    for (const match of value.matchAll(TEMPLATE_BODY)) out.push({ setting: path, body: match[1]!.trim() });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => templatesIn(item, path ? `${path}.${index}` : String(index), out));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (NOT_TEMPLATE_KEYS.has(key)) continue;
    templatesIn(child, path ? `${path}.${key}` : key, out);
  }
}

function isStepEdge(edge: WorkflowEdge): boolean {
  return !(edge.sourceHandle && ATTACHMENT_HANDLES.has(edge.sourceHandle));
}

/** The fields a node's output certainly holds, or null when it may hold any field. */
function closedFields(node: WorkflowNode, viaHandle?: string): Set<string> | null {
  // The error output carries the failed item and the error; On Error "continue" outputs the error instead.
  if (viaHandle === "error") return null;
  // A disabled step is skipped: what it passes on is its own input.
  if (node.disabled === true) return null;
  if (node.errorConfig?.continueOnFail === true) return null;
  const onError = isRecord(node.config) ? (node.config as Record<string, unknown>).onError : undefined;
  if (onError === "continue" || onError === "branch") return null;
  return nodeOutputFieldNames(node.type, node.config);
}

/** The fields to name in a message: an alias (`text`) is left out, its field (`answer`) is the one to use. */
function shownFields(type: string, fields: Set<string>): string[] {
  const aliases = nodeOutputAliases(type);
  return [...fields].filter((name) => !(name in aliases));
}

function describeFields(type: string, fields: Set<string>): string {
  const shown = shownFields(type, fields);
  return shown.length > 0 ? shown.join(", ") : "no fields";
}

/** Every `{{ }}` path of the workflow that reads a field no step before it outputs. */
export function unknownTemplatePaths(workflow: Pick<Workflow, "nodes" | "edges">): TemplatePathIssue[] {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const stepEdges = workflow.edges.filter(isStepEdge);
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const edge of stepEdges) {
    const list = incoming.get(edge.target) ?? [];
    list.push(edge);
    incoming.set(edge.target, list);
  }
  // Nodes after a loop read its item (and the loop's own variable name): their plain paths are not checked.
  const afterLoop = new Set<string>();
  const queue = workflow.nodes.filter((node) => node.type === "loop_node").map((node) => node.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of stepEdges) {
      if (edge.source === id && !afterLoop.has(edge.target)) {
        afterLoop.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  // The run starts at the nodes nothing points at (an agent's attached nodes are pointed at by its port edges).
  // A node on no edge at all (a note, a step not wired in yet) starts nothing.
  const targets = new Set(workflow.edges.map((edge) => edge.target));
  const sources = new Set(workflow.edges.map((edge) => edge.source));
  const inputNames = runInputNames(workflow.nodes, (id) => targets.has(id) || !sources.has(id));
  const issues: TemplatePathIssue[] = [];
  for (const node of workflow.nodes) {
    if (NOT_TEMPLATE_TYPES.has(node.type)) continue;
    const found: Array<{ setting: string; body: string }> = [];
    templatesIn(node.config, "", found);
    if (found.length === 0) continue;
    const config = isRecord(node.config) ? (node.config as Record<string, unknown>) : {};
    const hasInputMapping = isRecord(config.inputMapping) && Object.keys(config.inputMapping).length > 0;
    const parents = (incoming.get(node.id) ?? []).map((edge) => ({ node: byId.get(edge.source), handle: edge.sourceHandle }));
    const seen = new Set<string>();
    for (const { setting, body } of found) {
      if (!SIMPLE_PATH.test(body)) continue;
      const key = `${setting}\u0000${body}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const segments = body.split(".");
      const first = segments[0]!;
      const template = `{{${body}}}`;
      if (first === "results") {
        const targetId = segments[1];
        if (!targetId) continue;
        const target = byId.get(targetId);
        if (!target) {
          issues.push({
            nodeId: node.id,
            setting,
            template,
            message: `${template} in ${setting} reads node '${targetId}', but there is no node with that id (ids: ${[...byId.keys()].join(", ")}).`
          });
          continue;
        }
        const wanted = segments[2];
        if (!wanted) continue;
        const fields = closedFields(target);
        if (!fields || fields.has(wanted) || wanted.startsWith("_")) continue;
        issues.push({
          nodeId: node.id,
          setting,
          template,
          message: `${template} in ${setting}: '${targetId}' (${target.type}) outputs ${describeFields(target.type, fields)}, not '${wanted}'.`
        });
        continue;
      }
      if (first.startsWith("$") || first.startsWith("_") || RUN_WIDE_NAMES.has(first) || byId.has(first)) continue;
      if (!inputNames || inputNames.has(first)) continue;
      if (parents.length === 0 || afterLoop.has(node.id) || hasInputMapping || PER_ITEM_TYPES.has(node.type)) continue;
      const parentFields = parents.map((parent) => (parent.node ? closedFields(parent.node, parent.handle) : null));
      if (parentFields.some((fields) => fields === null)) continue;
      if (parentFields.some((fields) => fields!.has(first))) continue;
      const offered = parents
        .map((parent, index) => `'${parent.node!.id}' (${parent.node!.type}) outputs ${describeFields(parent.node!.type, parentFields[index]!)}`)
        .join("; ");
      const firstShown = parents.length === 1 ? shownFields(parents[0]!.node!.type, parentFields[0]!)[0] : undefined;
      const suggestion = firstShown ? ` Use one of those (for example {{${firstShown}}}), or {{results.<nodeId>.<field>}} for an earlier step.` : "";
      issues.push({
        nodeId: node.id,
        setting,
        template,
        message: `${template} in ${setting} reads '${first}', but no step connected into '${node.id}' outputs it: ${offered}.${suggestion}`
      });
    }
  }
  return issues;
}
