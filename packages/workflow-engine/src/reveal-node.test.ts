import { describe, expect, it } from "vitest";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createAesGcmProvider, hashGuardProfile, InMemoryTokenVaultStorage, parseGuardProfile, type GuardProfileInput } from "@ai-orchestrator/guard-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type { McpToolPolicySubject, Workflow, WorkflowExecutionState, WorkflowNode } from "@ai-orchestrator/shared";
import { executeWorkflow, resumeWorkflowExecution, type WorkflowExecutionDependencies } from "./executor";
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
  scoped: resolved("scoped", { ...base("scoped"), reveal: { rules: [{ dataClasses: ["card_number"], subjects: { roles: ["admin"] }, workflows: ["another-workflow"] }] } })
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

async function guardDeps(options: { stack?: string[]; projectId?: string | null; revealDisabled?: boolean; onReveal?: (event: GuardRevealEvent) => void | Promise<void>; noRecorder?: boolean } = {}) {
  const reveals: GuardRevealEvent[] = [];
  const stack = (options.stack ?? []).map((id) => PROFILES[id]!);
  const resolution: GuardRunResolution = { source: stack.length ? "project" : "none", stack, chain: [] };
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

function deps(guard: WorkflowExecutionDependencies["guard"], extra: Partial<WorkflowExecutionDependencies> = {}, paused?: WorkflowExecutionState[]): WorkflowExecutionDependencies {
  return {
    providerRegistry: new ProviderRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
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

function revealWorkflow(config: Record<string, unknown> = {}): Workflow {
  return {
    id: "wf-reveal",
    name: "Reveal",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [node("in", "webhook_input"), node("reveal", "guard_reveal", { inputField: "text", ...config }), node("out", "output")],
    edges: [
      { id: "e1", source: "in", target: "reveal" },
      { id: "e2", source: "reveal", target: "out" }
    ]
  };
}

const ADMIN: McpToolPolicySubject = { role: "admin", source: "user", userId: "u-admin" };
const OWNER_ADMIN: McpToolPolicySubject = { role: "admin", source: "owner", userId: "u-admin" };
const ANA: McpToolPolicySubject = { role: "operator", source: "user", userId: "u-ana" };

const statusOf = (result: Awaited<ReturnType<typeof executeWorkflow>>, id: string) => result.nodeResults.filter((entry) => entry.nodeId === id).at(-1);
const revealOutput = (result: Awaited<ReturnType<typeof executeWorkflow>>) => statusOf(result, "reveal")?.output as Record<string, any>;

async function run(text: unknown, options: { subject?: McpToolPolicySubject; config?: Record<string, unknown>; guard?: Awaited<ReturnType<typeof guardDeps>>; extra?: Partial<WorkflowExecutionDependencies> } = {}) {
  const guarded = options.guard ?? (await guardDeps({ stack: ["support"] }));
  const result = await executeWorkflow(
    { workflow: revealWorkflow(options.config), executionId: "exec-r", webhookPayload: { text }, ...(options.subject ? { toolPolicySubject: options.subject } : {}) },
    deps(guarded.guard, options.extra)
  );
  return { result, reveals: guarded.reveals };
}

describe("Reveal node", () => {
  it("reveals nothing without reveal rules (deny by default) and records the refusal without values", async () => {
    const guard = await guardDeps();
    const { result, reveals } = await run(`Card ${CARD_TOKEN}`, { subject: ADMIN, guard });
    expect(result.status).toBe("success");
    const output = revealOutput(result);
    expect(output.text).toBe(`Card ${CARD_TOKEN}`);
    expect(output.reveal.revealed).toEqual([]);
    expect(output.reveal.refused).toEqual([expect.objectContaining({ dataClass: "card_number", reason: "no_rule", count: 1 })]);
    expect(reveals).toHaveLength(1);
    expect(JSON.stringify(reveals)).not.toContain(CARD);
    expect(JSON.stringify(reveals)).not.toContain(CARD_TOKEN);
  });

  it("reveals for a signed-in admin, records counts and hashes only, and labels the output sensitive with its class", async () => {
    const { result, reveals } = await run({ note: `Card ${CARD_TOKEN} for ${EMAIL_TOKEN}` }, { subject: ADMIN });
    const output = revealOutput(result);
    expect(output.text).toEqual({ note: `Card ${CARD} for ${EMAIL_TOKEN}` });
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
    expect(revealOutput(ana.result).text).toBe(`Mail ${EMAIL}`);
    const serviceAccount = await run(`Mail ${EMAIL_TOKEN} card ${CARD_TOKEN}`, { subject: { role: "admin", source: "user", userId: "sa-crm", serviceAccountId: "sa-crm" } });
    // The service account's admin role matches no role rule; its own id matches the email rule.
    expect(revealOutput(serviceAccount.result).text).toBe(`Mail ${EMAIL} card ${CARD_TOKEN}`);
    const other = await run(`Mail ${EMAIL_TOKEN}`, { subject: { role: "admin", source: "owner", serviceAccountId: "sa-other" } });
    expect(revealOutput(other.result).text).toBe(`Mail ${EMAIL_TOKEN}`);
  });

  it("refuses tokens from another project, and older unscoped tokens unless an admin started the run", async () => {
    const { result } = await run(`${OTHER_PROJECT_TOKEN} ${LEGACY_TOKEN}`, { subject: ADMIN });
    expect(revealOutput(result).text).toBe(`${OTHER_PROJECT_TOKEN} 4000 0566 5566 5556`);
    expect(revealOutput(result).reveal.refused).toEqual([expect.objectContaining({ dataClass: "card_number", reason: "other_project" })]);
    const builderStack = await guardDeps({ stack: ["support"] });
    const ana = await run(`${EMAIL_TOKEN}`, { subject: ANA, guard: builderStack });
    expect(revealOutput(ana.result).text).toBe(EMAIL);
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
    expect(revealOutput(listed.result).text).toBe(`${CARD} ${email}`);
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
    const approved = await resumeWorkflowExecution({ executionId: "exec-ap", state: paused[0]!, decision: "approve", actedBy: "admin" }, deps(guarded.guard));
    expect(approved.status).toBe("success");
    expect(revealOutput(approved).text).toBe(CARD);
    expect(revealOutput(approved).reveal.approved).toBe(true);
    expect(guarded.reveals[0]?.approved).toBe(true);
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

  it("validates the node configuration", () => {
    const wf = revealWorkflow({ onRefused: "explode" });
    const result = validateWorkflowGraph(wf);
    expect(result.issues.some((issue) => issue.code === "invalid_reveal_config")).toBe(true);
    expect(validateWorkflowGraph(revealWorkflow()).issues.some((issue) => issue.code === "invalid_reveal_config")).toBe(false);
  });
});
