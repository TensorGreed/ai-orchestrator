import { z } from "zod";
import type {
  ApprovalDecisionValue,
  ApprovalEditableField,
  ApprovalHandoffState,
  ApprovalRequestKind,
  ApprovalRequestSpec,
  WorkflowExecutionState,
  WriteToolApprovalSettings
} from "./types";

/**
 * Phase 11.2 — approval gates: the `approval_gate` node, the agent-level
 * gate before MCP write tools, and the shapes the approvals inbox reads.
 * A paused run carries an `ApprovalRequestSpec` on its hand-off; the API
 * decides who may approve from it and the engine turns the decision into
 * the gate's output.
 */

export const APPROVAL_GATE_NODE_TYPE = "approval_gate";

/** Output handles of an Approval Gate node. */
export const APPROVAL_GATE_OUTPUT_HANDLES = ["approved", "rejected", "timed_out"] as const;
export type ApprovalGateOutputHandle = (typeof APPROVAL_GATE_OUTPUT_HANDLES)[number];

export const APPROVAL_DECISION_VALUES = ["approve", "reject", "timeout"] as const satisfies readonly ApprovalDecisionValue[];
export const APPROVAL_STATUS_VALUES = ["pending", "approved", "rejected", "timed_out", "canceled"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUS_VALUES)[number];
export const APPROVAL_REQUEST_KINDS = ["approval_gate", "human_approval", "guard", "agent_tool"] as const satisfies readonly ApprovalRequestKind[];
export const APPROVER_ROLE_VALUES = ["admin", "builder", "operator", "viewer"] as const;

/** Longest a gate may wait: 30 days. */
export const APPROVAL_MAX_TIMEOUT_MINUTES = 43_200;
export const APPROVAL_DEFAULT_TIMEOUT_MINUTES = 1_440;
export const APPROVAL_REASON_MAX_LENGTH = 2_000;
/** Largest serialised edits payload an approver may send. */
export const APPROVAL_EDITS_MAX_BYTES = 65_536;

const fieldKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "Use a letter or underscore, then up to 63 letters, digits or underscores");

export const approvalGateFieldSchema = z.object({
  key: fieldKeySchema,
  label: z.string().trim().max(120).optional(),
  type: z.enum(["string", "text", "number", "boolean", "json"]).default("string"),
  /** Template for the value the approver starts from, for example `{{answer}}`. */
  valueTemplate: z.string().max(20_000).optional(),
  required: z.boolean().optional(),
  maxLength: z.number().int().min(1).max(100_000).optional()
});
export type ApprovalGateField = z.output<typeof approvalGateFieldSchema>;

const approverUserSchema = z.string().trim().min(1).max(320);

export const approvalGateConfigSchema = z
  .object({
    /** Shown to the approver; a template. */
    message: z.string().max(4_000).default("Approval required to continue."),
    approverRoles: z.array(z.enum(APPROVER_ROLE_VALUES)).max(APPROVER_ROLE_VALUES.length).default([]),
    /** User ids or emails. */
    approverUsers: z.array(approverUserSchema).max(50).default([]),
    allowSelfApproval: z.boolean().default(false),
    timeoutMinutes: z.number().int().min(1).max(APPROVAL_MAX_TIMEOUT_MINUTES).default(APPROVAL_DEFAULT_TIMEOUT_MINUTES),
    timeoutOutcome: z.enum(["fallback", "reject"]).default("reject"),
    requireRejectReason: z.boolean().default(true),
    editableFields: z.array(approvalGateFieldSchema).max(20).default([])
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.editableFields.forEach((field, index) => {
      if (seen.has(field.key)) {
        ctx.addIssue({ code: "custom", path: ["editableFields", index, "key"], message: `Field '${field.key}' is listed twice` });
      }
      seen.add(field.key);
    });
  });
export type ApprovalGateConfig = z.output<typeof approvalGateConfigSchema>;

export const writeToolApprovalSettingsSchema = z.object({
  enabled: z.boolean(),
  approverRoles: z.array(z.enum(APPROVER_ROLE_VALUES)).max(APPROVER_ROLE_VALUES.length).optional(),
  approverUsers: z.array(approverUserSchema).max(50).optional(),
  allowSelfApproval: z.boolean().optional(),
  timeoutMinutes: z.number().int().min(1).max(APPROVAL_MAX_TIMEOUT_MINUTES).optional()
});

/** The request an agent's write-tool gate pauses with. Timeouts reject: a tool call has no fallback branch. */
export function writeToolApprovalRequest(settings: WriteToolApprovalSettings): ApprovalRequestSpec {
  return {
    kind: "agent_tool",
    approverRoles: [...(settings.approverRoles ?? [])],
    approverUsers: [...(settings.approverUsers ?? [])],
    allowSelfApproval: settings.allowSelfApproval === true,
    timeoutOutcome: "reject",
    requireRejectReason: true,
    editableFields: []
  };
}

