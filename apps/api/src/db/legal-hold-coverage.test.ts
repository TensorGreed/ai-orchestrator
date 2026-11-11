/**
 * 13.3 — a tripwire for legal holds, at the SQL level. In both stores' source (database.ts and postgres/*.ts):
 *
 * - every `DELETE FROM` a holdable table (or a table named at run time) sits in a function that checks holds (it
 *   carries the not-held predicate, a hold lookup or a refusal), or in a helper listed below whose every caller does;
 *   anything else must be listed as deleting nothing a hold keeps, with the reason;
 * - every statement that overwrites a holdable row's content (`UPDATE … SET <content>` or an upsert's `DO UPDATE SET
 *   <content>`) is listed the same way;
 * - every deleting Store method (prune*, delete*, purge*, clear*, remove*, evict*) is hold-checked on both stores or
 *   listed as deleting nothing a hold can name.
 *
 * A new delete or overwrite fails this test until someone decides which side it is on. The contract tests
 * (contract/legal-holds*.test.ts) prove the behaviour.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOLDABLE_TABLES } from "./legal-hold-sql.js";
import { RETENTION_TABLES } from "./retention-tables.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** What makes a function hold-checked. */
const HOLD_CHECK = /notHeldSql|heldRowSql|refuseIfHeld|legalHoldsOn|retentionWhere|deleteUnheld/;

/**
 * Helpers that delete holdable rows without checking: every function in the same file that calls one must check holds
 * (or be such a helper itself). Key `file:function`.
 */
const CALLER_CHECKED: Record<string, string> = {
  "database.ts:deleteEvalFixtureSync": "deleteEvalFixture and updateReleaseGateCases refuse first; deleteSubjectRowSync runs after deleteSubjectRow's check",
  "database.ts:deleteMcpCassetteSync": "deleteMcpCassette refuses first",
  "database.ts:deleteSubjectRowSync": "deleteSubjectRow checks the row first",
  "database.ts:deleteEvalFixturesForRecordingSync": "deleteEvalFixturesForRecording refuses first; inside deleteReplayRecordingSync and deleteSubjectRowSync after their checks",
  "database.ts:deleteReplayRecordingSync": "deleteReplayRecording refuses first; capture eviction picks unheld ones",
  "postgres/prune.ts:deleteUnlockedInBatches": "its callers pass a where that leaves held rows out"
};

/** Deletes of holdable tables that remove nothing a hold keeps. Key `file:function`. */
const NOT_HELD_DELETES: Record<string, string> = {
  "database.ts:cancelExecution": "a canceled run's paused state (workflow_executions); the run's history row stays",
  "database.ts:deleteWorkflowExecution": "a paused run's resume state, removed when the run ends; the history row stays",
  "database.ts:settleLostQueueItem": "a lost job's resume state; the history row stays",
  "database.ts:replaceMcpToolCallsForExecution": "rewrites the tool calls of the run being saved, with the same calls",
  "postgres/executions.ts:cancelExecution": "as on SQLite",
  "postgres/executions.ts:deleteWorkflowExecution": "as on SQLite",
  "postgres/mcp.ts:replaceMcpToolCallsForExecution": "as on SQLite",
  "postgres/queue.ts:settleLostJob": "as settleLostQueueItem on SQLite"
};

