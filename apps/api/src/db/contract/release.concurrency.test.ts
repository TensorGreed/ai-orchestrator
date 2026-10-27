/**
 * Phase 13.1 — Postgres only: two stores (two pools, as two API processes would have) on one schema race on the same
 * release rows. Each decision, publish and compare-and-set must apply once.
 *
 * Workflow versions are seeded with SQL here, so the publish races run before the Postgres workflow-version methods
 * exist.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, type TestStore, openTestStoreTwin, testStorePool } from "../../test-support/test-store.js";
import { PostgresStore } from "../postgres-store.js";
import type { Store } from "../store.js";
import type { ReleaseApprovalRequestRecord, ReleaseGateRecord } from "../database.js";

const ROUNDS = 8;
const now = () => new Date().toISOString();

function release(workflowId: string, id: string, version: number) {
  return {
    id,
    workflowId,
    version,
    workflowHash: `hash-${version}`,
    replayRunId: null,
    verdict: "pass",
    reason: null,
    gateReasons: [],
    approval: null,
    publishedAt: now(),
    publishedBy: "ana",
    publishedByUserId: null
  };
}

function gate(workflowId: string, updatedBy: string, overrides: Partial<ReleaseGateRecord> = {}): ReleaseGateRecord {
  return {
    workflowId,
    enabled: true,
    enforced: false,
    datasetIds: [],
    candidateOptions: {},
    policy: {},
    requireApproval: false,
    approvers: null,
    updatedAt: now(),
    updatedBy,
    ...overrides
  };
}

function releaseRequest(id: string, workflowId: string, version: number, expiresAt: string | null = null): ReleaseApprovalRequestRecord {
  return {
    id,
    workflowId,
    workflowName: null,
    projectId: "default",
    version,
    workflowHash: `hash-${version}`,
    replayRunId: null,
    origin: "policy",
    gateReasons: [],
    gateUpdatedAt: null,
    gateChecks: null,
    gateAuthority: null,
    publishedVersionAtRequest: null,
    spec: {},
    status: "pending",
    requestReason: null,
    requestedByUserId: null,
    requestedBy: null,
    expiresAt,
    decidedByUserId: null,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    releaseId: null,
    createdAt: now(),
    updatedAt: now()
  };
}

if (!testPostgresUrl()) {
  noticePostgresSkipped("release concurrency (Postgres)");
  describe.skip("release concurrency on Postgres (TEST_POSTGRES_URL not set)", () => {
    it("races two stores on one schema", () => undefined);
  });
} else {
  describe("release concurrency on Postgres: two stores, one schema", () => {
    let first: TestStore;
    let second: PostgresStore;
    let sql: Pool;
    let a: Store;
    let b: Store;

    beforeEach(async () => {
      first = await createTestStore({ kind: "postgres" });
      second = await openTestStoreTwin(first!, { maxConnections: 4 });
      sql = testStorePool(first!);
      a = first.store;
      b = second;
    }, 60_000);

    afterEach(async () => {
      await sql.end().catch(() => undefined);
      await second.close().catch(() => undefined);
      await first.cleanup();
    }, 60_000);

    async function workflowWithVersions(id: string, versions: number): Promise<void> {
      await a.upsertWorkflow({ id, name: id, schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);
      for (let version = 1; version <= versions; version += 1) {
        await sql.query(`INSERT INTO workflow_versions (id, workflow_id, version, workflow_json, created_at) VALUES ($1, $2, $3, '{}', now())`, [`${id}-v${version}`, id, version]);
      }
    }

    it("two publishes from the same previous version: one wins, the release history has one entry", async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const wf = `wf-pub-${round}`;
        await workflowWithVersions(wf, 2);
        const results = await Promise.all([a.publishWorkflowVersion(release(wf, `${wf}-a`, 1), null), b.publishWorkflowVersion(release(wf, `${wf}-b`, 2), null)]);
        const winners = results.filter((result) => result !== null);
        expect(winners).toHaveLength(1);
        expect(await a.getPublishedVersion(wf)).toBe(winners[0]!.version);
        expect(await a.listWorkflowReleases(wf)).toHaveLength(1);
        // The loser's version was not pinned.
        const loserVersion = winners[0]!.version === 1 ? 2 : 1;
        expect(await b.isWorkflowVersionPinned(wf, loserVersion)).toBe(false);
      }
    });

    it("one request approved twice at once publishes once; the other answer is decided", async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const wf = `wf-appr-${round}`;
        await workflowWithVersions(wf, 1);
        await a.insertReleaseApprovalRequest(releaseRequest(`rr-${round}`, wf, 1));
        const decide = (who: string) => ({ id: `rr-${round}`, status: "approved" as const, decidedBy: who, releaseId: `rel-${who}` });
        const results = await Promise.all([
          a.approveReleaseRequestAndPublish(decide("ana"), release(wf, `rel-ana-${round}`, 1), null),
          b.approveReleaseRequestAndPublish(decide("bo"), release(wf, `rel-bo-${round}`, 1), null)
        ]);
        expect(results.filter((result) => "release" in result)).toHaveLength(1);
        expect(results.filter((result) => "refused" in result)).toEqual([{ refused: "decided" }]);
        expect(await a.listWorkflowReleases(wf)).toHaveLength(1);
      }
    });

    it("two requests for different versions approved at once: one publishes, the other conflicts and stays pending", async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const wf = `wf-two-${round}`;
        await workflowWithVersions(wf, 2);
        await a.insertReleaseApprovalRequest(releaseRequest(`r1-${round}`, wf, 1));
        await a.insertReleaseApprovalRequest(releaseRequest(`r2-${round}`, wf, 2));
        const results = await Promise.all([
          a.approveReleaseRequestAndPublish({ id: `r1-${round}`, status: "approved" }, release(wf, `rel1-${round}`, 1), null),
          b.approveReleaseRequestAndPublish({ id: `r2-${round}`, status: "approved" }, release(wf, `rel2-${round}`, 2), null)
        ]);
        expect(results.filter((result) => "release" in result)).toHaveLength(1);
        expect(results.filter((result) => "refused" in result)).toEqual([{ refused: "conflict" }]);
        const statuses = [(await a.getReleaseApprovalRequest(`r1-${round}`))!.status, (await a.getReleaseApprovalRequest(`r2-${round}`))!.status].sort();
        expect(statuses).toEqual(["approved", "pending"]);
      }
    });

    it("a release request and a gate case request are each decided once", async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        await a.insertReleaseApprovalRequest(releaseRequest(`d-${round}`, "wf-d", 1));
        const release = await Promise.all([
          a.decideReleaseApprovalRequest({ id: `d-${round}`, status: "approved", decidedBy: "ana" }),
          b.decideReleaseApprovalRequest({ id: `d-${round}`, status: "rejected", decidedBy: "bo" })
        ]);
        expect(release.sort()).toEqual([false, true]);
        const record = (await a.getReleaseApprovalRequest(`d-${round}`))!;
        expect(record.decidedBy).toBe(record.status === "approved" ? "ana" : "bo");

        const caseRequest = {
          id: `gc-${round}`, workflowId: "wf-d", workflowName: null, projectId: "default", action: "admit" as const, fixtures: [], spec: {}, gateAuthority: null,
          status: "pending", requestReason: null, requestedByUserId: null, requestedBy: null, expiresAt: null, decidedByUserId: null, decidedBy: null,
          decidedAt: null, decisionReason: null, createdAt: now(), updatedAt: now()
        };
        await a.insertGateCaseRequest(caseRequest);
        const cases = await Promise.all([
          a.updateReleaseGateCases({ workflowId: "wf-d", decideRequest: { id: `gc-${round}`, status: "approved" }, updatedAt: now(), updatedBy: "ana" }),
          b.updateReleaseGateCases({ workflowId: "wf-d", decideRequest: { id: `gc-${round}`, status: "rejected" }, updatedAt: now(), updatedBy: "bo" })
        ]);
        expect(cases.sort()).toEqual(["decided", "ok"]);
      }
    });

    it("two gate case changes from the same admitted cases: one applies, the other answers changed", async () => {
      await a.upsertReleaseGate(gate("wf-adm", "ana", { enforced: true }));
      await a.setReleaseGateAdmission("wf-adm", ["fx-0"], now(), "ana");
      for (let round = 0; round < ROUNDS; round += 1) {
        const current = (await a.getReleaseGate("wf-adm"))!.admittedFixtureIds!;
        const results = await Promise.all([
          a.updateReleaseGateCases({ workflowId: "wf-adm", expectedAdmittedFixtureIds: current, admittedFixtureIds: [...current, `a-${round}`], updatedAt: now(), updatedBy: "ana" }),
          b.updateReleaseGateCases({ workflowId: "wf-adm", expectedAdmittedFixtureIds: current, admittedFixtureIds: [...current, `b-${round}`], updatedAt: now(), updatedBy: "bo" })
        ]);
        expect(results.sort()).toEqual(["changed", "ok"]);
        expect((await a.getReleaseGate("wf-adm"))!.admittedFixtureIds).toHaveLength(current.length + 1);
      }
    });

    it("two editors creating, then two editing, a release gate from the same starting point: one save each time", async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const wf = `wf-gate-${round}`;
        const created = await Promise.all([
          a.saveReleaseGate({ gate: gate(wf, "ana"), expected: null, updatedAt: now(), updatedBy: "ana" }),
          b.saveReleaseGate({ gate: gate(wf, "bo"), expected: null, updatedAt: now(), updatedBy: "bo" })
        ]);
        expect(created.filter((result) => result === null)).toHaveLength(1);
        const kept = created.find((result) => result !== null)!;
        const stored = (await a.getReleaseGate(wf))!;
        expect(stored.updatedBy).toBe(kept.updatedBy);

        const edited = await Promise.all([
          a.saveReleaseGate({ gate: gate(wf, "cy", { enforced: true }), admittedFixtureIds: ["cy"], expected: stored, updatedAt: now(), updatedBy: "cy" }),
          b.saveReleaseGate({ gate: gate(wf, "di", { enforced: true }), admittedFixtureIds: ["di"], expected: stored, updatedAt: now(), updatedBy: "di" })
        ]);
        expect(edited.filter((result) => result === null)).toHaveLength(1);
        const winner = edited.find((result) => result !== null)!;
        const after = (await b.getReleaseGate(wf))!;
        expect(after.updatedBy).toBe(winner.updatedBy);
        // The admission saved with the gate is the winner's, never the loser's.
        expect(after.admittedFixtureIds).toEqual([winner.updatedBy]);
      }
    });

    it("two sweeps time out each expired request once between them", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      for (let index = 0; index < 20; index += 1) {
        await a.insertReleaseApprovalRequest(releaseRequest(`exp-${index}`, "wf-exp", 1, past));
      }
      const [left, right] = await Promise.all([a.timeOutExpiredReleaseApprovalRequests(now()), b.timeOutExpiredReleaseApprovalRequests(now())]);
      const ids = [...left, ...right].map((request) => request.id).sort();
      expect(ids).toEqual(Array.from({ length: 20 }, (_, index) => `exp-${index}`).sort());
    });

    it("a sweep skips a request whose row another transaction holds, without waiting; the next sweep closes it", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      for (let index = 0; index < 5; index += 1) await a.insertReleaseApprovalRequest(releaseRequest(`held-${index}`, "wf-held", 1, past));
      const holder = await sql.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(`SELECT id FROM release_approval_requests WHERE id = 'held-0' FOR UPDATE`);
        const swept = await b.timeOutExpiredReleaseApprovalRequests(now());
        expect(swept.map((request) => request.id).sort()).toEqual(["held-1", "held-2", "held-3", "held-4"]);
        await holder.query("ROLLBACK");
      } finally {
        holder.release();
      }
      expect((await a.timeOutExpiredReleaseApprovalRequests(now())).map((request) => request.id)).toEqual(["held-0"]);
    });

    it("two markers with different reasons on one run keep both reasons", async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        await sql.query(
          `INSERT INTO eval_runs (id, dataset_id, workflow_id, status, started_at, created_at, kind, candidate_json) VALUES ($1, 'set', 'wf', 'completed', now(), now(), 'replay', '{}')`,
          [`run-${round}`]
        );
        const results = await Promise.all([a.markEvalRunsReleaseIneligible([`run-${round}`], "reason-a"), b.markEvalRunsReleaseIneligible([`run-${round}`], "reason-b")]);
        expect(results).toEqual([[`run-${round}`], [`run-${round}`]]);
        const row = (await sql.query(`SELECT candidate_json FROM eval_runs WHERE id = $1`, [`run-${round}`])).rows[0] as { candidate_json: string };
        const candidate = JSON.parse(row.candidate_json) as { releaseEligible: boolean; releaseIneligibleReasons: string[] };
        expect(candidate.releaseEligible).toBe(false);
        expect([...candidate.releaseIneligibleReasons].sort()).toEqual(["reason-a", "reason-b"]);
      }
    });
  });
}
