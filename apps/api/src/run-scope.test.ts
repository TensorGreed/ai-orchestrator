/**
 * Run-time project scope: which sub-workflows, error workflows, secrets and
 * session state a running workflow can reach (run-scope.ts).
 */
import { describe, expect, it } from "vitest";
import type { Workflow } from "@ai-orchestrator/shared";
import { createRunScope, projectSessionNamespace, type RunScopeDeps } from "./run-scope.js";
import type { SafeUser } from "./services/auth-service.js";

const workflow = (id: string, projectId?: string, nodes: Array<{ id: string; namespace?: string }> = []): Workflow => ({
  id,
  name: id,
  schemaVersion: "1.0.0",
  workflowVersion: 1,
  ...(projectId ? { projectId } : {}),
  nodes: nodes.map((node) => ({
    id: node.id,
    type: "local_memory",
    name: node.id,
    position: { x: 0, y: 0 },
    config: node.namespace ? { namespace: node.namespace } : {}
  })),
  edges: []
});

const user = (role: SafeUser["role"], id = `u-${role}`): SafeUser => ({ id, email: `${id}@x`, role }) as SafeUser;

function scopeFixture(overrides: Partial<RunScopeDeps> = {}) {
  const workflows: Record<string, Workflow> = {
    "a-1": workflow("a-1", "pa"),
    "a-2": workflow("a-2", "pa"),
    "b-1": workflow("b-1", "pb", [{ id: "agent" }]),
    "b-shared": workflow("b-shared", "pb"),
    "b-read-share": workflow("b-read-share", "pb"),
    legacy: workflow("legacy"),
    team: workflow("team", "pa", [{ id: "mem" }]),
    "team:agent": workflow("team:agent", "pb", [{ id: "node" }]),
    "b-custom": workflow("b-custom", "pb", [{ id: "mem", namespace: "b-support" }])
  };
  const mcpServers: Record<string, string | null> = { "m-pb": "pb", "m-none": null, "m-default": "default" };
  const mcpResolved: string[] = [];
  // Which projects claim a legacy namespace, as app.ts builds it from the stored workflows.
  const legacyOwners = async (namespace: string) => {
    const owners = new Set<string>();
    for (const wf of Object.values(workflows)) {
      for (const node of wf.nodes) {
        const custom = (node.config as { namespace?: string }).namespace;
        if (namespace === `${wf.id}:${node.id}` || namespace === custom) owners.add(wf.projectId ?? "default");
      }
    }
    return [...owners];
  };
  const secrets: Record<string, string> = { "s-a": "pa", "s-b": "pb", "s-default": "default", "s-shared": "pb" };
  const memory = new Map<string, unknown[]>();
  const toolCalls: Array<{ id: string; namespace: string; sessionId: string; toolName: string; args: Record<string, unknown>; output: unknown; createdAt: string }> = [];
  const artifacts = new Map<string, { namespace: string; sessionId: string; artifactKey: string; value: unknown; createdAt: string; updatedAt: string }>();
  const resolved: string[] = [];
  const deps: RunScopeDeps = {
    getWorkflow: async (id) => workflows[id] ?? null,
    listWorkflowShares: async (id) =>
      id === "b-shared" ? [{ projectId: "pa", accessLevel: "execute" }] : id === "b-read-share" ? [{ projectId: "pa", accessLevel: "read" }] : [],
    getSecretProjectId: async (id) => secrets[id] ?? null,
    listSecretIdsSharedToProject: async (projectId) => (projectId === "pa" ? ["s-shared"] : []),
    // u-consumer may use secrets only in pa (where b-shared is shared to with execute).
    canUseSecretsInProject: async (actor, projectId) => actor.id !== "u-no-secrets" && (actor.id !== "u-consumer" || projectId === "pa"),
    defaultSecretsShared: true,
    getMcpServerProjectId: async (id) => (id in mcpServers ? mcpServers[id] : undefined),
    resolveRegisteredMcpServer: (id) => {
      mcpResolved.push(id);
      return { serverId: id, connection: {} } as never;
    },
    legacyNamespaceOwnerProjects: legacyOwners,
    resolveSecret: async (ref) => {
      resolved.push(ref!.secretId);
      return `value-of-${ref!.secretId}`;
    },
    knowledgeBaseStoreFor: () => ({ addKnowledgeBaseChunks: () => 0, listKnowledgeBaseChunks: () => [], bm25SearchKnowledgeBase: () => [], getKnowledgeBase: () => null }) as never,
    sessions: {
      loadMemory: (namespace, sessionId) => (memory.get(`${namespace}|${sessionId}`) ?? []) as never,
      saveMemory: (namespace, sessionId, messages) => void memory.set(`${namespace}|${sessionId}`, messages),
      saveToolCall: async (input) => {
        const row = { ...input, id: `t${toolCalls.length}`, createdAt: new Date(Date.now() + toolCalls.length).toISOString() };
        toolCalls.push(row);
        return row;
      },
      listToolCalls: async (input) => toolCalls.filter((row) => row.namespace === input.namespace && row.sessionId === input.sessionId),
      getToolCall: async (input) => toolCalls.find((row) => row.namespace === input.namespace && row.sessionId === input.sessionId && row.id === input.id) ?? null,
      saveArtifact: async (input) => {
        const row = { ...input, createdAt: "t", updatedAt: "t" };
        artifacts.set(`${input.namespace}|${input.sessionId}|${input.artifactKey}`, row);
        return row;
      },
      loadArtifact: async (input) => artifacts.get(`${input.namespace}|${input.sessionId}|${input.artifactKey}`) ?? null
    },
    ...overrides
  };
  return { scope: createRunScope(deps), workflows, memory, toolCalls, artifacts, resolved, mcpResolved };
}

