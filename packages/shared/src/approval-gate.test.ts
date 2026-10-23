import { describe, expect, it } from "vitest";
import {
  approvalGateConfigSchema,
  checkApprover,
  defaultApprovalRequest,
  resolvePendingApproval,
  validateApprovalEdits,
  writeToolApprovalRequest
} from "./approval-gate";
import { nodeDefinitions } from "./definitions";
import { replayNodeClass } from "./replay";
import { workflowSchema } from "./schemas";
import type { ApprovalEditableField, WorkflowExecutionState } from "./types";

const approver = (role: "admin" | "builder" | "operator" | "viewer", id = `${role}-1`, email = `${role}@example.com`) => ({ id, email, role });

describe("approval gate config", () => {
  it("fills safe defaults: no self-approval, reject on timeout, a day to decide, a reason to reject", () => {
    const parsed = approvalGateConfigSchema.parse({});
    expect(parsed).toMatchObject({
      allowSelfApproval: false,
      timeoutOutcome: "reject",
      timeoutMinutes: 1440,
      requireRejectReason: true,
      approverRoles: [],
      approverUsers: [],
      editableFields: []
    });
  });

  it("refuses duplicate field keys, bad keys, unknown roles and timeouts past 30 days", () => {
    expect(approvalGateConfigSchema.safeParse({ editableFields: [{ key: "a" }, { key: "a" }] }).success).toBe(false);
    expect(approvalGateConfigSchema.safeParse({ editableFields: [{ key: "1bad" }] }).success).toBe(false);
    expect(approvalGateConfigSchema.safeParse({ approverRoles: ["owner"] }).success).toBe(false);
    expect(approvalGateConfigSchema.safeParse({ timeoutMinutes: 43_201 }).success).toBe(false);
    expect(approvalGateConfigSchema.safeParse({ timeoutMinutes: 0 }).success).toBe(false);
  });

  it("is a registered node type with a definition and the approval replay class", () => {
    expect(nodeDefinitions.some((definition) => definition.type === "approval_gate")).toBe(true);
    expect(replayNodeClass({ type: "approval_gate" })).toBe("approval");
    const workflow = {
      id: "wf",
      name: "Gate",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [{ id: "gate", type: "approval_gate", name: "Gate", position: { x: 0, y: 0 }, config: {} }],
      edges: [],
      settings: { writeToolApproval: { enabled: true, approverRoles: ["admin"], timeoutMinutes: 30 } }
    };
    expect(workflowSchema.safeParse(workflow).success).toBe(true);
    expect(workflowSchema.safeParse({ ...workflow, settings: { writeToolApproval: { enabled: true, approverRoles: ["root"] } } }).success).toBe(false);
  });
});

describe("checkApprover", () => {
  const spec = { approverRoles: [] as Array<"admin" | "builder" | "operator" | "viewer">, approverUsers: [] as string[], allowSelfApproval: false };

  it("lets operators and above decide when nobody is listed, never viewers", () => {
    expect(checkApprover(spec, approver("operator"), {}).allowed).toBe(true);
    expect(checkApprover(spec, approver("admin"), {}).allowed).toBe(true);
    expect(checkApprover(spec, approver("viewer"), {})).toMatchObject({ allowed: false, code: "role_too_low" });
  });

  it("matches listed roles exactly and listed users by id or email (case-insensitive)", () => {
    const listed = { ...spec, approverRoles: ["builder" as const], approverUsers: ["u-7", "Lead@Example.com"] };
    expect(checkApprover(listed, approver("builder"), {}).allowed).toBe(true);
    expect(checkApprover(listed, approver("admin"), {})).toMatchObject({ allowed: false, code: "not_an_approver" });
    expect(checkApprover(listed, approver("viewer", "u-7"), {}).allowed).toBe(true);
    expect(checkApprover(listed, approver("operator", "x", "lead@example.com"), {}).allowed).toBe(true);
  });

  it("refuses the requester unless the gate allows self-approval, matching by id or email", () => {
    expect(checkApprover(spec, approver("admin", "me"), { userId: "me" })).toMatchObject({ allowed: false, code: "self_approval" });
    expect(checkApprover(spec, approver("admin", "me", "Me@Example.com"), { email: "me@example.com" })).toMatchObject({ code: "self_approval" });
    expect(checkApprover({ ...spec, allowSelfApproval: true }, approver("admin", "me"), { userId: "me" }).allowed).toBe(true);
    // Listing the requester as an approver does not bypass the self-approval rule.
    expect(checkApprover({ ...spec, approverUsers: ["me"] }, approver("admin", "me"), { userId: "me" }).allowed).toBe(false);
  });
});

