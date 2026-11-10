import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultGuardRegistry, GuardRegistry, hashGuardProfile, parseGuardProfile, type GuardDetector, type GuardProfileInput } from "@ai-orchestrator/guard-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import { RESPONSE_FAILED_MESSAGE, RESPONSE_WITHHELD_MESSAGE, callerErrorOf, type Workflow, type WorkflowExecutionResult, type WorkflowNode } from "@ai-orchestrator/shared";
import { executeWorkflow, type ExecuteWorkflowRequest, type WorkflowExecutionDependencies } from "./executor";
import { builtInGuardProfile, type GuardRunResolution, type GuardRuntimeDependencies, type GuardVerdictEvent, type ResolvedGuardProfile } from "./guard-runtime";
import { checkRunResponse, checkTriggerInput } from "./response-boundary";

/**
 * Phase 12 coverage — the response boundary: a run that answers an external caller is checked once at its end on
 * the `response` channel, only when a rule set of its stack configures that channel.
 */

const SECRET = "sk-live-abcdefghijklmnopqrstuvwxyz123456";
const EMAIL = "ana.lopez@example.org";

function resolved(id: string, document: Omit<GuardProfileInput, "id">): ResolvedGuardProfile {
  const profile = parseGuardProfile({ ...document, id });
  return { profileId: id, version: 1, hash: hashGuardProfile(profile), name: profile.name, profile };
}

/** A rule set that checks responses: credentials blocked, emails redacted; optionally emails need a review. */
function responseRules(emailAction: "redact" | "review" | "require_approval" = "redact", extra: Partial<GuardProfileInput> = {}) {
  return resolved("responses", {
    name: "Responses",
    version: "1",
    channels: {
      response: {
        detectors: [{ id: "dlp.patterns", threshold: 0.5 }],
        actions: { credential: { action: "block" }, email: { action: emailAction }, sensitive_data: { action: "allow" } },
        defaultAction: { action: "allow" }
      }
    },
    ...extra
  });
}

function guardFor(stack: ResolvedGuardProfile[], options: { registry?: GuardRegistry; resolveRun?: () => GuardRunResolution } = {}) {
  const events: GuardVerdictEvent[] = [];
  let resolutions = 0;
  const guard: GuardRuntimeDependencies = {
    registry: options.registry ?? createDefaultGuardRegistry({ resolver: async () => ["93.184.215.14"] }),
    resolveRun:
      options.resolveRun ??
      (() => {
        resolutions += 1;
        return { source: stack.length ? "project" : "none", stack, chain: [] };
      }),
    loadProfile: (id) => stack.find((entry) => entry.profileId === id),
    onVerdict: (event) => {
      events.push(event);
    }
  };
  return { guard, events, resolutions: () => resolutions };
}

function deps(guard?: GuardRuntimeDependencies): WorkflowExecutionDependencies {
  return {
    providerRegistry: new ProviderRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    ...(guard ? { guard } : {})
  };
}

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

/** webhook_input → output: the run's output is the payload. */
const echo: Workflow = {
  id: "wf-echo",
  name: "Echo",
  schemaVersion: "1.0.0",
  workflowVersion: 1,
  nodes: [node("in", "webhook_input"), node("out", "output", { responseTemplate: "{{webhook.text}}" })],
  edges: [{ id: "e1", source: "in", target: "out" }]
};

function run(workflow: Workflow, text: string, guard: GuardRuntimeDependencies | undefined, extra: Partial<ExecuteWorkflowRequest> = { responseBoundary: { surface: "webhook" } }) {
  return executeWorkflow({ workflow, executionId: "exec-resp", webhookPayload: { text }, triggerType: "webhook", ...extra }, deps(guard));
}

const json = (value: unknown) => JSON.stringify(value);

