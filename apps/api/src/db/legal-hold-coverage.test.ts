/**
 * 13.3 — a tripwire for legal holds: every store method that deletes (`prune*`, `delete*`, `purge*`, `clear*`,
 * `remove*`) is either hold-checked (it carries the legal-hold predicate, or refuses with LegalHoldError) or listed
 * here as deleting nothing a hold can name, with the reason. A new deleting method fails this test until someone
 * decides which side it is on. The contract tests (contract/legal-holds.*.test.ts) prove the hold-checked ones.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOLDABLE_TABLES } from "./legal-hold-sql.js";
import { RETENTION_TABLES } from "./retention-tables.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Deletes that a legal hold stops (each proven on both stores by the contract tests). */
const HOLD_CHECKED: Record<string, string> = {
  pruneRetentionTable: "retentionWhere leaves held rows out of every batch",
  pruneEvalRuns: "held eval runs and replay jobs are left out, per chunk",
  pruneReplayCaptures: "held captured runs are left out of every batch",
  pruneGuardSimulations: "a simulation keeps its held jobs, and stays with them",
  deleteWorkflow: "refused (409 legal_hold) while a hold covers the workflow, its project or its runs",
  deleteProject: "refused while a project hold names it",
  deleteEvalDataset: "refused while a hold covers the set, its cases or its runs",
  deleteEvalFixture: "refused while a hold covers the case",
  deleteReplayRecording: "refused while a hold covers the golden or captured run (eviction skips held ones)",
  deleteMcpCassette: "refused while a hold covers the cassette",
  deleteSubjectRow: "a held row is left and reported (heldBy)"
};

/** Deletes of data no legal hold can name, or of no data at all. */
const NOT_HOLDABLE: Record<string, string> = {
  pruneExecutionHistory: "no production caller: kept only as the reference the retention equivalence test compares against",
  pruneWorkflowVersions: "workflow definitions, not run data",
  pruneClusterInstances: "instance liveness",
  prunePendingChallenges: "sign-in challenges",
  pruneRateLimitBuckets: "rate-limit counters",
  pruneReplayCaptureReservations: "capture slots, not captured runs",
  pruneAuditLogs: "the audit log is deployment-wide and hash-chained (AUDIT_LOG_RETENTION_DAYS)",
  pruneLogStreamEvents: "log stream delivery history",
  pruneExecutionManifests: "signed manifests are audit evidence with their own retention",
  purgeEndedSessions: "sign-in sessions",
  deleteMcpServer: "MCP server configuration",
  deleteMcpUserOAuthConnection: "OAuth connections",
  deleteMcpOAuthConnection: "OAuth connections",
  deleteMcpToolPolicy: "configuration",
  deleteMcpToolset: "configuration",
  deleteGuardProfile: "content rules configuration",
  deleteDataDestination: "configuration",
  deleteModelAllowlistEntry: "configuration",
  deleteKnowledgeBase: "knowledge bases are configuration and documents, not run data",
  deleteKnowledgeBaseChunksBySource: "knowledge base documents",
  deleteEvalFixturesForRecording: "called only inside a golden-run delete, which is hold-checked first",
  removeProjectRole: "membership",
  deleteCustomRole: "configuration",
  deleteSsoGroupMapping: "configuration",
  removeWorkflowShare: "sharing",
  removeSecretShare: "sharing",
  deleteTemplate: "templates",
  deleteFolder: "folders",
  deleteUser: "the user row and credentials (authorship pseudonymisation, deferred by a staff hold, comes with erasure)",
  deleteUserKeepingAdmin: "as deleteUser",
  clearSessionMfaVerified: "a session flag",
  deleteMfaSecret: "credentials",
  deleteSecret: "credentials",
  deleteExternalSecretProvider: "configuration",
  deleteExternalSecretCacheEntry: "a cache",
  clearExpiredWebhookSecurityState: "replay-protection nonces",
  deleteWorkflowExecution: "a paused run's resume state, removed when the run ends",
  deleteTriggerStatesForWorkflow: "trigger cursors",
  deleteGitConfig: "configuration",
  deleteClusterInstance: "instance liveness",
  deletePendingChallenges: "sign-in challenges",
  deleteLogStreamDestination: "configuration",
  deleteAuditExportDestination: "configuration",
  deleteVariable: "configuration",
  deleteNotificationConfig: "configuration",
  deleteBudget: "configuration"
};

function storeDeletingMethods(): string[] {
  const source = fs.readFileSync(path.join(here, "store.ts"), "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(/^\s{2}((?:prune|delete|purge|clear|remove|evict)[A-Za-z]*)\(/gm)) names.add(match[1]!);
  return [...names].sort();
}

describe("legal-hold coverage of the store's deletes", () => {
  it("every deleting store method is hold-checked or listed as deleting nothing a hold can name", () => {
    const methods = storeDeletingMethods();
    expect(methods.length).toBeGreaterThan(40);
    const unclassified = methods.filter((name) => !(name in HOLD_CHECKED) && !(name in NOT_HOLDABLE));
    expect(unclassified, "classify these in legal-hold-coverage.test.ts").toEqual([]);
    const stale = [...Object.keys(HOLD_CHECKED), ...Object.keys(NOT_HOLDABLE)].filter((name) => !methods.includes(name));
    expect(stale, "these are no longer store methods").toEqual([]);
  });

  it("every retention table but the purge log can be held", () => {
    const retention = Object.keys(RETENTION_TABLES).filter((table) => table !== "retention_runs");
    expect(retention.filter((table) => !(HOLDABLE_TABLES as readonly string[]).includes(table))).toEqual([]);
  });
});
