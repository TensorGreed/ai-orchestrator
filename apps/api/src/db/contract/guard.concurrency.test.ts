/**
 * Phase 13.1 — Postgres only: two PostgresStore instances (two pools, as two API processes would have) on one database.
 * Version numbers are taken atomically, the guard profile cache follows the database revision written by the other
 * instance, one running simulation is enforced by the database, the vault keeps the first token for a value, and the
 * data-subject cursor never skips rows created in the same instant.
 */
import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultGuardProfile } from "@ai-orchestrator/guard-sdk";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, type TestStore, openTestStoreTwin, testStorePool } from "../../test-support/test-store.js";
import { PostgresStore } from "../postgres-store.js";
import { isOneRunningSimulationViolation } from "../store-errors.js";
import { GuardService } from "../../services/guard-service.js";
import { SecretService } from "../../services/secret-service.js";

const postgres = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("guard concurrency on Postgres");

const key = crypto.randomBytes(32).toString("base64");
let primary: TestStore | undefined;
let second: PostgresStore | undefined;

async function twoStores() {
  primary = await createTestStore({ kind: "postgres" });
  second = await openTestStoreTwin(primary!, { maxConnections: 4 });
  return { a: primary.store, b: second, test: primary };
}

afterEach(async () => {
  await second?.close().catch(() => undefined);
  second = undefined;
  await primary?.cleanup();
  primary = undefined;
});

function strict(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ...createDefaultGuardProfile(), id: "strict", name: "Strict", ...extra })) as Record<string, unknown>;
}