describe("run scope: sub-workflows and error workflows", () => {
  it("loads same-project, project-less and execute-shared children, and refuses the rest with a clear error", async () => {
    const { scope, workflows } = scopeFixture();
    const load = scope.dependenciesFor(workflows["a-1"]!).loadWorkflow;
    expect((await load("a-2"))?.id).toBe("a-2");
    expect((await load("legacy"))?.id).toBe("legacy");
    expect((await load("b-shared"))?.id).toBe("b-shared");
    expect(await load("missing")).toBeUndefined();
    await expect(load("b-1")).rejects.toThrow(/Sub-workflow 'b-1' is in another project/);
    // A read share is not enough to run it.
    await expect(load("b-read-share")).rejects.toThrow(/another project/);
  });

  it("the run's user never widens what it can call, not even an admin approving or retrying it", async () => {
    const { scope, workflows } = scopeFixture();
    await expect(scope.dependenciesFor(workflows["a-1"]!, { actor: user("admin") }).loadWorkflow("b-1")).rejects.toThrow(/Sub-workflow 'b-1' is in another project/);
    await expect(scope.dependenciesFor(workflows["a-1"]!, { actor: null }).loadWorkflow("b-1")).rejects.toThrow(/another project/);
    expect((await scope.dependenciesFor(workflows["a-1"]!, { actor: user("admin") }).loadWorkflow("b-shared"))?.id).toBe("b-shared");
  });

  it("a workflow without a project counts as the default project when it calls others", async () => {
    const { scope, workflows } = scopeFixture();
    await expect(scope.dependenciesFor(workflows.legacy!).loadWorkflow("a-1")).rejects.toThrow(/another project/);
  });

  it("a sub-workflow is scoped to its own project", async () => {
    const { scope, workflows, resolved } = scopeFixture();
    const parent = scope.dependenciesFor(workflows["a-1"]!);
    const child = parent.scopeSubWorkflow(workflows["b-shared"]!);
    // The shared child reads its own project's secret, which the parent could not.
    await expect(parent.resolveSecret({ secretId: "s-b" })).rejects.toThrow(/another project/);
    await expect(child.resolveSecret!({ secretId: "s-b" })).resolves.toBe("value-of-s-b");
    expect(resolved).toEqual(["s-b"]);
    // And its own loader: from pb, a1 is in another project.
    await expect(child.loadWorkflow!("a-1")).rejects.toThrow(/another project/);
    expect((await child.loadWorkflow!("b-1"))?.id).toBe("b-1");
  });

  it("error workflows follow the same rule and report why they are not run", async () => {
    const { scope, workflows } = scopeFixture();
    expect(await scope.errorWorkflowFor(workflows["a-1"]!, "a-2")).toEqual({ workflow: workflows["a-2"] });
    expect(await scope.errorWorkflowFor(workflows["a-1"]!, "b-1")).toEqual({ error: expect.stringMatching(/Error workflow 'b-1' is in another project/) });
    expect(await scope.errorWorkflowFor(workflows["a-1"]!, "nope")).toEqual({ error: "Error workflow 'nope' was not found." });
    expect(await scope.errorWorkflowFor(workflows["a-1"]!, "b-shared")).toEqual({ workflow: workflows["b-shared"] });
  });
});

