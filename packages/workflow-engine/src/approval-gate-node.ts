import { createHash } from "node:crypto";
import {
  approvalGateConfigSchema,
  ErrorCategory,
  WorkflowError,
  writeToolApprovalRequest,
  type ApprovalDecisionValue,
  type ApprovalEditableField,
  type ApprovalGateOutputHandle,
  type ApprovalRequestSpec,
  type WriteToolApprovalSettings
} from "@ai-orchestrator/shared";
import { ApprovalHandoffSignal, type ApprovalHandoffRequest } from "./approval-handoff";

/**
 * Phase 11.2 — the Approval Gate node and the agent-level write-tool gate.
 *
 * A gate pauses by throwing `ApprovalHandoffSignal` with a `gate` hand-off,
 * so the run is saved like any other approval pause. On resume the gate
 * runs again with the decision and turns it into its output:
 *
 * - approve: `approved`, carrying the incoming item with the approver's
 *   edits applied on top and an `approval` record;
 * - reject: `rejected`; when nothing is connected to `rejected` the node
 *   fails instead, so try/catch and on-error settings apply;
 * - timeout: `timed_out` when the gate's timeout outcome is `fallback` and
 *   that output is connected, otherwise handled as a rejection.
 */

export interface ApprovalGateDecision {
  decision: ApprovalDecisionValue;
  actedBy?: string;
  reason?: string;
  edits?: Record<string, unknown>;
  editedFields?: string[];
  requestId?: string;
  decidedAt: string;
}

const MAX_RENDERED_FIELD_CHARS = 20_000;

function parseFieldValue(field: { type: ApprovalEditableField["type"] }, rendered: string): unknown {
  if (field.type === "number") {
    const value = Number(rendered);
    return rendered.trim() !== "" && Number.isFinite(value) ? value : undefined;
  }
  if (field.type === "boolean") {
    return rendered === "true" ? true : rendered === "false" ? false : undefined;
  }
  if (field.type === "json") {
    try {
      return JSON.parse(rendered);
    } catch {
      return undefined;
    }
  }
  return rendered.length > MAX_RENDERED_FIELD_CHARS ? rendered.slice(0, MAX_RENDERED_FIELD_CHARS) : rendered;
}

/** The pause an Approval Gate asks for; the config is validated, so a bad one fails the node. */
export function approvalGatePause(
  rawConfig: unknown,
  render: (template: string) => string
): ApprovalHandoffSignal {
  const parsed = approvalGateConfigSchema.safeParse(rawConfig ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw WorkflowError.nodeConfig(`Approval Gate ${first?.path.join(".") || "config"}: ${first?.message ?? "invalid configuration"}`);
  }
  const config = parsed.data;
  const editableFields: ApprovalEditableField[] = config.editableFields.map((field) => {
    const value = field.valueTemplate !== undefined ? parseFieldValue(field, render(field.valueTemplate)) : undefined;
    return {
      key: field.key,
      ...(field.label ? { label: field.label } : {}),
      type: field.type,
      ...(field.required ? { required: true } : {}),
      ...(field.maxLength ? { maxLength: field.maxLength } : {}),
      ...(value !== undefined ? { value } : {})
    };
  });
  const request: ApprovalRequestSpec = {
    kind: "approval_gate",
    approverRoles: [...config.approverRoles],
    approverUsers: [...config.approverUsers],
    allowSelfApproval: config.allowSelfApproval,
    timeoutOutcome: config.timeoutOutcome,
    requireRejectReason: config.requireRejectReason,
    editableFields
  };
  const message = render(config.message).trim() || "Approval required to continue.";
  return new ApprovalHandoffSignal({
    message,
    timeoutMinutes: config.timeoutMinutes,
    handoff: { kind: "gate", source: "approval_gate", request },
    details: {
      approverRoles: request.approverRoles,
      approverUsers: request.approverUsers,
      timeoutOutcome: request.timeoutOutcome,
      editableFields: editableFields.map((field) => field.key)
    }
  });
}

/** The incoming item without engine-internal routing keys. */
function itemFrom(merged: Record<string, unknown>, parentIds: readonly string[]): Record<string, unknown> {
  const parents = new Set(parentIds);
  const item: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (parents.has(key) || key === "_branchHandle" || key === "_branchHandleFallback") continue;
    item[key] = value;
  }
  return item;
}

