import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultGuardProfile } from "@ai-orchestrator/guard-sdk";
import { SqliteStore } from "./db/database.js";
import { GuardService } from "./services/guard-service.js";
import { SecretService } from "./services/secret-service.js";

/**
 * Phase 16 — cached guard profile facts are keyed on a revision kept in the
 * database (bumped by triggers), so a profile written by another instance on
 * the same database is what the next run here resolves.
 */

const key = crypto.randomBytes(32).toString("base64");
const opened: Array<{ store: SqliteStore; dir: string }> = [];

async function instances() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-guard-rev-"));
  const file = path.join(dir, "orchestrator.db");
  const a = await SqliteStore.create(file);
  a.ensureDefaultProject();
  const b = await SqliteStore.create(file);
  opened.push({ store: a, dir }, { store: b, dir });
  const ga = new GuardService(a, new SecretService(a, key), { autoApply: true, logger: () => {} });
  const gb = new GuardService(b, new SecretService(b, key), { autoApply: true, logger: () => {} });
  ga.ensureBuiltIns();
  gb.ensureBuiltIns();
  return { a, b, ga, gb };
}

afterEach(() => {
  for (const { store, dir } of opened.splice(0)) {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function strict(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ...createDefaultGuardProfile(), id: "strict", name: "Strict", ...extra })) as Record<string, unknown>;
}

const stackOf = (service: GuardService) => service.resolveRun({ workflowId: "wf", projectId: "default" }).stack.map((entry) => `${entry.profileId}@${entry.version}`);

describe("guard profiles across instances on one database", () => {
  it("a version saved by another instance is resolved by the next run here", async () => {
    const { ga, gb } = await instances();
    gb.createProfile({ document: strict({ name: "Strict v1" }) }, null);
    gb.setBinding("workflow", "wf", { mode: "override", profileId: "strict" }, null);
    expect(stackOf(ga)).toEqual(["strict@1"]);
    gb.updateProfile("strict", { document: strict({ name: "Strict v2", labels: "propagated" }) }, null);
    expect(stackOf(ga)).toEqual(["strict@2"]);
    expect(ga.resolveRun({ workflowId: "wf", projectId: "default" }).stack[0]!.profile.labels).toBe("propagated");
  });

  it("propagated labels turned on by another instance make mayUseLabels true here", async () => {
    const { ga, gb } = await instances();
    expect(ga.mayUseLabels()).toBe(false);
    gb.createProfile({ document: strict({ labels: "propagated" }) }, null);
    expect(ga.mayUseLabels()).toBe(true);
  });

  it("a profile deleted by another instance is no longer resolved here", async () => {
    const { ga, gb } = await instances();
    gb.createProfile({ document: strict() }, null);
    expect(ga.loadProfile("strict")?.version).toBe(1);
    gb.deleteProfile("strict");
    expect(ga.loadProfile("strict")).toBeUndefined();
  });

  it("a write made outside the store (a script, an older build) moves the revision too", async () => {
    const { a, b, ga } = await instances();
    const before = a.guardProfileRevision();
    expect(ga.loadProfile("default")?.name).toBeDefined();
    (b as unknown as { db: { exec(sql: string): void } }).db.exec(`UPDATE guard_profiles SET name = 'Renamed elsewhere' WHERE id = 'default'`);
    expect(a.guardProfileRevision()).toBeGreaterThan(before);
    expect(ga.loadProfile("default")?.name).toBe("Renamed elsewhere");
  });

  it("without writes the cached answer is reused: one revision read, no profile reads", async () => {
    const { a, ga } = await instances();
    ga.resolveRun({ workflowId: "wf", projectId: "default" });
    const reads: string[] = [];
    const getVersion = a.getGuardProfileVersion.bind(a);
    a.getGuardProfileVersion = (profileId: string, version?: number) => {
      reads.push(profileId);
      return getVersion(profileId, version);
    };
    expect(stackOf(ga)).toEqual(["default@1"]);
    expect(reads).toEqual([]);
  });
});
