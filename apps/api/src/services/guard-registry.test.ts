/**
 * The deployment's one detector registry reaches every check: workflow runs and their sub-workflows, gateway calls
 * (and the AI gateway, which checks through the gateway runtime), simulations, and rule set validation; without a
 * configured recognizer the verdicts are the same as the engine's own default registry.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENTITIES_DETECTOR_ID, type GuardEntityRecognizer } from "@ai-orchestrator/guard-sdk";
import { runGuardCheck, type GuardRuntimeDependencies } from "@ai-orchestrator/workflow-engine";
import type { Store } from "../db/store.js";
import { openTestStore } from "../test-support/test-store.js";
import { createDeploymentGuardRegistry } from "./guard-registry.js";
import { GuardService, GuardValidationError } from "./guard-service.js";
import { SecretService } from "./secret-service.js";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  while (stores.length > 0) await stores.pop()!.close().catch(() => undefined);
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const placesRecognizer: GuardEntityRecognizer = {
  id: "test-model",
  version: "7",
  classes: ["location"],
  languages: "any",
  recognize: async (texts) => texts.map((text) => (text.includes("Oslo") ? [{ start: text.indexOf("Oslo"), end: text.indexOf("Oslo") + 4, dataClass: "location", score: 0.99, source: "test-model" }] : []))
};

async function setup(options: { recognizer?: GuardEntityRecognizer } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-guard-registry-"));
  dirs.push(dir);
  const store = await openTestStore(path.join(dir, "db.sqlite"));
  stores.push(store);
  await store.ensureDefaultProject();
  const secrets = new SecretService(store, crypto.randomBytes(32).toString("base64"));
  const detectors = createDeploymentGuardRegistry(options.recognizer ? { entityRecognizer: options.recognizer } : {});
  const guard = new GuardService(store, secrets, { autoApply: true, detectors });
  await guard.ensureBuiltIns();
  await guard.createProfile(
    {
      id: "places",
      document: {
        id: "places",
        name: "Places",
        version: "1",
        channels: {
          prompt: {
            detectors: [{ id: "dlp.patterns", threshold: 0.6 }, { id: ENTITIES_DETECTOR_ID, threshold: 0.5, options: { classes: ["location"] } }],
            actions: { location: { action: "redact" }, email: { action: "redact" } },
            defaultAction: { action: "allow" }
          }
        }
      }
    },
    null
  );
  await guard.setBinding("workflow", "wf", { mode: "override", profileId: "places" }, null);
  return { store, guard, detectors };
}

async function check(runtime: GuardRuntimeDependencies, content: string) {
  const resolution = await runtime.resolveRun();
  return await runGuardCheck(
    { guard: runtime, resolveSecret: async () => undefined, executionId: "", workflowId: "wf", nodeId: "n", placement: "node" },
    resolution.stack,
    { content, channel: "prompt" }
  );
}

describe("deployment guard registry", () => {
  it("is handed to runs, sub-workflows in other projects and gateway calls", async () => {
    const { guard, detectors } = await setup();
    const runtime = guard.runtimeFor({ workflowId: "wf", projectId: "default" });
    expect(runtime.registry).toBe(detectors.registry);
    expect(runtime.forWorkflow?.({ id: "child", projectId: "other" }).registry).toBe(detectors.registry);
    const gateway = guard.gatewayRuntime({ executionId: "mcpgw_1", toolsetId: "ts", clientId: "c", projectId: null }, { source: "none", stack: [], chain: [] });
    expect(gateway.registry).toBe(detectors.registry);
    expect(guard.detectors).toBe(detectors);
  });

  it("builds one with the built-in rules when none is given", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-guard-registry-"));
    dirs.push(dir);
    const store = await openTestStore(path.join(dir, "db.sqlite"));
    stores.push(store);
    const guard = new GuardService(store, new SecretService(store, crypto.randomBytes(32).toString("base64")), { autoApply: true });
    expect(guard.detectors.registry.get(ENTITIES_DETECTOR_ID)).toBeDefined();
    expect(guard.detectors.entityEngine()).toMatchObject({ id: "rules", status: "rules" });
  });

  it("gives runs and gateway checks the deployment's recognizer", async () => {
    const { guard } = await setup({ recognizer: placesRecognizer });
    expect(guard.detectors.entityEngine()).toMatchObject({ id: "test-model", version: "7", status: "loaded" });
    const run = await check(guard.runtimeFor({ workflowId: "wf", projectId: "default" }), "Ship it to Oslo");
    expect(run.content).toBe("Ship it to [REDACTED:location]");
    const resolution = await guard.resolveRun({ workflowId: "wf" });
    const gateway = await check(guard.gatewayRuntime({ executionId: "mcpgw_2", toolsetId: "ts", clientId: "c", projectId: null }, resolution), "Ship it to Oslo");
    expect(gateway.content).toBe("Ship it to [REDACTED:location]");
  });

  it("gives the same verdicts as the engine's default registry when no recognizer is set up", async () => {
    const { guard } = await setup();
    const text = "Mail ana@example.com, she lives in Lisbon";
    const injected = await check(guard.runtimeFor({ workflowId: "wf", projectId: "default" }), text);
    const { registry: _registry, ...rest } = guard.runtimeFor({ workflowId: "wf", projectId: "default" });
    const engineDefault = await check(rest, text);
    expect(injected.content).toBe("Mail [REDACTED:email], she lives in [REDACTED:location]");
    expect(engineDefault.content).toBe(injected.content);
    expect(engineDefault.verdicts.map((entry) => entry.summary.findings.length)).toEqual(injected.verdicts.map((entry) => entry.summary.findings.length));
  });

  it("refuses rule sets with unusable names and addresses options", async () => {
    const { guard } = await setup();
    const save = async (options: Record<string, unknown>) =>
      await guard.createProfile(
        { id: `bad-${crypto.randomUUID().slice(0, 8)}`, document: { id: "x", name: "Bad", version: "1", channels: { prompt: { detectors: [{ id: ENTITIES_DETECTOR_ID, options }] } } } },
        null
      );
    await expect(save({})).rejects.toBeInstanceOf(GuardValidationError);
    await expect(save({ classes: ["person_name"], endpoint: "http://10.0.0.1/ner" })).rejects.toMatchObject({ issues: [expect.objectContaining({ path: expect.stringContaining(`detectors.0.options`) })] });
    await expect(save({ classes: ["person_name"], minScore: { person_name: 0.9 } })).resolves.toBeDefined();
  });
});
