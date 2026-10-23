import { createHmac, randomBytes } from "node:crypto";
import { canonicalJson } from "@ai-orchestrator/shared";

/**
 * Phase 11.2 — the digest of an approver's edits, as the audit log and the
 * run manifest record it: HMAC-SHA256 over the canonical JSON of the edits,
 * keyed with a random salt kept on the approval request row. The two records
 * of the same edits match, and a short edit (`{"approved_amount":250}`)
 * cannot be guessed from an exported manifest without the database.
 */
export function newApprovalEditsSalt(): string {
  return randomBytes(16).toString("hex");
}

export function approvalEditsDigest(salt: string | null | undefined, edits: unknown): string | null {
  if (edits === null || edits === undefined || !salt) return null;
  return createHmac("sha256", salt).update(canonicalJson(edits)).digest("hex");
}