/**
 * Who may decide a run paused before 11.2 or by a node without its own
 * approver settings (Human Approval, guard hand-offs): any operator or
 * above with execute access, the requester included, no reason required.
 */
export function defaultApprovalRequest(kind: ApprovalRequestKind): ApprovalRequestSpec {
  return {
    kind,
    approverRoles: [],
    approverUsers: [],
    allowSelfApproval: true,
    timeoutOutcome: "reject",
    requireRejectReason: false,
    editableFields: []
  };
}

export const approvalApproveInputSchema = z.object({
  reason: z.string().trim().max(APPROVAL_REASON_MAX_LENGTH).optional(),
  edits: z.record(z.string(), z.unknown()).optional(),
  /** The request the approver saw; a decision for an older request of the same run is refused. */
  requestId: z.string().min(1).max(128).optional()
});

export const approvalRejectInputSchema = z.object({
  reason: z.string().trim().max(APPROVAL_REASON_MAX_LENGTH).optional(),
  requestId: z.string().min(1).max(128).optional()
});

// ---------------------------------------------------------------------------
// Who may decide
// ---------------------------------------------------------------------------

export interface ApproverIdentity {
  id: string;
  email: string;
  role: (typeof APPROVER_ROLE_VALUES)[number];
}

export interface ApprovalRequester {
  userId?: string | null;
  email?: string | null;
}

export type ApproverCheck =
  | { allowed: true }
  | { allowed: false; code: "not_an_approver" | "self_approval" | "role_too_low"; message: string };

const ROLE_RANK: Record<ApproverIdentity["role"], number> = { viewer: 1, operator: 2, builder: 3, admin: 4 };

const sameEmail = (left?: string | null, right?: string | null) =>
  Boolean(left && right && left.trim().toLowerCase() === right.trim().toLowerCase());

/**
 * Whether `approver` may decide a request, before project access (the API
 * checks that the approver can execute the workflow's project first).
 * Listed roles match the approver's global role exactly; listed users match
 * by id or email. With no roles and no users listed, operators and above
 * qualify.
 */
export function checkApprover(spec: Pick<ApprovalRequestSpec, "approverRoles" | "approverUsers" | "allowSelfApproval">, approver: ApproverIdentity, requester: ApprovalRequester): ApproverCheck {
  const isRequester = (requester.userId && requester.userId === approver.id) || sameEmail(requester.email, approver.email);
  if (isRequester && !spec.allowSelfApproval) {
    return { allowed: false, code: "self_approval", message: "You started this run, and this gate does not allow approving your own run." };
  }
  const roles = spec.approverRoles ?? [];
  const users = spec.approverUsers ?? [];
  if (roles.length === 0 && users.length === 0) {
    return ROLE_RANK[approver.role] >= ROLE_RANK.operator
      ? { allowed: true }
      : { allowed: false, code: "role_too_low", message: "Deciding approvals needs the operator role or above." };
  }
  if (roles.includes(approver.role)) return { allowed: true };
  if (users.some((entry) => entry === approver.id || sameEmail(entry, approver.email))) return { allowed: true };
  return { allowed: false, code: "not_an_approver", message: "You are not one of this gate's approvers." };
}

// ---------------------------------------------------------------------------
// Approve with edits
// ---------------------------------------------------------------------------

export interface ApprovalEditsResult {
  ok: boolean;
  /** Every field's final value: the edit when given, else the proposed value. */
  values: Record<string, unknown>;
  /** Keys whose value the approver changed. */
  changed: string[];
  errors: Array<{ key: string; message: string }>;
}

function coerceEdit(field: ApprovalEditableField, raw: unknown): { value?: unknown; error?: string } {
  switch (field.type) {
    case "number": {
      const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (typeof value !== "number" || !Number.isFinite(value)) return { error: "must be a number" };
      return { value };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { value: raw };
      if (raw === "true" || raw === "false") return { value: raw === "true" };
      return { error: "must be true or false" };
    }
    case "json": {
      if (typeof raw === "string") {
        try {
          return { value: JSON.parse(raw) };
        } catch {
          return { error: "must be valid JSON" };
        }
      }
      return { value: raw };
    }
    default: {
      if (typeof raw !== "string") return { error: "must be text" };
      if (field.maxLength && raw.length > field.maxLength) return { error: `must be at most ${field.maxLength} characters` };
      return { value: raw };
    }
  }
}

const isBlank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

/**
 * Checks an approver's edits against the gate's editable fields: only listed
 * keys, values of the field's type, required fields not left empty and the
 * whole payload within `APPROVAL_EDITS_MAX_BYTES`.
 */
