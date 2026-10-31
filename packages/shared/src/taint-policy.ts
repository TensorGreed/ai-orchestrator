import { z } from "zod";
import { conditionList } from "./mcp-tool-policy";
import { dataClassNameSchema, PROVENANCE_LABELS, withImpliedSensitive, type DataLabels, type ProvenanceLabel } from "./data-labels";
import type { McpToolPolicyConditions, McpToolPolicyRule, Workflow } from "./types";

/**
 * Phase 12.2 — provenance (taint) policies over the MCP tool rules.
 *
 *   - Safety presets: ready-made tool rules an admin adds in one click. They are created in SHADOW mode (they log
 *     what they would have done and change nothing) and enforced later through the usual shadow → enforce step.
 *   - The per-workflow switch "Approve writes only after untrusted content": the first preset's rule, scoped to one
 *     workflow.
 *   - Recorded labels: the provenance labels a tool call was decided with, kept on the run trace and the call's
 *     telemetry row so that simulation can evaluate label conditions later. Label NAMES only, never values; data
 *     class names only when the run tracked labels (an untracked run never scans for them).
 *   - Open world: whether a tool can send what it is given outside (see `resolveToolOpenWorld` in the MCP SDK); an
 *     admin may override it per tool.
 *
 * Nothing here changes a run on its own: with no preset added and no switch on, every workflow runs as before.
 */

/** Provenance labels every run knows (no scan needed). `sensitive` is not one: detected data classes also imply it. */
export const RUN_PROVENANCE_LABELS: readonly ProvenanceLabel[] = ["trusted", "user", "untrusted_external"];

/**
 * True when a label condition's value can only be fed on a run that tracks labels: `sensitive` (detected data
 * classes imply it) and every data class name. `trusted`, `user` and `untrusted_external` are known on every run.
 */
export function labelValueNeedsTracking(value: unknown): boolean {
  return typeof value === "string" && !(RUN_PROVENANCE_LABELS as readonly string[]).includes(value);
}

/** The label values (`label_present` / `label_absent`) a rule's conditions read. */
export function ruleLabelValues(conditions: McpToolPolicyConditions | null | undefined): string[] {
  return conditionList(conditions)
    .items.filter((condition) => condition.op === "label_present" || condition.op === "label_absent")
    .flatMap((condition) => (typeof condition.value === "string" ? [condition.value] : []));
}

/** Node types that call MCP tools (an agent or supervisor through its tool ports, or the MCP Tool node itself). */
export const MCP_TOOL_CALLING_NODE_TYPES: readonly string[] = ["agent_orchestrator", "supervisor_node", "mcp_tool"];

/** Node types that run another workflow, which may call MCP tools: counted as calling them, conservatively. */
export const SUB_WORKFLOW_NODE_TYPES: readonly string[] = ["execute_workflow"];

/** True when an enabled node of the workflow may call an MCP tool, itself or through a sub-workflow. */
export function workflowMayCallMcpTools(workflow: Pick<Workflow, "nodes">): boolean {
  return workflow.nodes.some(
    (node) => node.disabled !== true && (MCP_TOOL_CALLING_NODE_TYPES.includes(node.type) || SUB_WORKFLOW_NODE_TYPES.includes(node.type))
  );
}

/**
 * Phase 12.2 — true when a run of `workflow` must track labels for its MCP tool rules: the workflow may call an MCP
 * tool (`workflowMayCallMcpTools`), and an enabled tool rule (enforced or shadow) that covers it (`workflowIds` empty
 * or naming it) has a label condition only a tracking run can feed (`sensitive` or a data class). Such runs then
 * track labels automatically, so the condition is not a silent no-op. Tracking is not free of side effects: it also
 * feeds the run's data classes to destination checks, so it is kept to the runs the rule can apply to.
 */
export function policyRulesNeedLabelTracking(
  rules: ReadonlyArray<Pick<McpToolPolicyRule, "enabled" | "conditions" | "kind" | "workflowIds">>,
  workflow: Pick<Workflow, "id" | "nodes">
): boolean {
  if (!workflowMayCallMcpTools(workflow)) return false;
  return rules.some(
    (rule) =>
      rule.enabled &&
      (rule.kind ?? "tool") === "tool" &&
      (!rule.workflowIds?.length || rule.workflowIds.includes(workflow.id)) &&
      ruleLabelValues(rule.conditions).some(labelValueNeedsTracking)
  );
}

