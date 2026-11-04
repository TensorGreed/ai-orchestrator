import { describe, expect, it } from "vitest";
import { ErrorCategory, WorkflowError } from "@ai-orchestrator/shared";
import { createDefaultProviderRegistry } from "./index";
import { createGatedProviderRegistry, isModelNotAllowedError, ModelNotAllowedError, type GatedModelCall } from "./gated-registry";
import { createModelTapeRecordingRegistry, ModelTapeRecorder } from "./model-tape";
import type { LLMProviderAdapter } from "./types";

const context = { resolveSecret: async () => undefined };

describe("GatedProviderRegistry", () => {
  it("asks the gate before every generate, stream and test call, and refuses with a typed error", async () => {
    const base = createDefaultProviderRegistry();
    const seen: GatedModelCall[] = [];
    const registry = createGatedProviderRegistry(base, (call) => {
      seen.push(call);
      if (call.model === "blocked") throw new ModelNotAllowedError("not allowed", { providerId: call.providerId, model: call.model, refusedBy: "deployment" });
    });
    const echo = registry.get("echo");
    const ok = await echo.generate({ provider: { providerId: "echo", model: "fine" }, messages: [{ role: "user", content: "hi" }] }, context);
    expect(typeof ok.content).toBe("string");
    const refused = await echo.generate({ provider: { providerId: "echo", model: "blocked" }, messages: [{ role: "user", content: "hi" }] }, context).catch((error: unknown) => error);
    expect(isModelNotAllowedError(refused)).toBe(true);
    expect(refused).toBeInstanceOf(WorkflowError);
    expect((refused as WorkflowError).category).toBe(ErrorCategory.MODEL_NOT_ALLOWED);
    expect((refused as WorkflowError).retryable).toBe(false);
    expect(seen.map((call) => [call.operation, call.model])).toEqual([["generate", "fine"], ["generate", "blocked"]]);
  });

  it("reads the Azure deployment name as the model, wraps streams and tests, and sees providers registered later", async () => {
    const base = createDefaultProviderRegistry();
    const seen: GatedModelCall[] = [];
    const registry = createGatedProviderRegistry(base, (call) => {
      seen.push(call);
      throw new ModelNotAllowedError("no", { providerId: call.providerId, model: call.model, refusedBy: "project", projectId: "p1" });
    });
    const late: LLMProviderAdapter = {
      definition: { id: "late", label: "Late", supportsTools: false, configSchema: {} },
      generate: async () => ({ content: "never", toolCalls: [] }),
      generateStream: async function* () {
        yield { type: "text_delta", textDelta: "never" };
      },
      testConnection: async () => ({ ok: true, message: "never" })
    };
    registry.register(late);
    expect(base.tryGet("late")).toBe(late);
    const wrapped = registry.get("late");
    expect(wrapped).toBe(registry.get("late"));
    await expect(wrapped.testConnection!({ providerId: "late", model: "m" }, context)).rejects.toThrow("no");
    const stream = wrapped.generateStream!({ provider: { providerId: "late", model: "m" }, messages: [] }, context);
    await expect(stream.next()).rejects.toThrow("no");
    await expect(registry.get("azure_openai").generate({ provider: { providerId: "azure_openai", model: "x", extra: { deployment: "prod-4o" } }, messages: [] }, context)).rejects.toThrow("no");
    expect(seen.map((call) => [call.operation, call.providerId, call.model])).toEqual([
      ["test", "late", "m"],
      ["stream", "late", "m"],
      ["generate", "azure_openai", "prod-4o"]
    ]);
    expect(registry.listDefinitions().map((definition) => definition.id)).toContain("late");
    expect(registry.tryGet("missing")).toBeUndefined();
  });

  it("a refusal under a recorder is taped as an error, never as an answer", async () => {
    const recorder = new ModelTapeRecorder();
    const gated = createGatedProviderRegistry(createDefaultProviderRegistry(), (call) => {
      if (call.model === "blocked") throw new ModelNotAllowedError("no", { providerId: call.providerId, model: call.model, refusedBy: "deployment" });
    });
    const outer = createGatedProviderRegistry(createModelTapeRecordingRegistry(gated, recorder), () => undefined);
    await outer.get("echo").generate({ provider: { providerId: "echo", model: "ok" }, messages: [{ role: "user", content: "a" }] }, context);
    await expect(outer.get("echo").generate({ provider: { providerId: "echo", model: "blocked" }, messages: [] }, context)).rejects.toThrow("no");
    // The recorder records the refusal as an error entry, never a model answer.
    const tape = recorder.toTape();
    expect(tape.entries.map((entry) => [entry.model, entry.error ?? null])).toEqual([["ok", null], ["blocked", "no"]]);
  });
});
