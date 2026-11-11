import { describe, expect, it } from "vitest";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createAesGcmProvider, hashGuardProfile, InMemoryTokenVaultStorage, parseGuardProfile, type GuardProfileInput } from "@ai-orchestrator/guard-sdk";
import { createDefaultMCPRegistry, type MCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import { resolvePendingApproval, type McpToolPolicySubject, type Workflow, type WorkflowExecutionState, type WorkflowNode } from "@ai-orchestrator/shared";
import { executeWorkflow, outputLabelsOf, resumeWorkflowExecution, runRevealedValues, type WorkflowExecutionDependencies } from "./executor";
import { builtInGuardProfile, type GuardRevealEvent, type GuardRunResolution, type ResolvedGuardProfile } from "./guard-runtime";
import { validateWorkflowGraph } from "./validation";

/**
 * Phase 12 coverage — the Reveal node: deny by default, matched on the run subject (role and user rules only for runs
 * a signed-in person started), scoped to the run's project, approval when a rule asks, audited, never in replays,
 * and revealed values labelled sensitive again.
 */

const CARD = "4111 1111 1111 1111";
const EMAIL = "ana.lopez@example.org";
const CARD_TOKEN = "tok_card_number_AAAAAAAAAAAAAAAA";
const EMAIL_TOKEN = "tok_email_BBBBBBBBBBBBBBBB";
const OTHER_PROJECT_TOKEN = "tok_card_number_CCCCCCCCCCCCCCCC";
const LEGACY_TOKEN = "tok_card_number_DDDDDDDDDDDDDDDD";
const KEY = Buffer.alloc(32, 9);

function resolved(id: string, document: GuardProfileInput, version = 1): ResolvedGuardProfile {
  const profile = parseGuardProfile({ ...document, id });
  return { profileId: id, version, hash: hashGuardProfile(profile), name: profile.name, profile };
}

const base = (id: string): GuardProfileInput => ({ id, name: id, version: "1", channels: {} });
const PROFILES: Record<string, ResolvedGuardProfile> = {
  default: builtInGuardProfile(),
  support: resolved("support", {
    ...base("support"),
    reveal: {
      rules: [
        { name: "Billing admins", dataClasses: ["card_number"], subjects: { roles: ["admin"] } },
        { dataClasses: ["email"], subjects: { users: ["u-ana"], serviceAccounts: ["sa-crm"] } }
      ]
    }
  }),
  approval: resolved("approval", { ...base("approval"), reveal: { rules: [{ dataClasses: ["card_number"], subjects: { roles: ["admin"] }, requireApproval: true }] } }),
  scoped: resolved("scoped", { ...base("scoped"), reveal: { rules: [{ dataClasses: ["card_number"], subjects: { roles: ["admin"] }, workflows: ["another-workflow"] }] } }),
  // An enforced rule set with a reveal block and no rules: the ceiling, no reveal at all in its project.
  ceiling: resolved("ceiling", { ...base("ceiling"), reveal: { rules: [] } }),
  plain: resolved("plain", base("plain")),
  // Reveals emails to admins, and checks what external callers receive (emails redacted).
  responses: resolved("responses", {
    ...base("responses"),
    reveal: { rules: [{ dataClasses: ["email"], subjects: { roles: ["admin"] } }] },
    channels: {
      response: {
        detectors: [{ id: "dlp.patterns", threshold: 0.5 }],
        actions: { email: { action: "redact" }, sensitive_data: { action: "allow" } },
        defaultAction: { action: "allow" }
      }
    }
  })
};

async function vault() {
  const storage = new InMemoryTokenVaultStorage();
  const createdAt = new Date().toISOString();
  await storage.put({ token: CARD_TOKEN, dataClass: "card_number", value: CARD, createdAt, projectId: "proj-a", executionId: "exec-issued" });
  await storage.put({ token: EMAIL_TOKEN, dataClass: "email", value: EMAIL, createdAt, projectId: "proj-a" });
  await storage.put({ token: OTHER_PROJECT_TOKEN, dataClass: "card_number", value: "5555 5555 5555 4444", createdAt, projectId: "proj-b" });
  await storage.put({ token: LEGACY_TOKEN, dataClass: "card_number", value: "4000 0566 5566 5556", createdAt });
  return storage;
}

async function guardDeps(
  options: { stack?: string[]; enforced?: string; projectId?: string | null; revealDisabled?: boolean; onReveal?: (event: GuardRevealEvent) => void | Promise<void>; noRecorder?: boolean } = {}
) {
  const reveals: GuardRevealEvent[] = [];
  const enforced = options.enforced ? PROFILES[options.enforced]! : undefined;
  const stack = [...(enforced ? [enforced] : []), ...(options.stack ?? []).map((id) => PROFILES[id]!)];
  const resolution: GuardRunResolution = { source: enforced ? "enforced" : stack.length ? "project" : "none", ...(enforced ? { enforced } : {}), stack, chain: [] };
  return {
    reveals,
    guard: {
      resolveRun: () => resolution,
      loadProfile: (id: string) => PROFILES[id],
      vault: await vault(),
      projectId: options.projectId === undefined ? "proj-a" : options.projectId,
      ...(options.revealDisabled ? { revealDisabled: true } : {}),
      ...(options.noRecorder
        ? {}
        : {
            onReveal:
              options.onReveal ??
              ((event: GuardRevealEvent) => {
                reveals.push(event);
              })
          })
    } satisfies NonNullable<WorkflowExecutionDependencies["guard"]>
  };
}

/** What the downstream `sink` node sent (an MCP tool call): the run's own nodes get the revealed values. */
let sent: Array<Record<string, unknown>> = [];

function sinkRegistry() {
  const registry = createDefaultMCPRegistry();
  registry.register({
    definition: { id: "sink-mcp", label: "Sink", description: "Test", configSchema: {}, authSchema: {} },
    async discoverTools() {
      return [{ serverId: "sink-mcp", serverLabel: "Sink", name: "send", description: "Send", inputSchema: { type: "object", properties: {} } }];
    },
    async invokeTool(_name: string, args: Record<string, unknown>) {
      sent.push(args);
      if (args.fail) return { ok: false, error: `Rejected ${String(args.text)}` };
      return { ok: true, output: { echoed: args.text } };
    }
  } as unknown as MCPServerAdapter);
  return registry;
}

function deps(guard: WorkflowExecutionDependencies["guard"], extra: Partial<WorkflowExecutionDependencies> = {}, paused?: WorkflowExecutionState[]): WorkflowExecutionDependencies {
  return {
    providerRegistry: new ProviderRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: sinkRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async (ref) => (ref?.secretId === "sec_key" ? KEY.toString("base64") : undefined),
    ...(guard ? { guard } : {}),
    persistPausedExecution: async (state) => {
      paused?.push(state.state);
    },
    ...extra
  };
}

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function revealWorkflow(config: Record<string, unknown> = {}, sinkArgs = '{"text":"{{text}}"}'): Workflow {
  return {
    id: "wf-reveal",
    name: "Reveal",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "proj-a",
    nodes: [
      node("in", "webhook_input"),
      node("reveal", "guard_reveal", { inputField: "text", ...config }),
      node("sink", "mcp_tool", { serverId: "sink-mcp", toolName: "send", argsTemplate: sinkArgs, retry: { enabled: false } }),
      node("out", "output")
    ],
    edges: [
      { id: "e1", source: "in", target: "reveal" },
      { id: "e2", source: "reveal", target: "sink" },
      { id: "e3", source: "sink", target: "out" }
    ]
  };
}

const ADMIN: McpToolPolicySubject = { role: "admin", source: "user", userId: "u-admin" };
const OWNER_ADMIN: McpToolPolicySubject = { role: "admin", source: "owner", userId: "u-admin" };
const ANA: McpToolPolicySubject = { role: "operator", source: "user", userId: "u-ana" };

const statusOf = (result: Awaited<ReturnType<typeof executeWorkflow>>, id: string) => result.nodeResults.filter((entry) => entry.nodeId === id).at(-1);
const revealOutput = (result: Awaited<ReturnType<typeof executeWorkflow>>) => statusOf(result, "reveal")?.output as Record<string, any>;

async function run(
  text: unknown,
  options: { subject?: McpToolPolicySubject; config?: Record<string, unknown>; guard?: Awaited<ReturnType<typeof guardDeps>>; extra?: Partial<WorkflowExecutionDependencies>; sinkArgs?: string } = {}
) {
  const guarded = options.guard ?? (await guardDeps({ stack: ["support"] }));
  sent = [];
  const result = await executeWorkflow(
    { workflow: revealWorkflow(options.config, options.sinkArgs), executionId: "exec-r", webhookPayload: { text }, ...(options.subject ? { toolPolicySubject: options.subject } : {}) },
    deps(guarded.guard, options.extra)
  );
  // What the downstream node got in the run (the revealed values), and what the run keeps (tokens).
  return { result, reveals: guarded.reveals, got: sent.at(-1)?.text };
}

describe("Reveal node", () => {
  it("reveals nothing without reveal rules (deny by default) and records the refusal without values", async () => {
    const guard = await guardDeps();
    const { result, reveals } = await run(`Card ${CARD_TOKEN}`, { subject: ADMIN, guard });
    expect(result.status).toBe("success");
    const output = revealOutput(result);
    expect(output.text).toBe(`Card ${CARD_TOKEN}`);
    expect(output.reveal.revealed).toEqual([]);
    expect(runRevealedValues(result)).toBe(false);
    expect(output.reveal.refused).toEqual([expect.objectContaining({ dataClass: "card_number", reason: "no_rule", count: 1 })]);
    expect(reveals).toHaveLength(1);
    expect(JSON.stringify(reveals)).not.toContain(CARD);
    expect(JSON.stringify(reveals)).not.toContain(CARD_TOKEN);
  });

  it("reveals for a signed-in admin, records counts and hashes only, and labels the output sensitive with its class", async () => {
    const { result, reveals, got } = await run({ note: `Card ${CARD_TOKEN} for ${EMAIL_TOKEN}` }, { subject: ADMIN, sinkArgs: '{"text":"{{text.note}}"}' });
    const output = revealOutput(result);
    expect(got).toBe(`Card ${CARD} for ${EMAIL_TOKEN}`);
    // The run keeps the token: its result never holds the revealed value.
    expect(output.text).toEqual({ note: `Card ${CARD_TOKEN} for ${EMAIL_TOKEN}` });
    expect(JSON.stringify(result)).not.toContain(CARD);
    // The API keeps such a run out of replay capture and cassettes (the mark survives a copy, never serialises).
    expect(runRevealedValues(result)).toBe(true);
    expect(runRevealedValues({ ...result })).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(JSON.parse(JSON.stringify({ ...result })));
    expect(output.reveal.revealed).toEqual([
      expect.objectContaining({ dataClass: "card_number", count: 1, rule: { profileId: "support", version: 1, index: 0, name: "Billing admins" } })
    ]);
    expect(output.reveal.refused).toEqual([expect.objectContaining({ dataClass: "email", reason: "no_rule" })]);
    expect(reveals).toHaveLength(1);
    expect(reveals[0]).toMatchObject({ executionId: "exec-r", workflowId: "wf-reveal", nodeId: "reveal", subject: { source: "user", role: "admin", userId: "u-admin" }, approved: false });
    expect(JSON.stringify(reveals)).not.toContain(CARD);
    const labels = statusOf(result, "reveal")?.labels;
    expect(labels?.provenance).toContain("sensitive");
    expect(labels?.dataClasses).toContain("card_number");
  });

  it("never matches role or user rules on runs nobody signed in to start (webhook, chat, schedule)", async () => {
    const { result } = await run(`Card ${CARD_TOKEN}`, { subject: OWNER_ADMIN });
    expect(revealOutput(result).text).toBe(`Card ${CARD_TOKEN}`);
    expect(revealOutput(result).reveal.refused[0].reason).toBe("no_rule");
    const anonymous = await run(`Card ${CARD_TOKEN}`);
    expect(revealOutput(anonymous.result).text).toBe(`Card ${CARD_TOKEN}`);
  });

  it("matches users by id and service accounts only by explicit id", async () => {
    const ana = await run(`Mail ${EMAIL_TOKEN}`, { subject: ANA });
    expect(ana.got).toBe(`Mail ${EMAIL}`);
    const serviceAccount = await run(`Mail ${EMAIL_TOKEN} card ${CARD_TOKEN}`, { subject: { role: "admin", source: "user", userId: "sa-crm", serviceAccountId: "sa-crm" } });
    // The service account's admin role matches no role rule; its own id matches the email rule.
    expect(serviceAccount.got).toBe(`Mail ${EMAIL} card ${CARD_TOKEN}`);
    const other = await run(`Mail ${EMAIL_TOKEN}`, { subject: { role: "admin", source: "owner", serviceAccountId: "sa-other" } });
    expect(revealOutput(other.result).text).toBe(`Mail ${EMAIL_TOKEN}`);
  });

  it("refuses tokens from another project, and older unscoped tokens unless an admin started the run", async () => {
    const { result, got } = await run(`${OTHER_PROJECT_TOKEN} ${LEGACY_TOKEN}`, { subject: ADMIN });
    expect(got).toBe(`${OTHER_PROJECT_TOKEN} 4000 0566 5566 5556`);
    expect(revealOutput(result).reveal.refused).toEqual([expect.objectContaining({ dataClass: "card_number", reason: "other_project" })]);
    const builderStack = await guardDeps({ stack: ["support"] });
    const ana = await run(`${EMAIL_TOKEN}`, { subject: ANA, guard: builderStack });
    expect(ana.got).toBe(EMAIL);
  });

  it("limits a rule to its workflows", async () => {
    const guard = await guardDeps({ stack: ["scoped"] });
    const { result } = await run(CARD_TOKEN, { subject: ADMIN, guard });
    expect(revealOutput(result).text).toBe(CARD_TOKEN);
  });

  it("opens encrypted values only under keys the node lists and classes a rule allows", async () => {
    const aes = createAesGcmProvider({ keys: async (id) => (id === "sec_key" ? KEY : undefined) });
    const card = await aes.protect(CARD, { dataClass: "card_number", keyId: "sec_key" });
    const email = await aes.protect(EMAIL, { dataClass: "email", keyId: "sec_key" });
    const listed = await run(`${card} ${email}`, { subject: ADMIN, config: { keySecretRefs: [{ secretId: "sec_key" }] } });
    expect(listed.got).toBe(`${CARD} ${email}`);
    expect(JSON.stringify(listed.result)).not.toContain(CARD);
    expect(revealOutput(listed.result).reveal.refused).toEqual([expect.objectContaining({ reason: "not_decryptable" })]);
    const unlisted = await run(card, { subject: ADMIN });
    expect(revealOutput(unlisted.result).text).toBe(card);
    expect(revealOutput(unlisted.result).reveal.refused[0].reason).toBe("key_not_allowed");
  });

  it("fails the step with onRefused fail and reveals nothing", async () => {
    const { result, reveals } = await run(`${CARD_TOKEN} ${EMAIL_TOKEN}`, { subject: ADMIN, config: { onRefused: "fail" } });
    expect(result.status).toBe("error");
    expect(statusOf(result, "reveal")?.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain(CARD);
    expect(reveals[0]?.revealed).toEqual([]);
    expect(reveals[0]?.refused).toHaveLength(1);
  });

  it("asks a person first when the rule requires approval, and reveals once approved", async () => {
    const guarded = await guardDeps({ stack: ["approval"] });
    const paused: WorkflowExecutionState[] = [];
    const first = await executeWorkflow(
      { workflow: revealWorkflow(), executionId: "exec-ap", webhookPayload: { text: CARD_TOKEN }, toolPolicySubject: ADMIN },
      deps(guarded.guard, {}, paused)
    );
    expect(first.status).toBe("waiting_approval");
    expect(paused[0]?.approvalHandoff).toMatchObject({ kind: "rerun", source: "reveal_node" });
    expect(JSON.stringify(paused[0])).not.toContain(CARD);
    expect(guarded.reveals).toHaveLength(0);
    // Only an admin other than the person who started the run may approve, and a rejection needs a reason.
    expect(paused[0]?.approvalHandoff).toMatchObject({ request: { kind: "guard", approverRoles: ["admin"], allowSelfApproval: false, requireRejectReason: true } });
    expect(resolvePendingApproval(paused[0]!).request).toMatchObject({ allowSelfApproval: false, approverRoles: ["admin"] });
    sent = [];
    const approved = await resumeWorkflowExecution({ executionId: "exec-ap", state: paused[0]!, decision: "approve", actedBy: "u-approver" }, deps(guarded.guard));
    expect(approved.status).toBe("success");
    expect(sent.at(-1)?.text).toBe(CARD);
    expect(JSON.stringify(approved)).not.toContain(CARD);
    expect(revealOutput(approved).reveal.approved).toBe(true);
    expect(guarded.reveals[0]).toMatchObject({ approved: true, approvedBy: "u-approver" });
    const rejected = await resumeWorkflowExecution({ executionId: "exec-ap", state: paused[0]!, decision: "reject", actedBy: "admin" }, deps(guarded.guard));
    expect(rejected.status).toBe("error");
    expect(JSON.stringify(rejected)).not.toContain(CARD);
  });

  it("never reveals in a replay or a run the API marks as not revealing", async () => {
    const replay = await run(CARD_TOKEN, { subject: ADMIN, extra: {
        // The recording holds the revealed value; the replay must neither use it nor reveal again.
        replayNodeHook: (entry) =>
          entry.type === "webhook_input" ? { kind: "output", output: { text: CARD_TOKEN } } : entry.type === "guard_reveal" ? { kind: "output", output: { text: CARD, reveal: {} } } : null
      }
    });
    expect(revealOutput(replay.result).text).toBe(CARD_TOKEN);
    expect(revealOutput(replay.result).reveal.skipped).toBe("replay");
    expect(replay.reveals).toHaveLength(0);
    const disabled = await guardDeps({ stack: ["support"], revealDisabled: true });
    const sim = await run(CARD_TOKEN, { subject: ADMIN, guard: disabled });
    expect(revealOutput(sim.result).text).toBe(CARD_TOKEN);
    expect(sim.reveals).toHaveLength(0);
  });

  it("fails closed when the reveal cannot be recorded", async () => {
    const throwing = await guardDeps({ stack: ["support"], onReveal: () => Promise.reject(new Error("disk full")) });
    const failed = await run(CARD_TOKEN, { subject: ADMIN, guard: throwing });
    expect(failed.result.status).toBe("error");
    expect(JSON.stringify(failed.result)).not.toContain(CARD);
    const silent = await guardDeps({ stack: ["support"], noRecorder: true });
    const unrecorded = await run(CARD_TOKEN, { subject: ADMIN, guard: silent });
    expect(unrecorded.result.status).toBe("error");
    expect(JSON.stringify(unrecorded.result)).not.toContain(CARD);
  });

  it("passes content without tokens through untouched and records nothing", async () => {
    const { result, reveals } = await run("Nothing protected here", { subject: ADMIN });
    expect(revealOutput(result).text).toBe("Nothing protected here");
    expect(revealOutput(result).reveal).toEqual({ field: "text", revealed: [], refused: [] });
    expect(reveals).toHaveLength(0);
  });

  it("takes reveal rules only from rule sets that apply to the run (a node cannot name an unbound one)", async () => {
    // Nothing bound: a node naming a stored rule set with reveal rules reveals nothing.
    const unbound = await run(CARD_TOKEN, { subject: ADMIN, guard: await guardDeps(), config: { profileId: "support" } });
    expect(unbound.got).toBe(CARD_TOKEN);
    expect(revealOutput(unbound.result).reveal.refused).toEqual([expect.objectContaining({ dataClass: "card_number", reason: "no_rule" })]);
    // Bound elsewhere in the stack: the node's choice narrows to that rule set (no approval rule from `approval`).
    const narrowed = await run(CARD_TOKEN, { subject: ADMIN, guard: await guardDeps({ stack: ["approval", "support"] }), config: { profileId: "support" } });
    expect(narrowed.result.status).toBe("success");
    expect(narrowed.got).toBe(CARD);
    // A bound rule set the node does not name contributes nothing.
    const other = await run(CARD_TOKEN, { subject: ADMIN, guard: await guardDeps({ stack: ["support"] }), config: { profileId: "scoped" } });
    expect(other.got).toBe(CARD_TOKEN);
  });

  it("treats an enforced rule set's reveal block as the ceiling", async () => {
    const capped = await run(CARD_TOKEN, { subject: ADMIN, guard: await guardDeps({ enforced: "ceiling", stack: ["support"] }) });
    expect(capped.got).toBe(CARD_TOKEN);
    expect(revealOutput(capped.result).reveal.refused[0].reason).toBe("no_rule");
    const named = await run(CARD_TOKEN, { subject: ADMIN, guard: await guardDeps({ enforced: "ceiling", stack: ["support"] }), config: { profileId: "support" } });
    expect(named.got).toBe(CARD_TOKEN);
    // An enforced rule set without a reveal block leaves the bound rule sets' reveal rules in force.
    const open = await run(CARD_TOKEN, { subject: ADMIN, guard: await guardDeps({ enforced: "plain", stack: ["support"] }) });
    expect(open.got).toBe(CARD);
  });

  it("keeps revealed values out of live events, the error workflow input and log metadata", async () => {
    const events: unknown[] = [];
    const errorInputs: unknown[] = [];
    const logged: unknown[] = [];
    const guarded = await guardDeps({ stack: ["support"] });
    sent = [];
    const wf = { ...revealWorkflow({}, '{"text":"{{text}}","fail":true}'), settings: { errorWorkflowId: "wf-errors" } } as Workflow;
    const result = await executeWorkflow(
      { workflow: wf, executionId: "exec-ev", webhookPayload: { text: `Card ${CARD_TOKEN}` }, toolPolicySubject: ADMIN },
      deps(guarded.guard, {
        onNodeStart: (event) => void events.push(event),
        onNodeComplete: (event) => void events.push(event),
        onNodeActivity: (event) => void events.push(event),
        logger: (message, metadata) => void logged.push([message, metadata]),
        triggerErrorWorkflow: async (input) => void errorInputs.push(input)
      })
    );
    // The downstream node got the value (and failed with it in its error message).
    expect(sent.at(-1)?.text).toBe(`Card ${CARD}`);
    expect(result.status).toBe("error");
    expect(events.length).toBeGreaterThan(0);
    expect(errorInputs).toHaveLength(1);
    for (const kept of [result, events, errorInputs, logged]) {
      expect(JSON.stringify(kept)).not.toContain(CARD);
    }
    expect(JSON.stringify(result)).toContain(CARD_TOKEN);
  });

  it("keeps revealed values out of a paused run's saved state (the run continues with the tokens)", async () => {
    const guarded = await guardDeps({ stack: ["support"] });
    const wf = revealWorkflow();
    wf.nodes.splice(2, 0, node("gate", "approval_gate", { message: "Send it?" }));
    wf.edges = [
      { id: "e1", source: "in", target: "reveal" },
      { id: "e2", source: "reveal", target: "gate" },
      { id: "e3", source: "gate", sourceHandle: "approved", target: "sink" },
      { id: "e4", source: "sink", target: "out" }
    ];
    const paused: WorkflowExecutionState[] = [];
    const first = await executeWorkflow({ workflow: wf, executionId: "exec-gate", webhookPayload: { text: CARD_TOKEN }, toolPolicySubject: ADMIN }, deps(guarded.guard, {}, paused));
    expect(first.status).toBe("waiting_approval");
    expect(paused).toHaveLength(1);
    expect(JSON.stringify(paused)).not.toContain(CARD);
    expect(JSON.stringify(first)).not.toContain(CARD);
    sent = [];
    const resumed = await resumeWorkflowExecution({ executionId: "exec-gate", state: paused[0]!, decision: "approve", actedBy: "u-lead" }, deps(guarded.guard));
    expect(resumed.status).toBe("success");
    expect(sent.at(-1)?.text).toBe(CARD_TOKEN);
  });

  it("scopes a sub-workflow's content rules to its own project", async () => {
    const child: Workflow = {
      id: "wf-child",
      name: "Child",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "proj-b",
      nodes: [node("start", "manual_trigger"), node("reveal", "guard_reveal", { inputField: "text" }), node("sink", "mcp_tool", { serverId: "sink-mcp", toolName: "send", argsTemplate: '{"text":"{{text}}"}', retry: { enabled: false } }), node("end", "output")],
      edges: [
        { id: "c1", source: "start", target: "reveal" },
        { id: "c2", source: "reveal", target: "sink" },
        { id: "c3", source: "sink", target: "end" }
      ]
    };
    const parent: Workflow = {
      id: "wf-parent",
      name: "Parent",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "proj-a",
      nodes: [node("in", "webhook_input"), node("call", "execute_workflow", { workflowId: "wf-child", inputMapping: { text: "text" } }), node("out", "output")],
      edges: [
        { id: "p1", source: "in", target: "call" },
        { id: "p2", source: "call", target: "out" }
      ]
    };
    const extra = { loadWorkflow: (id: string) => (id === "wf-child" ? child : undefined) };
    // Without the API's hook, a child in another project never reveals.
    const guarded = await guardDeps({ stack: ["support"] });
    sent = [];
    const result = await executeWorkflow({ workflow: parent, executionId: "exec-sub", webhookPayload: { text: CARD_TOKEN }, toolPolicySubject: ADMIN }, deps(guarded.guard, extra));
    expect(result.status).toBe("success");
    expect(sent.at(-1)?.text).toBe(CARD_TOKEN);
    expect(guarded.reveals).toHaveLength(0);
    // With it, the child's rules and vault come from the API, for the child's project.
    const scopedFor: Array<{ id: string; projectId: string | null }> = [];
    const hooked = await guardDeps({ stack: ["support"] });
    const childGuard = await guardDeps({ stack: ["support"], projectId: "proj-b" });
    const withHook = { ...hooked.guard, forWorkflow: (workflow: { id: string; projectId: string | null }) => (scopedFor.push(workflow), childGuard.guard) };
    sent = [];
    const scoped = await executeWorkflow({ workflow: parent, executionId: "exec-sub2", webhookPayload: { text: `${CARD_TOKEN} ${OTHER_PROJECT_TOKEN}` }, toolPolicySubject: ADMIN }, deps(withHook, extra));
    expect(scoped.status).toBe("success");
    expect(scopedFor).toEqual([{ id: "wf-child", projectId: "proj-b" }]);
    // Under proj-b's scope the proj-b token opens and the proj-a token stays protected.
    expect(sent.at(-1)?.text).toBe(`${CARD_TOKEN} 5555 5555 5555 4444`);
    expect(childGuard.reveals[0]?.refused).toEqual([expect.objectContaining({ reason: "other_project" })]);
    expect(JSON.stringify(scoped)).not.toContain("5555 5555 5555 4444");
  });

  it("checks the tokens, never the revealed values, when the run answers an external caller", async () => {
    const guarded = await guardDeps({ stack: ["responses"] });
    const workflow = revealWorkflow();
    // The run answers with what the sink echoed: the revealed email, inside the run.
    const answering = { ...workflow, nodes: workflow.nodes.map((entry) => (entry.id === "out" ? { ...entry, config: { responseTemplate: "{{tool_output.echoed}}" } } : entry)) };
    sent = [];
    const result = await executeWorkflow(
      { workflow: answering, executionId: "exec-r", webhookPayload: { text: `Mail ${EMAIL_TOKEN}` }, toolPolicySubject: ADMIN, responseBoundary: { surface: "webhook" } },
      deps(guarded.guard)
    );
    expect(sent.at(-1)?.text).toBe(`Mail ${EMAIL}`);
    expect(runRevealedValues(result)).toBe(true);
    // The caller receives the token, so the response check judges the token: nothing to redact, no email in its events.
    expect(result.responseCheck).toMatchObject({ withheld: false, transformed: false });
    expect(JSON.stringify(result)).not.toContain(EMAIL);
    expect(JSON.stringify(result.output)).toContain(EMAIL_TOKEN);
    // The output's labels survive the copy that puts the tokens back (a queue worker stores them for the parent run).
    expect(outputLabelsOf(result)?.provenance).toContain("sensitive");
  });

  it("validates the node configuration", () => {
    const wf = revealWorkflow({ onRefused: "explode" });
    const result = validateWorkflowGraph(wf);
    expect(result.issues.some((issue) => issue.code === "invalid_reveal_config")).toBe(true);
    expect(validateWorkflowGraph(revealWorkflow()).issues.some((issue) => issue.code === "invalid_reveal_config")).toBe(false);
  });
});