// ---------------------------------------------------------------------------
// Recorded labels
// ---------------------------------------------------------------------------

/**
 * The labels one tool call was decided with. `tracked`: the run tracked labels, so `dataClasses` lists what it found
 * (and `sensitive` may come from them); otherwise `dataClasses` is absent and only the provenance labels every run
 * knows are reliable.
 */
export interface McpToolCallLabels {
  provenance: ProvenanceLabel[];
  dataClasses?: string[];
  tracked: boolean;
}

export const MCP_TOOL_CALL_LABELS_MAX_CLASSES = 100;

export const mcpToolCallLabelsSchema = z.object({
  provenance: z.array(z.enum(PROVENANCE_LABELS)).max(PROVENANCE_LABELS.length),
  dataClasses: z.array(dataClassNameSchema).max(MCP_TOOL_CALL_LABELS_MAX_CLASSES).optional(),
  tracked: z.boolean()
});

/**
 * The labels to record for a call, from the labels the policy saw. Only label names that validate are kept (never
 * a value); data class names only when the run tracked labels. Undefined when the call carried no labels at all.
 */
export function recordedCallLabels(labels: Pick<DataLabels, "provenance" | "dataClasses"> | null | undefined, tracked: boolean): McpToolCallLabels | undefined {
  if (!labels) return undefined;
  // The decision read detected data classes as `sensitive` too (`withImpliedSensitive`), so the record says so.
  const provenance = PROVENANCE_LABELS.filter((label) => withImpliedSensitive(labels).provenance.includes(label));
  if (!tracked) return { provenance, tracked: false };
  const dataClasses = [...new Set(labels.dataClasses)]
    .filter((name) => dataClassNameSchema.safeParse(name).success)
    .sort()
    .slice(0, MCP_TOOL_CALL_LABELS_MAX_CLASSES);
  return { provenance, dataClasses, tracked: true };
}

/** Recorded labels read from storage (a JSON column, a trace field); null when absent or unreadable. */
export function parseRecordedCallLabels(value: unknown): McpToolCallLabels | null {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const parsed = mcpToolCallLabelsSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const { provenance, dataClasses, tracked } = parsed.data;
  return tracked ? { provenance, dataClasses: dataClasses ?? [], tracked } : { provenance, tracked };
}

// ---------------------------------------------------------------------------
// Open world
// ---------------------------------------------------------------------------

/** Admin override of a registry tool's open-world classification. */
export interface McpToolOpenWorldOverride {
  registryServerId: string;
  toolName: string;
  openWorld: boolean;
  setBy?: string | null;
  setAt?: string;
}

/**
 * Where a tool's resolved open-world value came from: an admin's `manual` override; the server's `destination` tier
 * (vendor or public); its `annotation` (a local or private server, where the tool's own hint decides); `unknown`
 * when the destination could not be classified, which counts as open world.
 */
export type McpOpenWorldSource = "manual" | "destination" | "annotation" | "unknown";

export interface McpOpenWorldResolution {
  openWorld: boolean;
  source: McpOpenWorldSource;
}

export const mcpToolOpenWorldSchema = z.object({
  /** true / false sets the override; null clears it, so the destination and annotations decide again. */
  openWorld: z.boolean().nullable()
});

// ---------------------------------------------------------------------------
// Safety presets
// ---------------------------------------------------------------------------

export const MCP_SAFETY_PRESET_IDS = ["untrusted_write_approval", "sensitive_no_open_world"] as const;
export type McpSafetyPresetId = (typeof MCP_SAFETY_PRESET_IDS)[number];
export const mcpSafetyPresetIdSchema = z.enum(MCP_SAFETY_PRESET_IDS);

/** The parts of a tool rule a preset fixes; everything else is the default (any project, role, workflow, server). */
export type McpSafetyPresetRule = Pick<McpToolPolicyRule, "name" | "description" | "effect" | "annotationHint" | "conditions"> & {
  toolPattern: "*";
};

