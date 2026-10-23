/**
 * Phase 15.3 — a replay's guard profile override: resolution replaces the
 * bindings, keeps a project's enforced floor (unless it is the same
 * profile), loads the requested version for guard ports too, and refuses
 * a profile or version that does not exist.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultGuardProfile } from "@ai-orchestrator/guard-sdk";
import { SqliteStore } from "../db/database.js";
import { GuardNotFoundError, GuardService } from "./guard-service.js";
import { SecretService } from "./secret-service.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-guard-override-"));
  dirs.push(dir);
  const store = await SqliteStore.create(path.join(dir, "db.sqlite"));
  store.ensureDefaultProject();
  const secrets = new SecretService(store, crypto.randomBytes(32).toString("base64"));
  const guard = new GuardService(store, secrets, { autoApply: true });
  guard.ensureBuiltIns();
  const document = (name: string) => ({ ...(createDefaultGuardProfile() as unknown as Record<string, unknown>), name });
  guard.createProfile({ id: "bound", document: document("Bound") }, null);
  guard.createProfile({ id: "candidate", document: document("Candidate v1") }, null);
  guard.updateProfile("candidate", { document: document("Candidate v2") }, null);
  guard.setBinding("workflow", "wf", { mode: "override", profileId: "bound" }, null);
  return { store, guard };
}

describe("guard profile override", () => {
  it("evaluates the candidate in place of the bindings, at the version asked for", async () => {
    const { guard } = await setup();
    expect(guard.resolveRun({ workflowId: "wf" }).stack.map((entry) => entry.profileId)).toEqual(["bound"]);
    const v1 = guard.resolveRun({ workflowId: "wf", profileOverride: { profileId: "candidate", version: 1 } });
    expect(v1.source).toBe("candidate");
    expect(v1.stack.map((entry) => [entry.profileId, entry.version])).toEqual([["candidate", 1]]);
    expect(v1.chain.at(-1)).toMatchObject({ level: "candidate", profileId: "candidate", version: 1 });
    const latest = guard.resolveRun({ workflowId: "wf", profileOverride: { profileId: "candidate" } });
    expect(latest.stack.map((entry) => entry.version)).toEqual([2]);
    const runtime = guard.runtimeFor({ workflowId: "wf", profileOverride: { profileId: "candidate", version: 1 } });
    expect((await runtime.loadProfile("candidate"))?.version).toBe(1);
    expect((await runtime.loadProfile("bound"))?.version).toBe(1);
  });

  it("keeps a project's enforced profile first, unless the candidate is a version of it", async () => {
    const { guard } = await setup();
    guard.setBinding("project", "default", { mode: "enforced", profileId: "bound" }, null);
    const other = guard.resolveRun({ workflowId: "wf", profileOverride: { profileId: "candidate" } });
    expect(other.stack.map((entry) => entry.profileId)).toEqual(["bound", "candidate"]);
    expect(other.enforced?.profileId).toBe("bound");
    const same = guard.resolveRun({ workflowId: "wf", profileOverride: { profileId: "bound" } });
    expect(same.stack.map((entry) => entry.profileId)).toEqual(["bound"]);
    expect(same.enforced).toBeUndefined();
  });

  it("refuses a profile or version that does not exist", async () => {
    const { guard } = await setup();
    expect(guard.profileOverrideProblem({ profileId: "candidate", version: 2 })).toBeNull();
    expect(guard.profileOverrideProblem({ profileId: "candidate", version: 9 })).toMatch(/Version 9/);
    expect(guard.profileOverrideProblem({ profileId: "nope" })).toMatch(/not found/);
    expect(() => guard.resolveRun({ workflowId: "wf", profileOverride: { profileId: "nope" } })).toThrow(GuardNotFoundError);
  });
});
