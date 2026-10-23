import { createHash } from "node:crypto";
import {
  APPROVAL_DEFAULT_TIMEOUT_MINUTES,
  approvalGateConfigSchema,
  ErrorCategory,
  WorkflowError,
  writeToolApprovalRequest,
  type ApprovalDecisionValue,
  type ApprovalEditableField,
  type ApprovalGateOutputHandle,
  type ApprovalRequestSpec,
  type McpToolClassification,
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
    timeoutMinutes: input.settings.timeoutMinutes ?? APPROVAL_DEFAULT_TIMEOUT_MINUTES,
    handoff: { kind: "rerun", source: "agent_tool_gate", approvalKey, request: writeToolApprovalRequest(input.settings) },
    details: {
      toolName: input.toolName,
      server: input.serverLabel,
      classification: input.classificationSource,
      arguments: preview
    }
  };
}

/**
 * Whether the write-tool gate lets a call through without asking. Server
 * annotations are hints from the server and are not trusted here (any MCP
 * server, an unreviewed inline one included, can label `delete_records`
 * read-only): only an admin's read-only mark in the tool policy counts.
 * Every other tool, unknown ones included, is a write tool.
 */
export function writeToolGateSkips(classification: McpToolClassification): boolean {
  return classification.source === "manual" && classification.readOnly;
}

/**
 * Phase 11.2 — what the write-tool gate remembers across re-runs of an agent
 * node. An approval is single use: the first matching call takes it, runs
 * the tool and stores the result. A later re-run of the node (it paused
 * again for the next write call) answers that call from the stored result
 * and never calls the tool again. Results are kept per approval key in call
 * order, so the n-th identical call of a re-run gets the n-th result, and a
 * call beyond the stored ones needs a new approval.
 */
export class WriteToolCallLedger {
  private readonly results: Map<string, unknown[]>;

  constructor(
    private readonly approvedKeys: Set<string>,
    stored?: Record<string, unknown> | null
  ) {
    this.results = new Map();
    for (const [key, value] of Object.entries(stored ?? {})) {
      if (Array.isArray(value)) this.results.set(key, [...value]);
    }
  }

  /** One execution of an agent node (shared with the workers it delegates to). */
  session(): WriteToolCallSession {
    const replayed = new Map<string, number>();
    return {
      replay: (key) => {
        const stored = this.results.get(key) ?? [];
        const used = replayed.get(key) ?? 0;
        if (used >= stored.length) return { hit: false };
        replayed.set(key, used + 1);
        return { hit: true, result: stored[used] };
      },
      takeApproval: (key) => this.approvedKeys.delete(key),
      record: (key, result) => {
        const stored = this.results.get(key) ?? [];
        stored.push(toJsonSafe(result));
        this.results.set(key, stored);
        replayed.set(key, stored.length);
      }
    };
  }

  /** For the paused state; undefined when nothing is stored. */
  toState(): Record<string, unknown[]> | undefined {
    if (this.results.size === 0) return undefined;
    return Object.fromEntries([...this.results.entries()].map(([key, value]) => [key, [...value]]));
  }

  clear(): void {
    this.results.clear();
  }
}

export interface WriteToolCallSession {
  /** The stored result for this key's next call in this execution, when an earlier run already made it. */
  replay(key: string): { hit: true; result: unknown } | { hit: false };
  /** Takes the one-time approval for this key; false when there is none. */
  takeApproval(key: string): boolean;
  /** Stores the result of an approved call. */
  record(key: string, result: unknown): void;
}

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
