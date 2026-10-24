/**
 * Release gate admission and required cases (migration 36), on enforced
 * gates only.
 *
 * A case added to an enforced gate's golden set after the gate was enforced
 * is pending admission (gate-admission-state.ts): it runs and is reported,
 * but counts toward nothing until it is admitted.
 *
 *   - Admins admit pending cases, reject them (the case leaves its set; the
 *     golden run is kept) and mark golden-run cases required (which admits
 *     them) or not.
 *   - Builders (`workflow:write`) ask instead: an `admit_cases` request to
 *     admit pending cases, or a `remove_cases` request to remove admitted
 *     ones, decided in the approvals inbox by the gate's approvers (admins
 *     when the gate names none), with the same rules as release requests:
 *     the approver can read the workflow and holds `workflow:publish` on it
 *     (so approvers are project-scoped), satisfies the approver list, and is
 *     not the requester unless the gate allows self-approval.
 *
 * A request is decided against the gate as it is at decision time: the
 * approver must satisfy the gate's current approvers and self-approval
 * setting (never the ones in force when it was asked). A later change to
 * who decides (the gate's approvers, self-approval or enforcement, all
 * admin-only on an enforced gate) makes open requests stale, as does the gate
 * no longer being enforced or none of the request's cases still fitting (pending cases not yet admitted, admitted
 * cases still there): a stale request cannot be approved, says why, and an
 * attempt to approve it cancels it with 409. Every change and request event
 * is audited (category `release`).
 * Gate case requests need the SQLite store; on Postgres the routes answer 501.
 */

import { randomUUID } from "node:crypto";
import {
  GATE_CASE_REQUEST_PREFIX,
  checkApprover,
  releaseAdmissionLoosening,
  type GateCaseDecisionInput,
  type GateCaseRequestInput,
  type GateCaseRequestKind,
  type GateCaseRequestView,
  type ReleaseGateCaseView,
  type ReleaseGateCasesView
} from "@ai-orchestrator/shared";
import type { GateCaseRequestRecord, ReleaseGateRecord, SqliteStore } from "../db/database.js";
import type { RunAccessResult } from "../run-access.js";
import type { AuditEventInput } from "./audit-service.js";
import type { SafeUser } from "./auth-service.js";
import { admissionState, gateAdmissionSnapshot, type GateAdmissionSnapshot } from "./gate-admission-state.js";
import { gateApprovers, gateAuthority } from "./gate-authority.js";
import type { NotificationEvent } from "./notification-service.js";
import { ReleaseError, type ReleasePermission } from "./release-service.js";

export interface GateAdmissionServiceOptions {
  store: SqliteStore;
  /** False on stores without release tables (Postgres in this release): every route answers 501. */
  available: boolean;
  /** The shared run-access check (run-access.ts): 404 unreadable, 403 without the permission; admins pass. */
  access: (user: SafeUser, workflowId: string, permission: ReleasePermission) => RunAccessResult<object>;
  readableWorkflowIds: (user: SafeUser) => string[] | null;
  audit: (event: AuditEventInput) => void;
  notify: (event: NotificationEvent) => Promise<void>;
  redact: (value: string) => string;
  appPublicUrl?: string;
  logger?: { warn: (message: string, fields?: Record<string, unknown>) => void };
  now?: () => Date;
}

