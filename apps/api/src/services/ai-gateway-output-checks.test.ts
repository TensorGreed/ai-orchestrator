/**
 * Phase 12 coverage — output checks on /v1 answers: whole-answer checks (a JSON schema, grounding) wait for the
 * complete answer instead of cutting a stream at a boundary, and a rule with `stream: "buffer"` buffers the answer.
 */
import { describe, expect, it } from "vitest";
import { createDefaultGuardRegistry, hashGuardProfile, parseGuardProfile, type GuardProfileInput } from "@ai-orchestrator/guard-sdk";
import type { ResolvedGuardProfile } from "@ai-orchestrator/workflow-engine";
import { checkAiGatewayAnswer, outputGuardMode, type AiGatewayGuardScope } from "./ai-gateway-guard.js";

function resolved(document: Omit<GuardProfileInput, "id" | "name" | "version">): ResolvedGuardProfile {
  const profile = parseGuardProfile({ id: "route-rules", name: "Route rules", version: "1", ...document });
  return { profileId: "route-rules", version: 1, hash: hashGuardProfile(profile), name: "Route rules", profile };
}

const SCHEMA = { type: "object", required: ["status"], properties: { status: { enum: ["ok", "late"] } } };

const schemaRule = (stream?: "buffer") =>
  resolved({
    channels: {
      final_output: {
        detectors: [{ id: "output.schema", threshold: 0.5, options: { schema: SCHEMA } }],
        actions: { schema_violation: { action: "block", ...(stream ? { stream } : {}) } },
        defaultAction: { action: "block" }
      }
    }
  } as never);

function scopeFor(profile: ResolvedGuardProfile): AiGatewayGuardScope {
  const resolution = { source: "toolset" as const, stack: [profile], chain: [] };
  return {
    guard: {
      gatewayRuntime: () => ({ registry: createDefaultGuardRegistry(), resolveRun: () => resolution, loadProfile: () => undefined })
    },
    resolution,
    requestId: "aigw_test",
    routeSetId: "set",
    clientId: "client",
    projectId: null,
    alias: "model",
    subject: { role: "operator" },
    resolveSecret: async () => undefined
  } as unknown as AiGatewayGuardScope;
}

describe("whole-answer checks on /v1 answers", () => {
  it("a boundary check of a streamed answer does not run the schema check", async () => {
    const scope = scopeFor(schemaRule());
    expect(await checkAiGatewayAnswer(scope, { content: '{"status":"o', toolCalls: [] }, false)).toEqual({ action: "allow" });
  });

  it("the final check runs it", async () => {
    const scope = scopeFor(schemaRule());
    expect((await checkAiGatewayAnswer(scope, { content: '{"status":"o', toolCalls: [] }, true)).action).toBe("block");
    expect(await checkAiGatewayAnswer(scope, { content: '{"status":"ok"}', toolCalls: [] }, true)).toEqual({ action: "allow" });
  });

  it("stream: buffer on a rule buffers the answer; without it the answer streams in chunks", () => {
    expect(outputGuardMode([schemaRule()])).toBe("chunked");
    expect(outputGuardMode([schemaRule("buffer")])).toBe("buffered");
  });
});