export function validateApprovalEdits(fields: readonly ApprovalEditableField[], edits: Record<string, unknown> | undefined): ApprovalEditsResult {
  const errors: ApprovalEditsResult["errors"] = [];
  const values: Record<string, unknown> = {};
  const changed: string[] = [];
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const given = edits ?? {};
  let size = 0;
  try {
    size = new TextEncoder().encode(JSON.stringify(given) ?? "").length;
  } catch {
    errors.push({ key: "*", message: "Edits must be plain JSON values" });
  }
  if (size > APPROVAL_EDITS_MAX_BYTES) errors.push({ key: "*", message: `Edits are larger than ${APPROVAL_EDITS_MAX_BYTES} bytes` });
  for (const key of Object.keys(given)) {
    if (!byKey.has(key)) errors.push({ key, message: "is not an editable field of this gate" });
  }
  for (const field of fields) {
    let value = field.value;
    if (Object.prototype.hasOwnProperty.call(given, field.key)) {
      const coerced = coerceEdit(field, given[field.key]);
      if (coerced.error) {
        errors.push({ key: field.key, message: coerced.error });
        continue;
      }
      value = coerced.value;
      if (JSON.stringify(value) !== JSON.stringify(field.value)) changed.push(field.key);
    }
    if (field.required && isBlank(value)) {
      errors.push({ key: field.key, message: "is required" });
      continue;
    }
    values[field.key] = value;
  }
  return { ok: errors.length === 0, values, changed, errors };
}

// ---------------------------------------------------------------------------
// The paused request inside a (possibly nested) paused state
// ---------------------------------------------------------------------------

export interface PendingApprovalInfo {
  /** The node that asked, in the innermost (sub-)workflow. */
  nodeId: string;
  nodeType: string | null;
  workflowId: string;
  workflowName: string | null;
  /** Execute Workflow nodes from the top-level run down to the asking workflow. */
  path: Array<{ workflowId: string; workflowName: string | null; nodeId: string }>;
  request: ApprovalRequestSpec;
  /** The waiting node's recorded output (message, tool name, verdict summaries). */
  details: Record<string, unknown> | null;
}

const MAX_NESTING = 16;

function requestKindFor(handoff: ApprovalHandoffState | undefined): ApprovalRequestKind {
  if (!handoff) return "human_approval";
  if (handoff.kind === "gate") return "approval_gate";
  if (handoff.kind === "rerun" && handoff.request) return handoff.request.kind;
  return "guard";
}

/** Walks sub-workflow hand-offs down to the node that asked for the decision. */
export function resolvePendingApproval(state: WorkflowExecutionState): PendingApprovalInfo {
  const path: PendingApprovalInfo["path"] = [];
  let current = state;
  for (let depth = 0; depth < MAX_NESTING; depth += 1) {
    const handoff = current.approvalHandoff;
    if (handoff?.kind === "sub_workflow" && handoff.childState && typeof handoff.childState === "object") {
      path.push({ workflowId: current.workflow?.id ?? "", workflowName: current.workflow?.name ?? null, nodeId: current.waitingNodeId });
      current = handoff.childState;
      continue;
    }
    break;
  }
  const handoff = current.approvalHandoff;
  const node = current.workflow?.nodes?.find((entry) => entry.id === current.waitingNodeId);
  const waiting = (current.nodeResults ?? []).find((entry) => entry.nodeId === current.waitingNodeId && entry.status === "waiting_approval");
  const details = waiting?.output && typeof waiting.output === "object" && !Array.isArray(waiting.output) ? (waiting.output as Record<string, unknown>) : null;
  const request =
    handoff?.kind === "gate"
      ? handoff.request
      : handoff?.kind === "rerun" && handoff.request
        ? handoff.request
        : defaultApprovalRequest(requestKindFor(handoff));
  return {
    nodeId: current.waitingNodeId,
    nodeType: node?.type ?? null,
    workflowId: current.workflow?.id ?? "",
    workflowName: current.workflow?.name ?? null,
    path,
    request,
    details
  };
}

// ---------------------------------------------------------------------------
// What the API returns
// ---------------------------------------------------------------------------

export interface ApprovalRequestView {
  /** The approval request. */
  requestId: string;
  /** The paused execution; `/api/approvals/:id/approve` takes this id. */
  id: string;
  executionId: string;
  workflowId: string;
  workflowName: string | null;
  projectId: string;
  nodeId: string;
  nodeType: string | null;
  kind: ApprovalRequestKind;
  status: ApprovalStatus;
  message: string | null;
  /** Kept for older clients: the same as `message`. */
  approvalMessage: string | null;
  timeoutMinutes: number | null;
  approverRoles: string[];
  approverUsers: string[];
  allowSelfApproval: boolean;
  timeoutOutcome: "fallback" | "reject";
  requireRejectReason: boolean;
  editableFields: ApprovalEditableField[];
  /** Sub-workflow path from the top-level run to the asking node. */
  path: PendingApprovalInfo["path"];
  details: Record<string, unknown> | null;
  requestedBy: string | null;
  triggerType: string | null;
  triggeredBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  /** Keys the approver changed. */
  editedFields: string[];
  /** Whether the signed-in user may decide it, and why not. */
  canDecide: boolean;
  cannotDecideReason: string | null;
}
