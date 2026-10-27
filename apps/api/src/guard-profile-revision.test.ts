import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultGuardProfile } from "@ai-orchestrator/guard-sdk";
import type { Store } from "./db/store.js";
import { SqliteStore } from "./db/database.js";
import { openTestStore, testStoreKind } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { GuardService } from "./services/guard-service.js";
import { SecretService } from "./services/secret-service.js";

/**
 * Phase 16 — cached guard profile facts are keyed on a revision kept in the
 * database (bumped by triggers), so a profile written by another instance on
 * the same database is what the next run here resolves.
 */

const key = crypto.randomBytes(32).toString("base64");
const opened: Array<{ store: Store; dir: string }> = [];

async function instances() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-guard-rev-"));
  const file = path.join(dir, "orchestrator.db");
  const a = await openTestStore(file);
  await a.ensureDefaultProject();
  const b = await openTestStore(file);
  opened.push({ store: a, dir }, { store: b, dir });
  const ga = new GuardService(a, new SecretService(a, key), { autoApply: true, logger: () => {} });
  const gb = new GuardService(b, new SecretService(b, key), { autoApply: true, logger: () => {} });
  await ga.ensureBuiltIns();
  await gb.ensureBuiltIns();
  return { a, b, ga, gb };
}

afterEach(async () => {
  for (const { store, dir } of opened.splice(0)) {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function strict(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ...createDefaultGuardProfile(), id: "strict", name: "Strict", ...extra })) as Record<string, unknown>;
}

const stackOf = async (service: GuardService) => (await service.resolveRun({ workflowId: "wf", projectId: "default" })).stack.map((entry) => `${entry.profileId}@${entry.version}`);

describe("guard profiles across instances on one database", () => {
  it("a version saved by another instance is resolved by the next run here", async () => {
    const { ga, gb } = await instances();
    await gb.createProfile({ document: strict({ name: "Strict v1" }) }, null);
    await gb.setBinding("workflow", "wf", { mode: "override", profileId: "strict" }, null);
    expect(await stackOf(ga)).toEqual(["strict@1"]);
    await gb.updateProfile("strict", { document: strict({ name: "Strict v2", labels: "propagated" }) }, null);
    expect(await stackOf(ga)).toEqual(["strict@2"]);
    expect((await ga.resolveRun({ workflowId: "wf", projectId: "default" })).stack[0]!.profile.labels).toBe("propagated");
  });

  it("propagated labels turned on by another instance make mayUseLabels true here", async () => {
    const { ga, gb } = await instances();
    expect(await ga.mayUseLabels()).toBe(false);
    await gb.createProfile({ document: strict({ labels: "propagated" }) }, null);
    expect(await ga.mayUseLabels()).toBe(true);
  });

  it("mayUseLabels fails open: a store error answers true (resolve fully) and is logged, never thrown", async () => {
    const { a } = await instances();
    const logged: Array<{ message: string; metadata?: Record<string, unknown> }> = [];
    const failing = new Proxy(a, {
      get(target, property, receiver) {
        if (property === "anyGuardProfileUsesLabels") {
          return async () => {
            throw new Error("unsupported Unicode escape sequence");
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const service = new GuardService(failing, new SecretService(a, key), { autoApply: true, logger: (message, metadata) => logged.push({ message, metadata }) });
    expect(await service.mayUseLabels()).toBe(true);
    expect(logged).toEqual([{ message: expect.stringContaining("labels check failed"), metadata: { error: "unsupported Unicode escape sequence" } }]);
  });

  it("a profile deleted by another instance is no longer resolved here", async () => {
    const { ga, gb } = await instances();
    await gb.createProfile({ document: strict() }, null);
    expect((await ga.loadProfile("strict"))?.version).toBe(1);
    await gb.deleteProfile("strict");
    expect(await ga.loadProfile("strict")).toBeUndefined();
  });

  it("a write made outside the store (a script, an older build) moves the revision too", async () => {
    const { a, b, ga } = await instances();
    const before = (await a.guardProfileRevision())!;
    expect((await ga.loadProfile("default"))?.name).toBeDefined();
    await testSql(b).run(`UPDATE guard_profiles SET name = 'Renamed elsewhere' WHERE id = 'default'`);
    expect(await a.guardProfileRevision()).toBeGreaterThan(before);
    expect((await ga.loadProfile("default"))?.name).toBe("Renamed elsewhere");
  });

  it("without writes the cached answer is reused: one revision read, no profile reads", async () => {
    const { a, ga } = await instances();
    await ga.resolveRun({ workflowId: "wf", projectId: "default" });
    const reads: string[] = [];
    const getVersion = a.getGuardProfileVersion.bind(a);
    a.getGuardProfileVersion = async (profileId: string, version?: number) => {
      reads.push(profileId);
      return await getVersion(profileId, version);
    };
    expect(await stackOf(ga)).toEqual(["default@1"]);
    expect(reads).toEqual([]);
  });

  // SQLite-specific: a synchronous better-sqlite3 transaction() callback; Postgres has no such call shape.
  it.skipIf(testStoreKind() !== "sqlite")("a revision read inside an open SQLite transaction is no revision, so nothing read there is cached", async () => {
    const { a, b, ga, gb } = await instances();
    await gb.createProfile({ document: strict({ name: "S1" }) }, null);
    const before = (await a.guardProfileRevision())!;
    expect((await ga.loadProfile("strict"))?.name).toBe("S1");
    // Store methods run their SQLite body when called, so this read happens inside the transaction.
    let inside: Promise<number | undefined> | undefined;
    try {
      (a as SqliteStore).transaction(() => {
        inside = a.guardProfileRevision();
        throw new Error("rollback");
      });
    } catch {
      /* expected */
    }
    expect(await inside).toBeUndefined();
    expect(await a.guardProfileRevision()).toBe(before);
    await gb.updateProfile("strict", { document: strict({ name: "S2 committed" }) }, null);
    expect(await b.guardProfileRevision()).toBe(before + 2);
    expect((await ga.loadProfile("strict"))?.name).toBe("S2 committed");
    expect(await ga.mayUseLabels()).toBe(false);
  });

  it("a missing revision row reads as no revision, so nothing is cached and changes are still seen", async () => {
    const { a, b, ga, gb } = await instances();
    await testSql(b).run(`DELETE FROM guard_profile_revision`);
    expect(await a.guardProfileRevision()).toBeUndefined();
    await gb.createProfile({ document: strict() }, null);
    await gb.setBinding("workflow", "wf", { mode: "override", profileId: "strict" }, null);
    expect(await stackOf(ga)).toEqual(["strict@1"]);
    await gb.updateProfile("strict", { document: strict({ name: "v2", labels: "propagated" }) }, null);
    expect(await stackOf(ga)).toEqual(["strict@2"]);
    expect(await ga.mayUseLabels()).toBe(true);
  });
});
