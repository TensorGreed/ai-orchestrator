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
import { GuardNotFoundError, GuardService, GuardValidationError } from "./guard-service.js";
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

  it("pins the latest version when the override names none, with its hash", async () => {
    const { guard } = await setup();
    const resolved = guard.resolveProfileOverride({ profileId: "candidate" }, { workflowId: "wf", isAdmin: false });
    expect(resolved).toMatchObject({ ok: true, profile: { profileId: "candidate", version: 2 } });
    if (resolved.ok) expect(resolved.profile.hash).toBe(guard.loadProfile("candidate", 2)!.hash);
    expect(guard.resolveProfileOverride({ profileId: "candidate", version: 9 }, { workflowId: "wf", isAdmin: true })).toMatchObject({ ok: false, problem: expect.stringMatching(/Version 9/) });
  });

  it("refuses an older version of a bound profile to a non-admin, and lets an admin use it", async () => {
    const { guard } = await setup();
    const document = { ...(createDefaultGuardProfile() as unknown as Record<string, unknown>), name: "Bound v2" };
    guard.updateProfile("bound", { document }, null);
    // The workflow binding applies "bound" at its latest version (2).
    const refused = guard.resolveProfileOverride({ profileId: "bound", version: 1 }, { workflowId: "wf", isAdmin: false });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.problem).toMatch(/older than version 2.*workflow binding.*Only an admin/);
    expect(guard.resolveProfileOverride({ profileId: "bound", version: 1 }, { workflowId: "wf", isAdmin: true })).toMatchObject({ ok: true, profile: { version: 1 } });
    expect(guard.resolveProfileOverride({ profileId: "bound", version: 2 }, { workflowId: "wf", isAdmin: false }).ok).toBe(true);
    // The project's enforced binding counts too.
    guard.setBinding("workflow", "wf", { mode: "inherit" }, null);
    guard.setBinding("project", "default", { mode: "enforced", profileId: "bound" }, null);
    const enforced = guard.resolveProfileOverride({ profileId: "bound", version: 1 }, { workflowId: "wf", projectId: "default", isAdmin: false });
    expect(enforced.ok).toBe(false);
    if (!enforced.ok) expect(enforced.problem).toMatch(/project binding \(enforced\)/);
    // An older version of a profile nothing binds is fine.
    expect(guard.resolveProfileOverride({ profileId: "candidate", version: 1 }, { workflowId: "wf", isAdmin: false }).ok).toBe(true);
  });

  it("Phase 15.6: a simulation swaps one profile wherever the run applies it and keeps the others", async () => {
    const { guard } = await setup();
    guard.setBinding("project", "default", { mode: "enforced", profileId: "candidate" }, null);
    const document = { ...(createDefaultGuardProfile() as unknown as Record<string, unknown>), name: "Draft" };
    const inline = guard.simulationProfile("candidate", { document });
    expect(inline).toMatchObject({ profileId: "candidate", version: 0, inline: true, name: "Draft" });
    // Enforced "candidate" first, then the workflow's own "bound": the enforced one is swapped, "bound" stays.
    const resolved = guard.resolveRun({ workflowId: "wf", projectId: "default", profileSubstitute: inline });
    expect(resolved.stack.map((entry) => [entry.profileId, entry.version])).toEqual([["candidate", 0], ["bound", 1]]);
    expect(resolved.enforced).toMatchObject({ profileId: "candidate", version: 0, hash: inline.hash });
    expect(resolved.source).toBe("enforced");
    const runtime = guard.runtimeFor({ workflowId: "wf", projectId: "default", profileSubstitute: inline });
    expect((await runtime.loadProfile("candidate"))?.hash).toBe(inline.hash);
    expect((await runtime.loadProfile("bound"))?.version).toBe(1);
    // A run that never applies the profile is unchanged.
    guard.setBinding("project", "default", { mode: "inherit" }, null);
    expect(guard.resolveRun({ workflowId: "wf", projectId: "default", profileSubstitute: inline }).stack.map((entry) => entry.profileId)).toEqual(["bound"]);
    // A saved version, and the refusals.
    expect(guard.simulationProfile("candidate", { version: 1 })).toMatchObject({ version: 1, inline: false, name: "Candidate v1" });
    expect(() => guard.simulationProfile("candidate", { version: 9 })).toThrow(GuardNotFoundError);
    expect(() => guard.simulationProfile("nope", { version: 1 })).toThrow(GuardNotFoundError);
    expect(() => guard.simulationProfile("candidate", { document: { name: "" } })).toThrow(GuardValidationError);
  });
});
