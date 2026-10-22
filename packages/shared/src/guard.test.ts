import { describe, expect, it } from "vitest";
import { nodeDefinitions } from "./definitions";
import {
  defaultGuardLabels,
  GUARD_OUTPUT_HANDLES,
  guardNodeConfigSchema,
  guardProfileCreateSchema,
  guardProjectBindingInputSchema,
  guardProtectionNodeConfigSchema,
  guardWorkflowBindingInputSchema
} from "./guard";
import { workflowNodeSchema } from "./schemas";

describe("guard node schemas", () => {
  it("fills defaults for the guard node and rejects unknown channels", () => {
    const config = guardNodeConfigSchema.parse({});
    expect(config).toEqual({ profileId: "effective", channel: "prompt", inputField: "user_prompt", timeoutMinutes: 60 });
    expect(guardNodeConfigSchema.safeParse({ channel: "everything" }).success).toBe(false);
    expect(guardNodeConfigSchema.parse({ channel: "tool_result", profileOverride: { shadow: { block: true } } }).profileOverride).toEqual({ shadow: { block: true } });
  });

  it("requires a key secret for keyed and deterministic protection providers", () => {
    expect(guardProtectionNodeConfigSchema.safeParse({ providerId: "mask", dataClasses: "*" }).success).toBe(true);
    const missingKey = guardProtectionNodeConfigSchema.safeParse({ providerId: "aes_gcm", dataClasses: ["us_ssn"] });
    expect(missingKey.success).toBe(false);
    expect(missingKey.error?.issues[0]?.path).toEqual(["keySecretRef"]);
    expect(guardProtectionNodeConfigSchema.safeParse({ providerId: "token_vault", dataClasses: ["email"], deterministic: true }).success).toBe(false);
    expect(
      guardProtectionNodeConfigSchema.parse({ providerId: "token_vault", dataClasses: ["email"], deterministic: true, keySecretRef: { secretId: "sec_1" } }).protectMatches
    ).toBe(true);
    expect(guardProtectionNodeConfigSchema.safeParse({ providerId: "vault", dataClasses: ["email"] }).success).toBe(false);
  });

  it("registers both node types in the workflow contract and the node definitions", () => {
    expect(workflowNodeSchema.safeParse({ id: "g", type: "guard", name: "Guard", position: { x: 0, y: 0 }, config: {} }).success).toBe(true);
    expect(workflowNodeSchema.safeParse({ id: "p", type: "guard_protection", name: "P", position: { x: 0, y: 0 }, config: {} }).success).toBe(true);
    expect(nodeDefinitions.map((definition) => definition.type)).toEqual(expect.arrayContaining(["guard", "guard_protection"]));
    expect(GUARD_OUTPUT_HANDLES).toEqual(["pass", "blocked", "review"]);
  });

  it("labels prompt input as user and tool results as untrusted", () => {
    expect(defaultGuardLabels("prompt")).toEqual(["user"]);
    expect(defaultGuardLabels("tool_result")).toEqual(["untrusted_external"]);
    expect(defaultGuardLabels("final_output")).toEqual([]);
  });
});

describe("guard binding and profile schemas", () => {
  it("needs a profile for override and enforced bindings, and never lets a workflow enforce", () => {
    expect(guardProjectBindingInputSchema.safeParse({ mode: "inherit" }).success).toBe(true);
    expect(guardProjectBindingInputSchema.safeParse({ mode: "enforced" }).success).toBe(false);
    expect(guardProjectBindingInputSchema.safeParse({ mode: "enforced", profileId: "strict" }).success).toBe(true);
    expect(guardWorkflowBindingInputSchema.safeParse({ mode: "override" }).success).toBe(false);
    expect(guardWorkflowBindingInputSchema.safeParse({ mode: "enforced", profileId: "strict" }).success).toBe(false);
  });

  it("validates profile ids", () => {
    expect(guardProfileCreateSchema.safeParse({ id: "strict-pii", document: {} }).success).toBe(true);
    expect(guardProfileCreateSchema.safeParse({ id: "Strict PII", document: {} }).success).toBe(false);
  });
});