describe("validateApprovalEdits", () => {
  const fields: ApprovalEditableField[] = [
    { key: "subject", type: "string", required: true, maxLength: 20, value: "Hello" },
    { key: "amount", type: "number", value: 10 },
    { key: "send", type: "boolean", value: true },
    { key: "meta", type: "json", value: { a: 1 } }
  ];

  it("keeps proposed values, applies typed edits and lists what changed", () => {
    const result = validateApprovalEdits(fields, { subject: "Hi there", amount: "12.5", send: "false", meta: "{\"b\":2}" });
    expect(result.ok).toBe(true);
    expect(result.values).toEqual({ subject: "Hi there", amount: 12.5, send: false, meta: { b: 2 } });
    expect(result.changed).toEqual(["subject", "amount", "send", "meta"]);
    const untouched = validateApprovalEdits(fields, undefined);
    expect(untouched.values).toEqual({ subject: "Hello", amount: 10, send: true, meta: { a: 1 } });
    expect(untouched.changed).toEqual([]);
    expect(validateApprovalEdits(fields, { amount: 10 }).changed).toEqual([]);
  });

  it("refuses unknown keys, wrong types, blank required fields, long text and oversized payloads", () => {
    expect(validateApprovalEdits(fields, { other: 1 }).errors).toEqual([{ key: "other", message: "is not an editable field of this gate" }]);
    expect(validateApprovalEdits(fields, { amount: "lots" }).errors[0]?.key).toBe("amount");
    expect(validateApprovalEdits(fields, { send: "maybe" }).ok).toBe(false);
    expect(validateApprovalEdits(fields, { meta: "{nope" }).ok).toBe(false);
    expect(validateApprovalEdits(fields, { subject: "  " }).errors).toEqual([{ key: "subject", message: "is required" }]);
    expect(validateApprovalEdits(fields, { subject: "x".repeat(21) }).ok).toBe(false);
    expect(validateApprovalEdits(fields, { subject: 5 }).ok).toBe(false);
    expect(validateApprovalEdits(fields, { meta: "x".repeat(70_000) }).errors.some((error) => error.key === "*")).toBe(true);
  });
});

describe("resolvePendingApproval", () => {
  const baseState = (overrides: Partial<WorkflowExecutionState>): WorkflowExecutionState => ({
    workflow: { id: "wf", name: "Top", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [{ id: "n", type: "human_approval", name: "Approve", position: { x: 0, y: 0 }, config: {} }], edges: [] },
    nodeOrder: ["n"],
    nextNodeIndex: 1,
    waitingNodeId: "n",
    startedAt: "2026-10-23T00:00:00.000Z",
    globals: {},
    nodeOutputs: {},
    nodeResults: [{ nodeId: "n", status: "waiting_approval", startedAt: "", completedAt: "", durationMs: 0, output: { message: "ok?" } }],
    skippedByBranch: [],
    tryCatchScopes: [],
    hadContinuedErrors: false,
    ...overrides
  });

  it("reads a Human Approval pause with the permissive legacy defaults", () => {
    const info = resolvePendingApproval(baseState({}));
    expect(info).toMatchObject({ nodeId: "n", nodeType: "human_approval", path: [], details: { message: "ok?" } });
    expect(info.request).toEqual(defaultApprovalRequest("human_approval"));
  });

  it("reads guard and agent-tool hand-offs", () => {
    expect(resolvePendingApproval(baseState({ approvalHandoff: { kind: "route", source: "guard", onApprove: {}, onReject: {} } })).request.kind).toBe("guard");
    const toolGate = writeToolApprovalRequest({ enabled: true, approverRoles: ["admin"] });
    const info = resolvePendingApproval(baseState({ approvalHandoff: { kind: "rerun", source: "agent_tool_gate", approvalKey: "k", request: toolGate } }));
    expect(info.request).toMatchObject({ kind: "agent_tool", approverRoles: ["admin"], allowSelfApproval: false, timeoutOutcome: "reject" });
  });

  it("walks sub-workflow hand-offs down to the asking gate", () => {
    const gate = { ...defaultApprovalRequest("approval_gate"), allowSelfApproval: false, approverUsers: ["lead"] };
    const child = baseState({
      workflow: { id: "child", name: "Child", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [{ id: "g", type: "approval_gate", name: "Gate", position: { x: 0, y: 0 }, config: {} }], edges: [] },
      waitingNodeId: "g",
      nodeResults: [{ nodeId: "g", status: "waiting_approval", startedAt: "", completedAt: "", durationMs: 0, output: { message: "inner" } }],
      approvalHandoff: { kind: "gate", source: "approval_gate", request: gate }
    });
    const middle = baseState({ waitingNodeId: "call", approvalHandoff: { kind: "sub_workflow", source: "execute_workflow", workflowId: "child", childState: child } });
    const info = resolvePendingApproval(middle);
    expect(info).toMatchObject({ nodeId: "g", nodeType: "approval_gate", workflowId: "child", path: [{ workflowId: "wf", nodeId: "call" }], details: { message: "inner" } });
    expect(info.request.approverUsers).toEqual(["lead"]);
  });
});