describe("response boundary at the end of a run", () => {
  it("does nothing without a rule set that checks responses (built-in rule set, no guard, no boundary)", async () => {
    const builtIn = guardFor([builtInGuardProfile()]);
    const withBuiltIn = await run(echo, `key ${SECRET}`, builtIn.guard);
    expect(json(withBuiltIn.output)).toContain(SECRET);
    expect(withBuiltIn.responseCheck).toBeUndefined();
    expect(builtIn.events.filter((event) => event.placement === "response")).toEqual([]);

    const unguarded = await run(echo, `key ${SECRET}`, undefined);
    expect(json(unguarded.output)).toContain(SECRET);
    expect(unguarded.responseCheck).toBeUndefined();

    // A run that answers no external caller (the editor, a schedule) is never checked, whatever its rule sets say.
    const rules = guardFor([responseRules()]);
    const editorRun = await run(echo, `key ${SECRET}`, rules.guard, {});
    expect(json(editorRun.output)).toContain(SECRET);
    expect(editorRun.responseCheck).toBeUndefined();
    expect(rules.events).toEqual([]);
  });

  it("redacts the output in place: history and the reply hold the checked version, node results keep what ran", async () => {
    const { guard, events } = guardFor([responseRules()]);
    const result = await run(echo, `write to ${EMAIL}`, guard);
    expect(result.status).toBe("success");
    expect(json(result.output)).not.toContain(EMAIL);
    expect(result.responseCheck).toMatchObject({ action: "redact", withheld: false, transformed: true });
    expect(result.responseCheck?.reason).not.toContain(EMAIL);
    // The builder's record of each step is unchanged.
    expect(json(result.nodeResults.find((entry) => entry.nodeId === "out")?.output)).toContain(EMAIL);
    const recorded = events.filter((event) => event.placement === "response");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ channel: "response", nodeId: "out", executionId: "exec-resp", workflowId: "wf-echo" });
    expect(json(recorded)).not.toContain(EMAIL);
  });

  it("withholds a blocked output and the run still ends success", async () => {
    const { guard, events } = guardFor([responseRules()]);
    const result = await run(echo, `key ${SECRET}`, guard);
    expect(result.status).toBe("success");
    expect(result.output).toEqual({ error: RESPONSE_WITHHELD_MESSAGE, code: "content_filter" });
    expect(result.responseCheck).toMatchObject({ action: "block", withheld: true, transformed: false });
    expect(json(result.responseCheck)).not.toContain(SECRET);
    expect(events.filter((event) => event.placement === "response").map((event) => event.check?.action)).toEqual(["block"]);
  });

  it("withholds review and require_approval: the caller cannot wait for a person", async () => {
    for (const action of ["review", "require_approval"] as const) {
      const { guard } = guardFor([responseRules(action)]);
      const result = await run(echo, `write to ${EMAIL}`, guard);
      expect(result.status, action).toBe("success");
      expect(result.responseCheck, action).toMatchObject({ action, withheld: true });
      expect(json(result.output), action).not.toContain(EMAIL);
    }
  });

  it("checks only what a Webhook Response reply sends (status, headers, body)", async () => {
    const { guard, events } = guardFor([responseRules()]);
    const reply = (who: string) => ({ statusCode: 201, headers: { "x-contact": who }, body: { reply: who } });
    const finished = (who: string, extra: Record<string, unknown> = {}): WorkflowExecutionResult => ({
      workflowId: "wf",
      status: "success",
      startedAt: "2026-11-10T00:00:00.000Z",
      completedAt: "2026-11-10T00:00:01.000Z",
      executionId: "exec-reply",
      nodeResults: [],
      output: { __webhookResponse: reply(who), result: { reply: who }, ...extra }
    });
    const check = (result: WorkflowExecutionResult, surface: "webhook" | "chat" | "mcp_invoke" = "webhook") =>
      checkRunResponse({ result, boundary: { surface }, guard, resolveSecret: async () => undefined, executionId: "exec-reply", workflowId: "wf", nodeId: "out" });

    const clean = await check(finished("nobody"));
    expect(clean.output).toEqual(finished("nobody").output);
    // The output can hold more than the reply (an Output node that reads everything), but a webhook caller receives
    // only the reply: a credential elsewhere in the output does not withhold it.
    const extra = await check(finished("nobody", { webhook: { token: SECRET } }));
    expect(extra.responseCheck).toMatchObject({ action: "allow", withheld: false });
    // Chat and MCP invoke callers receive the whole output, so the same output is withheld for them.
    for (const surface of ["chat", "mcp_invoke"] as const) {
      expect((await check(finished("nobody", { webhook: { token: SECRET } }), surface)).responseCheck, surface).toMatchObject({ withheld: true });
    }

    const redacted = await check(finished(EMAIL));
    const sent = (redacted.output as Record<string, any>).__webhookResponse;
    expect(sent.statusCode).toBe(201);
    expect(sent.headers["x-contact"]).toBeTypeOf("string");
    expect(json(sent)).not.toContain(EMAIL);
    // The stored output is what was sent: no other field keeps an unchecked copy of the body.
    expect(Object.keys(redacted.output as object)).toEqual(["__webhookResponse"]);
    expect(json(redacted.output)).not.toContain(EMAIL);
    expect(events.at(-1)).toMatchObject({ placement: "response", nodeId: "out", channel: "response" });

    const blocked = await check(finished(SECRET));
    expect(blocked.output).toEqual({ error: RESPONSE_WITHHELD_MESSAGE, code: "content_filter" });
  });

  it("shadow rules record but never change the response", async () => {
    const { guard, events } = guardFor([responseRules("redact", { shadow: { block: true, redact: true } })]);
    const result = await run(echo, `key ${SECRET} and ${EMAIL}`, guard);
    expect(json(result.output)).toContain(SECRET);
    expect(json(result.output)).toContain(EMAIL);
    expect(result.responseCheck).toMatchObject({ action: "allow", withheld: false, transformed: false });
    expect(events.filter((event) => event.placement === "response")).toHaveLength(1);
  });

  it("evaluates only the rule sets that check responses, after an enforced one in stack order", async () => {
    const other = resolved("other", { name: "Other", version: "1", channels: { final_output: { detectors: [{ id: "dlp.patterns", threshold: 0.5 }], actions: {}, defaultAction: { action: "block" } } } });
    const { guard, events } = guardFor([other, builtInGuardProfile(), responseRules()]);
    const result = await run(echo, `write to ${EMAIL}`, guard);
    expect(json(result.output)).not.toContain(EMAIL);
    expect(events.map((event) => event.profile.profileId)).toEqual(["responses"]);
  });

  it("fails closed when the rule sets cannot be resolved or a detector fails", async () => {
    const broken = guardFor([], {
      resolveRun: () => {
        throw new Error("store down");
      }
    });
    const result = await run(echo, "hello", broken.guard);
    expect(result.status).toBe("success");
    expect(result.responseCheck).toMatchObject({ action: "block", withheld: true });
    expect(result.output).toEqual({ error: RESPONSE_WITHHELD_MESSAGE, code: "content_filter" });

    const throwing: GuardDetector = {
      id: "test.throws",
      tier: "rule",
      description: "always fails",
      channels: ["response"],
      categories: ["custom"],
      detect: () => {
        throw new Error("detector failed");
      }
    };
    const failing = resolved("failing", {
      name: "Failing",
      version: "1",
      latencyBudget: { ms: 2000, onExceeded: "fail_closed" },
      channels: { response: { detectors: [{ id: "test.throws", threshold: 0.5 }], actions: {}, defaultAction: { action: "allow" } } }
    });
    const failed = await run(echo, "hello", guardFor([failing], { registry: new GuardRegistry().register(throwing) }).guard);
    expect(failed.responseCheck?.withheld).toBe(true);
  });

  it("skips the resolution when no stored rule set could check responses, and resolves when the shortcut fails", async () => {
    const { guard, events } = guardFor([responseRules()]);
    let resolved = 0;
    const counted: GuardRuntimeDependencies = {
      ...guard,
      // No rule set tracks labels either, so nothing else resolves the run's profiles.
      mayUseLabels: () => false,
      resolveRun: () => {
        resolved += 1;
        return { source: "project", stack: [responseRules()], chain: [] };
      }
    };
    const none = await run(echo, `key ${SECRET}`, { ...counted, mayCheckChannel: (channel) => channel !== "response" });
    expect(json(none.output)).toContain(SECRET);
    expect(resolved).toBe(0);
    const failing = await run(echo, `key ${SECRET}`, {
      ...counted,
      mayCheckChannel: () => {
        throw new Error("store down");
      }
    });
    expect(failing.responseCheck?.withheld).toBe(true);
    expect(resolved).toBe(1);
    expect(events).toHaveLength(1);
  });

  it("stamps error runs (the API answers a generic error while rules apply) and keeps their error for the history", async () => {
    const { guard, events } = guardFor([responseRules()]);
    const broken: Workflow = { ...echo, nodes: [node("in", "webhook_input"), node("bad", "stop_and_error", { message: "leak {{webhook.text}}" }), node("out", "output")], edges: [{ id: "e1", source: "in", target: "bad" }, { id: "e2", source: "bad", target: "out" }] };
    const failed = await run(broken, SECRET, guard);
    expect(failed.status).toBe("error");
    expect(failed.responseCheck).toBeUndefined();
    expect(failed.responseRules).toEqual({ surface: "webhook", apply: true });
    expect(failed.error).toContain(SECRET);
    expect(callerErrorOf(failed, "x")).toBe(RESPONSE_FAILED_MESSAGE);
    expect(events).toEqual([]);
    // Without response rules the caller reads the run's own error, as before.
    const plain = await run(broken, SECRET, guardFor([builtInGuardProfile()]).guard);
    expect(plain.responseRules).toEqual({ surface: "webhook", apply: false });
    expect(callerErrorOf(plain, "x")).toBe(plain.error);
    // A run without a boundary is never stamped.
    expect((await run(broken, SECRET, guard, {})).responseRules).toBeUndefined();
  });

  it("seals a paused run's reply while rules apply: no approval message, no node data", async () => {
    const gated: Workflow = {
      ...echo,
      nodes: [node("in", "webhook_input"), node("gate", "human_approval", { approvalMessage: "Approve: {{webhook.text}}", timeoutMinutes: 5 }), node("out", "output", { responseTemplate: "done" })],
      edges: [
        { id: "e1", source: "in", target: "gate" },
        { id: "e2", source: "gate", target: "out" }
      ]
    };
    const paused: string[] = [];
    const withPause = (guard: GuardRuntimeDependencies) => ({ ...deps(guard), persistPausedExecution: async (state: { approvalMessage?: string }) => void paused.push(String(state.approvalMessage)) }) as WorkflowExecutionDependencies;
    const { guard } = guardFor([responseRules()]);
    const sealed = await executeWorkflow({ workflow: gated, executionId: "exec-p", webhookPayload: { text: `key ${SECRET}` }, triggerType: "webhook", responseBoundary: { surface: "webhook" } }, withPause(guard));
    expect(sealed.status).toBe("waiting_approval");
    expect(sealed.output).toEqual({ waitingForApproval: true, executionId: "exec-p" });
    expect(sealed.responseRules).toEqual({ surface: "webhook", apply: true });
    // The approver still reads the message from the paused run's record.
    expect(paused.at(-1)).toContain(SECRET);
    // Without response rules the reply is unchanged.
    const open = await executeWorkflow({ workflow: gated, executionId: "exec-q", webhookPayload: { text: "hello" }, triggerType: "webhook", responseBoundary: { surface: "webhook" } }, withPause(guardFor([]).guard));
    expect(open.output).toMatchObject({ waitingForApproval: true, approvalMessage: "Approve: hello" });
    // The rule sets could not be resolved: sealed (fails closed).
    const failing = guardFor([], { resolveRun: () => { throw new Error("store down"); } });
    const closed = await executeWorkflow({ workflow: gated, executionId: "exec-r", webhookPayload: { text: "hello" }, triggerType: "webhook", responseBoundary: { surface: "webhook" } }, withPause(failing.guard));
    expect(closed.output).toEqual({ waitingForApproval: true, executionId: "exec-r" });
  });

  it("reuses a clean check of the same content earlier in the run (memo) and records nothing new", async () => {
    const counter = { calls: 0 };
    const counting: GuardDetector = {
      id: "test.count",
      tier: "rule",
      description: "counts",
      channels: ["response"],
      categories: ["custom"],
      detect: () => {
        counter.calls += 1;
        return [];
      }
    };
    const profile = resolved("counting", {
      name: "Counting",
      version: "1",
      channels: { response: { detectors: [{ id: "test.count", threshold: 0.5 }], actions: {}, defaultAction: { action: "allow" } } }
    });
    const { guard, events } = guardFor([profile], { registry: new GuardRegistry().register(counting) });
    await run(echo, "hello", guard);
    // The same dependencies object stands for the same run: the second check is a memo hit.
    await run(echo, "hello", guard);
    expect(counter.calls).toBe(1);
    expect(events).toHaveLength(1);
  });
});