/** Overwrites of a holdable row's content that destroy nothing a hold keeps, or the documented limits. */
const NOT_HELD_OVERWRITES: Record<string, string> = {
  "database.ts:saveSessionArtifact": "documented limit: an artifact's value is replaced under its key (agent memory is kept whole)",
  "postgres/sessions.ts:saveSessionArtifact": "as on SQLite",
  "database.ts:recordBudgetRefusedRun": "writes the run being refused",
  "database.ts:saveQueueItemResult": "a running job's result",
  "postgres/queue.ts:saveQueueItemResult": "as on SQLite",
  "database.ts:setEvalRunSetSnapshot": "a starting eval run's own snapshot",
  "postgres/release.ts:setEvalRunSetSnapshot": "as on SQLite",
  "database.ts:updateEvalRunProgress": "a running eval run's progress",
  "postgres/eval.ts:updateEvalRunProgress": "as on SQLite",
  "database.ts:updateEvalRunSummary": "a finishing eval run's summary",
  "postgres/eval.ts:updateEvalRunSummary": "as on SQLite",
  "database.ts:createMcpGatewayApproval": "merges labels into a pending request",
  "postgres/mcp.ts:mergePendingApprovalLabels": "as on SQLite",
  "database.ts:promoteReplayCaptureSync": "promotion keeps the capture's content (it becomes a golden run)",
  "postgres/capture.ts:promoteReplayCapture": "as on SQLite",
  "postgres/replay.ts:promoteReplayCaptureToGoldenSet": "as on SQLite",
  "database.ts:markEvalRunsReleaseIneligible": "marks a run as no longer proving a release; its results stay",
  "postgres/release.ts:markEvalRunsReleaseIneligible": "as on SQLite"
};

/** Store methods whose deletes a hold stops (each proven on both stores by the contract tests). */
const HOLD_CHECKED: Record<string, string> = {
  pruneRetentionTable: "retentionWhere leaves held rows out of every batch",
  pruneExecutionHistory: "the reference purge (no production caller) keeps held rows too",
  pruneEvalRuns: "held eval runs and replay jobs are left out, per chunk",
  pruneReplayCaptures: "held captured runs are left out of every batch",
  pruneGuardSimulations: "a simulation keeps its held jobs, and stays with them",
  pruneWorkflowVersions: "nothing is pruned while a hold covers the workflow",
  deleteWorkflow: "refused (409 legal_hold) while a hold covers the workflow, its project or its runs",
  deleteProject: "refused while a hold covers the project",
  deleteEvalDataset: "refused while a hold covers the set, its cases or its runs",
  deleteEvalFixture: "refused while a hold covers the case",
  deleteReplayRecording: "refused while a hold covers the golden or captured run (eviction skips held ones)",
  deleteMcpCassette: "refused while a hold covers the cassette",
  deleteMcpServer: "held tool calls of the server stay",
  deleteEvalFixturesForRecording: "refused while a hold covers any of the cases",
  deleteSubjectRow: "a held row is left and reported (heldBy)"
};

/** Store methods that delete nothing a hold can name. */
const NOT_HOLDABLE: Record<string, string> = {
  pruneClusterInstances: "instance liveness",
  prunePendingChallenges: "sign-in challenges",
  pruneRateLimitBuckets: "rate-limit counters",
  pruneReplayCaptureReservations: "capture slots, not captured runs",
  pruneAuditLogs: "the audit log is deployment-wide and hash-chained (AUDIT_LOG_RETENTION_DAYS)",
  pruneLogStreamEvents: "log stream delivery history",
  pruneExecutionManifests: "manifests whose run is gone (a held run keeps its manifest)",
  purgeEndedSessions: "sign-in sessions",
  deleteMcpUserOAuthConnection: "OAuth connections",
  deleteMcpOAuthConnection: "OAuth connections",
  deleteMcpToolPolicy: "configuration",
  deleteMcpToolset: "configuration",
  deleteGuardProfile: "content rules configuration",
  deleteDataDestination: "configuration",
  deleteModelAllowlistEntry: "configuration",
  deleteKnowledgeBase: "knowledge bases are configuration and documents, not run data",
  deleteKnowledgeBaseChunksBySource: "knowledge base documents",
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
  deleteWorkflowExecution: "a paused run's resume state, removed when the run ends (the history row stays)",
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

const HOLDABLE = new Set<string>(HOLDABLE_TABLES);
const CONTENT_COLUMN = /^(?:\w+_json|content|output|input|payload|messages|result|value)$/;
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "await", "constructor", "super", "function"]);