describe("run scope: secrets", () => {
  it("resolves secrets of the workflow's project, the default project and shares; refuses others", async () => {
    const { scope, workflows, resolved } = scopeFixture();
    const resolve = scope.dependenciesFor(workflows["a-1"]!).resolveSecret;
    await expect(resolve({ secretId: "s-a" })).resolves.toBe("value-of-s-a");
    await expect(resolve({ secretId: "s-default" })).resolves.toBe("value-of-s-default");
    await expect(resolve({ secretId: "s-shared" })).resolves.toBe("value-of-s-shared");
    await expect(resolve({ secretId: "s-b" })).rejects.toThrow("Secret 's-b' belongs to another project and is not shared to this workflow's project.");
    await expect(resolve({ secretId: "unknown" })).resolves.toBeUndefined();
    await expect(resolve(undefined)).resolves.toBeUndefined();
    expect(resolved).toEqual(["s-a", "s-default", "s-shared"]);
  });

  it("needs secret:use for the run's user, except admins", async () => {
    const { scope, workflows } = scopeFixture();
    await expect(scope.dependenciesFor(workflows["a-1"]!, { actor: user("operator", "u-no-secrets") }).resolveSecret({ secretId: "s-a" })).rejects.toThrow(
      /Permission 'secret:use' is required/
    );
    await expect(scope.dependenciesFor(workflows["a-1"]!, { actor: user("admin", "u-no-secrets") }).resolveSecret({ secretId: "s-a" })).resolves.toBe("value-of-s-a");
    await expect(scope.dependenciesFor(workflows["a-1"]!, { actor: user("builder") }).resolveSecret({ secretId: "s-a" })).resolves.toBe("value-of-s-a");
  });

  it("strict isolation: a default-project secret needs a share like any other", async () => {
    const { scope, workflows } = scopeFixture({ defaultSecretsShared: false, listSecretIdsSharedToProject: async (projectId) => (projectId === "pb" ? ["s-default"] : []) });
    await expect(scope.dependenciesFor(workflows["a-1"]!).resolveSecret({ secretId: "s-default" })).rejects.toThrow(/belongs to another project/);
    // The default project's own workflows keep it, and a share opens it to another project.
    await expect(scope.dependenciesFor(workflows.legacy!).resolveSecret({ secretId: "s-default" })).resolves.toBe("value-of-s-default");
    await expect(scope.dependenciesFor(workflows["b-1"]!).resolveSecret({ secretId: "s-default" })).resolves.toBe("value-of-s-default");
  });

  it("secret:use in a project the workflow is shared to with execute counts", async () => {
    const { scope, workflows } = scopeFixture();
    const consumer = user("builder", "u-consumer");
    // b-shared (pb) is shared to pa with execute; u-consumer may use secrets only in pa.
    await expect(scope.dependenciesFor(workflows["b-shared"]!, { actor: consumer }).resolveSecret({ secretId: "s-b" })).resolves.toBe("value-of-s-b");
    // No execute share, no secret:use: refused.
    await expect(scope.dependenciesFor(workflows["b-1"]!, { actor: consumer }).resolveSecret({ secretId: "s-b" })).rejects.toThrow(/secret:use/);
    await expect(scope.dependenciesFor(workflows["b-read-share"]!, { actor: consumer }).resolveSecret({ secretId: "s-b" })).rejects.toThrow(/secret:use/);
    // A user with secret:use nowhere still fails through the share.
    await expect(scope.dependenciesFor(workflows["b-shared"]!, { actor: user("viewer", "u-no-secrets") }).resolveSecret({ secretId: "s-b" })).rejects.toThrow(/secret:use/);
  });

  it("canUseSecretFor applies the same rules without resolving anything", async () => {
    const { scope, workflows, resolved } = scopeFixture();
    const consumer = user("builder", "u-consumer");
    expect(await scope.canUseSecretFor(workflows["b-shared"]!, consumer, "s-b")).toBe(true);
    expect(await scope.canUseSecretFor(workflows["b-1"]!, consumer, "s-b")).toBe(false);
    expect(await scope.canUseSecretFor(workflows["a-1"]!, consumer, "s-b")).toBe(false);
    expect(await scope.canUseSecretFor(workflows["a-1"]!, user("admin", "u-admin"), "s-a")).toBe(true);
    expect(await scope.canUseSecretFor(workflows["a-1"]!, user("builder", "u-no-secrets"), "s-a")).toBe(false);
    expect(await scope.canUseSecretFor(workflows["a-1"]!, consumer, "s-missing")).toBe(false);
    // A project alone (no workflow, so no shares).
    expect(await scope.canUseSecretFor({ projectId: "pa" }, consumer, "s-a")).toBe(true);
    expect(await scope.canUseSecretFor({ projectId: "pb" }, consumer, "s-b")).toBe(false);
    expect(resolved).toEqual([]);
  });

  it("the run's user carries over to a same-project child only", async () => {
    const { scope, workflows } = scopeFixture();
    const parent = scope.dependenciesFor(workflows["a-1"]!, { actor: user("operator", "u-no-secrets") });
    // Same project: the user's missing secret:use still applies.
    await expect(parent.scopeSubWorkflow(workflows["a-2"]!).resolveSecret!({ secretId: "s-a" })).rejects.toThrow(/secret:use/);
    // Another project, reached through the owner's execute share: the share authorizes it.
    await expect(parent.scopeSubWorkflow(workflows["b-shared"]!).resolveSecret!({ secretId: "s-b" })).resolves.toBe("value-of-s-b");
  });
});

