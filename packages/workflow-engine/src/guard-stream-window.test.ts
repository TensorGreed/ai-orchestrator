import { describe, expect, it } from "vitest";
import { createGuardVerdictMemo } from "@ai-orchestrator/guard-sdk";
import { builtInGuardProfile, guardCheckMemoKey, runGuardCheck, type GuardCheckResult, type GuardEvalScope, type GuardRuntimeDependencies } from "./guard-runtime";

/**
 * Phase 12 coverage, gateway lane — what the `/v1` gateway needs from the engine: a stream window's end on the check
 * result, and the memo key `runGuardCheck` uses, so the gateway can keep a memo of conversation turns it checks together.
 */
function scopeFor(memo?: GuardEvalScope["memo"]): GuardEvalScope {
  const guard: GuardRuntimeDependencies = {
    resolveRun: () => ({ source: "none", stack: [], chain: [] }),
    loadProfile: () => undefined,
    onVerdict: () => undefined
  };
  return {
    guard,
    resolveSecret: async () => undefined,
    executionId: "aigw_1",
    workflowId: "",
    nodeId: "alias",
    placement: "gateway",
    subject: { role: "operator", userId: "client-1" } as GuardEvalScope["subject"],
    ...(memo ? { memo } : {})
  };
}

describe("stream windows through runGuardCheck", () => {
  it("returns the window's end in the rewritten content's coordinates", async () => {
    const profiles = [builtInGuardProfile()];
    const sent = "Sent. ";
    const release = "key ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD. ";
    const held = "held";
    const result = await runGuardCheck(scopeFor(), profiles, {
      channel: "final_output",
      content: sent + release + held,
      streamWindow: { start: sent.length, end: sent.length + release.length }
    });
    expect(result.transformed).toBe(true);
    const out = result.content as string;
    expect(out.slice(result.window!.start, result.window!.end)).toBe("key [REDACTED:credential]. ");
    expect(out.slice(result.window!.end)).toBe(held);
  });

  it("has no window without one in the input", async () => {
    const result = await runGuardCheck(scopeFor(), [builtInGuardProfile()], { channel: "final_output", content: "hello" });
    expect(result.window).toBeUndefined();
  });
});

describe("guardCheckMemoKey", () => {
  it("is the key runGuardCheck stores a clean check under", async () => {
    const memo = createGuardVerdictMemo<GuardCheckResult["verdicts"]>();
    const scope = scopeFor(memo);
    const profiles = [builtInGuardProfile()];
    const input = { channel: "prompt" as const, content: ["Summarise the report."], labels: [] };
    await runGuardCheck(scope, profiles, input);
    const key = guardCheckMemoKey(scope, profiles, input);
    expect(key).toBeDefined();
    expect(memo.get(key!)).toBeDefined();
  });

  it("includes the scope's subject, and is undefined where a memo may not be used", () => {
    const profiles = [builtInGuardProfile()];
    const scope = scopeFor();
    const input = { channel: "prompt" as const, content: "hello" };
    const other = { ...scope, subject: { role: "operator", userId: "client-2" } as GuardEvalScope["subject"] };
    expect(guardCheckMemoKey(scope, profiles, input)).not.toBe(guardCheckMemoKey(other, profiles, input));
    expect(guardCheckMemoKey(scope, [], input)).toBeUndefined();
    expect(guardCheckMemoKey(scope, profiles, { channel: "tool_arguments", content: { url: "http://example.com" } })).toBeUndefined();
  });
});