const SELF_APPROVAL_MESSAGE = "You asked for this, and this gate does not allow approving your own request.";
const NOT_ENFORCED_MESSAGE = "This release gate is not enforced, so every case already counts: admission applies to enforced gates only.";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function sameIdentity(a: { id?: string | null; email?: string | null }, b: { id?: string | null; email?: string | null }): boolean {
  if (a.id && b.id && a.id === b.id) return true;
  return Boolean(a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase());
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export class GateAdmissionService {
  constructor(private readonly options: GateAdmissionServiceOptions) {}

  get available(): boolean {
    return this.options.available;
  }

  private get store(): SqliteStore {
    return this.options.store;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private requireAvailable(): void {
    if (!this.options.available) throw new ReleaseError("Release gates need the SQLite store in this release", 501);
  }

  private check(user: SafeUser, workflowId: string, permission: ReleasePermission): void {
    const result = this.options.access(user, workflowId, permission);
    if (!result.ok) throw new ReleaseError(result.error, result.status);
  }

  private projectOf(workflowId: string): string | null {
    return this.store.getWorkflow(workflowId)?.projectId ?? null;
  }

  private auditEvent(user: SafeUser | null, workflowId: string, eventType: string, action: string, metadata: Record<string, unknown>, outcome: "success" | "denied" = "success"): void {
    this.options.audit({
      category: "release",
      eventType,
      action,
      outcome,
      actor: user ? { userId: user.id, email: user.email, type: "user" } : { type: "system", email: "system" },
      resourceType: "workflow",
      resourceId: workflowId,
      projectId: this.projectOf(workflowId),
      metadata
    });
  }

  /** The enforced gate and its admission state; 409 when the gate is not enforced. */
  private enforced(workflowId: string): { gate: ReleaseGateRecord; snapshot: GateAdmissionSnapshot } {
    const gate = this.store.getReleaseGate(workflowId);
    const snapshot = gateAdmissionSnapshot(this.store, gate);
    if (!gate || !snapshot) throw new ReleaseError(NOT_ENFORCED_MESSAGE, 409);
    return { gate, snapshot };
  }

  /** The named cases, each in one of the gate's sets; 404 for one that is not. */
  private casesOf(snapshot: GateAdmissionSnapshot, fixtureIds: readonly string[]) {
    const byId = new Map(snapshot.fixtures.map((fixture) => [fixture.id, fixture]));
    const unique = [...new Set(fixtureIds)];
    const missing = unique.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new ReleaseError(`Not a case of this gate's golden sets: ${missing.join(", ")}`, 404);
    return unique.map((id) => byId.get(id)!);
  }

  // -------------------------------------------------------------------------
  // The gate's cases
  // -------------------------------------------------------------------------

  casesView(user: SafeUser, workflowId: string): ReleaseGateCasesView {
    this.requireAvailable();
    this.check(user, workflowId, "workflow:read");
    const gate = this.store.getReleaseGate(workflowId);
    const snapshot = gateAdmissionSnapshot(this.store, gate);
    const canWrite = this.options.access(user, workflowId, "workflow:write").ok;
    if (!snapshot) {
      return { workflowId, enforced: false, cases: [], counts: { admitted: 0, pending: 0, required: 0 }, canAdmit: false, canRequest: false };
    }
    this.sweepExpired();
    const asked = new Map<string, { id: string; kind: GateCaseRequestKind }>();
    for (const request of this.store.listPendingGateCaseRequests(workflowId)) {
      if (this.expired(request) || this.staleReason(request, gate)) continue;
      for (const entry of request.fixtures) {
        if (!asked.has(entry.fixtureId)) asked.set(entry.fixtureId, { id: request.id, kind: request.action === "remove" ? "remove_cases" : "admit_cases" });
      }
    }
    const setNames = new Map<string, string | null>();
    const setName = (datasetId: string) => {
      if (!setNames.has(datasetId)) setNames.set(datasetId, this.store.getEvalDataset(datasetId)?.name ?? null);
      return setNames.get(datasetId) ?? null;
    };
    const required = new Set(snapshot.requiredIds);
    const cases: ReleaseGateCaseView[] = snapshot.fixtures.map((fixture) => ({
      fixtureId: fixture.id,
      datasetId: fixture.datasetId,
      datasetName: setName(fixture.datasetId),
      name: fixture.name,
      recordingId: fixture.recordingId,
      admission: snapshot.admittedIds.has(fixture.id) ? "admitted" : "pending",
      required: required.has(fixture.id),
      requestId: asked.get(fixture.id)?.id ?? null,
      requestKind: asked.get(fixture.id)?.kind ?? null,
      createdAt: fixture.createdAt
    }));
    return {
      workflowId,
      enforced: true,
      cases,
      counts: {
        admitted: cases.filter((entry) => entry.admission === "admitted").length,
        pending: cases.filter((entry) => entry.admission === "pending").length,
        required: required.size
      },
      canAdmit: user.role === "admin",
      canRequest: canWrite && user.role !== "admin"
    };
  }

  private requireAdmin(user: SafeUser, workflowId: string, what: string): void {
    this.check(user, workflowId, "workflow:write");
    if (user.role !== "admin") {
      this.auditEvent(user, workflowId, "release.gate.cases_refused", "update", { what }, "denied");
      throw new ReleaseError(`Only admins can ${what} on an enforced release gate. Ask the gate's approvers instead.`, 403);
    }
  }

  /** Admins: the pending cases count from now on. */
  admit(user: SafeUser, workflowId: string, input: GateCaseDecisionInput): ReleaseGateCasesView {
    this.requireAvailable();
    this.requireAdmin(user, workflowId, "admit cases");
    const { snapshot } = this.enforced(workflowId);
    const cases = this.casesOf(snapshot, input.fixtureIds);
    const admitted = this.applyAdmit(user, workflowId, snapshot, cases.map((fixture) => fixture.id), { reason: input.reason ?? null, requestId: null });
    if (admitted.length === 0) throw new ReleaseError("Those cases are already admitted.", 409);
    return this.casesView(user, workflowId);
  }

  /** Admins: pending cases leave their golden sets (the golden runs are kept). Admitted cases are removed with the case's own delete. */
  reject(user: SafeUser, workflowId: string, input: GateCaseDecisionInput): ReleaseGateCasesView {
    this.requireAvailable();
    this.requireAdmin(user, workflowId, "reject cases");
    const { snapshot } = this.enforced(workflowId);
    const cases = this.casesOf(snapshot, input.fixtureIds);
    const admitted = cases.filter((fixture) => snapshot.admittedIds.has(fixture.id));
    if (admitted.length > 0) {
      throw new ReleaseError(`Only pending cases can be rejected; ${admitted.map((fixture) => `"${fixture.name}"`).join(", ")} ${admitted.length === 1 ? "is" : "are"} admitted. Remove an admitted case from its golden set instead.`, 409);
    }
    this.store.transaction(() => {
      for (const fixture of cases) this.store.deleteEvalFixture(fixture.id);
    });
    this.auditEvent(user, workflowId, "release.gate.cases_rejected", "update", {
      fixtureIds: cases.map((fixture) => fixture.id),
      reason: input.reason ? this.options.redact(input.reason) : null
    });
    return this.casesView(user, workflowId);
  }

  /** Admins: a golden-run case must pass on every publish (marking it also admits it), or no longer must. */
  setRequired(user: SafeUser, workflowId: string, fixtureId: string, required: boolean): ReleaseGateCasesView {
    this.requireAvailable();
    this.requireAdmin(user, workflowId, required ? "mark a case required" : "stop requiring a case");
    const { snapshot } = this.enforced(workflowId);
    const [fixture] = this.casesOf(snapshot, [fixtureId]);
    if (!fixture!.recordingId) throw new ReleaseError("Only a golden-run case can be required: replay jobs skip hand-written fixtures.", 400);
    const before = admissionState(snapshot);
    this.store.transaction(() => {
      if (required && !snapshot.admittedIds.has(fixtureId)) {
        this.applyAdmit(user, workflowId, snapshot, [fixtureId], { reason: "Marked required", requestId: null });
      }
      if (fixture!.required !== required) this.store.setEvalFixtureRequired(fixtureId, required);
    });
    const after = { admittedIds: [...new Set([...before.admittedIds, ...(required ? [fixtureId] : [])])], requiredIds: required ? [...new Set([...before.requiredIds, fixtureId])] : before.requiredIds.filter((id) => id !== fixtureId) };
    this.auditEvent(user, workflowId, "release.gate.case_required", "update", {
      fixtureId,
      required,
      loosened: releaseAdmissionLoosening(before, after, snapshot.names)
    });
    return this.casesView(user, workflowId);
  }

  private applyAdmit(user: SafeUser, workflowId: string, snapshot: GateAdmissionSnapshot, fixtureIds: string[], context: { reason: string | null; requestId: string | null }): string[] {
    const fresh = fixtureIds.filter((id) => !snapshot.admittedIds.has(id));
    if (fresh.length === 0) return [];
    this.store.setReleaseGateAdmission(workflowId, [...snapshot.admittedIds, ...fresh], this.now().toISOString(), user.email);
    this.auditEvent(user, workflowId, "release.gate.cases_admitted", "update", {
      fixtureIds: fresh,
      reason: context.reason ? this.options.redact(context.reason) : null,
      requestId: context.requestId
    });
    return fresh;
  }

  // -------------------------------------------------------------------------
  // Requests (the approvals inbox)
  // -------------------------------------------------------------------------

  /** Builders (`workflow:write`): ask the gate's approvers to admit pending cases or remove admitted ones. */
  request(user: SafeUser, workflowId: string, input: GateCaseRequestInput): GateCaseRequestView {
    this.requireAvailable();
    this.check(user, workflowId, "workflow:write");
    const { gate, snapshot } = this.enforced(workflowId);
    const cases = this.casesOf(snapshot, input.fixtureIds);
    if (input.action === "admit") {
      const already = cases.filter((fixture) => snapshot.admittedIds.has(fixture.id));
      if (already.length > 0) throw new ReleaseError(`${already.map((fixture) => `"${fixture.name}"`).join(", ")} ${already.length === 1 ? "is" : "are"} already admitted.`, 409);
    } else {
      const pending = cases.filter((fixture) => !snapshot.admittedIds.has(fixture.id));
      if (pending.length > 0) {
        throw new ReleaseError(`${pending.map((fixture) => `"${fixture.name}"`).join(", ")} ${pending.length === 1 ? "is" : "are"} still pending admission: remove ${pending.length === 1 ? "it" : "them"} from the golden set directly.`, 409);
      }
    }
    this.sweepExpired();
    const action = input.action;
    const ids = new Set(cases.map((fixture) => fixture.id));
    for (const existing of this.store.listPendingGateCaseRequests(workflowId)) {
      const stale = this.staleReason(existing, gate);
      if (stale) {
        this.close(existing, "canceled", `Stale: ${stale}`, null);
        continue;
      }
      if (existing.action !== action) continue;
      const overlap = existing.fixtures.filter((entry) => ids.has(entry.fixtureId));
      if (overlap.length === 0) continue;
      if (sameIdentity({ id: existing.requestedByUserId, email: existing.requestedBy }, user) && overlap.length === ids.size && existing.fixtures.length === ids.size) {
        return this.toView(existing, user);
      }
      throw new ReleaseError(`A request about ${overlap.map((entry) => `"${entry.name}"`).join(", ")} is already waiting in the approvals inbox.`, 409);
    }
    const approvers = gateApprovers(gate);
    const createdAt = this.now();
    const workflow = this.store.getWorkflow(workflowId);
    const record = this.store.insertGateCaseRequest({
      id: `${GATE_CASE_REQUEST_PREFIX}${randomUUID()}`,
      workflowId,
      workflowName: workflow?.name ?? null,
      projectId: workflow?.projectId ?? "default",
      action,
      fixtures: cases.map((fixture) => ({ fixtureId: fixture.id, name: fixture.name, datasetId: fixture.datasetId })),
      spec: { approverRoles: approvers.approverRoles, approverUsers: approvers.approverUsers, allowSelfApproval: approvers.allowSelfApproval },
      gateAuthority: gateAuthority(gate),
      status: "pending",
      requestReason: input.reason,
      requestedByUserId: user.id,
      requestedBy: user.email,
      expiresAt: new Date(createdAt.getTime() + approvers.timeoutMinutes * 60_000).toISOString(),
      decidedByUserId: null,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString()
    });
    this.auditEvent(user, workflowId, "release.gate.case_request.requested", "request", {
      requestId: record.id,
      action,
      fixtureIds: [...ids],
      reason: this.options.redact(input.reason),
      approverRoles: approvers.approverRoles,
      approverUsers: approvers.approverUsers.length
    });
    const base = this.options.appPublicUrl?.replace(/\/+$/, "");
    // Channels are not project-scoped: only the workflow, the count and the approvers go out, never case names or reasons.
    this.options
      .notify({
        type: "approval.requested",
        workflowId,
        workflowName: record.workflowName ?? workflowId,
        timestamp: createdAt.toISOString(),
        approval: {
          requestId: record.id,
          nodeId: `release-gate:${action === "admit" ? "admit" : "remove"}-${ids.size}-cases`,
          expiresAt: record.expiresAt,
          approvers: [...approvers.approverRoles.map((role) => `role ${role}`), ...approvers.approverUsers].join(", ") || "anyone else who may publish",
          ...(base ? { link: `${base}/?mode=approvals&request=${encodeURIComponent(record.id)}` } : {})
        }
      })
      .catch((error) => this.options.logger?.warn("Gate case request notification failed", { error: error instanceof Error ? error.message : String(error) }));
    return this.toView(record, user);
  }

  private expired(record: GateCaseRequestRecord): boolean {
    return Boolean(record.expiresAt && Date.parse(record.expiresAt) <= this.now().getTime());
  }

  private sweepExpired(): void {
    for (const record of this.store.timeOutExpiredGateCaseRequests(this.now().toISOString())) {
      this.auditEvent(null, record.workflowId, "release.gate.case_request.timed_out", "timeout", { requestId: record.id, action: record.action });
    }
  }

  /**
   * Why approving this request now would decide on a gate other than the one
   * it was asked of; null when it still holds. `gate` is the current gate
   * (read when not given).
   */
  private staleReason(record: GateCaseRequestRecord, gate: ReleaseGateRecord | null = this.store.getReleaseGate(record.workflowId)): string | null {
    if (!gate?.enforced) return "The release gate is no longer enforced, so every case counts.";
    if (record.gateAuthority !== gateAuthority(gate)) return "Who decides the release gate's cases (its approvers, self-approval or enforcement) changed after the request was made.";
    return null;
  }

  /** Checks the person against the gate's approvers and self-approval setting as they are now. */
  private personCheck(record: GateCaseRequestRecord, user: SafeUser, gate: ReleaseGateRecord | null): { allowed: true } | { allowed: false; code: string; message: string } {
    if (!this.options.access(user, record.workflowId, "workflow:publish").ok) {
      return { allowed: false, code: "project_access", message: "You may not publish this workflow, so you cannot decide its gate's cases." };
    }
    if (!gate) return { allowed: false, code: "stale", message: "This workflow no longer has a release gate." };
    const approvers = gateApprovers(gate);
    const check = checkApprover(
      { approverRoles: approvers.approverRoles, approverUsers: approvers.approverUsers, allowSelfApproval: approvers.allowSelfApproval },
      { id: user.id, email: user.email, role: user.role },
      { userId: record.requestedByUserId, email: record.requestedBy }
    );
    if (!check.allowed) return { allowed: false, code: check.code, message: check.code === "self_approval" ? SELF_APPROVAL_MESSAGE : check.message };
    return { allowed: true };
  }

  private message(record: GateCaseRequestRecord): string {
    const count = plural(record.fixtures.length, "case");
    return record.action === "remove"
      ? `Remove ${count} the enforced release gate counts`
      : `Admit ${count} to the enforced release gate, so ${record.fixtures.length === 1 ? "it counts" : "they count"} toward publishing`;
  }

  private toView(record: GateCaseRequestRecord, user: SafeUser): GateCaseRequestView {
    const status = record.status === "pending" && this.expired(record) ? "timed_out" : record.status;
    const gate = this.store.getReleaseGate(record.workflowId);
    const stale = status === "pending" ? this.staleReason(record, gate) : null;
    const check = status !== "pending" ? { allowed: false as const, message: "Already decided." } : stale ? { allowed: false as const, message: `This request is stale: ${stale} Ask again.` } : this.personCheck(record, user, gate);
    // The approvers who decide now: the gate's current ones (the ones asked when the gate is gone).
    const spec = asRecord(record.spec);
    const current = gate ? gateApprovers(gate) : null;
    return {
      kind: record.action === "remove" ? "remove_cases" : "admit_cases",
      requestId: record.id,
      id: record.id,
      workflowId: record.workflowId,
      workflowName: record.workflowName,
      projectId: this.store.getWorkflow(record.workflowId)?.projectId ?? record.projectId,
      status: status as GateCaseRequestView["status"],
      message: this.message(record),
      cases: record.fixtures,
      requestReason: record.requestReason ? this.options.redact(record.requestReason) : null,
      approverRoles: current ? [...current.approverRoles] : ((Array.isArray(spec.approverRoles) ? spec.approverRoles : []) as string[]),
      approverUsers: current ? [...current.approverUsers] : ((Array.isArray(spec.approverUsers) ? spec.approverUsers : []) as string[]),
      allowSelfApproval: current ? current.allowSelfApproval : spec.allowSelfApproval === true,
      requestedBy: record.requestedBy,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      decidedBy: record.decidedBy,
      decidedAt: record.decidedAt,
      reason: record.decisionReason ? this.options.redact(record.decisionReason) : null,
      canDecide: check.allowed,
      cannotDecideReason: check.allowed ? null : check.message
    };
  }

  /** Gate case requests of workflows the user can read, narrowed in SQL before the limit. */
  listRequests(user: SafeUser, filter: { status: "pending" | "decided" | "all"; workflowId?: string; limit?: number }): GateCaseRequestView[] {
    if (!this.options.available) return [];
    this.sweepExpired();
    const workflowIds = this.options.readableWorkflowIds(user);
    const rows = this.store.listGateCaseRequests({ ...filter, now: this.now().toISOString(), scope: workflowIds === null ? { all: true } : { workflowIds } });
    const views: GateCaseRequestView[] = [];
    for (const row of rows) {
      if (!this.options.access(user, row.workflowId, "workflow:read").ok) continue;
      const view = this.toView(row, user);
      if (filter.status === "pending" && view.status !== "pending") continue;
      views.push(view);
    }
    return views;
  }

  private close(record: GateCaseRequestRecord, status: "canceled" | "timed_out", reason: string, actor: SafeUser | null): void {
    if (!this.store.decideGateCaseRequest({ id: record.id, status, decisionReason: reason, decidedByUserId: actor?.id ?? null, decidedBy: actor?.email ?? "system" })) return;
    this.auditEvent(actor, record.workflowId, status === "timed_out" ? "release.gate.case_request.timed_out" : "release.gate.case_request.canceled", status === "timed_out" ? "timeout" : "cancel", {
      requestId: record.id,
      action: record.action,
      reason
    });
  }

  /**
   * Decides a gate case request. Approving admits the cases still pending
   * (`admit_cases`) or removes the admitted cases still there
   * (`remove_cases`: the cases leave their golden sets, the golden runs are
   * kept), as the approver.
   */
  decide(user: SafeUser, requestId: string, decision: "approve" | "reject", reason?: string): { request: GateCaseRequestView } {
    this.requireAvailable();
    const record = this.store.getGateCaseRequest(requestId);
    if (!record || !this.options.access(user, record.workflowId, "workflow:read").ok) throw new ReleaseError("Pending approval not found", 404);
    if (record.status !== "pending") throw new ReleaseError("This approval was already decided", 409);
    if (this.expired(record)) {
      this.close(record, "timed_out", "Nobody decided before the request expired", null);
      throw new ReleaseError("This request expired; ask again", 409);
    }
    const check = this.personCheck(record, user, this.store.getReleaseGate(record.workflowId));
    if (!check.allowed) {
      this.auditEvent(user, record.workflowId, "release.gate.case_request.decided", decision, { requestId: record.id, action: record.action, refused: check.code }, "denied");
      throw new ReleaseError(check.message, 403);
    }
    const trimmed = reason?.trim() || null;
    if (decision === "reject") {
      if (!trimmed) throw new ReleaseError("A reason is required to reject a request", 400);
      if (!this.store.decideGateCaseRequest({ id: record.id, status: "rejected", decidedByUserId: user.id, decidedBy: user.email, decisionReason: trimmed })) {
        throw new ReleaseError("This approval was already decided", 409);
      }
      this.auditEvent(user, record.workflowId, "release.gate.case_request.decided", decision, { requestId: record.id, action: record.action, decision, reason: this.options.redact(trimmed) });
      return { request: this.toView(this.store.getGateCaseRequest(record.id)!, user) };
    }
    const gate = this.store.getReleaseGate(record.workflowId);
    const snapshot = gateAdmissionSnapshot(this.store, gate);
    const stale = (why: string): never => {
      this.close(record, "canceled", `Stale: ${why}`, user);
      throw new ReleaseError(`This request is stale and was canceled: ${why} Ask again.`, 409);
    };
    const why = this.staleReason(record, gate);
    if (why || !snapshot) return stale(why ?? "The release gate is no longer enforced, so every case counts.");
    const inGate = new Set(snapshot.fixtures.map((fixture) => fixture.id));
    const asked = record.fixtures.map((entry) => entry.fixtureId);
    const fits = record.action === "admit" ? asked.filter((id) => inGate.has(id) && !snapshot.admittedIds.has(id)) : asked.filter((id) => snapshot.admittedIds.has(id));
    if (fits.length === 0) {
      return stale(record.action === "admit" ? "None of its cases is still pending admission." : "None of its cases is still admitted to the gate.");
    }
    const before = admissionState(snapshot);
    this.store.transaction(() => {
      if (!this.store.decideGateCaseRequest({ id: record.id, status: "approved", decidedByUserId: user.id, decidedBy: user.email, decisionReason: trimmed })) {
        throw new ReleaseError("This approval was already decided", 409);
      }
      if (record.action === "admit") {
        this.store.setReleaseGateAdmission(record.workflowId, [...snapshot.admittedIds, ...fits], this.now().toISOString(), user.email);
      } else {
        for (const id of fits) this.store.deleteEvalFixture(id);
        this.store.setReleaseGateAdmission(record.workflowId, [...snapshot.admittedIds].filter((id) => !fits.includes(id)), this.now().toISOString(), user.email);
      }
    });
    const after =
      record.action === "admit"
        ? { admittedIds: [...before.admittedIds, ...fits], requiredIds: before.requiredIds }
        : { admittedIds: before.admittedIds.filter((id) => !fits.includes(id)), requiredIds: before.requiredIds.filter((id) => !fits.includes(id)) };
    this.auditEvent(user, record.workflowId, "release.gate.case_request.decided", decision, {
      requestId: record.id,
      action: record.action,
      decision,
      fixtureIds: fits,
      requestedBy: record.requestedBy,
      reason: trimmed ? this.options.redact(trimmed) : null,
      loosened: releaseAdmissionLoosening(before, after, snapshot.names)
    });
    this.auditEvent(user, record.workflowId, record.action === "admit" ? "release.gate.cases_admitted" : "release.gate.cases_removed", "update", {
      fixtureIds: fits,
      requestId: record.id
    });
    return { request: this.toView(this.store.getGateCaseRequest(record.id)!, user) };
  }
}