describe("incoming payload check (trigger_input)", () => {
  const triggerRules = resolved("door", {
    name: "Door",
    version: "1",
    channels: {
      trigger_input: {
        detectors: [{ id: "dlp.patterns", threshold: 0.5 }, { id: "injection.hidden_unicode", threshold: 0.5 }],
        actions: { credential: { action: "block" }, email: { action: "redact" }, sensitive_data: { action: "allow" } },
        defaultAction: { action: "allow" }
      }
    }
  });
  const check = (payload: unknown, stack: ResolvedGuardProfile[]) => {
    const { guard, events } = guardFor(stack);
    return checkTriggerInput({ payload, guard, resolveSecret: async () => undefined, executionId: "exec-in", workflowId: "wf", nodeId: "in", labels: ["untrusted_external"] }).then((outcome) => ({ outcome, events }));
  };

  it("is null without a rule set that configures it", async () => {
    expect((await check({ text: SECRET }, [builtInGuardProfile(), responseRules()])).outcome).toBeNull();
  });

  it("refuses a blocked payload, rewrites a redacted one and passes a clean one", async () => {
    const blocked = await check({ text: SECRET }, [triggerRules]);
    expect(blocked.outcome).toMatchObject({ refused: true, transformed: false });
    expect(blocked.events[0]).toMatchObject({ channel: "trigger_input", placement: "request", nodeId: "in" });
    const redacted = await check({ text: `mail ${EMAIL}` }, [triggerRules]);
    expect(redacted.outcome?.refused).toBe(false);
    expect(redacted.outcome?.transformed).toBe(true);
    expect(json(redacted.outcome?.payload)).not.toContain(EMAIL);
    const clean = await check({ text: "hello" }, [triggerRules]);
    expect(clean.outcome).toMatchObject({ refused: false, transformed: false, payload: { text: "hello" } });
  });
});
