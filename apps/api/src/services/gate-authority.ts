/**
 * Who decides on a release gate: its approvers, self-approval and
 * enforcement, hashed. Only an admin can change any of them on an enforced
 * gate, so a builder's save never changes it. Gate case requests and release
 * approval requests store it when asked and go stale only when it changes.
 */

import { createHash } from "node:crypto";
import { RELEASE_APPROVAL_DEFAULT_TIMEOUT_MINUTES, releaseApproversSchema, releaseCanonicalJson, type ReleaseApprovers } from "@ai-orchestrator/shared";
import type { ReleaseGateRecord } from "../db/database.js";

/** The gate's approvers; a gate without any is decided by its admins. */
export function gateApprovers(gate: Pick<ReleaseGateRecord, "approvers">): ReleaseApprovers {
  const parsed = gate.approvers ? releaseApproversSchema.safeParse(gate.approvers) : null;
  if (parsed?.success) return parsed.data;
  return releaseApproversSchema.parse({ approverRoles: ["admin"], timeoutMinutes: RELEASE_APPROVAL_DEFAULT_TIMEOUT_MINUTES });
}

export function gateAuthority(gate: Pick<ReleaseGateRecord, "approvers" | "enforced">): string {
  const approvers = gateApprovers(gate);
  // Lower-cased, like the shared canonicalApprovers: re-casing an approver's email changes nothing about who may approve.
  const sorted = (values: readonly string[], lower = false) => [...new Set(values.map((value) => (lower ? value.trim().toLowerCase() : value.trim())))].sort();
  return createHash("sha256")
    .update(
      releaseCanonicalJson({
        approverRoles: sorted(approvers.approverRoles),
        approverUsers: sorted(approvers.approverUsers, true),
        allowSelfApproval: approvers.allowSelfApproval,
        enforced: gate.enforced
      })
    )
    .digest("hex");
}