export interface McpSafetyPreset {
  id: McpSafetyPresetId;
  title: string;
  summary: string;
  rule: McpSafetyPresetRule;
}

const UNTRUSTED_WRITE_RULE: McpSafetyPresetRule = {
  name: "Untrusted content: write tools need approval",
  description:
    "Safety preset. A call to a tool that is not read-only waits for an approval while the agent's context (or the node's input) holds untrusted outside content.",
  effect: "require_approval",
  toolPattern: "*",
  annotationHint: "not_read_only",
  conditions: { all: [{ op: "label_present", value: "untrusted_external" }] }
};

const SENSITIVE_OPEN_WORLD_RULE: McpSafetyPresetRule = {
  name: "Sensitive data: no open-world tools",
  description:
    "Safety preset. A call to an open-world tool (its server is a vendor or public destination, or unclassified) is denied while the context holds sensitive data.",
  effect: "deny",
  toolPattern: "*",
  annotationHint: "open_world",
  conditions: { all: [{ op: "label_present", value: "sensitive" }] }
};

export const MCP_SAFETY_PRESETS: readonly McpSafetyPreset[] = Object.freeze([
  {
    id: "untrusted_write_approval",
    title: "Untrusted content ⇒ write tools need approval",
    summary: "After an agent or node has read outside content (a public webhook, a web page, a tool result), every call to a tool that is not read-only waits for an admin's approval.",
    rule: UNTRUSTED_WRITE_RULE
  },
  {
    id: "sensitive_no_open_world",
    title: "Sensitive data ⇒ no open-world tools",
    summary:
      "While the context holds sensitive data, tools whose server is a vendor or public destination (or unclassified) are denied. Runs of workflows with an agent or MCP Tool node then track data labels automatically; the data classes found also feed destination checks.",
    rule: SENSITIVE_OPEN_WORLD_RULE
  }
]);

export function mcpSafetyPreset(id: McpSafetyPresetId): McpSafetyPreset {
  return MCP_SAFETY_PRESETS.find((preset) => preset.id === id)!;
}

/** The fixed id of the rule a preset creates: adding it twice is refused, and its state can be shown. */
export function mcpSafetyPresetRuleId(id: McpSafetyPresetId): string {
  return `mtp_preset_${id}`;
}

/** The rule a preset creates, as stored (in shadow mode, everyone, every server). */
export function mcpSafetyPresetRule(id: McpSafetyPresetId): McpToolPolicyRule {
  const preset = mcpSafetyPreset(id);
  return {
    id: mcpSafetyPresetRuleId(id),
    ...preset.rule,
    kind: "tool",
    projectId: null,
    roles: [],
    serverId: null,
    workflowIds: [],
    clientIds: [],
    mode: "shadow",
    additive: true,
    enabled: true
  };
}

// ---------------------------------------------------------------------------
// The per-workflow switch
// ---------------------------------------------------------------------------

/** The fixed id of the workflow's "Approve writes only after untrusted content" rule. */
export function untrustedWriteSwitchRuleId(workflowId: string): string {
  return `mtp_wf_untrusted_writes_${workflowId}`;
}

/** The workflow-scoped rule the switch creates: the first preset's rule, for this workflow only, enforced. */
export function untrustedWriteSwitchRule(workflowId: string): McpToolPolicyRule {
  return {
    id: untrustedWriteSwitchRuleId(workflowId),
    ...UNTRUSTED_WRITE_RULE,
    name: "This workflow: approve writes after untrusted content",
    description:
      "Set by the workflow's \"Approve writes only after untrusted content\" switch. A call to a tool that is not read-only waits for an approval while the context holds untrusted outside content.",
    kind: "tool",
    projectId: null,
    roles: [],
    serverId: null,
    workflowIds: [workflowId],
    clientIds: [],
    mode: "enforce",
    additive: true,
    enabled: true
  };
}

export const untrustedWriteSwitchSchema = z.object({ enabled: z.boolean() });

/** What the switch reads as: `customised` when an admin has changed the rule since the switch created it. */
export interface UntrustedWriteSwitchState {
  enabled: boolean;
  ruleId: string;
  mode?: "enforce" | "shadow";
  ruleEnabled?: boolean;
  customised?: boolean;
}