/**
 * The gate's output for a decision, or a non-retryable failure when the
 * decision is a rejection with nowhere to go.
 */
export function approvalGateOutcome(input: {
  decision: ApprovalGateDecision;
  request: ApprovalRequestSpec;
  connectedHandles: ReadonlySet<string>;
  merged: Record<string, unknown>;
  parentIds: readonly string[];
  timeoutMinutes?: number;
}): Record<string, unknown> {
  const { decision, request } = input;
  let handle: ApprovalGateOutputHandle;
  if (decision.decision === "approve") {
    handle = "approved";
  } else if (decision.decision === "timeout" && request.timeoutOutcome === "fallback" && input.connectedHandles.has("timed_out")) {
    handle = "timed_out";
  } else {
    handle = "rejected";
  }
  const outcome = decision.decision === "approve" ? "approved" : decision.decision === "timeout" ? "timed_out" : "rejected";
  const approval = {
    decision: decision.decision,
    outcome,
    actedBy: decision.actedBy ?? null,
    reason: decision.reason ?? null,
    decidedAt: decision.decidedAt,
    requestId: decision.requestId ?? null,
    editedFields: decision.editedFields ?? []
  };
  if (handle === "rejected" && !input.connectedHandles.has("rejected")) {
    const message =
      decision.decision === "timeout"
        ? `Approval timed out${input.timeoutMinutes ? ` after ${input.timeoutMinutes} minutes` : ""} with nobody deciding.`
        : `Approval rejected${decision.actedBy ? ` by ${decision.actedBy}` : ""}${decision.reason ? `: ${decision.reason}` : "."}`;
    throw new WorkflowError(message, ErrorCategory.NODE_CONFIG, false, { approval }, "Connect the gate's Rejected output to handle a rejection without failing the run.");
  }
  const item = itemFrom(input.merged, input.parentIds);
  // Only the gate's declared fields; engine routing keys are never taken from an edit.
  const allowed = new Set(request.editableFields.map((field) => field.key));
  const values =
    decision.decision === "approve"
      ? Object.fromEntries(Object.entries(decision.edits ?? {}).filter(([key]) => allowed.has(key) && !key.startsWith("_")))
      : {};
  return {
    ...item,
    ...values,
    approved: decision.decision === "approve",
    approval,
    _branchHandle: handle
  };
}

// ---------------------------------------------------------------------------
// Agent-level gate before MCP write tools
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/**
 * The approval covers one call: this agent node, this server and tool and
 * these exact arguments. A re-run that calls the tool with other arguments
 * asks again.
 */
export function writeToolApprovalKey(nodeId: string, serverKey: string, toolName: string, args: unknown): string {
  const digest = createHash("sha256").update(canonicalJson(args ?? {})).digest("hex").slice(0, 32);
  return `tool_gate:${nodeId}:${serverKey}:${toolName}:${digest}`;
}

const ARGUMENT_PREVIEW_CHARS = 2_000;

export function writeToolApprovalPause(input: {
  settings: WriteToolApprovalSettings;
  nodeId: string;
  nodeName: string;
  serverKey: string;
  serverLabel: string;
  toolName: string;
  args: unknown;
  classificationSource: string;
}): ApprovalHandoffRequest {
  const approvalKey = writeToolApprovalKey(input.nodeId, input.serverKey, input.toolName, input.args);
  let preview = canonicalJson(input.args ?? {});
  if (preview.length > ARGUMENT_PREVIEW_CHARS) preview = `${preview.slice(0, ARGUMENT_PREVIEW_CHARS)}…`;
  return {
    message: `Agent '${input.nodeName}' wants to call the write tool '${input.toolName}' on '${input.serverLabel}'.`,
    timeoutMinutes: input.settings.timeoutMinutes ?? 60,
    handoff: { kind: "rerun", source: "agent_tool_gate", approvalKey, request: writeToolApprovalRequest(input.settings) },
    details: {
      toolName: input.toolName,
      server: input.serverLabel,
      classification: input.classificationSource,
      arguments: preview
    }
  };
}