postgres("guard on two Postgres stores sharing one database", () => {
  it("concurrent saves of one profile from both stores take consecutive version numbers", async () => {
    const { a, b } = await twoStores();
    await a.insertGuardProfile({ id: "p", name: "P", document: {}, hash: "h1", createdBy: null });
    const save = (store: typeof a, index: number) =>
      store.addGuardProfileVersion({ profileId: "p", name: "P", document: { index }, hash: `h-${index}`, createdBy: null });
    const saved = await Promise.all(Array.from({ length: 16 }, (_, index) => save(index % 2 === 0 ? a : b, index)));
    expect(saved.map((v) => v.version).sort((x, y) => x - y)).toEqual(Array.from({ length: 16 }, (_, index) => index + 2));
    expect((await b.getGuardProfile("p"))?.latestVersion).toBe(17);
    const versions = await a.listGuardProfileVersions("p");
    expect(versions.map((v) => v.version)).toEqual(Array.from({ length: 17 }, (_, index) => 17 - index));
    // Each saved record is the row it wrote.
    for (const record of saved) expect(versions.find((v) => v.version === record.version)?.hash).toBe(record.hash);
  }, 60_000);

  it("two instances booting at once both seed the built-in profile without a duplicate-key failure, and update it once", async () => {
    for (let round = 0; round < 5; round += 1) {
      const { a, b } = await twoStores();
      const boot = (store: typeof a) => new GuardService(store, new SecretService(store, key), { logger: () => {} }).ensureBuiltIns();
      await Promise.all([boot(a), boot(b), boot(a), boot(b)]);
      const builtIn = await a.getGuardProfile("default");
      expect(builtIn).toMatchObject({ builtIn: true, latestVersion: 1 });
      // A newer shipped profile (an upgrade): both instances notice at once and one version is added.
      const v1 = await a.getGuardProfileVersion("default", 1);
      await Promise.all(
        [a, b, a, b].map((store) =>
          store.addGuardProfileVersion({ profileId: "default", name: "Default", document: { upgraded: true }, hash: `${v1!.hash}-next`, createdBy: null }, { unlessLatestHash: true })
        )
      );
      expect((await b.getGuardProfile("default"))?.latestVersion).toBe(2);
      // Plain inserts still refuse a taken id.
      await expect(a.insertGuardProfile({ id: "default", name: "Again", document: {}, hash: "x", createdBy: null })).rejects.toThrow();
      await second?.close();
      second = undefined;
      await primary?.cleanup();
      primary = undefined;
    }
  }, 120_000);

  it("the profile cache of one instance sees versions, labels and deletes written through the other", async () => {
    const { a, b } = await twoStores();
    await a.ensureDefaultProject();
    const ga = new GuardService(a, new SecretService(a, key), { autoApply: true, logger: () => {} });
    const gb = new GuardService(b, new SecretService(b, key), { autoApply: true, logger: () => {} });
    await ga.ensureBuiltIns();
    await gb.ensureBuiltIns();
    expect((await a.listGuardProfiles()).map((p) => p.id)).toEqual(["default"]);
    const stack = async () => (await ga.resolveRun({ workflowId: "wf", projectId: "default" })).stack.map((entry) => `${entry.profileId}@${entry.version}`);

    expect(await ga.mayUseLabels()).toBe(false);
    await gb.createProfile({ document: strict({ name: "Strict v1" }) }, null);
    await gb.setBinding("workflow", "wf", { mode: "override", profileId: "strict" }, null);
    expect(await stack()).toEqual(["strict@1"]);
    expect((await ga.loadProfile("strict"))?.name).toBe("Strict v1");

    const before = (await a.guardProfileRevision())!;
    await gb.updateProfile("strict", { document: strict({ name: "Strict v2", labels: "propagated" }) }, null);
    expect(await a.guardProfileRevision()).toBeGreaterThan(before);
    expect(await stack()).toEqual(["strict@2"]);
    expect((await ga.loadProfile("strict"))?.name).toBe("Strict v2");
    expect(await ga.mayUseLabels()).toBe(true);

    await gb.setBinding("workflow", "wf", { mode: "inherit" }, null);
    await gb.deleteProfile("strict");
    expect(await ga.loadProfile("strict")).toBeUndefined();
    expect(await ga.mayUseLabels()).toBe(false);
  }, 60_000);

  it("a write made with plain SQL on another connection moves the revision and is seen", async () => {
    const { a, test } = await twoStores();
    await a.insertGuardProfile({ id: "p", name: "Before", document: {}, hash: "h1", createdBy: null });
    const before = (await a.guardProfileRevision())!;
    const pool = testStorePool(test);
    try {
      await pool.query(`UPDATE guard_profiles SET name = 'After' WHERE id = 'p'`);
    } finally {
      await pool.end();
    }
    expect(await a.guardProfileRevision()).toBe(before + 1);
    expect((await a.getGuardProfile("p"))?.name).toBe("After");
  }, 60_000);

  it("two stores starting a simulation at once: one is running, the other is refused by the index", async () => {
    const { a, b } = await twoStores();
    const sim = (id: string) => ({
      id, profileId: "p", sourceKind: "inline" as const, sourceVersion: null, simulatedHash: "h", baseVersion: null, jobIds: [], detail: null,
      status: "running", createdAt: new Date().toISOString(), createdBy: null, createdByUserId: null
    });
    for (let round = 0; round < 5; round += 1) {
      const outcomes = await Promise.allSettled([a.insertGuardSimulation(sim(`a-${round}`)), b.insertGuardSimulation(sim(`b-${round}`))]);
      const won = outcomes.filter((o) => o.status === "fulfilled");
      const lost = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(isOneRunningSimulationViolation(lost[0]!.reason)).toBe(true);
      const running = await a.listRunningGuardSimulations();
      expect(running).toHaveLength(1);
      expect(await b.updateGuardSimulation({ id: running[0]!.id, status: "completed", onlyFrom: ["running"] })).toBe(true);
    }
  }, 60_000);

  it("the vault keeps one token per value when both stores insert it at once", async () => {
    const { a, b } = await twoStores();
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? a : b).putGuardVault({ token: `tok-${index}`, dataClass: "email", valueHash: "same", valueSealed: `s-${index}`, createdAt: new Date().toISOString() })
      )
    );
    const kept = await b.getGuardVaultByHash("same");
    expect(kept).not.toBeNull();
    const tokens = await Promise.all(Array.from({ length: 10 }, (_, index) => a.getGuardVaultByToken(`tok-${index}`)));
    expect(tokens.filter(Boolean).map((row) => row!.token)).toEqual([kept!.token]);
  }, 60_000);

  it("data-subject paging returns every row once when many rows share one creation instant across page ends", async () => {
    const { a, test } = await twoStores();
    for (let index = 0; index < 25; index += 1) {
      await a.saveExecutionHistory({ id: `run-${String(index).padStart(2, "0")}`, workflowId: "wf", status: "success", startedAt: new Date().toISOString(), triggerType: "eval" });
    }
    const pool = testStorePool(test);
    try {
      // Rows 5..19 created in the same microsecond, so one group straddles both page boundaries of size 7.
      await pool.query(`UPDATE execution_history SET created_at = '2026-10-01T00:00:00.123456Z' WHERE id BETWEEN 'run-05' AND 'run-19'`);
      await pool.query(`UPDATE execution_history SET created_at = NULL WHERE id = 'run-24'`);
    } finally {
      await pool.end();
    }
    const seen: string[] = [];
    let after = 0;
    for (;;) {
      const page = await a.subjectTextPage("execution", after, 7);
      seen.push(...page.rows.map((row) => row.id));
      if (page.lastRowid === null || page.rows.length < 7) break;
      expect(page.lastRowid).toBeGreaterThan(after);
      after = page.lastRowid;
    }
    expect([...seen].sort()).toEqual(Array.from({ length: 25 }, (_, index) => `run-${String(index).padStart(2, "0")}`));
    expect(new Set(seen).size).toBe(25);
    expect(await a.countSubjectRows("execution")).toBe(25);
  }, 60_000);
});