describe("run scope: registry MCP servers", () => {
  it("a server with a project is usable only from that project; default-project servers follow the isolation mode", async () => {
    const role = scopeFixture();
    const fromA = role.scope.dependenciesFor(role.workflows["a-1"]!).resolveRegisteredMcpServer;
    await expect(fromA("m-pb")).rejects.toThrow("MCP server 'm-pb' belongs to another project, so workflows in this project cannot use it.");
    expect(await fromA("m-none")).toMatchObject({ serverId: "m-none" });
    expect(await fromA("m-default")).toMatchObject({ serverId: "m-default" });
    expect(await role.scope.dependenciesFor(role.workflows["b-1"]!).resolveRegisteredMcpServer("m-pb")).toMatchObject({ serverId: "m-pb" });
    expect(role.mcpResolved).toEqual(["m-none", "m-default", "m-pb"]);

    const strict = scopeFixture({ defaultSecretsShared: false });
    await expect(strict.scope.dependenciesFor(strict.workflows["a-1"]!).resolveRegisteredMcpServer("m-default")).rejects.toThrow(/belongs to another project/);
    expect(await strict.scope.dependenciesFor(strict.workflows.legacy!).resolveRegisteredMcpServer("m-default")).toMatchObject({ serverId: "m-default" });
  });

  it("a run's own resolver (a cassette plan) is used and passed to sub-workflows, under their project's rule", async () => {
    const { scope, workflows, mcpResolved } = scopeFixture();
    const planned: string[] = [];
    const parent = scope.dependenciesFor(workflows["a-1"]!, { resolveRegisteredMcpServer: (id) => (planned.push(id), { serverId: `planned-${id}` } as never) });
    expect(await parent.resolveRegisteredMcpServer("m-none")).toMatchObject({ serverId: "planned-m-none" });
    const child = parent.scopeSubWorkflow(workflows["b-shared"]!);
    expect(await child.resolveRegisteredMcpServer!("m-pb")).toMatchObject({ serverId: "planned-m-pb" });
    expect(planned).toEqual(["m-none", "m-pb"]);
    expect(mcpResolved).toEqual([]);
  });
});

