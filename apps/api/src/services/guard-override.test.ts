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
import type { Store } from "../db/store.js";
import { openTestStore } from "../test-support/test-store.js";
import { GuardNotFoundError, GuardService, GuardValidationError } from "./guard-service.js";
import { SecretService } from "./secret-service.js";
import { GuardSimulationSink, GuardSimulationVault } from "./guard-simulation-sink.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-guard-override-"));
  dirs.push(dir);
  const store = await openTestStore(path.join(dir, "db.sqlite"));
  await store.ensureDefaultProject();
  const secrets = new SecretService(store, crypto.randomBytes(32).toString("base64"));
  const guard = new GuardService(store, secrets, { autoApply: true });
  await guard.ensureBuiltIns();
  const document = (name: string) => ({ ...(createDefaultGuardProfile() as unknown as Record<string, unknown>), name });
  await guard.createProfile({ id: "bound", document: document("Bound") }, null);
  await guard.createProfile({ id: "candidate", document: document("Candidate v1") }, null);
  await guard.updateProfile("candidate", { document: document("Candidate v2") }, null);
  await guard.setBinding("workflow", "wf", { mode: "override", profileId: "bound" }, null);
  return { store, guard };
}

describe("guard profile override", () => {
  it("evaluates the candidate in place of the bindings, at the version asked for", async () => {
    const { guard } = await setup();
    expect((await guard.resolveRun({ workflowId: "wf" })).stack.map((entry) => entry.profileId)).toEqual(["bound"]);
    const v1 = await guard.resolveRun({ workflowId: "wf", profileOverride: { profileId: "candidate", version: 1 } });
    expect(v1.source).toBe("candidate");
    expect(v1.stack.map((entry) => [entry.profileId, entry.version])).toEqual([["candidate", 1]]);
    expect(v1.chain.at(-1)).toMatchObject({ level: "candidate", profileId: "candidate", version: 1 });
    const latest = await guard.resolveRun({ workflowId: "wf", profileOverride: { profileId: "candidate" } });
    expect(latest.stack.map((entry) => entry.version)).toEqual([2]);
    const runtime = guard.runtimeFor({ workflowId: "wf", profileOverride: { profileId: "candidate", version: 1 } });
    expect((await runtime.loadProfile("candidate"))?.version).toBe(1);
    expect((await runtime.loadProfile("bound"))?.version).toBe(1);
  });

  it("keeps a project's enforced profile first, unless the candidate is a version of it", async () => {
    const { guard } = await setup();
    await guard.setBinding("project", "default", { mode: "enforced", profileId: "bound" }, null);
    const other = await guard.resolveRun({ workflowId: "wf", profileOverride: { profileId: "candidate" } });
    expect(other.stack.map((entry) => entry.profileId)).toEqual(["bound", "candidate"]);
    expect(other.enforced?.profileId).toBe("bound");
    const same = await guard.resolveRun({ workflowId: "wf", profileOverride: { profileId: "bound" } });
    expect(same.stack.map((entry) => entry.profileId)).toEqual(["bound"]);
    expect(same.enforced).toBeUndefined();
  });

  it("refuses a profile or version that does not exist", async () => {
    const { guard } = await setup();
    expect(await guard.profileOverrideProblem({ profileId: "candidate", version: 2 })).toBeNull();
    expect(await guard.profileOverrideProblem({ profileId: "candidate", version: 9 })).toMatch(/Version 9/);
    expect(await guard.profileOverrideProblem({ profileId: "nope" })).toMatch(/not found/);
    await expect(guard.resolveRun({ workflowId: "wf", profileOverride: { profileId: "nope" } })).rejects.toThrow(GuardNotFoundError);
  });

  it("pins the latest version when the override names none, with its hash", async () => {
    const { guard } = await setup();
    const resolved = await guard.resolveProfileOverride({ profileId: "candidate" }, { workflowId: "wf", isAdmin: false });
    expect(resolved).toMatchObject({ ok: true, profile: { profileId: "candidate", version: 2 } });
    if (resolved.ok) expect(resolved.profile.hash).toBe((await guard.loadProfile("candidate", 2))!.hash);
    expect(await guard.resolveProfileOverride({ profileId: "candidate", version: 9 }, { workflowId: "wf", isAdmin: true })).toMatchObject({ ok: false, problem: expect.stringMatching(/Version 9/) });
  });

  it("refuses an older version of a bound profile to a non-admin, and lets an admin use it", async () => {
    const { guard } = await setup();
    const document = { ...(createDefaultGuardProfile() as unknown as Record<string, unknown>), name: "Bound v2" };
    await guard.updateProfile("bound", { document }, null);
    // The workflow binding applies "bound" at its latest version (2).
    const refused = await guard.resolveProfileOverride({ profileId: "bound", version: 1 }, { workflowId: "wf", isAdmin: false });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.problem).toMatch(/older than version 2.*workflow binding.*Only an admin/);
    expect(await guard.resolveProfileOverride({ profileId: "bound", version: 1 }, { workflowId: "wf", isAdmin: true })).toMatchObject({ ok: true, profile: { version: 1 } });
    expect((await guard.resolveProfileOverride({ profileId: "bound", version: 2 }, { workflowId: "wf", isAdmin: false })).ok).toBe(true);
    // The project's enforced binding counts too.
    await guard.setBinding("workflow", "wf", { mode: "inherit" }, null);
    await guard.setBinding("project", "default", { mode: "enforced", profileId: "bound" }, null);
    const enforced = await guard.resolveProfileOverride({ profileId: "bound", version: 1 }, { workflowId: "wf", projectId: "default", isAdmin: false });
    expect(enforced.ok).toBe(false);
    if (!enforced.ok) expect(enforced.problem).toMatch(/project binding \(enforced\)/);
    // An older version of a profile nothing binds is fine.
    expect((await guard.resolveProfileOverride({ profileId: "candidate", version: 1 }, { workflowId: "wf", isAdmin: false })).ok).toBe(true);
  });

  it("Phase 15.6: a simulation swaps one profile wherever the run applies it and keeps the others", async () => {
    const { guard } = await setup();
    await guard.setBinding("project", "default", { mode: "enforced", profileId: "candidate" }, null);
    const document = { ...(createDefaultGuardProfile() as unknown as Record<string, unknown>), name: "Draft" };
    const inline = await guard.simulationProfile("candidate", { document });
    expect(inline).toMatchObject({ profileId: "candidate", version: 0, inline: true, name: "Draft" });
    // Enforced "candidate" first, then the workflow's own "bound": the enforced one is swapped, "bound" stays.
    const resolved = await guard.resolveRun({ workflowId: "wf", projectId: "default", profileSubstitute: inline });
    expect(resolved.stack.map((entry) => [entry.profileId, entry.version])).toEqual([["candidate", 0], ["bound", 1]]);
    expect(resolved.enforced).toMatchObject({ profileId: "candidate", version: 0, hash: inline.hash });
    expect(resolved.source).toBe("enforced");
    const runtime = guard.runtimeFor({ workflowId: "wf", projectId: "default", profileSubstitute: inline });
    expect((await runtime.loadProfile("candidate"))?.hash).toBe(inline.hash);
    expect((await runtime.loadProfile("bound"))?.version).toBe(1);
    // A run that never applies the profile is unchanged.
    await guard.setBinding("project", "default", { mode: "inherit" }, null);
    expect((await guard.resolveRun({ workflowId: "wf", projectId: "default", profileSubstitute: inline })).stack.map((entry) => entry.profileId)).toEqual(["bound"]);
    // A saved version, and the refusals.
    expect(await guard.simulationProfile("candidate", { version: 1 })).toMatchObject({ version: 1, inline: false, name: "Candidate v1" });
    await expect(guard.simulationProfile("candidate", { version: 9 })).rejects.toThrow(GuardNotFoundError);
    await expect(guard.simulationProfile("nope", { version: 1 })).rejects.toThrow(GuardNotFoundError);
    await expect(guard.simulationProfile("candidate", { document: { name: "" } })).rejects.toThrow(GuardValidationError);
  });

  it("Phase 15.6: a simulated run's verdicts go to its sink and its tokens to its vault, never to the live tables", async () => {
    const { guard, store } = await setup();
    const sink = new GuardSimulationSink();
    const vault = new GuardSimulationVault(guard.vault);
    const runtime = guard.runtimeFor({ executionId: "exec-sim", workflowId: "wf", projectId: "default", simulation: { sink, vault } });
    expect(runtime.vault).toBe(vault);
    await runtime.onVerdict!({
      executionId: "exec-sim",
      workflowId: "wf",
      nodeId: "guard",
      placement: "node",
      channel: "prompt",
      profile: { profileId: "bound", version: 1, hash: "h" },
      verdict: { action: "allow", actions: [], findings: [], timings: { totalMs: 1 }, budget: { exceeded: false, skippedDetectors: [] } },
      check: { id: "c1", index: 0, action: "allow" }
    } as never);
    expect(sink.checks).toHaveLength(1);
    expect(await store.listGuardEventsForExecution("exec-sim")).toHaveLength(0);
    await runtime.vault!.put({ token: "tok_1", dataClass: "email", value: "a@b.c", createdAt: new Date().toISOString() });
    expect(await store.getGuardVaultByToken("tok_1")).toBeFalsy();
    expect(vault.size).toBe(1);
  });
});