interface SourceFunction {
  file: string;
  name: string;
  start: number;
  body: string;
}

interface SourceFile {
  file: string;
  lines: string[];
  functions: SourceFunction[];
}

function readSource(file: string): SourceFile {
  const lines = fs.readFileSync(path.join(here, file), "utf8").split("\n");
  const classMethod = /^ {2}(?:(?:private|public|protected|static|async|get)\s+)*([A-Za-z_]\w*)\s*(?:<[^()]*>)?\(/;
  const topFunction = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
  const starts: Array<{ name: string; start: number }> = [];
  lines.forEach((line, index) => {
    const match = topFunction.exec(line) ?? (file === "database.ts" ? classMethod.exec(line) : null);
    if (match && !KEYWORDS.has(match[1]!)) starts.push({ name: match[1]!, start: index });
  });
  const functions = starts.map((entry, index) => ({
    file,
    name: entry.name,
    start: entry.start,
    body: lines.slice(entry.start, starts[index + 1]?.start ?? lines.length).join("\n")
  }));
  return { file, lines, functions };
}

function enclosing(source: SourceFile, line: number): SourceFunction | undefined {
  let found: SourceFunction | undefined;
  for (const fn of source.functions) if (fn.start <= line) found = fn;
  return found;
}

const SOURCES: SourceFile[] = [
  readSource("database.ts"),
  ...fs
    .readdirSync(path.join(here, "postgres"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort()
    .map((name) => readSource(`postgres/${name}`))
];

const key = (fn: SourceFunction) => `${fn.file}:${fn.name}`;

/** Functions holding a `DELETE FROM` a holdable table, or a table named at run time. */
function deletingFunctions(): SourceFunction[] {
  const found = new Map<string, SourceFunction>();
  for (const source of SOURCES) {
    source.lines.forEach((line, index) => {
      for (const match of line.matchAll(/DELETE FROM (\$\{[^}]+\}|\w+)/g)) {
        const table = match[1]!;
        if (!table.startsWith("${") && !HOLDABLE.has(table)) continue;
        const fn = enclosing(source, index);
        if (fn) found.set(key(fn), fn);
      }
    });
  }
  return [...found.values()];
}

/** Functions overwriting a holdable row's content columns. */
function overwritingFunctions(): SourceFunction[] {
  const found = new Map<string, SourceFunction>();
  for (const source of SOURCES) {
    source.lines.forEach((line, index) => {
      const window = source.lines.slice(index, index + 8).join(" ");
      let table: string | undefined;
      const update = /UPDATE (\w+)\s+SET/.exec(line);
      if (update) table = update[1];
      else if (/ON CONFLICT/.test(line) && !/DO NOTHING/.test(window)) {
        table = /INSERT (?:OR \w+ )?INTO (\w+)/.exec(source.lines.slice(Math.max(0, index - 6), index + 1).join(" "))?.[1];
      }
      if (!table || !HOLDABLE.has(table)) return;
      const columns = [...window.matchAll(/(\w+)\s*=\s*(?:excluded|EXCLUDED|\?|\$\d)/g)].map((match) => match[1]!);
      if (!columns.some((column) => CONTENT_COLUMN.test(column))) return;
      const fn = enclosing(source, index);
      if (fn) found.set(key(fn), fn);
    });
  }
  return [...found.values()];
}

function callers(fn: SourceFunction): SourceFunction[] {
  const source = SOURCES.find((entry) => entry.file === fn.file)!;
  const call = new RegExp(`(?:this\\.|\\b)${fn.name}\\(`);
  return source.functions.filter((other) => other !== fn && call.test(other.body));
}

describe("legal-hold coverage of the stores' SQL", () => {
  it("every delete of a holdable table is hold-checked, done only by checked callers, or listed with a reason", () => {
    const problems: string[] = [];
    for (const fn of deletingFunctions()) {
      const id = key(fn);
      if (HOLD_CHECK.test(fn.body) || id in NOT_HELD_DELETES) continue;
      if (!(id in CALLER_CHECKED)) {
        problems.push(`${id} deletes holdable rows without a hold check: add the not-held predicate or a refusal, or list it here with a reason`);
        continue;
      }
      const unchecked = callers(fn).filter((caller) => !HOLD_CHECK.test(caller.body) && !(key(caller) in CALLER_CHECKED));
      if (callers(fn).length === 0) problems.push(`${id} is listed as caller-checked but nothing in its file calls it`);
      for (const caller of unchecked) problems.push(`${key(caller)} calls ${fn.name} without a hold check`);
    }
    expect(problems).toEqual([]);
  });

  it("every overwrite of a holdable row's content is hold-checked or listed with a reason", () => {
    const unlisted = overwritingFunctions()
      .filter((fn) => !HOLD_CHECK.test(fn.body) && !(key(fn) in NOT_HELD_OVERWRITES))
      .map(key);
    expect(unlisted).toEqual([]);
  });

  it("the lists name only functions that still exist", () => {
    const all = new Set(SOURCES.flatMap((source) => source.functions.map(key)));
    const stale = [...Object.keys(CALLER_CHECKED), ...Object.keys(NOT_HELD_DELETES), ...Object.keys(NOT_HELD_OVERWRITES)].filter((id) => !all.has(id));
    expect(stale).toEqual([]);
  });
});

describe("legal-hold coverage of the Store's deleting methods", () => {
  function storeDeletingMethods(): string[] {
    const source = fs.readFileSync(path.join(here, "store.ts"), "utf8");
    const names = new Set<string>();
    for (const match of source.matchAll(/^\s{2}((?:prune|delete|purge|clear|remove|evict)[A-Za-z]*)\(/gm)) names.add(match[1]!);
    return [...names].sort();
  }

  it("every deleting store method is hold-checked or listed as deleting nothing a hold can name", () => {
    const methods = storeDeletingMethods();
    expect(methods.length).toBeGreaterThan(40);
    const unclassified = methods.filter((name) => !(name in HOLD_CHECKED) && !(name in NOT_HOLDABLE));
    expect(unclassified, "classify these in legal-hold-coverage.test.ts").toEqual([]);
    const stale = [...Object.keys(HOLD_CHECKED), ...Object.keys(NOT_HOLDABLE)].filter((name) => !methods.includes(name));
    expect(stale, "these are no longer store methods").toEqual([]);
  });

  it("each hold-checked method carries the check on both stores (in its body, or in the helper it calls)", () => {
    const problems: string[] = [];
    const checked = (fn: SourceFunction, depth = 0): boolean => {
      if (HOLD_CHECK.test(fn.body)) return true;
      if (depth > 2) return false;
      // A Postgres helper can live in another module (imported); a SQLite one is a method of the same class.
      const pool = fn.file.startsWith("postgres/") ? SOURCES.slice(1) : SOURCES.slice(0, 1);
      return pool
        .flatMap((source) => source.functions)
        .some((other) => other !== fn && new RegExp(`(?:this\\.|\\b)${other.name}\\(`).test(fn.body) && checked(other, depth + 1));
    };
    for (const name of Object.keys(HOLD_CHECKED)) {
      const sqlite = SOURCES[0]!.functions.filter((fn) => fn.name === name);
      const pg = SOURCES.slice(1).flatMap((source) => source.functions.filter((fn) => fn.name === name));
      if (sqlite.length === 0 || !sqlite.some((fn) => checked(fn))) problems.push(`database.ts:${name}`);
      if (pg.length === 0 || !pg.some((fn) => checked(fn))) problems.push(`postgres:${name}`);
    }
    expect(problems).toEqual([]);
  });

  it("every retention table but the purge log can be held", () => {
    const retention = Object.keys(RETENTION_TABLES).filter((table) => table !== "retention_runs");
    expect(retention.filter((table) => !HOLDABLE.has(table))).toEqual([]);
  });
});