describe("run scope: session memory, tool cache and artifacts", () => {
  it("keys every write by project, so two projects never share a namespace", async () => {
    const { scope, workflows, memory } = scopeFixture();
    const a = scope.dependenciesFor(workflows["a-1"]!);
    const b = scope.dependenciesFor(workflows["b-1"]!);
    await a.memoryStore.saveMessages("support", "s1", [{ role: "user", content: "from A" }]);
    expect([...memory.keys()]).toEqual([`${projectSessionNamespace("pa", "support")}|s1`]);
    expect(await b.memoryStore.loadMessages("support", "s1")).toEqual([]);
    expect(await a.memoryStore.loadMessages("support", "s1")).toEqual([{ role: "user", content: "from A" }]);
  });

  it("reads unprefixed rows from before scoping only where they can be this workflow's own", async () => {
    const { scope, workflows, memory } = scopeFixture();
    memory.set("support|s1", [{ role: "user", content: "legacy shared" }]);
    memory.set("b-1:agent|s1", [{ role: "user", content: "legacy of b-1" }]);
    memory.set("b-1:other|s1", [{ role: "user", content: "not a node of b-1" }]);
    // From another project: neither the shared name nor someone else's default namespace.
    const a = scope.dependenciesFor(workflows["a-1"]!);
    expect(await a.memoryStore.loadMessages("support", "s1")).toEqual([]);
    expect(await a.memoryStore.loadMessages("b-1:agent", "s1")).toEqual([]);
    // The workflow's own default namespace still reads its old memory; only an exact node match counts.
    const b = scope.dependenciesFor(workflows["b-1"]!);
    expect(await b.memoryStore.loadMessages("b-1:agent", "s1")).toEqual([{ role: "user", content: "legacy of b-1" }]);
    expect(await b.memoryStore.loadMessages("b-1:other", "s1")).toEqual([]);
    // Default-project workflows keep reading legacy rows no other project claims (single-project installs see no change).
    expect(await scope.dependenciesFor(workflows.legacy!).memoryStore.loadMessages("support", "s1")).toEqual([{ role: "user", content: "legacy shared" }]);
  });

  it("a default-project workflow cannot read another project's legacy rows (N5)", async () => {
    const { scope, workflows, memory } = scopeFixture();
    memory.set("b-1:agent|s1", [{ role: "user", content: "B-private" }]);
    memory.set("b-support|s1", [{ role: "user", content: "B custom namespace" }]);
    const fromDefault = scope.dependenciesFor(workflows.legacy!);
    expect(await fromDefault.memoryStore.loadMessages("b-1:agent", "s1")).toEqual([]);
    expect(await fromDefault.memoryStore.loadMessages("b-support", "s1")).toEqual([]);
  });

  it("a workflow id that prefixes another's does not read its legacy rows (N5)", async () => {
    const { scope, workflows, memory, toolCalls } = scopeFixture();
    memory.set("team:agent:node|s1", [{ role: "user", content: "team-private" }]);
    toolCalls.push({ id: "tc", namespace: "team:agent:node", sessionId: "s1", toolName: "t", args: {}, output: "x", createdAt: "2020-01-01T00:00:00.000Z" });
    const team = scope.dependenciesFor(workflows.team!);
    expect(await team.memoryStore.loadMessages("team:agent:node", "s1")).toEqual([]);
    expect(await team.toolDataStore.listToolCalls({ namespace: "team:agent:node", sessionId: "s1" })).toEqual([]);
    expect(await scope.dependenciesFor(workflows["team:agent"]!).memoryStore.loadMessages("team:agent:node", "s1")).toEqual([{ role: "user", content: "team-private" }]);
  });

  it("scopes the tool cache and artifacts the same way, and reports the caller's namespace", async () => {
    const { scope, workflows, toolCalls } = scopeFixture();
    const a = scope.dependenciesFor(workflows["a-1"]!);
    const b = scope.dependenciesFor(workflows["b-1"]!);
    const saved = await a.toolDataStore.saveToolCall({ namespace: "cache", sessionId: "s1", toolName: "search", args: {}, output: "secret result" });
    expect(saved.namespace).toBe("cache");
    expect(toolCalls[0]!.namespace).toBe(projectSessionNamespace("pa", "cache"));
    expect(await b.toolDataStore.listToolCalls({ namespace: "cache", sessionId: "s1" })).toEqual([]);
    expect(await b.toolDataStore.getToolCall({ namespace: "cache", sessionId: "s1", id: saved.id })).toBeNull();
    expect((await a.toolDataStore.listToolCalls({ namespace: "cache", sessionId: "s1" })).map((row) => row.namespace)).toEqual(["cache"]);
    expect((await a.toolDataStore.getToolCall({ namespace: "cache", sessionId: "s1", id: saved.id }))?.output).toBe("secret result");

    toolCalls.push({ id: "old", namespace: "b-1:agent", sessionId: "s1", toolName: "search", args: {}, output: "legacy", createdAt: "2020-01-01T00:00:00.000Z" });
    expect((await b.toolDataStore.listToolCalls({ namespace: "b-1:agent", sessionId: "s1" })).map((row) => row.id)).toEqual(["old"]);
    expect(await a.toolDataStore.getToolCall({ namespace: "b-1:agent", sessionId: "s1", id: "old" })).toBeNull();

    await a.sessionArtifactStore.saveArtifact({ namespace: "art", sessionId: "s1", artifactKey: "k", value: 42 });
    expect(await b.sessionArtifactStore.loadArtifact({ namespace: "art", sessionId: "s1", artifactKey: "k" })).toBeNull();
    expect(await a.sessionArtifactStore.loadArtifact({ namespace: "art", sessionId: "s1", artifactKey: "k" })).toMatchObject({ namespace: "art", value: 42 });
  });

  it("namespace keys are unambiguous even when project ids contain the separator", () => {
    expect(projectSessionNamespace("x", "y:ns")).not.toBe(projectSessionNamespace("x:y", "ns"));
  });

  it("a production run fails on a deactivated gated child and skips such an error workflow, with the reason (Phase 15.4)", async () => {
    const deactivated = "This workflow is deactivated, so production runs are refused.";
    const { scope, workflows } = scopeFixture({
      getRunnableWorkflow: async (id, channel) => (channel === "production" && id === "a-2" ? null : ({ "a-1": workflow("a-1", "pa"), "a-2": workflow("a-2", "pa") } as Record<string, Workflow>)[id] ?? null),
      productionRefusal: async (id) => (id === "a-2" ? deactivated : null)
    });
    const production = scope.dependenciesFor(workflows["a-1"]!, { channel: "production" });
    await expect(production.loadWorkflow!("a-2")).rejects.toThrow(/Sub-workflow 'a-2': This workflow is deactivated/);
    expect(await production.loadWorkflow!("missing")).toBeUndefined();
    expect(await scope.errorWorkflowFor(workflows["a-1"]!, "a-2", "production")).toEqual({ error: expect.stringMatching(/Error workflow 'a-2': This workflow is deactivated/) });
    // A draft run (the editor) still calls the child's draft.
    expect((await scope.dependenciesFor(workflows["a-1"]!).loadWorkflow!("a-2"))?.id).toBe("a-2");
    expect(await scope.errorWorkflowFor(workflows["a-1"]!, "a-2")).toEqual({ workflow: workflows["a-2"] });
  });
});
